import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createApp } from "../server/app.js";
import { createAccountStore } from "../server/account-store.js";
import { createSessionDatabase } from "../server/database.js";
import { loadConfig } from "../server/config.js";

test("internal Shortcut lookup uses current exact real names and enabled expense accounts without exposing credentials", async (t) => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "shortcut-accounts-"));
  const accounts = createAccountStore({ stateDir });
  const database = createSessionDatabase({ stateDir });
  const token = "fixture-shortcut-gateway-internal-secret";
  const config = loadConfig({ ADMIN_AUTH_MODE: "unified", ADMIN_AUTH_INTERNAL_TOKEN: token });
  for (const [id, username, displayName] of [
    ["admin", "ryanzzy", "张志延"], ["same-name", "another-login", "张志延"],
    ["disabled-account", "disabled-login", "张志延"], ["disabled-access", "disabled-access-login", "张志延"],
    ["no-expense", "staff-only", "张志延"], ["login-collision", "张志延", "另一人"],
  ]) {
    accounts.createAccount({ accountId: id, username, displayName, password: "never-return-this-password", enabled: id !== "disabled-account" }, { actor: "fixture" });
    if (id !== "no-expense") accounts.putAccess({ accountId: id, app: "expense", role: "admin", enabled: id !== "disabled-access",
      permissions: ["report:view", "report:submit"], config: { viewScope: { ownership: "any", stores: "all", channels: "all" }, submitScope: { stores: "all", channels: "all" } },
    }, { actor: "fixture", expectedVersion: 0 });
  }
  const { app } = createApp({ config, accounts, database });
  const server = await new Promise((resolve) => { const listener = app.listen(0, "127.0.0.1", () => resolve(listener)); });
  t.after(async () => { await new Promise((resolve) => server.close(resolve)); database.close(); accounts.close(); fs.rmSync(stateDir, { recursive: true, force: true }); });
  const base = `http://127.0.0.1:${server.address().port}/internal/shortcut-accounts/expense`;
  const request = (name, headers = { Authorization: `Bearer ${token}` }) => fetch(`${base}?${new URLSearchParams({ displayName: name })}`, { headers });
  assert.equal((await request("张志延", {})).status, 403);
  assert.equal((await request("张志延", { Authorization: "Bearer wrong", "X-Forwarded-For": "127.0.0.1" })).status, 403);
  for (const name of ["", " 张志延", "x".repeat(201)]) assert.equal((await request(name)).status, 400);
  assert.equal((await fetch(`${base}?displayName=a&displayName=b`, { headers: { Authorization: `Bearer ${token}` } })).status, 400);
  const reply = await request("张志延");
  assert.equal(reply.status, 200);
  assert.equal(reply.headers.get("cache-control"), "no-store");
  const payload = await reply.json();
  assert.deepEqual(payload.matches.map((item) => item.account.accountId), ["admin", "same-name"]);
  assert.equal(payload.matches[0].account.username, "ryanzzy");
  assert.doesNotMatch(JSON.stringify(payload), /password|never-return-this-password/);
  for (const name of ["ryanzzy", "张志延。", "张志", "不存在"]) assert.deepEqual((await (await request(name)).json()).matches, []);
  accounts.updateAccount("same-name", { displayName: "新姓名" }, { actor: "fixture", expectedVersion: 1 });
  assert.deepEqual((await (await request("张志延")).json()).matches.map((item) => item.account.accountId), ["admin"]);
  assert.equal((await (await request("新姓名")).json()).matches[0].account.accountId, "same-name");
  accounts.updateAccount("admin", { enabled: false }, { actor: "fixture", expectedVersion: 1 });
  assert.deepEqual((await (await request("张志延")).json()).matches, []);
});
