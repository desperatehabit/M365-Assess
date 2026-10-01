// Tests for backup retention pruning: expired rows and their artifacts are
// removed, unexpired rows are untouched, and each prune is audited
// (EPIC-035 §2 US-4, §4.3, §8, §10; T-0688).
import { describe, expect, it } from "vitest";
import type { Backup } from "@m365-assess/db";
import {
  BACKUP_RETENTION_INVALID,
  pruneExpiredBackups,
  requireRetentionDays,
  retentionCutoff,
  type BackupRetentionStore,
  type RetentionArtifactStore,
} from "./retention.js";

const NOW = new Date("2026-10-01T00:00:00.000Z");

function backup(id: string, createdAt: string, extra: Partial<Backup> = {}): Backup {
  return {
    id,
    type: "instance",
    tenantId: null,
    createdAt,
    createdBy: "operator-1",
    schemaVersion: 43,
    artifactRef: `backups/${id}.zip`,
    checksum: "a".repeat(64),
    ...extra,
  };
}

class FakeRetentionStore implements BackupRetentionStore {
  readonly backups = new Map<string, Backup>();
  readonly deleted: string[] = [];

  async listBackups(): Promise<Backup[]> {
    return [...this.backups.values()];
  }

  async deleteBackup(backupId: string): Promise<boolean> {
    this.deleted.push(backupId);
    return this.backups.delete(backupId);
  }
}

class FakeArtifacts implements RetentionArtifactStore {
  readonly files = new Set<string>();
  readonly removed: string[] = [];

  async remove(ref: string): Promise<void> {
    this.removed.push(ref);
    this.files.delete(ref);
  }
}

function makeStore(rows: readonly Backup[]): FakeRetentionStore {
  const store = new FakeRetentionStore();
  for (const row of rows) {
    store.backups.set(row.id, row);
  }
  return store;
}

describe("pruneExpiredBackups", () => {
  it("prunes expired backups and their artifacts and leaves unexpired ones untouched", async () => {
    const store = makeStore([
      backup("old-1", "2026-08-01T00:00:00.000Z"),
      backup("old-2", "2026-08-15T00:00:00.000Z"),
      backup("fresh-1", "2026-09-20T00:00:00.000Z"),
    ]);
    const artifacts = new FakeArtifacts();
    artifacts.files.add("backups/old-1.zip");
    artifacts.files.add("backups/old-2.zip");
    artifacts.files.add("backups/fresh-1.zip");

    const result = await pruneExpiredBackups({
      store,
      artifacts,
      retentionDays: 30,
      now: () => NOW,
    });

    expect(result.pruned.sort()).toEqual(["old-1", "old-2"]);
    expect(result.retained).toEqual(["fresh-1"]);
    expect(artifacts.removed.sort()).toEqual(["backups/old-1.zip", "backups/old-2.zip"]);
    expect([...store.backups.keys()]).toEqual(["fresh-1"]);
    expect(artifacts.files.has("backups/fresh-1.zip")).toBe(true);
  });

  it("retains a backup exactly at the retention boundary", async () => {
    const store = makeStore([backup("boundary", "2026-09-01T00:00:00.000Z")]);
    const artifacts = new FakeArtifacts();

    const result = await pruneExpiredBackups({
      store,
      artifacts,
      retentionDays: 30,
      now: () => NOW,
    });

    expect(result.pruned).toEqual([]);
    expect(result.retained).toEqual(["boundary"]);
    expect(store.backups.has("boundary")).toBe(true);
  });

  it("retains a backup with an unparseable createdAt rather than guessing", async () => {
    const store = makeStore([backup("bad-date", "not-a-date")]);
    const artifacts = new FakeArtifacts();

    const result = await pruneExpiredBackups({
      store,
      artifacts,
      retentionDays: 1,
      now: () => NOW,
    });

    expect(result.retained).toEqual(["bad-date"]);
    expect(artifacts.removed).toEqual([]);
  });

  it("audits each pruned backup with its before-image", async () => {
    const store = makeStore([
      backup("old-1", "2026-08-01T00:00:00.000Z", { tenantId: "tenant-a", type: "tenant" }),
    ]);
    const artifacts = new FakeArtifacts();
    const events: Array<Record<string, unknown>> = [];

    await pruneExpiredBackups({
      store,
      artifacts,
      retentionDays: 30,
      now: () => NOW,
      newId: () => "audit-1",
      audit: async (event) => {
        events.push(event);
      },
    });

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      id: "audit-1",
      action: "backup.prune",
      targetType: "backup",
      targetId: "old-1",
      actorType: "system",
      tenantId: "tenant-a",
      source: "schedule",
      before: { id: "old-1", artifactRef: "backups/old-1.zip" },
      after: null,
    });
  });

  it("is a no-op when nothing is expired", async () => {
    const store = makeStore([backup("fresh", "2026-09-30T00:00:00.000Z")]);
    const artifacts = new FakeArtifacts();

    const result = await pruneExpiredBackups({
      store,
      artifacts,
      retentionDays: 30,
      now: () => NOW,
    });

    expect(result.pruned).toEqual([]);
    expect(artifacts.removed).toEqual([]);
    expect(store.deleted).toEqual([]);
  });

  it("rejects an invalid retention window", async () => {
    const store = makeStore([]);
    const artifacts = new FakeArtifacts();

    await expect(
      pruneExpiredBackups({ store, artifacts, retentionDays: -1, now: () => NOW }),
    ).rejects.toMatchObject({ code: BACKUP_RETENTION_INVALID, status: 400 });
    await expect(
      pruneExpiredBackups({ store, artifacts, retentionDays: 1.5, now: () => NOW }),
    ).rejects.toMatchObject({ code: BACKUP_RETENTION_INVALID });
  });
});

describe("retentionCutoff", () => {
  it("subtracts the retention window from now", () => {
    expect(retentionCutoff(30, NOW).toISOString()).toBe("2026-09-01T00:00:00.000Z");
  });

  it("requireRetentionDays rejects non-integers and negatives", () => {
    expect(requireRetentionDays(0)).toBe(0);
    expect(() => requireRetentionDays(-2)).toThrow(/non-negative integer/);
    expect(() => requireRetentionDays("30")).toThrow(/non-negative integer/);
  });
});
