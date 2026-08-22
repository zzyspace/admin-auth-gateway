import express from "express";

import { renderLoginPage, sanitizeReturnTo, scopeForReturnTo } from "./login-page.js";
import { createLoginRateLimiter } from "./rate-limit.js";
import {
  basicAuthorization,
  expectedOrigin,
  isSafeMethod,
  parseCookies,
  randomToken,
  secureEqual,
} from "./security.js";
import { createSessionService } from "./session-service.js";

const LOGIN_CSRF_COOKIE = "admin_login_csrf";
const INTERNAL_SCOPES = new Set(["invoice", "reimbursement"]);

function sessionCookieOptions(config) {
  return {
    httpOnly: true,
    secure: config.cookie.secure,
    sameSite: "lax",
    path: "/",
    maxAge: config.cookie.maxAgeSeconds * 1000,
  };
}

function sessionCookieClearOptions(config) {
  return {
    httpOnly: true,
    secure: config.cookie.secure,
    sameSite: "lax",
    path: "/",
  };
}

function csrfCookieOptions(config) {
  return {
    httpOnly: true,
    secure: config.cookie.secure,
    sameSite: "strict",
    path: "/admin-login",
    maxAge: 10 * 60 * 1000,
  };
}

function csrfCookieClearOptions(config) {
  return {
    httpOnly: true,
    secure: config.cookie.secure,
    sameSite: "strict",
    path: "/admin-login",
  };
}

function requestSessionToken(request, config) {
  return parseCookies(request.headers.cookie).get(config.cookie.name);
}

