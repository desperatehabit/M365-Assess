// T-0665 — DNS check API: TTL cache on repeat check-dns, DomainCheck
// persistence on a miss, ordered tenant-scoped history, and the Tenant.Domains.Read
// gate. The T-0664 analyser and T-0661 repository are injected seams here.

import { describe, expect, it } from "vitest";
import type { DomainCheck, DomainCheckInput } from "@m365-assess/db";
import { DnsResultCache } from "../cache/dns-cache.js";
import { ALL_TENANTS, tenantScope } from "../rbac/scope.js";
import type { RequestContext } from "../server.js";
import {
  DOMAIN_CHECK_DNS_PATH,
  DOMAIN_HISTORY_PATH,
  DOMAINS_DNS_OPENAPI,
  DOMAINS_DNS_READ_PERMISSION,
  createDomainsDnsRoutes,
  type DnsAnalysisResult,
  type DnsAnalyser,
  type DomainCheckStore,
  type DomainDnsCheckResponse,
  type DomainDnsHistoryResponse,
} from "./domains-dns.js";

const TENANT_A = "tenant-a";
const TENANT_B = "tenant-b";
const DOMAIN = "contoso.com";

const RESULT: DnsAnalysisResult = {
  records: { mx: ["contoso-com.mail.protection.outlook.com"], spf: "v=spf1 -all" },
  health: { overall: "healthy" },
  recommendations: ["publish a DMARC reject policy"],
};

class FakeDnsAnalyser implements DnsAnalyser {
  calls: Array<{ tenantId: string; domain: string }> = [];

  async analyse(tenantId: string, domain: string): Promise<DnsAnalysisResult> {
    this.calls.push({ tenantId, domain });
    return RESULT;
  }
}

class FakeDomainCheckStore implements DomainCheckStore {
  readonly appends: DomainCheckInput[] = [];
  readonly historyCalls: Array<{ tenantId: string; domain: string }> = [];
  private readonly rows: DomainCheck[] = [];

  async appendDomainCheck(input: DomainCheckInput): Promise<DomainCheck> {
    this.appends.push(input);
    const row: DomainCheck = {
      id: input.id,
      tenantId: input.tenantId,
      domain: input.domain,
      at: input.at ?? "1970-01-01T00:00:00.000Z",
      records: input.records ?? {},
      health: input.health ?? {},
      recommendations: input.recommendations ?? [],
    };
    this.rows.push(row);
    return row;
  }

  async listDomainHistory(tenantId: string, domain: string): Promise<DomainCheck[]> {
    this.historyCalls.push({ tenantId, domain });
    return this.rows
      .filter((row) => row.tenantId === tenantId && row.domain === domain)
      .sort((a, b) => a.at.localeCompare(b.at) || a.id.localeCompare(b.id));
  }

  seed(row: DomainCheck): void {
    this.rows.push(row);
  }
}

function fixture(ttlMs = 60 * 60 * 1000) {
  let clock = Date.parse("2026-09-30T00:00:00.000Z");
  let idCounter = 0;
  const cache = new DnsResultCache<DomainCheck>({ ttlMs, now: () => clock });
  const analyser = new FakeDnsAnalyser();
  const store = new FakeDomainCheckStore();
  const routes = createDomainsDnsRoutes({
    analyser,
    cache,
    checks: store,
    resolveCaller: () => ({ roles: ["operator"], tenantScope: tenantScope([TENANT_A]), permissions: [DOMAINS_DNS_READ_PERMISSION] }),
    now: () => new Date(clock).toISOString(),
    idGenerator: () => `check-${++idCounter}`,
  });
  return {
    analyser,
    store,
    routes,
    advance(ms: number) {
      clock += ms;
    },
    route(method: string, path: string) {
      const route = routes.find((r) => r.method === method && r.path === path);
      if (!route) throw new Error(`route not found: ${method} ${path}`);
      return route;
    },
  };
}

function context(
  method: string,
  path: string,
  params: Record<string, string> = { tenantId: TENANT_A, domain: DOMAIN },
): RequestContext {
  return {
    correlationId: "corr-dns-1",
    method,
    path,
    query: new URLSearchParams(),
    headers: {},
    params,
  };
}

function check(
  id: string,
  at: string,
  domain = DOMAIN,
  tenantId = TENANT_A,
): DomainCheck {
  return { id, tenantId, domain, at, records: {}, health: {}, recommendations: [] };
}

