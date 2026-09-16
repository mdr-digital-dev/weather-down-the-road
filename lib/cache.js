/**
 * Small in-memory cache: LRU eviction, per-entry TTL, and request coalescing
 * so that N concurrent identical requests result in one upstream call.
 */
export class Cache {
  constructor({ max = 2000, ttlMs = 60_000 } = {}) {
    this.max = max;
    this.ttlMs = ttlMs;
    this.map = new Map();      // key -> { value, expires }
    this.inflight = new Map(); // key -> Promise
  }

  get(key) {
    const hit = this.map.get(key);
    if (!hit) return undefined;
    if (hit.expires < Date.now()) {
      this.map.delete(key);
      return undefined;
    }
    // Refresh LRU order
    this.map.delete(key);
    this.map.set(key, hit);
    return hit.value;
  }

  set(key, value, ttlMs = this.ttlMs) {
    if (this.map.has(key)) this.map.delete(key);
    this.map.set(key, { value, expires: Date.now() + ttlMs });
    while (this.map.size > this.max) {
      const oldest = this.map.keys().next().value;
      this.map.delete(oldest);
    }
    return value;
  }

  /**
   * Get from cache or compute. Concurrent callers for the same key share one
   * in-flight promise. Failures are not cached.
   */
  async wrap(key, fn, ttlMs = this.ttlMs) {
    const cached = this.get(key);
    if (cached !== undefined) return cached;

    const pending = this.inflight.get(key);
    if (pending) return pending;

    const p = (async () => {
      try {
        const value = await fn();
        this.set(key, value, ttlMs);
        return value;
      } finally {
        this.inflight.delete(key);
      }
    })();
    this.inflight.set(key, p);
    return p;
  }

  clear() {
    this.map.clear();
    this.inflight.clear();
  }

  get size() {
    return this.map.size;
  }
}
