// Tiny in-memory cache that lives as long as a warm Forge runtime (or a test process).
// Concurrent callers share one in-flight promise, so a burst of screens downloads a list once.
const store = new Map();

export function cached(key, ttlMs, loader) {
  const hit = store.get(key);
  const now = Date.now();
  if (hit && now - hit.at < ttlMs) return hit.promise;
  const promise = loader().catch(err => { store.delete(key); throw err; });
  store.set(key, { at: now, promise });
  return promise;
}

export function clearCache() { store.clear(); }
