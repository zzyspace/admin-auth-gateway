// Shared admin light/dark theme, served at /auth/accounts/admin-theme.js.
// Load synchronously in <head> (before page styles paint) so the saved theme applies without a flash.
// The #theme-toggle button is rendered by admin-shell.js.
(() => {
  const key = "comeover-admin-theme", media = matchMedia("(prefers-color-scheme: dark)");
  const valid = value => value === "light" || value === "dark";
  const saved = () => { try { return localStorage.getItem(key); } catch { return null; } };
  const apply = value => {
    const dark = value === "dark";
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
