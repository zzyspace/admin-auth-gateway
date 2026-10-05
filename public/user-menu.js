(() => {
  'use strict';
  const menus = [];
  const logoutIcon = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M10 4H5a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h5M15 8l4 4-4 4M19 12H9"/></svg>';
  let active = null;
  function close(restoreFocus = false) {
    if (!active) return;
    const menu = active;
    active = null;
    menu.panel.hidden = true;
    menu.root.removeAttribute('data-open');
    menu.trigger.setAttribute('aria-expanded', 'false');
    if (restoreFocus) menu.trigger.focus();
  }
  function open(menu, focusItem = false) {
    if (menu.root.hidden) return;
    close();
    // Only one navigation dropdown is open at a time.
    document.querySelectorAll('.topbar [aria-haspopup="menu"][aria-expanded="true"]').forEach(button => {
      if (button !== menu.trigger) button.click();
    });
    active = menu;
    menu.panel.hidden = false;
    menu.root.setAttribute('data-open', '');
    menu.trigger.setAttribute('aria-expanded', 'true');
    if (focusItem) menu.logout.focus();
  }
  for (const form of document.querySelectorAll('.topbar form[action="/logout"]')) {
    if (form.closest('.account-menu')) continue;
    const logout = form.querySelector('button[type="submit"]');
    if (!logout) continue;
    const root = document.createElement('div');
    root.className = 'account-menu';
    root.hidden = form.hidden;
    const trigger = document.createElement('button');
    trigger.type = 'button';
    trigger.className = 'account-menu-trigger';
    trigger.setAttribute('aria-haspopup', 'menu');
    trigger.setAttribute('aria-expanded', 'false');
    const label = document.createElement('span');
    label.className = 'account-menu-name';
    trigger.append(label);
    const panel = document.createElement('div');
    panel.className = 'account-menu-panel';
    panel.id = `account-menu-panel-${menus.length + 1}`;
    panel.setAttribute('role', 'menu');
    panel.setAttribute('aria-label', '用户菜单');
    panel.hidden = true;
    trigger.setAttribute('aria-controls', panel.id);
    logout.setAttribute('role', 'menuitem');
    logout.setAttribute('aria-label', '退出登录');
    // Keep the original form, submit button, hidden inputs and submit handlers.
    if (!logout.querySelector('svg')) logout.insertAdjacentHTML('afterbegin', logoutIcon);
    form.before(root);
    root.append(trigger, panel);
    panel.append(form);
    const menu = { root, trigger, panel, logout, form, label };
    menus.push(menu);
    const name = form.dataset.accountName?.trim() || '';
    setName(menu, name);
    trigger.addEventListener('click', () => active === menu ? close() : open(menu));
    trigger.addEventListener('keydown', event => {
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault(); open(menu, true);
      }
    });
    root.addEventListener('focusout', () => requestAnimationFrame(() => {
      if (active === menu && !root.contains(document.activeElement)) close();
    }));
    new MutationObserver(() => {
      root.hidden = form.hidden;
      if (root.hidden && active === menu) close();
    }).observe(form, { attributes: true, attributeFilter: ['hidden'] });
  }
  function setName(menu, name) {
    menu.label.textContent = name || '我的账户';
    menu.trigger.title = name || '我的账户';
    menu.trigger.setAttribute('aria-label', `${name || '我的账户'}，用户菜单`);
  }
  async function loadName() {
    const pending = menus.filter(menu => !menu.form.hasAttribute('data-account-name'));
    if (!pending.length) return;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 8000);
    try {
      const response = await fetch('/auth/api/session', { credentials: 'same-origin', cache: 'no-store', headers: { Accept: 'application/json' }, signal: controller.signal });
      if (!response.ok) return;
      const session = await response.json();
      // This field is the managed real name. Never substitute the login username.
      const name = typeof session.account?.displayName === 'string' ? session.account.displayName.trim() : '';
      pending.forEach(menu => setName(menu, name));
    } catch { /* The original logout form remains available if identity lookup fails. */ }
    finally { clearTimeout(timeout); }
  }
  document.addEventListener('pointerdown', event => {
    if (active && !active.root.contains(event.target)) close();
  }, true);
  document.addEventListener('keydown', event => {
    if (!active) return;
    if (event.key === 'Escape') {
      event.preventDefault(); event.stopImmediatePropagation(); close(true);
    } else if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key) && active.panel.contains(event.target)) {
      event.preventDefault(); active.logout.focus();
    }
  }, true);
  addEventListener('pageshow', event => {
    if (!event.persisted) return;
    close();
    menus.filter(menu => !menu.form.hasAttribute('data-account-name')).forEach(menu => setName(menu, ''));
    void loadName();
  });
  void loadName();
})();
