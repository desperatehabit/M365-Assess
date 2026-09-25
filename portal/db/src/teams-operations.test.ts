import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import type { TeamOperationInput, TeamTemplateInput, TenantInput } from "./repository.js";
import { loadMigrations, openSqliteRepository } from "./sqlite-repository.js";

const TENANT_A = "11111111-1111-1111-1111-111111111111";
const TENANT_B = "22222222-2222-2222-2222-222222222222";
const TEMPLATE_A = "aaaaaaaa-5555-5555-5555-555555555555";
const OPERATION_A = "bbbbbbbb-6666-6666-6666-666666666666";

const tempDirs: string[] = [];

function tempDbPath(): string {
  const dir = mkdtempSync(join(tmpdir(), "m365-teams-"));
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

function template(id: string, extra: Partial<TeamTemplateInput> = {}): TeamTemplateInput {
  return { id, name: `Template ${id.slice(0, 4)}`, visibility: "private", ...extra };
}

function operation(
  id: string,
  tenantId: string,
  extra: Partial<TeamOperationInput> = {},
): TeamOperationInput {
  return {
    id,
    tenantId,
    teamId: `team-${id.slice(0, 4)}`,
    operation: "create",
    state: "planned",
    ...extra,
  };
}

describe("migration 0034", () => {
  it("applies after the base migrations, is re-runnable, and advances SchemaVersion", async () => {
    const filename = tempDbPath();
    const expected = loadMigrations().reduce((max, migration) => Math.max(max, migration.version), 0);
    expect(expected).toBeGreaterThanOrEqual(34);

    const first = await openSqliteRepository({ filename });
    expect(first.schemaVersion).toBe(expected);
    first.close();

    const raw = new Database(filename);
    expect(
      raw.prepare("SELECT COUNT(*) AS c FROM schema_versions WHERE version = 34").get(),
    ).toMatchObject({ c: 1 });
    const tables = (
      raw.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{
        name: string;
      }>
    ).map((row) => row.name);
    expect(tables).toEqual(expect.arrayContaining(["team_templates", "team_operations"]));
    raw.close();

    const second = await openSqliteRepository({ filename });
    expect(second.schemaVersion).toBe(expected);
    second.close();

    const rawAgain = new Database(filename);
    expect(
      rawAgain.prepare("SELECT COUNT(*) AS c FROM schema_versions WHERE version = 34").get(),
    ).toMatchObject({ c: 1 });
    rawAgain.close();
  });
});

describe("repository surface", () => {
  it("exposes TeamTemplate CRUD and TeamOperation create/get/update/list", async () => {
    const repo = await openSqliteRepository({ filename: tempDbPath() });
    const methods = [
      "createTeamTemplate",
      "getTeamTemplate",
      "listTeamTemplates",
      "updateTeamTemplate",
      "softDeleteTeamTemplate",
      "createTeamOperation",
      "getTeamOperation",
      "listTeamOperations",
      "updateTeamOperation",
    ];
    for (const method of methods) {
      expect(typeof (repo as unknown as Record<string, unknown>)[method]).toBe("function");
    }
    repo.close();
  });
});

describe("team templates", () => {
  it("round-trips owners, members, and settings as JSON and soft-deletes", async () => {
    const repo = await openSqliteRepository({ filename: tempDbPath() });
    await repo.createTeamTemplate(
      template(TEMPLATE_A, {
        owners: ["owner-a", "owner-b"],
        members: ["member-a"],
        settings: { channels: ["general", "ops"], allowGuests: false },
      }),
    );

    const stored = await repo.getTeamTemplate(TEMPLATE_A);
    expect(stored?.visibility).toBe("private");
    expect(stored?.owners).toEqual(["owner-a", "owner-b"]);
    expect(stored?.members).toEqual(["member-a"]);
    expect(stored?.settings).toEqual({ channels: ["general", "ops"], allowGuests: false });

    const updated = await repo.updateTeamTemplate(TEMPLATE_A, {
      name: "Renamed",
      visibility: "public",
      settings: { channels: ["general"] },
    });
    expect(updated?.name).toBe("Renamed");
    expect(updated?.visibility).toBe("public");
    expect(updated?.owners).toEqual(["owner-a", "owner-b"]);
    expect(updated?.settings).toEqual({ channels: ["general"] });
    expect((await repo.listTeamTemplates()).map((t) => t.id)).toEqual([TEMPLATE_A]);
    expect(await repo.updateTeamTemplate("missing", { name: "x" })).toBeUndefined();

    expect(
      await repo.softDeleteTeamTemplate(TEMPLATE_A, { now: "2026-06-01T00:00:00.000Z" }),
    ).toBe(true);
    expect(await repo.getTeamTemplate(TEMPLATE_A)).toBeUndefined();
    expect(await repo.listTeamTemplates()).toHaveLength(0);
    expect(
      (await repo.getTeamTemplate(TEMPLATE_A, { includeDeleted: true }))?.deletedAt,
    ).toBe("2026-06-01T00:00:00.000Z");
    expect(await repo.softDeleteTeamTemplate(TEMPLATE_A)).toBe(false);
    repo.close();
  });
});

describe("secrets", () => {
  it("stores only JSON text and has no secret-value column", async () => {
    const filename = tempDbPath();
    const repo = await openSqliteRepository({ filename });
    await repo.createTeamTemplate(template(TEMPLATE_A));
    repo.close();

    const raw = new Database(filename);
    const secretishTextColumns = new Set<string>();
    for (const table of ["team_templates", "team_operations"]) {
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
      .prepare("SELECT owners, members, settings FROM team_templates WHERE id = ?")
      .get(TEMPLATE_A) as { owners: string; members: string; settings: string };
    expect(JSON.parse(stored.owners)).toEqual([]);
    expect(JSON.parse(stored.members)).toEqual([]);
    expect(JSON.parse(stored.settings)).toEqual({});
    raw.close();
  });
});

describe("team operations", () => {
  it("records state transitions in place and scopes to the tenant", async () => {
    const repo = await openSqliteRepository({ filename: tempDbPath() });
    await repo.upsertTenant(tenant(TENANT_A));
    await repo.upsertTenant(tenant(TENANT_B));

    await repo.createTeamOperation(
      operation(OPERATION_A, TENANT_A, {
        teamId: "team-alpha",
        operation: "archive",
        state: "planned",
        by: "api-client-a",
        at: "2026-06-01T00:00:00.000Z",
      }),
    );

    const created = await repo.getTeamOperation(TENANT_A, OPERATION_A);
    expect(created?.state).toBe("planned");
    expect(created?.by).toBe("api-client-a");
    expect(created?.at).toBe("2026-06-01T00:00:00.000Z");
    expect(created?.result).toBeNull();

    const updated = await repo.updateTeamOperation(TENANT_A, OPERATION_A, {
      state: "applied",
      result: "archived",
    });
    expect(updated?.state).toBe("applied");
    expect(updated?.result).toBe("archived");
    expect(await repo.listTeamOperations(TENANT_A)).toHaveLength(1);

    expect(await repo.getTeamOperation(TENANT_B, OPERATION_A)).toBeUndefined();
    expect(await repo.listTeamOperations(TENANT_B)).toHaveLength(0);
    expect(
      await repo.updateTeamOperation(TENANT_B, OPERATION_A, { state: "failed" }),
    ).toBeUndefined();
    repo.close();
  });
});
