import assert from "node:assert/strict";
import test from "node:test";

import {
  accessDestination,
  effectiveExpenseChannels,
  normalizeManagedAccess,
} from "../server/account-policy.js";

const base = { accountId: "person", enabled: "1", role: "viewer" };

test("all stores are derived from the explicit child selections", () => {
  const access = normalizeManagedAccess({
    ...base,
    app: "invoice",
    permissions: ["submission:view", "attachment:view"],
    viewStoresMaster: "1",
    viewStores: ["fuzzy", "fuzzy_qz"],
  });
  assert.deepEqual(access.config.viewScope.stores, ["fuzzy", "fuzzy_qz"]);
  assert.throws(() => normalizeManagedAccess({ ...base, app: "invoice", permissions: ["submission:view"] }), /empty-view-scope/);
});

test("expense matrices derive consistent store and channel intersections", () => {
  const access = normalizeManagedAccess({
    accountId: "person",
    app: "expense",
    enabled: "1",
    role: "manager",
    ownership: "self",
    permissions: ["report:view", "attachment:view", "report:submit", "report:import"],
    viewChannels: ["reimbursement_fuzzy_manager", "reimbursement_fuzzy_qz_manager"],
    submitChannels: ["reimbursement_fuzzy_manager"],
    importChannels: ["reimbursement_fuzzyqz"],
  });
  assert.deepEqual(access.config, {
    viewScope: { ownership: "self", stores: ["fuzzy", "fuzzyqz"], channels: ["reimbursement_fuzzy_manager", "reimbursement_fuzzy_qz_manager"] },
    submitScope: { stores: ["fuzzy"], channels: ["reimbursement_fuzzy_manager"] },
    importScope: { stores: ["fuzzyqz"], channels: ["reimbursement_fuzzyqz"] },
  });
  assert.deepEqual(effectiveExpenseChannels(access.config.viewScope), ["reimbursement_fuzzy_manager", "reimbursement_fuzzy_qz_manager"]);
});

test("permission dependencies and enabled entry behavior fail closed", () => {
  assert.throws(() => normalizeManagedAccess({ ...base, app: "invoice", permissions: ["submission:delete"], viewStores: ["fuzzy"] }), /missing-permission-dependency/);
  assert.throws(() => normalizeManagedAccess({ ...base, app: "staff", permissions: [], viewStores: ["fuzzy"] }), /missing-entry-permission/);
  assert.throws(() => normalizeManagedAccess({ accountId: "person", app: "expense", enabled: "1", role: "manager", ownership: "self", permissions: ["report:submit"] }), /empty-submit-scope/);
  const submitOnly = normalizeManagedAccess({ accountId: "person", app: "expense", enabled: "1", role: "manager", ownership: "self", permissions: ["report:submit"], submitChannels: ["reimbursement_fuzzy_manager"] });
  assert.equal(accessDestination("expense", submitOnly), "/expense/submit");
});

test("expense self deletion is explicit and keeps the configured view scope", () => {
  const body = {
    accountId: "person", app: "expense", enabled: "1", role: "manager", ownership: "any",
    viewChannels: ["reimbursement_fuzzy_manager"], permissions: ["report:view", "report:delete:self"],
  };
  const access = normalizeManagedAccess(body);
  assert.deepEqual(access.permissions, ["report:delete:self", "report:view"]);
  assert.deepEqual(access.config.viewScope, { ownership: "any", stores: ["fuzzy"], channels: ["reimbursement_fuzzy_manager"] });
  assert.equal(accessDestination("expense", access), "/expense");
  assert.throws(() => normalizeManagedAccess({ ...body, permissions: ["report:delete:self"] }), /missing-permission-dependency/);
  assert.throws(() => normalizeManagedAccess({ ...body, viewChannels: [] }), /empty-view-scope/);

  const viewOnly = normalizeManagedAccess({ ...body, permissions: ["report:view"] });
  assert.deepEqual(viewOnly.permissions, ["report:view"]);
  const fullDelete = normalizeManagedAccess({ ...body, role: "admin", permissions: ["report:view", "report:delete"] });
  assert.deepEqual(fullDelete.permissions, ["report:delete", "report:view"]);
  assert.deepEqual(fullDelete.config.viewScope, access.config.viewScope);
  const both = normalizeManagedAccess({ ...body, permissions: ["report:view", "report:delete", "report:delete:self"] });
  assert.deepEqual(both.permissions, ["report:delete", "report:delete:self", "report:view"]);
  assert.deepEqual(both.config.viewScope, access.config.viewScope);
});

test("disabling an existing app retains its complete configuration", () => {
  const existing = { accountId: "person", app: "expense", role: "admin", enabled: true, version: 7, permissions: ["report:view"], config: { viewScope: { ownership: "any", stores: "all", channels: "all" }, submitScope: { stores: [], channels: [] } } };
  assert.deepEqual(normalizeManagedAccess({ app: "expense", role: "admin" }, existing), { ...existing, enabled: false });
});
