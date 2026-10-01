// DNS analysis result TTL cache (EPIC-034 SPEC.md §9, §11.3; T-0665).
//
// Repeat `Check DNS` calls inside the TTL window are served from cache instead
// of re-resolving, which also mitigates the SPEC §9 risk of egress and resolver
// rate limits. Entries are keyed by tenant + domain (domains are
// case-insensitive) and the TTL is configurable; the default is one hour.

export const DEFAULT_DNS_CACHE_TTL_MS = 60 * 60 * 1000;

export interface DnsResultCacheOptions {
  /** Entry lifetime in milliseconds. Defaults to one hour. */
  readonly ttlMs?: number;
  /** Monotonic millisecond clock; injectable so tests control expiry. */
  readonly now?: () => number;
}

export interface DnsCacheOutcome<T> {
  readonly value: T;
  readonly cached: boolean;
}

interface CacheEntry<T> {
  readonly value: T;
  readonly expiresAt: number;
}

function cacheKey(tenantId: string, domain: string): string {
  return `${tenantId}\u0000${domain.trim().toLowerCase()}`;
}

export class DnsResultCache<T = unknown> {
  readonly ttlMs: number;
  private readonly now: () => number;
  private readonly entries = new Map<string, CacheEntry<T>>();

  constructor(options: DnsResultCacheOptions = {}) {
    const ttlMs = options.ttlMs ?? DEFAULT_DNS_CACHE_TTL_MS;
    if (!Number.isFinite(ttlMs) || ttlMs < 0) {
      throw new RangeError("ttlMs must be a non-negative finite number");
    }
    this.ttlMs = ttlMs;
    this.now = options.now ?? Date.now;
  }

  get(tenantId: string, domain: string): T | undefined {
    const key = cacheKey(tenantId, domain);
    const entry = this.entries.get(key);
    if (entry === undefined) return undefined;
    if (entry.expiresAt <= this.now()) {
      this.entries.delete(key);
      return undefined;
    }
    return entry.value;
  }

  set(tenantId: string, domain: string, value: T): void {
    this.entries.set(cacheKey(tenantId, domain), {
      value,
      expiresAt: this.now() + this.ttlMs,
    });
  }

  delete(tenantId: string, domain: string): boolean {
    return this.entries.delete(cacheKey(tenantId, domain));
  }

  clear(): void {
    this.entries.clear();
  }

  /**
   * Serves a fresh cached value, otherwise awaits `resolve` and caches its
   * result. This is the seam that wraps the analyser job: the caller's
   * `resolve` runs the T-0664 analyser and persists the T-0661 DomainCheck, so
   * a cache hit skips both.
   */
  async getOrResolve(
    tenantId: string,
    domain: string,
    resolve: () => Promise<T>,
  ): Promise<DnsCacheOutcome<T>> {
    const cached = this.get(tenantId, domain);
    if (cached !== undefined) {
      return { value: cached, cached: true };
    }
    const value = await resolve();
    this.set(tenantId, domain, value);
    return { value, cached: false };
  }
}
