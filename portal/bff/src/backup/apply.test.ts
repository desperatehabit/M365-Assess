// Tests for the restore apply: per-table transaction with full rollback,
// the automatic pre-restore backup, before/after audit, and Idempotency-Key
// replay (EPIC-035 §4.2 steps 3-4, §8, §9, §11.4; T-0687).
import { describe, expect, it } from "vitest";
import { AppError } from "../errors.js";
import {
  BACKUP_ARCHIVE_SCHEMA_MISMATCH,
  packBackupArchive,
  type BackupRow,
  type BackupTableDump,
} from "./archive.js";
import {
  BACKUP_RESTORE_IDEMPOTENCY_REQUIRED,
  applyRestore,
  createMemoryRestoreIdempotencyStore,
  type ApplyRestoreOptions,
  type PreRestoreBackupResult,
  type RestoreApplyStore,
} from "./apply.js";
import type { BackupTableFilter } from "./collect.js";
import { BACKUP_RESTORE_TABLE_MISSING } from "./restore.js";

const SCHEMA_VERSION = 86;
const INSTANCE_VERSION = "0.0.0";
const BACKUP_ID = "bk-restore-1";

const ARCHIVE_TABLES: readonly BackupTableDump[] = [
  {
    name: "tenants",
    rows: [
      { id: "tenant-a", displayName: "Alpha" },
      { id: "tenant-b", displayName: "Bravo" },
      { id: "tenant-c", displayName: "Charlie" },
    ],
  },
  {
    name: "settings",
    rows: [
      { id: "theme", value: "dark" },
      { id: "language", value: "en" },
    ],
  },
];

function pack(
  overrides: Partial<Parameters<typeof packBackupArchive>[0]> = {},
): Buffer {
  return packBackupArchive({
    schemaVersion: SCHEMA_VERSION,
    instanceVersion: INSTANCE_VERSION,
    tables: ARCHIVE_TABLES,
    createdAt: "2026-01-02T03:04:05.000Z",
    ...overrides,
  });
}

class FakeApplyStore implements RestoreApplyStore {
  readonly schemaVersion: number;
  readonly tables = new Map<string, BackupRow[]>();
  readonly writes: string[] = [];
  readonly filters: Array<BackupTableFilter | undefined> = [];
  readonly log: string[] = [];
  transactionCalls = 0;
  failOn: string | null = null;

  constructor(schemaVersion: number = SCHEMA_VERSION) {
    this.schemaVersion = schemaVersion;
  }

  async readTable(
    name: string,
    filter?: BackupTableFilter,
  ): Promise<readonly BackupRow[] | undefined> {
    const rows = this.tables.get(name);
    if (rows === undefined) return undefined;
    if (filter?.tenantId === undefined) return rows;
    return rows.filter((row) => row["tenantId"] === filter.tenantId);
  }

  async replaceTable(
    name: string,
    rows: readonly BackupRow[],
    filter?: BackupTableFilter,
  ): Promise<void> {
    this.log.push(`write:${name}`);
    this.writes.push(name);
    this.filters.push(filter);
    if (this.failOn === name) {
      throw new Error(`replaceTable '${name}' failed`);
    }
    this.tables.set(name, [...rows]);
  }

  async transaction<T>(work: () => Promise<T>): Promise<T> {
    this.transactionCalls += 1;
    const snapshot = new Map([...this.tables].map(([name, rows]) => [name, [...rows]]));
    try {
      return await work();
    } catch (error) {
      this.tables.clear();
      for (const [name, rows] of snapshot) {
        this.tables.set(name, rows);
      }
      throw error;
    }
  }
}

interface Harness {
  readonly store: FakeApplyStore;
  readonly audits: Record<string, unknown>[];
  readonly options: ApplyRestoreOptions;
  readonly preBackupCalls: () => number;
}

