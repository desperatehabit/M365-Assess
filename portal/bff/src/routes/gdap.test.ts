import { describe, expect, it } from "vitest";
import { ALL_TENANTS } from "../rbac/scope.js";
import type { RequestContext, Route } from "../server.js";
import type { GdapRelationship, GdapRelationshipStore } from "../tenants/gdap-tenant-source.js";
import type { TenantAuditInput, TenantRecord, TenantStore } from "./tenants.js";
import {
  createGdapRoutes,
  GDAP_OPENAPI,
  GDAP_PERMISSION,
  GDAP_SYNC_PATH,
  GDAP_UNAUTHENTICATED,
  type GdapCaller,
  type GdapRouteOptions,
  type GdapSyncResult,
} from "./gdap.js";

const NOW = "2026-06-01T12:00:00.000Z";

class MemoryTenantStore implements TenantStore {
  readonly records = new Map<string, TenantRecord>();
  readonly events: TenantAuditInput[] = [];

  async listTenants(): Promise<TenantRecord[]> {
    return [...this.records.values()];
  }

  async getTenant(tenantId: string): Promise<TenantRecord | undefined> {
    const found = this.records.get(tenantId);
    if (!found || found.deletedAt !== null) return undefined;
    return { ...found };
  }

  async upsertTenant(input: TenantRecord): Promise<TenantRecord> {
    const stored = { ...input };
    this.records.set(stored.id, stored);
    return { ...stored };
  }

  async softDeleteTenant(tenantId: string): Promise<boolean> {
    const found = this.records.get(tenantId);
    if (!found) return false;
    found.deletedAt = NOW;
    return true;
  }

  async appendAuditEvent(input: TenantAuditInput): Promise<any> {
    this.events.push(input);
    return input;
  }
}

class MemoryGdapRelationshipStore implements GdapRelationshipStore {
  readonly relationships = new Map<string, GdapRelationship>();

  async getGdapRelationship(tenantId: string): Promise<GdapRelationship | undefined> {
    const r = this.relationships.get(tenantId);
    return r ? { ...r } : undefined;
  }

  async listGdapRelationships(): Promise<GdapRelationship[]> {
    return [...this.relationships.values()];
  }

  async upsertGdapRelationship(input: GdapRelationship): Promise<GdapRelationship> {
    const stored = { ...input };
    this.relationships.set(stored.tenantId, stored);
    return { ...stored };
  }
}

function adminCaller(): GdapCaller {
  return { roles: ["admin"], tenantScope: ALL_TENANTS, userId: "admin-1" };
}

function makeDirectTenant(id: string): TenantRecord {
  return {
    id,
    displayName: "Direct Managed Corp",
    defaultDomain: "direct.com",
    initialDomain: "direct.onmicrosoft.com",
    source: "direct",
    status: "active",
    excluded: false,
    excludeReason: null,
    excludeDate: null,
    environment: "commercial",
    lastRunAt: null,
    errorCount: 0,
    lastError: null,
    createdAt: NOW,
    updatedAt: NOW,
    deletedAt: null,
  };
}

