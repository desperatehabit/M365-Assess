import { describe, expect, it, vi } from "vitest";
import { ALL_TENANTS, tenantScope } from "../rbac/scope.js";
import {
  createTenantLookupService,
  type GraphTenantDetails,
  type TenantLookupGraphClient,
  type TenantLookupStore,
  type TenantLookupStoreTenant,
} from "./tenant-lookup-service.js";

const TENANT_ID = "11111111-2222-3333-4444-555555555555";
const DOMAIN = "example.com";

const GRAPH_TENANT: GraphTenantDetails = {
  tenantId: TENANT_ID,
  displayName: "Example Tenant",
  defaultDomain: DOMAIN,
  verifiedDomains: [DOMAIN, "example.onmicrosoft.com"],
  region: "global",
};

const STORE_TENANT: TenantLookupStoreTenant = {
  id: TENANT_ID,
  deletedAt: null,
};

class FakeTenantLookupGraphClient implements TenantLookupGraphClient {
  readonly domainCalls: string[] = [];
  readonly tenantIdCalls: string[] = [];
  byDomain: GraphTenantDetails | null = GRAPH_TENANT;
  byTenantId: GraphTenantDetails | null = GRAPH_TENANT;

  async resolveByDomain(domain: string): Promise<GraphTenantDetails | null> {
    this.domainCalls.push(domain);
    return this.byDomain;
  }

  async resolveByTenantId(tenantId: string): Promise<GraphTenantDetails | null> {
    this.tenantIdCalls.push(tenantId);
    return this.byTenantId;
  }
}

class FakeTenantLookupStore implements TenantLookupStore {
  readonly calls: string[] = [];
  record: TenantLookupStoreTenant | undefined = STORE_TENANT;

  async getTenant(tenantId: string): Promise<TenantLookupStoreTenant | undefined> {
    this.calls.push(tenantId);
    return this.record;
  }
}

function setup(): { graph: FakeTenantLookupGraphClient; store: FakeTenantLookupStore; service: ReturnType<typeof createTenantLookupService> } {
  const graph = new FakeTenantLookupGraphClient();
  const store = new FakeTenantLookupStore();
  const service = createTenantLookupService({ graph, store });
  return { graph, store, service };
}

describe("Tenant lookup service (T-0785)", () => {
  it("resolves a domain against the Graph tenant endpoints and returns the §3.2 fields", async () => {
    const { graph, store, service } = setup();

    const result = await service.lookup(DOMAIN, ALL_TENANTS);

    expect(graph.domainCalls).toEqual([DOMAIN]);
    expect(graph.tenantIdCalls).toEqual([]);
    expect(store.calls).toEqual([TENANT_ID]);
    expect(result).toEqual({
      tenantId: TENANT_ID,
      name: "Example Tenant",
      defaultDomain: DOMAIN,
      verifiedDomains: [DOMAIN, "example.onmicrosoft.com"],
      region: "global",
      inPortal: true,
    });
  });

  it("resolves a GUID-shaped query as a tenant ID", async () => {
    const { graph, store, service } = setup();

    const result = await service.lookup(TENANT_ID, ALL_TENANTS);

    expect(graph.domainCalls).toEqual([]);
    expect(graph.tenantIdCalls).toEqual([TENANT_ID]);
    expect(store.calls).toEqual([TENANT_ID]);
    expect(result.tenantId).toBe(TENANT_ID);
  });

  it("trims the query before resolving", async () => {
    const { graph, service } = setup();

    await service.lookup(`  ${DOMAIN}  `, ALL_TENANTS);

    expect(graph.domainCalls).toEqual([DOMAIN]);
  });

  it("reports inPortal false when the tenant is absent from the portal store", async () => {
    const { store, service } = setup();
    store.record = undefined;

    const result = await service.lookup(DOMAIN, ALL_TENANTS);

    expect(result.inPortal).toBe(false);
  });

  it("reports inPortal false when the portal store record is soft-deleted", async () => {
    const { store, service } = setup();
    store.record = { id: TENANT_ID, deletedAt: "2026-09-01T00:00:00.000Z" };

    const result = await service.lookup(DOMAIN, ALL_TENANTS);

    expect(result.inPortal).toBe(false);
  });

  it("denies a caller scoped away from the tenant with a 403 and no details", async () => {
    const { graph, store, service } = setup();

    const error = await service.lookup(DOMAIN, tenantScope(["99999999-8888-7777-6666-555555555555"])).catch(
      (e: unknown) => e,
    );

    expect(error).toMatchObject({ status: 403, code: "auth.forbidden" });
    expect(store.calls).toEqual([]);
  });

  it("allows a caller whose scope contains the tenant", async () => {
    const { service } = setup();

    const result = await service.lookup(DOMAIN, tenantScope([TENANT_ID]));

    expect(result.tenantId).toBe(TENANT_ID);
  });

  it("returns a 404 when the Graph tenant endpoints match no tenant", async () => {
    const { graph, service } = setup();
    graph.byDomain = null;

    const error = await service.lookup(DOMAIN, ALL_TENANTS).catch((e: unknown) => e);

    expect(error).toMatchObject({ status: 404, code: "tenant.not_found" });
  });

  it("returns a 400 for an empty or whitespace-only query", async () => {
    const { graph, service } = setup();

    for (const query of ["", "   "]) {
      const error = await service.lookup(query, ALL_TENANTS).catch((e: unknown) => e);
      expect(error).toMatchObject({ status: 400, code: "request.validation_failed" });
    }
    expect(graph.domainCalls).toEqual([]);
    expect(graph.tenantIdCalls).toEqual([]);
  });

  it("propagates Graph endpoint failures to the caller", async () => {
    const graph: TenantLookupGraphClient = {
      resolveByDomain: vi.fn(async () => {
        throw new Error("graph unreachable");
      }),
      resolveByTenantId: vi.fn(async () => GRAPH_TENANT),
    };
    const service = createTenantLookupService({ graph, store: new FakeTenantLookupStore() });

    await expect(service.lookup(DOMAIN, ALL_TENANTS)).rejects.toThrow("graph unreachable");
  });
});
