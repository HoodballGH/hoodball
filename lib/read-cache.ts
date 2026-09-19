type Entry = { promise: Promise<unknown>; expiresAt: number };
export function createReadCache(capacity = 256, ttlMs = 3000, now: () => number = Date.now) {
  const entries = new Map<string, Entry>();
  return {
    get<T>(key: string, read: () => Promise<T>): Promise<T> {
      const existing = entries.get(key);
      if (existing && existing.expiresAt > now()) {
        entries.delete(key); entries.set(key, existing);
        return existing.promise as Promise<T>;
      }
      entries.delete(key);
      while (entries.size >= capacity) entries.delete(entries.keys().next().value!);
      const entry: Entry = { promise: Promise.resolve(), expiresAt: Infinity };
      entry.promise = Promise.resolve().then(read).then(value => {
        entry.expiresAt = now() + ttlMs;
        return value;
      }, error => {
        if (entries.get(key) === entry) entries.delete(key);
        throw error;
      });
      entries.set(key, entry);
      return entry.promise as Promise<T>;
    },
    invalidate(prefix = "") {
      for (const key of entries.keys()) if (key.startsWith(prefix)) entries.delete(key);
    },
  };
}
const globalCache = globalThis as typeof globalThis & { hoodballReadCache?: ReturnType<typeof createReadCache> };
export const publicReadCache = globalCache.hoodballReadCache ??= createReadCache();
