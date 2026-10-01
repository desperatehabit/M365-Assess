import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import type { UserPreference } from "./repository.js";
import { loadMigrations, openSqliteRepository, runMigrations } from "./sqlite-repository.js";

const USER_A = "user-0000-0000-0000-0000000000a1";
const USER_B = "user-0000-0000-0000-0000000000b2";
const NOW = "2026-01-01T00:00:00.000Z";

const tempDirs: string[] = [];

function tempDbPath(): string {
  const dir = mkdtempSync(join(tmpdir(), "m365-preferences-"));
  tempDirs.push(dir);
  return join(dir, "portal.db");
}

afterEach(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
  tempDirs.length = 0;
});

function seedUsers(dbFile: string, users: readonly string[]): void {
  const raw = new Database(dbFile);
  try {
    const user = raw.prepare(
      `INSERT OR IGNORE INTO portal_users (id, upn, status, preferences, roleId, createdAt, updatedAt)
       VALUES (?, ?, 'active', NULL, NULL, ?, ?)`,
    );
    for (const id of users) user.run(id, `${id}@example.invalid`, NOW, NOW);
  } finally {
    raw.close();
  }
}

async function open(dbFile: string, users: readonly string[] = []) {
  const repo = await openSqliteRepository({ filename: dbFile });
  if (users.length > 0) seedUsers(dbFile, users);
  return repo;
}

function prefs(version: number): Record<string, unknown> {
  return {
    schemaVersion: "v1",
    general: { usageLocation: `region-${version}`, tablePageSize: 25 + version },
  };
}

describe("migration 0049", () => {
  it("creates the user_preferences table, applies once, and is re-runnable", () => {
    const migrations = loadMigrations();
    const target = migrations.reduce((max, migration) => Math.max(max, migration.version), 0);
    const db = new Database(":memory:");
    try {
      expect(runMigrations(db, migrations)).toBe(target);
      expect(runMigrations(db, migrations)).toBe(target);
      expect(
        db.prepare("SELECT COUNT(*) AS c FROM schema_versions WHERE version = 49").get(),
      ).toMatchObject({ c: 1 });

      const columns = (
        db.prepare("PRAGMA table_info(user_preferences)").all() as Array<{ name: string }>
      ).map((row) => row.name);
      expect(columns).toEqual(["userId", "prefs", "createdAt", "updatedAt"]);
    } finally {
      db.close();
    }
  });

  it("applies forward onto a database already at the previous version", () => {
    const migrations = loadMigrations();
    const db = new Database(":memory:");
    try {
      const priorMigrations = migrations.filter((migration) => migration.version < 49);
      runMigrations(db, priorMigrations);
      expect(db.prepare("SELECT MAX(version) AS v FROM schema_versions").get()).toMatchObject({
        v: 48,
      });

      const target = migrations.reduce((max, migration) => Math.max(max, migration.version), 0);
      expect(runMigrations(db, migrations)).toBe(target);
      expect(runMigrations(db, migrations)).toBe(target);
      expect(
        db.prepare("SELECT COUNT(*) AS c FROM schema_versions WHERE version = 49").get(),
      ).toMatchObject({ c: 1 });
      expect(
        (
          db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{
            name: string;
          }>
        ).map((row) => row.name),
      ).toContain("user_preferences");
    } finally {
      db.close();
    }
  });
});

describe("user preference repository", () => {
  it("exposes preference get/upsert with no delete mutator", async () => {
    const repo = await openSqliteRepository({ filename: tempDbPath() });
    expect(typeof repo.getUserPreference).toBe("function");
    expect(typeof repo.upsertUserPreference).toBe("function");
    expect((repo as unknown as Record<string, unknown>)["deleteUserPreference"]).toBeUndefined();
    repo.close();
  });

  it("returns undefined for a user with no saved preferences", async () => {
    const repo = await open(tempDbPath(), [USER_A]);
    try {
      expect(await repo.getUserPreference(USER_A)).toBeUndefined();
    } finally {
      repo.close();
    }
  });

  it("round-trips a preference record for the same user", async () => {
    const repo = await open(tempDbPath(), [USER_A]);
    try {
      const saved = await repo.upsertUserPreference(USER_A, prefs(1));
      expect(saved.userId).toBe(USER_A);
      expect(saved.prefs).toEqual(prefs(1));
      expect(saved.createdAt).not.toBeNull();
      expect(saved.updatedAt).not.toBeNull();

      const fetched = await repo.getUserPreference(USER_A);
      expect(fetched).toEqual(saved);
    } finally {
      repo.close();
    }
  });

  it("keeps preferences per-user so one user cannot read or overwrite another's", async () => {
    const filename = tempDbPath();
    const repo = await open(filename, [USER_A, USER_B]);
    try {
      await repo.upsertUserPreference(USER_A, prefs(1));
      expect(await repo.getUserPreference(USER_B)).toBeUndefined();

      await repo.upsertUserPreference(USER_B, prefs(2));
      const a = await repo.getUserPreference(USER_A);
      const b = await repo.getUserPreference(USER_B);
      expect((a as UserPreference).prefs).toEqual(prefs(1));
      expect((b as UserPreference).prefs).toEqual(prefs(2));

      const raw = new Database(filename);
      try {
        expect(raw.prepare("SELECT COUNT(*) AS c FROM user_preferences").get()).toMatchObject({ c: 2 });
      } finally {
        raw.close();
      }
    } finally {
      repo.close();
    }
  });

  it("treats a repeated upsert as an edit of the user's single row", async () => {
    const filename = tempDbPath();
    const repo = await open(filename, [USER_A]);
    try {
      const first = await repo.upsertUserPreference(USER_A, prefs(1));
      const second = await repo.upsertUserPreference(USER_A, prefs(3));
      expect(second.prefs).toEqual(prefs(3));
      expect(second.createdAt).toBe(first.createdAt);
      expect(second.updatedAt >= first.updatedAt).toBe(true);
    } finally {
      repo.close();
    }

    const raw = new Database(filename);
    try {
      expect(raw.prepare("SELECT COUNT(*) AS c FROM user_preferences").get()).toMatchObject({ c: 1 });
    } finally {
      raw.close();
    }
  });

  it("writes an AuditEvent for preference upserts", async () => {
    const filename = tempDbPath();
    const repo = await open(filename, [USER_A]);
    await repo.upsertUserPreference(USER_A, prefs(1));
    repo.close();

    const auditor = await openSqliteRepository({ filename });
    const events = (await auditor.listAuditEvents()).filter(
      (event) => event.action === "preferences.upsert",
    );
    expect(events).toHaveLength(1);
    expect(events[0]?.actorUserId).toBe(USER_A);
    expect(events[0]?.actorType).toBe("user");
    expect(events[0]?.targetId).toBe(USER_A);
    auditor.close();
  });
});
