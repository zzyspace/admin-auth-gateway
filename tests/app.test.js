import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createApp } from "../server/app.js";
import { loadConfig } from "../server/config.js";
import { createSessionDatabase } from "../server/database.js";
import { createSessionService } from "../server/session-service.js";

function testConfig(overrides = {}) {
  return loadConfig({
    ADMIN_AUTH_COOKIE_SECURE: "false",
    ADMIN_AUTH_COOKIE_NAME: "admin_session",
    ADMIN_AUTH_SESSION_TTL_SECONDS: "3600",
    ADMIN_AUTH_LOGIN_WINDOW_SECONDS: "60",
    ADMIN_AUTH_LOGIN_MAX_ATTEMPTS: "3",
    INVOICE_ADMIN_USERNAME: "shared-admin",
    INVOICE_ADMIN_PASSWORD: "shared-password",
    WECHATY_ADMIN_USERNAME: "shared-admin",
    WECHATY_ADMIN_PASSWORD: "shared-password",
    WECHATY_REIMBURSEMENT_ACCOUNTS_JSON: JSON.stringify([
      {
        accountId: "partner-001",
        username: "reimbursement-partner",
        password: "partner-password",
        role: "partner",
      },
      {
        accountId: "manager-001",
        username: "reimbursement-manager",
        password: "manager-password",
        role: "manager",
        managerStores: ["fuzzyqz", "fuzzy"],
      },
    ]),
    ...overrides,
  });
}

async function startFixture({ config = testConfig(), clock } = {}) {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "admin-auth-gateway-test-"));
  const database = createSessionDatabase({ stateDir });
  const { app } = createApp({ config, database, now: clock ? () => clock.value : Date.now });
  const server = await new Promise((resolve) => {
    const listening = app.listen(0, "127.0.0.1", () => resolve(listening));
  });
  const address = server.address();
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    config,
    async close() {
      await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
      database.close();
      fs.rmSync(stateDir, { recursive: true, force: true });
    },
  };
}

function cookieFrom(response, name) {
  const header = response.headers.get("set-cookie") ?? "";
  const match = header.match(new RegExp(`(?:^|,\\s*)${name}=([^;,]*)`));
  return match ? `${name}=${match[1]}` : null;
}

function csrfFrom(html) {
  return html.match(/name="csrfToken" value="([^"]+)"/)?.[1] ?? null;
}

async function login(fixture, { username, password, returnTo }) {
  const page = await fetch(`${fixture.baseUrl}/admin-login?returnTo=${encodeURIComponent(returnTo)}`);
  const html = await page.text();
  const csrfToken = csrfFrom(html);
  const csrfCookie = cookieFrom(page, "admin_login_csrf");
  assert.ok(csrfToken);
  assert.ok(csrfCookie);

  const response = await fetch(`${fixture.baseUrl}/admin-login`, {
    method: "POST",
    redirect: "manual",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Cookie: csrfCookie,
    },
    body: new URLSearchParams({ csrfToken, username, password, returnTo }),
  });
  return response;
}

async function verify(fixture, { cookie, scope, method = "GET", origin = "http://admin.test" }) {
  return fetch(`${fixture.baseUrl}/internal/verify/${scope}`, {
    headers: {
      Cookie: cookie,
      "X-Original-Method": method,
      "X-Original-Host": "admin.test",
      "X-Original-Proto": "http",
      ...(origin ? { "X-Original-Origin": origin } : {}),
    },
  });
}

test("loadConfig requires both credential groups and safe cookie settings", () => {
  assert.throws(() => loadConfig({}), /INVOICE_ADMIN_USERNAME/);
  assert.throws(() => testConfig({ WECHATY_ADMIN_PASSWORD: "" }), /configured together/);
  assert.throws(
    () => testConfig({ ADMIN_AUTH_COOKIE_SECURE: "true", ADMIN_AUTH_COOKIE_NAME: "admin_session" }),
    /__Host-/,
  );
});

