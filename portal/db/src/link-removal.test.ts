import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import type { LinkRemovalJobInput, TenantInput } from "./repository.js";
import { loadMigrations, openSqliteRepository } from "./sqlite-repository.js";

const TENANT_A = "11111111-1111-1111-1111-111111111111";
const TENANT_B = "22222222-2222-2222-2222-222222222222";
const JOB_A = "aaaaaaaa-5555-5555-5555-555555555555";

const tempDirs: string[] = [];

function tempDbPath(): string {
  const dir = mkdtempSync(join(tmpdir(), "m365-link-removal-"));
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

function job(id: string, tenantId: string, extra: Partial<LinkRemovalJobInput> = {}): LinkRemovalJobInput {
  return {
    id,
    tenantId,
    linkIds: ["link-1", "link-2"],
    createdBy: "operator-1",
    ...extra,
  };
}

describe("migration 0035", () => {
  it("applies after the base migrations, is re-runnable, and advances SchemaVersion", async () => {
    const filename = tempDbPath();
    const expected = loadMigrations().reduce((max, migration) => Math.max(max, migration.version), 0);
    expect(expected).toBeGreaterThanOrEqual(35);

    const first = await openSqliteRepository({ filename });
    expect(first.schemaVersion).toBe(expected);
    first.close();

    const raw = new Database(filename);
    expect(
      raw.prepare("SELECT COUNT(*) AS c FROM schema_versions WHERE version = 35").get(),
    ).toMatchObject({ c: 1 });
    const tables = (
      raw.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{
        name: string;
      }>
    ).map((row) => row.name);
    expect(tables).toContain("link_removal_jobs");
    raw.close();

    const second = await openSqliteRepository({ filename });
    expect(second.schemaVersion).toBe(expected);
    second.close();

    const rawAgain = new Database(filename);
    expect(
      rawAgain.prepare("SELECT COUNT(*) AS c FROM schema_versions WHERE version = 35").get(),
    ).toMatchObject({ c: 1 });
    rawAgain.close();
  });
});

describe("repository surface", () => {
  it("exposes LinkRemovalJob create/get/update/list", async () => {
    const repo = await openSqliteRepository({ filename: tempDbPath() });
    const methods = [
      "createLinkRemovalJob",
      "getLinkRemovalJob",
      "listLinkRemovalJobs",
      "updateLinkRemovalJob",
    ];
    for (const method of methods) {
      expect(typeof (repo as unknown as Record<string, unknown>)[method]).toBe("function");
    }
    repo.close();
  });
});

describe("link removal jobs", () => {
  it("round-trips linkIds and results as JSON and scopes to the tenant", async () => {
    const repo = await openSqliteRepository({ filename: tempDbPath() });
    await repo.upsertTenant(tenant(TENANT_A));
    await repo.upsertTenant(tenant(TENANT_B));

    await repo.createLinkRemovalJob(
      job(JOB_A, TENANT_A, { linkIds: ["link-1", "link-2"], createdBy: "operator-1" }),
    );

    const created = await repo.getLinkRemovalJob(TENANT_A, JOB_A);
    expect(created?.linkIds).toEqual(["link-1", "link-2"]);
    expect(created?.state).toBe("planned");
    expect(created?.results).toBeNull();
    expect(created?.createdBy).toBe("operator-1");
    expect(created?.createdAt).toBeTruthy();

    const updated = await repo.updateLinkRemovalJob(TENANT_A, JOB_A, {
      state: "completed",
      results: { "link-1": { removed: true }, "link-2": { removed: false, error: "missing" } },
    });
    expect(updated?.state).toBe("completed");
    expect(updated?.results).toEqual({
      "link-1": { removed: true },
      "link-2": { removed: false, error: "missing" },
    });
    expect(updated?.linkIds).toEqual(["link-1", "link-2"]);

    expect((await repo.listLinkRemovalJobs(TENANT_A)).map((j) => j.id)).toEqual([JOB_A]);

    expect(await repo.getLinkRemovalJob(TENANT_B, JOB_A)).toBeUndefined();
    expect(await repo.listLinkRemovalJobs(TENANT_B)).toHaveLength(0);
    expect(
      await repo.updateLinkRemovalJob(TENANT_B, JOB_A, { state: "failed" }),
    ).toBeUndefined();

    repo.close();
  });
});

describe("secrets", () => {
  it("stores linkIds/results as JSON text and has no secret-value column", async () => {
    const filename = tempDbPath();
    const repo = await openSqliteRepository({ filename });
    await repo.upsertTenant(tenant(TENANT_A));
    await repo.createLinkRemovalJob(job(JOB_A, TENANT_A));
    repo.close();

    const raw = new Database(filename);
    const secretishTextColumns = raw
      .prepare("PRAGMA table_info(link_removal_jobs)")
      .all() as Array<{ name: string; type: string }>;
    expect(
      secretishTextColumns.filter(
        (column) => column.type.toUpperCase().includes("TEXT") && /secret|password|token/i.test(column.name),
      ),
    ).toEqual([]);

    const stored = raw
      .prepare("SELECT linkIds, results FROM link_removal_jobs WHERE id = ?")
      .get(JOB_A) as { linkIds: string; results: string | null };
    expect(JSON.parse(stored.linkIds)).toEqual(["link-1", "link-2"]);
    expect(stored.results).toBeNull();
    raw.close();
  });
});
