// T-0665 — DNS analysis result TTL cache: tenant+domain keying, configurable
// TTL, expiry, and the getOrResolve wrapper around the analyser job.

import { describe, expect, it, vi } from "vitest";
import {
  DEFAULT_DNS_CACHE_TTL_MS,
  DnsResultCache,
} from "./dns-cache.js";

const TENANT_A = "tenant-a";
const TENANT_B = "tenant-b";
const DOMAIN = "contoso.com";

function withClock(ttlMs?: number) {
  let clock = 1_000_000;
  const cache = new DnsResultCache<string>({ ttlMs, now: () => clock });
  return {
    cache,
    advance(ms: number) {
      clock += ms;
    },
  };
}

describe("DnsResultCache (T-0665)", () => {
  it("defaults to a one hour TTL", () => {
    const cache = new DnsResultCache<string>();
    expect(cache.ttlMs).toBe(DEFAULT_DNS_CACHE_TTL_MS);
    expect(DEFAULT_DNS_CACHE_TTL_MS).toBe(60 * 60 * 1000);
  });

  it("rejects a negative or non-finite TTL", () => {
    expect(() => new DnsResultCache({ ttlMs: -1 })).toThrow(RangeError);
    expect(() => new DnsResultCache({ ttlMs: Number.POSITIVE_INFINITY })).toThrow(RangeError);
  });

  it("stores and serves a value inside the TTL", () => {
    const { cache } = withClock(1000);
    cache.set(TENANT_A, DOMAIN, "result");
    expect(cache.get(TENANT_A, DOMAIN)).toBe("result");
  });

  it("expires the entry once the TTL elapses", () => {
    const { cache, advance } = withClock(1000);
    cache.set(TENANT_A, DOMAIN, "result");
    advance(999);
    expect(cache.get(TENANT_A, DOMAIN)).toBe("result");
    advance(1);
    expect(cache.get(TENANT_A, DOMAIN)).toBeUndefined();
  });

  it("is configurable per instance", () => {
    const { cache, advance } = withClock(5);
    cache.set(TENANT_A, DOMAIN, "result");
    advance(6);
    expect(cache.get(TENANT_A, DOMAIN)).toBeUndefined();
  });

  it("keys by tenant and by domain", () => {
    const { cache } = withClock(1000);
    cache.set(TENANT_A, DOMAIN, "a");
    expect(cache.get(TENANT_B, DOMAIN)).toBeUndefined();
    expect(cache.get(TENANT_A, "fabrikam.com")).toBeUndefined();
  });

  it("treats domains case-insensitively", () => {
    const { cache } = withClock(1000);
    cache.set(TENANT_A, "Contoso.COM", "result");
    expect(cache.get(TENANT_A, "contoso.com")).toBe("result");
  });

  it("supports delete and clear", () => {
    const { cache } = withClock(1000);
    cache.set(TENANT_A, DOMAIN, "a");
    cache.set(TENANT_B, DOMAIN, "b");
    expect(cache.delete(TENANT_A, DOMAIN)).toBe(true);
    expect(cache.get(TENANT_A, DOMAIN)).toBeUndefined();
    cache.clear();
    expect(cache.get(TENANT_B, DOMAIN)).toBeUndefined();
  });
});

describe("DnsResultCache.getOrResolve (T-0665)", () => {
  it("resolves once inside the TTL and serves the cached value", async () => {
    const { cache } = withClock(1000);
    const resolve = vi.fn(async () => "resolved");

    const first = await cache.getOrResolve(TENANT_A, DOMAIN, resolve);
    const second = await cache.getOrResolve(TENANT_A, DOMAIN, resolve);

    expect(first).toEqual({ value: "resolved", cached: false });
    expect(second).toEqual({ value: "resolved", cached: true });
    expect(resolve).toHaveBeenCalledTimes(1);
  });

  it("re-resolves after the TTL expires", async () => {
    const { cache, advance } = withClock(1000);
    const resolve = vi.fn(async () => "resolved");

    await cache.getOrResolve(TENANT_A, DOMAIN, resolve);
    advance(1001);
    const second = await cache.getOrResolve(TENANT_A, DOMAIN, resolve);

    expect(second.cached).toBe(false);
    expect(resolve).toHaveBeenCalledTimes(2);
  });

  it("does not cache when the resolver rejects", async () => {
    const { cache } = withClock(1000);
    const resolve = vi.fn(async () => {
      throw new Error("boom");
    });

    await expect(cache.getOrResolve(TENANT_A, DOMAIN, resolve)).rejects.toThrow("boom");
    expect(cache.get(TENANT_A, DOMAIN)).toBeUndefined();
  });
});
