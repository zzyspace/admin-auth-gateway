import { AccountStoreError, validateImportRecord } from "./account-store.js";

// Migration-only snapshots of existing business behavior. Runtime authorization
// belongs to each application, not to the gateway's generic account store.
const MANAGER_CHANNELS = {
  fuzzy: "reimbursement_fuzzy_manager",
  peanut: "reimbursement_peanut_manager",
  fuzzyqz: "reimbursement_fuzzy_qz_manager",
};
const PARTNER_CHANNELS = ["reimbursement_fuzzy", "reimbursement_peanut", "reimbursement_fuzzyqz"];
const ALL_CHANNELS = [...PARTNER_CHANNELS, ...Object.values(MANAGER_CHANNELS)];

function invalid(code = "invalid-import-mapping") { throw new AccountStoreError(code); }
function expenseGrant(account) {
  const manager = account.role === "manager";
  const admin = account.role === "admin";
  if (!["admin", "partner", "manager"].includes(account.role)) invalid("invalid-legacy-role");
  const stores = manager ? [...(account.managerStores ?? [])] : "all";
  if (manager && (!Array.isArray(stores) || !stores.length || stores.some((store) => !Object.hasOwn(MANAGER_CHANNELS, store)))) {
    invalid("invalid-legacy-stores");
  }
  const channels = manager ? stores.map((store) => MANAGER_CHANNELS[store]) : admin ? ALL_CHANNELS : PARTNER_CHANNELS;
  return {
    app: "expense", role: account.role, enabled: true,
    permissions: ["report:view", "attachment:view", "report:submit",
      ...(admin ? ["report:edit", "report:delete", "report:import", "task:view:any"] : [])],
    config: {
      viewScope: { ownership: manager ? "self" : "any", stores, channels: manager ? channels : "all" },
      submitScope: { stores, channels },
    },
  };
}
function legacySources(config) {
  const sources = new Map();
  for (const account of config.credentials.invoice) {
    sources.set(`invoice:${account.accountId}`, { account, access: [
      { app: "invoice", role: "admin", enabled: true,
        permissions: ["submission:view", "attachment:view", "submission:delete"],
        config: { viewScope: { stores: "all", ownership: "any" } } },
      { app: "staff", role: "admin", enabled: true,
        permissions: ["employee:view", "attachment:view", "employee:edit", "employee:delete", "employee:restore"],
        config: { viewScope: { stores: "all", ownership: "any" } } },
    ] });
  }
  for (const account of config.credentials.reimbursement) {
    sources.set(`reimbursement:${account.accountId}`, { account, access: [expenseGrant(account)] });
  }
  return sources;
}

export function planLegacyAccountImport(config, mapping) {
  const sources = legacySources(config);
  if (mapping !== undefined && (!mapping || Object.keys(mapping).some((key) => key !== "accounts") || !Array.isArray(mapping.accounts))) {
    invalid();
  }
  const groups = mapping?.accounts ?? [...sources].map(([source, { account }]) => ({
    accountId: account.accountId,
    username: account.username,
    displayName: account.username,
    credentialSource: source,
    sources: [source],
  }));
  const consumed = new Set();
  const records = groups.map((group) => {
    if (!group || Object.keys(group).some((key) => !["accountId", "username", "displayName", "credentialSource", "sources"].includes(key)) ||
        !Array.isArray(group.sources) || !group.sources.length || typeof group.accountId !== "string" || !group.accountId.length) invalid();
    for (const source of group.sources) {
      if (!sources.has(source) || consumed.has(source)) invalid("duplicate-or-unknown-source");
      consumed.add(source);
    }
    const credentialSource = group.credentialSource ?? (group.sources.length === 1 ? group.sources[0] : undefined);
    if (!group.sources.includes(credentialSource)) invalid("credential-source-required");
    const expenseSources = group.sources.filter((source) => source.startsWith("reimbursement:"));
    if (expenseSources.length > 1) invalid("expense-accounts-cannot-merge");
    if (expenseSources.length && sources.get(expenseSources[0]).account.accountId !== group.accountId) {
      invalid("expense-account-id-must-be-preserved");
    }
    const credential = sources.get(credentialSource).account;
    const username = group.username ?? credential.username;
    const access = group.sources.flatMap((source) => sources.get(source).access);
    if (new Set(access.map((item) => item.app)).size !== access.length) invalid("duplicate-app-grant");
    return {
      account: {
        accountId: group.accountId, username, displayName: group.displayName ?? username,
        password: credential.password, enabled: true,
      },
      access,
      sources: group.sources,
      credentialSource,
    };
  });
  if (consumed.size !== sources.size) invalid("all-legacy-sources-required");
  records.forEach(validateImportRecord);
  const conflicts = [];
  for (const field of ["accountId", "username"]) {
    const values = new Set();
    for (const { account } of records) {
      if (values.has(account[field])) conflicts.push({ code: `duplicate-${field}`, value: account[field] });
      values.add(account[field]);
    }
  }
  // Only this redacted representation is printable. Passwords remain in the
  // apply closure, never in the JSON preview or mapping template.
  const preview = {
    ready: conflicts.length === 0,
    conflicts,
    accounts: records.map(({ account: { password: _password, ...account }, access, sources: names, credentialSource }) => ({
      ...account, sources: names, credentialSource, access,
    })),
    mapping: { accounts: records.map(({ account, sources: names, credentialSource }) => ({
      accountId: account.accountId, username: account.username, displayName: account.displayName,
      sources: names, credentialSource,
    })) },
  };
  return {
    preview: structuredClone(preview),
    apply(store) {
      if (conflicts.length) invalid("resolve-import-conflicts-first");
      return store.importAccounts(records, { actor: "legacy-import" });
    },
  };
}
