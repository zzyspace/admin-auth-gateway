import {
  credentialVersion,
  hashToken,
  randomToken,
  secureEqual,
} from "./security.js";

const SCOPES = new Set(["invoice", "reimbursement"]);

function accountsFor(config) {
  return [
    ["invoice", config.credentials.invoice.admin],
    ["reimbursement", config.credentials.reimbursement.admin],
    ["reimbursement", config.credentials.reimbursement.readonly],
  ].filter(([, account]) => account !== null);
}

function currentAccountForScope(config, scope, role, username) {
  const scopeConfig = config.credentials[scope];
  if (!scopeConfig) return null;
  return Object.values(scopeConfig).find(
    (account) => account?.role === role && account.username === username,
  ) ?? null;
}

export function createSessionService({ config, database, now = Date.now }) {
  function authenticate(username, password) {
    const matches = [];

    for (const [scope, account] of accountsFor(config)) {
      const usernameMatches = secureEqual(username, account.username);
      const passwordMatches = secureEqual(password, account.password);
      if (usernameMatches && passwordMatches) {
        matches.push({ scope, account });
      }
    }

    return matches;
  }

  function create(matches) {
    const token = randomToken();
    const scopes = {};

    for (const { scope, account } of matches) {
      const existing = scopes[scope];
      if (existing?.role === "admin") continue;
      scopes[scope] = {
        username: account.username,
        role: account.role,
        credentialVersion: credentialVersion(token, scope, account),
      };
    }

    const timestamp = now();
    database.create({
      tokenHash: hashToken(token),
      scopes,
      now: timestamp,
      expiresAt: timestamp + config.cookie.maxAgeSeconds * 1000,
    });

    return { token, scopes };
  }

  function resolve(token, requiredScope) {
    if (!token || !SCOPES.has(requiredScope)) return null;
    const tokenHash = hashToken(token);
    const session = database.find(tokenHash);
    if (!session) return null;

    const timestamp = now();
    if (session.expiresAt <= timestamp) {
      database.delete(tokenHash);
      return null;
    }

    const granted = session.scopes[requiredScope];
    if (!granted) return null;
    const currentAccount = currentAccountForScope(
      config,
      requiredScope,
      granted.role,
      granted.username,
    );
    if (!currentAccount) return null;

    const currentVersion = credentialVersion(token, requiredScope, currentAccount);
    if (!secureEqual(currentVersion, granted.credentialVersion)) return null;

    database.touch(tokenHash, timestamp);
    return {
      tokenHash,
      session,
      account: currentAccount,
      scope: requiredScope,
    };
  }

  function destroy(token) {
    if (token) database.delete(hashToken(token));
  }

  return {
    authenticate,
    create,
    resolve,
    destroy,
    cleanup() {
      return database.deleteExpired(now());
    },
  };
}
