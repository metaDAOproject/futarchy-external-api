/**
 * Bounded in-memory cache with a per-read TTL and per-key single-flight.
 *
 * Several caches are keyed by caller-supplied values (mint addresses from
 * public requests), so an unbounded Map would grow for as long as the
 * process lives. Past `maxEntries`, the least recently written entry is
 * evicted; expired entries are dropped when read. `null` is a cacheable
 * value (e.g. "this mint has no launch"); only `undefined` means "miss".
 */
export class TtlCache {
  private entries = new Map<string, { value: unknown; storedAt: number }>();
  private inFlight = new Map<string, Promise<unknown>>();

  constructor(private readonly maxEntries: number) {}

  get<T>(key: string, ttlMs: number): T | undefined {
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    if (Date.now() - entry.storedAt >= ttlMs) {
      this.entries.delete(key);
      return undefined;
    }
    return entry.value as T;
  }

  set(key: string, value: unknown): void {
    this.entries.delete(key); // re-insert as the newest entry
    this.entries.set(key, { value, storedAt: Date.now() });
    if (this.entries.size > this.maxEntries) {
      this.entries.delete(this.entries.keys().next().value!);
    }
  }

  /**
   * The cached value if fresh; otherwise `load()` it once — concurrent callers
   * for the same key share the in-flight load — and cache the result. A
   * failed load is not cached and rejects every caller sharing it.
   */
  getOrLoad<T>(key: string, ttlMs: number, load: () => Promise<T>): Promise<T> {
    const cached = this.get<T>(key, ttlMs);
    if (cached !== undefined) return Promise.resolve(cached);

    let pending = this.inFlight.get(key) as Promise<T> | undefined;
    if (!pending) {
      pending = load()
        .then((value) => {
          this.set(key, value);
          return value;
        })
        .finally(() => this.inFlight.delete(key));
      this.inFlight.set(key, pending);
    }
    return pending;
  }

  get size(): number {
    return this.entries.size;
  }
}
