import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { loadConfig } from "../server/config.js";
import { planLegacyAccountImport } from "../server/legacy-account-import.js";
import { createAccountStore } from "../server/account-store.js";

const env = {
  INVOICE_ADMIN_USERNAME: "shared-admin", INVOICE_ADMIN_PASSWORD: " secret invoice ",
  WECHATY_ADMIN_USERNAME: "shared-admin", WECHATY_ADMIN_PASSWORD: " secret expense ",
  WECHATY_REIMBURSEMENT_ACCOUNTS_JSON: JSON.stringify([
    { accountId: "partner-1", username: "partner", password: " partner secret ", role: "partner" },
    { accountId: "manager-1", username: "manager", password: " manager secret ", role: "manager", managerStores: ["fuzzyqz"] },
  ]),
};
function config(overrides = {}) { return loadConfig({ ...env, ...overrides }); }
function mergedMapping() {
  const mapping = planLegacyAccountImport(config()).preview.mapping;
  const invoice = mapping.accounts.shift();
  mapping.accounts[0].sources.push(...invoice.sources);
  mapping.accounts[0].credentialSource = "invoice:invoice-admin";
  return mapping;
}
function temp(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "account-import-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}
const script = fileURLToPath(new URL("../scripts/import-legacy-accounts.js", import.meta.url));
function cli(stateDir, args = [], overrides = {}) {
  return spawnSync(process.execPath, [script, ...args], { encoding: "utf8",
    env: { ...process.env, ...env, ADMIN_AUTH_STATE_DIR: stateDir, ...overrides } });
}

test("default preview does not merge matching identities and exposes no credentials", () => {
  const plan = planLegacyAccountImport(config());
  assert.equal(plan.preview.accounts.length, 4);
  assert.equal(plan.preview.ready, false);
  assert.deepEqual(plan.preview.conflicts, [{ code: "duplicate-username", value: "shared-admin" }]);
  assert.doesNotMatch(JSON.stringify(plan), /password|secret/);
});

test("same username and password still require an explicit merge or rename", () => {
  const plan = planLegacyAccountImport(config({ INVOICE_ADMIN_PASSWORD: "same", WECHATY_ADMIN_PASSWORD: "same" }));
  assert.equal(plan.preview.ready, false);
  assert.equal(plan.preview.accounts.length, 4);
});

test("explicit mapping combines grants, preserves expense ids and selects credentials exactly", (t) => {
  const root = temp(t);
  const plan = planLegacyAccountImport(config(), mergedMapping());
  assert.equal(plan.preview.ready, true);
  const store = createAccountStore({ stateDir: root });
  try {
    assert.deepEqual(plan.apply(store), { accounts: 3, grants: 5 });
    const admin = store.authenticate("shared-admin", " secret invoice ");
    assert.equal(admin.accountId, "reimbursement-admin");
    assert.equal(store.authenticate("shared-admin", "secret invoice"), null);
    assert.equal(store.authenticate("shared-admin", "secret expense"), null);
    assert.deepEqual(store.listAccess(admin.accountId).map((access) => access.app), ["expense", "invoice", "staff"]);
    assert.ok(store.authenticate("manager", "manager secret"));
    assert.equal(store.getAccount("manager-1").accountId, "manager-1");
  } finally { store.close(); }
});

test("migration preserves partner submission and exact manager ownership and channel restrictions", () => {
  const { accounts } = planLegacyAccountImport(config()).preview;
  const partner = accounts.find((account) => account.accountId === "partner-1").access[0];
  assert.deepEqual(partner.permissions, ["report:view", "attachment:view", "report:submit"]);
  assert.deepEqual(partner.config.viewScope, { ownership: "any", stores: "all", channels: "all" });
  assert.deepEqual(partner.config.submitScope.channels, ["reimbursement_fuzzy", "reimbursement_peanut", "reimbursement_fuzzyqz"]);
  const manager = accounts.find((account) => account.accountId === "manager-1").access[0];
  assert.deepEqual(manager.config.viewScope, {
    ownership: "self", stores: ["fuzzyqz"], channels: ["reimbursement_fuzzy_qz_manager"],
  });
  assert.deepEqual(manager.config.submitScope, { stores: ["fuzzyqz"], channels: ["reimbursement_fuzzy_qz_manager"] });
  assert.ok(!manager.permissions.includes("report:edit"));
  assert.ok(!manager.permissions.includes("report:delete"));
});

test("mapping rejects missing sources, implicit credential selection, id changes and invented fields", () => {
  const missing = mergedMapping();
  missing.accounts.pop();
  assert.throws(() => planLegacyAccountImport(config(), missing), /all-legacy-sources-required/);
  const noCredential = mergedMapping();
  delete noCredential.accounts[0].credentialSource;
  assert.throws(() => planLegacyAccountImport(config(), noCredential), /credential-source-required/);
  const changedId = mergedMapping();
  changedId.accounts[0].accountId = "new-admin";
  assert.throws(() => planLegacyAccountImport(config(), changedId), /expense-account-id-must-be-preserved/);
  const injected = mergedMapping();
  injected.accounts[1].permissions = ["report:delete"];
  assert.throws(() => planLegacyAccountImport(config(), injected), /invalid-import-mapping/);
});

test("CLI preview does not create the state directory even when conflicts exist", (t) => {
  const stateDir = path.join(temp(t), "nonexistent-state");
  const result = cli(stateDir);
  assert.equal(result.status, 2, result.stderr);
  assert.equal(JSON.parse(result.stdout).ready, false);
  assert.equal(fs.existsSync(stateDir), false);
  assert.doesNotMatch(result.stdout + result.stderr, /password|secret/);
});

test("CLI refuses conflicting apply before opening SQLite", (t) => {
  const stateDir = path.join(temp(t), "nonexistent-state");
  const result = cli(stateDir, ["--apply"]);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /resolve-import-conflicts-first/);
  assert.equal(fs.existsSync(stateDir), false);
});

