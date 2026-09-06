import crypto from "node:crypto";
import express from "express";

import { AccountStoreError } from "./account-store.js";
import {
  APP_DEFINITIONS,
  EXPENSE_CHANNELS,
  STORE_DEFINITIONS,
  accessDestination,
  effectiveExpenseChannels,
  normalizeManagedAccess,
} from "./account-policy.js";
import { parseCookies, secureEqual } from "./security.js";

const escapeHtml = (value) => String(value ?? "").replace(/[&<>"']/g, (character) => ({
  "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
})[character]);
const hidden = (name, value) => `<input type="hidden" name="${name}" value="${escapeHtml(value)}">`;
const checkbox = ({ name, value = "1", label, checked = false, attributes = "" }) =>
  `<label class="check"><input type="checkbox" name="${name}" value="${escapeHtml(value)}" ${checked ? "checked" : ""} ${attributes}>${escapeHtml(label)}</label>`;

function effectiveStores(scope) {
  return scope?.stores === "all" ? Object.keys(STORE_DEFINITIONS) : Array.isArray(scope?.stores) ? scope.stores : [];
}

function storeSelector(access) {
  const selected = effectiveStores(access?.config?.viewScope);
  return `<fieldset data-scope="view"><legend>可管理门店</legend>
    ${checkbox({ name: "viewStoresMaster", label: "全部门店", checked: selected.length === Object.keys(STORE_DEFINITIONS).length, attributes: 'data-master="viewStores"' })}
    <div class="checks">${Object.entries(STORE_DEFINITIONS).map(([key, label]) => checkbox({
      name: "viewStores", value: key, label, checked: selected.includes(key), attributes: 'data-member="viewStores"',
    })).join("")}</div>
  </fieldset>`;
}

function channelMatrix(name, title, description, selectedChannels) {
  return `<fieldset data-scope="${name}"><legend>${escapeHtml(title)}</legend>
    <p class="muted">${escapeHtml(description)}</p>
    ${checkbox({ name: `${name}Master`, label: "全部门店与全部渠道", checked: selectedChannels.length === Object.keys(EXPENSE_CHANNELS).length, attributes: `data-master="${name}"` })}
    <div class="matrix" role="group" aria-label="${escapeHtml(title)}">
      <div class="matrix-head">门店</div><div class="matrix-head">普通报账</div><div class="matrix-head">店长报账</div>
      ${Object.entries(STORE_DEFINITIONS).map(([store, storeLabel]) => {
        const channels = Object.entries(EXPENSE_CHANNELS).filter(([, definition]) => definition.store === store);
        return `<strong>${escapeHtml(storeLabel)}</strong>${channels.map(([channel, definition]) => checkbox({
          name: `${name}Channels`, value: channel, label: definition.label,
          checked: selectedChannels.includes(channel), attributes: `data-member="${name}"`,
        })).join("")}`;
      }).join("")}
    </div>
  </fieldset>`;
}

function templateOptions(app) {
  const options = app === "expense"
    ? [["", "自定义"], ["expense-readonly", "只读"], ["expense-partner", "合伙人"], ["expense-manager", "店长"], ["expense-admin", "完整管理员"]]
    : [["", "自定义"], [`${app}-readonly`, "只读"], [`${app}-operator`, "操作人员"], [`${app}-admin`, "完整管理员"]];
  return `<label>快速套用权限模板<select name="template">${options.map(([value, label]) => `<option value="${value}">${label}</option>`).join("")}</select></label>`;
}