describe("route surface (T-0665)", () => {
  it("exposes the check-dns and history operations", () => {
    const { routes } = fixture();
    expect(routes.map((r) => `${r.method} ${r.path}`).sort()).toEqual(
      [`POST ${DOMAIN_CHECK_DNS_PATH}`, `GET ${DOMAIN_HISTORY_PATH}`].sort(),
    );
  });

  it("publishes both operations with Tenant.Domains.Read", () => {
    expect(DOMAINS_DNS_OPENAPI.paths["/tenants/{tenantId}/domains/{domain}/check-dns"].post.permission).toBe(
      DOMAINS_DNS_READ_PERMISSION,
    );
    expect(DOMAINS_DNS_OPENAPI.paths["/tenants/{tenantId}/domains/{domain}/history"].get.permission).toBe(
      DOMAINS_DNS_READ_PERMISSION,
    );
    expect(DOMAINS_DNS_OPENAPI.paths["/tenants/{tenantId}/domains/{domain}/check-dns"].post.operationId).toBe(
      "checkDomainDns",
    );
    expect(DOMAINS_DNS_OPENAPI.paths["/tenants/{tenantId}/domains/{domain}/history"].get.operationId).toBe(
      "getDomainDnsHistory",
    );
  });
});

describe("POST check-dns (T-0665)", () => {
  it("resolves, persists, and caches on the first call", async () => {
    const { analyser, store, route } = fixture();

    const res = await route("POST", DOMAIN_CHECK_DNS_PATH).handler(context("POST", DOMAIN_CHECK_DNS_PATH));

    expect(res.status).toBe(200);
    const body = res.body as DomainDnsCheckResponse;
    expect(body.tenantId).toBe(TENANT_A);
    expect(body.domain).toBe(DOMAIN);
    expect(body.cached).toBe(false);
    expect(body.check.id).toBe("check-1");
    expect(body.check.records).toEqual(RESULT.records);
    expect(body.check.recommendations).toEqual(RESULT.recommendations);

    expect(analyser.calls).toEqual([{ tenantId: TENANT_A, domain: DOMAIN }]);
    expect(store.appends).toHaveLength(1);
    expect(store.appends[0]!.tenantId).toBe(TENANT_A);
  });

  it("serves the cached result without re-resolving inside the TTL", async () => {
    const { analyser, store, route, advance } = fixture();

    const first = await route("POST", DOMAIN_CHECK_DNS_PATH).handler(context("POST", DOMAIN_CHECK_DNS_PATH));
    advance(30 * 60 * 1000);
    const second = await route("POST", DOMAIN_CHECK_DNS_PATH).handler(context("POST", DOMAIN_CHECK_DNS_PATH));

    const firstBody = first.body as DomainDnsCheckResponse;
    const secondBody = second.body as DomainDnsCheckResponse;
    expect(secondBody.cached).toBe(true);
    expect(secondBody.check.id).toBe(firstBody.check.id);
    expect(analyser.calls).toHaveLength(1);
    expect(store.appends).toHaveLength(1);
  });

  it("re-resolves and appends a new check after the TTL expires", async () => {
    const { analyser, store, route, advance } = fixture(1000);

    const first = await route("POST", DOMAIN_CHECK_DNS_PATH).handler(context("POST", DOMAIN_CHECK_DNS_PATH));
    advance(1001);
    const second = await route("POST", DOMAIN_CHECK_DNS_PATH).handler(context("POST", DOMAIN_CHECK_DNS_PATH));

    const firstBody = first.body as DomainDnsCheckResponse;
    const secondBody = second.body as DomainDnsCheckResponse;
    expect(secondBody.cached).toBe(false);
    expect(secondBody.check.id).not.toBe(firstBody.check.id);
    expect(analyser.calls).toHaveLength(2);
    expect(store.appends).toHaveLength(2);
  });

  it("keeps the cache per tenant", async () => {
    const clock = Date.parse("2026-09-30T00:00:00.000Z");
    let idCounter = 0;
    const analyser = new FakeDnsAnalyser();
    const store = new FakeDomainCheckStore();
    const routes = createDomainsDnsRoutes({
      analyser,
      cache: new DnsResultCache<DomainCheck>({ now: () => clock }),
      checks: store,
      resolveCaller: () => ({
        roles: ["admin"],
        tenantScope: ALL_TENANTS,
        permissions: [DOMAINS_DNS_READ_PERMISSION],
      }),
      now: () => new Date(clock).toISOString(),
      idGenerator: () => `check-${++idCounter}`,
    });
    const route = routes.find((r) => r.method === "POST")!;

    await route.handler(context("POST", DOMAIN_CHECK_DNS_PATH, { tenantId: TENANT_A, domain: DOMAIN }));
    await route.handler(context("POST", DOMAIN_CHECK_DNS_PATH, { tenantId: TENANT_B, domain: DOMAIN }));
    const again = await route.handler(
      context("POST", DOMAIN_CHECK_DNS_PATH, { tenantId: TENANT_A, domain: DOMAIN }),
    );

    expect((again.body as DomainDnsCheckResponse).cached).toBe(true);
    expect(analyser.calls).toHaveLength(2);
    expect(store.appends).toHaveLength(2);
  });

  it("rejects an unauthenticated caller with 401", async () => {
    const { analyser } = fixture();
    const isolated = createDomainsDnsRoutes({
      analyser,
      cache: new DnsResultCache<DomainCheck>(),
      checks: new FakeDomainCheckStore(),
      resolveCaller: () => undefined,
    });
    await expect(isolated[0]!.handler(context("POST", DOMAIN_CHECK_DNS_PATH))).rejects.toMatchObject({
      status: 401,
    });
  });

  it("rejects a caller without Tenant.Domains.Read with 403", async () => {
    const { analyser } = fixture();
    const routes = createDomainsDnsRoutes({
      analyser,
      cache: new DnsResultCache<DomainCheck>(),
      checks: new FakeDomainCheckStore(),
      resolveCaller: () => ({
        roles: ["operator"],
        tenantScope: ALL_TENANTS,
        permissions: ["other.read"],
      }),
    });
    await expect(routes[0]!.handler(context("POST", DOMAIN_CHECK_DNS_PATH))).rejects.toMatchObject({
      status: 403,
    });
    expect(analyser.calls).toHaveLength(0);
  });

  it("rejects a tenant outside the caller scope with 403", async () => {
    const { analyser, store, route } = fixture();
    await expect(
      route("POST", DOMAIN_CHECK_DNS_PATH).handler(
        context("POST", DOMAIN_CHECK_DNS_PATH, { tenantId: TENANT_B, domain: DOMAIN }),
      ),
    ).rejects.toMatchObject({ status: 403 });
    expect(analyser.calls).toHaveLength(0);
    expect(store.appends).toHaveLength(0);
  });

  it("rejects a missing domain parameter with 400", async () => {
    const { route } = fixture();
    await expect(
      route("POST", DOMAIN_CHECK_DNS_PATH).handler(
        context("POST", DOMAIN_CHECK_DNS_PATH, { tenantId: TENANT_A, domain: "  " }),
      ),
    ).rejects.toMatchObject({ status: 400 });
  });
});

