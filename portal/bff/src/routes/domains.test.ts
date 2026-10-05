import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import Database from "better-sqlite3";
import { AppError } from "../errors.js";
import { tenantScope } from "../rbac/scope.js";
import {
  DOMAINS_OPENAPI,
  DOMAINS_PATH,
  DOMAINS_READ_PERMISSION,
  createDomainsRoute,
  parseDomainsFilter,
  type DomainCheck,
  type DomainItem,
  type DomainsFilter,
  type DomainsPage,
  type DomainsProvider,
} from "./domains.js";

const TENANT = "tenant-test";

const SAMPLE_DOMAINS: readonly DomainItem[] = [
  {
    domain: "contoso.com",
    type: "verified",
    verification: "verified",
    dnsHealth: "healthy",
    services: "contoso-com.mail.protection.outlook.com",
    lastChecked: "2026-09-20T12:00:00Z",
  },
  {
    domain: "contoso.onmicrosoft.com",
    type: "initial",
    verification: "unverified",
    dnsHealth: null,
    services: null,
    lastChecked: null,
  },
  {
    domain: "fabrikam.com",
    type: "managed",
    verification: "verified",
    dnsHealth: "degraded",
    services: "fabrikam-com.mail.protection.outlook.com",
    lastChecked: "2026-09-19T08:30:00Z",
  },
];

const SAMPLE_CHECKS: readonly DomainCheck[] = [
  {
    id: "check-1",
    tenantId: TENANT,
    domain: "contoso.com",
    at: "2026-09-20T12:00:00Z",
    records: "{}",
    health: '{"overall":"healthy"}',
    recommendations: "[]",
  },
  {
    id: "check-2",
    tenantId: TENANT,
    domain: "fabrikam.com",
    at: "2026-09-19T08:30:00Z",
    records: "{}",
    health: '{"overall":"degraded"}',
    recommendations: "[]",
  },
];

class FakeDomainsProvider implements DomainsProvider {
  readonly calls: Array<{ tenantId: string; filter: DomainsFilter; latestChecks: readonly DomainCheck[] }> = [];

  async listDomains(tenantId: string, filter: DomainsFilter, latestChecks: readonly DomainCheck[]): Promise<DomainsPage> {
    this.calls.push({ tenantId, filter, latestChecks });
    return {
      tenantId,
      totalCount: SAMPLE_DOMAINS.length,
      items: SAMPLE_DOMAINS,
      nextCursor: null,
    };
  }
}

