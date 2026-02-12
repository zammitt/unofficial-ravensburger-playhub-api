/**
 * In-memory TTL cache with optional max size (LRU eviction).
 * - Entries expire on access (get) and are pruned on set (cleanup-on-set).
 * - When maxSize is set, least-recently-used entries are evicted on set when at capacity.
 * This prevents unbounded growth from one-off keys that are never read again.
 */

export interface TtlCacheOptions {
  /** Max number of entries. When exceeded, LRU entries are evicted on set. Omit for unbounded (not recommended for long-lived caches). */
  maxSize?: number;
}

export interface TtlCache<T> {
  get: (key: string) => T | undefined;
  set: (key: string, value: T, ttlMs: number) => void;
}

export function createTtlCache<T>(options: TtlCacheOptions = {}): TtlCache<T> {
  const { maxSize = 0 } = options;
  const store = new Map<string, { value: T; expiresAt: number }>();

  function pruneExpired(): void {
    const now = Date.now();
    for (const [key, entry] of store.entries()) {
      if (now > entry.expiresAt) store.delete(key);
    }
  }

  function evictLru(): void {
    if (maxSize <= 0 || store.size < maxSize) return;
    const firstKey = store.keys().next().value;
    if (firstKey !== undefined) store.delete(firstKey);
  }

  return {
    get(key: string): T | undefined {
      const entry = store.get(key);
      if (!entry) return undefined;
      if (Date.now() > entry.expiresAt) {
        store.delete(key);
        return undefined;
      }
      if (maxSize > 0) {
        store.delete(key);
        store.set(key, entry);
      }
      return entry.value;
    },
    set(key: string, value: T, ttlMs: number): void {
      pruneExpired();
      const isNew = !store.has(key);
      if (isNew && maxSize > 0) {
        while (store.size >= maxSize) evictLru();
      }
      const entry = { value, expiresAt: Date.now() + ttlMs };
      if (maxSize > 0 && !isNew) {
        store.delete(key);
      }
      store.set(key, entry);
    },
  };
}
