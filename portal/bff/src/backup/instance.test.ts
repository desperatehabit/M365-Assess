// Tests for the instance configuration backup: archive + Backup row + audit,
// secret-column exclusion, skipped tables, and the filesystem artifact tier
// (EPIC-035 §2 US-1, §4.1, §9; T-0683).
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { Backup, BackupInput } from "@m365-assess/db";
import { readBackupArchive, type BackupRow } from "./archive.js";
import {
  backupArtifactRef,
  createFileArtifactStore,
  createInstanceBackup,
  INSTANCE_BACKUP_TABLES,
  type BackupArtifactStore,
  type InstanceBackupStore,
} from "./instance.js";

const SCHEMA_VERSION = 86;
const INSTANCE_VERSION = "0.0.0";
const CREATED_AT = "2026-01-02T03:04:05.000Z";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
  tempDirs.length = 0;
});

function fakeStore(tables: Record<string, readonly BackupRow[]>): {
  store: InstanceBackupStore;
  created: BackupInput[];
} {
  const created: BackupInput[] = [];
  const store: InstanceBackupStore = {
    schemaVersion: SCHEMA_VERSION,
    async readTable(name) {
      return tables[name];
    },
    async createBackup(input) {
      created.push(input);
      return { ...input, createdAt: input.createdAt ?? CREATED_AT } as Backup;
    },
  };
  return { store, created };
}

function fakeArtifacts(): { artifacts: BackupArtifactStore; written: Array<{ ref: string; bytes: Buffer }> } {
  const written: Array<{ ref: string; bytes: Buffer }> = [];
  return {
    artifacts: {
      async write(ref, bytes) {
        written.push({ ref, bytes });
      },
    },
    written,
  };
}

describe("createInstanceBackup", () => {
  it("writes an archive and a Backup row carrying schemaVersion, artifactRef, and checksum", async () => {
    const { store, created } = fakeStore({
      tenants: [{ id: "tenant-a", displayName: "Alpha", clientSecret: "nope", credentialRef: "ref://a" }],
      settings: [{ key: "theme", value: "dark" }],
    });
    const { artifacts, written } = fakeArtifacts();

    const result = await createInstanceBackup(
      {
        store,
        artifacts,
        instanceVersion: INSTANCE_VERSION,
        now: () => new Date(CREATED_AT),
        newId: () => "bk-1",
      },
      { createdBy: "operator-1" },
    );

    expect(written).toHaveLength(1);
    expect(written[0]?.ref).toBe("backups/bk-1.zip");

    const contents = readBackupArchive(written[0]!.bytes, { instanceSchemaVersion: SCHEMA_VERSION });
    expect(contents.manifest).toMatchObject({
      schemaVersion: SCHEMA_VERSION,
      instanceVersion: INSTANCE_VERSION,
      createdAt: CREATED_AT,
    });
    expect(contents.manifest.tables.map((table) => table.name)).toEqual(["tenants", "settings"]);
    expect(contents.tables["tenants"]?.[0]).toEqual({
      id: "tenant-a",
      displayName: "Alpha",
      credentialRef: "ref://a",
    });

    expect(created).toHaveLength(1);
    expect(created[0]).toMatchObject({
      id: "bk-1",
      type: "instance",
      tenantId: null,
      createdBy: "operator-1",
      schemaVersion: SCHEMA_VERSION,
      artifactRef: "backups/bk-1.zip",
      checksum: contents.manifest.checksum,
    });
    expect(result.backup).toMatchObject({ type: "instance", tenantId: null });
  });

  it("records included and skipped tables from the SPEC allow-list", async () => {
    const { store } = fakeStore({ tenants: [], settings: [] });
    const { artifacts } = fakeArtifacts();

    const result = await createInstanceBackup(
      { store, artifacts, instanceVersion: INSTANCE_VERSION, now: () => new Date(CREATED_AT), newId: () => "bk-2" },
      { createdBy: "operator-1" },
    );

    expect(result.collection.included).toEqual(["tenants", "settings"]);
    expect(result.collection.skipped).toEqual(["roles", "templates", "alerts"]);
    expect(INSTANCE_BACKUP_TABLES).toEqual(["tenants", "roles", "templates", "alerts", "settings"]);
  });

  it("appends an audit event when an audit sink is supplied", async () => {
    const { store } = fakeStore({ tenants: [] });
    const { artifacts } = fakeArtifacts();
    const events: Array<Record<string, unknown>> = [];

    await createInstanceBackup(
      {
        store,
        artifacts,
        instanceVersion: INSTANCE_VERSION,
        now: () => new Date(CREATED_AT),
        newId: () => "bk-3",
        audit: async (event) => {
          events.push(event);
        },
      },
      { createdBy: "operator-1", correlationId: "corr-1" },
    );

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      action: "backup.create",
      targetType: "backup",
      targetId: "bk-3",
      actorUserId: "operator-1",
      tenantId: null,
      correlationId: "corr-1",
      after: {
        id: "bk-3",
        type: "instance",
        artifactRef: "backups/bk-3.zip",
        included: ["tenants"],
        skipped: ["roles", "templates", "alerts", "settings"],
      },
    });
  });

  it("requires a createdBy", async () => {
    const { store } = fakeStore({});
    const { artifacts } = fakeArtifacts();

    await expect(
      createInstanceBackup({ store, artifacts, instanceVersion: INSTANCE_VERSION }, { createdBy: "  " }),
    ).rejects.toMatchObject({ code: "backup.collect_invalid", status: 400 });
  });
});

describe("backupArtifactRef", () => {
  it("names the archive under the backups directory", () => {
    expect(backupArtifactRef("bk-9")).toBe("backups/bk-9.zip");
  });
});

describe("createFileArtifactStore", () => {
  it("writes archive bytes under the artifact root", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "m365-backup-"));
    tempDirs.push(dir);
    const store = createFileArtifactStore(dir);
    const bytes = Buffer.from("archive-bytes");

    await store.write("backups/bk-1.zip", bytes);

    expect(readFileSync(path.join(dir, "backups", "bk-1.zip"))).toEqual(bytes);
  });

  it("refuses a ref that escapes the artifact root", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "m365-backup-"));
    tempDirs.push(dir);
    const store = createFileArtifactStore(dir);

    await expect(store.write("../escape.zip", Buffer.from("x"))).rejects.toThrow(/escapes/);
  });
});