describe("Domains list route (T-0662)", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(":memory:");
    db.exec(`
      CREATE TABLE domain_checks (
        id TEXT PRIMARY KEY,
        tenantId TEXT NOT NULL,
        domain TEXT NOT NULL,
        "at" TEXT NOT NULL,
        records TEXT NOT NULL,
        health TEXT NOT NULL,
        recommendations TEXT NOT NULL
      );
    `);
  });

  afterEach(() => {
    db.close();
  });

  it("exposes GET /v1/tenants/:tenantId/domains", () => {
    const provider = new FakeDomainsProvider();
    const route = createDomainsRoute({
      provider,
      db,
      resolveCaller: () => ({
        tenantScope: tenantScope([TENANT]),
        permissions: [DOMAINS_READ_PERMISSION],
      }),
    });
    expect(route.method).toBe("GET");
    expect(route.path).toBe(DOMAINS_PATH);
  });

  it("rejects unauthenticated requests with 401", async () => {
    const provider = new FakeDomainsProvider();
    const route = createDomainsRoute({
      provider,
      db,
      resolveCaller: () => undefined,
    });

    await expect(
      route.handler({
        path: `/v1/tenants/${TENANT}/domains`,
        method: "GET",
        headers: {},
        params: { tenantId: TENANT },
        query: new URLSearchParams(),
      }),
    ).rejects.toThrow(AppError);
  });

  it("rejects missing Tenant.Domains.Read permission with 403", async () => {
    const provider = new FakeDomainsProvider();
    const route = createDomainsRoute({
      provider,
      db,
      resolveCaller: () => ({
        tenantScope: tenantScope([TENANT]),
        permissions: ["other.read"],
      }),
    });

    await expect(
      route.handler({
        path: `/v1/tenants/${TENANT}/domains`,
        method: "GET",
        headers: {},
        params: { tenantId: TENANT },
        query: new URLSearchParams(),
      }),
    ).rejects.toThrow(AppError);
  });

  it("rejects tenant outside caller scope with 403", async () => {
    const provider = new FakeDomainsProvider();
    const route = createDomainsRoute({
      provider,
      db,
      resolveCaller: () => ({
        tenantScope: tenantScope(["tenant-other"]),
        permissions: [DOMAINS_READ_PERMISSION],
      }),
    });

    await expect(
      route.handler({
        path: `/v1/tenants/${TENANT}/domains`,
        method: "GET",
        headers: {},
        params: { tenantId: TENANT },
        query: new URLSearchParams(),
      }),
    ).rejects.toThrow(AppError);
  });

  it("returns 200 with domain list for authorized caller", async () => {
    const provider = new FakeDomainsProvider();
    const route = createDomainsRoute({
      provider,
      db,
      resolveCaller: () => ({
        tenantScope: tenantScope([TENANT]),
        permissions: [DOMAINS_READ_PERMISSION],
      }),
    });

    const response = await route.handler({
      path: `/v1/tenants/${TENANT}/domains`,
      method: "GET",
      headers: {},
      params: { tenantId: TENANT },
      query: new URLSearchParams(),
    });

    expect(response.status).toBe(200);
    const body = response.body as DomainsPage;
    expect(body.tenantId).toBe(TENANT);
    expect(body.items).toHaveLength(3);
    expect(body.items[0]?.domain).toBe("contoso.com");
  });

  it("parses filter parameters and forwards to provider with latest checks", async () => {
    const provider = new FakeDomainsProvider();
    const route = createDomainsRoute({
      provider,
      db,
      resolveCaller: () => ({
        tenantScope: tenantScope([TENANT]),
        permissions: [DOMAINS_READ_PERMISSION],
      }),
    });

    // Insert test data
    db.prepare(
      `INSERT INTO domain_checks (id, tenantId, domain, "at", records, health, recommendations)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).run("check-1", TENANT, "contoso.com", "2026-09-20T12:00:00Z", "{}", '{"overall":"healthy"}', "[]");
    db.prepare(
      `INSERT INTO domain_checks (id, tenantId, domain, "at", records, health, recommendations)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).run("check-2", TENANT, "fabrikam.com", "2026-09-19T08:30:00Z", "{}", '{"overall":"degraded"}', "[]");

    const query = new URLSearchParams({
      limit: "25",
      cursor: "b2Zmc2V0OjEw",
    });

    await route.handler({
      path: `/v1/tenants/${TENANT}/domains`,
      method: "GET",
      headers: {},
      params: { tenantId: TENANT },
      query,
    });

    expect(provider.calls).toHaveLength(1);
    const call = provider.calls[0]!;
    expect(call.filter.limit).toBe(25);
    expect(call.filter.cursor).toBe("b2Zmc2V0OjEw");
    expect(call.latestChecks).toHaveLength(2);
    expect(call.latestChecks.map((c) => c.domain).sort()).toEqual(["contoso.com", "fabrikam.com"]);
  });

  it("parses parseDomainsFilter directly", () => {
    const query = new URLSearchParams({
      cursor: "b2Zmc2V0OjEw",
      limit: "50",
    });
    const filter = parseDomainsFilter(query);
    expect(filter.cursor).toBe("b2Zmc2V0OjEw");
    expect(filter.limit).toBe(50);
  });

  it("fetches latest domain checks from database per domain", async () => {
    const provider = new FakeDomainsProvider();
    const route = createDomainsRoute({
      provider,
      db,
      resolveCaller: () => ({
        tenantScope: tenantScope([TENANT]),
        permissions: [DOMAINS_READ_PERMISSION],
      }),
    });

    // Insert test data
    db.prepare(
      `INSERT INTO domain_checks (id, tenantId, domain, "at", records, health, recommendations)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).run("check-1", TENANT, "contoso.com", "2026-09-20T12:00:00Z", "{}", '{"overall":"healthy"}', "[]");
    db.prepare(
      `INSERT INTO domain_checks (id, tenantId, domain, "at", records, health, recommendations)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).run("check-2", TENANT, "fabrikam.com", "2026-09-19T08:30:00Z", "{}", '{"overall":"degraded"}', "[]");
    // Older check for same domain - should not be returned as latest
    db.prepare(
      `INSERT INTO domain_checks (id, tenantId, domain, "at", records, health, recommendations)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).run("check-3", TENANT, "contoso.com", "2026-09-18T10:00:00Z", "{}", '{"overall":"unhealthy"}', "[]");

    await route.handler({
      path: `/v1/tenants/${TENANT}/domains`,
      method: "GET",
      headers: {},
      params: { tenantId: TENANT },
      query: new URLSearchParams(),
    });

    expect(provider.calls).toHaveLength(1);
    const checks = provider.calls[0]!.latestChecks;
    expect(checks).toHaveLength(2);
    const contosoCheck = checks.find((c) => c.domain === "contoso.com");
    expect(contosoCheck?.at).toBe("2026-09-20T12:00:00Z");
    const fabrikamCheck = checks.find((c) => c.domain === "fabrikam.com");
    expect(fabrikamCheck?.at).toBe("2026-09-19T08:30:00Z");
  });

  it("handles domain with no stored check returning empty dnsHealth/lastChecked", async () => {
    const provider = new FakeDomainsProvider();
    const route = createDomainsRoute({
      provider,
      db,
      resolveCaller: () => ({
        tenantScope: tenantScope([TENANT]),
        permissions: [DOMAINS_READ_PERMISSION],
      }),
    });

    // No checks in database for any domain
    const response = await route.handler({
      path: `/v1/tenants/${TENANT}/domains`,
      method: "GET",
      headers: {},
      params: { tenantId: TENANT },
      query: new URLSearchParams(),
    });

    expect(response.status).toBe(200);
    const body = response.body as DomainsPage;
    const onmicrosoftDomain = body.items.find((d) => d.domain === "contoso.onmicrosoft.com");
    expect(onmicrosoftDomain).toBeDefined();
    expect(onmicrosoftDomain?.dnsHealth).toBeNull();
    expect(onmicrosoftDomain?.lastChecked).toBeNull();
  });

  it("publishes the Tenant.Domains.Read permission through the route module", () => {
    const operation = DOMAINS_OPENAPI.paths["/tenants/{tenantId}/domains"].get;
    expect(operation.permission).toBe(DOMAINS_READ_PERMISSION);
    expect(operation.operationId).toBe("listTenantDomains");
    expect(DOMAINS_READ_PERMISSION).toBe("Tenant.Domains.Read");
    expect(DOMAINS_PATH).toBe("/v1/tenants/:tenantId/domains");
  });
});