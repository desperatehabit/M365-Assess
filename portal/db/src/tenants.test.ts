import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import type {
  GdapRelationshipInput,
  TenantGroupInput,
  TenantInput,
  TenantLicenseInventoryInput,
  TenantVariableInput,
} from "./repository.js";
import { openSqliteRepository } from "./sqlite-repository.js";

const TENANT_A = "11111111-1111-1111-1111-111111111111";
const TENANT_B = "22222222-2222-2222-2222-222222222222";
const GROUP_A = "aaaaaaaa-1111-1111-1111-111111111111";
const GROUP_B = "bbbbbbbb-2222-2222-2222-222222222222";

const tempDirs: string[] = [];

function tempDbPath(): string {
  const dir = mkdtempSync(join(tmpdir(), "m365-tenants-"));
  tempDirs.push(dir);
  return join(dir, "portal.db");
}

afterEach(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
  tempDirs.length = 0;
});

function tenant(id: string, extra: Partial<TenantInput> = {}): TenantInput {
  return {
    id,
    displayName: `Tenant ${id.slice(0, 4)}`,
    defaultDomain: null,
    initialDomain: null,
    source: "direct",
    status: "active",
    excluded: false,
    lastRunAt: null,
    errorCount: 0,
    ...extra,
  };
}

function group(id: string, extra: Partial<TenantGroupInput> = {}): TenantGroupInput {
  return { id, name: `Group ${id.slice(0, 4)}`, kind: "static", filter: null, ...extra };
}

function variable(
  id: string,
  tenantId: string | null,
  extra: Partial<TenantVariableInput> = {},
): TenantVariableInput {
  return { id, tenantId, name: id, value: "value", isSecret: false, ...extra };
}

function gdap(tenantId: string, extra: Partial<GdapRelationshipInput> = {}): GdapRelationshipInput {
  return {
    tenantId,
    relationshipEnd: null,
    delegatedPrivilegeStatus: null,
    cpvConsentState: null,
    lastSynced: null,
    ...extra,
  };
}

function inventory(
  tenantId: string,
  skuId: string,
  extra: Partial<TenantLicenseInventoryInput> = {},
): TenantLicenseInventoryInput {
  return {
    tenantId,
    skuId,
    skuPartNumber: skuId,
    enabledUnits: 25,
    consumedUnits: 17,
    lastSynced: "2026-09-28T00:00:00.000Z",
    ...extra,
  };
}

describe("migration 0002", () => {
  it("applies after 0001, is re-runnable, and advances SchemaVersion", async () => {
    const filename = tempDbPath();
    const first = await openSqliteRepository({ filename });
    expect(first.schemaVersion).toBeGreaterThanOrEqual(60);
    first.close();

    const raw = new Database(filename);
    expect(raw.prepare("SELECT MAX(version) AS v FROM schema_versions").get()).toMatchObject({
      v: first.schemaVersion,
    });
    const tables = (
      raw.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{
        name: string;
      }>
    ).map((row) => row.name);
    expect(tables).toEqual(
      expect.arrayContaining([
        "tenants",
        "tenant_credentials",
        "tenant_groups",
        "tenant_group_members",
        "tenant_variables",
        "gdap_relationships",
      ]),
    );
    raw.close();

    const second = await openSqliteRepository({ filename });
    expect(second.schemaVersion).toBe(first.schemaVersion);
    second.close();

    const rawAgain = new Database(filename);
    expect(
      rawAgain.prepare("SELECT COUNT(*) AS c FROM schema_versions WHERE version = ?").get(first.schemaVersion),
    ).toMatchObject({ c: 1 });
    rawAgain.close();
  });
});

describe("repository surface", () => {
  it("exposes tenant, credential, group, variable, and gdap methods", async () => {
    const repo = await openSqliteRepository({ filename: tempDbPath() });
    const methods = [
      "getTenant",
      "listTenants",
      "upsertTenant",
      "softDeleteTenant",
      "getTenantCredential",
      "listTenantCredentials",
      "upsertTenantCredential",
      "getTenantGroup",
      "listTenantGroups",
      "upsertTenantGroup",
      "softDeleteTenantGroup",
      "addTenantGroupMember",
      "removeTenantGroupMember",
      "listTenantGroupMembers",
      "listTenantGroupsForTenant",
      "getTenantVariable",
      "listTenantVariables",
      "upsertTenantVariable",
      "deleteTenantVariable",
      "getGdapRelationship",
      "listGdapRelationships",
      "upsertGdapRelationship",
    ];
    for (const method of methods) {
      expect(typeof (repo as unknown as Record<string, unknown>)[method]).toBe("function");
    }
    repo.close();
  });
});

