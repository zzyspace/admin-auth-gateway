# Nginx integration

Do not enable these changes on the current plain-HTTP port. First expose the
admin host over HTTPS and redirect HTTP to HTTPS. The production cookie is a
`Secure` `__Host-` cookie and is intentionally unusable over plain HTTP.

## 1. Install and include the gateway locations

Production routing is owned by `server-infra`. The files under `deploy/nginx/`
are compatibility references only. The shared locations are included once
inside the HTTPS `server` block:

```nginx
include /etc/nginx/snippets/admin-auth-gateway.locations.conf;
```

## 2. Protect invoice-submit

Add a more-specific admin API location before `/invoice/api/`.
Keep `/invoice/api/submissions` public.

```nginx
location ^~ /invoice/api/admin/ {
  include /etc/nginx/snippets/admin-auth-invoice.inc;
  error_page 401 = /auth/api/unauthorized;

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

Add these locations before the broad `^~ /staff/` location:

```nginx
location = /staff {
  include /etc/nginx/snippets/admin-auth-invoice.inc;
  error_page 401 = @admin_login_redirect;
  proxy_pass http://127.0.0.1:8789/staff;
  proxy_http_version 1.1;
  proxy_set_header Host $host;
  proxy_set_header X-Real-IP $remote_addr;
  proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
  proxy_set_header X-Forwarded-Proto $scheme;
}

location = /staff/ {
  include /etc/nginx/snippets/admin-auth-invoice.inc;
  error_page 401 = @admin_login_redirect;
  proxy_pass http://127.0.0.1:8789/staff/;
  proxy_http_version 1.1;
  proxy_set_header Host $host;
  proxy_set_header X-Real-IP $remote_addr;
  proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
  proxy_set_header X-Forwarded-Proto $scheme;
}

location ^~ /staff/api/admin/ {
  include /etc/nginx/snippets/admin-auth-invoice.inc;
  error_page 401 = /auth/api/unauthorized;
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

The public `/staff/fuzzy`, `/staff/fuzzy-qz`, `/staff/peanut`, upload,
asset, and health routes continue through the existing broad location.

## 4. Protect reimbursement admin

Inside the exact `/expense` and `/expense/` page locations add:

```nginx
include /etc/nginx/snippets/admin-auth-reimbursement.inc;
error_page 401 = @admin_login_redirect;
```

Inside `location ^~ /expense/api/` add:

```nginx
include /etc/nginx/snippets/admin-auth-reimbursement.inc;
error_page 401 = /auth/api/unauthorized;
```

Keep the existing exact `/expense/api/shortcut/reports` location before
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
The durable integration must be committed and published from `server-infra` so
later business-service deployments cannot erase it.
