import { checkBrowser } from "./browser-check.js";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createAccountStore } from "../server/account-store.js";
import { createSessionDatabase } from "../server/database.js";
import { loadConfig } from "../server/config.js";
import { createApp as gatewayApp } from "../server/app.js";
import { createApp as invoiceApp } from "../../invoice-submit/server/app.js";
import { createApp as staffApp } from "../../employee-information/server/app.js";
import { createDatabase as invoiceDatabase } from "../../invoice-submit/server/database.js";
import { createDatabase as staffDatabase } from "../../employee-information/server/database.js";
import { createApp as expenseApp } from "../../wechat-claw/dist/admin/app.js";
import { importManualReimbursementReport } from "../../wechat-claw/dist/scenarios/reimbursement/manual-import.js";
import { createBatchImportTask } from "../../wechat-claw/dist/scenarios/reimbursement/batch-import-task-repository.js";
import { getDatabase as expenseDatabase } from "../../wechat-claw/dist/core/storage/database.js";

const workspace = path.resolve(import.meta.dirname, "../..");
const internalToken = "local-integration-secret-0000000000000001";
const actor = "integration";
const invoiceGrant = { app: "invoice", role: "admin", permissions: ["submission:view", "attachment:view"], config: { viewScope: { ownership: "any", stores: ["fuzzy"] } } };
const staffGrant = { app: "staff", role: "admin", permissions: ["employee:view", "attachment:view", "employee:edit"], config: { viewScope: { ownership: "any", stores: ["fuzzy"] } } };
const expenseGrant = { app: "expense", role: "manager", permissions: ["report:view", "attachment:view", "report:submit"], config: {
  viewScope: { ownership: "self", stores: ["fuzzy"], channels: ["reimbursement_fuzzy_manager"] },
  submitScope: { stores: ["fuzzy"], channels: ["reimbursement_fuzzy_manager"] },
} };
async function serve(app, servers) {
  const server = await new Promise((resolve, reject) => {
    const server = app.listen(0, "127.0.0.1", () => resolve(server));
    server.on("error", reject);
  });
  servers.push(server);
  return `http://127.0.0.1:${server.address().port}`;
}
function request(base, route, cookie, options = {}) {
  return fetch(`${base}${route}`, { redirect: "manual", ...options,
    headers: { ...(cookie ? { Cookie: cookie } : {}),
      ...(options.method && options.method !== "GET" ? { Origin: base } : {}), ...options.headers } });
}

