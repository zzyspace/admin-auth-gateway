import fs from "node:fs";
import path from "node:path";

import Database from "better-sqlite3";

export function createSessionDatabase({ stateDir, filename = "sessions.db" }) {
  fs.mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  const database = new Database(path.join(stateDir, filename));
  database.pragma("journal_mode = WAL");
  database.pragma("foreign_keys = ON");
  database.exec(`
    CREATE TABLE IF NOT EXISTS admin_sessions (
      token_hash TEXT PRIMARY KEY,
      scopes_json TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      last_seen_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_admin_sessions_expires_at
      ON admin_sessions (expires_at);
  `);

  const insert = database.prepare(`
    INSERT INTO admin_sessions (
      token_hash, scopes_json, created_at, last_seen_at, expires_at
    ) VALUES (
      @tokenHash, @scopesJson, @createdAt, @lastSeenAt, @expiresAt
    )
  `);
  const find = database.prepare(`
    SELECT token_hash, scopes_json, created_at, last_seen_at, expires_at
    FROM admin_sessions
    WHERE token_hash = ?
  `);
  const touch = database.prepare(`
    UPDATE admin_sessions SET last_seen_at = ? WHERE token_hash = ?
  `);
  const remove = database.prepare("DELETE FROM admin_sessions WHERE token_hash = ?");
  const removeExpired = database.prepare("DELETE FROM admin_sessions WHERE expires_at <= ?");

  return {
    create({ tokenHash, scopes, now, expiresAt }) {
      insert.run({
        tokenHash,
        scopesJson: JSON.stringify(scopes),
        createdAt: now,
        lastSeenAt: now,
        expiresAt,
      });
    },
    find(tokenHash) {
      const row = find.get(tokenHash);
      if (!row) return null;
      try {
        return {
          tokenHash: row.token_hash,
          scopes: JSON.parse(row.scopes_json),
          createdAt: row.created_at,
          lastSeenAt: row.last_seen_at,
          expiresAt: row.expires_at,
        };
      } catch {
        remove.run(tokenHash);
        return null;
      }
    },
    touch(tokenHash, now) {
      touch.run(now, tokenHash);
    },
    delete(tokenHash) {
      remove.run(tokenHash);
    },
    deleteExpired(now) {
      return removeExpired.run(now).changes;
    },
    close() {
      database.close();
    },
  };
}
