import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import type { FindingInput, RunInput, TestPackInput, TestRunInput } from "./repository.js";
import { loadMigrations, openSqliteRepository } from "./sqlite-repository.js";

const TENANT_A = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const TENANT_B = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";
const PACK_1 = "pack-1";
const PACK_2 = "pack-2";
const RUN_1 = "run-1";
const RUN_2 = "run-2";
const FINDING_1 = "finding-1";
const FINDING_2 = "finding-2";

const tempDirs: string[] = [];

function tempDbPath(): string {
  const dir = mkdtempSync(join(tmpdir(), "m365-test-packs-"));
  tempDirs.push(dir);
  return join(dir, "portal.db");
}

afterEach(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
  tempDirs.length = 0;
});

function columns(filename: string, table: string): string[] {
  const raw = new Database(filename);
  try {
    return (
      raw.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>
    ).map((row) => row.name);
  } finally {
    raw.close();
  }
}

async function seedTenant(filename: string, tenantId: string): Promise<void> {
  const repo = await openSqliteRepository({ filename });
  await repo.upsertTenant({
    id: tenantId,
    displayName: null,
    defaultDomain: null,
    initialDomain: null,
    source: "direct",
    status: "active",
    excluded: false,
    lastRunAt: null,
    errorCount: 0,
  });
  repo.close();
}

function pack(id: string, extra: Partial<TestPackInput> = {}): TestPackInput {
  return {
    id,
    name: `Pack ${id}`,
    description: `Description for ${id}`,
    checkIds: ["CA-REPORTONLY-001", "CA-REPORTONLY-002"],
    frameworkId: "CIS",
    scoring: { mode: "percentage" },
    ...extra,
  };
}

function sourceRun(id: string, tenantId: string): RunInput {
  return {
    id,
    tenantId,
    parentRunId: null,
    trigger: "manual",
    sections: ["Identity"],
    options: null,
    startedAt: null,
    finishedAt: null,
    status: "succeeded",
    artifactPath: null,
    summaryCounts: null,
    provenance: null,
  };
}

function finding(id: string, tenantId: string, runId: string): FindingInput {
  return {
    id,
    runId,
    tenantId,
    checkId: "CA-REPORTONLY-001",
    controlName: "MFA enabled",
    category: "Entra",
    collector: "Entra",
    status: "Fail",
    severity: "High",
    currentValue: "disabled",
    recommendedValue: "enabled",
    evidence: null,
    frameworkRefs: ["CIS"],
    remediationMode: "manual",
  };
}

function run(id: string, tenantId: string, extra: Partial<TestRunInput> = {}): TestRunInput {
  return {
    id,
    packId: PACK_1,
    tenantId,
    at: "2026-06-01T00:00:00.000Z",
    score: 0.75,
    results: [
      { findingId: FINDING_1, status: "Pass" },
      { findingId: FINDING_2, status: "Fail" },
    ],
    ...extra,
  };
}

describe("migration 0044", () => {
  it("creates the SPEC §5 tables, is re-runnable, and advances SchemaVersion", async () => {
    const filename = tempDbPath();
    const expected = loadMigrations().reduce((max, migration) => Math.max(max, migration.version), 0);
    expect(expected).toBeGreaterThanOrEqual(44);

    const first = await openSqliteRepository({ filename });
    expect(first.schemaVersion).toBe(expected);
    first.close();

    expect(columns(filename, "test_packs")).toEqual(
      expect.arrayContaining([
        "id",
        "name",
        "description",
        "checkIds",
        "frameworkId",
        "scoring",
        "createdAt",
        "updatedAt",
      ]),
    );
    expect(columns(filename, "test_runs")).toEqual(
      expect.arrayContaining(["id", "packId", "tenantId", "at", "score", "results", "createdAt"]),
    );

    const second = await openSqliteRepository({ filename });
    expect(second.schemaVersion).toBe(expected);
    second.close();

    const raw = new Database(filename);
    try {
      expect(
        raw.prepare("SELECT COUNT(*) AS c FROM schema_versions WHERE version = 44").get(),
      ).toMatchObject({ c: 1 });
    } finally {
      raw.close();
    }
  });
});

