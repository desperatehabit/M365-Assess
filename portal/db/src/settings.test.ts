import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { loadMigrations, openSqliteRepository } from "./sqlite-repository.js";

const tempDirs: string[] = [];

function tempDbPath(): string {
  const dir = mkdtempSync(join(tmpdir(), "m365-settings-"));
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

describe("migration 0046", () => {
  it("creates the app_settings table, is re-runnable, and advances SchemaVersion", async () => {
    const filename = tempDbPath();
    const expected = loadMigrations().reduce((max, migration) => Math.max(max, migration.version), 0);

    const first = await openSqliteRepository({ filename });
    expect(first.schemaVersion).toBe(expected);
    expect(await first.listSettings()).toEqual([]);
    first.close();

    expect(columns(filename, "app_settings")).toEqual(
      expect.arrayContaining(["key", "value", "scope", "updatedAt", "updatedBy"]),
    );

    const second = await openSqliteRepository({ filename });
    expect(second.schemaVersion).toBe(expected);
    second.close();

    const raw = new Database(filename);
    try {
      expect(
        raw.prepare("SELECT COUNT(*) AS c FROM schema_versions WHERE version = 46").get(),
      ).toMatchObject({ c: 1 });
    } finally {
      raw.close();
    }
  });
});

describe("repository surface", () => {
  it("exposes settings list/get/upsert with no delete mutator", async () => {
    const repo = await openSqliteRepository({ filename: tempDbPath() });
    expect(typeof repo.listSettings).toBe("function");
    expect(typeof repo.getSetting).toBe("function");
    expect(typeof repo.upsertSetting).toBe("function");
    expect((repo as unknown as Record<string, unknown>)["deleteSetting"]).toBeUndefined();
    repo.close();
  });
});

describe("app settings", () => {
  it("round-trips a typed value through upsert and get", async () => {
    const repo = await openSqliteRepository({ filename: tempDbPath() });
    const created = await repo.upsertSetting("general.sessionTimeoutMinutes", 600, {
      updatedBy: "user-1",
    });
    expect(created).toMatchObject({
      key: "general.sessionTimeoutMinutes",
      value: 600,
      scope: "global",
      updatedBy: "user-1",
    });
    expect(typeof created.updatedAt).toBe("string");

    const fetched = await repo.getSetting("general.sessionTimeoutMinutes");
    expect(fetched).toEqual(created);
    repo.close();
  });

  it("lists every setting and returns undefined for an unknown key", async () => {
    const repo = await openSqliteRepository({ filename: tempDbPath() });
    await repo.upsertSetting("general.portalName", "Contoso Portal");
    await repo.upsertSetting("security.requireMfaForAdmins", false);

    const settings = await repo.listSettings();
    expect(settings.map((setting) => setting.key)).toEqual([
      "general.portalName",
      "security.requireMfaForAdmins",
    ]);
    expect(settings[0]).toMatchObject({ value: "Contoso Portal", scope: "global" });
    expect(await repo.getSetting("general.unknown")).toBeUndefined();
    repo.close();
  });

  it("treats a repeated upsert as an edit of the same row", async () => {
    const filename = tempDbPath();
    const repo = await openSqliteRepository({ filename });
    await repo.upsertSetting("general.sessionTimeoutMinutes", 480);
    const edited = await repo.upsertSetting("general.sessionTimeoutMinutes", 720, {
      updatedBy: "user-2",
    });
    expect(edited.value).toBe(720);
    expect(edited.updatedBy).toBe("user-2");
    repo.close();

    const raw = new Database(filename);
    try {
      expect(raw.prepare("SELECT COUNT(*) AS c FROM app_settings").get()).toMatchObject({ c: 1 });
      const row = raw
        .prepare("SELECT value, updatedBy FROM app_settings WHERE key = ?")
        .get("general.sessionTimeoutMinutes") as { value: string; updatedBy: string };
      expect(row).toEqual({ value: "720", updatedBy: "user-2" });
    } finally {
      raw.close();
    }
  });

  it("stores the scope and honours a tenant scope", async () => {
    const repo = await openSqliteRepository({ filename: tempDbPath() });
    const stored = await repo.upsertSetting("general.portalName", "Contoso Portal", {
      scope: "tenant",
    });
    expect(stored.scope).toBe("tenant");
    expect((await repo.getSetting("general.portalName"))?.scope).toBe("tenant");
    repo.close();
  });

  it("writes an AuditEvent for every upsert", async () => {
    const filename = tempDbPath();
    const repo = await openSqliteRepository({ filename });
    await repo.upsertSetting("general.sessionTimeoutMinutes", 600, { updatedBy: "user-1" });
    await repo.upsertSetting("general.sessionTimeoutMinutes", 720, { updatedBy: "user-1" });
    repo.close();

    const auditor = await openSqliteRepository({ filename });
    const events = (await auditor.listAuditEvents()).filter(
      (event) => event.action === "settings.upsert",
    );
    expect(events).toHaveLength(2);
    const first = events.find((event) => event.after?.["value"] === 600);
    const second = events.find((event) => event.after?.["value"] === 720);
    expect(first).toMatchObject({
      actorType: "user",
      actorUserId: "user-1",
      targetType: "app_setting",
      targetId: "general.sessionTimeoutMinutes",
      result: "success",
      before: null,
    });
    expect(second?.before?.["value"]).toBe(600);
    expect(second?.after?.["value"]).toBe(720);
    auditor.close();
  });

  it("rejects an invalid key, an unserializable value, and an invalid scope", async () => {
    const repo = await openSqliteRepository({ filename: tempDbPath() });
    await expect(repo.upsertSetting("", 1)).rejects.toThrow(/setting key/);
    await expect(repo.upsertSetting("not a key", 1)).rejects.toThrow(/setting key/);
    await expect(repo.upsertSetting("general.portalName", Number.NaN)).rejects.toThrow(/finite/);
    await expect(repo.upsertSetting("general.portalName", Number.POSITIVE_INFINITY)).rejects.toThrow(/finite/);
    await expect(
      repo.upsertSetting("general.portalName", undefined as unknown as string),
    ).rejects.toThrow(/JSON-serializable/);
    await expect(
      repo.upsertSetting("general.portalName", "ok", { scope: "planet" as never }),
    ).rejects.toThrow(/scope/);
    expect(await repo.listSettings()).toEqual([]);
    repo.close();
  });
});
