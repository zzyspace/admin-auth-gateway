import assert from "node:assert/strict";
import test from "node:test";
import { sanitizeReturnTo, renderLoginPage } from "../server/login-page.js";

test("workbench login allows only the exact local return path", () => {
  assert.equal(sanitizeReturnTo("/mini.html"), "/mini.html");
  for (const value of ["//evil.example/mini.html", "https://evil.example/mini.html", "/mini.html/", "/mini.html?next=https://evil.example", "/mini.html#next", "/mini.html/../auth/accounts", "/miniXhtml"]) {
    assert.equal(sanitizeReturnTo(value), "/invoice");
  }
  const html = renderLoginPage({ returnTo: "/mini.html", csrfToken: "fixture", sessionDays: 30 });
  assert.match(html, /登录后进入工作台/);
  assert.match(html, /name="returnTo" value="\/mini\.html"/);
});
