import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import Database from "better-sqlite3";
import { createAccountStore } from "../server/account-store.js";
import { createSessionDatabase } from "../server/database.js";
import { createUnifiedSessionService } from "../server/unified-session-service.js";
import { createSessionService } from "../server/session-service.js";
import { loadConfig } from "../server/config.js";

const actor = "test-operator";
const identity = { accountId: "person-1", username: "person", displayName: "测试账号", password: " secret " };
function grant(app, overrides = {}) {
  return { accountId: identity.accountId, app, role: "viewer", enabled: true,
    permissions: ["record:view"], config: { viewScope: { stores: ["fuzzy"], ownership: "self" } }, ...overrides };
}
function fixture(t) {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "gateway-accounts-"));
  const accounts = createAccountStore({ stateDir });
  const database = createSessionDatabase({ stateDir });
  const clock = { value: 1000 };
  const sessions = createUnifiedSessionService({ accounts, database, ttlSeconds: 60, now: () => clock.value });
  t.after(() => { database.close(); accounts.close(); fs.rmSync(stateDir, { recursive: true, force: true }); });
  return { stateDir, accounts, database, sessions, clock };
}
function seed(accounts, apps = ["invoice", "staff", "expense"]) {
  accounts.createAccount(identity, { actor });
  for (const app of apps) accounts.putAccess(grant(app), { actor, expectedVersion: 0 });
}

test("accounts preserve exact credentials and never return passwords in public data or audit", (t) => {
  const { accounts, stateDir } = fixture(t);
  const created = accounts.createAccount(identity, { actor });
  assert.equal(created.version, 1);
  assert.equal(accounts.authenticate("person", "secret"), null);
  assert.equal(accounts.authenticate(" person ", " secret "), null);
  assert.deepEqual(accounts.authenticate("person", " secret "), created);
  accounts.putAccess(grant("invoice"), { actor, expectedVersion: 0 });
  const outputs = [created, accounts.listAccounts(), accounts.getAuthorization("person-1", "invoice"), accounts.listAudit()];
  assert.doesNotMatch(JSON.stringify(outputs), /password| secret /);
  assert.equal(fs.statSync(path.join(stateDir, "accounts.db")).mode & 0o777, 0o600);
  for (const suffix of ["-wal", "-shm"]) {
    const file = path.join(stateDir, `accounts.db${suffix}`);
    if (fs.existsSync(file)) assert.equal(fs.statSync(file).mode & 0o077, 0);
  }
});

test("invoice and staff grants are independent; role names do not grant other applications", (t) => {
  const { accounts, sessions } = fixture(t);
  seed(accounts, ["invoice"]);
  const login = sessions.login("person", " secret ");
  assert.deepEqual(login.apps, ["invoice"]);
  assert.ok(sessions.resolve(login.token, "invoice"));
  assert.equal(sessions.resolve(login.token, "staff"), null);
  assert.equal(sessions.resolve(login.token, "expense"), null);
  assert.equal(sessions.resolve(login.token, "reimbursement"), null);
});

test("changing one app authorization invalidates only that app in existing sessions", (t) => {
  const { accounts, sessions } = fixture(t);
  seed(accounts);
  const { token } = sessions.login("person", " secret ");
  accounts.putAccess(grant("staff", { permissions: [] }), { actor, expectedVersion: 1 });
  assert.equal(sessions.resolve(token, "staff"), null);
  assert.ok(sessions.resolve(token, "invoice"));
  assert.ok(sessions.resolve(token, "expense"));
  const fresh = sessions.login("person", " secret ");
  assert.deepEqual(sessions.resolve(fresh.token, "staff").access.permissions, []);
});

test("password and identity updates invalidate all prior app sessions without restarting", (t) => {
  const { accounts, sessions } = fixture(t);
  seed(accounts);
  const login = sessions.login("person", " secret ");
  accounts.updateAccount(identity.accountId, { password: "new-password" }, { actor, expectedVersion: 1 });
  for (const app of login.apps) assert.equal(sessions.resolve(login.token, app), null);
  assert.equal(sessions.login("person", " secret "), null);
  const fresh = sessions.login("person", "new-password");
  assert.ok(sessions.resolve(fresh.token, "expense"));
  accounts.updateAccount(identity.accountId, { username: "renamed" }, { actor, expectedVersion: 2 });
  assert.equal(sessions.resolve(fresh.token, "expense"), null);
  assert.equal(sessions.login("person", "new-password"), null);
  assert.ok(sessions.login("renamed", "new-password"));
});

test("disabling and re-enabling accounts or grants never resurrects old sessions", (t) => {
  const { accounts, sessions } = fixture(t);
  seed(accounts);
  const { token } = sessions.login("person", " secret ");
  accounts.putAccess(grant("expense", { enabled: false }), { actor, expectedVersion: 1 });
  assert.equal(accounts.getAuthorization(identity.accountId, "expense"), null);
  accounts.putAccess(grant("expense"), { actor, expectedVersion: 2 });
  assert.equal(sessions.resolve(token, "expense"), null);
  assert.ok(sessions.resolve(token, "invoice"));
  accounts.updateAccount(identity.accountId, { enabled: false }, { actor, expectedVersion: 1 });
  assert.equal(sessions.login("person", " secret "), null);
  accounts.updateAccount(identity.accountId, { enabled: true }, { actor, expectedVersion: 2 });
  for (const app of ["invoice", "staff", "expense"]) assert.equal(sessions.resolve(token, app), null);
});

