import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { createAccountStore } from "../server/account-store.js";
import { normalizeManagedAccess, accessDestination } from "../server/account-policy.js";
import { sanitizeReturnTo, scopeForReturnTo } from "../server/login-page.js";

test("business grants are explicit, scoped, and have their own login destination", () => {
  const body = { accountId: "a", app: "business", enabled: "1", role: "viewer", permissions: ["revenue:view"], viewStores: ["fuzzy"] };
  const access = normalizeManagedAccess(body);
  assert.deepEqual(access.config.viewScope.stores, ["fuzzy"]); assert.equal(accessDestination("business", access), "/business");
  assert.throws(() => normalizeManagedAccess({ ...body, permissions: [] }));
  assert.throws(() => normalizeManagedAccess({ ...body, viewStores: [] }));
  assert.throws(() => normalizeManagedAccess({ ...body, permissions: ["coupon:view"] }));
  assert.equal(sanitizeReturnTo("/business"), "/business"); assert.equal(scopeForReturnTo("/business", "unified"), "business");
  assert.notEqual(sanitizeReturnTo("/business-evil"), "/business-evil");
});
test("adding business preserves all four previous apps, accounts, versions and audit", t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "business-migration-")); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  let store = createAccountStore({ stateDir: dir });
  store.createAccount({ accountId: "a", username: "a", password: " unchanged " }, { actor: "test" });
  for (const app of ["invoice", "staff", "expense", "store"]) store.putAccess({ accountId: "a", app, role: "viewer", permissions: ["original:view"], config: { original: app } }, { actor: "test", expectedVersion: 0 });
  store.close();
  let db = new Database(path.join(dir, "accounts.db"));
  db.exec(`ALTER TABLE account_access RENAME TO previous;
    CREATE TABLE account_access(account_id TEXT NOT NULL REFERENCES accounts(account_id), app TEXT NOT NULL CHECK(app IN ('invoice','staff','expense','store')),role TEXT NOT NULL,permissions_json TEXT NOT NULL,config_json TEXT NOT NULL,enabled INTEGER NOT NULL CHECK(enabled IN(0,1)),version INTEGER NOT NULL CHECK(version>=1),PRIMARY KEY(account_id,app));
    INSERT INTO account_access SELECT * FROM previous; DROP TABLE previous;`);
  const before = Object.fromEntries(["accounts", "account_access", "account_audit"].map(table => [table, db.prepare(`SELECT * FROM ${table}`).all()])); db.close();
  for (let pass = 0; pass < 2; pass++) {
    store = createAccountStore({ stateDir: dir }); assert.equal(store.getAccess("a", "business"), null); assert.ok(store.authenticate("a", " unchanged ")); store.close();
    db = new Database(path.join(dir, "accounts.db"));
    for (const [table, rows] of Object.entries(before)) assert.deepEqual(db.prepare(`SELECT * FROM ${table}`).all(), rows);
    assert.deepEqual(db.pragma("foreign_key_check"), []); db.close();
  }
  store = createAccountStore({ stateDir: dir });
  store.putAccess(normalizeManagedAccess({ accountId: "a", app: "business", role: "viewer", enabled: "1", permissions: ["revenue:view"], viewStores: ["fuzzy", "fuzzy_qz", "peanut"] }), { actor: "test", expectedVersion: 0 });
  assert.equal(store.getAccess("a", "business").config.viewScope.stores, "all"); store.close();
});