// Runs against real gateway and real application middleware, on temporary ports
// and databases. No production services, accounts, or model APIs are used.
test("unified authorization across the three applications", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "unified-auth-integration-"));
  const servers = [];
  const stateDir = path.join(root, "gateway");
  const accounts = createAccountStore({ stateDir });
  const sessions = createSessionDatabase({ stateDir });
  const invoiceDb = invoiceDatabase({ dbFilePath: path.join(root, "invoice.db"), dbInitSqlPath: path.join(workspace, "invoice-submit/db/init.sql") });
  const staffDb = staffDatabase({ dbFilePath: path.join(root, "staff.db"), dbInitSqlPath: path.join(workspace, "employee-information/db/init.sql") });
  const envKeys = ["WECHATY_ADMIN_USERNAME", "WECHATY_ADMIN_PASSWORD", "WECHATY_STATE_DIR", "WECHATY_PUPPET", "WECHATY_CHANNELS_JSON", "WECHATY_REIMBURSEMENT_EXTRACTION_API_KEY", "WECHATY_REIMBURSEMENT_SHORTCUT_API_TOKEN"];
  const savedEnv = Object.fromEntries(envKeys.map((key) => [key, process.env[key]]));
  t.after(async () => {
    await Promise.all(servers.map((server) => new Promise((resolve) => server.close(resolve))));
    invoiceDb.close(); staffDb.close(); accounts.close(); sessions.close(); expenseDatabase().close();
    for (const [key, value] of Object.entries(savedEnv)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    fs.rmSync(root, { recursive: true, force: true });
  });
  process.env.WECHATY_ADMIN_USERNAME = "legacy";
  process.env.WECHATY_ADMIN_PASSWORD = "legacy-password";
  process.env.WECHATY_STATE_DIR = path.join(root, "expense");
  process.env.WECHATY_PUPPET = "wechaty-puppet-wechat";
  process.env.WECHATY_REIMBURSEMENT_EXTRACTION_API_KEY = "";
  process.env.WECHATY_REIMBURSEMENT_SHORTCUT_API_TOKEN = "";
  process.env.WECHATY_CHANNELS_JSON = JSON.stringify(["reimbursement_fuzzy_manager", "reimbursement_peanut_manager", "reimbursement_fuzzy"].map((code) => ({
    code, enabled: true, scenario: "reimbursement", match: { type: "room_topic", value: code }, deliveryTargets: [], summarySchedule: "",
  })));
  for (const [id, grants] of [["operator", [invoiceGrant, staffGrant, expenseGrant]], ["invoice-only", [invoiceGrant]]]) {
    accounts.createAccount({ accountId: id, username: id, password: "test-password" }, { actor });
    for (const grant of grants) accounts.putAccess({ ...grant, accountId: id }, { actor, expectedVersion: 0 });
  }
  const config = loadConfig({ ADMIN_AUTH_MODE: "unified", ADMIN_AUTH_INTERNAL_TOKEN: internalToken, ADMIN_AUTH_COOKIE_SECURE: "false", ADMIN_AUTH_COOKIE_NAME: "admin_session" });
  const gateway = await serve(gatewayApp({ config, database: sessions, accounts }).app, servers);
  const gatewayAuth = { mode: "unified", url: gateway, token: internalToken };
  const invoice = await serve(invoiceApp({ db: invoiceDb, gatewayAuth, adminCredentials: { username: "legacy", password: "legacy-password" }, uploadDirectory: path.join(root, "invoice-uploads") }), servers);
  const staff = await serve(staffApp({ db: staffDb, gatewayAuth, adminCredentials: { username: "legacy", password: "legacy-password" }, uploadDirectory: path.join(root, "staff-uploads"), identityCardRecognizer: async () => "11010519491231002X" }), servers);
  const expense = await serve(expenseApp({ gatewayAuth }), servers);
  async function login(username = "operator", returnTo = "/invoice", password = "test-password") {
    const page = await fetch(`${gateway}/login?returnTo=${returnTo}`);
    const csrf = (await page.text()).match(/name="csrfToken" value="([^"]+)"/)[1];
    const csrfCookie = page.headers.get("set-cookie").split(";")[0];
    const response = await fetch(`${gateway}/login`, { method: "POST", redirect: "manual",
      headers: { Cookie: csrfCookie, "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ csrfToken: csrf, username, password, returnTo }) });
    assert.equal(response.status, 303);
    return response.headers.getSetCookie().find((cookie) => cookie.startsWith("admin_session=")).split(";")[0];
  }
  let cookie = await login();
  const onlyInvoice = await login("invoice-only");
  const fixtureFile = path.join(root, "fixture.jpg");
  fs.writeFileSync(fixtureFile, Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0]));
  for (const store of ["fuzzy", "peanut"]) {
    fs.copyFileSync(fixtureFile, `${fixtureFile}.invoice.${store}`);
    invoiceDb.prepare(`INSERT INTO submissions (id, invoice_type, invoice_title, email, store_key, attachment_path, attachment_name, attachment_content_type, attachment_size_bytes, created_at)
      VALUES (?, 'enterprise', 'Fixture', 'test@example.test', ?, ?, 'fixture.jpg', 'image/jpeg', 8, '2026-09-05')`).run(store, store, `${fixtureFile}.invoice.${store}`);
    staffDb.prepare(`INSERT INTO employee_submissions (id, name, phone, position, identity_card_number, store_key, created_at, updated_at)
      VALUES (?, '测试员工', '13800000000', 'front_of_house', '11010519491231002X', ?, '2026-09-05', '2026-09-05')`).run(store, store);
    staffDb.prepare(`INSERT INTO employee_attachment_versions (attachment_version_id, submission_id, kind, storage_path, original_name, content_type, size_bytes, created_at)
      VALUES (?, ?, 'id_card_front', ?, 'fixture.jpg', 'image/jpeg', 8, '2026-09-05')`).run(store, store, `${fixtureFile}.${store}`);
    fs.copyFileSync(fixtureFile, `${fixtureFile}.${store}`);
    staffDb.prepare("UPDATE employee_submissions SET current_id_card_front_attachment_id = ?, current_id_card_back_attachment_id = ? WHERE id = ?").run(store, store, store);
  }
  const expenseRecords = [];
  for (const [channel, owner] of [["reimbursement_fuzzy_manager", "operator"], ["reimbursement_fuzzy_manager", "other"], ["reimbursement_peanut_manager", "operator"], ["reimbursement_fuzzy", "operator"], ["reimbursement_fuzzy_manager", undefined]]) {
    const imported = importManualReimbursementReport({ channelCode: channel, channelName: channel, reporter: "显示报账人",
      amount: 10, expenseCategory: "food", sentAt: "2026-09-05T00:00:00.000Z",
      attachments: [{ type: "image", localPath: fixtureFile, sha256: `fixture-${expenseRecords.length}`, mimeType: "image/jpeg" }],
      ...(owner ? { submittedBy: { accountId: owner, username: owner, role: "manager", managerStores: ["fuzzy"] } } : {}),
    });
    expenseRecords.push(imported.report.id);
  }
  if (process.env.AUTH_PLAYWRIGHT_MODULE) await checkBrowser({ gateway, invoice, staff, expense, cookie, onlyInvoice, accounts, config });
  await t.test("sessions, forged headers and Basic fallback cannot cross application boundaries", async () => {
    assert.equal((await request(staff, "/staff/api/admin/session", onlyInvoice)).status, 401);
    assert.equal((await request(expense, "/expense/api/session", onlyInvoice)).status, 401);
    const spoofed = { "X-Admin-Account-Id": "operator", "X-Admin-Role": "admin", Authorization: `Basic ${Buffer.from("legacy:legacy-password").toString("base64")}` };
    for (const [base, route] of [[invoice, "/invoice/api/admin/submissions"], [staff, "/employee/api/admin/submissions"], [expense, "/reimbursement/api/reports"]]) {
      assert.equal((await request(base, route, null, { headers: spoofed })).status, 401);
    }
  });
  await t.test("invoice filters totals and attachments, blocks writes despite admin role", async () => {
    const list = await (await request(invoice, "/invoice/api/admin/submissions?allowedStores=all", cookie)).json();
    assert.equal(list.total, 1); assert.deepEqual(list.items.map((item) => item.id), ["fuzzy"]);
    assert.equal((await request(invoice, "/api/admin/submissions/peanut/attachment", cookie)).status, 404);
    assert.equal((await request(invoice, "/api/admin/submissions/fuzzy/attachment", cookie)).status, 200);
    assert.equal((await request(invoice, "/invoice/api/admin/submissions/fuzzy", cookie, { method: "DELETE" })).status, 403);
    assert.equal(invoiceDb.prepare("SELECT COUNT(*) AS n FROM submissions").get().n, 2);
  });
  await t.test("staff applies store restrictions to lists, details, histories and attachment versions", async () => {
    const list = await (await request(staff, "/staff/api/admin/submissions", cookie)).json();
    assert.equal(list.total, 1);
    for (const route of ["submissions/peanut", "submissions/peanut/history", "attachments/peanut"]) assert.equal((await request(staff, `/staff/api/admin/${route}`, cookie)).status, 404);
    assert.equal((await request(staff, "/staff/api/admin/attachments/fuzzy", cookie)).status, 200);
    assert.equal((await request(staff, "/staff/api/admin/submissions/fuzzy", cookie, { method: "DELETE" })).status, 403);
    assert.equal((await request(staff, "/staff/api/admin/submissions/fuzzy/restore", cookie, { method: "POST" })).status, 403);
    const form = new FormData();
    for (const [key, value] of Object.entries({ name: "测试员工", phone: "13800000000", position: "front_of_house", storeKey: "peanut" })) form.set(key, value);
    const move = await request(staff, "/staff/api/admin/submissions/fuzzy", cookie, { method: "PATCH", body: form });
    assert.equal(move.status, 403, await move.text());
    assert.equal(staffDb.prepare("SELECT store_key FROM employee_submissions WHERE id = 'fuzzy'").get().store_key, "fuzzy");
  });
  await t.test("explicit write grants allow only scoped records and stamp the authenticated actor", async () => {
    accounts.putAccess({ ...invoiceGrant, accountId: "operator", permissions: [...invoiceGrant.permissions, "submission:delete"] }, { actor, expectedVersion: 1 });
    cookie = await login();
    assert.equal((await request(invoice, "/invoice/api/admin/submissions/peanut", cookie, { method: "DELETE" })).status, 404);
    assert.equal((await request(invoice, "/invoice/api/admin/submissions/fuzzy", cookie, { method: "DELETE" })).status, 200);
    assert.equal(invoiceDb.prepare("SELECT COUNT(*) AS n FROM submissions").get().n, 1);
    const form = new FormData();
    for (const [key, value] of Object.entries({ name: "新姓名", phone: "13800000000", position: "front_of_house", storeKey: "fuzzy" })) form.set(key, value);
    const edited = await request(staff, "/staff/api/admin/submissions/fuzzy", cookie, { method: "PATCH", body: form, headers: { "X-Admin-Username": "forged" } });
    assert.equal(edited.status, 200, await edited.text());
    assert.equal(staffDb.prepare("SELECT actor_username FROM employee_submission_revisions WHERE submission_id = 'fuzzy'").get().actor_username, "operator");
  });
  await t.test("expense manager scope intersects owner, store and channel, including attachments", async () => {
    const list = await (await request(expense, "/expense/api/reports?submittedByAccountId=other", cookie)).json();
    assert.equal(list.total, 1); assert.equal(list.items[0].id, expenseRecords[0]);
    for (const [index, id] of expenseRecords.entries()) {
      assert.equal((await request(expense, `/expense/api/reports/${id}`, cookie)).status, index === 0 ? 200 : 404);
      const attachmentId = expenseDatabase().prepare(`SELECT ma.id FROM message_attachments ma JOIN reimbursement_report_sources rs ON rs.raw_message_id = ma.raw_message_id WHERE rs.reimbursement_report_id = ?`).get(id).id;
      assert.equal((await request(expense, `/expense/api/attachments/${attachmentId}/content`, cookie)).status, index === 0 ? 200 : 404);
    }
    for (const method of ["PATCH", "DELETE"]) assert.equal((await request(expense, `/expense/api/reports/${expenseRecords[0]}`, cookie, { method })).status, 403);
    const validOptions = await (await request(expense, "/expense/api/submissions/submit/options", cookie)).json();
    assert.deepEqual(validOptions.channels.map((item) => item.code), ["reimbursement_fuzzy_manager"]);
  });
  await t.test("expense tasks remain private even when another account can view all reports", async () => {
    const makeTask = (owner) => createBatchImportTask({ channelCode: "reimbursement_fuzzy_manager", channelName: "fixture", reporter: "fixture",
      sentAt: "2026-09-05T00:00:00Z", timeZone: "Asia/Shanghai", notes: [""], originalNames: ["fixture.jpg"],
      attachments: [{ type: "image", localPath: fixtureFile, sha256: "fixture", mimeType: "image/jpeg" }],
      submittedBy: { accountId: owner, username: owner, role: "manager", managerStores: ["fuzzy"] } });
    const own = makeTask("operator"), other = makeTask("other");
    assert.equal((await request(expense, `/expense/api/batch-reports/${own.id}`, cookie)).status, 200);
    assert.equal((await request(expense, `/expense/api/batch-reports/${other.id}`, cookie)).status, 404);
    accounts.createAccount({ accountId: "partner", username: "partner", password: "test-password" }, { actor });
    accounts.putAccess({ accountId: "partner", app: "expense", role: "partner", permissions: ["report:view", "attachment:view"],
      config: { viewScope: { ownership: "any", stores: "all", channels: "all" }, submitScope: { stores: "all", channels: [] } } }, { actor, expectedVersion: 0 });
    const partnerCookie = await login("partner", "/expense");
    assert.equal((await (await request(expense, "/expense/api/reports", partnerCookie)).json()).total, 5);
    assert.equal((await request(expense, `/expense/api/batch-reports/${other.id}`, partnerCookie)).status, 404);
    assert.equal((await request(expense, "/expense/api/submissions/submit/options", partnerCookie)).status, 403);
    assert.equal((await request(expense, `/expense/api/reports/${expenseRecords[0]}`, partnerCookie, { method: "DELETE" })).status, 403);
  });
  await t.test("new manual imports derive ownership from the session and constrain their target channel", async () => {
    accounts.createAccount({ accountId: "importer", username: "importer", password: "test-password" }, { actor });
    accounts.putAccess({ ...expenseGrant, accountId: "importer", role: "partner", permissions: ["report:view", "report:import"], config: {
      ...expenseGrant.config,
      submitScope: { stores: ["peanut"], channels: ["reimbursement_peanut_manager"] },
      importScope: { stores: ["fuzzy"], channels: ["reimbursement_fuzzy_manager"] },
    } }, { actor, expectedVersion: 0 });
    const importedCookie = await login("importer", "/expense");
    for (const channel of ["reimbursement_peanut_manager", "reimbursement_fuzzy_manager"]) {
      const form = new FormData();
      for (const [key, value] of Object.entries({ channelCode: channel, expenseCategory: "food", amount: "12.50", sentAt: "2026-09-05T08:00", reporter: "other", submittedByAccountId: "other" })) form.set(key, value);
      const reply = await request(expense, "/expense/api/reports", importedCookie, { method: "POST", body: form });
      const body = await reply.json();
      assert.equal(reply.status, channel === "reimbursement_fuzzy_manager" ? 201 : 400, JSON.stringify(body));
      if (reply.status === 201) assert.equal(body.report.submittedByAccountId, "importer");
    }
  });
  await t.test("expense admin label does not bypass data scope or grant writes; submissions reject other channels", async () => {
    accounts.putAccess({ ...expenseGrant, role: "admin", accountId: "operator" }, { actor, expectedVersion: 1 });
    cookie = await login();
    const list = await (await request(expense, "/expense/api/reports", cookie)).json();
    assert.equal(list.total, 1);
    assert.equal((await request(expense, `/expense/api/reports/${expenseRecords[0]}`, cookie, { method: "PATCH" })).status, 403);
    for (const channel of ["reimbursement_peanut_manager", "reimbursement_fuzzy"]) {
      const form = new FormData();
      form.set("channelCode", channel); form.set("sentAt", "2026-09-05T08:00");
      form.set("images", new Blob([fs.readFileSync(fixtureFile)], { type: "image/jpeg" }), "test.jpg");
      const rejected = await request(expense, "/expense/api/submissions/submit/batch-reports", cookie, { method: "POST", body: form });
      assert.equal(rejected.status, 400, await rejected.text());
    }
  });
  await t.test("authorization changes take effect without restarting and never fall back to Basic", async () => {
    accounts.putAccess({ ...staffGrant, accountId: "operator", enabled: false }, { actor, expectedVersion: 1 });
    assert.equal((await request(staff, "/staff/api/admin/session", cookie)).status, 401);
    assert.equal((await request(invoice, "/invoice/api/admin/session", cookie)).status, 200);
    assert.equal((await request(expense, "/expense/api/session", cookie)).status, 200);
    accounts.putAccess({ ...invoiceGrant, accountId: "operator", config: { viewScope: { stores: "all", ownership: "self" } } }, { actor, expectedVersion: 2 });
    cookie = await login();
    assert.equal((await request(invoice, "/invoice/api/admin/submissions", cookie)).status, 503);
    accounts.updateAccount("operator", { password: "new-password" }, { actor, expectedVersion: 1 });
    assert.equal((await request(expense, "/expense/api/session", cookie)).status, 401);
    await new Promise((resolve) => servers[0].close(resolve));
    assert.equal((await request(invoice, "/invoice/api/admin/session", onlyInvoice)).status, 503);
  });
});
