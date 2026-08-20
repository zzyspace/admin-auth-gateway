import crypto from "node:crypto";

export function secureEqual(left, right) {
  const leftDigest = crypto.createHash("sha256").update(String(left), "utf8").digest();
  const rightDigest = crypto.createHash("sha256").update(String(right), "utf8").digest();
  return crypto.timingSafeEqual(leftDigest, rightDigest);
}

export function randomToken(bytes = 32) {
  return crypto.randomBytes(bytes).toString("base64url");
}

export function hashToken(token) {
  return crypto.createHash("sha256").update(token, "utf8").digest("hex");
}

export function credentialVersion(token, scope, account) {
  return crypto
    .createHmac("sha256", token)
    .update(`${scope}\0${account.role}\0${account.username}\0${account.password}`, "utf8")
    .digest("hex");
}

export function parseCookies(header) {
  const cookies = new Map();
  if (typeof header !== "string") return cookies;

  for (const item of header.split(";")) {
    const separator = item.indexOf("=");
    if (separator < 1) continue;
    const name = item.slice(0, separator).trim();
    const value = item.slice(separator + 1).trim();
    try {
      cookies.set(name, decodeURIComponent(value));
    } catch {
      // Ignore malformed cookie values.
    }
  }
  return cookies;
}

export function basicAuthorization(username, password) {
  return `Basic ${Buffer.from(`${username}:${password}`, "utf8").toString("base64")}`;
}

export function isSafeMethod(method) {
  return new Set(["GET", "HEAD", "OPTIONS"]).has(String(method).toUpperCase());
}

export function expectedOrigin({ host, proto }) {
  if (!host || !proto || !["http", "https"].includes(proto)) return null;
  return `${proto}://${host}`;
}
