import http from "node:http";
import fs from "node:fs";
import assert from "node:assert/strict";

export async function checkBrowser({ gateway, invoice, staff, expense, cookie, onlyInvoice, accounts, config }) {
  const { chromium } = await import(process.env.AUTH_PLAYWRIGHT_MODULE);
  const proxy = http.createServer((request, response) => {
    const target = request.url.startsWith("/invoice") ? invoice : request.url.startsWith("/staff") ? staff : request.url.startsWith("/expense") ? expense : gateway;
    const upstream = http.request(target + request.url, { method: request.method, headers: { ...request.headers, "x-forwarded-proto": "http" } }, (reply) => { response.writeHead(reply.statusCode, reply.headers); reply.pipe(response); });
    upstream.on("error", () => response.writeHead(502).end()); request.pipe(upstream);
  });
  await new Promise((resolve) => proxy.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${proxy.address().port}`;
  const browser = await chromium.launch({ executablePath: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", headless: true });
  const context = await browser.newContext();
  const errors = [];
  const page = await context.newPage(); page.on("pageerror", (error) => errors.push(error.message));
  const dir = process.env.AUTH_BROWSER_OUTPUT || "/tmp/auth-browser-check"; fs.mkdirSync(dir, { recursive: true });
  try {
    await context.addCookies([{ name: "admin_session", value: cookie.split("=")[1], url: base }]);
    for (const [route, selector, absent] of [
      ["/invoice", "#records-body tr", 'button[data-action="delete"]'],
      ["/staff", 'button[data-action="detail"]', 'button[data-action="delete"]'],
      ["/expense", 'button[data-report-id]', 'button[data-delete-id]'],
    ]) {
      await page.goto(base + route);
      await page.locator(selector).first().waitFor();
      assert.equal(await page.locator(absent).count(), 0);
      await page.screenshot({ path: `${dir}/${route.slice(1)}-desktop.png`, fullPage: true });
      await page.setViewportSize({ width: 390, height: 844 });
      const mobile = await page.evaluate(() => ({ width: innerWidth, scroll: document.documentElement.scrollWidth }));
      assert.ok(mobile.scroll <= mobile.width, `${route}: ${JSON.stringify(mobile)}`);
      await page.screenshot({ path: `${dir}/${route.slice(1)}-mobile.png`, fullPage: true });
      await page.setViewportSize({ width: 1280, height: 900 });
      if (route === "/staff") assert.ok(await page.locator('button[data-action="edit"]').count() > 0);
    }
    await context.addCookies([{ name: "admin_session", value: onlyInvoice.split("=")[1], url: base }]);
    await page.goto(base + "/invoice");
    await page.locator("#records-body tr").first().waitFor();
    await page.waitForFunction(() => document.querySelector('[data-center="staff"]').hidden);
    assert.equal(await page.locator('[data-center="expense"]').isVisible(), false);
    // A dedicated management account has no business grants.
    accounts.createAccount({ accountId: "browser-owner", username: "browser-owner", password: "browser-fixture" }, { actor: "browser-check" });
    config.managementAccountIds.push("browser-owner");
    await context.clearCookies();
    await page.goto(base + "/auth/accounts");
    await page.locator('#username').fill("browser-owner");
    await page.locator('#password').fill("browser-fixture");
    await page.getByRole("button", { name: "登录", exact: true }).click();
    await page.waitForURL("**/auth/accounts");
    const create = page.locator('form[action="/auth/accounts/create"]');
    await create.locator('[name="username"]').fill("browser-created");
    await create.locator('[name="displayName"]').fill("浏览器测试账号");
    await create.locator('[name="password"]').fill("browser-created-secret");
    await create.getByRole("button").click();
    await page.waitForURL(/account=/);
    const access = page.locator('form[action="/auth/accounts/access"]').filter({ has: page.locator('input[name="app"][value="invoice"]') });
    await access.locator('[name="enabled"]').check();
    await access.locator('[name="permissions"][value="submission:view"]').check();
    await access.locator('[name="viewStores"][value="fuzzy"]').check();
    await access.getByRole("button", { name: "保存开票后台权限", exact: true }).click();
    await page.waitForLoadState("load");
    const account = accounts.listAccounts().find((item) => item.username === "browser-created");
    assert.deepEqual(accounts.getAccess(account.accountId, "invoice").permissions, ["submission:view"]);
    assert.ok(!await page.content().then((html) => html.includes("browser-created-secret")));
    for (const width of [1440, 390]) {
      await page.setViewportSize({ width, height: 900 });
      await page.screenshot({ path: `${dir}/accounts-${width}.png`, fullPage: true });
      const size = await page.evaluate(() => ({ width: innerWidth, scroll: document.documentElement.scrollWidth }));
      assert.ok(size.scroll <= size.width, JSON.stringify(size));
    }
    await page.setViewportSize({ width: 1440, height: 900 });
    const expenseAccess = page.locator('form[action="/auth/accounts/access"]').filter({ has: page.locator('input[name="app"][value="expense"]') });
    await expenseAccess.locator('[name="enabled"]').check();
    await expenseAccess.locator('[name="template"]').selectOption("expense-manager");
    assert.match(await expenseAccess.locator('[data-preview]').innerText(), /范围为空/);
    await expenseAccess.locator('[name="template"]').selectOption("expense-readonly");
    assert.equal(await expenseAccess.locator('[name="role"]').inputValue(), "partner");
    assert.equal(await expenseAccess.locator('[name="viewChannels"]:checked').count(), 6);
    await expenseAccess.locator('[name="viewChannels"][value="reimbursement_peanut"]').uncheck();
    assert.equal(await expenseAccess.locator('[data-master="view"]').evaluate((input) => input.indeterminate), true);
    await expenseAccess.locator('[data-master="view"]').check();
    assert.equal(await expenseAccess.locator('[name="viewChannels"]:checked').count(), 6);
    assert.match(await expenseAccess.locator('[data-preview]').innerText(), /Fuzzy普通报账/);
    for (const width of [1440, 390]) {
      await page.setViewportSize({ width, height: 900 });
      const size = await page.evaluate(() => ({ width: innerWidth, scroll: document.documentElement.scrollWidth }));
      assert.ok(size.scroll <= size.width, JSON.stringify(size));
      await page.screenshot({ path: `${dir}/accounts-expense-matrix-${width}.png`, fullPage: true });
    }
    await page.setViewportSize({ width: 1440, height: 900 });
    await expenseAccess.getByRole("button", { name: "保存报账后台权限", exact: true }).click();
    await page.waitForLoadState("load");
    await context.clearCookies();
    await page.goto(base + "/login?returnTo=/expense");
    await page.locator('#username').fill("browser-created");
    await page.locator('#password').fill("browser-created-secret");
    await page.getByRole("button", { name: "登录", exact: true }).click();
    await page.locator('button[data-report-id]').first().waitFor();
    assert.equal(await page.getByRole("button", { name: "新建报账", exact: true }).isVisible(), false);
    assert.equal(await page.locator('[data-edit-id], [data-delete-id]').count(), 0);
    assert.equal(await page.locator('#manualImportOpen').isVisible(), false);
    await page.screenshot({ path: `${dir}/expense-readonly-mobile.png`, fullPage: true });
    assert.deepEqual(errors, []);
    console.log(`Browser verification passed; screenshots: ${dir}`);
  } finally {
    await browser.close();
    await new Promise((resolve) => proxy.close(resolve));
  }
}
