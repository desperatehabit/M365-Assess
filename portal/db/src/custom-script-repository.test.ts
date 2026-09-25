import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import {
  CustomScriptNotFoundError,
  openSqliteCustomScriptRepository,
} from "./custom-script-repository.js";
import { loadMigrations } from "./sqlite-repository.js";

const tempDirs: string[] = [];

function tempDbPath(): string {
  const dir = mkdtempSync(join(tmpdir(), "m365-scripts-"));
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
      .prepare(
        "SELECT action, targetType, targetId, before, after FROM audit_events ORDER BY rowid",
      )
      .all() as AuditRow[];
  } finally {
    raw.close();
  }
}

const SCRIPT_A = "cccccccc-0000-0000-0000-000000000000";
const VERSION_1 = "cccccccc-0001-0000-0000-000000000000";
const VERSION_2 = "cccccccc-0002-0000-0000-000000000000";

describe("custom script migration", () => {
  it("creates the SPEC §5 tables with the stated columns", async () => {
    const filename = tempDbPath();
    const repo = await openSqliteCustomScriptRepository({ filename });
    const expectedVersion = loadMigrations().reduce(
      (max, migration) => Math.max(max, migration.version),
      0,
    );
    expect(repo.schemaVersion).toBe(expectedVersion);
    repo.close();

    expect(columns(filename, "custom_scripts")).toEqual(
      expect.arrayContaining([
        "id",
        "name",
        "author",
        "enabled",
        "alertsEnabled",
        "currentVersionId",
      ]),
    );
    expect(columns(filename, "custom_script_versions")).toEqual(
      expect.arrayContaining([
        "id",
        "scriptId",
        "content",
        "markdownTemplate",
        "parameters",
        "createdAt",
        "createdBy",
      ]),
    );
  });

  it("is forward-only and re-runnable without dropping stored scripts", async () => {
    const filename = tempDbPath();
    const first = await openSqliteCustomScriptRepository({ filename });
    await first.registerScript({ id: SCRIPT_A, name: "Inactive users", author: "operator" });
    const version = first.schemaVersion;
    first.close();

    const second = await openSqliteCustomScriptRepository({ filename });
    expect(second.schemaVersion).toBe(version);
    expect(await second.listScripts()).toHaveLength(1);
    second.close();
  });
});

describe("register and versioning", () => {
  it("starts with no current version and advances the pointer on each save", async () => {
    const repo = await openSqliteCustomScriptRepository({ filename: tempDbPath() });
    const script = await repo.registerScript({
      id: SCRIPT_A,
      name: "Inactive users",
      author: "operator",
    });
    expect(script.currentVersionId).toBeNull();
    expect(script.enabled).toBe(false);
    expect(script.alertsEnabled).toBe(false);

    await repo.appendVersion({
      id: VERSION_1,
      scriptId: SCRIPT_A,
      content: "Get-MgUser -Filter \"accountEnabled eq false\"",
      markdownTemplate: "# Inactive users",
      parameters: { thresholdDays: 30 },
      createdBy: "operator",
      createdAt: "2026-01-01T00:00:00.000Z",
    });
    expect((await repo.getScript(SCRIPT_A))?.currentVersionId).toBe(VERSION_1);

    await repo.appendVersion({
      id: VERSION_2,
      scriptId: SCRIPT_A,
      content: "Get-MgUser -Filter \"accountEnabled eq false\" | Select-Object Id",
      markdownTemplate: "# Inactive users v2",
      parameters: null,
      createdBy: "operator",
      createdAt: "2026-01-02T00:00:00.000Z",
    });
    expect((await repo.getScript(SCRIPT_A))?.currentVersionId).toBe(VERSION_2);
    repo.close();
  });

  it("never mutates an earlier version when a new one is saved", async () => {
    const filename = tempDbPath();
    const repo = await openSqliteCustomScriptRepository({ filename });
    await repo.registerScript({ id: SCRIPT_A, name: "Inactive users", author: "operator" });
    const original = await repo.appendVersion({
      id: VERSION_1,
      scriptId: SCRIPT_A,
      content: "Write-Output 'one'",
      markdownTemplate: null,
      parameters: { a: 1 },
      createdBy: "operator",
      createdAt: "2026-01-01T00:00:00.000Z",
    });

    await repo.appendVersion({
      id: VERSION_2,
      scriptId: SCRIPT_A,
      content: "Write-Output 'two'",
      markdownTemplate: null,
      parameters: null,
      createdBy: "operator",
      createdAt: "2026-01-02T00:00:00.000Z",
    });

    const versions = await repo.listVersions(SCRIPT_A);
    expect(versions.map((version) => version.id)).toEqual([VERSION_1, VERSION_2]);
    expect(versions.find((version) => version.id === VERSION_1)).toEqual(original);
    expect((await repo.getVersion(VERSION_1))?.content).toBe("Write-Output 'one'");
    repo.close();
  });

  it("rejects appending a version to an unknown script", async () => {
    const repo = await openSqliteCustomScriptRepository({ filename: tempDbPath() });
    await expect(
      repo.appendVersion({
        id: VERSION_1,
        scriptId: "missing-script",
        content: "Write-Output 'x'",
        createdBy: "operator",
      }),
    ).rejects.toBeInstanceOf(CustomScriptNotFoundError);
    repo.close();
  });
});