function accessForm(account, app, access) {
  const definition = APP_DEFINITIONS[app];
  const permissions = access?.permissions ?? [];
  const viewChannels = effectiveExpenseChannels(access?.config?.viewScope);
  const submitChannels = effectiveExpenseChannels(access?.config?.submitScope);
  const importChannels = effectiveExpenseChannels(access?.config?.importScope ?? access?.config?.submitScope);
  return `<form method="post" action="/auth/accounts/access" class="card access-form" data-app="${app}">
    <div class="card-title"><div><h2>${definition.label}</h2><p class="muted app-state" aria-live="polite"></p></div>
      ${checkbox({ name: "enabled", label: "启用此后台访问", checked: access?.enabled, attributes: 'data-app-enabled="true"' })}</div>
    ${hidden("csrf", account.csrf)}${hidden("accountId", account.accountId)}${hidden("app", app)}${hidden("version", access?.version ?? 0)}
    <div data-app-settings>
      <label>角色标签（不自动授予权限）<select name="role">${Object.entries(definition.roles).map(([value, label]) =>
        `<option value="${value}" ${(access?.role ?? Object.keys(definition.roles)[1]) === value ? "selected" : ""}>${label}</option>`).join("")}</select></label>
      <p class="muted">角色只用于识别身份和记录来源，最终能力以下方具体权限为准。</p>
      ${templateOptions(app)}
      <fieldset><legend>操作权限</legend><div class="checks">${Object.entries(definition.permissions).map(([permission, label]) => checkbox({
        name: "permissions", value: permission, label, checked: permissions.includes(permission), attributes: `data-permission="${permission}"`,
      })).join("")}</div></fieldset>
      ${app === "expense" ? `
        <label>查看记录归属<select name="ownership"><option value="any" ${access?.config?.viewScope?.ownership === "any" ? "selected" : ""}>所有人的记录</option><option value="self" ${access?.config?.viewScope?.ownership !== "any" ? "selected" : ""}>仅本人提交</option></select></label>
        ${channelMatrix("view", "查看、附件、编辑和删除范围", "只有勾选相应操作权限后，这个范围才生效。", viewChannels)}
        ${channelMatrix("submit", "提交范围", "仅用于“提交”权限。", submitChannels)}
        ${channelMatrix("import", "补录范围", "仅用于“补录”权限，包括手工和批量补录。", importChannels)}
      ` : storeSelector(access)}
      <section class="effective-preview" data-preview aria-live="polite"><strong>最终生效权限</strong><div></div></section>
    </div>
    <button type="submit">保存${definition.label}权限</button>
  </form>`;
}

function auditDetails(row) {
  const details = row.details ?? {};
  if (row.action === "account:create") return `创建登录名 ${details.username ?? "-"}，状态：${details.enabled ? "启用" : "停用"}`;
  if (row.action === "account:update") {
    const changes = [];
    for (const field of ["username", "displayName", "enabled"]) {
      if (details.before?.[field] !== details.after?.[field]) changes.push(`${field}: ${String(details.before?.[field])} → ${String(details.after?.[field])}`);
    }
    if (details.passwordChanged) changes.push("已重设密码（密码内容不记录）");
    return changes.join("；") || "没有可显示的字段变化";
  }
  if (row.action === "access:put") {
    const before = details.before;
    const after = details.after;
    if (!before) return `新增授权：${after?.enabled ? "启用" : "停用"}；权限 ${after?.permissions?.join("、") || "无"}`;
    const added = (after?.permissions ?? []).filter((permission) => !before.permissions.includes(permission));
    const removed = before.permissions.filter((permission) => !(after?.permissions ?? []).includes(permission));
    return [`状态 ${before.enabled ? "启用" : "停用"} → ${after?.enabled ? "启用" : "停用"}`, added.length ? `新增 ${added.join("、")}` : "", removed.length ? `取消 ${removed.join("、")}` : "", JSON.stringify(before.config) !== JSON.stringify(after?.config) ? "数据范围已变化" : ""].filter(Boolean).join("；");
  }
  return "";
}