function harness(
  store: FakeApplyStore,
  overrides: Partial<ApplyRestoreOptions> = {},
): Harness {
  const audits: Record<string, unknown>[] = [];
  let calls = 0;
  const preRestoreBackup = async (): Promise<PreRestoreBackupResult> => {
    calls += 1;
    store.log.push("pre-backup");
    return {
      backupId: `pre-${calls}`,
      artifactRef: `backups/pre-${calls}.zip`,
      checksum: "c".repeat(64),
      schemaVersion: store.schemaVersion,
    };
  };
  const options: ApplyRestoreOptions = {
    store,
    archive: pack(),
    backupId: BACKUP_ID,
    createdBy: "operator-1",
    idempotencyKey: "idem-1",
    preRestoreBackup,
    idempotency: createMemoryRestoreIdempotencyStore(),
    audit: async (event) => {
      audits.push(event);
    },
    now: () => new Date("2026-02-03T04:05:06.000Z"),
    newId: (() => {
      let n = 0;
      return () => `audit-${(n += 1)}`;
    })(),
    ...overrides,
  };
  return { store, audits, options, preBackupCalls: () => calls };
}

async function captureError(fn: () => Promise<unknown>): Promise<AppError> {
  try {
    await fn();
  } catch (error) {
    return error as AppError;
  }
  throw new Error("expected the function to reject");
}

