// Shared admin top bar, served at /auth/accounts/admin-shell.js.
// Pages provide <nav class="topbar" aria-label="后台导航" data-admin-center="<center>" data-return-to="/path"></nav>
// and load this script with `defer` BEFORE user-menu.js, which then upgrades the logout form.
// Which centers appear comes from /auth/api/session; showing a link never grants access.
//
// Optional, for pages with their own top bar content:
//   data-admin-mode="brand"   show the center as a plain link (data-admin-home, default the center's
//                             href) instead of the center switcher, e.g. for submit-only or report pages.
//   <div data-admin-slot>     its children follow the switcher/brand after a divider (e.g. a report
//                             or feature switcher); nodes are moved, so page references stay valid.
//   <div data-admin-actions>  its children go before the theme toggle (e.g. a "返回后台" link).
//   data-account-name="…"     handed to user-menu.js so it needs no extra request.
// data-admin-center="accounts" marks the account management page as the current entry.
(() => {
  const CENTERS = [
    { id: "business", label: "营业数据", href: "/business", destinations: ["/business"],
      icon: '<svg viewBox="0 0 32 32" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="3.6" stroke-linecap="round" stroke-linejoin="round"><path d="M7 26V16M16 26V6M25 26V11"/></svg>' },
    { id: "expense", label: "报账中心", href: "/expense", destinations: ["/expense", "/expense/submit"],
      icon: '<svg viewBox="0 0 32 32" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><rect x="5" y="7" width="22" height="19" rx="4" fill="currentColor" fill-opacity=".16"/><path d="M8 7V5.5A2.5 2.5 0 0 1 10.5 3H22"/><path d="M10 13h8"/><path d="m12 17 2.2 2.2 3.5-3.7"/><circle cx="24" cy="24" r="4" fill="currentColor" stroke="none"/><path d="M24 22v4M22 24h4" stroke="white" stroke-width="1.8"/></svg>' },
    { id: "invoice", label: "发票中心", href: "/invoice", destinations: ["/invoice"],
      icon: '<svg viewBox="0 0 32 32" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><rect x="7" y="3.5" width="18" height="25" rx="3"/><path d="M11 9h10M11 14h8M11 19h5"/><circle cx="23" cy="23.5" r="4"/><path d="m21.3 23.5 1.2 1.2 2.2-2.5"/></svg>' },
    { id: "staff", label: "员工中心", href: "/staff", destinations: ["/staff"],
      icon: '<svg viewBox="0 0 32 32" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><circle cx="16" cy="10" r="5"/><path d="M6.5 27c.8-6.2 4-9.2 9.5-9.2s8.7 3 9.5 9.2"/></svg>' },
    { id: "store", label: "门店管理", href: "/store", destinations: ["/store"],
      icon: '<svg viewBox="0 0 32 32" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M6 15v10a3 3 0 0 0 3 3h14a3 3 0 0 0 3-3V15M4 12l2.5-7h19l2.5 7M13 28v-8h6v8"/><path d="M4 12a4 4 0 0 0 8 0 4 4 0 0 0 8 0 4 4 0 0 0 8 0"/></svg>' },
  ];
  const ACCOUNTS = { id: "accounts", label: "账号管理", href: "/auth/accounts",
    icon: '<svg viewBox="0 0 32 32" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="9.5" r="4.25" fill="currentColor" fill-opacity=".16"/><path d="M4.5 25.5c.65-5.8 3.15-8.5 7.5-8.5 3.25 0 5.45 1.5 6.65 4.55"/><circle cx="23.25" cy="22.75" r="3.25" fill="currentColor" fill-opacity=".16"/><path d="M23.25 17.5v1.15M23.25 26.85V28M18 22.75h1.15M27.35 22.75h1.15M19.55 19.05l.8.8M26.15 25.65l.8.8M26.95 19.05l-.8.8M20.35 25.65l-.8.8"/><circle cx="23.25" cy="22.75" r="1.05" fill="currentColor" stroke="none"/></svg>' };
  // The workbench (/mini.html) is the entry to every center, not a center itself: brand mode only.
  const WORKBENCH = { id: "workbench", label: "Workbench", href: "/mini.html",
    icon: '<svg viewBox="0 0 32 32" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linejoin="round"><rect x="5" y="5" width="9" height="9" rx="2.5"/><rect x="18" y="5" width="9" height="9" rx="2.5" fill="currentColor" fill-opacity=".16"/><rect x="5" y="18" width="9" height="9" rx="2.5" fill="currentColor" fill-opacity=".16"/><rect x="18" y="18" width="9" height="9" rx="2.5"/></svg>' };
  const CHEVRON = '<svg class="center-switcher-chevron" viewBox="0 0 20 20" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" hidden><path d="m5 7 5 5 5-5"></path></svg>';
  const LOGOUT = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M10 4H5a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h5M15 8l4 4-4 4M19 12H9"></path></svg>';

  const nav = document.querySelector("nav.topbar[data-admin-center]");
  if (!nav) return;
  const current = [...CENTERS, ACCOUNTS, WORKBENCH].find(center => center.id === nav.dataset.adminCenter);
  if (!current) throw new Error(`Unknown admin center: ${nav.dataset.adminCenter}`);
  const brandMode = nav.dataset.adminMode === "brand";
  if (current === WORKBENCH && !brandMode) throw new Error('The workbench needs data-admin-mode="brand"');
  const element = (tag, attributes = {}, html = "") => {
    const node = document.createElement(tag);
    for (const [name, value] of Object.entries(attributes)) {
      if (value === true) node.setAttribute(name, "");
      else if (value !== false && value != null) node.setAttribute(name, value);
    }
    if (html) node.innerHTML = html;
    return node;
  };
  const withIcon = (svg, className) => svg.replace("<svg ", `<svg class="${className}" `);
  // Page-provided content is moved (not copied) so listeners and element references survive.
  const slot = nav.querySelector(":scope > [data-admin-slot]");
  const extraActions = nav.querySelector(":scope > [data-admin-actions]");

  const switcher = element("div", { class: "center-switcher", id: "center-switcher" });
  const trigger = element("button", { class: "center-switcher-trigger", id: "center-trigger", "data-center": current.id, "aria-haspopup": "menu", "aria-expanded": "false", "aria-controls": "center-menu", type: "button", disabled: true },
    `${withIcon(current.icon, "center-icon")}<span>${current.label}</span>${CHEVRON}`);
  const menu = element("div", { class: "center-switcher-menu", id: "center-menu", role: "menu", hidden: true });
  const option = (center, attributes) => {
    const isCurrent = center === current;
    return element("a", { class: "center-switcher-option", ...attributes, role: "menuitem", href: center.href, "aria-current": isCurrent ? "page" : null, hidden: !isCurrent },
      `${center.icon}<span>${center.label}</span>${isCurrent ? '<span class="center-switcher-check" aria-hidden="true">✓</span>' : "<span></span>"}`);
  };
  for (const center of CENTERS) menu.append(option(center, { "data-center": center.id }));
  menu.append(option(ACCOUNTS, { "data-management": "true", "data-center": current === ACCOUNTS ? "accounts" : null }));
  switcher.append(trigger, menu);
  const brand = element("a", { class: "center-brand", "data-center": current.id, href: nav.dataset.adminHome || current.href },
    `${withIcon(current.icon, "center-icon")}<span>${current.label}</span>`);

  const returnTo = nav.dataset.returnTo || location.pathname;
  const actions = element("div", { class: "topbar-actions" },
    '<button class="theme-toggle" id="theme-toggle" type="button" aria-label="切换到深色模式" aria-pressed="false"><span aria-hidden="true" id="theme-icon">🌙</span></button>');
  if (extraActions) actions.prepend(...extraActions.childNodes);
  const form = element("form", { method: "post", action: "/logout", class: "logout-form", "data-account-name": nav.dataset.accountName ?? null });
  form.append(element("input", { type: "hidden", name: "returnTo", value: returnTo }));
  form.append(element("button", { class: "logout", id: "logout", type: "submit" }, `${LOGOUT}<span>退出登录</span>`));
  actions.append(form);
  const start = slot ? element("div", { class: "topbar-start" }) : null;
  if (start) start.append(brandMode ? brand : switcher, element("span", { class: "topbar-divider", "aria-hidden": "true" }), ...slot.childNodes);
  nav.replaceChildren(start ?? (brandMode ? brand : switcher), actions);
  if (brandMode) return;

  const backdrop = element("button", { class: "center-switcher-backdrop", id: "menu-backdrop", "aria-label": "关闭后台选择列表", type: "button", tabindex: "-1", hidden: true });
  nav.after(backdrop);
  const options = () => [...menu.querySelectorAll(".center-switcher-option")];
  const currentOption = menu.querySelector("[aria-current='page']");
  function toggle(open, focus = false) {
    if (open && trigger.disabled) return;
    switcher.classList.toggle("is-open", open);
    document.body.classList.toggle("switcher-open", open);
    trigger.setAttribute("aria-expanded", String(open)); menu.hidden = !open; backdrop.hidden = !open;
    if (open) currentOption.focus();
    if (focus) trigger.focus();
  }
  trigger.addEventListener("click", () => toggle(menu.hidden));
  backdrop.addEventListener("click", () => toggle(false, true));
  currentOption.addEventListener("click", () => toggle(false, true));
  document.addEventListener("keydown", event => {
    if (event.key === "Escape" && !menu.hidden) toggle(false, true);
    if (event.key === "Tab" && !menu.hidden) {
      const controls = [trigger, ...options().filter(option => !option.hidden), document.querySelector("#theme-toggle"), nav.querySelector(".account-menu-trigger") || document.querySelector("#logout")];
      if (event.shiftKey && document.activeElement === controls[0]) { event.preventDefault(); controls.at(-1).focus(); }
      else if (!event.shiftKey && document.activeElement === controls.at(-1)) { event.preventDefault(); controls[0].focus(); }
    }
  });

  async function loadCenters() {
    try {
      const response = await fetch("/auth/api/session", { credentials: "same-origin", cache: "no-store", headers: { Accept: "application/json" } });
      if (!response.ok) return;
      const session = await response.json();
      for (const center of CENTERS) {
        if (center === current) continue;
        const destination = session.destinations?.[center.id];
        const link = menu.querySelector(`[data-center="${center.id}"]`);
        link.hidden = !(session.apps?.includes(center.id) && center.destinations.includes(destination ?? center.href));
        if (!link.hidden) link.href = destination ?? center.href;
      }
      if (current !== ACCOUNTS) menu.querySelector("[data-management]").hidden = session.canManageAccounts !== true;
    } catch { /* Keep the current center label, with switching disabled. */ }
    trigger.disabled = !options().some(option => !option.hidden && option !== currentOption);
    trigger.querySelector(".center-switcher-chevron").toggleAttribute("hidden", trigger.disabled);
  }
  addEventListener("pageshow", event => { if (event.persisted) void loadCenters(); });
  void loadCenters();
})();
