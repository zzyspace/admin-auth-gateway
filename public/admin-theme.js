// Shared admin light/dark theme, served at /auth/accounts/admin-theme.js.
// Load synchronously in <head> (before page styles paint) so the saved theme applies without a flash.
// The #theme-toggle button is rendered by admin-shell.js.
(() => {
  const key = "comeover-admin-theme", media = matchMedia("(prefers-color-scheme: dark)");
  const valid = value => value === "light" || value === "dark";
  // Per-admin keys predate the shared key; they are read only as a fallback and never written.
  const legacyKeys = ["employee-portal-theme", "invoice-admin-theme", "reimbursement-admin-theme", "store-management-theme", "account-management-theme"];
  const saved = () => {
    try {
      for (const name of [key, ...legacyKeys]) { const value = localStorage.getItem(name); if (valid(value)) return value; }
    } catch {}
    return null;
  };
  // Pages that draw theme-dependent content (e.g. charts) listen for "admin-themechange".
  const apply = value => {
    const dark = value === "dark", changed = document.documentElement.dataset.theme !== value;
    document.documentElement.dataset.theme = value;
    document.documentElement.style.colorScheme = value;
    const meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.content = dark ? "#1d2026" : "#ffffff";
    const button = document.querySelector("#theme-toggle");
    if (button) {
      button.setAttribute("aria-pressed", String(dark));
      button.setAttribute("aria-label", dark ? "切换到浅色模式" : "切换到深色模式");
      const icon = document.querySelector("#theme-icon");
      if (icon) icon.textContent = dark ? "☀️" : "🌙";
    }
    if (changed) document.dispatchEvent(new CustomEvent("admin-themechange", { detail: { theme: value } }));
  };
  const preferred = () => valid(saved()) ? saved() : media.matches ? "dark" : "light";
  apply(preferred());
  addEventListener("storage", event => { if (event.key === key) apply(preferred()); });
  media.addEventListener("change", () => { if (!valid(saved())) apply(preferred()); });
  document.addEventListener("DOMContentLoaded", () => {
    apply(preferred());
    document.querySelector("#theme-toggle")?.addEventListener("click", () => {
      const value = document.documentElement.dataset.theme === "dark" ? "light" : "dark";
      apply(value); try { localStorage.setItem(key, value); } catch {}
    });
  });
})();
