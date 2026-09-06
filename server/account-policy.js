import { AccountStoreError } from "./account-store.js";

export const STORE_DEFINITIONS = Object.freeze({
  fuzzy: "Fuzzy",
  fuzzy_qz: "Fuzzy泉州店",
  peanut: "Peanut",
});

export const EXPENSE_CHANNELS = Object.freeze({
  reimbursement_fuzzy: { label: "普通报账", store: "fuzzy" },
  reimbursement_fuzzy_manager: { label: "店长报账", store: "fuzzy" },
  reimbursement_peanut: { label: "普通报账", store: "peanut" },
  reimbursement_peanut_manager: { label: "店长报账", store: "peanut" },
  reimbursement_fuzzyqz: { label: "普通报账", store: "fuzzy_qz" },
  reimbursement_fuzzy_qz_manager: { label: "店长报账", store: "fuzzy_qz" },
});

export const APP_DEFINITIONS = Object.freeze({
  invoice: {
    label: "开票后台",
    roles: { admin: "管理员", viewer: "查看人员", operator: "操作人员" },
    permissions: { "submission:view": "查看", "attachment:view": "查看附件", "submission:delete": "删除" },
    dependencies: { "attachment:view": "submission:view", "submission:delete": "submission:view" },
    entry: ["submission:view"],
  },
  staff: {
    label: "员工信息后台",
    roles: { admin: "管理员", viewer: "查看人员", operator: "操作人员" },
    permissions: { "employee:view": "查看", "attachment:view": "查看附件", "employee:edit": "编辑", "employee:delete": "删除", "employee:restore": "恢复" },
    dependencies: { "attachment:view": "employee:view", "employee:edit": "employee:view", "employee:delete": "employee:view", "employee:restore": "employee:view" },
    entry: ["employee:view"],
  },
  expense: {
    label: "报账后台",
    roles: { admin: "管理员", partner: "合伙人", manager: "店长" },
    permissions: { "report:view": "查看", "attachment:view": "查看附件", "report:submit": "提交", "report:edit": "编辑", "report:delete": "删除", "report:import": "补录", "task:view:any": "查看他人批量任务" },
    dependencies: { "attachment:view": "report:view", "report:edit": "report:view", "report:delete": "report:view", "report:import": "report:view", "task:view:any": "report:view" },
    entry: ["report:view", "report:submit"],
  },
});

export class AccountPolicyError extends AccountStoreError {
  constructor(code, message) {
    super(code);
    this.userMessage = message;
  }
}

function fail(code, message) {
  throw new AccountPolicyError(code, message);
}

function selections(body, name, allowed) {
  const raw = body[name] === undefined ? [] : Array.isArray(body[name]) ? body[name] : [body[name]];
  if (raw.some((value) => typeof value !== "string" || !allowed.includes(value))) {
    fail("invalid-selection", "权限范围包含无法识别的选项，请刷新页面后重试。");
  }
  return [...new Set(raw)];
}

function normalizedStores(values) {
  const all = Object.keys(STORE_DEFINITIONS);
  const selected = [...new Set(values)].sort();
  return selected.length === all.length ? "all" : selected;
}

function normalizedExpenseScope(channelCodes, ownership) {
  const allChannels = Object.keys(EXPENSE_CHANNELS);
  const channels = [...new Set(channelCodes)].sort();
  const selectedStores = [...new Set(channels.map((channel) =>
    EXPENSE_CHANNELS[channel].store === "fuzzy_qz" ? "fuzzyqz" : EXPENSE_CHANNELS[channel].store,
  ))];
  return {
    ...(ownership ? { ownership } : {}),
    stores: channels.length === allChannels.length ? "all" : selectedStores.sort(),
    channels: channels.length === allChannels.length ? "all" : channels,
  };
}

export function effectiveExpenseChannels(scope) {
  if (!scope || typeof scope !== "object") return [];
  return Object.entries(EXPENSE_CHANNELS).filter(([channel, definition]) =>
    (scope.channels === "all" || Array.isArray(scope.channels) && scope.channels.includes(channel)) &&
    (scope.stores === "all" || Array.isArray(scope.stores) && scope.stores.includes(definition.store === "fuzzy_qz" ? "fuzzyqz" : definition.store)),
  ).map(([channel]) => channel);
}

export function accessDestination(app, access) {
  if (!access?.enabled) return null;
  if (app === "invoice" && access.permissions.includes("submission:view")) return "/invoice";
  if (app === "staff" && access.permissions.includes("employee:view")) return "/staff";
  if (app === "expense") {
    if (access.permissions.includes("report:view")) return "/expense";
    if (access.permissions.includes("report:submit")) return "/expense/submit";
  }
  return null;
}

export function normalizeManagedAccess(body, existing) {
  const definition = APP_DEFINITIONS[body.app];
  if (!definition || !Object.hasOwn(definition.roles, body.role)) {
    fail("invalid-app-role", "后台或角色标签无法识别，请刷新页面后重试。");
  }
  const enabled = body.enabled === "1";
  if (!enabled) {
    if (existing) return { ...existing, enabled: false };
    return {
      accountId: body.accountId,
      app: body.app,
      role: body.role,
      enabled: false,
      permissions: [],
      config: body.app === "expense"
        ? {
            viewScope: { ownership: "self", stores: [], channels: [] },
            submitScope: { stores: [], channels: [] },
            importScope: { stores: [], channels: [] },
          }
        : { viewScope: { ownership: "any", stores: [] } },
    };
  }

  const permissions = selections(body, "permissions", Object.keys(definition.permissions)).sort();
  for (const [permission, dependency] of Object.entries(definition.dependencies)) {
    if (permissions.includes(permission) && !permissions.includes(dependency)) {
      fail("missing-permission-dependency", `${definition.permissions[permission]}必须同时启用${definition.permissions[dependency]}。`);
    }
  }
  if (enabled && !definition.entry.some((permission) => permissions.includes(permission))) {
    fail("missing-entry-permission", `启用${definition.label}前，请至少选择可进入该后台的基础权限。`);
  }

  let config;
  if (body.app === "expense") {
    const channelNames = Object.keys(EXPENSE_CHANNELS);
    const ownership = body.ownership;
    if (!['self', 'any'].includes(ownership)) fail("invalid-ownership", "请选择查看本人记录或所有人的记录。");
    const viewChannels = selections(body, "viewChannels", channelNames);
    const submitChannels = selections(body, "submitChannels", channelNames);
    const importChannels = selections(body, "importChannels", channelNames);
    if (permissions.includes("report:view") && viewChannels.length === 0) fail("empty-view-scope", "已启用查看权限，请至少选择一个可查看渠道。");
    if (permissions.includes("report:submit") && submitChannels.length === 0) fail("empty-submit-scope", "已启用提交权限，请至少选择一个可提交渠道。");
    if (permissions.includes("report:import") && importChannels.length === 0) fail("empty-import-scope", "已启用补录权限，请至少选择一个可补录渠道。");
    config = {
      viewScope: normalizedExpenseScope(viewChannels, ownership),
      submitScope: normalizedExpenseScope(submitChannels),
      importScope: normalizedExpenseScope(importChannels),
    };
  } else {
    const stores = selections(body, "viewStores", Object.keys(STORE_DEFINITIONS));
    if (enabled && stores.length === 0) fail("empty-view-scope", "已启用后台访问，请至少选择一个可管理门店。");
    config = { viewScope: { ownership: "any", stores: normalizedStores(stores) } };
  }
  return { accountId: body.accountId, app: body.app, role: body.role, enabled, permissions, config };
}
