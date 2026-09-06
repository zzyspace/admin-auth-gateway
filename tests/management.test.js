import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createAccountStore } from "../server/account-store.js";
import { createSessionDatabase } from "../server/database.js";
import { createApp } from "../server/app.js";
import { loadConfig } from "../server/config.js";

test("management is explicit, supports isolated management login and protects all writes", async (t) => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "management-test-"));
  const accounts = createAccountStore({ stateDir }), database = createSessionDatabase({ stateDir });
  for (const id of ["owner", "business"]) accounts.createAccount({ accountId: id, username: id, password: "fixture-password" }, { actor: "fixture" });
  accounts.putAccess({ accountId: "business", app: "invoice", role: "admin", permissions: ["submission:view"], config: { viewScope: { ownership: "any", stores: "all" } } }, { actor: "fixture", expectedVersion: 0 });
  const config = loadConfig({ ADMIN_AUTH_MODE: "unified", ADMIN_AUTH_INTERNAL_TOKEN: "fixture-secret-000000000000000000000", ADMIN_AUTH_MANAGEMENT_ACCOUNT_IDS: "owner", ADMIN_AUTH_COOKIE_SECURE: "false", ADMIN_AUTH_COOKIE_NAME: "admin_session" });
  const { app, sessions } = createApp({ config, accounts, database });
  const server = await new Promise((resolve) => { const server = app.listen(0, "127.0.0.1", () => resolve(server)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => { await new Promise((resolve) => server.close(resolve)); database.close(); accounts.close(); fs.rmSync(stateDir, { recursive: true, force: true }); });
  const ownerToken = sessions.login("owner", "fixture-password").token;
  const headers = { Cookie: `admin_session=${ownerToken}` };
  const business = sessions.login("business", "fixture-password");
  assert.equal((await fetch(base + "/auth/accounts", { headers: { Cookie: `admin_session=${business.token}` } })).status, 403);
  const page = await fetch(base + "/auth/accounts", { headers });
  assert.equal(page.status, 200);
  const html = await page.text();
  assert.doesNotMatch(html, /fixture-password/);
  const csrf = html.match(/name="csrf" value="([^"]+)"/)[1];
  const post = (action, body, extra = {}) => {
    const form = new URLSearchParams({ csrf });
    for (const [name, value] of Object.entries(body)) {
      for (const item of Array.isArray(value) ? value : [value]) form.append(name, item);
    }
    return fetch(base + "/auth/accounts/" + action, { method: "POST", redirect: "manual", headers: { ...headers, Origin: base, "Content-Type": "application/x-www-form-urlencoded", ...extra }, body: form });
  };
  assert.equal((await post("create", { username: "bad", displayName: "bad", password: "secret" }, { Origin: "https://evil.test", "X-Original-Method": "GET" })).status, 403);
  assert.equal((await post("create", { csrf: "wrong", username: "bad", password: "secret" })).status, 403);
  const created = await post("create", { username: "new-person", displayName: "<script>fixture</script>", password: "private-fixture" });
  assert.equal(created.status, 303);
  const person = accounts.listAccounts().find((account) => account.username === "new-person");
  assert.ok(person);
  const editPage = await (await fetch(base + created.headers.get("location"), { headers })).text();
  assert.ok(editPage.includes("&lt;script&gt;fixture&lt;/script&gt;"));
  assert.doesNotMatch(editPage, /private-fixture/);
  assert.equal((await post("access", { accountId: person.accountId, app: "invoice", role: "viewer", enabled: "1", version: "0", permissions: "submission:view", viewStores: "fuzzy" })).status, 303);
  assert.deepEqual(accounts.getAccess(person.accountId, "invoice").config, { viewScope: { stores: ["fuzzy"], ownership: "any" } });
  assert.equal((await post("access", { accountId: person.accountId, app: "invoice", role: "admin", version: "0", permissions: "submission:delete" })).status, 409);
  assert.equal((await post("access", { accountId: person.accountId, app: "staff", role: "operator", enabled: "1", version: "0", permissions: "employee:edit", viewStores: "fuzzy" })).status, 400);
  assert.equal((await post("access", { accountId: person.accountId, app: "expense", role: "manager", enabled: "1", version: "0", permissions: ["report:view", "report:submit", "report:import"], ownership: "self", viewChannels: "reimbursement_fuzzy_manager", submitChannels: "reimbursement_peanut_manager", importChannels: "reimbursement_fuzzyqz" })).status, 303);
  assert.deepEqual(accounts.getAccess(person.accountId, "expense").config, {
    viewScope: { ownership: "self", stores: ["fuzzy"], channels: ["reimbursement_fuzzy_manager"] },
    submitScope: { stores: ["peanut"], channels: ["reimbursement_peanut_manager"] },
    importScope: { stores: ["fuzzyqz"], channels: ["reimbursement_fuzzyqz"] },
  });
  assert.equal((await post("identity", { accountId: "owner", version: "1", username: "owner", displayName: "Owner", password: "" })).status, 400);
  assert.equal((await post("identity", { accountId: person.accountId, version: "1", username: "new-person", displayName: "New", password: "changed", enabled: "1" })).status, 400);
  assert.equal((await post("identity", { accountId: person.accountId, version: "1", username: "new-person", displayName: "New", password: "changed", confirmPassword: "1", enabled: "1" })).status, 303);
  assert.ok(accounts.authenticate("new-person", "changed"));
  assert.ok(accounts.listAudit().some((row) => row.actor === "owner" && row.account_id === person.accountId));
  assert.equal((await post("access", { accountId: person.accountId, app: "invoice", role: "viewer", enabled: "1", version: "1", permissions: "submission:view", viewStores: "fuzzy_qz" })).status, 303);
  const refreshed = await (await fetch(`${base}/auth/accounts?account=${encodeURIComponent(person.accountId)}`, { headers })).text();
  assert.match(refreshed, /不可修改的账号 ID/);
  assert.match(refreshed, /数据范围已变化/);
  assert.doesNotMatch(refreshed, /changed/);
  config.managementAccountIds.length = 0;
  assert.equal((await fetch(base + "/auth/accounts", { headers })).status, 403);
});