describe("GDAP routes (T-0029)", () => {
  it("serves no route when feature flag is off", () => {
    const store = new MemoryTenantStore();
    const routes = createGdapRoutes({
      enabled: false,
      tenantStore: store,
      resolveCaller: () => adminCaller(),
    });

    expect(routes.length).toBe(0);
  });

  it("synchronizes GDAP tenants and relationships without modifying direct tenants", async () => {
    const store = new MemoryTenantStore();
    const relStore = new MemoryGdapRelationshipStore();

    // Pre-populate with a direct tenant
    await store.upsertTenant(makeDirectTenant("direct-tenant-1"));

    const syncResult: GdapSyncResult = {
      syncedAt: NOW,
      totalDiscovered: 3,
      tenants: [
        {
          id: "gdap-tenant-active",
          displayName: "Active Partner Client",
          source: "gdap",
          status: "active",
          excluded: false,
          excludeReason: null,
        },
        {
          id: "gdap-tenant-terminated",
          displayName: "Terminated Partner Client",
          source: "gdap",
          status: "excluded",
          excluded: true,
          excludeReason: "GDAP relationship is terminated",
        },
        // Attempted overlap with direct tenant
        {
          id: "direct-tenant-1",
          displayName: "Should Not Overwrite Direct Tenant",
          source: "gdap",
          status: "active",
          excluded: false,
          excludeReason: null,
        },
      ],
      relationships: [
        {
          tenantId: "gdap-tenant-active",
          relationshipEnd: "2027-01-01T00:00:00Z",
          delegatedPrivilegeStatus: "active",
          cpvConsentState: "consented",
        },
        {
          tenantId: "gdap-tenant-terminated",
          relationshipEnd: "2025-01-01T00:00:00Z",
          delegatedPrivilegeStatus: "terminated",
          cpvConsentState: "expired",
        },
      ],
    };

    const routes = createGdapRoutes({
      enabled: true,
      tenantStore: store,
      relationshipStore: relStore,
      runner: async () => syncResult,
      resolveCaller: () => adminCaller(),
      now: () => NOW,
    });

    expect(routes.length).toBe(1);
    const route = routes[0];
    const ctx: RequestContext = {
      method: "POST",
      path: GDAP_SYNC_PATH,
      params: {},
      query: new URLSearchParams(),
      headers: {},
    };

    const res = await route.handler(ctx);
    expect(res.status).toBe(200);

    // Active GDAP tenant was created
    const activeGdap = await store.getTenant("gdap-tenant-active");
    expect(activeGdap).toBeDefined();
    expect(activeGdap?.source).toBe("gdap");
    expect(activeGdap?.status).toBe("active");
    expect(activeGdap?.excluded).toBe(false);

    // Terminated GDAP tenant was preserved as excluded, not dropped
    const termGdap = await store.getTenant("gdap-tenant-terminated");
    expect(termGdap).toBeDefined();
    expect(termGdap?.source).toBe("gdap");
    expect(termGdap?.status).toBe("excluded");
    expect(termGdap?.excluded).toBe(true);
    expect(termGdap?.excludeReason).toBe("GDAP relationship is terminated");

    // Direct tenant was NOT overwritten or altered
    const direct = await store.getTenant("direct-tenant-1");
    expect(direct).toBeDefined();
    expect(direct?.source).toBe("direct");
    expect(direct?.displayName).toBe("Direct Managed Corp");

    // Satellite relationships were persisted
    const rels = await relStore.listGdapRelationships();
    expect(rels.length).toBe(2);
    const activeRel = await relStore.getGdapRelationship("gdap-tenant-active");
    expect(activeRel?.delegatedPrivilegeStatus).toBe("active");
    expect(activeRel?.cpvConsentState).toBe("consented");

    // Audit event was written
    expect(store.events.length).toBe(1);
    expect(store.events[0].action).toBe("gdap.sync");
  });

  it("rejects unauthenticated requests with 401", async () => {
    const store = new MemoryTenantStore();
    const routes = createGdapRoutes({
      enabled: true,
      tenantStore: store,
      resolveCaller: () => undefined,
    });

    const route = routes[0];
    const ctx: RequestContext = {
      method: "POST",
      path: GDAP_SYNC_PATH,
      params: {},
      query: new URLSearchParams(),
      headers: {},
    };

    await expect(route.handler(ctx)).rejects.toMatchObject({
      code: GDAP_UNAUTHENTICATED,
      status: 401,
    });
  });

  it("declares OpenAPI spec matching the route", () => {
    expect(GDAP_OPENAPI.paths["/v1/gdap/sync"]).toBeDefined();
    expect(GDAP_OPENAPI.paths["/v1/gdap/sync"].post.permission).toBe(GDAP_PERMISSION);
  });
});
