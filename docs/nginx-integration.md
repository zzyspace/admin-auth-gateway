# Nginx integration

Do not enable these changes on the current plain-HTTP port. First expose the
admin host over HTTPS and redirect HTTP to HTTPS. The production cookie is a
`Secure` `__Host-` cookie and is intentionally unusable over plain HTTP.

## 1. Install and include the gateway locations

Install the three files from `deploy/nginx/` into `/etc/nginx/snippets/`, then
include the shared locations once inside the HTTPS `server` block:

```nginx
include /etc/nginx/snippets/admin-auth-gateway.locations.conf;
```

## 2. Protect invoice-submit

Add a more-specific admin API location before the existing `/api/` location.
Keep `/api/submissions` public.

```nginx
location ^~ /api/admin/ {
  include /etc/nginx/snippets/admin-auth-invoice.inc;
  error_page 401 = /admin-auth/api/unauthorized;

  proxy_pass http://127.0.0.1:8787;
  proxy_http_version 1.1;
  proxy_set_header Host $host;
  proxy_set_header X-Real-IP $remote_addr;
  proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
  proxy_set_header X-Forwarded-Proto $scheme;
}
```

Inside both exact `/invoice` page locations add:

```nginx
include /etc/nginx/snippets/admin-auth-invoice.inc;
error_page 401 = @admin_login_redirect;
```

## 3. Protect employee-information

Add these locations before the existing broad `^~ /employee/` location:

```nginx
location = /employee/portal {
  include /etc/nginx/snippets/admin-auth-invoice.inc;
  error_page 401 = @admin_login_redirect;
  proxy_pass http://127.0.0.1:8789/employee/portal;
  proxy_http_version 1.1;
  proxy_set_header Host $host;
  proxy_set_header X-Real-IP $remote_addr;
  proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
  proxy_set_header X-Forwarded-Proto $scheme;
}

location = /employee/portal/ {
  include /etc/nginx/snippets/admin-auth-invoice.inc;
  error_page 401 = @admin_login_redirect;
  proxy_pass http://127.0.0.1:8789/employee/portal/;
  proxy_http_version 1.1;
  proxy_set_header Host $host;
  proxy_set_header X-Real-IP $remote_addr;
  proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
  proxy_set_header X-Forwarded-Proto $scheme;
}

location ^~ /employee/api/admin/ {
  include /etc/nginx/snippets/admin-auth-invoice.inc;
  error_page 401 = /admin-auth/api/unauthorized;
  proxy_pass http://127.0.0.1:8789;
  proxy_http_version 1.1;
  proxy_set_header Host $host;
  proxy_set_header X-Real-IP $remote_addr;
  proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
  proxy_set_header X-Forwarded-Proto $scheme;
  proxy_read_timeout 120s;
  proxy_send_timeout 120s;
}
```

The public `/employee/fuzzy`, `/employee/fuzzy_qz`, `/employee/peanut`, upload,
asset, and health routes continue through the existing broad location.

## 4. Protect reimbursement admin

Inside the exact `/reimbursement` and `/reimbursement/` page locations add:

```nginx
include /etc/nginx/snippets/admin-auth-reimbursement.inc;
error_page 401 = @admin_login_redirect;
```

Inside `location ^~ /reimbursement/api/` add:

```nginx
include /etc/nginx/snippets/admin-auth-reimbursement.inc;
error_page 401 = /admin-auth/api/unauthorized;
```

Keep the existing exact `/reimbursement/api/shortcut/reports` location before
the protected prefix location. It must continue to use its Bearer token without
an admin session.

## 5. Validate before reload

```bash
nginx -t
systemctl is-active admin-auth-gateway.service
curl --fail http://127.0.0.1:8790/healthz
```

After reloading nginx, verify all public routes, redirects, admin logins, guest
read-only enforcement, mutations, attachments, and the shortcut Bearer endpoint.
The durable integration must also be copied into the owning repositories'
Nginx templates so later deployments cannot erase it.