function noStore(_request, response, next) {
  response.set("Cache-Control", "no-store");
  response.set("X-Content-Type-Options", "nosniff");
  response.set("Referrer-Policy", "same-origin");
  response.set("X-Frame-Options", "DENY");
  response.set(
    "Content-Security-Policy",
    "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
  );
  response.set("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
  next();
}

function sameOriginMutation(request) {
  const method = request.get("X-Original-Method") ?? request.method;
  if (isSafeMethod(method)) return true;

  const host = request.get("X-Original-Host") ?? request.get("Host");
  const proto = request.get("X-Original-Proto") ?? request.protocol;
  const origin = request.get("X-Original-Origin") ?? request.get("Origin");
  const expected = expectedOrigin({ host, proto });
  return Boolean(origin && expected && secureEqual(origin, expected));
}

export function createApp({ config, database, now = Date.now }) {
  const app = express();
  const sessions = createSessionService({ config, database, now });
  const limiter = createLoginRateLimiter({ ...config.loginRateLimit, now });
  const sessionDays = Math.ceil(config.cookie.maxAgeSeconds / (24 * 60 * 60));

  app.disable("x-powered-by");
  app.set("trust proxy", "loopback");
  app.use(noStore);

  app.get("/healthz", (_request, response) => {
    response.status(200).json({ ok: true });
  });

  app.get("/admin-login", (request, response) => {
    const returnTo = sanitizeReturnTo(request.query.returnTo);
    const existing = sessions.resolve(
      requestSessionToken(request, config),
      scopeForReturnTo(returnTo),
    );
    if (existing) {
      response.redirect(303, returnTo);
      return;
    }

    const csrfToken = randomToken();
    response.cookie(LOGIN_CSRF_COOKIE, csrfToken, csrfCookieOptions(config));
    response.status(200).type("html").send(renderLoginPage({ csrfToken, returnTo, sessionDays }));
  });

  app.post(
    "/admin-login",
    express.urlencoded({ extended: false, limit: "8kb" }),
    (request, response) => {
      const returnTo = sanitizeReturnTo(request.body.returnTo);
      const requiredScope = scopeForReturnTo(returnTo);
      const cookies = parseCookies(request.headers.cookie);
      const suppliedCsrf = typeof request.body.csrfToken === "string" ? request.body.csrfToken : "";
      const cookieCsrf = cookies.get(LOGIN_CSRF_COOKIE) ?? "";

      if (!suppliedCsrf || !cookieCsrf || !secureEqual(suppliedCsrf, cookieCsrf)) {
        response.status(403).type("text/plain").send("登录页面已失效，请返回后重新打开登录页。");
        return;
      }

      response.clearCookie(LOGIN_CSRF_COOKIE, csrfCookieClearOptions(config));
      const rateLimitKey = request.ip || request.socket.remoteAddress || "unknown";
      if (limiter.isLimited(rateLimitKey)) {
        const csrfToken = randomToken();
        response.cookie(LOGIN_CSRF_COOKIE, csrfToken, csrfCookieOptions(config));
        response.set("Retry-After", String(config.loginRateLimit.windowSeconds));
        response.status(429).type("html").send(renderLoginPage({
          csrfToken,
          returnTo,
          sessionDays,
          error: "登录尝试次数过多，请稍后再试。",
        }));
        return;
      }

      const username = typeof request.body.username === "string" ? request.body.username : "";
      const password = typeof request.body.password === "string" ? request.body.password : "";
      const matches = sessions.authenticate(username, password);

      if (!matches.some(({ scope }) => scope === requiredScope)) {
        limiter.recordFailure(rateLimitKey);
        const csrfToken = randomToken();
        response.cookie(LOGIN_CSRF_COOKIE, csrfToken, csrfCookieOptions(config));
        response.status(401).type("html").send(renderLoginPage({
          csrfToken,
          returnTo,
          sessionDays,
          error: "账号或密码不正确。",
        }));
        return;
      }

      limiter.clear(rateLimitKey);
      sessions.destroy(requestSessionToken(request, config));
      const session = sessions.create(matches);
      response.cookie(config.cookie.name, session.token, sessionCookieOptions(config));
      response.redirect(303, returnTo);
    },
  );

  app.post(
    "/admin-logout",
    express.urlencoded({ extended: false, limit: "2kb" }),
    (request, response) => {
      if (!sameOriginMutation(request)) {
        response.status(403).type("text/plain").send("退出请求来源无效。");
        return;
      }
      const returnTo = sanitizeReturnTo(request.body.returnTo);
      sessions.destroy(requestSessionToken(request, config));
      response.clearCookie(config.cookie.name, sessionCookieClearOptions(config));
      response.redirect(303, `/admin-login?returnTo=${encodeURIComponent(returnTo)}`);
    },
  );

  app.get("/admin-auth/api/session", (request, response) => {
    const token = requestSessionToken(request, config);
    const scopes = {};
    for (const scope of INTERNAL_SCOPES) {
      const resolved = sessions.resolve(token, scope);
      if (resolved) {
        scopes[scope] = {
          accountId: resolved.account.accountId,
          username: resolved.account.username,
          role: resolved.account.role,
          managerStores: resolved.account.managerStores,
        };
      }
    }
    if (Object.keys(scopes).length === 0) {
      response.status(401).json({ success: false, error: { message: "登录已失效。" } });
      return;
    }
    response.status(200).json({ success: true, scopes });
  });

  app.all("/admin-auth/api/unauthorized", (_request, response) => {
    response.status(401).json({ success: false, error: { message: "需要登录。" } });
  });

  app.get("/internal/verify/:scope", (request, response) => {
    const scope = request.params.scope;
    if (!INTERNAL_SCOPES.has(scope)) {
      response.sendStatus(404);
      return;
    }
    if (!sameOriginMutation(request)) {
      response.status(403).json({ success: false, error: { message: "请求来源无效。" } });
      return;
    }

    const resolved = sessions.resolve(requestSessionToken(request, config), scope);
    if (!resolved) {
      response.status(401).json({ success: false, error: { message: "需要登录。" } });
      return;
    }

    response.set("X-Admin-Authorization", basicAuthorization(
      resolved.account.username,
      resolved.account.password,
    ));
    response.set("X-Admin-Username", resolved.account.username);
    response.set("X-Admin-Role", resolved.account.role);
    response.set("X-Admin-Account-Id", resolved.account.accountId);
    response.set("X-Admin-Manager-Stores", resolved.account.managerStores.join(","));
    response.sendStatus(204);
  });

  app.use((_request, response) => {
    response.status(404).json({ success: false, error: { message: "Not found." } });
  });

  return { app, sessions };
}