describe("test packs", () => {
  it("persists and reads a pack", async () => {
    const repo = await openSqliteRepository({ filename: tempDbPath() });
    const created = await repo.createTestPack(pack(PACK_1));
    expect(created.name).toBe(`Pack ${PACK_1}`);
    expect(created.description).toBe(`Description for ${PACK_1}`);
    expect(created.checkIds).toEqual(["CA-REPORTONLY-001", "CA-REPORTONLY-002"]);
    expect(created.frameworkId).toBe("CIS");
    expect(created.scoring).toEqual({ mode: "percentage" });

    const fetched = await repo.getTestPack(PACK_1);
    expect(fetched?.name).toBe(`Pack ${PACK_1}`);
    expect(fetched?.checkIds).toEqual(["CA-REPORTONLY-001", "CA-REPORTONLY-002"]);
    expect(await repo.getTestPack("pack-missing")).toBeUndefined();
    repo.close();
  });

  it("lists packs ordered by name", async () => {
    const repo = await openSqliteRepository({ filename: tempDbPath() });
    await repo.createTestPack(pack(PACK_2));
    await repo.createTestPack(pack(PACK_1));
    const packs = await repo.listTestPacks();
    expect(packs).toHaveLength(2);
    expect(packs.map((p) => p.id)).toEqual([PACK_1, PACK_2]);
    repo.close();
  });

  it("updates a pack and leaves a missing pack untouched", async () => {
    const repo = await openSqliteRepository({ filename: tempDbPath() });
    await repo.createTestPack(pack(PACK_1));
    const updated = await repo.updateTestPack(PACK_1, {
      description: "Updated",
      frameworkId: "E8",
    });
    expect(updated?.description).toBe("Updated");
    expect(updated?.frameworkId).toBe("E8");
    expect((await repo.getTestPack(PACK_1))?.description).toBe("Updated");
    expect(await repo.updateTestPack("pack-missing", { description: "Nope" })).toBeUndefined();
    repo.close();
  });

  it("writes an AuditEvent for pack create and update", async () => {
    const filename = tempDbPath();
    const repo = await openSqliteRepository({ filename });
    await repo.createTestPack(pack(PACK_1));
    await repo.updateTestPack(PACK_1, { description: "Updated" });
    repo.close();

    const auditor = await openSqliteRepository({ filename });
    const events = await auditor.listAuditEvents();
    expect(events.filter((event) => event.action === "testpack.create")).toHaveLength(1);
    expect(events.filter((event) => event.action === "testpack.update")).toHaveLength(1);
    auditor.close();
  });
});

describe("test runs", () => {
  async function openSeeded(filename: string) {
    await seedTenant(filename, TENANT_A);
    await seedTenant(filename, TENANT_B);
    const repo = await openSqliteRepository({ filename });
    await repo.createTestPack(pack(PACK_1));
    return repo;
  }

  it("persists and reads a run with results referencing finding rows", async () => {
    const filename = tempDbPath();
    const repo = await openSeeded(filename);
    const source = await repo.createRun(sourceRun("run-source", TENANT_A));
    await repo.createFinding(finding(FINDING_1, TENANT_A, source.id));
    await repo.createFinding(finding(FINDING_2, TENANT_A, source.id));

    const created = await repo.createTestRun(run(RUN_1, TENANT_A));
    expect(created.packId).toBe(PACK_1);
    expect(created.tenantId).toBe(TENANT_A);
    expect(created.score).toBe(0.75);
    expect(created.results).toEqual([
      { findingId: FINDING_1, status: "Pass" },
      { findingId: FINDING_2, status: "Fail" },
    ]);

    const fetched = await repo.getTestRun(TENANT_A, RUN_1);
    expect(fetched?.score).toBe(0.75);
    expect(fetched?.results).toHaveLength(2);
    expect(fetched?.results[0]?.findingId).toBe(FINDING_1);
    repo.close();

    const raw = new Database(filename);
    try {
      const row = raw
        .prepare("SELECT results FROM test_runs WHERE id = ?")
        .get(RUN_1) as { results: string };
      const parsed = JSON.parse(row.results) as Array<Record<string, unknown>>;
      expect(parsed).toHaveLength(2);
      expect(parsed[0]).toMatchObject({ findingId: FINDING_1, status: "Pass" });
      expect(parsed[0]).not.toHaveProperty("checkId");
      expect(parsed[0]).not.toHaveProperty("currentValue");
    } finally {
      raw.close();
    }
  });

  it("scopes run reads to the tenant", async () => {
    const repo = await openSeeded(tempDbPath());
    await repo.createTestRun(run(RUN_1, TENANT_A));

    expect(await repo.getTestRun(TENANT_B, RUN_1)).toBeUndefined();
    expect(await repo.listTestRuns(TENANT_B)).toHaveLength(0);
    expect(await repo.listTestRuns(TENANT_A)).toHaveLength(1);
    repo.close();
  });

  it("lists runs filtered by pack", async () => {
    const repo = await openSeeded(tempDbPath());
    await repo.createTestPack(pack(PACK_2));
    await repo.createTestRun(run(RUN_1, TENANT_A));
    await repo.createTestRun(run(RUN_2, TENANT_A, { packId: PACK_2 }));

    expect(await repo.listTestRuns(TENANT_A)).toHaveLength(2);
    const filtered = await repo.listTestRuns(TENANT_A, { packId: PACK_2 });
    expect(filtered).toHaveLength(1);
    expect(filtered[0]?.id).toBe(RUN_2);
    repo.close();
  });

  it("writes an AuditEvent for run creation", async () => {
    const filename = tempDbPath();
    const repo = await openSeeded(filename);
    await repo.createTestRun(run(RUN_1, TENANT_A));
    repo.close();

    const auditor = await openSqliteRepository({ filename });
    const events = (await auditor.listAuditEvents(TENANT_A)).filter(
      (event) => event.action === "testrun.create",
    );
    expect(events).toHaveLength(1);
    expect(events[0]?.targetId).toBe(RUN_1);
    auditor.close();
  });
});
