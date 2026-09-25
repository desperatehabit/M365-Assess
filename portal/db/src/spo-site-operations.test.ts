import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import type { SharePointTemplateInput, SiteOperationInput, TenantInput } from "./repository.js";
import { loadMigrations, openSqliteRepository } from "./sqlite-repository.js";

const TENANT_A = "11111111-1111-1111-1111-111111111111";
const TENANT_B = "22222222-2222-2222-2222-222222222222";
const TEMPLATE_A = "aaaaaaaa-3333-3333-3333-333333333333";
const OPERATION_A = "bbbbbbbb-4444-4444-4444-444444444444";

const tempDirs: string[] = [];

function tempDbPath(): string {
  const dir = mkdtempSync(join(tmpdir(), "m365-spo-"));
  tempDirs.push(dir);
  return join(dir, "portal.db");
}

afterEach(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
  tempDirs.length = 0;
});

function tenant(id: string): TenantInput {
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
  };
}

function template(
  id: string,
  extra: Partial<SharePointTemplateInput> = {},
): SharePointTemplateInput {
  return { id, name: `Template ${id.slice(0, 4)}`, siteType: "team", ...extra };
}

function operation(
  id: string,
  tenantId: string,
  extra: Partial<SiteOperationInput> = {},
): SiteOperationInput {
  return {
    id,
    tenantId,
    siteId: `site-${id.slice(0, 4)}`,
    operation: "create",
    state: "planned",
    ...extra,
  };
}

describe("migration 0033", () => {
  it("applies after the base migrations, is re-runnable, and advances SchemaVersion", async () => {
    const filename = tempDbPath();
    const expected = loadMigrations().reduce((max, migration) => Math.max(max, migration.version), 0);
    expect(expected).toBeGreaterThanOrEqual(33);

    const first = await openSqliteRepository({ filename });
    expect(first.schemaVersion).toBe(expected);
    first.close();

    const raw = new Database(filename);
    expect(
      raw.prepare("SELECT COUNT(*) AS c FROM schema_versions WHERE version = 33").get(),
    ).toMatchObject({ c: 1 });
    const tables = (
      raw.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{
        name: string;
      }>
    ).map((row) => row.name);
    expect(tables).toEqual(expect.arrayContaining(["sharepoint_templates", "site_operations"]));
    raw.close();

    const second = await openSqliteRepository({ filename });
    expect(second.schemaVersion).toBe(expected);
    second.close();

    const rawAgain = new Database(filename);
    expect(
      rawAgain.prepare("SELECT COUNT(*) AS c FROM schema_versions WHERE version = 33").get(),
    ).toMatchObject({ c: 1 });
    rawAgain.close();
  });
});

describe("repository surface", () => {
  it("exposes SharePointTemplate CRUD and SiteOperation create/get/update/list", async () => {
    const repo = await openSqliteRepository({ filename: tempDbPath() });
    const methods = [
      "createSharePointTemplate",
      "getSharePointTemplate",
      "listSharePointTemplates",
      "updateSharePointTemplate",
      "softDeleteSharePointTemplate",
      "createSiteOperation",
      "getSiteOperation",
      "listSiteOperations",
      "updateSiteOperation",
    ];
    for (const method of methods) {
      expect(typeof (repo as unknown as Record<string, unknown>)[method]).toBe("function");
    }
    repo.close();
  });
});