describe("applyRestore", () => {
  it("applies every selected table inside one transaction", async () => {
    const store = new FakeApplyStore();
    store.tables.set("tenants", [{ id: "tenant-a", displayName: "Alpha" }]);
    store.tables.set("settings", [{ id: "theme", value: "dark" }]);
    const { options } = harness(store);

    const result = await applyRestore(options);

    expect(store.transactionCalls).toBe(1);
    expect(store.writes).toEqual(["tenants", "settings"]);
    expect(store.tables.get("tenants")).toEqual(ARCHIVE_TABLES[0]!.rows);
    expect(store.tables.get("settings")).toEqual(ARCHIVE_TABLES[1]!.rows);
    expect(result).toMatchObject({
      backupId: BACKUP_ID,
      schemaVersion: SCHEMA_VERSION,
      preRestoreBackupId: "pre-1",
      tables: ["tenants", "settings"],
      replayed: false,
    });
    expect(result.applied).toEqual([
      { table: "tenants", added: 2, changed: 0, removed: 0 },
      { table: "settings", added: 1, changed: 0, removed: 0 },
    ]);
  });

  it("takes the pre-restore backup before any mutation", async () => {
    const store = new FakeApplyStore();
    store.tables.set("tenants", []);
    store.tables.set("settings", []);
    const { options, preBackupCalls } = harness(store);

    await applyRestore(options);

    expect(preBackupCalls()).toBe(1);
    expect(store.log[0]).toBe("pre-backup");
    expect(store.log.slice(1)).toEqual(["write:tenants", "write:settings"]);
  });

  it("rolls back every table when a mid-apply write fails", async () => {
    const store = new FakeApplyStore();
    const originalTenants = [{ id: "tenant-a", displayName: "Original" }];
    const originalSettings = [{ id: "theme", value: "light" }];
    store.tables.set("tenants", originalTenants);
    store.tables.set("settings", originalSettings);
    store.failOn = "settings";
    const { options, audits } = harness(store);

    const error = await captureError(() => applyRestore(options));

    expect(error.message).toContain("settings");
    expect(store.transactionCalls).toBe(1);
    expect(store.writes).toEqual(["tenants", "settings"]);
    expect(store.tables.get("tenants")).toEqual(originalTenants);
    expect(store.tables.get("settings")).toEqual(originalSettings);
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({ action: "backup.restore", result: "failure" });
  });

  it("writes an audit event with before/after per table", async () => {
    const store = new FakeApplyStore();
    store.tables.set("tenants", [{ id: "tenant-a", displayName: "Alpha" }]);
    store.tables.set("settings", []);
    const { options, audits } = harness(store);

    await applyRestore(options);

    expect(audits).toHaveLength(1);
    const event = audits[0]!;
    expect(event).toMatchObject({
      action: "backup.restore",
      targetType: "backup",
      targetId: BACKUP_ID,
      tenantId: null,
      actorUserId: "operator-1",
      result: "success",
    });
    const before = event["before"] as { preRestoreBackupId: string; tables: unknown[] };
    const after = event["after"] as { tables: Array<{ table: string; rows: BackupRow[] }> };
    expect(before.preRestoreBackupId).toBe("pre-1");
    expect(before.tables).toHaveLength(2);
    expect(before.tables[0]).toMatchObject({
      table: "tenants",
      added: expect.any(Array),
      changed: expect.any(Array),
      removed: expect.any(Array),
    });
    expect(after.tables.map((table) => table.table)).toEqual(["tenants", "settings"]);
    expect(after.tables[0]!.rows).toEqual(ARCHIVE_TABLES[0]!.rows);
  });

  it("does not apply twice when the Idempotency-Key is replayed", async () => {
    const store = new FakeApplyStore();
    store.tables.set("tenants", []);
    store.tables.set("settings", []);
    const { options, preBackupCalls } = harness(store);

    const first = await applyRestore(options);
    const writesAfterFirst = [...store.writes];
    const second = await applyRestore(options);

    expect(first.replayed).toBe(false);
    expect(second.replayed).toBe(true);
    expect(second.preRestoreBackupId).toBe(first.preRestoreBackupId);
    expect(store.writes).toEqual(writesAfterFirst);
    expect(store.transactionCalls).toBe(1);
    expect(preBackupCalls()).toBe(1);
  });

  it("requires an Idempotency-Key before any mutation", async () => {
    const store = new FakeApplyStore();
    store.tables.set("tenants", []);
    const { options, preBackupCalls } = harness(store, { idempotencyKey: undefined });

    const error = await captureError(() => applyRestore(options));

    expect(error).toMatchObject({ code: BACKUP_RESTORE_IDEMPOTENCY_REQUIRED, status: 400 });
    expect(store.writes).toEqual([]);
    expect(preBackupCalls()).toBe(0);
  });

  it("refuses a requested table the archive does not carry", async () => {
    const store = new FakeApplyStore();
    const { options } = harness(store, { tables: ["roles"] });

    const error = await captureError(() => applyRestore(options));

    expect(error).toMatchObject({ code: BACKUP_RESTORE_TABLE_MISSING, status: 400 });
    expect(store.writes).toEqual([]);
  });

  it("refuses a schema mismatch before the pre-restore backup", async () => {
    const store = new FakeApplyStore(SCHEMA_VERSION + 1);
    const { options, preBackupCalls } = harness(store);

    const error = await captureError(() => applyRestore(options));

    expect(error).toMatchObject({ code: BACKUP_ARCHIVE_SCHEMA_MISMATCH, status: 409 });
    expect(preBackupCalls()).toBe(0);
    expect(store.writes).toEqual([]);
  });

  it("applies without a transaction seam but only when the store omits one", async () => {
    const store = new FakeApplyStore();
    store.tables.set("tenants", []);
    store.tables.set("settings", []);
    const { options } = harness(store, {
      store: {
        schemaVersion: store.schemaVersion,
        readTable: (name, filter) => store.readTable(name, filter),
        replaceTable: (name, rows, filter) => store.replaceTable(name, rows, filter),
      },
    });

    await applyRestore(options);

    expect(store.transactionCalls).toBe(0);
    expect(store.writes).toEqual(["tenants", "settings"]);
  });

  it("passes the tenant filter to both reads and writes", async () => {
    const store = new FakeApplyStore();
    store.tables.set("tenants", []);
    const { options } = harness(store, { filter: { tenantId: "tenant-a" } });

    await applyRestore(options);

    expect(store.filters.every((filter) => filter?.tenantId === "tenant-a")).toBe(true);
  });
});
