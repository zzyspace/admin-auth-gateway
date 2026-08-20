export function createLoginRateLimiter({ windowSeconds, maxAttempts, now = Date.now }) {
  const attempts = new Map();
  const windowMs = windowSeconds * 1000;

  function prune(timestamp) {
    if (attempts.size < 10_000) return;
    for (const [key, entry] of attempts) {
      if (timestamp - entry.startedAt >= windowMs) attempts.delete(key);
    }
    while (attempts.size >= 10_000) {
      attempts.delete(attempts.keys().next().value);
    }
  }

  function currentEntry(key) {
    const timestamp = now();
    prune(timestamp);
    const existing = attempts.get(key);
    if (!existing || timestamp - existing.startedAt >= windowMs) {
      const fresh = { count: 0, startedAt: timestamp };
      attempts.set(key, fresh);
      return fresh;
    }
    return existing;
  }

  return {
    isLimited(key) {
      return currentEntry(key).count >= maxAttempts;
    },
    recordFailure(key) {
      currentEntry(key).count += 1;
    },
    clear(key) {
      attempts.delete(key);
    },
  };
}