describe("sharepoint templates", () => {
  it("round-trips settings and variables as JSON and soft-deletes", async () => {
    const repo = await openSqliteRepository({ filename: tempDbPath() });
    await repo.createSharePointTemplate(
      template(TEMPLATE_A, {
        settings: { sharing: "disabled", owners: ["owner-a"] },
        variables: { region: "eu", tier: "gold" },
      }),
    );

    const stored = await repo.getSharePointTemplate(TEMPLATE_A);
    expect(stored?.siteType).toBe("team");
    expect(stored?.settings).toEqual({ sharing: "disabled", owners: ["owner-a"] });
    expect(stored?.variables).toEqual({ region: "eu", tier: "gold" });

    const updated = await repo.updateSharePointTemplate(TEMPLATE_A, {
      name: "Renamed",
      settings: { sharing: "externalUserSharingOnly" },
    });
    expect(updated?.name).toBe("Renamed");
    expect(updated?.settings).toEqual({ sharing: "externalUserSharingOnly" });
    expect(updated?.variables).toEqual({ region: "eu", tier: "gold" });
    expect((await repo.listSharePointTemplates()).map((t) => t.id)).toEqual([TEMPLATE_A]);
    expect(await repo.updateSharePointTemplate("missing", { name: "x" })).toBeUndefined();

    expect(
      await repo.softDeleteSharePointTemplate(TEMPLATE_A, { now: "2026-06-01T00:00:00.000Z" }),
    ).toBe(true);
    expect(await repo.getSharePointTemplate(TEMPLATE_A)).toBeUndefined();
    expect(await repo.listSharePointTemplates()).toHaveLength(0);
    expect(
      (await repo.getSharePointTemplate(TEMPLATE_A, { includeDeleted: true }))?.deletedAt,
    ).toBe("2026-06-01T00:00:00.000Z");
    expect(await repo.softDeleteSharePointTemplate(TEMPLATE_A)).toBe(false);
    repo.close();
  });
});

describe("secrets", () => {
  it("stores only JSON text and has no secret-value column", async () => {
    const filename = tempDbPath();
    const repo = await openSqliteRepository({ filename });
    await repo.createSharePointTemplate(template(TEMPLATE_A));
    repo.close();

    const raw = new Database(filename);
    const secretishTextColumns = new Set<string>();
    for (const table of ["sharepoint_templates", "site_operations"]) {
      const columns = raw.prepare(`PRAGMA table_info(${table})`).all() as Array<{
        name: string;
        type: string;
      }>;
      for (const column of columns) {
        if (column.type.toUpperCase().includes("TEXT") && /secret|password|token/i.test(column.name)) {
          secretishTextColumns.add(column.name);
        }
      }
    }
    expect([...secretishTextColumns].sort()).toEqual([]);

    const stored = raw
      .prepare("SELECT settings, variables FROM sharepoint_templates WHERE id = ?")
      .get(TEMPLATE_A) as { settings: string; variables: string };
    expect(JSON.parse(stored.settings)).toEqual({});
    expect(JSON.parse(stored.variables)).toEqual({});
    raw.close();
  });
});

describe("site operations", () => {
  it("records state transitions in place and scopes to the tenant", async () => {
    const repo = await openSqliteRepository({ filename: tempDbPath() });
    await repo.upsertTenant(tenant(TENANT_A));
    await repo.upsertTenant(tenant(TENANT_B));

    await repo.createSiteOperation(
      operation(OPERATION_A, TENANT_A, {
        siteId: "site-alpha",
        operation: "delete",
        state: "planned",
        by: "api-client-a",
        at: "2026-06-01T00:00:00.000Z",
      }),
    );

    const created = await repo.getSiteOperation(TENANT_A, OPERATION_A);
    expect(created?.state).toBe("planned");
    expect(created?.by).toBe("api-client-a");
    expect(created?.at).toBe("2026-06-01T00:00:00.000Z");
    expect(created?.result).toBeNull();

    const updated = await repo.updateSiteOperation(TENANT_A, OPERATION_A, {
      state: "applied",
      result: "deleted",
    });
    expect(updated?.state).toBe("applied");
    expect(updated?.result).toBe("deleted");
    expect(await repo.listSiteOperations(TENANT_A)).toHaveLength(1);

    expect(await repo.getSiteOperation(TENANT_B, OPERATION_A)).toBeUndefined();
    expect(await repo.listSiteOperations(TENANT_B)).toHaveLength(0);
    expect(
      await repo.updateSiteOperation(TENANT_B, OPERATION_A, { state: "failed" }),
    ).toBeUndefined();
    repo.close();
  });
});