describe("GET history (T-0665)", () => {
  it("returns the domain's checks ordered by time", async () => {
    const { store, route } = fixture();
    store.seed(check("check-2", "2026-09-30T12:00:00.000Z"));
    store.seed(check("check-1", "2026-09-30T06:00:00.000Z"));
    store.seed(check("check-3", "2026-09-30T18:00:00.000Z"));

    const res = await route("GET", DOMAIN_HISTORY_PATH).handler(context("GET", DOMAIN_HISTORY_PATH));

    expect(res.status).toBe(200);
    const body = res.body as DomainDnsHistoryResponse;
    expect(body.tenantId).toBe(TENANT_A);
    expect(body.domain).toBe(DOMAIN);
    expect(body.items.map((row) => row.id)).toEqual(["check-1", "check-2", "check-3"]);
    expect(body.totalCount).toBe(3);
    expect(store.historyCalls).toEqual([{ tenantId: TENANT_A, domain: DOMAIN }]);
  });

  it("is tenant-scoped and excludes another domain's checks", async () => {
    const { store, route } = fixture();
    store.seed(check("check-a", "2026-09-30T06:00:00.000Z"));
    store.seed(check("check-b", "2026-09-30T07:00:00.000Z", DOMAIN, TENANT_B));
    store.seed(check("check-c", "2026-09-30T08:00:00.000Z", "fabrikam.com", TENANT_A));

    const res = await route("GET", DOMAIN_HISTORY_PATH).handler(context("GET", DOMAIN_HISTORY_PATH));

    const body = res.body as DomainDnsHistoryResponse;
    expect(body.items.map((row) => row.id)).toEqual(["check-a"]);
  });

  it("returns an empty history for a domain with no checks", async () => {
    const { route } = fixture();
    const res = await route("GET", DOMAIN_HISTORY_PATH).handler(context("GET", DOMAIN_HISTORY_PATH));
    expect(res.status).toBe(200);
    expect((res.body as DomainDnsHistoryResponse).items).toEqual([]);
  });

  it("rejects a tenant outside the caller scope without reading history", async () => {
    const { store, route } = fixture();
    await expect(
      route("GET", DOMAIN_HISTORY_PATH).handler(
        context("GET", DOMAIN_HISTORY_PATH, { tenantId: TENANT_B, domain: DOMAIN }),
      ),
    ).rejects.toMatchObject({ status: 403 });
    expect(store.historyCalls).toHaveLength(0);
  });
});
