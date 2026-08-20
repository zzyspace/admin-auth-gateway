import path from "node:path";

const DEFAULT_SESSION_TTL_SECONDS = 30 * 24 * 60 * 60;

function optionalTrimmed(value) {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function parseInteger(value, fallback, { min, max, name }) {
  if (value === undefined || value === "") {
    return fallback;
  }

  const parsed = Number.parseInt(value, 10);
  if (!Number.isSafeInteger(parsed) || parsed < min || parsed > max) {
    throw new Error(`${name} must be an integer between ${min} and ${max}.`);
  }

  return parsed;
}

function parseBoolean(value, fallback, name) {
  if (value === undefined || value === "") {
    return fallback;
  }

  if (value === "true") return true;
  if (value === "false") return false;
  throw new Error(`${name} must be true or false.`);
}

function configuredAccount({ username, password, role, label, trim = false }) {
  const normalizedUsername = typeof username === "string"
    ? (trim ? username.trim() : username)
    : undefined;
  const normalizedPassword = typeof password === "string"
    ? (trim ? password.trim() : password)
    : undefined;

  if (Boolean(normalizedUsername) !== Boolean(normalizedPassword)) {
    throw new Error(`${label} username and password must be configured together.`);
  }

  if (!normalizedUsername || !normalizedPassword) {
    return null;
  }

  return {
    username: normalizedUsername,
    password: normalizedPassword,
    role,
  };
}

export function loadConfig(env = process.env) {
  const invoiceAdmin = configuredAccount({
    username: env.INVOICE_ADMIN_USERNAME,
    password: env.INVOICE_ADMIN_PASSWORD,
    role: "admin",
    label: "Invoice admin",
    trim: false,
  });
  const reimbursementAdmin = configuredAccount({
    username: env.WECHATY_ADMIN_USERNAME,
    password: env.WECHATY_ADMIN_PASSWORD,
    role: "admin",
    label: "Reimbursement admin",
    trim: true,
  });
  const reimbursementGuest = configuredAccount({
    username: env.WECHATY_ADMIN_GUEST_USERNAME,
    password: env.WECHATY_ADMIN_GUEST_PASSWORD,
    role: "readonly",
    label: "Reimbursement guest",
    trim: true,
  });

  if (!invoiceAdmin) {
    throw new Error("INVOICE_ADMIN_USERNAME and INVOICE_ADMIN_PASSWORD are required.");
  }
  if (!reimbursementAdmin) {
    throw new Error("WECHATY_ADMIN_USERNAME and WECHATY_ADMIN_PASSWORD are required.");
  }
  if (reimbursementGuest?.username === reimbursementAdmin.username) {
    throw new Error("Reimbursement guest username must differ from the admin username.");
  }

  const cookieSecure = parseBoolean(
    env.ADMIN_AUTH_COOKIE_SECURE,
    true,
    "ADMIN_AUTH_COOKIE_SECURE",
  );
  const cookieName = optionalTrimmed(env.ADMIN_AUTH_COOKIE_NAME) ??
    (cookieSecure ? "__Host-admin_session" : "admin_session");

  if (cookieSecure && !cookieName.startsWith("__Host-")) {
    throw new Error("Secure production cookie names must use the __Host- prefix.");
  }
  if (!cookieSecure && cookieName.startsWith("__Host-")) {
    throw new Error("__Host- cookies require ADMIN_AUTH_COOKIE_SECURE=true and HTTPS.");
  }

  return {
    host: optionalTrimmed(env.ADMIN_AUTH_HOST) ?? "127.0.0.1",
    port: parseInteger(env.ADMIN_AUTH_PORT, 8790, {
      min: 1,
      max: 65535,
      name: "ADMIN_AUTH_PORT",
    }),
    stateDir: path.resolve(optionalTrimmed(env.ADMIN_AUTH_STATE_DIR) ?? "./data"),
    cookie: {
      name: cookieName,
      secure: cookieSecure,
      maxAgeSeconds: parseInteger(
        env.ADMIN_AUTH_SESSION_TTL_SECONDS,
        DEFAULT_SESSION_TTL_SECONDS,
        { min: 300, max: 365 * 24 * 60 * 60, name: "ADMIN_AUTH_SESSION_TTL_SECONDS" },
      ),
    },
    loginRateLimit: {
      windowSeconds: parseInteger(env.ADMIN_AUTH_LOGIN_WINDOW_SECONDS, 600, {
        min: 10,
        max: 86400,
        name: "ADMIN_AUTH_LOGIN_WINDOW_SECONDS",
      }),
      maxAttempts: parseInteger(env.ADMIN_AUTH_LOGIN_MAX_ATTEMPTS, 5, {
        min: 1,
        max: 100,
        name: "ADMIN_AUTH_LOGIN_MAX_ATTEMPTS",
      }),
    },
    credentials: {
      invoice: {
        admin: invoiceAdmin,
      },
      reimbursement: {
        admin: reimbursementAdmin,
        readonly: reimbursementGuest,
      },
    },
  };
}
