import crypto from "node:crypto";

const LOGIN_THEME_SCRIPT = "\n      (() => {\n        const key = \"comeover-admin-theme\";\n        const media = window.matchMedia(\"(prefers-color-scheme: dark)\");\n        const valid = value => value === \"light\" || value === \"dark\";\n        const saved = () => { try { return window.localStorage.getItem(key); } catch { return null; } };\n        const apply = theme => { document.documentElement.dataset.theme = theme; document.documentElement.style.colorScheme = theme; };\n        const preferred = saved();\n        apply(valid(preferred) ? preferred : (media.matches ? \"dark\" : \"light\"));\n        window.addEventListener(\"storage\", event => {\n          if (event.key === key) apply(valid(event.newValue) ? event.newValue : (media.matches ? \"dark\" : \"light\"));\n        });\n        media.addEventListener(\"change\", event => { if (!valid(saved())) apply(event.matches ? \"dark\" : \"light\"); });\n      })();\n    ";
export const LOGIN_THEME_SCRIPT_HASH = crypto.createHash("sha256").update(LOGIN_THEME_SCRIPT).digest("base64");

const ALLOWED_RETURN_PATHS = [
  /^\/mini\.html$/,
  /^\/store\/?$/,
  /^\/auth\/accounts\/?$/,
  /^\/invoice\/?$/,
  /^\/staff\/?$/,
  /^\/expense\/?$/,
  /^\/expense\/submit\/?$/,
  /^\/employee\/portal\/?$/,
  /^\/reimbursement\/?$/,
  /^\/reimbursement\/submit\/?$/,
];

export function sanitizeReturnTo(value) {
  const candidate = typeof value === "string" ? value : "";
  return ALLOWED_RETURN_PATHS.some((pattern) => pattern.test(candidate))
    ? candidate
    : "/invoice";
}

export function scopeForReturnTo(returnTo, mode = "legacy") {
  if (mode === "unified") {
    if (returnTo === "/store" || returnTo === "/store/") return "store";
    if (returnTo.startsWith("/auth/accounts")) return "accounts";
    if (returnTo.startsWith("/staff") || returnTo.startsWith("/employee")) return "staff";
    return returnTo.startsWith("/expense") || returnTo.startsWith("/reimbursement") ? "expense" : "invoice";
  }
  return returnTo.startsWith("/expense") || returnTo.startsWith("/reimbursement")
    ? "reimbursement"
    : "invoice";
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

export function renderLoginPage({ csrfToken, returnTo, sessionDays, error = "", actionPath = "/login", bindingFlowId = "" }) {
  const safeReturnTo = sanitizeReturnTo(returnTo);
  const destination = safeReturnTo === "/mini.html" ? "工作台" : safeReturnTo.startsWith("/store") ? "门店管理" : safeReturnTo.startsWith("/auth/accounts") ? "账号管理" : safeReturnTo.startsWith("/expense") || safeReturnTo.startsWith("/reimbursement")
    ? "报账后台"
    : safeReturnTo.startsWith("/staff") || safeReturnTo.startsWith("/employee")
      ? "员工资料后台"
      : "开票后台";

  return `<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
    <meta name="color-scheme" content="light dark">
    <title>后台登录</title>
    <script>${LOGIN_THEME_SCRIPT}</script>
    <style>
      :root { color-scheme: light dark; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
      * { box-sizing: border-box; }
      body { margin: 0; min-height: 100svh; display: grid; place-items: center; padding: 24px; background: #eef2f7; color: #172033; }
      main { width: min(100%, 410px); padding: 32px; border: 1px solid #d8deea; border-radius: 18px; background: #fff; box-shadow: 0 18px 50px rgba(31, 45, 70, .12); }
      h1 { margin: 0 0 8px; font-size: 26px; }
      p { margin: 0 0 24px; color: #63708a; }
      label { display: block; margin: 16px 0 7px; font-weight: 650; }
      input { width: 100%; min-height: 48px; border: 1px solid #b7c0d1; border-radius: 10px; padding: 11px 13px; font: inherit; background: transparent; }
      input:focus { outline: 3px solid rgba(46, 108, 229, .2); border-color: #2e6ce5; }
      button { width: 100%; min-height: 48px; margin-top: 24px; border: 0; border-radius: 10px; background: #2e6ce5; color: #fff; font: inherit; font-weight: 700; cursor: pointer; }
      .error { margin: 0 0 16px; padding: 11px 13px; border-radius: 9px; background: #fff0f0; color: #a52222; }
      .note { margin: 18px 0 0; font-size: 13px; line-height: 1.5; }
      :root[data-theme="dark"] body { background: #111827; color: #edf2fb; }
      :root[data-theme="dark"] main { background: #1c2535; border-color: #344056; box-shadow: none; }
      :root[data-theme="dark"] p { color: #aab5ca; }
      :root[data-theme="dark"] input { border-color: #526078; }
      :root[data-theme="dark"] .error { background: #482424; color: #ffd1d1; }
      @media (prefers-color-scheme: dark) {
        :root:not([data-theme="light"]) body { background: #111827; color: #edf2fb; }
        :root:not([data-theme="light"]) main { background: #1c2535; border-color: #344056; box-shadow: none; }
        :root:not([data-theme="light"]) p { color: #aab5ca; }
        :root:not([data-theme="light"]) input { border-color: #526078; }
        :root:not([data-theme="light"]) .error { background: #482424; color: #ffd1d1; }
      }
    </style>
  </head>
  <body>
    <main>
      <h1>${bindingFlowId ? "首次绑定微信" : "后台登录"}</h1>
      <p>${bindingFlowId ? "使用原账号密码验证身份，登录并绑定当前微信。" : "登录后进入" + escapeHtml(destination)}</p>
      ${error ? `<div class="error" role="alert">${escapeHtml(error)}</div>` : ""}
      <form method="post" action="${escapeHtml(actionPath)}" autocomplete="on">
        <input type="hidden" name="csrfToken" value="${escapeHtml(csrfToken)}">
        ${bindingFlowId ? `<input type="hidden" name="bindingFlowId" value="${escapeHtml(bindingFlowId)}">` : ""}
        <input type="hidden" name="returnTo" value="${escapeHtml(safeReturnTo)}">
        <label for="username">账号</label>
        <input id="username" name="username" type="text" autocomplete="username" autocapitalize="none" required autofocus>
        <label for="password">密码</label>
        <input id="password" name="password" type="password" autocomplete="current-password" required>
        <button type="submit">${bindingFlowId ? "登录并绑定微信" : "登录"}</button>
      </form>
      ${bindingFlowId ? '<p class="note"><a href="/login?returnTo=%2Fmini.html">暂不绑定，使用账号密码登录</a></p>' : ""}
      <p class="note">在此设备上保持登录 ${escapeHtml(sessionDays)} 天。请勿在公共设备上使用。</p>
    </main>
  </body>
</html>`;
}
