import assert from "node:assert/strict";
import test from "node:test";
import { sanitizeReturnTo, renderLoginPage, scopeForReturnTo } from "../server/login-page.js";

test("workbench login allows only the exact local return path", () => {
  assert.equal(sanitizeReturnTo("/mini.html"), "/mini.html");
  for (const value of ["//evil.example/mini.html", "https://evil.example/mini.html", "/mini.html/", "/mini.html?next=https://evil.example", "/mini.html#next", "/mini.html/../auth/accounts", "/miniXhtml"]) {
    assert.equal(sanitizeReturnTo(value), "/invoice");
  }
  const html = renderLoginPage({ returnTo: "/mini.html", csrfToken: "fixture", sessionDays: 30 });
  assert.match(html, /登录后进入工作台/);
  assert.match(html, /name="returnTo" value="\/mini\.html"/);
});

test('monthly report login preserves its route and only its supported filters', () => {
  for (const route of ['/expense/monthly','/expense/monthly/','/expense/monthly?month=2026-09&store=fuzzy','/expense/monthly?store=peanut']) {
    assert.equal(sanitizeReturnTo(route),route);
    assert.equal(scopeForReturnTo(route,'unified'),'expense');
  }
  for (const route of ['/expense/monthly?redirect=https://example.com','/expense/monthly?month=2026-13','/expense/monthly?store=unknown','/expense/monthly?month=2026-09&month=2026-08']) assert.equal(sanitizeReturnTo(route),'/expense/monthly');
  assert.equal(sanitizeReturnTo('https://example.com/expense/monthly'),'/invoice');
});
