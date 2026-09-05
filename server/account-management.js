import express from "express";
import crypto from "node:crypto";
import { parseCookies, secureEqual } from "./security.js";
import { AccountStoreError } from "./account-store.js";

const apps = {
  invoice: { label: "开票后台", permissions: { "submission:view": "查看", "attachment:view": "查看附件", "submission:delete": "删除" } },
  staff: { label: "员工信息后台", permissions: { "employee:view": "查看", "attachment:view": "查看附件", "employee:edit": "编辑", "employee:delete": "删除", "employee:restore": "恢复" } },
  expense: { label: "报账后台", permissions: { "report:view": "查看", "attachment:view": "查看附件", "report:submit": "提交", "report:edit": "编辑", "report:delete": "删除", "report:import": "补录", "task:view:any": "查看他人批量任务" } },
};
const stores = { fuzzy: "Fuzzy", fuzzy_qz: "Fuzzy泉州店", peanut: "Peanut" };
const channels = { reimbursement_fuzzy: "Fuzzy普通报账", reimbursement_peanut: "Peanut普通报账", reimbursement_fuzzyqz: "泉州普通报账", reimbursement_fuzzy_manager: "Fuzzy店长报账", reimbursement_peanut_manager: "Peanut店长报账", reimbursement_fuzzy_qz_manager: "泉州店长报账" };
const esc = (value) => String(value ?? "").replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]);
const hidden = (name, value) => `<input type="hidden" name="${name}" value="${esc(value)}">`;
const check = (name, value, label, enabled) => `<label class="check"><input type="checkbox" name="${name}" value="${esc(value)}" ${enabled ? "checked" : ""}>${esc(label)}</label>`;
function scopeFields(prefix, scope, expense, viewing) {
  const choices = Object.fromEntries(Object.entries(stores).map(([key, label]) => [expense && key === "fuzzy_qz" ? "fuzzyqz" : key, label]));
  return `<fieldset><legend>${viewing ? "查看范围（编辑和删除沿用此范围）" : "提交与补录范围"}</legend>
  ${viewing && expense ? `<label>记录归属<select name="ownership"><option value="any" ${scope?.ownership === "any" ? "selected" : ""}>所有人的记录</option><option value="self" ${scope?.ownership !== "any" ? "selected" : ""}>仅本人提交</option></select></label>` : ""}
  ${check(prefix + "All", "1", "全部门店", scope?.stores === "all")}
  <div class="checks">${Object.entries(choices).map(([key, label]) => check(prefix + "Stores", key, label, Array.isArray(scope?.stores) && scope.stores.includes(key))).join("")}</div>
  ${expense ? `${check(prefix + "ChannelsAll", "1", "全部渠道", scope?.channels === "all")}<div class="checks">${Object.entries(channels).map(([key, label]) => check(prefix + "Channels", key, label, Array.isArray(scope?.channels) && scope.channels.includes(key))).join("")}</div>` : ""}</fieldset>`;
}
function page({ accounts, selected, csrf, message, managementAccountIds, visibleApps = [] }) {
  const people = accounts.listAccounts();
  const account = selected ? accounts.getAccount(selected) : null;
  const accessForms = account ? Object.entries(apps).map(([app, catalog]) => {
    const access = accounts.getAccess(account.accountId, app);
    return `<form method="post" action="/auth/accounts/access" class="card"><h2>${catalog.label}</h2>
    ${hidden("csrf", csrf)}${hidden("accountId", account.accountId)}${hidden("app", app)}${hidden("version", access?.version ?? 0)}
    ${check("enabled", "1", "允许进入", access?.enabled)}
    <label>角色名称<select name="role">${(app === "expense" ? [["admin", "管理员"], ["partner", "合伙人"], ["manager", "店长"]] : [["admin", "管理员"], ["viewer", "查看人员"], ["operator", "操作人员"]]).map(([value, label]) => `<option value="${value}" ${(access?.role ?? (app === "expense" ? "manager" : "viewer")) === value ? "selected" : ""}>${label}</option>`).join("")}</select></label>
    <p class="muted">角色仅作标识，实际操作以勾选权限为准。</p><div class="checks">${Object.entries(catalog.permissions).map(([key, label]) => check("permissions", key, label, access?.permissions.includes(key))).join("")}</div>
    ${scopeFields("view", access?.config.viewScope, app === "expense", true)}
    ${app === "expense" ? scopeFields("submit", access?.config.submitScope, true, false) : ""}
    <button>保存${catalog.label}权限</button></form>`;
  }).join("") : "";
  const recent = accounts.listAudit().slice(-30).reverse();
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>账号管理</title><style>
  *{box-sizing:border-box}body{margin:0;background:#f3f5f8;color:#203047;font:15px/1.55 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}header{background:#fff;border-bottom:1px solid #dde3ec;padding:18px max(20px,calc((100vw - 1180px)/2));display:flex;align-items:center;gap:20px;flex-wrap:wrap}h1{font-size:24px;margin:0}h2{font-size:18px;margin:0 0 16px}main{max-width:1220px;margin:auto;padding:24px 20px}a{color:#225c9b}nav{display:flex;gap:16px;flex-wrap:wrap}.layout{display:grid;grid-template-columns:250px 1fr;gap:20px}.card{background:white;border:1px solid #dde3ec;border-radius:14px;padding:22px;margin-bottom:18px;min-width:0}.people{display:grid;gap:10px}.people a{padding:10px;border-radius:8px;background:#f4f7fb;overflow-wrap:anywhere}.people a[aria-current]{background:#e1ecfb;font-weight:650}label{display:block;margin:12px 0}input:not([type=checkbox]),select{display:block;width:100%;min-height:42px;border:1px solid #b9c4d4;border-radius:7px;padding:9px;font:inherit}button{border:0;background:#265f9e;color:#fff;border-radius:8px;padding:11px 18px;font:inherit;cursor:pointer}fieldset{border:1px solid #dce3ed;border-radius:8px;margin:18px 0;padding:12px}legend{font-weight:600}.checks{display:flex;gap:10px 20px;flex-wrap:wrap}.check{display:flex;align-items:center;gap:8px;margin:8px 0}input[type=checkbox]{width:18px;height:18px}.muted{color:#607086;font-size:13px}.notice{padding:14px 18px;background:#e6effb;border-radius:9px;margin-bottom:20px}.audit{overflow:auto}table{width:100%;border-collapse:collapse;text-align:left;font-size:13px}td,th{padding:9px;border-bottom:1px solid #edf0f5;overflow-wrap:anywhere}details summary{cursor:pointer;font-weight:600}@media(max-width:700px){.layout{grid-template-columns:1fr}main{padding:16px}.card{padding:17px}.people{grid-template-columns:repeat(2,minmax(0,1fr))}header{padding:16px}nav{font-size:14px}}
  </style></head><body><header><h1>账号管理</h1><nav>${visibleApps.map((app) => `<a href="/${app}">${apps[app].label}</a>`).join("")}</nav><form action="/logout" method="post">${hidden("returnTo", "/auth/accounts")}<button>退出登录</button></form></header><main>
  <p class="muted">统一维护登录账号，分别授予各后台权限。修改密码或账号状态后，原会话将失效。</p>
  ${message ? `<p role="status" class="notice">${esc(message)}</p>` : ""}<div class="layout"><aside><section class="card"><h2>账号列表</h2><div class="people">${people.map((person) => `<a href="/auth/accounts?account=${encodeURIComponent(person.accountId)}" ${person.accountId === selected ? 'aria-current="page"' : ""}>${esc(person.displayName)} · ${person.enabled ? "启用" : "停用"}</a>`).join("")}</div></section>
  <form method="post" action="/auth/accounts/create" class="card"><h2>新建账号</h2>${hidden("csrf", csrf)}<label>登录名<input name="username" required maxlength="200" autocomplete="off"></label><label>显示名称<input name="displayName" required maxlength="200"></label><label>初始密码<input type="password" name="password" required maxlength="4096" autocomplete="new-password"></label><p class="muted">创建后分别授予后台权限。</p><button>创建账号</button></form></aside><section>
  ${account ? `<form method="post" action="/auth/accounts/identity" class="card"><h2>${esc(account.displayName)}</h2>${hidden("csrf", csrf)}${hidden("accountId", account.accountId)}${hidden("version", account.version)}<p class="muted">${managementAccountIds.includes(account.accountId) ? "拥有账号管理权限（由服务器配置授予）" : "普通业务账号"}</p><label>登录名<input name="username" value="${esc(account.username)}" required maxlength="200"></label><label>显示名称<input name="displayName" value="${esc(account.displayName)}" required maxlength="200"></label><label>重设密码<input name="password" type="password" autocomplete="new-password" placeholder="留空则保持原密码" maxlength="4096"></label>${check("enabled", "1", "启用账号", account.enabled)}<button>保存账号</button></form>${accessForms}` : '<section class="card"><h2>选择一个账号</h2><p>从左侧选择账号，或创建账号后配置后台权限。</p></section>'}
  </section></div><details class="card"><summary>最近的账号变更记录</summary><div class="audit"><table><thead><tr><th>时间</th><th>操作人</th><th>动作</th><th>账号 / 后台</th></tr></thead><tbody>${recent.map((row) => `<tr><td>${esc(new Date(row.occurred_at).toLocaleString("zh-CN", { timeZone: "Asia/Shanghai" }))}</td><td>${esc(row.actor)}</td><td>${esc({ "account:create": "创建账号", "account:update": "修改账号", "access:put": "修改授权" }[row.action] ?? row.action)}</td><td>${esc(row.account_id)} ${esc(apps[row.app]?.label)}</td></tr>`).join("")}</tbody></table></div></details></main></body></html>`;
}
function values(body, key, allowed) {
  const raw = body[key] === undefined ? [] : Array.isArray(body[key]) ? body[key] : [body[key]];
  if (raw.some((value) => !allowed.includes(value))) throw new AccountStoreError("invalid-permissions");
  return [...new Set(raw)];
}
function scope(body, prefix, expense, viewing) {
  const result = { stores: body[prefix + "All"] === "1" ? "all" : values(body, prefix + "Stores", expense ? ["fuzzy", "fuzzyqz", "peanut"] : Object.keys(stores)) };
  if (viewing) {
    if (expense && !["self", "any"].includes(body.ownership)) throw new AccountStoreError("invalid-config");
    result.ownership = expense ? body.ownership : "any";
  }
  if (expense) result.channels = body[prefix + "ChannelsAll"] === "1" ? "all" : values(body, prefix + "Channels", Object.keys(channels));
  return result;
}
export function installAccountManagement({ app, config, accounts, sessions }) {
  const ids = config.managementAccountIds ?? [];
  const tokenFrom = (request) => parseCookies(request.headers.cookie).get(config.cookie.name);
  const csrfFor = (token) => crypto.createHmac("sha256", token).update("account-management-v1").digest("hex");
  const guard = (request, response, next) => {
    if (config.authMode !== "unified") return response.sendStatus(404);
    const token = tokenFrom(request);
    const identity = sessions.resolve(token, "accounts");
    if (!identity) {
      if (request.method === "GET" && !token) return response.redirect(303, "/login?returnTo=/auth/accounts");
      return response.status(403).type("text").send("无账号管理权限或登录已失效，请重新登录。");
    }
    response.locals.visibleApps = Object.keys(apps).filter((app) => sessions.resolve(token, app));
    response.locals.actor = identity.account.accountId;
    response.locals.csrf = csrfFor(token);
    next();
  };
  app.use("/auth/accounts", guard);
  app.get("/auth/accounts", (request, response) => response.type("html").send(page({ accounts, selected: typeof request.query.account === "string" ? request.query.account : "", csrf: response.locals.csrf, message: request.query.saved === "1" ? "已保存。相关旧会话将在下次访问时失效。" : "", managementAccountIds: ids, visibleApps: response.locals.visibleApps })));
  app.post("/auth/accounts/:action", express.urlencoded({ extended: false, limit: "32kb" }), (request, response) => {
    // Public mutations use actual request headers, never client X-Original-*.
    if (request.get("Origin") !== `${request.protocol}://${request.get("Host")}` || !secureEqual(request.body.csrf ?? "", response.locals.csrf)) return response.status(403).send("请求来源无效，请重新打开账号管理页面。");
    const body = request.body, actor = response.locals.actor;
    let id = body.accountId;
    try {
      if (request.params.action === "create") {
        id = crypto.randomUUID();
        accounts.createAccount({ accountId: id, username: body.username, displayName: body.displayName, password: body.password }, { actor });
      } else if (request.params.action === "identity") {
        if (id === actor && body.enabled !== "1") throw new AccountStoreError("cannot-disable-self");
        const changes = { username: body.username, displayName: body.displayName, enabled: body.enabled === "1" };
        if (body.password !== "") changes.password = body.password;
        accounts.updateAccount(id, changes, { actor, expectedVersion: Number(body.version) });
      } else if (request.params.action === "access") {
        const catalog = apps[body.app];
        if (!catalog || !(body.app === "expense" ? ["admin", "partner", "manager"] : ["admin", "viewer", "operator"]).includes(body.role)) throw new AccountStoreError("invalid-app");
        accounts.putAccess({ accountId: id, app: body.app, role: body.role, enabled: body.enabled === "1", permissions: values(body, "permissions", Object.keys(catalog.permissions)), config: {
          viewScope: scope(body, "view", body.app === "expense", true),
          ...(body.app === "expense" ? { submitScope: scope(body, "submit", true, false) } : {}),
        } }, { actor, expectedVersion: Number(body.version) });
      } else return response.sendStatus(404);
      if (request.params.action === "identity" && id === actor) return response.redirect(303, "/login?returnTo=/auth/accounts");
      response.redirect(303, `/auth/accounts?account=${encodeURIComponent(id)}&saved=1`);
    } catch (error) {
      const messages = { "version-conflict": "账号已被其他操作修改，请刷新后重试。", "account-conflict": "登录名已存在，请使用其他名称。", "cannot-disable-self": "不能停用当前管理账号。" };
      const code = error instanceof AccountStoreError ? error.code : "unknown";
      response.status(code === "version-conflict" || code === "account-conflict" ? 409 : 400).type("html").send(page({ accounts, selected: typeof id === "string" ? id : "", csrf: response.locals.csrf, message: messages[code] ?? "保存失败，请检查填写内容并重试。", managementAccountIds: ids, visibleApps: response.locals.visibleApps }));
    }
  });
}