describe("tenant listing and filtering", () => {
  it("filters by status, source, group, and search and round-trips day-2 fields", async () => {
    const repo = await openSqliteRepository({ filename: tempDbPath() });
    await repo.upsertTenant(
      tenant(TENANT_A, { createdAt: "2026-01-01T00:00:00.000Z", displayName: "Alpha Tenant" }),
    );
    await repo.upsertTenant(
      tenant(TENANT_B, {
        createdAt: "2026-01-02T00:00:00.000Z",
        status: "excluded",
        source: "gdap",
        excluded: true,
        excludeReason: "business",
        excludeDate: "2026-03-01T00:00:00.000Z",
        environment: "gcchigh",
        lastError: "connect failed",
      }),
    );
    await repo.upsertTenantGroup(group(GROUP_A));
    await repo.addTenantGroupMember({ groupId: GROUP_A, tenantId: TENANT_A });

    expect((await repo.listTenants()).map((t) => t.id)).toEqual([TENANT_A, TENANT_B]);
    expect((await repo.listTenants({ status: "excluded" })).map((t) => t.id)).toEqual([TENANT_B]);
    expect((await repo.listTenants({ source: "gdap" })).map((t) => t.id)).toEqual([TENANT_B]);
    expect((await repo.listTenants({ groupId: GROUP_A })).map((t) => t.id)).toEqual([TENANT_A]);
    expect((await repo.listTenants({ search: "Alpha" })).map((t) => t.id)).toEqual([TENANT_A]);
    expect((await repo.listTenants({ search: "22222222" })).map((t) => t.id)).toEqual([TENANT_B]);

    const excluded = await repo.getTenant(TENANT_B);
    expect(excluded?.excludeReason).toBe("business");
    expect(excluded?.excludeDate).toBe("2026-03-01T00:00:00.000Z");
    expect(excluded?.environment).toBe("gcchigh");
    expect(excluded?.lastError).toBe("connect failed");

    const active = await repo.getTenant(TENANT_A);
    expect(active?.environment).toBe("global");
    expect(active?.excludeReason).toBeNull();
    repo.close();
  });
});

describe("tenant scoping", () => {
  it("scopes credentials, variables, and group membership to the tenant", async () => {
    const repo = await openSqliteRepository({ filename: tempDbPath() });
    await repo.upsertTenant(tenant(TENANT_A));
    await repo.upsertTenant(tenant(TENANT_B));
    await repo.upsertTenantCredential({
      id: "cred-a",
      tenantId: TENANT_A,
      authMethod: "certificate",
      clientId: "client-a",
      secretRef: "ref://store/cred-a",
      thumbprint: null,
      environment: "global",
      expiresOn: null,
      lastValidated: null,
    });
    await repo.upsertTenantVariable(variable("var-a", TENANT_A));
    await repo.upsertTenantVariable(variable("var-b", TENANT_B));
    await repo.upsertTenantVariable(variable("var-global", null));
    await repo.upsertTenantGroup(group(GROUP_A));
    await repo.upsertTenantGroup(
      group(GROUP_B, { kind: "dynamic", filter: { variable: "tier", value: "gold" } }),
    );
    await repo.addTenantGroupMember({ groupId: GROUP_A, tenantId: TENANT_A });
    await repo.addTenantGroupMember({ groupId: GROUP_B, tenantId: TENANT_B });

    const dynamicGroup = await repo.getTenantGroup(GROUP_B);
    expect(dynamicGroup?.kind).toBe("dynamic");
    expect(dynamicGroup?.filter).toEqual({ variable: "tier", value: "gold" });

    expect(await repo.listTenantCredentials(TENANT_B)).toHaveLength(0);
    expect(await repo.getTenantCredential(TENANT_B)).toBeUndefined();
    expect(await repo.listTenantCredentials(TENANT_A)).toHaveLength(1);

    expect((await repo.listTenantVariables({ tenantId: TENANT_A })).map((v) => v.id)).toEqual([
      "var-a",
    ]);
    expect(
      (await repo.listTenantVariables({ tenantId: TENANT_A, includeGlobal: true }))
        .map((v) => v.id)
        .sort(),
    ).toEqual(["var-a", "var-global"]);
    expect((await repo.listTenantVariables({ tenantId: TENANT_B })).map((v) => v.id)).toEqual([
      "var-b",
    ]);

    expect((await repo.listTenantGroupsForTenant(TENANT_A)).map((g) => g.id)).toEqual([GROUP_A]);
    expect((await repo.listTenantGroupsForTenant(TENANT_B)).map((g) => g.id)).toEqual([GROUP_B]);
    expect(await repo.removeTenantGroupMember(GROUP_A, TENANT_B)).toBe(false);
    expect(await repo.removeTenantGroupMember(GROUP_A, TENANT_A)).toBe(true);
    expect(await repo.listTenantGroupMembers(GROUP_A)).toHaveLength(0);
    repo.close();
  });
});

