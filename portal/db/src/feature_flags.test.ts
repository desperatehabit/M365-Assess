import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import type { FeatureFlagInput } from "./repository.js";
import { loadMigrations, openSqliteRepository } from "./sqlite-repository.js";

const tempDirs: string[] = [];

function tempDbPath(): string {
  const dir = mkdtempSync(join(tmpdir(), "m365-feature-flags-"));
  tempDirs.push(dir);
  return join(dir, "portal.db");
}

afterEach(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
  tempDirs.length = 0;
});

function flag(key: string, extra: Partial<FeatureFlagInput> = {}): FeatureFlagInput {
  return {
    key,
    enabled: true,
    description: `${key} description`,
    updatedBy: null,
    ...extra,
  };
}

describe("migration 0048", () => {
  it("creates the SPEC §5 columns, is re-runnable, and advances SchemaVersion", async () => {
    const filename = tempDbPath();
    const expected = loadMigrations().reduce((max, migration) => Math.max(max, migration.version), 0);
    expect(expected).toBeGreaterThanOrEqual(48);

    const first = await openSqliteRepository({ filename });
    expect(first.schemaVersion).toBe(expected);
    expect(await first.getFeatureFlags()).toEqual([]);
    first.close();

    const raw = new Database(filename);
    try {
      const columns = (
        raw.prepare("PRAGMA table_info(feature_flags)").all() as Array<{ name: string }>
      ).map((row) => row.name);
      expect(columns).toEqual(
        expect.arrayContaining(["key", "enabled", "scope", "description", "updatedAt", "updatedBy"]),
      );
      expect(
        raw.prepare("SELECT COUNT(*) AS c FROM schema_versions WHERE version = 48").get(),
      ).toMatchObject({ c: 1 });
    } finally {
      raw.close();
    }

    const second = await openSqliteRepository({ filename });
    expect(second.schemaVersion).toBe(expected);
    second.close();
  });
});

describe("repository surface", () => {
  it("exposes feature flag get/upsert with no delete mutator", async () => {
    const repo = await openSqliteRepository({ filename: tempDbPath() });
    expect(typeof repo.getFeatureFlags).toBe("function");
    expect(typeof repo.getFeatureFlag).toBe("function");
    expect(typeof repo.upsertFeatureFlag).toBe("function");
    expect((repo as unknown as Record<string, unknown>)["deleteFeatureFlag"]).toBeUndefined();
    repo.close();
  });
});

describe("feature flags", () => {
  it("round-trips a global flag through the repository", async () => {
    const repo = await openSqliteRepository({ filename: tempDbPath() });
    const created = await repo.upsertFeatureFlag(flag("reports.executive", { enabled: true }));
    expect(created).toMatchObject({
      key: "reports.executive",
      enabled: true,
      scope: "global",
      description: "reports.executive description",
    });

    const fetched = await repo.getFeatureFlag("reports.executive");
    expect(fetched).toEqual(created);

    const list = await repo.getFeatureFlags();
    expect(list).toEqual([created]);
    repo.close();
  });

  it("defaults scope to global and treats a repeated upsert as an edit", async () => {
    const repo = await openSqliteRepository({ filename: tempDbPath() });
    await repo.upsertFeatureFlag(flag("nav.diagnostics"));
    const edited = await repo.upsertFeatureFlag(
      flag("nav.diagnostics", { enabled: false, description: "deferred", updatedBy: "user-1" }),
    );
    expect(edited).toMatchObject({ enabled: false, scope: "global", updatedBy: "user-1" });
    expect(await repo.getFeatureFlags()).toHaveLength(1);
    repo.close();
  });

  it("rejects the reserved tenant scope in v1", async () => {
    const repo = await openSqliteRepository({ filename: tempDbPath() });
    await expect(
      repo.upsertFeatureFlag(flag("nav.diagnostics", { scope: "tenant" })),
    ).rejects.toMatchObject({ code: "feature_flag.tenant_scope_deferred" });
    expect(await repo.getFeatureFlags()).toEqual([]);
    repo.close();
  });

  it("writes an AuditEvent for flag upserts", async () => {
    const filename = tempDbPath();
    const repo = await openSqliteRepository({ filename });
    await repo.upsertFeatureFlag(flag("reports.executive", { updatedBy: "user-9" }));
    repo.close();

    const auditor = await openSqliteRepository({ filename });
    const events = (await auditor.listAuditEvents()).filter(
      (event) => event.action === "feature_flag.upsert",
    );
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      targetId: "reports.executive",
      targetType: "feature_flags",
      actorUserId: "user-9",
      result: "success",
    });
    auditor.close();
  });
});