test("loadConfig validates reimbursement roles, stable ids, and multi-store managers", () => {
  const config = testConfig({
    WECHATY_ADMIN_GUEST_USERNAME: "legacy-guest",
    WECHATY_ADMIN_GUEST_PASSWORD: "legacy-password",
  });
  assert.deepEqual(
    config.credentials.reimbursement.map(({ accountId, role, managerStores }) => ({
      accountId,
      role,
      managerStores,
    })),
    [
      { accountId: "reimbursement-admin", role: "admin", managerStores: [] },
      { accountId: "partner-001", role: "partner", managerStores: [] },
      { accountId: "manager-001", role: "manager", managerStores: ["fuzzy", "fuzzyqz"] },
    ],
  );
  assert.throws(
    () => testConfig({
      WECHATY_REIMBURSEMENT_ACCOUNTS_JSON: JSON.stringify([
        {
          accountId: "manager-bad",
          username: "manager-bad",
          password: "password",
          role: "manager",
          managerStores: [],
        },
      ]),
    }),
    /requires at least one manager store/,
  );
});

test("login page sanitizes external return destinations and sets CSRF cookie", async (t) => {
  const fixture = await startFixture();
  t.after(() => fixture.close());
  const response = await fetch(`${fixture.baseUrl}/admin-login?returnTo=https://evil.example/`);
  const html = await response.text();
  assert.equal(response.status, 200);
  assert.match(html, /name="returnTo" value="\/invoice"/);
  assert.match(html, /保持登录 1 天/);
  assert.match(response.headers.get("set-cookie"), /admin_login_csrf=.*HttpOnly.*SameSite=Strict/i);
  assert.match(response.headers.get("content-security-policy"), /form-action 'self'/);
  assert.equal(response.headers.get("x-frame-options"), "DENY");

  const nearMissResponse = await fetch(
    `${fixture.baseUrl}/admin-login?returnTo=${encodeURIComponent("/reimbursement/submit_other")}`,
  );
  assert.match(await nearMissResponse.text(), /name="returnTo" value="\/invoice"/);
});

test("login page preserves exact batch reimbursement destinations", async (t) => {
  const fixture = await startFixture();
  t.after(() => fixture.close());

  for (const returnTo of [
    "/reimbursement/submit",
    "/reimbursement/submit_fuzzy",
    "/reimbursement/submit_peanut",
    "/reimbursement/submit_fuzzyqz",
  ]) {
    const response = await fetch(
      `${fixture.baseUrl}/admin-login?returnTo=${encodeURIComponent(returnTo)}`,
    );
    assert.equal(response.status, 200);
    assert.match(await response.text(), new RegExp(`name="returnTo" value="${returnTo}"`));
  }
});

test("production configuration emits a host-wide Secure session cookie", async (t) => {
  const fixture = await startFixture({
    config: testConfig({
      ADMIN_AUTH_COOKIE_SECURE: "true",
      ADMIN_AUTH_COOKIE_NAME: "__Host-admin_session",
    }),
  });
  t.after(() => fixture.close());
  const response = await login(fixture, {
    username: "shared-admin",
    password: "shared-password",
    returnTo: "/invoice",
  });
  assert.match(
    response.headers.get("set-cookie"),
    /__Host-admin_session=.*Path=\/.*HttpOnly.*Secure.*SameSite=Lax/i,
  );
  assert.doesNotMatch(response.headers.get("set-cookie"), /Domain=/i);
});

test("login rejects missing CSRF token", async (t) => {
  const fixture = await startFixture();
  t.after(() => fixture.close());
  const response = await fetch(`${fixture.baseUrl}/admin-login`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ username: "shared-admin", password: "shared-password" }),
  });
  assert.equal(response.status, 403);
});

test("shared admin login grants invoice and reimbursement scopes", async (t) => {
  const fixture = await startFixture();
  t.after(() => fixture.close());
  const response = await login(fixture, {
    username: "shared-admin",
    password: "shared-password",
    returnTo: "/reimbursement",
  });
  assert.equal(response.status, 303);
  assert.equal(response.headers.get("location"), "/reimbursement");
  assert.match(response.headers.get("set-cookie"), /admin_session=.*Max-Age=3600.*HttpOnly.*SameSite=Lax/i);
  const cookie = cookieFrom(response, "admin_session");

  const invoice = await verify(fixture, { cookie, scope: "invoice" });
  assert.equal(invoice.status, 204);
  assert.equal(invoice.headers.get("x-admin-role"), "admin");
  assert.equal(
    invoice.headers.get("x-admin-authorization"),
    `Basic ${Buffer.from("shared-admin:shared-password").toString("base64")}`,
  );

  const reimbursement = await verify(fixture, { cookie, scope: "reimbursement" });
  assert.equal(reimbursement.status, 204);
  assert.equal(reimbursement.headers.get("x-admin-role"), "admin");
});