function managementPage({ accounts, selected, csrf, message, managementAccountIds, destinations }) {
  const people = accounts.listAccounts();
  const account = selected ? accounts.getAccount(selected) : null;
  const accessForms = account ? Object.keys(APP_DEFINITIONS).map((app) => accessForm({ ...account, csrf }, app, accounts.getAccess(account.accountId, app))).join("") : "";
  const recent = accounts.listAudit().slice(-30).reverse();
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>账号管理</title><style>
  *{box-sizing:border-box}body{margin:0;background:#f3f5f8;color:#203047;font:15px/1.55 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}header{background:#fff;border-bottom:1px solid #dde3ec;padding:18px max(20px,calc((100vw - 1180px)/2));display:flex;align-items:center;gap:20px;flex-wrap:wrap}h1{font-size:24px;margin:0}h2{font-size:18px;margin:0}main{max-width:1220px;margin:auto;padding:24px 20px}a{color:#225c9b}nav{display:flex;gap:16px;flex-wrap:wrap}.layout{display:grid;grid-template-columns:270px 1fr;gap:20px}.card{background:white;border:1px solid #dde3ec;border-radius:14px;padding:22px;margin-bottom:18px;min-width:0}.card-title{display:flex;justify-content:space-between;gap:16px;align-items:flex-start}.people{display:grid;gap:10px}.people a{padding:10px;border-radius:8px;background:#f4f7fb;overflow-wrap:anywhere}.people small{display:block;color:#607086}.people a[aria-current]{background:#e1ecfb;font-weight:650}label{display:block;margin:12px 0}input:not([type=checkbox]),select{display:block;width:100%;min-height:42px;border:1px solid #b9c4d4;border-radius:7px;padding:9px;font:inherit}button{border:0;background:#265f9e;color:#fff;border-radius:8px;padding:11px 18px;font:inherit;cursor:pointer}fieldset{border:1px solid #dce3ed;border-radius:8px;margin:18px 0;padding:12px;min-width:0}legend{font-weight:600}.checks{display:flex;gap:10px 20px;flex-wrap:wrap}.check{display:flex;align-items:center;gap:8px;margin:8px 0;min-width:0;overflow-wrap:anywhere}.check input{width:18px;height:18px;flex:0 0 auto}.muted{color:#607086;font-size:13px}.notice{padding:14px 18px;background:#e6effb;border-radius:9px;margin-bottom:20px}.effective-preview{padding:14px;border-radius:9px;background:#edf5ff;margin:16px 0}.effective-preview.invalid{background:#fff0eb;color:#8f2e13}.matrix{display:grid;grid-template-columns:minmax(130px,1fr) repeat(2,minmax(150px,1fr));align-items:center;gap:4px 12px;min-width:0}.matrix-head{font-weight:650;color:#607086;border-bottom:1px solid #dde3ec;padding:6px}.audit{overflow:auto}table{width:100%;border-collapse:collapse;text-align:left;font-size:13px}td,th{padding:9px;border-bottom:1px solid #edf0f5;vertical-align:top}code{overflow-wrap:anywhere}.disabled-settings{opacity:.5}details summary{cursor:pointer;font-weight:600}@media(max-width:700px){.layout{grid-template-columns:1fr}main{padding:16px}.card{padding:17px}.people{grid-template-columns:1fr}header{padding:16px}nav{font-size:14px}.matrix{grid-template-columns:minmax(68px,.7fr) repeat(2,minmax(0,1fr));gap:2px 5px;font-size:12px}.matrix-head{padding:4px}.card-title{display:block}}
  </style></head><body><header><h1>账号管理</h1><nav>${Object.entries(destinations).map(([app, destination]) => `<a href="${destination}">${APP_DEFINITIONS[app].label}</a>`).join("")}</nav><form action="/logout" method="post">${hidden("returnTo", "/auth/accounts")}<button>退出登录</button></form></header><main>
  <p class="muted">统一维护登录身份和各后台权限。界面下方会实时显示最终生效结果。</p>${message ? `<p role="status" class="notice">${escapeHtml(message)}</p>` : ""}
  <div class="layout"><aside><section class="card"><h2>账号列表</h2><div class="people">${people.map((person) => `<a href="/auth/accounts?account=${encodeURIComponent(person.accountId)}" ${person.accountId === selected ? 'aria-current="page"' : ""}>${escapeHtml(person.displayName)}<small>登录名：${escapeHtml(person.username)} · ${person.enabled ? "启用" : "停用"}</small></a>`).join("")}</div></section>
  <form method="post" action="/auth/accounts/create" class="card identity-form"><h2>新建账号</h2>${hidden("csrf", csrf)}<label>登录名<input name="username" required maxlength="200" autocomplete="off"></label><label>显示名称<input name="displayName" required maxlength="200"></label><label>初始密码<input type="password" name="password" required maxlength="4096" autocomplete="new-password"></label><p class="muted">登录名和密码开头、结尾不能含空格。创建后默认不能进入任何后台。</p><button>创建账号</button></form></aside><section>
  ${account ? `<form method="post" action="/auth/accounts/identity" class="card identity-form"><h2>${escapeHtml(account.displayName)}</h2>${hidden("csrf", csrf)}${hidden("accountId", account.accountId)}${hidden("version", account.version)}<p>不可修改的账号 ID：<code>${escapeHtml(account.accountId)}</code></p><p class="muted">${managementAccountIds.includes(account.accountId) ? "拥有账号管理权限（由服务器配置授予）" : "没有账号管理权限"}</p><label>登录名<input name="username" value="${escapeHtml(account.username)}" required maxlength="200"></label><label>显示名称<input name="displayName" value="${escapeHtml(account.displayName)}" required maxlength="200"></label><label>重设密码<input name="password" type="password" autocomplete="new-password" placeholder="留空则保持原密码" maxlength="4096"></label><p class="muted">重设密码会使该账号在所有后台的现有会话失效。</p>${checkbox({ name: "enabled", label: "启用账号", checked: account.enabled })}<p class="muted">停用账号会立即阻止其访问全部后台，但保留已有授权配置。</p>${hidden("confirmPassword", "0")}${hidden("confirmDisable", "0")}<button>保存账号</button></form>${accessForms}` : '<section class="card"><h2>选择一个账号</h2><p>从左侧选择账号，或创建账号后配置后台权限。</p></section>'}
  </section></div><details class="card"><summary>最近的账号变更记录</summary><div class="audit"><table><thead><tr><th>时间</th><th>操作人</th><th>动作</th><th>账号 / 后台</th><th>变化</th></tr></thead><tbody>${recent.map((row) => `<tr><td>${escapeHtml(new Date(row.occurred_at).toLocaleString("zh-CN", { timeZone: "Asia/Shanghai" }))}</td><td><code>${escapeHtml(row.actor)}</code></td><td>${escapeHtml({ "account:create": "创建账号", "account:update": "修改账号", "access:put": "修改授权" }[row.action] ?? row.action)}</td><td><code>${escapeHtml(row.account_id)}</code> ${escapeHtml(APP_DEFINITIONS[row.app]?.label)}</td><td>${escapeHtml(auditDetails(row))}</td></tr>`).join("")}</tbody></table></div></details></main>
  <script src="/auth/accounts/ui.js"></script></body></html>`;
}

function managementScript() {
  const policyJson = JSON.stringify({ apps: APP_DEFINITIONS, stores: STORE_DEFINITIONS, channels: EXPENSE_CHANNELS }).replaceAll("<", "\\u003c");
  return `(() => {
    const policy=${policyJson};const labels=Object.fromEntries(Object.entries(policy.channels).map(([key,item])=>[key,policy.stores[item.store]+item.label]));
    const selected=(form,name)=>[...form.querySelectorAll('[name="'+name+'"]:checked')].map(input=>input.value);
    const setMaster=(form,group)=>{const master=form.querySelector('[data-master="'+group+'"]'),members=[...form.querySelectorAll('[data-member="'+group+'"]')];if(!master)return;const count=members.filter(item=>item.checked).length;master.checked=count===members.length;master.indeterminate=count>0&&count<members.length;};
    const update=form=>{const app=form.dataset.app,enabled=form.querySelector('[data-app-enabled]').checked,settings=form.querySelector('[data-app-settings]');settings.classList.toggle('disabled-settings',!enabled);for(const control of settings.querySelectorAll('input,select'))control.disabled=!enabled;form.querySelector('.app-state').textContent=enabled?'当前启用；保存后按下方结果生效。':'当前停用；已有配置保留，但不会生效。';const permissions=selected(form,'permissions'),preview=form.querySelector('[data-preview]'),lines=[],errors=[];if(!enabled){preview.classList.remove('invalid');preview.querySelector('div').textContent='此后台当前不能访问。';return;}const definition=policy.apps[app];if(!definition.entry.some(permission=>permissions.includes(permission)))errors.push('缺少可进入后台的基础权限');if(app==='expense'){for(const [name,permission,title] of [['view','report:view','查看'],['submit','report:submit','提交'],['import','report:import','补录']]){const channels=selected(form,name+'Channels');if(permissions.includes(permission)){if(channels.length)lines.push(title+'：'+channels.map(channel=>labels[channel]).join('、'));else errors.push(title+'范围为空');}}if(permissions.includes('task:view:any'))lines.push('他人批量任务：仅限查看权限和查看范围内');}else{const stores=selected(form,'viewStores');if(stores.length)lines.push('门店：'+stores.map(store=>policy.stores[store]).join('、'));else errors.push('门店范围为空');}lines.unshift('操作：'+(permissions.map(permission=>definition.permissions[permission]).join('、')||'无'));preview.classList.toggle('invalid',errors.length>0);preview.querySelector('div').innerHTML=[...lines,...errors.map(error=>'⚠ '+error)].map(line=>'<div>'+line+'</div>').join('');};
    const templates={'invoice-readonly':{role:'viewer',permissions:['submission:view','attachment:view'],stores:'all'},'invoice-operator':{role:'operator',permissions:['submission:view','attachment:view','submission:delete'],stores:'all'},'invoice-admin':{role:'admin',permissions:['submission:view','attachment:view','submission:delete'],stores:'all'},'staff-readonly':{role:'viewer',permissions:['employee:view','attachment:view'],stores:'all'},'staff-operator':{role:'operator',permissions:['employee:view','attachment:view','employee:edit'],stores:'all'},'staff-admin':{role:'admin',permissions:['employee:view','attachment:view','employee:edit','employee:delete','employee:restore'],stores:'all'},'expense-readonly':{role:'partner',permissions:['report:view','attachment:view'],ownership:'any',view:'all'},'expense-partner':{role:'partner',permissions:['report:view','attachment:view','report:submit'],ownership:'any',view:'all',submit:'ordinary'},'expense-manager':{role:'manager',permissions:['report:view','attachment:view','report:submit'],ownership:'self',view:'none',submit:'none'},'expense-admin':{role:'admin',permissions:['report:view','attachment:view','report:submit','report:edit','report:delete','report:import','task:view:any'],ownership:'any',view:'all',submit:'all',import:'all'}};
    const applyTemplate=(form,name)=>{const item=templates[name];if(!item)return;for(const input of form.querySelectorAll('[name="permissions"]'))input.checked=item.permissions.includes(input.value);if(item.role)form.elements.role.value=item.role;if(item.ownership)form.elements.ownership.value=item.ownership;if(item.stores==='all')for(const input of form.querySelectorAll('[name="viewStores"]'))input.checked=true;for(const scope of ['view','submit','import'])if(item[scope])for(const input of form.querySelectorAll('[name="'+scope+'Channels"]'))input.checked=item[scope]==='all'||item[scope]==='ordinary'&&!input.value.includes('manager')||item[scope]==='manager'&&input.value.includes('manager');for(const master of form.querySelectorAll('[data-master]'))setMaster(form,master.dataset.master);update(form);};
    for(const form of document.querySelectorAll('.access-form')){for(const master of form.querySelectorAll('[data-master]'))master.addEventListener('change',()=>{for(const item of form.querySelectorAll('[data-member="'+master.dataset.master+'"]'))item.checked=master.checked;update(form);});for(const member of form.querySelectorAll('[data-member]'))member.addEventListener('change',()=>{setMaster(form,member.dataset.member);update(form);});for(const input of form.querySelectorAll('[data-permission]'))input.addEventListener('change',()=>{const deps=policy.apps[form.dataset.app].dependencies;if(input.checked&&deps[input.value])form.querySelector('[data-permission="'+deps[input.value]+'"]').checked=true;if(!input.checked)for(const [permission,dependency] of Object.entries(deps))if(dependency===input.value)form.querySelector('[data-permission="'+permission+'"]').checked=false;update(form);});form.elements.template.addEventListener('change',()=>applyTemplate(form,form.elements.template.value));form.querySelector('[data-app-enabled]').addEventListener('change',()=>update(form));form.addEventListener('submit',event=>{update(form);if(form.querySelector('[data-preview]').classList.contains('invalid')){event.preventDefault();alert('请先处理“最终生效权限”中的提示。');}});for(const master of form.querySelectorAll('[data-master]'))setMaster(form,master.dataset.master);update(form);}
    for(const form of document.querySelectorAll('.identity-form'))form.addEventListener('submit',event=>{const username=form.elements.username.value,password=form.elements.password.value;if(username!==username.trim()||(password&&password!==password.trim())){event.preventDefault();alert('登录名和密码开头、结尾不能含空格。');return;}if(form.action.endsWith('/identity')){if(password){if(!confirm('确认重设密码？该账号在所有后台的现有会话都会失效。')){event.preventDefault();return;}form.elements.confirmPassword.value='1';}if(!form.elements.enabled.checked){if(!confirm('确认停用此账号？该账号将立即无法访问全部后台。')){event.preventDefault();return;}form.elements.confirmDisable.value='1';}}});
  })();`;
}

function validateManagedIdentity(body, creating = false) {
  for (const name of ["username", "displayName"]) if (typeof body[name] !== "string" || !body[name] || body[name] !== body[name].trim()) throw new AccountStoreError("invalid-managed-identity");
  if ((creating || body.password) && (typeof body.password !== "string" || !body.password || body.password !== body.password.trim())) throw new AccountStoreError("invalid-managed-password");
}

export function installAccountManagement({ app, config, accounts, sessions }) {
  const managementAccountIds = config.managementAccountIds ?? [];
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
    response.locals.actor = identity.account.accountId;
    response.locals.csrf = csrfFor(token);
    response.locals.destinations = Object.fromEntries(Object.keys(APP_DEFINITIONS).flatMap((appName) => {
      const authorization = sessions.resolve(token, appName);
      const destination = authorization ? accessDestination(appName, authorization.access) : null;
      return destination ? [[appName, destination]] : [];
    }));
    next();
  };
  app.use("/auth/accounts", guard);
  app.get("/auth/accounts/ui.js", (_request, response) => response.type("application/javascript").send(managementScript()));
  const renderPage = (response, selected, message = "") => {
    response.set("Content-Security-Policy", "default-src 'none'; style-src 'unsafe-inline'; script-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'");
    response.type("html").send(managementPage({ accounts, selected, csrf: response.locals.csrf, message, managementAccountIds, destinations: response.locals.destinations }));
  };
  app.get("/auth/accounts", (request, response) => renderPage(
    response,
    typeof request.query.account === "string" ? request.query.account : "",
    request.query.saved === "1" ? "已保存。相关旧会话将在下次访问时失效。" : "",
  ));
  app.post("/auth/accounts/:action", express.urlencoded({ extended: false, limit: "32kb" }), (request, response) => {
    if (request.get("Origin") !== `${request.protocol}://${request.get("Host")}` || !secureEqual(request.body.csrf ?? "", response.locals.csrf)) return response.status(403).send("请求来源无效，请重新打开账号管理页面。");
    const body = request.body;
    const actor = response.locals.actor;
    let accountId = body.accountId;
    try {
      if (request.params.action === "create") {
        validateManagedIdentity(body, true);
        accountId = crypto.randomUUID();
        accounts.createAccount({ accountId, username: body.username, displayName: body.displayName, password: body.password }, { actor });
      } else if (request.params.action === "identity") {
        validateManagedIdentity(body);
        if (accountId === actor && body.enabled !== "1") throw new AccountStoreError("cannot-disable-self");
        if (body.enabled !== "1" && body.confirmDisable !== "1") throw new AccountStoreError("disable-confirmation-required");
        if (body.password && body.confirmPassword !== "1") throw new AccountStoreError("password-confirmation-required");
        const changes = { username: body.username, displayName: body.displayName, enabled: body.enabled === "1" };
        if (body.password) changes.password = body.password;
        accounts.updateAccount(accountId, changes, { actor, expectedVersion: Number(body.version) });
      } else if (request.params.action === "access") {
        const existing = accounts.getAccess(accountId, body.app);
        accounts.putAccess(normalizeManagedAccess(body, existing), { actor, expectedVersion: Number(body.version) });
      } else return response.sendStatus(404);
      if (request.params.action === "identity" && accountId === actor) return response.redirect(303, "/login?returnTo=/auth/accounts");
      response.redirect(303, `/auth/accounts?account=${encodeURIComponent(accountId)}&saved=1`);
    } catch (error) {
      const messages = { "version-conflict": "账号已被其他操作修改，请刷新后重试。", "account-conflict": "登录名已存在，请使用其他名称。", "cannot-disable-self": "不能停用当前管理账号。", "disable-confirmation-required": "停用账号需要再次确认。", "password-confirmation-required": "重设密码需要再次确认。", "invalid-managed-identity": "登录名和显示名称不能为空，开头和结尾不能含空格。", "invalid-managed-password": "密码不能为空，开头和结尾不能含空格。" };
      const status = error.code === "version-conflict" || error.code === "account-conflict" ? 409 : 400;
      response.status(status);
      renderPage(response, typeof accountId === "string" ? accountId : "", error.userMessage ?? messages[error instanceof AccountStoreError ? error.code : ""] ?? "保存失败，请检查填写内容并重试。");
    }
  });
}