describe("soft delete", () => {
  it("hides tenants and groups but keeps the rows and supports includeDeleted", async () => {
    const filename = tempDbPath();
    const repo = await openSqliteRepository({ filename });
    await repo.upsertTenant(tenant(TENANT_A));
    await repo.upsertTenantGroup(group(GROUP_A));
    await repo.addTenantGroupMember({ groupId: GROUP_A, tenantId: TENANT_A });

    expect(await repo.softDeleteTenantGroup(GROUP_A, { now: "2026-04-01T00:00:00.000Z" })).toBe(
      true,
    );
    expect(await repo.getTenantGroup(GROUP_A)).toBeUndefined();
    expect(await repo.listTenantGroups()).toHaveLength(0);
    expect(await repo.listTenantGroupsForTenant(TENANT_A)).toHaveLength(0);
    expect((await repo.getTenantGroup(GROUP_A, { includeDeleted: true }))?.deletedAt).toBe(
      "2026-04-01T00:00:00.000Z",
    );
    expect(await repo.listTenantGroups({ includeDeleted: true })).toHaveLength(1);
    expect(await repo.softDeleteTenantGroup(GROUP_A)).toBe(false);

    expect(await repo.softDeleteTenant(TENANT_A, { now: "2026-04-02T00:00:00.000Z" })).toBe(true);
    expect(await repo.getTenant(TENANT_A)).toBeUndefined();
    expect(await repo.listTenants()).toHaveLength(0);
    expect(await repo.listTenants({ includeDeleted: true })).toHaveLength(1);
    expect(await repo.softDeleteTenant(TENANT_A)).toBe(false);
    repo.close();

    const raw = new Database(filename);
    expect(raw.prepare("SELECT COUNT(*) AS c FROM tenants WHERE id = ?").get(TENANT_A)).toMatchObject(
      { c: 1 },
    );
    expect(
      raw.prepare("SELECT COUNT(*) AS c FROM tenant_groups WHERE id = ?").get(GROUP_A),
    ).toMatchObject({ c: 1 });
    raw.close();
  });
});

describe("secrets", () => {
  it("stores credentials by reference only and has no secret-value column", async () => {
    const filename = tempDbPath();
    const repo = await openSqliteRepository({ filename });
    await repo.upsertTenant(tenant(TENANT_A));
    const stored = await repo.upsertTenantCredential({
      id: "cred-a",
      tenantId: TENANT_A,
      authMethod: "certificate",
      clientId: "client-a",
      secretRef: "ref://store/cred-a",
      thumbprint: "thumb-a",
      environment: "global",
      expiresOn: null,
      lastValidated: null,
    });
    expect(stored.secretRef).toBe("ref://store/cred-a");
    repo.close();

    const raw = new Database(filename);
    const tables = raw
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")
      .all() as Array<{ name: string }>;
    const secretishTextColumns = new Set<string>();
    for (const table of tables) {
      const columns = raw.prepare(`PRAGMA table_info(${table.name})`).all() as Array<{
        name: string;
        type: string;
      }>;
      for (const column of columns) {
        const storesText = column.type.toUpperCase().includes("TEXT");
        if (storesText && /secret|password|token/i.test(column.name)) {
          secretishTextColumns.add(column.name);
        }
      }
    }
    expect([...secretishTextColumns].sort()).toEqual(["secretHash", "secretRef"]);
    raw.close();
  });
});

