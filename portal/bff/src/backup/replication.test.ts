// Tests for backup replication: the latest archive is copied to the secondary
// same-tier location, a re-run is idempotent, a blank target or empty backup
// set is a no-op, and each copy is audited (EPIC-035 §2 US-4, §4.3, §11.3;
// T-0688).
import { describe, expect, it } from "vitest";
import type { Backup } from "@m365-assess/db";
import {
  BACKUP_REPLICATION_INVALID,
  latestBackup,
  replicateLatestBackup,
  replicationRef,
  type BackupReplicationStore,
  type ReplicationArtifactStore,
} from "./replication.js";

function backup(id: string, createdAt: string, artifactRef = `backups/${id}.zip`): Backup {
  return {
    id,
    type: "instance",
    tenantId: null,
    createdAt,
    createdBy: "operator-1",
    schemaVersion: 43,
    artifactRef,
    checksum: "a".repeat(64),
  };
}

class FakeReplicationStore implements BackupReplicationStore {
  constructor(readonly backups: readonly Backup[]) {}

  async listBackups(): Promise<Backup[]> {
    return [...this.backups];
  }
}

class FakeArtifacts implements ReplicationArtifactStore {
  readonly files = new Map<string, Buffer>();
  readonly writes: string[] = [];

  async read(ref: string): Promise<Buffer> {
    const bytes = this.files.get(ref);
    if (bytes === undefined) {
      throw new Error(`ENOENT: no such file '${ref}'`);
    }
    return bytes;
  }

  async write(ref: string, bytes: Buffer): Promise<void> {
    this.writes.push(ref);
    this.files.set(ref, bytes);
  }

  async exists(ref: string): Promise<boolean> {
    return this.files.has(ref);
  }
}

describe("replicateLatestBackup", () => {
  it("copies the latest archive to the secondary same-tier location", async () => {
    const store = new FakeReplicationStore([
      backup("old", "2026-09-01T00:00:00.000Z"),
      backup("new", "2026-09-30T00:00:00.000Z"),
    ]);
    const artifacts = new FakeArtifacts();
    artifacts.files.set("backups/old.zip", Buffer.from("old-bytes"));
    artifacts.files.set("backups/new.zip", Buffer.from("new-bytes"));

    const result = await replicateLatestBackup({
      store,
      artifacts,
      replicationTarget: "backups-replica",
    });

    expect(result).toMatchObject({
      replicated: true,
      alreadyReplicated: false,
      sourceBackupId: "new",
      sourceRef: "backups/new.zip",
      targetRef: "backups-replica/new.zip",
    });
    expect(artifacts.files.get("backups-replica/new.zip")?.toString("utf8")).toBe("new-bytes");
  });

  it("is idempotent: a second run does not write again", async () => {
    const store = new FakeReplicationStore([backup("new", "2026-09-30T00:00:00.000Z")]);
    const artifacts = new FakeArtifacts();
    artifacts.files.set("backups/new.zip", Buffer.from("new-bytes"));
    const options = { store, artifacts, replicationTarget: "backups-replica" };

    const first = await replicateLatestBackup(options);
    const second = await replicateLatestBackup(options);

    expect(first.replicated).toBe(true);
    expect(second).toMatchObject({ replicated: false, alreadyReplicated: true, targetRef: "backups-replica/new.zip" });
    expect(artifacts.writes).toEqual(["backups-replica/new.zip"]);
  });

  it("is a no-op when replication is not configured", async () => {
    const store = new FakeReplicationStore([backup("new", "2026-09-30T00:00:00.000Z")]);
    const artifacts = new FakeArtifacts();

    const result = await replicateLatestBackup({ store, artifacts, replicationTarget: null });

    expect(result).toMatchObject({ replicated: false, alreadyReplicated: false, sourceBackupId: null });
    expect(artifacts.writes).toEqual([]);
  });

  it("is a no-op when there are no backups", async () => {
    const store = new FakeReplicationStore([]);
    const artifacts = new FakeArtifacts();

    const result = await replicateLatestBackup({
      store,
      artifacts,
      replicationTarget: "backups-replica",
    });

    expect(result.sourceBackupId).toBeNull();
    expect(artifacts.writes).toEqual([]);
  });

  it("audits a fresh copy", async () => {
    const store = new FakeReplicationStore([backup("new", "2026-09-30T00:00:00.000Z")]);
    const artifacts = new FakeArtifacts();
    artifacts.files.set("backups/new.zip", Buffer.from("new-bytes"));
    const events: Array<Record<string, unknown>> = [];

    await replicateLatestBackup({
      store,
      artifacts,
      replicationTarget: "backups-replica",
      now: () => new Date("2026-10-01T00:00:00.000Z"),
      newId: () => "audit-1",
      audit: async (event) => {
        events.push(event);
      },
    });

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      id: "audit-1",
      action: "backup.replicate",
      targetType: "backup",
      targetId: "new",
      actorType: "system",
      source: "schedule",
      after: { backupId: "new", sourceRef: "backups/new.zip", targetRef: "backups-replica/new.zip" },
    });
  });
});

describe("replicationRef", () => {
  it("joins the target prefix with the archive name", () => {
    expect(replicationRef("backups-replica", "backups/bk-1.zip")).toBe("backups-replica/bk-1.zip");
    expect(replicationRef("replica/", "backups/bk-1.zip")).toBe("replica/bk-1.zip");
  });

  it("rejects a blank target", () => {
    expect(() => replicationRef("  ", "backups/bk-1.zip")).toThrow(/non-empty same-tier prefix/);
    try {
      replicationRef("  ", "backups/bk-1.zip");
    } catch (error) {
      expect(error).toMatchObject({ code: BACKUP_REPLICATION_INVALID, status: 400 });
    }
  });
});

describe("latestBackup", () => {
  it("returns the newest backup, breaking ties by id", () => {
    expect(latestBackup([])).toBeUndefined();
    expect(latestBackup([backup("a", "2026-09-01T00:00:00.000Z"), backup("b", "2026-09-02T00:00:00.000Z")])?.id).toBe("b");
    expect(
      latestBackup([backup("a", "2026-09-02T00:00:00.000Z"), backup("b", "2026-09-02T00:00:00.000Z")])?.id,
    ).toBe("b");
  });
});