test("accounts without an enabled grant cannot create a unified session", (t) => {
  const { accounts, sessions } = fixture(t);
  seed(accounts, []);
  assert.equal(sessions.login("person", " secret "), null);
  accounts.putAccess(grant("staff", { enabled: false }), { actor, expectedVersion: 0 });
  assert.equal(sessions.login("person", " secret "), null);
});

test("grant additions require a new login; expiration and logout remove sessions", (t) => {
  const { accounts, sessions, clock } = fixture(t);
  seed(accounts, ["invoice"]);
  const { token } = sessions.login("person", " secret ");
  accounts.putAccess(grant("staff"), { actor, expectedVersion: 0 });
  assert.equal(sessions.resolve(token, "staff"), null);
  const fresh = sessions.login("person", " secret ");
  assert.ok(sessions.resolve(fresh.token, "staff"));
  sessions.destroy(fresh.token);
  assert.equal(sessions.resolve(fresh.token, "staff"), null);
  clock.value += 60000;
  assert.equal(sessions.resolve(token, "invoice"), null);
});

test("legacy and unified sessions cannot be interpreted as each other", (t) => {
  const { accounts, database, sessions } = fixture(t);
  seed(accounts);
  const config = loadConfig({ INVOICE_ADMIN_USERNAME: "legacy", INVOICE_ADMIN_PASSWORD: "pw",
    WECHATY_ADMIN_USERNAME: "legacy", WECHATY_ADMIN_PASSWORD: "pw" });
  const legacy = createSessionService({ config, database, now: () => 1000 });
  const old = legacy.create(legacy.authenticate("legacy", "pw"));
  assert.equal(sessions.resolve(old.token, "invoice"), null);
  const fresh = sessions.login("person", " secret ");
  assert.equal(legacy.resolve(fresh.token, "invoice"), null);
});

test("stale updates and duplicate usernames fail atomically without audit entries", (t) => {
  const { accounts } = fixture(t);
  seed(accounts);
  accounts.createAccount({ ...identity, accountId: "person-2", username: "other" }, { actor });
  const before = accounts.listAudit();
  assert.throws(() => accounts.updateAccount(identity.accountId, { username: "other" }, { actor, expectedVersion: 1 }), /account-conflict/);
  assert.throws(() => accounts.updateAccount(identity.accountId, { password: "pw" }, { actor, expectedVersion: 0 }), /version-conflict/);
  assert.throws(() => accounts.putAccess(grant("invoice"), { actor, expectedVersion: 0 }), /version-conflict/);
  assert.deepEqual(accounts.listAudit(), before);
  assert.equal(accounts.getAccount(identity.accountId).version, 1);
  assert.ok(accounts.authenticate("person", " secret "));
});

test("invalid writes fail closed and roll back including actor validation", (t) => {
  const { accounts } = fixture(t);
  assert.throws(() => accounts.createAccount(identity, { actor: "" }), /invalid-text/);
  assert.deepEqual(accounts.listAccounts(), []);
  seed(accounts, []);
  assert.throws(() => accounts.putAccess(grant("other"), { actor, expectedVersion: 0 }), /invalid-app/);
  assert.throws(() => accounts.putAccess(grant("invoice", { enabled: "false" }), { actor, expectedVersion: 0 }), /invalid-enabled/);
  assert.throws(() => accounts.putAccess(grant("invoice", { enabled: null }), { actor, expectedVersion: 0 }), /invalid-enabled/);
  assert.throws(() => accounts.putAccess(grant("invoice", { config: { stores: undefined } }), { actor, expectedVersion: 0 }), /invalid-config/);
  assert.throws(() => accounts.updateAccount(identity.accountId, { accountId: "replacement" }, { actor, expectedVersion: 1 }), /invalid-account-change/);
  assert.deepEqual(accounts.listAccess(identity.accountId), []);
});

test("bootstrap imports are all-or-nothing and cannot overwrite an existing store", (t) => {
  const { accounts } = fixture(t);
  const records = [{ account: identity, access: [grant("invoice")] },
    { account: { ...identity, accountId: "person-2" }, access: [] }];
  assert.throws(() => accounts.importAccounts(records, { actor }), /account-conflict/);
  assert.deepEqual(accounts.listAccounts(), []);
  assert.deepEqual(accounts.listAudit(), []);
  assert.deepEqual(accounts.importAccounts(records.slice(0, 1), { actor }), { accounts: 1, grants: 1 });
  assert.throws(() => accounts.importAccounts(records.slice(0, 1), { actor }), /import-requires-empty-store/);
  assert.equal(accounts.getAccount(identity.accountId).version, 1);
});

test("data persists across a second store connection and sessions contain no passwords", (t) => {
  const { accounts, stateDir, sessions } = fixture(t);
  seed(accounts);
  const second = createAccountStore({ stateDir });
  try {
    assert.ok(second.authenticate("person", " secret "));
    const { token } = sessions.login("person", " secret ");
    second.putAccess(grant("invoice", { enabled: false }), { actor, expectedVersion: 1 });
    assert.equal(sessions.resolve(token, "invoice"), null);
    const db = new Database(path.join(stateDir, "sessions.db"), { readonly: true });
    try {
      const serialized = JSON.stringify(db.prepare("SELECT * FROM admin_sessions").all());
      assert.doesNotMatch(serialized, /password| secret /);
      assert.ok(!serialized.includes(token));
    } finally { db.close(); }
  } finally { second.close(); }
});
