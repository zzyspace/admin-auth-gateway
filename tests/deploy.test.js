import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function read(relativePath) {
  return fs.readFileSync(path.join(root, relativePath), "utf8");
}

test("systemd service loads both existing credential files and binds loopback", () => {
  const unit = read("deploy/systemd/admin-auth-gateway.service");
  assert.match(unit, /^EnvironmentFile=\/etc\/invoice-submit\.env$/m);
  assert.match(unit, /^EnvironmentFile=\/etc\/wechat-claw\.env$/m);
  assert.match(unit, /^Environment=ADMIN_AUTH_HOST=127\.0\.0\.1$/m);
  assert.match(unit, /^Environment=ADMIN_AUTH_COOKIE_SECURE=true$/m);
  assert.match(unit, /^EnvironmentFile=-\/etc\/admin-auth-gateway\.env$/m);
  assert.match(unit, /^DynamicUser=yes$/m);
  assert.match(unit, /^StateDirectory=admin-auth-gateway$/m);
});

test("HTTP trial override is explicit, short-lived, and non-Secure", () => {
  const trial = read("deploy/systemd/admin-auth-gateway.http-trial.env");
  assert.match(trial, /^ADMIN_AUTH_COOKIE_SECURE=false$/m);
  assert.match(trial, /^ADMIN_AUTH_COOKIE_NAME=admin_session$/m);
  assert.match(trial, /^ADMIN_AUTH_SESSION_TTL_SECONDS=604800$/m);
});

test("nginx verification endpoints are internal and never forward request bodies", () => {
  const nginx = read("deploy/nginx/admin-auth-gateway.locations.conf");
  for (const scope of ["invoice", "reimbursement"]) {
    const block = nginx.match(
      new RegExp(`location = /_admin_auth_${scope} \\{([\\s\\S]*?)\\n\\}`),
    )?.[1];
    assert.ok(block, `missing ${scope} auth location`);
    assert.match(block, /\binternal;/);
    assert.match(block, /proxy_pass_request_body off;/);
    assert.match(block, /proxy_set_header Cookie \$http_cookie;/);
    assert.match(block, new RegExp(`/internal/verify/${scope}`));
  }
});

test("upstream auth snippets overwrite Authorization and hide Basic challenges", () => {
  for (const scope of ["invoice", "reimbursement"]) {
    const snippet = read(`deploy/nginx/admin-auth-${scope}.inc`);
    assert.match(snippet, new RegExp(`auth_request /_admin_auth_${scope};`));
    assert.match(snippet, /proxy_set_header Authorization \$admin_authorization;/);
    assert.match(snippet, /proxy_hide_header WWW-Authenticate;/);
  }
});

test("gateway deployment leaves the shared Nginx entry to server-infra", () => {
  const hooks = read("deploy/release.sh");
  assert.doesNotMatch(hooks, /\/etc\/nginx\/snippets/);
  assert.doesNotMatch(hooks, /\bnginx -t\b/);
  assert.doesNotMatch(hooks, /systemctl reload nginx/);
});

test("gateway deployment never rewrites server environment files", () => {
  // /etc/admin-auth-gateway.env holds server-only settings such as the WeChat AppSecret.
  const hooks = read("deploy/release.sh").replace(/^#.*$/gm, "");
  assert.doesNotMatch(hooks, /\b(mv|cp|rm|install|tee)\b[^\n]*\/etc\/[\w.-]*\.env/);
  assert.doesNotMatch(hooks, />\s*\/etc\/[\w.-]*\.env/);
});

test("gateway release hooks restart only the gateway and test it in isolation", () => {
  const hooks = read("deploy/release.sh");
  assert.match(hooks, /^SERVICES=\(admin-auth-gateway\.service\)$/m);
  assert.match(hooks, /^UNIT_FILES=\(deploy\/systemd\/admin-auth-gateway\.service\)$/m);
  assert.match(hooks, /^HEALTH_URL=http:\/\/127\.0\.0\.1:8790\/health\/auth$/m);
  assert.match(hooks, /run_isolated node --test tests\/\*\.test\.js/);
});