describe("version immutability", () => {
  it("exposes no update or delete path for a version", async () => {
    const repo = await openSqliteCustomScriptRepository({ filename: tempDbPath() });
    expect("updateVersion" in repo).toBe(false);
    expect("deleteVersion" in repo).toBe(false);
    expect("upsertVersion" in repo).toBe(false);
    repo.close();
  });

  it("rejects raw updates and deletes of a version at the database", async () => {
    const filename = tempDbPath();
    const repo = await openSqliteCustomScriptRepository({ filename });
    await repo.registerScript({ id: SCRIPT_A, name: "Inactive users", author: "operator" });
    await repo.appendVersion({
      id: VERSION_1,
      scriptId: SCRIPT_A,
      content: "Write-Output 'one'",
      createdBy: "operator",
    });
    repo.close();

    const raw = new Database(filename);
    expect(() =>
      raw.prepare("UPDATE custom_script_versions SET content = 'tampered'").run(),
    ).toThrow(/append-only/);
    expect(() => raw.prepare("DELETE FROM custom_script_versions").run()).toThrow(/append-only/);
    expect(
      raw.prepare("SELECT content FROM custom_script_versions WHERE id = ?").get(VERSION_1),
    ).toMatchObject({ content: "Write-Output 'one'" });
    raw.close();
  });
});

describe("flag toggles", () => {
  it("toggles enabled and alertsEnabled independently", async () => {
    const repo = await openSqliteCustomScriptRepository({ filename: tempDbPath() });
    await repo.registerScript({ id: SCRIPT_A, name: "Inactive users", author: "operator" });

    await repo.setScriptFlags({ scriptId: SCRIPT_A, enabled: true });
    let script = await repo.getScript(SCRIPT_A);
    expect(script?.enabled).toBe(true);
    expect(script?.alertsEnabled).toBe(false);

    await repo.setScriptFlags({ scriptId: SCRIPT_A, alertsEnabled: true });
    script = await repo.getScript(SCRIPT_A);
    expect(script?.enabled).toBe(true);
    expect(script?.alertsEnabled).toBe(true);

    await repo.setScriptFlags({ scriptId: SCRIPT_A, enabled: false });
    script = await repo.getScript(SCRIPT_A);
    expect(script?.enabled).toBe(false);
    expect(script?.alertsEnabled).toBe(true);

    expect(await repo.setScriptFlags({ scriptId: "missing-script", enabled: true })).toBeUndefined();
    repo.close();
  });
});

describe("audit emission", () => {
  it("writes an audit event for every mutation", async () => {
    const filename = tempDbPath();
    const repo = await openSqliteCustomScriptRepository({ filename });
    const actor = {
      actorUserId: "operator-1",
      actorType: "user" as const,
      source: "request" as const,
      correlationId: "corr-script-1",
    };

    await repo.registerScript({
      id: SCRIPT_A,
      name: "Inactive users",
      author: "operator",
      actor,
    });
    await repo.appendVersion({
      id: VERSION_1,
      scriptId: SCRIPT_A,
      content: "Write-Output 'one'",
      createdBy: "operator",
      actor,
    });
    await repo.setScriptFlags({ scriptId: SCRIPT_A, enabled: true, actor });
    repo.close();

    const rows = auditRows(filename);
    expect(rows.map((row) => row.action)).toEqual([
      "script.create",
      "script.version.create",
      "script.update",
    ]);
    expect(rows[0]?.targetType).toBe("customScript");
    expect(rows[0]?.targetId).toBe(SCRIPT_A);
    expect(rows[1]?.targetType).toBe("customScriptVersion");
    expect(rows[1]?.targetId).toBe(VERSION_1);
    expect(JSON.parse(rows[1]?.after ?? "{}")).toMatchObject({
      scriptId: SCRIPT_A,
      currentVersionId: VERSION_1,
    });
  });

  it("does not audit a no-op toggle", async () => {
    const filename = tempDbPath();
    const repo = await openSqliteCustomScriptRepository({ filename });
    await repo.registerScript({ id: SCRIPT_A, name: "Inactive users", author: "operator" });
    await repo.setScriptFlags({ scriptId: SCRIPT_A, enabled: false });
    repo.close();

    expect(auditRows(filename).map((row) => row.action)).toEqual(["script.create"]);
  });
});
