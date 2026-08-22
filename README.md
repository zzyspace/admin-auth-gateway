# admin-auth-gateway

Shared login and persistent server-side sessions for these existing admin
applications:

- invoice-submit: `/invoice` and `/api/admin/`
- employee-information: `/employee/portal` and `/employee/api/admin/`
- wechat-claw reimbursement admin: `/reimbursement` and `/reimbursement/api/`

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

Then open `http://127.0.0.1:8790/admin-login?returnTo=/invoice`.

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
