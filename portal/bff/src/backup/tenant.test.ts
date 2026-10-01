// Tests for the tenant-scoped configuration backup: cross-tenant isolation, the
// `tenant` Backup row, audit, and skipped tables (EPIC-035 §2 US-2, §4.1, §7;
// T-0684).
import { describe, expect, it } from "vitest";
import type { Backup, BackupInput } from "@m365-assess/db";
import { readBackupArchive, type BackupRow } from "./archive.js";
import type { BackupTableFilter } from "./collect.js";
import {
  createTenantBackup,
  TENANT_BACKUP_TABLES,
  type TenantBackupStore,
} from "./tenant.js";
import type { BackupArtifactStore } from "./instance.js";

const SCHEMA_VERSION = 86;
const INSTANCE_VERSION = "0.0.0";
const CREATED_AT = "2026-01-02T03:04:05.000Z";
const TENANT_A = "tenant-a";
const TENANT_B = "tenant-b";

/**
 * A repository that applies the tenant filter the way a real one must: a
 * `tenantId` filter returns only that tenant's rows, while no filter returns
 * every row including instance-level ones. That makes a missing filter in the
 * caller observable as a cross-tenant leak.
 */
function fakeStore(tables: Record<string, readonly BackupRow[]>): {
  store: TenantBackupStore;
  created: BackupInput[];
} {
  const created: BackupInput[] = [];
  const store: TenantBackupStore = {
    schemaVersion: SCHEMA_VERSION,
    async readTable(name, filter?: BackupTableFilter) {
      const rows = tables[name];
      if (rows === undefined) return undefined;
      if (!filter) return rows;
      return rows.filter((row) => row["tenantId"] === filter.tenantId);
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

describe("createTenantBackup", () => {
  it("writes an archive and a tenant Backup row carrying schemaVersion, artifactRef, and checksum", async () => {
    const { store, created } = fakeStore({
      template_assignments: [
        { tenantId: TENANT_A, templateId: "std-1", targetType: "tenant", targetId: TENANT_A },
      ],
      drift_deviations: [
        { tenantId: TENANT_A, id: "dev-1", standardKey: "CA-1", state: "open" },
      ],
    });
    const { artifacts, written } = fakeArtifacts();

    const result = await createTenantBackup(
      {
        store,
        artifacts,
        instanceVersion: INSTANCE_VERSION,
        now: () => new Date(CREATED_AT),
        newId: () => "bk-tenant-1",
      },
      { tenantId: TENANT_A, createdBy: "operator-1" },
    );

    expect(written).toHaveLength(1);
    expect(written[0]?.ref).toBe("backups/bk-tenant-1.zip");

    const contents = readBackupArchive(written[0]!.bytes, { instanceSchemaVersion: SCHEMA_VERSION });
    expect(contents.manifest).toMatchObject({
      schemaVersion: SCHEMA_VERSION,
      instanceVersion: INSTANCE_VERSION,
      createdAt: CREATED_AT,
    });
    expect(contents.manifest.tables.map((table) => table.name)).toEqual([
      "template_assignments",
      "drift_deviations",
    ]);

    expect(created).toHaveLength(1);
    expect(created[0]).toMatchObject({
      id: "bk-tenant-1",
      type: "tenant",
      tenantId: TENANT_A,
      createdBy: "operator-1",
      schemaVersion: SCHEMA_VERSION,
      artifactRef: "backups/bk-tenant-1.zip",
      checksum: contents.manifest.checksum,
    });
    expect(result.backup).toMatchObject({ type: "tenant", tenantId: TENANT_A });
  });

  it("contains only the requested tenant's rows and never leaks another tenant or instance rows", async () => {
    const { store } = fakeStore({
      template_assignments: [
        { tenantId: TENANT_A, templateId: "std-a", targetType: "tenant", targetId: TENANT_A },
        { tenantId: TENANT_B, templateId: "std-b", targetType: "tenant", targetId: TENANT_B },
        { tenantId: null, templateId: "std-global", targetType: "allTenants", targetId: "" },
      ],
      drift_deviations: [
        { tenantId: TENANT_A, id: "dev-a", state: "open" },
        { tenantId: TENANT_B, id: "dev-b", state: "open" },
      ],
      scheduled_tasks: [
        { tenantId: TENANT_A, id: "task-a", name: "tenant-a task" },
        { tenantId: TENANT_B, id: "task-b", name: "tenant-b task" },
      ],
    });
    const { artifacts, written } = fakeArtifacts();

    await createTenantBackup(
      { store, artifacts, instanceVersion: INSTANCE_VERSION, now: () => new Date(CREATED_AT), newId: () => "bk-iso" },
      { tenantId: TENANT_A, createdBy: "operator-1" },
    );

    const contents = readBackupArchive(written[0]!.bytes, { instanceSchemaVersion: SCHEMA_VERSION });
    for (const name of ["template_assignments", "drift_deviations", "scheduled_tasks"]) {
      const rows = contents.tables[name] ?? [];
      expect(rows.length).toBeGreaterThan(0);
      for (const row of rows) {
        expect(row["tenantId"]).toBe(TENANT_A);
      }
    }
    expect(contents.tables["template_assignments"]).toEqual([
      { tenantId: TENANT_A, templateId: "std-a", targetType: "tenant", targetId: TENANT_A },
    ]);
    expect(contents.tables["drift_deviations"]).toEqual([
      { tenantId: TENANT_A, id: "dev-a", state: "open" },
    ]);
    expect(contents.tables["scheduled_tasks"]).toEqual([
      { tenantId: TENANT_A, id: "task-a", name: "tenant-a task" },
    ]);
  });

  it("records included and skipped tables from the SPEC allow-list", async () => {
    const { store } = fakeStore({
      template_assignments: [],
      scheduled_tasks: [],
    });
    const { artifacts } = fakeArtifacts();

    const result = await createTenantBackup(
      { store, artifacts, instanceVersion: INSTANCE_VERSION, now: () => new Date(CREATED_AT), newId: () => "bk-2" },
      { tenantId: TENANT_A, createdBy: "operator-1" },
    );

    expect(result.collection.included).toEqual(["template_assignments", "scheduled_tasks"]);
    expect(result.collection.skipped).toEqual(["drift_deviations"]);
    expect(TENANT_BACKUP_TABLES).toEqual([
      "template_assignments",
      "drift_deviations",
      "scheduled_tasks",
    ]);
  });

  it("appends an audit event scoped to the tenant when an audit sink is supplied", async () => {
    const { store } = fakeStore({ template_assignments: [{ tenantId: TENANT_A, templateId: "std-a" }] });
    const { artifacts } = fakeArtifacts();
    const events: Array<Record<string, unknown>> = [];

    await createTenantBackup(
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
      { tenantId: TENANT_A, createdBy: "operator-1", correlationId: "corr-1" },
    );

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      action: "backup.create",
      targetType: "backup",
      targetId: "bk-3",
      actorUserId: "operator-1",
      tenantId: TENANT_A,
      correlationId: "corr-1",
      after: {
        id: "bk-3",
        type: "tenant",
        tenantId: TENANT_A,
        artifactRef: "backups/bk-3.zip",
        included: ["template_assignments"],
        skipped: ["drift_deviations", "scheduled_tasks"],
      },
    });
  });

  it("requires a tenantId", async () => {
    const { store } = fakeStore({});
    const { artifacts } = fakeArtifacts();

    await expect(
      createTenantBackup(
        { store, artifacts, instanceVersion: INSTANCE_VERSION },
        { tenantId: "  ", createdBy: "operator-1" },
      ),
    ).rejects.toMatchObject({ code: "backup.collect_invalid", status: 400 });
  });

  it("requires a createdBy", async () => {
    const { store } = fakeStore({});
    const { artifacts } = fakeArtifacts();

    await expect(
      createTenantBackup(
        { store, artifacts, instanceVersion: INSTANCE_VERSION },
        { tenantId: TENANT_A, createdBy: "  " },
      ),
    ).rejects.toMatchObject({ code: "backup.collect_invalid", status: 400 });
  });
});
