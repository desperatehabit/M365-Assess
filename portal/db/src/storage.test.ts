import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import {
  SchemaVersionError,
  type AuditEventInput,
  type RunInput,
  type TenantInput,
} from "./repository.js";
import {
  loadMigrations,
  openSqliteRepository,
  runMigrations,
  type Migration,
} from "./sqlite-repository.js";

const TENANT_A = "11111111-1111-1111-1111-111111111111";
const TENANT_B = "22222222-2222-2222-2222-222222222222";
const RUN_A = "aaaaaaaa-0000-0000-0000-000000000000";
const FINDING_A = "ffffffff-0000-0000-0000-000000000000";

const tempDirs: string[] = [];

function tempDbPath(): string {
  const dir = mkdtempSync(join(tmpdir(), "m365-db-"));
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

function run(id: string, tenantId: string): RunInput {
  return {
    id,
    tenantId,
    trigger: "manual",
    sections: ["Identity"],
    startedAt: null,
    finishedAt: null,
    status: "queued",
    artifactPath: null,
    summaryCounts: null,
    provenance: null,
  };
}

function auditEvent(id: string, tenantId: string): AuditEventInput {
  return {
    id,
    timestamp: "2026-01-01T00:00:00.000Z",
    actorUserId: null,
    actorType: "system",
    tenantId,
    action: "run.create",
    targetType: "run",
    targetId: RUN_A,
    before: null,
    after: null,
    result: "success",
    error: null,
    source: "request",
    correlationId: "corr-0001",
  };
}

describe("migrations", () => {
  it("applies once, is re-runnable, and sets SchemaVersion", async () => {
    const filename = tempDbPath();
    const first = await openSqliteRepository({ filename });
    expect(first.schemaVersion).toBe(1);
    first.close();

    const raw = new Database(filename);
    expect(raw.prepare("SELECT COUNT(*) AS c FROM schema_versions").get()).toMatchObject({ c: 1 });
    raw.close();

    const second = await openSqliteRepository({ filename });
    expect(second.schemaVersion).toBe(1);
    second.close();

    const rawAgain = new Database(filename);
    expect(rawAgain.prepare("SELECT COUNT(*) AS c FROM schema_versions").get()).toMatchObject({
      c: 1,
    });
    expect(rawAgain.prepare("SELECT MAX(version) AS v FROM schema_versions").get()).toMatchObject({
      v: 1,
    });
    rawAgain.close();
  });

  it("is idempotent when runMigrations is invoked repeatedly", () => {
    const migrations = loadMigrations();
    const db = new Database(":memory:");
    expect(runMigrations(db, migrations)).toBe(1);
    expect(runMigrations(db, migrations)).toBe(1);
    expect(db.prepare("SELECT COUNT(*) AS c FROM schema_versions").get()).toMatchObject({ c: 1 });
    db.close();
  });

  it("rolls back a failed migration without advancing SchemaVersion", async () => {
    const filename = tempDbPath();
    const migrations: Migration[] = [
      {
        version: 1,
        name: "0001_ok.sql",
        sql: "CREATE TABLE ok (id TEXT); INSERT INTO schema_versions (version, appliedAt) VALUES (1, 'x');",
      },
      {
        version: 2,
        name: "0002_bad.sql",
        sql: "CREATE TABLE broken (id TEXT); SELECT this_function_does_not_exist();",
      },
    ];

    await expect(openSqliteRepository({ filename, migrations })).rejects.toThrow();

    const raw = new Database(filename);
    const tables = (
      raw.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{
        name: string;
      }>
    ).map((row) => row.name);
    expect(tables).toContain("ok");
    expect(tables).not.toContain("broken");
    expect(raw.prepare("SELECT MAX(version) AS v FROM schema_versions").get()).toMatchObject({
      v: 1,
    });
    raw.close();
  });

  it("gates startup on an unknown (newer) SchemaVersion", async () => {
    const filename = tempDbPath();
    const repo = await openSqliteRepository({ filename });
    repo.close();

    const raw = new Database(filename);
    raw.prepare("UPDATE schema_versions SET version = 99 WHERE version = 1").run();
    raw.close();

    await expect(openSqliteRepository({ filename })).rejects.toBeInstanceOf(SchemaVersionError);
  });
});

describe("sqlite storage", () => {
  it("enables WAL mode for on-disk databases", async () => {
    const repo = await openSqliteRepository({ filename: tempDbPath() });
    expect(repo.journalMode.toLowerCase()).toBe("wal");
    repo.close();
  });
});

describe("tenant scoping", () => {
  it("only returns rows for the requested tenant", async () => {
    const repo = await openSqliteRepository({ filename: tempDbPath() });
    await repo.upsertTenant(tenant(TENANT_A));
    await repo.upsertTenant(tenant(TENANT_B));
    await repo.createRun(run(RUN_A, TENANT_A));
    await repo.createFinding({
      id: FINDING_A,
      runId: RUN_A,
      tenantId: TENANT_A,
      checkId: "CA-REPORTONLY-001.1",
      controlName: "Example control",
      category: "Identity",
      collector: "CA",
      status: "Fail",
      severity: "High",
      currentValue: "disabled",
      recommendedValue: "enabled",
      evidence: null,
      frameworkRefs: ["CIS"],
      remediationMode: "manual",
    });

    expect(await repo.listRuns(TENANT_A)).toHaveLength(1);
    expect(await repo.getRun(TENANT_A, RUN_A)).toBeDefined();
    expect(await repo.listRuns(TENANT_B)).toHaveLength(0);
    expect(await repo.getRun(TENANT_B, RUN_A)).toBeUndefined();
    expect(await repo.listFindings(TENANT_B, RUN_A)).toHaveLength(0);
    expect(await repo.listFindings(TENANT_A, RUN_A)).toHaveLength(1);

    repo.close();
  });
});

describe("soft delete", () => {
  it("hides deleted tenants but keeps the row", async () => {
    const filename = tempDbPath();
    const repo = await openSqliteRepository({ filename });
    await repo.upsertTenant(tenant(TENANT_A));

    expect(await repo.softDeleteTenant(TENANT_A, { now: "2026-02-01T00:00:00.000Z" })).toBe(true);
    expect(await repo.getTenant(TENANT_A)).toBeUndefined();
    expect(await repo.listTenants()).toHaveLength(0);

    const hidden = await repo.getTenant(TENANT_A, { includeDeleted: true });
    expect(hidden?.deletedAt).toBe("2026-02-01T00:00:00.000Z");
    expect(await repo.listTenants({ includeDeleted: true })).toHaveLength(1);
    expect(await repo.softDeleteTenant(TENANT_A)).toBe(false);
    repo.close();

    const raw = new Database(filename);
    expect(raw.prepare("SELECT COUNT(*) AS c FROM tenants WHERE id = ?").get(TENANT_A)).toMatchObject(
      { c: 1 },
    );
    raw.close();
  });
});

describe("append-only audit", () => {
  it("appends events and exposes no update or delete path", async () => {
    const filename = tempDbPath();
    const repo = await openSqliteRepository({ filename });
    await repo.upsertTenant(tenant(TENANT_A));
    await repo.appendAuditEvent(auditEvent("eeeeeeee-0000-0000-0000-000000000000", TENANT_A));

    expect(await repo.listAuditEvents(TENANT_A)).toHaveLength(1);
    expect("updateAuditEvent" in repo).toBe(false);
    expect("deleteAuditEvent" in repo).toBe(false);
    repo.close();

    const raw = new Database(filename);
    expect(() => raw.prepare("UPDATE audit_events SET action = 'tampered'").run()).toThrow();
    expect(() => raw.prepare("DELETE FROM audit_events").run()).toThrow();
    raw.close();
  });
});
