import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { createAccountStore } from "../server/account-store.js";
import { normalizeManagedAccess, accessDestination } from "../server/account-policy.js";
import { sanitizeReturnTo, scopeForReturnTo, renderLoginPage } from "../server/login-page.js";

test("store roles have explicit operations and fixed or selected store scope", () => {
  const base = { accountId: "person", app: "store", enabled: "1", permissions: ["coupon:view"] };
  for (const role of ["admin", "partner"]) {
    const result = normalizeManagedAccess({ ...base, role, viewStores: ["peanut"] });
    assert.equal(result.config.viewScope.stores, "all");
    assert.deepEqual(result.permissions, ["coupon:view"]);
    assert.equal(accessDestination("store", result), "/store");
  }
  assert.throws(() => normalizeManagedAccess({ ...base, role: "manager" }), /empty-view-scope/);
  const manager = normalizeManagedAccess({ ...base, role: "manager", viewStores: ["peanut", "fuzzy_qz"] });
  assert.deepEqual(manager.config.viewScope, { ownership: "any", stores: ["fuzzy_qz", "peanut"] });
  for (const permission of ["coupon:issue", "coupon:redeem", "coupon:delete"]) assert.throws(() => normalizeManagedAccess({ ...base, role: "admin", permissions: [permission] }), /missing-permission-dependency/);
  assert.equal(sanitizeReturnTo("/store"), "/store"); assert.equal(sanitizeReturnTo("/store/"), "/store/");
  assert.notEqual(sanitizeReturnTo("/store-evil"), "/store-evil");
  assert.equal(scopeForReturnTo("/store", "unified"), "store");
  assert.match(renderLoginPage({ returnTo: "/store" }), /门店管理/);
});

test("legacy CHECK migration preserves accounts, grants, versions and audit and is repeatable", (t) => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "store-migration-"));
  t.after(() => fs.rmSync(stateDir, { recursive: true, force: true }));
  const filename = path.join(stateDir, "accounts.db");
  let accounts = createAccountStore({ stateDir });
  accounts.createAccount({ accountId: "person", username: "person", displayName: "原账号", password: " original password " }, { actor: "fixture" });
  for (const app of ["invoice", "staff", "expense"]) accounts.putAccess({ accountId: "person", app, role: "admin", permissions: ["fixture:view"], config: { exact: app } }, { actor: "fixture", expectedVersion: 0 });
  accounts.close();
  // Build the actual prior schema, preserving all seeded values byte for byte.
  let db = new Database(filename);
  db.exec(`ALTER TABLE account_access RENAME TO saved_access;
    CREATE TABLE account_access (
      account_id TEXT NOT NULL REFERENCES accounts(account_id),
      app TEXT NOT NULL CHECK(app IN ('invoice', 'staff', 'expense')),
      role TEXT NOT NULL, permissions_json TEXT NOT NULL, config_json TEXT NOT NULL,
      enabled INTEGER NOT NULL CHECK(enabled IN (0,1)), version INTEGER NOT NULL CHECK(version >= 1), PRIMARY KEY(account_id,app)
    );
    INSERT INTO account_access SELECT * FROM saved_access;
    DROP TABLE saved_access;`);
  const before = Object.fromEntries(["accounts", "account_access", "account_audit"].map((table) => [table, db.prepare(`SELECT * FROM ${table}`).all()])); db.close();
  for (let pass = 0; pass < 2; pass++) {
    accounts = createAccountStore({ stateDir });
    assert.ok(accounts.authenticate("person", " original password "));
    assert.equal(accounts.getAccess("person", "store"), null); accounts.close();
    db = new Database(filename);
    for (const [table, rows] of Object.entries(before)) assert.deepEqual(db.prepare(`SELECT * FROM ${table}`).all(), rows);
    assert.deepEqual(db.pragma("foreign_key_check"), []); db.close();
  }
  accounts = createAccountStore({ stateDir });
  accounts.putAccess(normalizeManagedAccess({ accountId: "person", app: "store", role: "admin", enabled: "1", permissions: ["coupon:view"] }), { actor: "fixture", expectedVersion: 0 });
  assert.equal(accounts.getAccess("person", "store").version, 1); accounts.close();
});
