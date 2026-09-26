import { describe, expect, it } from "vitest";
import type { TenantListOptions, TenantRecord, TenantStore } from "../routes/tenants.js";
import { DirectTenantSource } from "./direct-tenant-source.js";
import {
  GdapTenantSource,
  type GdapRelationship,
  type GdapRelationshipStore,
} from "./gdap-tenant-source.js";

const NOW = "2026-06-01T12:00:00.000Z";

class MemoryTenantStore implements Pick<TenantStore, "listTenants" | "getTenant"> {
  readonly tenants = new Map<string, TenantRecord>();

  async listTenants(options: TenantListOptions = {}): Promise<TenantRecord[]> {
    return [...this.tenants.values()].filter((t) => {
      if (options.source !== undefined && t.source !== options.source) return false;
      if (options.status !== undefined && t.status !== options.status) return false;
      return true;
    });
  }

  async getTenant(tenantId: string): Promise<TenantRecord | undefined> {
    const t = this.tenants.get(tenantId);
    return t ? { ...t } : undefined;
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

function makeTenant(id: string, source: "direct" | "gdap"): TenantRecord {
  return {
    id,
    displayName: `${source}-${id}`,
    defaultDomain: `${id}.com`,
    initialDomain: `${id}.onmicrosoft.com`,
    source,
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

describe("GdapTenantSource (T-0029)", () => {
  it("returns nothing and resolves nothing when feature flag is off", async () => {
    const store = new MemoryTenantStore();
    store.tenants.set("gdap-1", makeTenant("gdap-1", "gdap"));
    store.tenants.set("direct-1", makeTenant("direct-1", "direct"));

    const source = new GdapTenantSource({ store, enabled: false });

    expect(source.enabled).toBe(false);
    expect(await source.listTenants()).toEqual([]);
    expect(await source.resolveTenant("gdap-1")).toBeUndefined();
    expect(await source.resolveTenant("direct-1")).toBeUndefined();
  });

  it("lists only source: gdap tenants and resolves only gdap tenants when enabled", async () => {
    const store = new MemoryTenantStore();
    store.tenants.set("gdap-1", makeTenant("gdap-1", "gdap"));
    store.tenants.set("direct-1", makeTenant("direct-1", "direct"));

    const source = new GdapTenantSource({ store, enabled: true });

    expect(source.enabled).toBe(true);
    const listed = await source.listTenants();
    expect(listed.length).toBe(1);
    expect(listed[0].id).toBe("gdap-1");
    expect(listed[0].source).toBe("gdap");

    const resolvedGdap = await source.resolveTenant("gdap-1");
    expect(resolvedGdap).toBeDefined();
    expect(resolvedGdap?.id).toBe("gdap-1");

    // Must never resolve direct tenants
    const resolvedDirect = await source.resolveTenant("direct-1");
    expect(resolvedDirect).toBeUndefined();
  });

  it("enabling and disabling GDAP leaves direct tenants completely untouched", async () => {
    const store = new MemoryTenantStore();
    store.tenants.set("direct-1", makeTenant("direct-1", "direct"));
    store.tenants.set("direct-2", makeTenant("direct-2", "direct"));
    store.tenants.set("gdap-1", makeTenant("gdap-1", "gdap"));

    const directSource = new DirectTenantSource(store);

    // Initial check with GDAP disabled
    const gdapDisabled = new GdapTenantSource({ store, enabled: false });
    const directBefore = await directSource.listTenants();
    expect(directBefore.length).toBe(2);
    expect(directBefore.map((t) => t.id)).toEqual(["direct-1", "direct-2"]);
    expect(await gdapDisabled.listTenants()).toEqual([]);

    // Turn GDAP on
    const gdapEnabled = new GdapTenantSource({ store, enabled: true });
    expect((await gdapEnabled.listTenants()).length).toBe(1);

    // Direct tenants remain identical
    const directAfter = await directSource.listTenants();
    expect(directAfter.length).toBe(2);
    expect(directAfter.map((t) => t.id)).toEqual(["direct-1", "direct-2"]);
    expect(await directSource.resolveTenant("direct-1")).toBeDefined();
    expect(await directSource.resolveTenant("gdap-1")).toBeUndefined();
  });

  it("provides satellite relationship access only when enabled", async () => {
    const store = new MemoryTenantStore();
    const relStore = new MemoryGdapRelationshipStore();
    await relStore.upsertGdapRelationship({
      tenantId: "gdap-1",
      delegatedPrivilegeStatus: "active",
      cpvConsentState: "consented",
    });

    const disabledSource = new GdapTenantSource({
      store,
      relationshipStore: relStore,
      enabled: false,
    });
    expect(await disabledSource.getRelationship("gdap-1")).toBeUndefined();
    expect(await disabledSource.listRelationships()).toEqual([]);

    const enabledSource = new GdapTenantSource({
      store,
      relationshipStore: relStore,
      enabled: true,
    });
    const rel = await enabledSource.getRelationship("gdap-1");
    expect(rel).toBeDefined();
    expect(rel?.delegatedPrivilegeStatus).toBe("active");
    expect((await enabledSource.listRelationships()).length).toBe(1);
  });
});
