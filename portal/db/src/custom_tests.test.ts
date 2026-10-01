import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { CustomTestNotFoundError, type CustomTestInput } from "./repository.js";
import { loadMigrations, openSqliteRepository } from "./sqlite-repository.js";

const tempDirs: string[] = [];

function tempDbPath(): string {
  const dir = mkdtempSync(join(tmpdir(), "m365-custom-tests-"));
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

interface AuditRow {
  action: string;
  targetType: string | null;
  targetId: string | null;
  before: string | null;
  after: string | null;
}

function auditRows(filename: string): AuditRow[] {
  const raw = new Database(filename);
  try {
    return raw
      .prepare("SELECT action, targetType, targetId, before, after FROM audit_events ORDER BY rowid")
      .all() as AuditRow[];
  } finally {
    raw.close();
  }
}

const TEST_A = "aaaaaaaa-0000-0000-0000-000000000000";
const VERSION_1 = "aaaaaaaa-0001-0000-0000-000000000000";
const VERSION_2 = "aaaaaaaa-0002-0000-0000-000000000000";

function customTest(id: string, extra: Partial<CustomTestInput> = {}): CustomTestInput {
  return {
    id,
    name: `Test ${id}`,
    category: "Entra",
    enabled: false,
    alertsEnabled: false,
    ...extra,
  };
}

describe("migration 0045", () => {
  it("creates the SPEC §5 tables, is re-runnable, and advances SchemaVersion", async () => {
    const filename = tempDbPath();
    const expected = loadMigrations().reduce((max, migration) => Math.max(max, migration.version), 0);
    expect(expected).toBeGreaterThanOrEqual(45);

    const first = await openSqliteRepository({ filename });
    expect(first.schemaVersion).toBe(expected);
    first.close();

    expect(columns(filename, "custom_tests")).toEqual(
      expect.arrayContaining([
        "id",
        "name",
        "category",
        "enabled",
        "alertsEnabled",
        "currentVersionId",
      ]),
    );
    expect(columns(filename, "custom_test_versions")).toEqual(
      expect.arrayContaining([
        "id",
        "testId",
        "content",
        "markdownTemplate",
        "parameters",
        "createdAt",
        "createdBy",
      ]),
    );

    const second = await openSqliteRepository({ filename });
    expect(second.schemaVersion).toBe(expected);
    second.close();

    const raw = new Database(filename);
    try {
      expect(
        raw.prepare("SELECT COUNT(*) AS c FROM schema_versions WHERE version = 45").get(),
      ).toMatchObject({ c: 1 });
    } finally {
      raw.close();
    }
  });
});

describe("custom test CRUD", () => {
  it("persists, reads, lists, updates, and soft-deletes a test", async () => {
    const filename = tempDbPath();
    const repo = await openSqliteRepository({ filename });
    const created = await repo.createCustomTest(customTest(TEST_A));
    expect(created.name).toBe(`Test ${TEST_A}`);
    expect(created.category).toBe("Entra");
    expect(created.enabled).toBe(false);
    expect(created.alertsEnabled).toBe(false);
    expect(created.currentVersionId).toBeNull();

    expect((await repo.getCustomTest(TEST_A))?.id).toBe(TEST_A);
    expect(await repo.getCustomTest("missing")).toBeUndefined();
    expect((await repo.listCustomTests()).map((test) => test.id)).toEqual([TEST_A]);

    const updated = await repo.updateCustomTest(TEST_A, {
      name: "Renamed",
      enabled: true,
      alertsEnabled: true,
    });
    expect(updated?.name).toBe("Renamed");
    expect(updated?.enabled).toBe(true);
    expect(updated?.alertsEnabled).toBe(true);
    expect(await repo.updateCustomTest("missing", { name: "Nope" })).toBeUndefined();

    expect(await repo.deleteCustomTest(TEST_A)).toBe(true);
    expect(await repo.getCustomTest(TEST_A)).toBeUndefined();
    expect(await repo.listCustomTests()).toHaveLength(0);
    expect((await repo.getCustomTest(TEST_A, { includeDeleted: true }))?.id).toBe(TEST_A);
    expect(await repo.deleteCustomTest(TEST_A)).toBe(false);
    repo.close();
  });

  it("lists tests ordered by name", async () => {
    const repo = await openSqliteRepository({ filename: tempDbPath() });
    await repo.createCustomTest(customTest("b", { name: "Beta" }));
    await repo.createCustomTest(customTest("a", { name: "Alpha" }));
    expect((await repo.listCustomTests()).map((test) => test.id)).toEqual(["a", "b"]);
    repo.close();
  });
});

describe("custom test versioning", () => {
  it("appends versions and repoints currentVersionId while old versions stay readable", async () => {
    const repo = await openSqliteRepository({ filename: tempDbPath() });
    await repo.createCustomTest(customTest(TEST_A));

    const first = await repo.appendCustomTestVersion({
      id: VERSION_1,
      testId: TEST_A,
      content: "Get-MgUser",
      markdownTemplate: "# Users",
      parameters: { threshold: 30 },
      createdBy: "operator",
      createdAt: "2026-01-01T00:00:00.000Z",
    });
    expect(first.testId).toBe(TEST_A);
    expect(first.parameters).toEqual({ threshold: 30 });
    expect((await repo.getCustomTest(TEST_A))?.currentVersionId).toBe(VERSION_1);

    await repo.appendCustomTestVersion({
      id: VERSION_2,
      testId: TEST_A,
      content: "Get-MgUser | Select-Object Id",
      markdownTemplate: null,
      parameters: null,
      createdBy: "operator",
      createdAt: "2026-01-02T00:00:00.000Z",
    });
    expect((await repo.getCustomTest(TEST_A))?.currentVersionId).toBe(VERSION_2);

    const versions = await repo.listCustomTestVersions(TEST_A);
    expect(versions.map((version) => version.id)).toEqual([VERSION_1, VERSION_2]);
    expect(await repo.getCustomTestVersion(VERSION_1)).toEqual(first);
    expect((await repo.getCustomTestVersion(VERSION_1))?.content).toBe("Get-MgUser");
    repo.close();
  });

  it("rejects appending a version to an unknown test", async () => {
    const repo = await openSqliteRepository({ filename: tempDbPath() });
    await expect(
      repo.appendCustomTestVersion({
        id: VERSION_1,
        testId: "missing",
        content: "Get-MgUser",
        createdBy: "operator",
      }),
    ).rejects.toBeInstanceOf(CustomTestNotFoundError);
    repo.close();
  });
});

describe("custom test version immutability", () => {
  it("exposes no update or delete path for a version", async () => {
    const repo = await openSqliteRepository({ filename: tempDbPath() });
    expect("updateCustomTestVersion" in repo).toBe(false);
    expect("deleteCustomTestVersion" in repo).toBe(false);
    expect("upsertCustomTestVersion" in repo).toBe(false);
    repo.close();
  });

  it("rejects raw updates and deletes of a version at the database", async () => {
    const filename = tempDbPath();
    const repo = await openSqliteRepository({ filename });
    await repo.createCustomTest(customTest(TEST_A));
    await repo.appendCustomTestVersion({
      id: VERSION_1,
      testId: TEST_A,
      content: "Write-Output 'one'",
      createdBy: "operator",
    });
    repo.close();

    const raw = new Database(filename);
    expect(() =>
      raw.prepare("UPDATE custom_test_versions SET content = 'tampered'").run(),
    ).toThrow(/append-only/);
    expect(() => raw.prepare("DELETE FROM custom_test_versions").run()).toThrow(/append-only/);
    expect(
      raw.prepare("SELECT content FROM custom_test_versions WHERE id = ?").get(VERSION_1),
    ).toMatchObject({ content: "Write-Output 'one'" });
    raw.close();
  });
});

describe("custom test audit emission", () => {
  it("writes an audit event for every mutation", async () => {
    const filename = tempDbPath();
    const repo = await openSqliteRepository({ filename });
    await repo.createCustomTest(customTest(TEST_A));
    await repo.appendCustomTestVersion({
      id: VERSION_1,
      testId: TEST_A,
      content: "Write-Output 'one'",
      createdBy: "operator",
    });
    await repo.updateCustomTest(TEST_A, { enabled: true });
    await repo.deleteCustomTest(TEST_A);
    repo.close();

    const rows = auditRows(filename);
    expect(rows.map((row) => row.action)).toEqual([
      "customtest.create",
      "customtest.version.create",
      "customtest.update",
      "customtest.delete",
    ]);
    expect(rows[0]?.targetType).toBe("custom_test");
    expect(rows[0]?.targetId).toBe(TEST_A);
    expect(rows[1]?.targetType).toBe("custom_test_version");
    expect(rows[1]?.targetId).toBe(VERSION_1);
    expect(JSON.parse(rows[1]?.after ?? "{}")).toMatchObject({
      testId: TEST_A,
      currentVersionId: VERSION_1,
    });
  });
});
