import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { secureEqual } from "./security.js";

export const APPLICATIONS = Object.freeze(["invoice", "staff", "expense"]);
const PUBLIC_ACCOUNT_COLUMNS = "account_id, username, display_name, enabled, version";

export class AccountStoreError extends Error {
  constructor(code) {
    super(code);
    this.code = code;
  }
}

function fail(code) { throw new AccountStoreError(code); }
function requiredText(value, max = 200) {
  // Do not trim identities or passwords: migration must preserve exact semantics.
  if (typeof value !== "string" || !value.length || value.length > max || /[\u0000-\u001f\u007f]/u.test(value)) {
    fail("invalid-text");
  }
  return value;
}
function boolean(value) {
  if (typeof value !== "boolean") fail("invalid-enabled");
  return value;
}
function application(value) {
  if (!APPLICATIONS.includes(value)) fail("invalid-app");
  return value;
}
function accountInput(input) {
  const password = input.password;
  if (typeof password !== "string" || !password.length || password.length > 4096) fail("invalid-password");
  return {
    accountId: requiredText(input.accountId),
    username: requiredText(input.username),
    displayName: requiredText(input.displayName ?? input.username),
    password,
    enabled: boolean(input.enabled === undefined ? true : input.enabled),
  };
}
function accessInput(input) {
  if (!Array.isArray(input.permissions) || input.permissions.length > 200) fail("invalid-permissions");
  const permissions = [...new Set(input.permissions.map((permission) => requiredText(permission)))].sort();
  // This validates the envelope only. Each app must validate and enforce its own
  // permission vocabulary and configuration before granting business access.
  if (!input.config || Object.getPrototypeOf(input.config) !== Object.prototype) fail("invalid-config");
  let configJson;
  try {
    configJson = JSON.stringify(input.config, (_key, value) => {
      if (value === undefined || typeof value === "function" || typeof value === "symbol" ||
          (typeof value === "number" && !Number.isFinite(value))) fail("invalid-config");
      return value;
    });
  } catch { fail("invalid-config"); }
  if (Buffer.byteLength(configJson) > 16384) fail("invalid-config");
  return {
    accountId: requiredText(input.accountId),
    app: application(input.app),
    role: requiredText(input.role),
    permissionsJson: JSON.stringify(permissions),
    configJson,
    enabled: boolean(input.enabled === undefined ? true : input.enabled),
  };
}
function publicAccount(row) {
  return row ? {
    accountId: row.account_id,
    username: row.username,
    displayName: row.display_name,
    enabled: Boolean(row.enabled),
    version: row.version,
  } : null;
}
function publicAccess(row) {
  return row ? {
    accountId: row.account_id,
    app: row.app,
    role: row.role,
    permissions: JSON.parse(row.permissions_json),
    config: JSON.parse(row.config_json),
    enabled: Boolean(row.enabled),
    version: row.version,
  } : null;
}

export function validateImportRecord(record) {
  if (!record?.account || !Array.isArray(record.access)) fail("invalid-import-record");
  const account = accountInput(record.account);
  const apps = new Set();
  for (const input of record.access) {
    const access = accessInput({ ...input, accountId: account.accountId });
    if (apps.has(access.app)) fail("duplicate-app-grant");
    apps.add(access.app);
  }
}