test("reimbursement partner cannot obtain invoice scope", async (t) => {
  const fixture = await startFixture();
  t.after(() => fixture.close());
  const response = await login(fixture, {
    username: "reimbursement-partner",
    password: "partner-password",
    returnTo: "/reimbursement",
  });
  assert.equal(response.status, 303);
  const cookie = cookieFrom(response, "admin_session");

  const reimbursement = await verify(fixture, { cookie, scope: "reimbursement" });
  assert.equal(reimbursement.status, 204);
  assert.equal(reimbursement.headers.get("x-admin-role"), "partner");
  assert.equal(reimbursement.headers.get("x-admin-account-id"), "partner-001");

  const invoice = await verify(fixture, { cookie, scope: "invoice" });
  assert.equal(invoice.status, 401);
  assert.equal(invoice.headers.get("www-authenticate"), null);
});

test("non-ASCII reimbursement usernames are safely encoded in verification headers", async (t) => {
  const fixture = await startFixture({
    config: testConfig({
      WECHATY_REIMBURSEMENT_ACCOUNTS_JSON: JSON.stringify([
        {
          accountId: "partner-cn-001",
          username: "合伙人甲",
          password: "partner-password",
          role: "partner",
        },
      ]),
    }),
  });
  t.after(() => fixture.close());
  const response = await login(fixture, {
    username: "合伙人甲",
    password: "partner-password",
    returnTo: "/reimbursement/submit",
  });
  assert.equal(response.status, 303);
  const reimbursement = await verify(fixture, {
    cookie: cookieFrom(response, "admin_session"),
    scope: "reimbursement",
  });
  assert.equal(reimbursement.status, 204);
  assert.equal(reimbursement.headers.get("x-admin-username"), encodeURIComponent("合伙人甲"));
  assert.equal(
    reimbursement.headers.get("x-admin-authorization"),
    `Basic ${Buffer.from("合伙人甲:partner-password").toString("base64")}`,
  );
});

test("legacy reimbursement guest credentials are ignored", async (t) => {
  const fixture = await startFixture({
    config: testConfig({
      WECHATY_ADMIN_GUEST_USERNAME: "legacy-guest",
      WECHATY_ADMIN_GUEST_PASSWORD: "legacy-password",
    }),
  });
  t.after(() => fixture.close());
  const response = await login(fixture, {
    username: "legacy-guest",
    password: "legacy-password",
    returnTo: "/reimbursement",
  });
  assert.equal(response.status, 401);
  assert.equal(cookieFrom(response, "admin_session"), null);
});

test("multi-store reimbursement manager can log in from the unified submission page", async (t) => {
  const fixture = await startFixture();
  t.after(() => fixture.close());
  const response = await login(fixture, {
    username: "reimbursement-manager",
    password: "manager-password",
    returnTo: "/reimbursement/submit",
  });
  assert.equal(response.status, 303);
  assert.equal(response.headers.get("location"), "/reimbursement/submit");
  const cookie = cookieFrom(response, "admin_session");

  const reimbursement = await verify(fixture, { cookie, scope: "reimbursement" });
  assert.equal(reimbursement.status, 204);
  assert.equal(reimbursement.headers.get("x-admin-role"), "manager");
  assert.equal(reimbursement.headers.get("x-admin-account-id"), "manager-001");
  assert.equal(reimbursement.headers.get("x-admin-manager-stores"), "fuzzy,fuzzyqz");
  assert.equal((await verify(fixture, { cookie, scope: "invoice" })).status, 401);
});

test("credentials for the wrong destination do not create a session", async (t) => {
  const fixture = await startFixture({
    config: testConfig({ WECHATY_ADMIN_PASSWORD: "different-password" }),
  });
  t.after(() => fixture.close());
  const response = await login(fixture, {
    username: "shared-admin",
    password: "shared-password",
    returnTo: "/reimbursement",
  });
  assert.equal(response.status, 401);
  assert.equal(cookieFrom(response, "admin_session"), null);
});