test("CLI apply bootstraps once, preserves live session database and does not switch login", (t) => {
  const root = temp(t);
  const stateDir = path.join(root, "state");
  fs.mkdirSync(stateDir);
  fs.writeFileSync(path.join(stateDir, "sessions.db"), "untouched-session-file");
  const mappingFile = path.join(root, "mapping.json");
  fs.writeFileSync(mappingFile, JSON.stringify(mergedMapping()));
  const result = cli(stateDir, ["--mapping", mappingFile, "--apply"]);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), { success: true, accounts: 3, grants: 5, loginMode: "legacy-unchanged" });
  assert.equal(fs.readFileSync(path.join(stateDir, "sessions.db"), "utf8"), "untouched-session-file");
  const repeat = cli(stateDir, ["--mapping", mappingFile, "--apply"]);
  assert.equal(repeat.status, 1);
  assert.match(repeat.stderr, /import-requires-empty-store/);
});

test("CLI redacts JSON parser errors that might contain raw credentials", (t) => {
  const stateDir = path.join(temp(t), "state");
  const result = cli(stateDir, [], { WECHATY_REIMBURSEMENT_ACCOUNTS_JSON: '{"password":"NEVER-PRINT-THIS", invalid}' });
  assert.equal(result.status, 1);
  assert.doesNotMatch(result.stdout + result.stderr, /NEVER-PRINT-THIS|password/);
  assert.match(result.stderr, /import-input-or-storage-error/);
  assert.equal(fs.existsSync(stateDir), false);
});

test("invalid mapped identities fail during preview before creating a database", (t) => {
  const root = temp(t);
  const mapping = mergedMapping();
  mapping.accounts[0].username = "";
  const mappingFile = path.join(root, "mapping.json");
  fs.writeFileSync(mappingFile, JSON.stringify(mapping));
  const stateDir = path.join(root, "state");
  const result = cli(stateDir, ["--mapping", mappingFile, "--apply"]);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /invalid-text/);
  assert.equal(fs.existsSync(stateDir), false);
});

test("editing preview output cannot change the import plan's grants", (t) => {
  const plan = planLegacyAccountImport(config(), mergedMapping());
  const partner = plan.preview.accounts.find((account) => account.accountId === "partner-1");
  partner.access[0].permissions.push("report:delete");
  const store = createAccountStore({ stateDir: temp(t) });
  try {
    plan.apply(store);
    assert.ok(!store.getAccess("partner-1", "expense").permissions.includes("report:delete"));
  } finally { store.close(); }
});
