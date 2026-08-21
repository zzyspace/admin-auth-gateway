const ALLOWED_RETURN_PATHS = [
  /^\/invoice\/?$/,
  /^\/employee\/portal\/?$/,
  /^\/reimbursement\/?$/,
  /^\/reimbursement\/submit\/?$/,
  /^\/reimbursement\/submit_fuzzy\/?$/,
  /^\/reimbursement\/submit_peanut\/?$/,
  /^\/reimbursement\/submit_fuzzyqz\/?$/,
];

export function sanitizeReturnTo(value) {
  const candidate = typeof value === "string" ? value : "";
  return ALLOWED_RETURN_PATHS.some((pattern) => pattern.test(candidate))
    ? candidate
    : "/invoice";
}

export function scopeForReturnTo(returnTo) {
  return returnTo.startsWith("/reimbursement") ? "reimbursement" : "invoice";
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

export function renderLoginPage({ csrfToken, returnTo, sessionDays, error = "" }) {
  const safeReturnTo = sanitizeReturnTo(returnTo);
  const destination = safeReturnTo.startsWith("/reimbursement")
    ? "报账后台"
    : safeReturnTo.startsWith("/employee")
      ? "员工资料后台"
      : "开票后台";

  return `<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
    <meta name="color-scheme" content="light dark">
    <title>后台登录</title>
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
      @media (prefers-color-scheme: dark) {
        body { background: #111827; color: #edf2fb; }
        main { background: #1c2535; border-color: #344056; box-shadow: none; }
        p { color: #aab5ca; }
        input { border-color: #526078; }
        .error { background: #482424; color: #ffd1d1; }
      }
    </style>
  </head>
  <body>
    <main>
      <h1>后台登录</h1>
      <p>登录后进入${escapeHtml(destination)}</p>
      ${error ? `<div class="error" role="alert">${escapeHtml(error)}</div>` : ""}
      <form method="post" action="/admin-login" autocomplete="on">
        <input type="hidden" name="csrfToken" value="${escapeHtml(csrfToken)}">
        <input type="hidden" name="returnTo" value="${escapeHtml(safeReturnTo)}">
        <label for="username">账号</label>
        <input id="username" name="username" type="text" autocomplete="username" autocapitalize="none" required autofocus>
        <label for="password">密码</label>
        <input id="password" name="password" type="password" autocomplete="current-password" required>
        <button type="submit">登录</button>
      </form>
      <p class="note">在此设备上保持登录 ${escapeHtml(sessionDays)} 天。请勿在公共设备上使用。</p>
    </main>
  </body>
</html>`;
}