describe("gdap satellite", () => {
  it("upserts relationship metadata without changing the direct tenant", async () => {
    const repo = await openSqliteRepository({ filename: tempDbPath() });
    await repo.upsertTenant(tenant(TENANT_A));
    expect(await repo.listGdapRelationships()).toHaveLength(0);

    await repo.upsertGdapRelationship(
      gdap(TENANT_A, {
        relationshipEnd: "end-a",
        delegatedPrivilegeStatus: "active",
        cpvConsentState: "accepted",
        lastSynced: "2026-05-01T00:00:00.000Z",
      }),
    );
    const found = await repo.getGdapRelationship(TENANT_A);
    expect(found?.cpvConsentState).toBe("accepted");
    expect(found?.delegatedPrivilegeStatus).toBe("active");

    await repo.upsertGdapRelationship(gdap(TENANT_A, { cpvConsentState: "pending" }));
    expect((await repo.getGdapRelationship(TENANT_A))?.cpvConsentState).toBe("pending");
    expect(await repo.listGdapRelationships()).toHaveLength(1);
    expect((await repo.getTenant(TENANT_A))?.source).toBe("direct");
    repo.close();
  });
});

describe("tenant license inventory (T-0828)", () => {
  it("persists per-tenant SKUs with units and sync time", async () => {
    const repo = await openSqliteRepository({ filename: tempDbPath() });
    await repo.upsertTenant(tenant(TENANT_A));
    await repo.upsertTenant(tenant(TENANT_B));
    await repo.upsertTenantLicenseInventory(inventory(TENANT_A, "ENTERPRISEPREMIUM"));

    const rows = await repo.listTenantLicenseInventory(TENANT_A);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      tenantId: TENANT_A,
      skuId: "ENTERPRISEPREMIUM",
      skuPartNumber: "ENTERPRISEPREMIUM",
      enabledUnits: 25,
      consumedUnits: 17,
      lastSynced: "2026-09-28T00:00:00.000Z",
    });
    expect(await repo.listTenantLicenseInventory(TENANT_B)).toHaveLength(0);
    expect((await repo.listTenantLicenseInventory()).map((row) => row.skuId)).toEqual([
      "ENTERPRISEPREMIUM",
    ]);
    repo.close();
  });

  it("treats a repeated upsert as an edit of the same row", async () => {
    const repo = await openSqliteRepository({ filename: tempDbPath() });
    await repo.upsertTenant(tenant(TENANT_A));
    await repo.upsertTenantLicenseInventory(inventory(TENANT_A, "EMS"));
    const edited = await repo.upsertTenantLicenseInventory(
      inventory(TENANT_A, "EMS", { consumedUnits: 20, lastSynced: "2026-09-29T00:00:00.000Z" }),
    );
    expect(edited.consumedUnits).toBe(20);
    expect(edited.lastSynced).toBe("2026-09-29T00:00:00.000Z");
    expect(await repo.listTenantLicenseInventory(TENANT_A)).toHaveLength(1);
    repo.close();
  });

  it("replaces the tenant's inventory on re-sync, dropping SKUs no longer held", async () => {
    const repo = await openSqliteRepository({ filename: tempDbPath() });
    await repo.upsertTenant(tenant(TENANT_A));
    await repo.upsertTenant(tenant(TENANT_B));
    await repo.replaceTenantLicenseInventory(TENANT_A, [
      inventory(TENANT_A, "ENTERPRISEPREMIUM"),
      inventory(TENANT_A, "EMS"),
    ]);
    await repo.upsertTenantLicenseInventory(inventory(TENANT_B, "EMS"));

    expect((await repo.listTenantLicenseInventory(TENANT_A)).map((row) => row.skuId)).toEqual([
      "EMS",
      "ENTERPRISEPREMIUM",
    ]);

    const resynced = await repo.replaceTenantLicenseInventory(TENANT_A, [
      inventory(TENANT_A, "ENTERPRISEPREMIUM"),
    ]);
    expect(resynced.map((row) => row.skuId)).toEqual(["ENTERPRISEPREMIUM"]);
    expect((await repo.listTenantLicenseInventory(TENANT_A)).map((row) => row.skuId)).toEqual([
      "ENTERPRISEPREMIUM",
    ]);
    expect((await repo.listTenantLicenseInventory(TENANT_B)).map((row) => row.skuId)).toEqual([
      "EMS",
    ]);
    repo.close();
  });
});
