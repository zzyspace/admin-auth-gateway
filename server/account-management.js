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
    <div class="card-title permission-heading"><button class="section-toggle" type="button" aria-expanded="true"><span class="app-mark" aria-hidden="true">${app === "invoice" ? "票" : app === "staff" ? "员" : "账"}</span><span><strong>${definition.label}</strong><small class="app-state" aria-live="polite"></small></span><span class="section-chevron" aria-hidden="true">⌄</span></button>
      ${checkbox({ name: "enabled", label: "启用访问", checked: access?.enabled, attributes: 'data-app-enabled="true"' })}</div>
    ${hidden("csrf", account.csrf)}${hidden("accountId", account.accountId)}${hidden("app", app)}${hidden("version", access?.version ?? 0)}
    <div class="access-body">
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
    <button class="button-primary" type="submit">保存${definition.label}权限</button>
    </div>
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
  const centerIcons = {
    invoice: '<svg viewBox="0 0 32 32" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><rect x="7" y="3.5" width="18" height="25" rx="3"/><path d="M11 9h10M11 14h8M11 19h5"/><circle cx="23" cy="23.5" r="4"/><path d="m21.3 23.5 1.2 1.2 2.2-2.5"/></svg>',
    staff: '<svg viewBox="0 0 32 32" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><circle cx="16" cy="10" r="5"/><path d="M6.5 27c.8-6.2 4-9.2 9.5-9.2s8.7 3 9.5 9.2"/></svg>',
    expense: '<svg viewBox="0 0 32 32" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><rect x="5" y="7" width="22" height="19" rx="4"/><path d="M8 7V5.5A2.5 2.5 0 0 1 10.5 3H22M10 13h8m-6 4 2.2 2.2 3.5-3.7"/></svg>',
    accounts: '<svg viewBox="0 0 32 32" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="9.5" r="4.25"/><path d="M4.5 25.5c.65-5.8 3.15-8.5 7.5-8.5 3.25 0 5.45 1.5 6.65 4.55"/><circle cx="23.25" cy="22.75" r="3.25"/><path d="M23.25 17.5v1.15M23.25 26.85V28M18 22.75h1.15M27.35 22.75h1.15"/></svg>',
  };
  const centerLabels = { invoice: "发票中心", staff: "员工中心", expense: "报账中心" };
  const centerOptions = Object.entries(destinations).map(([app, destination]) => `<a class="center-switcher-option" data-center="${app}" role="menuitem" href="${escapeHtml(destination)}">${centerIcons[app]}<span>${centerLabels[app]}</span><span></span></a>`).join("");
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"><meta name="color-scheme" content="light dark"><title>账号管理</title>
  <script>(()=>{let theme=null;try{theme=localStorage.getItem('account-management-theme')}catch{}theme=theme==='light'||theme==='dark'?theme:(matchMedia('(prefers-color-scheme: dark)').matches?'dark':'light');document.documentElement.dataset.theme=theme;document.documentElement.style.colorScheme=theme})()</script><style>
  :root{--bg:#f2f2f7;--bg-accent:#e9edf7;--surface:rgba(255,255,255,.84);--surface-strong:#fff;--surface-muted:rgba(255,255,255,.72);--surface-input:rgba(255,255,255,.92);--line:rgba(60,60,67,.16);--line-strong:rgba(60,60,67,.24);--ink:#1c1c1e;--ink-soft:#6e6e73;--brand:#007aff;--brand-soft:rgba(0,122,255,.12);--danger:#d93025;--danger-soft:rgba(255,59,48,.12);--success:#248a3d;--success-soft:rgba(52,199,89,.13);--glow-a:rgba(0,122,255,.16);--glow-b:rgba(90,200,250,.18);--shadow:0 24px 60px rgba(28,28,30,.1)}
  :root[data-theme="dark"]{--bg:#0d1117;--bg-accent:#151b25;--surface:rgba(27,34,45,.88);--surface-strong:#202938;--surface-muted:rgba(41,51,66,.82);--surface-input:rgba(17,23,32,.9);--line:rgba(235,242,255,.14);--line-strong:rgba(235,242,255,.28);--ink:#f2f5f9;--ink-soft:#aab4c3;--brand:#5aa7ff;--brand-soft:rgba(90,167,255,.18);--danger:#ff6961;--danger-soft:rgba(255,105,97,.16);--success:#62d47d;--success-soft:rgba(98,212,125,.14);--glow-a:rgba(32,110,210,.22);--glow-b:rgba(50,170,210,.14);--shadow:0 24px 60px rgba(0,0,0,.34)}
  *{box-sizing:border-box}body{margin:0;min-height:100vh;color:var(--ink);font:15px/1.55 "SF Pro Text","PingFang SC","Noto Sans SC",sans-serif;background:radial-gradient(circle at top left,var(--glow-a),transparent 28%),radial-gradient(circle at top right,var(--glow-b),transparent 26%),linear-gradient(180deg,var(--bg),var(--bg-accent)) fixed}body.switcher-open{overflow:hidden}.page{width:min(1240px,calc(100vw - 32px));margin:auto;padding:14px 0 48px}.topbar{position:relative;z-index:2;display:flex;align-items:center;justify-content:space-between;min-height:52px;padding:7px 12px;border:1px solid var(--line);border-radius:13px;background:var(--surface);box-shadow:0 12px 32px rgba(30,70,120,.08);backdrop-filter:blur(20px)}body.switcher-open .topbar{z-index:21}.center-switcher{position:relative;z-index:22}.center-switcher-trigger{display:inline-flex;align-items:center;gap:8px;min-height:36px;padding:0 7px;border:0;border-radius:10px;background:transparent;color:var(--ink);font:inherit;font-weight:700;cursor:pointer}.center-switcher-trigger:hover,.center-switcher-trigger:focus-visible{background:var(--surface-muted);outline:none}.center-switcher-trigger>svg:first-child{width:22px;height:22px;flex:0 0 22px;color:#a78bfa}.center-switcher-chevron{width:15px;height:15px;flex:0 0 15px;transition:transform .18s}.center-switcher.is-open .center-switcher-chevron{transform:rotate(180deg)}.center-switcher-menu{position:absolute;z-index:22;top:calc(100% + 10px);left:0;width:min(286px,calc(100vw - 32px));padding:8px;border:1px solid var(--line);border-radius:20px;background:var(--surface-strong);box-shadow:0 24px 60px rgba(28,28,30,.22)}.center-switcher-menu[hidden],.center-switcher-backdrop[hidden]{display:none}.center-switcher-backdrop{position:fixed;z-index:20;inset:0;border:0;background:rgba(28,28,30,.28);backdrop-filter:blur(2px)}.center-switcher-option{display:grid;grid-template-columns:30px 1fr 20px;align-items:center;gap:12px;min-height:62px;padding:0 14px;border-radius:14px;color:var(--ink);font-size:16px;font-weight:650;text-decoration:none}.center-switcher-option:hover,.center-switcher-option:focus-visible{background:var(--surface-muted);outline:none}.center-switcher-option[aria-current="page"]{background:var(--brand-soft)}.center-switcher-option svg{width:27px;height:27px}.center-switcher-option[data-center="expense"] svg{color:#3478f6}.center-switcher-option[data-center="invoice"] svg{color:#34b978}.center-switcher-option[data-center="staff"] svg{color:#f0a52b}.center-switcher-option[data-center="accounts"] svg{color:#a78bfa}.center-switcher-check{color:var(--brand);font-size:22px;font-weight:800;text-align:center}.topbar-actions{display:flex;align-items:center;gap:6px}.topbar-actions form{margin:0}.icon-button,.logout-button{display:inline-flex;align-items:center;justify-content:center;min-height:36px;border:1px solid transparent;border-radius:10px;background:var(--surface-muted);color:var(--ink);font:inherit;font-weight:650;cursor:pointer}.icon-button{width:36px;padding:0;font-size:20px}.logout-button{gap:6px;padding:0 9px}.logout-button svg{width:18px;height:18px}
  .hero{padding:30px 34px 26px}.hero h1{margin:0;font-size:clamp(34px,4vw,48px);line-height:1.08;letter-spacing:-.035em}.hero p{max-width:720px;margin:10px 0 0;color:var(--ink-soft);font-size:16px}.notice{margin:0 0 18px;padding:13px 16px;border:1px solid color-mix(in srgb,var(--brand) 22%,transparent);border-radius:14px;background:var(--brand-soft);color:var(--ink)}.layout{display:grid;grid-template-columns:286px minmax(0,1fr);gap:18px;align-items:start}.sidebar{position:sticky;top:14px}.card{min-width:0;margin:0 0 18px;padding:22px;border:1px solid var(--line);border-radius:20px;background:var(--surface);box-shadow:var(--shadow);backdrop-filter:blur(20px)}h2{margin:0;font-size:20px;letter-spacing:-.015em}.card-heading{display:flex;align-items:center;justify-content:space-between;gap:12px;margin-bottom:16px}.count-badge,.status-badge{display:inline-flex;align-items:center;border-radius:999px;font-size:12px;font-weight:700}.count-badge{padding:4px 9px;background:var(--brand-soft);color:var(--brand)}.status-badge{padding:2px 7px;background:var(--success-soft);color:var(--success)}.status-badge.off{background:var(--danger-soft);color:var(--danger)}.people{display:grid;gap:8px}.people a{display:block;padding:11px 12px;border:1px solid transparent;border-radius:12px;background:var(--surface-muted);color:var(--ink);text-decoration:none;overflow-wrap:anywhere}.people a:hover{border-color:var(--line-strong)}.people a[aria-current]{border-color:color-mix(in srgb,var(--brand) 35%,transparent);background:var(--brand-soft)}.person-name{display:flex;align-items:center;justify-content:space-between;gap:8px;font-weight:700}.people small{display:block;margin-top:3px;color:var(--ink-soft);font-size:12px}.identity-summary{margin:8px 0 18px;padding:12px 14px;border-radius:13px;background:var(--surface-muted)}.identity-summary p{margin:0}.identity-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:0 14px}.identity-grid .wide{grid-column:1/-1}label{display:block;margin:13px 0 7px;font-weight:650}input:not([type=checkbox]),select{display:block;width:100%;min-height:46px;padding:10px 12px;border:1px solid var(--line-strong);border-radius:12px;background:var(--surface-input);color:var(--ink);font:inherit;-webkit-appearance:none}select{padding-right:38px;background-image:linear-gradient(45deg,transparent 50%,var(--ink-soft) 50%),linear-gradient(135deg,var(--ink-soft) 50%,transparent 50%);background-position:calc(100% - 18px) 19px,calc(100% - 13px) 19px;background-size:5px 5px,5px 5px;background-repeat:no-repeat}input:focus,select:focus{outline:3px solid var(--brand-soft);border-color:var(--brand)}button.button-primary{min-height:42px;padding:9px 16px;border:0;border-radius:11px;background:var(--brand);color:#fff;font:inherit;font-weight:700;cursor:pointer}button.button-primary:hover{filter:brightness(.97)}.muted{color:var(--ink-soft);font-size:13px}.card>p.muted{margin-top:6px}.check{display:flex;align-items:center;gap:8px;margin:9px 0;font-weight:500;min-width:0;overflow-wrap:anywhere}.check input{width:18px;height:18px;margin:0;accent-color:var(--brand);flex:0 0 auto}fieldset{min-width:0;margin:18px 0;padding:14px;border:1px solid var(--line);border-radius:14px;background:color-mix(in srgb,var(--surface-muted) 68%,transparent)}legend{padding:0 5px;font-weight:700}.checks{display:flex;gap:4px 20px;flex-wrap:wrap}.card-title{display:flex;align-items:flex-start;justify-content:space-between;gap:16px}.permission-heading{align-items:center;padding-bottom:16px;border-bottom:1px solid var(--line)}.permission-heading>.check{margin:0;white-space:nowrap}.section-toggle{display:flex;align-items:center;gap:11px;min-width:0;padding:0;border:0;background:transparent;color:var(--ink);font:inherit;text-align:left;cursor:pointer}.section-toggle strong{display:block;font-size:19px}.section-toggle small{display:block;margin-top:2px;color:var(--ink-soft);font-size:12px;font-weight:500}.app-mark{display:grid;place-items:center;width:38px;height:38px;border-radius:12px;background:var(--brand-soft);color:var(--brand);font-weight:800}.section-chevron{font-size:21px;transition:transform .18s}.access-form.collapsed .section-chevron{transform:rotate(-90deg)}.access-form.collapsed .access-body{display:none}.effective-preview{margin:16px 0;padding:14px;border-radius:13px;background:var(--brand-soft)}.effective-preview strong{display:block;margin-bottom:4px}.effective-preview.invalid{background:var(--danger-soft);color:var(--danger)}.matrix{display:grid;grid-template-columns:minmax(120px,1fr) repeat(2,minmax(140px,1fr));align-items:center;gap:3px 12px;min-width:0}.matrix-head{padding:6px;border-bottom:1px solid var(--line);color:var(--ink-soft);font-weight:700}.disabled-settings{opacity:.5}.audit-card{padding:0;overflow:hidden}.audit-card summary{padding:18px 22px;cursor:pointer;font-weight:700}.audit{overflow:auto;border-top:1px solid var(--line)}table{width:100%;border-collapse:collapse;text-align:left;font-size:13px}td,th{padding:12px;border-bottom:1px solid var(--line);vertical-align:top}th{color:var(--ink-soft);font-size:11px;letter-spacing:.04em}tbody tr:last-child td{border-bottom:0}code{overflow-wrap:anywhere;color:var(--ink)}.empty-state{text-align:center;padding:42px 24px}.empty-state .app-mark{margin:0 auto 14px;width:48px;height:48px;font-size:18px}
  @media(max-width:760px){.page{width:calc(100vw - 16px);padding:8px 0 28px}.topbar{min-height:52px;padding:7px 9px}.logout-button{width:36px;padding:0}.logout-button span{display:none}.hero{padding:25px 12px 22px}.hero h1{font-size:34px}.hero p{font-size:14px}.layout{grid-template-columns:1fr;gap:0}.sidebar{position:static}.card{padding:17px;border-radius:18px;margin-bottom:12px}.people{grid-template-columns:repeat(2,minmax(0,1fr))}.identity-grid{grid-template-columns:1fr}.identity-grid .wide{grid-column:auto}.permission-heading{gap:8px}.permission-heading>.check{font-size:13px}.section-toggle{gap:8px}.section-toggle strong{font-size:17px}.section-toggle small{max-width:150px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.app-mark{width:34px;height:34px}.matrix{grid-template-columns:minmax(62px,.7fr) repeat(2,minmax(0,1fr));gap:2px 5px;font-size:12px}.matrix-head{padding:4px}.audit-card summary{padding:16px 18px}}
  @media(max-width:420px){.people{grid-template-columns:1fr}.center-switcher-trigger{padding-left:4px}.hero h1{font-size:32px}}
  </style></head><body><div class="page"><nav class="topbar" aria-label="账号中心导航"><div class="center-switcher" id="centerSwitcher"><button class="center-switcher-trigger" id="centerSwitcherTrigger" type="button" aria-haspopup="menu" aria-expanded="false" aria-controls="centerSwitcherMenu">${centerIcons.accounts}<span>账号中心</span><svg class="center-switcher-chevron" viewBox="0 0 20 20" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="m5 7 5 5 5-5"/></svg></button><div class="center-switcher-menu" id="centerSwitcherMenu" role="menu" hidden>${centerOptions}<a class="center-switcher-option" data-center="accounts" role="menuitem" href="/auth/accounts" aria-current="page">${centerIcons.accounts}<span>账号中心</span><span class="center-switcher-check" aria-hidden="true">✓</span></a></div></div><div class="topbar-actions"><button class="icon-button" id="themeToggle" type="button" aria-label="切换到深色模式" aria-pressed="false"><span id="themeIcon" aria-hidden="true">🌙</span></button><form action="/logout" method="post">${hidden("returnTo", "/auth/accounts")}<button class="logout-button" type="submit"><svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10 4H5a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h5M15 8l4 4-4 4M19 12H9"/></svg><span>退出登录</span></button></form></div></nav><button class="center-switcher-backdrop" id="centerSwitcherBackdrop" type="button" aria-label="关闭后台选择列表" hidden></button>
  <header class="hero"><h1>账号管理</h1><p>统一维护登录身份、后台权限和数据范围。每项授权都会实时显示最终生效结果。</p></header>${message ? `<p role="status" class="notice">${escapeHtml(message)}</p>` : ""}
  <main><div class="layout"><aside class="sidebar"><section class="card"><div class="card-heading"><h2>账号列表</h2><span class="count-badge">${people.length}</span></div><div class="people">${people.map((person) => `<a href="/auth/accounts?account=${encodeURIComponent(person.accountId)}" ${person.accountId === selected ? 'aria-current="page"' : ""}><span class="person-name"><span>${escapeHtml(person.displayName)}</span><span class="status-badge ${person.enabled ? "" : "off"}">${person.enabled ? "启用" : "停用"}</span></span><small>${escapeHtml(person.username)}</small></a>`).join("")}</div></section>
  <form method="post" action="/auth/accounts/create" class="card identity-form"><div class="card-heading"><h2>新建账号</h2></div>${hidden("csrf", csrf)}<label>登录名<input name="username" required maxlength="200" autocomplete="off"></label><label>显示名称<input name="displayName" required maxlength="200"></label><label>初始密码<input type="password" name="password" required maxlength="4096" autocomplete="new-password"></label><p class="muted">登录名和密码开头、结尾不能含空格。创建后默认不能进入任何后台。</p><button class="button-primary" type="submit">创建账号</button></form></aside><section>
  ${account ? `<form method="post" action="/auth/accounts/identity" class="card identity-form"><div class="card-heading"><h2>${escapeHtml(account.displayName)}</h2><span class="status-badge ${account.enabled ? "" : "off"}">${account.enabled ? "账号已启用" : "账号已停用"}</span></div>${hidden("csrf", csrf)}${hidden("accountId", account.accountId)}${hidden("version", account.version)}<div class="identity-summary"><p class="muted">不可修改的账号 ID：</p><code>${escapeHtml(account.accountId)}</code><p class="muted">${managementAccountIds.includes(account.accountId) ? "拥有账号管理权限（由服务器配置授予）" : "没有账号管理权限"}</p></div><div class="identity-grid"><label>登录名<input name="username" value="${escapeHtml(account.username)}" required maxlength="200"></label><label>显示名称<input name="displayName" value="${escapeHtml(account.displayName)}" required maxlength="200"></label><label class="wide">重设密码<input name="password" type="password" autocomplete="new-password" placeholder="留空则保持原密码" maxlength="4096"></label></div><p class="muted">重设密码会使该账号在所有后台的现有会话失效。</p>${checkbox({ name: "enabled", label: "启用账号", checked: account.enabled })}<p class="muted">停用账号会立即阻止其访问全部后台，但保留已有授权配置。</p>${hidden("confirmPassword", "0")}${hidden("confirmDisable", "0")}<button class="button-primary" type="submit">保存账号</button></form>${accessForms}` : `<section class="card empty-state"><span class="app-mark" aria-hidden="true">号</span><h2>选择一个账号</h2><p class="muted">从左侧选择账号，或创建账号后配置后台权限。</p></section>`}
  </section></div><details class="card audit-card"><summary>最近的账号变更记录</summary><div class="audit"><table><thead><tr><th>时间</th><th>操作人</th><th>动作</th><th>账号 / 后台</th><th>变化</th></tr></thead><tbody>${recent.map((row) => `<tr><td>${escapeHtml(new Date(row.occurred_at).toLocaleString("zh-CN", { timeZone: "Asia/Shanghai" }))}</td><td><code>${escapeHtml(row.actor)}</code></td><td>${escapeHtml({ "account:create": "创建账号", "account:update": "修改账号", "access:put": "修改授权" }[row.action] ?? row.action)}</td><td><code>${escapeHtml(row.account_id)}</code> ${escapeHtml(APP_DEFINITIONS[row.app]?.label)}</td><td>${escapeHtml(auditDetails(row))}</td></tr>`).join("")}</tbody></table></div></details></main></div>
  <script src="/auth/accounts/ui.js"></script></body></html>`;
}

function managementScript() {
  const policyJson = JSON.stringify({ apps: APP_DEFINITIONS, stores: STORE_DEFINITIONS, channels: EXPENSE_CHANNELS }).replaceAll("<", "\\u003c");
  return `(() => {
    const policy=${policyJson};const labels=Object.fromEntries(Object.entries(policy.channels).map(([key,item])=>[key,policy.stores[item.store]+item.label]));
    const root=document.documentElement,themeToggle=document.getElementById('themeToggle'),themeIcon=document.getElementById('themeIcon');
    const renderTheme=()=>{const dark=root.dataset.theme==='dark';themeToggle.setAttribute('aria-pressed',String(dark));themeToggle.setAttribute('aria-label',dark?'切换到浅色模式':'切换到深色模式');themeIcon.textContent=dark?'☀️':'🌙';};
    themeToggle.addEventListener('click',()=>{root.dataset.theme=root.dataset.theme==='dark'?'light':'dark';root.style.colorScheme=root.dataset.theme;try{localStorage.setItem('account-management-theme',root.dataset.theme)}catch{}renderTheme();});renderTheme();
    const switcher=document.getElementById('centerSwitcher'),switcherTrigger=document.getElementById('centerSwitcherTrigger'),switcherMenu=document.getElementById('centerSwitcherMenu'),switcherBackdrop=document.getElementById('centerSwitcherBackdrop');
    const setSwitcher=open=>{switcher.classList.toggle('is-open',open);switcherTrigger.setAttribute('aria-expanded',String(open));switcherMenu.hidden=!open;switcherBackdrop.hidden=!open;document.body.classList.toggle('switcher-open',open);};
    switcherTrigger.addEventListener('click',()=>setSwitcher(switcherMenu.hidden));switcherBackdrop.addEventListener('click',()=>setSwitcher(false));document.addEventListener('keydown',event=>{if(event.key==='Escape')setSwitcher(false)});
    const selected=(form,name)=>[...form.querySelectorAll('[name="'+name+'"]:checked')].map(input=>input.value);
    const setMaster=(form,group)=>{const master=form.querySelector('[data-master="'+group+'"]'),members=[...form.querySelectorAll('[data-member="'+group+'"]')];if(!master)return;const count=members.filter(item=>item.checked).length;master.checked=count===members.length;master.indeterminate=count>0&&count<members.length;};
    const update=form=>{const app=form.dataset.app,enabled=form.querySelector('[data-app-enabled]').checked,settings=form.querySelector('[data-app-settings]');settings.classList.toggle('disabled-settings',!enabled);for(const control of settings.querySelectorAll('input,select'))control.disabled=!enabled;form.querySelector('.app-state').textContent=enabled?'当前启用；保存后按下方结果生效。':'当前停用；已有配置保留，但不会生效。';const permissions=selected(form,'permissions'),preview=form.querySelector('[data-preview]'),lines=[],errors=[];if(!enabled){preview.classList.remove('invalid');preview.querySelector('div').textContent='此后台当前不能访问。';return;}const definition=policy.apps[app];if(!definition.entry.some(permission=>permissions.includes(permission)))errors.push('缺少可进入后台的基础权限');if(app==='expense'){for(const [name,permission,title] of [['view','report:view','查看'],['submit','report:submit','提交'],['import','report:import','补录']]){const channels=selected(form,name+'Channels');if(permissions.includes(permission)){if(channels.length)lines.push(title+'：'+channels.map(channel=>labels[channel]).join('、'));else errors.push(title+'范围为空');}}if(permissions.includes('task:view:any'))lines.push('他人批量任务：仅限查看权限和查看范围内');}else{const stores=selected(form,'viewStores');if(stores.length)lines.push('门店：'+stores.map(store=>policy.stores[store]).join('、'));else errors.push('门店范围为空');}lines.unshift('操作：'+(permissions.map(permission=>definition.permissions[permission]).join('、')||'无'));preview.classList.toggle('invalid',errors.length>0);preview.querySelector('div').innerHTML=[...lines,...errors.map(error=>'⚠ '+error)].map(line=>'<div>'+line+'</div>').join('');};
    const templates={'invoice-readonly':{role:'viewer',permissions:['submission:view','attachment:view'],stores:'all'},'invoice-operator':{role:'operator',permissions:['submission:view','attachment:view','submission:delete'],stores:'all'},'invoice-admin':{role:'admin',permissions:['submission:view','attachment:view','submission:delete'],stores:'all'},'staff-readonly':{role:'viewer',permissions:['employee:view','attachment:view'],stores:'all'},'staff-operator':{role:'operator',permissions:['employee:view','attachment:view','employee:edit'],stores:'all'},'staff-admin':{role:'admin',permissions:['employee:view','attachment:view','employee:edit','employee:delete','employee:restore'],stores:'all'},'expense-readonly':{role:'partner',permissions:['report:view','attachment:view'],ownership:'any',view:'all'},'expense-partner':{role:'partner',permissions:['report:view','attachment:view','report:submit'],ownership:'any',view:'all',submit:'ordinary'},'expense-manager':{role:'manager',permissions:['report:view','attachment:view','report:submit'],ownership:'self',view:'none',submit:'none'},'expense-admin':{role:'admin',permissions:['report:view','attachment:view','report:submit','report:edit','report:delete','report:import','task:view:any'],ownership:'any',view:'all',submit:'all',import:'all'}};
    const applyTemplate=(form,name)=>{const item=templates[name];if(!item)return;for(const input of form.querySelectorAll('[name="permissions"]'))input.checked=item.permissions.includes(input.value);if(item.role)form.elements.role.value=item.role;if(item.ownership)form.elements.ownership.value=item.ownership;if(item.stores==='all')for(const input of form.querySelectorAll('[name="viewStores"]'))input.checked=true;for(const scope of ['view','submit','import'])if(item[scope])for(const input of form.querySelectorAll('[name="'+scope+'Channels"]'))input.checked=item[scope]==='all'||item[scope]==='ordinary'&&!input.value.includes('manager')||item[scope]==='manager'&&input.value.includes('manager');for(const master of form.querySelectorAll('[data-master]'))setMaster(form,master.dataset.master);update(form);};
    const compactLayout=matchMedia('(max-width: 760px)');
    for(const form of document.querySelectorAll('.access-form')){const toggle=form.querySelector('.section-toggle');const setCollapsed=collapsed=>{form.classList.toggle('collapsed',collapsed);toggle.setAttribute('aria-expanded',String(!collapsed));};toggle.addEventListener('click',()=>setCollapsed(!form.classList.contains('collapsed')));compactLayout.addEventListener('change',event=>setCollapsed(event.matches));setCollapsed(compactLayout.matches);for(const master of form.querySelectorAll('[data-master]'))master.addEventListener('change',()=>{for(const item of form.querySelectorAll('[data-member="'+master.dataset.master+'"]'))item.checked=master.checked;update(form);});for(const member of form.querySelectorAll('[data-member]'))member.addEventListener('change',()=>{setMaster(form,member.dataset.member);update(form);});for(const input of form.querySelectorAll('[data-permission]'))input.addEventListener('change',()=>{const deps=policy.apps[form.dataset.app].dependencies;if(input.checked&&deps[input.value])form.querySelector('[data-permission="'+deps[input.value]+'"]').checked=true;if(!input.checked)for(const [permission,dependency] of Object.entries(deps))if(dependency===input.value)form.querySelector('[data-permission="'+permission+'"]').checked=false;update(form);});form.elements.template.addEventListener('change',()=>applyTemplate(form,form.elements.template.value));form.querySelector('[data-app-enabled]').addEventListener('change',()=>update(form));form.addEventListener('submit',event=>{update(form);if(form.querySelector('[data-preview]').classList.contains('invalid')){event.preventDefault();setCollapsed(false);alert('请先处理“最终生效权限”中的提示。');}});for(const master of form.querySelectorAll('[data-master]'))setMaster(form,master.dataset.master);update(form);}
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
