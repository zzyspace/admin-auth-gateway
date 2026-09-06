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

test("disabling an existing app retains its complete configuration", () => {
  const existing = { accountId: "person", app: "expense", role: "admin", enabled: true, version: 7, permissions: ["report:view"], config: { viewScope: { ownership: "any", stores: "all", channels: "all" }, submitScope: { stores: [], channels: [] } } };
  assert.deepEqual(normalizeManagedAccess({ app: "expense", role: "admin" }, existing), { ...existing, enabled: false });
});
