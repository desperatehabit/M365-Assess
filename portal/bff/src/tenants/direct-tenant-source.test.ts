import { describe, expect, it } from "vitest";
import type { TenantListOptions, TenantRecord } from "../routes/tenants.js";
import { DirectTenantSource } from "./direct-tenant-source.js";

const NOW = "2026-06-01T00:00:00.000Z";

function record(id: string, extra: Partial<TenantRecord> = {}): TenantRecord {
  return {
    id,
    displayName: `Tenant ${id}`,
    defaultDomain: null,
    initialDomain: null,
    source: "direct",
    status: "active",
    excluded: false,
    excludeReason: null,
    excludeDate: null,
    environment: "global",
    lastRunAt: null,
    errorCount: 0,
    lastError: null,
    createdAt: NOW,
    updatedAt: NOW,
    deletedAt: null,
    ...extra,
  };
}

// Mirrors the T-0021 repository surface the source reads through: tenant rows
// plus the GDAP satellite. The source only ever receives the tenant facet, so
// a direct-mode install must leave the satellite untouched.
class FakeTenantRepository {
  readonly tenants = new Map<string, TenantRecord>();
  readonly gdapRows = new Map<string, { tenantId: string }>();
  gdapWrites = 0;

  async listTenants(options: TenantListOptions = {}): Promise<TenantRecord[]> {
    return [...this.tenants.values()]
      .filter((tenant) => options.includeDeleted === true || tenant.deletedAt === null)
      .filter((tenant) => options.status === undefined || tenant.status === options.status)
      .filter((tenant) => options.source === undefined || tenant.source === options.source)
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt));
  }

  async getTenant(tenantId: string): Promise<TenantRecord | undefined> {
    const found = this.tenants.get(tenantId);
    if (found === undefined || found.deletedAt !== null) return undefined;
    return { ...found };
  }

  async onboardDirect(id: string): Promise<TenantRecord> {
    const created = record(id, { source: "direct" });
    this.tenants.set(id, created);
    return { ...created };
  }

  async listGdapRelationships(): Promise<Array<{ tenantId: string }>> {
    return [...this.gdapRows.values()];
  }

  async upsertGdapRelationship(row: { tenantId: string }): Promise<{ tenantId: string }> {
    this.gdapWrites += 1;
    this.gdapRows.set(row.tenantId, { ...row });
    return { ...row };
  }
}

describe("DirectTenantSource", () => {
  it("lists direct tenants and never surfaces gdap tenants", async () => {
    const repo = new FakeTenantRepository();
    repo.tenants.set("direct-1", record("direct-1"));
    repo.tenants.set("gdap-1", record("gdap-1", { source: "gdap" }));
    const source = new DirectTenantSource(repo);

    expect((await source.listTenants()).map((tenant) => tenant.id)).toEqual(["direct-1"]);
    expect(
      (await source.listTenants({ source: "gdap" })).map((tenant) => tenant.id),
    ).toEqual(["direct-1"]);
  });

  it("resolves a direct tenant by id", async () => {
    const repo = new FakeTenantRepository();
    repo.tenants.set("direct-1", record("direct-1"));
    repo.tenants.set("gdap-1", record("gdap-1", { source: "gdap" }));
    const source = new DirectTenantSource(repo);

    expect((await source.resolveTenant("direct-1"))?.source).toBe("direct");
    expect(await source.resolveTenant("gdap-1")).toBeUndefined();
    expect(await source.resolveTenant("missing")).toBeUndefined();
  });

  it("direct-mode installs carry no GDAP data", async () => {
    const repo = new FakeTenantRepository();
    const onboarded = [await repo.onboardDirect("direct-1"), await repo.onboardDirect("direct-2")];
    expect(onboarded.map((tenant) => tenant.source)).toEqual(["direct", "direct"]);

    const source = new DirectTenantSource(repo);
    expect((await source.listTenants()).map((tenant) => tenant.id)).toEqual([
      "direct-1",
      "direct-2",
    ]);
    expect((await source.resolveTenant("direct-1"))?.id).toBe("direct-1");

    expect(await repo.listGdapRelationships()).toHaveLength(0);
    expect(repo.gdapWrites).toBe(0);
  });
});
