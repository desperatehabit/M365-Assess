// T-0783 — Graph Explorer preset migration and per-user store.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { openSqliteGraphPresetRepository } from "../src/graph-preset-repository.js";
import { loadMigrations } from "../src/sqlite-repository.js";

const USER = "user-1";
const OTHER = "user-2";

const tempDirs: string[] = [];

function tempDbPath(): string {
  const dir = mkdtempSync(join(tmpdir(), "m365-graph-presets-"));
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
    return (raw.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map(
      (row) => row.name,
    );
  } finally {
    raw.close();
  }
}

const INPUT = {
  name: "List users",
  method: "GET",
  url: "https://graph.microsoft.com/v1.0/users",
  body: { select: "id,displayName" },
} as const;

describe("graph presets migration", () => {
  it("creates graph_presets with createdBy, is re-runnable, and advances SchemaVersion", async () => {
    const filename = tempDbPath();
    const expected = loadMigrations().reduce((max, migration) => Math.max(max, migration.version), 0);
    expect(expected).toBeGreaterThanOrEqual(125);

    const first = await openSqliteGraphPresetRepository({ filename });
    expect(first.schemaVersion).toBe(expected);
    first.close();

    expect(columns(filename, "graph_presets")).toEqual(
      expect.arrayContaining([
        "id",
        "name",
        "method",
        "url",
        "body",
        "createdBy",
        "createdAt",
        "updatedAt",
      ]),
    );
    // A preset carries no tenant credential and no secret column.
    expect(columns(filename, "graph_presets")).not.toEqual(
      expect.arrayContaining(["secretRef", "clientId", "thumbprint", "tenantId"]),
    );

    const second = await openSqliteGraphPresetRepository({ filename });
    expect(second.schemaVersion).toBe(expected);
    second.close();

    const raw = new Database(filename);
    try {
      expect(
        raw.prepare("SELECT COUNT(*) AS c FROM schema_versions WHERE version = 125").get(),
      ).toMatchObject({ c: 1 });
    } finally {
      raw.close();
    }
  });
});

describe("graph preset repository", () => {
  it("persists a preset and scopes reads by createdBy", async () => {
    const filename = tempDbPath();
    const repo = await openSqliteGraphPresetRepository({ filename });
    await repo.createGraphPreset({ id: "p1", ...INPUT, createdBy: USER });
    await repo.createGraphPreset({ id: "p2", ...INPUT, createdBy: OTHER });

    expect((await repo.listGraphPresets({ createdBy: USER })).map((preset) => preset.id)).toEqual([
      "p1",
    ]);
    expect((await repo.listGraphPresets({ createdBy: OTHER })).map((preset) => preset.id)).toEqual([
      "p2",
    ]);
    expect(await repo.listGraphPresets()).toHaveLength(2);
    repo.close();
  });

  it("round-trips the body JSON and returns undefined for an unknown id", async () => {
    const filename = tempDbPath();
    const repo = await openSqliteGraphPresetRepository({ filename });
    const created = await repo.createGraphPreset({ id: "p1", ...INPUT, createdBy: USER });

    expect(created.body).toEqual(INPUT.body);
    expect(created.createdBy).toBe(USER);
    expect(await repo.getGraphPreset("missing")).toBeUndefined();
    repo.close();
  });

  it("hard-deletes a preset", async () => {
    const filename = tempDbPath();
    const repo = await openSqliteGraphPresetRepository({ filename });
    await repo.createGraphPreset({ id: "p1", ...INPUT, createdBy: USER });

    expect(await repo.deleteGraphPreset("p1")).toBe(true);
    expect(await repo.deleteGraphPreset("p1")).toBe(false);
    expect(await repo.getGraphPreset("p1")).toBeUndefined();
    repo.close();
  });
});
