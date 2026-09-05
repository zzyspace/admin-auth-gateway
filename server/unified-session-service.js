import { hashToken, randomToken } from "./security.js";
import { APPLICATIONS } from "./account-store.js";

// Unified mode uses per-account and per-app versions on every resolution.
export function createUnifiedSessionService({ accounts, database, ttlSeconds, managementAccountIds = [], now = Date.now }) {
  if (!Number.isSafeInteger(ttlSeconds) || ttlSeconds < 1) throw new Error("invalid-session-ttl");
  function resolve(token, app) {
    if (!token || ![...APPLICATIONS, "accounts"].includes(app)) return null;
    const tokenHash = hashToken(token);
    const session = database.find(tokenHash);
    if (!session) return null;
    if (session.expiresAt <= now()) {
      database.delete(tokenHash);
      return null;
    }
    const identity = session.scopes?.unified;
    if (!identity || identity.schema !== 1) return null;
    const managementAccount = app === "accounts" && managementAccountIds.includes(identity.accountId) ? accounts.getAccount(identity.accountId) : null;
    const authorization = app === "accounts" ? (managementAccount?.enabled ? { account: managementAccount, access: { app: "accounts", version: 1 } } : null) : accounts.getAuthorization(identity.accountId, app);
    if (!authorization || authorization.account.version !== identity.accountVersion ||
        authorization.access.version !== identity.accessVersions?.[app]) return null;
    database.touch(tokenHash, now());
    return authorization;
  }
  function authenticate(username, password) {
    const account = accounts.authenticate(username, password);
    if (!account) return [];
    const matches = accounts.listAccess(account.accountId).filter((entry) => entry.enabled)
      .map((access) => ({ scope: access.app, account, access }));
    if (managementAccountIds.includes(account.accountId)) matches.push({ scope: "accounts", account, access: { app: "accounts", version: 1 } });
    return matches;
  }
  function create(matches) {
    if (!matches.length) return null;
    const account = matches[0].account;
    const token = randomToken();
    const timestamp = now();
    database.create({
      tokenHash: hashToken(token),
      scopes: { unified: {
        schema: 1, accountId: account.accountId, accountVersion: account.version,
        accessVersions: Object.fromEntries(matches.map(({ access }) => [access.app, access.version])),
      } },
      now: timestamp, expiresAt: timestamp + ttlSeconds * 1000,
    });
    return { token, account, apps: matches.map(({ scope }) => scope) };
  }
  return {
    authenticate,
    create,
    login(username, password) { return create(authenticate(username, password)); },
    resolve,
    destroy(token) {
      if (token) database.delete(hashToken(token));
    },
    cleanup() { return database.deleteExpired(now()); },
  };
}