export function createAccountStore({ stateDir, now = Date.now }) {
  fs.mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  const filename = path.join(stateDir, "accounts.db");
  // Create restrictively before SQLite opens the file (including WAL/SHM files).
  const fd = fs.openSync(filename, "a", 0o600);
  fs.closeSync(fd);
  fs.chmodSync(filename, 0o600);
  const db = new Database(filename);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  db.pragma("busy_timeout = 5000");
  db.exec(`
    CREATE TABLE IF NOT EXISTS accounts (
      account_id TEXT PRIMARY KEY,
      username TEXT NOT NULL UNIQUE,
      display_name TEXT NOT NULL,
      password TEXT NOT NULL,
      enabled INTEGER NOT NULL CHECK (enabled IN (0, 1)),
      version INTEGER NOT NULL CHECK (version >= 1)
    );
    CREATE TABLE IF NOT EXISTS account_access (
      account_id TEXT NOT NULL REFERENCES accounts(account_id),
      app TEXT NOT NULL CHECK (app IN ('invoice', 'staff', 'expense')),
      role TEXT NOT NULL,
      permissions_json TEXT NOT NULL,
      config_json TEXT NOT NULL,
      enabled INTEGER NOT NULL CHECK (enabled IN (0, 1)),
      version INTEGER NOT NULL CHECK (version >= 1),
      PRIMARY KEY (account_id, app)
    );
    CREATE TABLE IF NOT EXISTS account_audit (
      id INTEGER PRIMARY KEY,
      occurred_at INTEGER NOT NULL,
      actor TEXT NOT NULL,
      action TEXT NOT NULL,
      account_id TEXT NOT NULL,
      app TEXT,
      version INTEGER NOT NULL,
      details_json TEXT NOT NULL DEFAULT '{}'
    );
  `);
  const auditColumns = new Set(db.prepare("PRAGMA table_info(account_audit)").all().map((column) => column.name));
  if (!auditColumns.has("details_json")) db.exec("ALTER TABLE account_audit ADD COLUMN details_json TEXT NOT NULL DEFAULT '{}'");
  function audit(actor, action, accountId, app, version, details = {}) {
    db.prepare(`INSERT INTO account_audit (occurred_at, actor, action, account_id, app, version, details_json)
      VALUES (?, ?, ?, ?, ?, ?, ?)`).run(now(), requiredText(actor), action, accountId, app, version, JSON.stringify(details));
  }
  function getAccount(accountId) {
    return publicAccount(db.prepare(`SELECT ${PUBLIC_ACCOUNT_COLUMNS} FROM accounts WHERE account_id = ?`).get(accountId));
  }
  function getAccess(accountId, app) {
    return publicAccess(db.prepare("SELECT * FROM account_access WHERE account_id = ? AND app = ?").get(accountId, application(app)));
  }
  function insertAccount(input, actor) {
    const value = accountInput(input);
    if (getAccount(value.accountId) || db.prepare("SELECT 1 FROM accounts WHERE username = ?").get(value.username)) {
      fail("account-conflict");
    }
    db.prepare(`INSERT INTO accounts (account_id, username, display_name, password, enabled, version)
      VALUES (@accountId, @username, @displayName, @password, @enabled, 1)`)
      .run({ ...value, enabled: Number(value.enabled) });
    audit(actor, "account:create", value.accountId, null, 1, {
      username: value.username, displayName: value.displayName, enabled: value.enabled,
    });
    return getAccount(value.accountId);
  }
  function putAccess(input, { actor, expectedVersion }) {
    const value = accessInput(input);
    if (!getAccount(value.accountId)) fail("account-not-found");
    const existing = getAccess(value.accountId, value.app);
    if (!Number.isSafeInteger(expectedVersion) || expectedVersion !== (existing?.version ?? 0)) fail("version-conflict");
    const version = expectedVersion + 1;
    db.prepare(`INSERT INTO account_access (account_id, app, role, permissions_json, config_json, enabled, version)
      VALUES (@accountId, @app, @role, @permissionsJson, @configJson, @enabled, @version)
      ON CONFLICT(account_id, app) DO UPDATE SET role = excluded.role,
        permissions_json = excluded.permissions_json, config_json = excluded.config_json,
        enabled = excluded.enabled, version = excluded.version`)
      .run({ ...value, enabled: Number(value.enabled), version });
    audit(actor, "access:put", value.accountId, value.app, version, {
      before: existing ? { role: existing.role, permissions: existing.permissions, config: existing.config, enabled: existing.enabled } : null,
      after: { role: value.role, permissions: JSON.parse(value.permissionsJson), config: JSON.parse(value.configJson), enabled: value.enabled },
    });
    return getAccess(value.accountId, value.app);
  }

  return {
    getAccount,
    getAccess,
    listAccounts() {
      return db.prepare(`SELECT ${PUBLIC_ACCOUNT_COLUMNS} FROM accounts ORDER BY account_id`).all().map(publicAccount);
    },
    listAccess(accountId) {
      return db.prepare("SELECT * FROM account_access WHERE account_id = ? ORDER BY app").all(accountId).map(publicAccess);
    },
    authenticate(username, password) {
      if (typeof username !== "string" || typeof password !== "string") return null;
      const row = db.prepare("SELECT * FROM accounts WHERE username = ?").get(username);
      const matches = secureEqual(password, row?.password ?? "");
      return row?.enabled && matches ? publicAccount(row) : null;
    },
    getAuthorization(accountId, app) {
      const account = getAccount(accountId);
      const access = getAccess(accountId, app);
      return account?.enabled && access?.enabled ? { account, access } : null;
    },
    createAccount(input, { actor }) {
      return db.transaction(() => insertAccount(input, actor)).immediate();
    },
    updateAccount(accountId, changes, { actor, expectedVersion }) {
      return db.transaction(() => {
        if (!changes || Object.keys(changes).some((key) => !["username", "displayName", "password", "enabled"].includes(key))) {
          fail("invalid-account-change");
        }
        const existing = db.prepare("SELECT * FROM accounts WHERE account_id = ?").get(accountId);
        if (!existing) fail("account-not-found");
        if (!Number.isSafeInteger(expectedVersion) || existing.version !== expectedVersion) fail("version-conflict");
        const value = accountInput({ ...publicAccount(existing), password: existing.password, ...changes });
        if (db.prepare("SELECT 1 FROM accounts WHERE username = ? AND account_id != ?").get(value.username, accountId)) {
          fail("account-conflict");
        }
        db.prepare(`UPDATE accounts SET username = @username, display_name = @displayName,
          password = @password, enabled = @enabled, version = version + 1 WHERE account_id = @accountId`)
          .run({ ...value, enabled: Number(value.enabled) });
        audit(actor, "account:update", accountId, null, expectedVersion + 1, {
          before: { username: existing.username, displayName: existing.display_name, enabled: Boolean(existing.enabled) },
          after: { username: value.username, displayName: value.displayName, enabled: value.enabled },
          passwordChanged: Object.hasOwn(changes, "password"),
        });
        return getAccount(accountId);
      }).immediate();
    },
    putAccess(input, options) {
      return db.transaction(() => putAccess(input, options)).immediate();
    },
    importAccounts(records, { actor }) {
      // Bootstrap only. Never overwrite a live account or partially import a plan.
      return db.transaction(() => {
        if (db.prepare("SELECT 1 FROM accounts LIMIT 1").get()) fail("import-requires-empty-store");
        if (!Array.isArray(records) || !records.length) fail("empty-import");
        records.forEach(validateImportRecord);
        for (const record of records) {
          insertAccount(record.account, actor);
          for (const access of record.access) {
            putAccess({ ...access, accountId: record.account.accountId }, { actor, expectedVersion: 0 });
          }
        }
        return { accounts: records.length, grants: records.reduce((sum, record) => sum + record.access.length, 0) };
      }).immediate();
    },
    listAudit() {
      // Audit records authorization changes but never password values.
      return db.prepare("SELECT * FROM account_audit ORDER BY id").all().map((row) => ({
        ...row,
        details: JSON.parse(row.details_json),
        details_json: undefined,
      }));
    },
    close() { db.close(); },
  };
}
