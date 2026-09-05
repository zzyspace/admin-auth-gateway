import path from "node:path";

const DEFAULT_SESSION_TTL_SECONDS = 30 * 24 * 60 * 60;
const REIMBURSEMENT_ACCOUNT_ROLES = new Set(["partner", "manager"]);
const REIMBURSEMENT_MANAGER_STORES = new Set(["fuzzy", "peanut", "fuzzyqz"]);

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

function configuredAccount({ accountId, username, password, role, label, managerStores = [], trim = false }) {
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
    accountId,
    username: normalizedUsername,
    password: normalizedPassword,
    role,
    managerStores,
  };
}

function parseReimbursementAccounts(value) {
  const raw = optionalTrimmed(value);
  if (!raw) return [];

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(`WECHATY_REIMBURSEMENT_ACCOUNTS_JSON must be valid JSON: ${error.message}`);
  }
  if (!Array.isArray(parsed)) {
    throw new Error("WECHATY_REIMBURSEMENT_ACCOUNTS_JSON must be a JSON array.");
  }

  const accounts = parsed.map((item, index) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      throw new Error(`Reimbursement account ${index + 1} must be an object.`);
    }
    const accountId = optionalTrimmed(item.accountId);
    const username = optionalTrimmed(item.username);
    const password = optionalTrimmed(item.password);
    const role = optionalTrimmed(item.role);
    if (!accountId || !username || !password || !role) {
      throw new Error(`Reimbursement account ${index + 1} requires accountId, username, password, and role.`);
    }
    if (!REIMBURSEMENT_ACCOUNT_ROLES.has(role)) {
      throw new Error(`Reimbursement account ${accountId} has unsupported role: ${role}.`);
    }

    const rawStores = item.managerStores ?? [];
    if (!Array.isArray(rawStores)) {
      throw new Error(`Reimbursement account ${accountId} managerStores must be an array.`);
    }
    const managerStores = [...new Set(rawStores.map((store) => optionalTrimmed(store)))];
    if (managerStores.some((store) => !store || !REIMBURSEMENT_MANAGER_STORES.has(store))) {
      throw new Error(`Reimbursement account ${accountId} has an unsupported manager store.`);
    }
    if (role === "manager" && managerStores.length === 0) {
      throw new Error(`Reimbursement manager account ${accountId} requires at least one manager store.`);
    }
    if (role !== "manager" && managerStores.length > 0) {
      throw new Error(`Reimbursement partner account ${accountId} cannot configure managerStores.`);
    }

    return configuredAccount({
      accountId,
      username,
      password,
      role,
      label: `Reimbursement account ${accountId}`,
      managerStores: managerStores.sort(),
      trim: true,
    });
  });

  const accountIds = new Set();
  const usernames = new Set();
  for (const account of accounts) {
    if (accountIds.has(account.accountId)) {
      throw new Error(`Duplicate reimbursement accountId: ${account.accountId}.`);
    }
    if (usernames.has(account.username)) {
      throw new Error(`Duplicate reimbursement username: ${account.username}.`);
    }
    accountIds.add(account.accountId);
    usernames.add(account.username);
  }
  return accounts;
}

export function loadConfig(env = process.env) {
  const authMode = env.ADMIN_AUTH_MODE ?? "legacy";
  if (!["legacy", "unified"].includes(authMode)) throw new Error("Invalid ADMIN_AUTH_MODE.");
  const host = optionalTrimmed(env.ADMIN_AUTH_HOST) ?? "127.0.0.1";
  const internalToken = env.ADMIN_AUTH_INTERNAL_TOKEN ?? "";
  if (authMode === "unified" && (!/^[A-Za-z0-9_-]{32,256}$/.test(internalToken) || !["127.0.0.1", "::1"].includes(host))) {
    throw new Error("Unified mode requires a loopback host and a 32-256 character internal token.");
  }
  const legacyEnv = authMode === "legacy" ? env : {};
  const invoiceAdmin = configuredAccount({
    accountId: "invoice-admin",
    username: legacyEnv.INVOICE_ADMIN_USERNAME,
    password: legacyEnv.INVOICE_ADMIN_PASSWORD,
    role: "admin",
    label: "Invoice admin",
    trim: false,
  });
  const reimbursementAdmin = configuredAccount({
    accountId: "reimbursement-admin",
    username: legacyEnv.WECHATY_ADMIN_USERNAME,
    password: legacyEnv.WECHATY_ADMIN_PASSWORD,
    role: "admin",
    label: "Reimbursement admin",
    trim: true,
  });
  const reimbursementAccounts = parseReimbursementAccounts(
    legacyEnv.WECHATY_REIMBURSEMENT_ACCOUNTS_JSON,
  );

  if (authMode === "legacy" && !invoiceAdmin) {
    throw new Error("INVOICE_ADMIN_USERNAME and INVOICE_ADMIN_PASSWORD are required.");
  }
  if (authMode === "legacy" && !reimbursementAdmin) {
    throw new Error("WECHATY_ADMIN_USERNAME and WECHATY_ADMIN_PASSWORD are required.");
  }
  if (reimbursementAccounts.some((account) => account.username === reimbursementAdmin.username)) {
    throw new Error("Reimbursement account usernames must differ from WECHATY_ADMIN_USERNAME.");
  }
  if (reimbursementAccounts.some((account) => account.accountId === reimbursementAdmin.accountId)) {
    throw new Error(`Duplicate reimbursement accountId: ${reimbursementAdmin.accountId}.`);
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
    host,
    authMode,
    managementAccountIds: (env.ADMIN_AUTH_MANAGEMENT_ACCOUNT_IDS ?? "").split(",").map((id) => id.trim()).filter(Boolean),
    internalToken,
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
      invoice: invoiceAdmin ? [invoiceAdmin] : [],
      reimbursement: [reimbursementAdmin, ...reimbursementAccounts].filter(Boolean),
    },
  };
}