test("unsafe upstream requests require an exact same-origin Origin", async (t) => {
  const fixture = await startFixture();
  t.after(() => fixture.close());
  const response = await login(fixture, {
    username: "shared-admin",
    password: "shared-password",
    returnTo: "/invoice",
  });
  const cookie = cookieFrom(response, "admin_session");

  assert.equal((await verify(fixture, { cookie, scope: "invoice", method: "POST", origin: null })).status, 403);
  assert.equal((await verify(fixture, { cookie, scope: "invoice", method: "DELETE", origin: "https://evil.example" })).status, 403);
  assert.equal((await verify(fixture, { cookie, scope: "invoice", method: "PATCH" })).status, 204);
});

test("expired sessions and sessions created under changed credentials are rejected", async (t) => {
  const clock = { value: Date.now() };
  const config = testConfig({ ADMIN_AUTH_SESSION_TTL_SECONDS: "300" });
  const fixture = await startFixture({ config, clock });
  t.after(() => fixture.close());
  const first = await login(fixture, {
    username: "shared-admin",
    password: "shared-password",
    returnTo: "/invoice",
  });
  const firstCookie = cookieFrom(first, "admin_session");
  config.credentials.invoice[0].password = "new-password";
  assert.equal((await verify(fixture, { cookie: firstCookie, scope: "invoice" })).status, 401);
  assert.equal((await verify(fixture, { cookie: firstCookie, scope: "reimbursement" })).status, 204);

  const second = await login(fixture, {
    username: "shared-admin",
    password: "new-password",
    returnTo: "/invoice",
  });
  const secondCookie = cookieFrom(second, "admin_session");
  clock.value += 301_000;
  assert.equal((await verify(fixture, { cookie: secondCookie, scope: "invoice" })).status, 401);
});

test("manager sessions are invalidated when assigned stores change", async (t) => {
  const config = testConfig();
  const fixture = await startFixture({ config });
  t.after(() => fixture.close());
  const response = await login(fixture, {
    username: "reimbursement-manager",
    password: "manager-password",
    returnTo: "/reimbursement/submit",
  });
  const cookie = cookieFrom(response, "admin_session");
  assert.equal((await verify(fixture, { cookie, scope: "reimbursement" })).status, 204);
  config.credentials.reimbursement.find((account) => account.accountId === "manager-001").managerStores = ["peanut"];
  assert.equal((await verify(fixture, { cookie, scope: "reimbursement" })).status, 401);
});

test("logout destroys the server-side session", async (t) => {
  const fixture = await startFixture();
  t.after(() => fixture.close());
  const loginResponse = await login(fixture, {
    username: "shared-admin",
    password: "shared-password",
    returnTo: "/invoice",
  });
  const cookie = cookieFrom(loginResponse, "admin_session");
  const logout = await fetch(`${fixture.baseUrl}/admin-logout`, {
    method: "POST",
    redirect: "manual",
    headers: {
      Cookie: cookie,
      Origin: fixture.baseUrl,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({ returnTo: "/reimbursement" }),
  });
  assert.equal(logout.status, 303);
  assert.equal(logout.headers.get("location"), "/admin-login?returnTo=%2Freimbursement");
  assert.equal((await verify(fixture, { cookie, scope: "invoice" })).status, 401);
});

test("sessions remain valid after the database is reopened", () => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "admin-auth-gateway-persistence-"));
  const config = testConfig();
  let database = createSessionDatabase({ stateDir });
  let sessions = createSessionService({ config, database });
  const created = sessions.create(sessions.authenticate("shared-admin", "shared-password"));
  database.close();

  database = createSessionDatabase({ stateDir });
  sessions = createSessionService({ config, database });
  assert.equal(sessions.resolve(created.token, "invoice")?.account.username, "shared-admin");
  assert.equal(sessions.resolve(created.token, "reimbursement")?.account.role, "admin");
  database.close();
  fs.rmSync(stateDir, { recursive: true, force: true });
});

test("login failures are rate limited per client", async (t) => {
  const fixture = await startFixture();
  t.after(() => fixture.close());
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const response = await login(fixture, {
      username: "shared-admin",
      password: "wrong-password",
      returnTo: "/invoice",
    });
    assert.equal(response.status, 401);
  }
  const limited = await login(fixture, {
    username: "shared-admin",
    password: "shared-password",
    returnTo: "/invoice",
  });
  assert.equal(limited.status, 429);
  assert.equal(limited.headers.get("retry-after"), "60");
});
