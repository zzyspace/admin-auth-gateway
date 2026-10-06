import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createAccountStore } from '../server/account-store.js';
import { createSessionDatabase } from '../server/database.js';
import { createApp } from '../server/app.js';
import { loadConfig } from '../server/config.js';
import { accessDestination } from '../server/account-policy.js';

const read = name => fs.readFileSync(new URL(`../public/${name}`, import.meta.url), 'utf8');
const shellJs = read('admin-shell.js'), shellCss = read('admin-shell.css'), themeJs = read('admin-theme.js');
// Centers as declared once in admin-shell.js: id, label, default href and accepted destinations.
const centers = [...shellJs.matchAll(/\{ id: "(\w+)", label: "([^"]+)", href: "([^"]+)", destinations: \[([^\]]*)\]/g)]
  .map(([, id, label, href, list]) => ({ id, label, href, destinations: [...list.matchAll(/"([^"]+)"/g)].map(m => m[1]) }));

test('shared admin shell assets are public and served verbatim', async t => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'admin-shell-test-'));
  const accounts = createAccountStore({ stateDir }), database = createSessionDatabase({ stateDir });
  const config = loadConfig({ ADMIN_AUTH_MODE: 'unified', ADMIN_AUTH_INTERNAL_TOKEN: 'fixture-secret-000000000000000000000', ADMIN_AUTH_COOKIE_SECURE: 'false', ADMIN_AUTH_COOKIE_NAME: 'admin_session' });
  const { app } = createApp({ config, accounts, database });
  const server = await new Promise(resolve => { const server = app.listen(0, '127.0.0.1', () => resolve(server)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => { await new Promise(resolve => server.close(resolve)); database.close(); accounts.close(); fs.rmSync(stateDir, { recursive: true, force: true }); });
  for (const [name, type] of [['admin-shell.js', /javascript/], ['admin-theme.js', /javascript/], ['admin-shell.css', /text\/css/]]) {
    const response = await fetch(`${base}/auth/accounts/${name}`);
    assert.equal(response.status, 200, name);
    assert.match(response.headers.get('content-type'), type, name);
    assert.equal(await response.text(), read(name), name);
  }
});

test('centers are declared once, in the canonical order and labels', () => {
  assert.deepEqual(centers.map(c => `${c.id}:${c.label}:${c.href}`), [
    'business:营业数据:/business', 'expense:报账中心:/expense', 'invoice:发票中心:/invoice', 'staff:员工中心:/staff', 'store:门店管理:/store',
  ]);
  assert.match(shellJs, /const ACCOUNTS = \{ id: "accounts", label: "账号管理", href: "\/auth\/accounts"/);
  for (const center of centers) assert.match(shellCss, new RegExp(`\\[data-center="${center.id}"\\] \\{ --center-color:#[0-9a-f]{6}; \\}`), center.id);
  assert.match(shellCss, /\[data-management\] \{ --center-color:#8e8e93; \}/);
});

test('every destination the gateway can grant is accepted by the shell', () => {
  const permissions = ['revenue:view', 'coupon:view', 'submission:view', 'employee:view', 'report:view', 'report:submit'];
  for (const center of centers) {
    for (const permission of permissions) {
      for (const set of [[permission], permission === 'report:submit' ? ['report:submit'] : []]) {
        const destination = accessDestination(center.id, { enabled: true, permissions: set });
        if (destination) assert.ok(center.destinations.includes(destination), `${center.id} → ${destination}`);
      }
    }
  }
});

test('the shell keeps the contract user-menu.js and pages rely on', () => {
  assert.match(shellJs, /document\.querySelector\("nav\.topbar\[data-admin-center\]"\)/);
  assert.match(shellJs, /element\("form", \{ method: "post", action: "\/logout", class: "logout-form", "data-account-name": nav\.dataset\.accountName \?\? null \}\)/);
  assert.match(shellJs, /name: "returnTo", value: returnTo/);
  assert.match(shellJs, /fetch\("\/auth\/api\/session"/);
  for (const id of ['center-switcher', 'center-trigger', 'center-menu', 'menu-backdrop', 'theme-toggle', 'logout']) assert.match(shellJs, new RegExp(`id: "${id}"|id="${id}"`), id);
  assert.match(themeJs, /"comeover-admin-theme"/);
  assert.match(themeJs, /querySelector\("#theme-toggle"\)/);
  // Pages that redraw on theme changes (the monthly report) rely on this event, sent only on a real change.
  assert.match(themeJs, /changed = document\.documentElement\.dataset\.theme !== value/);
  assert.match(themeJs, /if \(changed\) document\.dispatchEvent\(new CustomEvent\("admin-themechange", \{ detail: \{ theme: value \} \}\)\)/);
  // A fixed toggle size, so page-level button rules cannot make it differ between admins.
  assert.match(shellCss, /\.theme-toggle \{ width:44px; height:44px; min-height:44px; padding:0; border:0;/);
});

test('the shell stylesheet defines every custom property it uses', () => {
  // Self-contained: it must not depend on tokens from the page that embeds it.
  const used = new Set([...shellCss.matchAll(/var\(--([\w-]+)\)/g)].map(m => m[1]));
  const defined = new Set([...shellCss.matchAll(/--([\w-]+):/g)].map(m => m[1]));
  for (const name of used) assert.ok(defined.has(name), `--${name} is used but not defined in admin-shell.css`);
});

test('page-specific top bar content is moved, not copied, around the shared controls', () => {
  // Slot and extra actions keep their nodes (and listeners); brand mode skips the switcher entirely.
  assert.match(shellJs, /nav\.querySelector\(":scope > \[data-admin-slot\]"\)/);
  assert.match(shellJs, /nav\.querySelector\(":scope > \[data-admin-actions\]"\)/);
  assert.match(shellJs, /actions\.prepend\(\.\.\.extraActions\.childNodes\)/);
  assert.match(shellJs, /element\("span", \{ class: "topbar-divider", "aria-hidden": "true" \}\), \.\.\.slot\.childNodes/);
  assert.match(shellJs, /const brandMode = nav\.dataset\.adminMode === "brand"/);
  assert.match(shellJs, /if \(brandMode\) return;/);
  assert.match(shellJs, /\[\.\.\.CENTERS, ACCOUNTS\]\.find\(center => center\.id === nav\.dataset\.adminCenter\)/);
  for (const selector of ['.center-brand', '.topbar-start', '.topbar-divider', '.report-switcher-trigger', '.report-switcher-menu', '.report-switcher-option']) {
    assert.ok(shellCss.includes(`${selector} {`), selector);
  }
});
