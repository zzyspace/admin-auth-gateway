# admin-auth-gateway

Unified accounts support opt-in `ADMIN_AUTH_MODE=unified` with independent
invoice, staff, and expense grants. Legacy mode remains the default. Backend
integration and management UI were enabled and verified in production on
2026-09-06. See [the rollout plan and migration guide](docs/unified-accounts.md).

The account-management UI uses permission templates, linked permission
dependencies, channel matrices, separate view/submit/import scopes, and a live
effective-access preview. Server-side validation rejects contradictory or empty
enabled grants even when requests bypass the browser UI.

Expense grants can include `report:delete:self` (删除本人上传), which requires
`report:view` and permits deletion only for records attributed to the signed-in
account within its view scope, including attributed Shortcut uploads. Existing
`report:delete` still permits deletion of any visible record. Neither permission
is automatically added to existing accounts. Deploy the reimbursement service
with support for the new permission before enabling it through this gateway.

Shared login and persistent server-side sessions for these existing admin
applications:

- invoice-submit: `/invoice` and `/invoice/api/admin/`
- employee-information: `/staff` and `/staff/api/admin/`
- wechat-claw reimbursement admin: `/expense` and `/expense/api/`

The gateway does not own or duplicate passwords. It reads the existing
`INVOICE_ADMIN_*` credentials from `/etc/invoice-submit.env` and the existing
`WECHATY_ADMIN_*` credentials from `/etc/wechat-claw.env`.

## Behavior

- One successful login creates a random, opaque, 30-day session token.
- If one credential pair matches both configured admin accounts, the session
  receives both `invoice` and `reimbursement` scopes.
- The invoice scope covers invoice-submit and employee-information because they
  already share `INVOICE_ADMIN_USERNAME` and `INVOICE_ADMIN_PASSWORD`.
- Reimbursement accounts use `admin`, `partner`, or `manager` roles. Managers
  can be assigned one or more stores through `managerStores`.
- Nginx validates the Cookie using `auth_request`, then injects Basic Auth only
  on the loopback request to the existing application. Existing application
  authorization remains a second layer.
- Credential fingerprints are keyed by the random session token. Changing a
  configured account id, username, password, role, or manager-store assignment
  invalidates sessions for that scope.
- Session tokens are hashed in SQLite. Passwords and Basic headers are never
  stored in the session database or browser storage.

## Security boundary

Production requires HTTPS. The default Cookie is:

```text
__Host-admin_session=<opaque token>; Path=/; Max-Age=2592000; Secure; HttpOnly; SameSite=Lax
```

Unsafe upstream methods must include an exact same-origin `Origin` header. Login
uses a separate short-lived CSRF token and failed logins are rate-limited. The
gateway listens on `127.0.0.1` and its internal verification routes must remain
Nginx `internal` locations.

Do not store session tokens in `localStorage`, put credentials in URLs, expose
port 8790 publicly, or disable `Secure` in production.

## Local development

Copy `.env.example` values into your shell environment. Development HTTP must
use a non-`__Host-` cookie:

```bash
export ADMIN_AUTH_COOKIE_SECURE=false
export ADMIN_AUTH_COOKIE_NAME=admin_session
export INVOICE_ADMIN_USERNAME=admin
export INVOICE_ADMIN_PASSWORD=invoice-password
export WECHATY_ADMIN_USERNAME=admin
export WECHATY_ADMIN_PASSWORD=reimbursement-password
export WECHATY_REIMBURSEMENT_ACCOUNTS_JSON='[{"accountId":"partner-001","username":"partner","password":"partner-password","role":"partner"},{"accountId":"manager-001","username":"manager","password":"manager-password","role":"manager","managerStores":["fuzzy","fuzzyqz"]}]'
npm install
npm run dev
```

Then open `http://127.0.0.1:8790/login?returnTo=/invoice`.

## Test

```bash
npm test
```

The HTTP integration tests open a temporary loopback listener. In a restricted
sandbox they may need to be run with local-listen permission.

## Production layout

```text
/opt/admin-auth-gateway/current
/var/lib/admin-auth-gateway/sessions.db
/etc/systemd/system/admin-auth-gateway.service
```

The systemd service loads both existing credential files. The deployment script
only manages this service; shared Nginx routes and auth snippets are published by
the independent `server-infra` project. Files under `deploy/nginx/` are retained
as migration-era compatibility snapshots and are not installed by this script.

### Temporary HTTP trial

Before the domain is ready, the gateway can be exercised using an explicit,
reversible seven-day HTTP Cookie override:

```bash
bash deploy/deploy-admin-auth-gateway.sh root@server http-trial
```

This installs `/etc/admin-auth-gateway.env` with `Secure=false` and cookie name
`admin_session`. It is not suitable as a long-term public deployment because
HTTP exposes both login credentials and bearer-like session cookies to network
observers. After HTTPS is ready, run the deployment in `production` mode; the
script disables the override and restores the `__Host-admin_session` Secure
Cookie defaults.

## Credential changes

After changing `/etc/invoice-submit.env`, restart:

```bash
systemctl restart invoice-submit.service employee-information.service admin-auth-gateway.service
```

After changing the admin, partner, or manager accounts in
`/etc/wechat-claw.env`, restart only the services that consume those values:

```bash
systemctl restart wechat-claw-reimbursement-admin.service admin-auth-gateway.service
```

The bot service does not need a restart solely for an admin password change.

## 门店管理授权

新增独立应用 `store`，入口 `/store`，账号管理中的名称为“门店管理”。操作权限为 `coupon:view`、`coupon:issue`、`coupon:redeem`，激活和核销依赖查看。管理员、合伙人配置三店范围 `all`；店长按 `viewScope.stores` 显式选择门店，`ownership` 固定 `any`。角色不授予操作权限或账号管理权限。

启动时会在事务内将旧 `account_access` 应用 CHECK 扩展为支持 `store`，保留既有授权、版本和审计；不会自动添加新后台权限。发布前备份账号数据库，授权变更后重新登录新后台。共享 Nginx 入口仍由 server-infra 管理。

## 微信小程序账号绑定（默认关闭）

新增可选微信登录，仍签发现有 Cookie，会话与权限按 accountId 校验。配置 ADMIN_AUTH_WECHAT_ENABLED、ADMIN_AUTH_WECHAT_APP_ID、ADMIN_AUTH_WECHAT_APP_SECRET；密钥仅保存在服务器环境文件，不进入仓库。所有旧账号可用原密码自行绑定，管理员可在账号管理解绑。完整流程与发布门槛见 `../server-infra/docs/mini-wechat-login.md`。
