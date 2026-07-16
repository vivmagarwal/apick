/**
 * Small TTL cache for hot auth-path lookups (tenants, key grants, public
 * rules). Staleness is bounded by the TTL: same-instance mutations clear the
 * cache immediately; other replicas converge within the TTL (documented —
 * key revocation propagates cluster-wide in <= authCacheTtlMs).
 */
export class TtlCache<V> {
  #map = new Map<string, { value: V; expires: number }>();
  #ttlMs: number;
  #maxSize: number;

  constructor(ttlMs: number, maxSize = 5000) {
    this.#ttlMs = ttlMs;
    this.#maxSize = maxSize;
  }

  get enabled(): boolean {
    return this.#ttlMs > 0;
  }

  get(key: string): V | undefined {
    if (!this.enabled) return undefined;
    const entry = this.#map.get(key);
    if (!entry) return undefined;
    if (entry.expires < Date.now()) {
      this.#map.delete(key);
      return undefined;
    }
    return entry.value;
  }

  set(key: string, value: V): void {
    if (!this.enabled) return;
    if (this.#map.size >= this.#maxSize) {
      // drop the oldest entries (Map preserves insertion order)
      const drop = Math.max(1, Math.floor(this.#maxSize / 10));
      let i = 0;
      for (const k of this.#map.keys()) {
        this.#map.delete(k);
        if (++i >= drop) break;
      }
    }
    this.#map.set(key, { value, expires: Date.now() + this.#ttlMs });
  }

  delete(key: string): void {
    this.#map.delete(key);
  }

  clear(): void {
    this.#map.clear();
  }
}

/** The auth-path caches, owned by the app core and cleared on auth mutations. */
export interface AuthCaches {
  /** tenant slug/id -> tenant row */
  tenants: TtlCache<unknown>;
  /** 'public' -> public role rules */
  publicRules: TtlCache<unknown>;
  /** token hash -> key row + grants bundle */
  keys: TtlCache<unknown>;
  /** external id -> principal + grants bundle */
  externals: TtlCache<unknown>;
  clearAll(): void;
}

export function createAuthCaches(ttlMs: number): AuthCaches {
  const tenants = new TtlCache<unknown>(ttlMs);
  const publicRules = new TtlCache<unknown>(ttlMs);
  const keys = new TtlCache<unknown>(ttlMs);
  const externals = new TtlCache<unknown>(ttlMs);
  return {
    tenants,
    publicRules,
    keys,
    externals,
    clearAll: () => {
      tenants.clear();
      publicRules.clear();
      keys.clear();
      externals.clear();
    },
  };
}
