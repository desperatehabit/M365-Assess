// Tests for the restore preview: schema-version refusal, per-table
// added/changed/removed classification, scope handling, and the read-only
// guarantee (EPIC-035 §3.2, §4.2 steps 1-2, §9, §11.4; T-0686).
import { describe, expect, it } from "vitest";
import { AppError } from "../errors.js";
import {
  BACKUP_ARCHIVE_SCHEMA_MISMATCH,
  packBackupArchive,
  type BackupRow,
  type BackupTableDump,
} from "./archive.js";
import { BACKUP_RESTORE_TABLE_MISSING, previewRestore, type RestorePreviewStore } from "./restore.js";

const SCHEMA_VERSION = 86;
const INSTANCE_VERSION = "0.0.0";

const TABLES: readonly BackupTableDump[] = [
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

function pack(overrides: Partial<Parameters<typeof packBackupArchive>[0]> = {}): Buffer {
  return packBackupArchive({
    schemaVersion: SCHEMA_VERSION,
    instanceVersion: INSTANCE_VERSION,
    tables: TABLES,
    createdAt: "2026-01-02T03:04:05.000Z",
    ...overrides,
  });
}

function fakeStore(
  tables: Record<string, readonly BackupRow[]>,
  schemaVersion: number = SCHEMA_VERSION,
): { store: RestorePreviewStore; calls: string[] } {
  const calls: string[] = [];
  const store: RestorePreviewStore = {
    schemaVersion,
    async readTable(name, filter) {
      calls.push(filter === undefined ? `readTable:${name}` : `readTable:${name}:${filter.tenantId}`);
      return tables[name];
    },
  };
  return { store, calls };
}

async function captureError(fn: () => Promise<unknown>): Promise<AppError> {
  try {
    await fn();
  } catch (error) {
    return error as AppError;
  }
  throw new Error("expected the function to reject");
}

describe("previewRestore", () => {
  it("refuses a schema mismatch with a structured error and computes no diff", async () => {
    const { store, calls } = fakeStore({ tenants: [] }, SCHEMA_VERSION + 1);

    const error = await captureError(() =>
      previewRestore({ store, archive: pack(), tables: ["tenants"] }),
    );

    expect(error).toMatchObject({ code: BACKUP_ARCHIVE_SCHEMA_MISMATCH, status: 409 });
    expect(error.details?.[0]).toMatchObject({
      field: "schemaVersion",
      reason: "mismatch",
      actual: SCHEMA_VERSION,
      expected: SCHEMA_VERSION + 1,
    });
    expect(calls).toEqual([]);
  });

  it("classifies records as added/changed/removed per table", async () => {
    const { store } = fakeStore({
      tenants: [
        { displayName: "Alpha", id: "tenant-a" },
        { id: "tenant-b", displayName: "Bravo Old" },
        { id: "tenant-d", displayName: "Delta" },
      ],
      settings: [{ id: "theme", value: "dark" }],
    });

    const preview = await previewRestore({ store, archive: pack(), tables: ["tenants", "settings"] });

    expect(preview.schemaVersion).toBe(SCHEMA_VERSION);
    expect(preview.tables).toHaveLength(2);

    const tenants = preview.tables[0]!;
    expect(tenants.table).toBe("tenants");
    expect(tenants.added).toEqual([
      { kind: "added", id: "tenant-c", row: { id: "tenant-c", displayName: "Charlie" } },
    ]);
    expect(tenants.changed).toEqual([
      {
        kind: "changed",
        id: "tenant-b",
        before: { id: "tenant-b", displayName: "Bravo Old" },
        after: { id: "tenant-b", displayName: "Bravo" },
      },
    ]);
    expect(tenants.removed).toEqual([
      { kind: "removed", id: "tenant-d", row: { id: "tenant-d", displayName: "Delta" } },
    ]);

    const settings = preview.tables[1]!;
    expect(settings.table).toBe("settings");
    expect(settings.added).toEqual([
      { kind: "added", id: "language", row: { id: "language", value: "en" } },
    ]);
    expect(settings.changed).toEqual([]);
    expect(settings.removed).toEqual([]);
  });

  it("diffs every table in the archive when no scope is requested", async () => {
    const { store } = fakeStore({ tenants: [], settings: [] });

    const preview = await previewRestore({ store, archive: pack() });

    expect(preview.tables.map((table) => table.table)).toEqual(["tenants", "settings"]);
    expect(preview.tables[0]!.added).toHaveLength(3);
    expect(preview.tables[1]!.added).toHaveLength(2);
  });

  it("refuses a requested table the archive does not carry", async () => {
    const { store, calls } = fakeStore({});

    const error = await captureError(() =>
      previewRestore({ store, archive: pack(), tables: ["tenants", "roles"] }),
    );

    expect(error).toMatchObject({ code: BACKUP_RESTORE_TABLE_MISSING, status: 400 });
    expect(error.details?.[0]).toMatchObject({ field: "tables.roles", reason: "missing" });
    expect(calls).toEqual(["readTable:tenants"]);
  });

  it("performs no write: only readTable is called and repeat previews match", async () => {
    const { store, calls } = fakeStore({ tenants: [{ id: "tenant-a", displayName: "Alpha" }] });
    const archive = pack();

    const first = await previewRestore({ store, archive, tables: ["tenants"] });
    const second = await previewRestore({ store, archive, tables: ["tenants"] });

    expect(first).toEqual(second);
    expect(calls).toEqual(["readTable:tenants", "readTable:tenants"]);
  });

  it("passes the tenant filter through so a tenant preview never diffs another tenant's rows", async () => {
    const { store, calls } = fakeStore({ tenants: [] });

    await previewRestore({
      store,
      archive: pack(),
      tables: ["tenants"],
      filter: { tenantId: "tenant-a" },
    });

    expect(calls).toEqual(["readTable:tenants:tenant-a"]);
  });

  it("matches rows without an id by value", async () => {
    const archive = packBackupArchive({
      schemaVersion: SCHEMA_VERSION,
      instanceVersion: INSTANCE_VERSION,
      tables: [
        {
          name: "settings",
          rows: [
            { key: "theme", value: "dark" },
            { key: "language", value: "en" },
          ],
        },
      ],
    });
    const { store } = fakeStore({
      settings: [
        { key: "theme", value: "dark" },
        { key: "region", value: "eu" },
      ],
    });

    const preview = await previewRestore({ store, archive, tables: ["settings"] });

    const diff = preview.tables[0]!;
    expect(diff.changed).toEqual([]);
    expect(diff.added).toEqual([{ kind: "added", id: null, row: { key: "language", value: "en" } }]);
    expect(diff.removed).toEqual([{ kind: "removed", id: null, row: { key: "region", value: "eu" } }]);
  });

  it("treats a table the current repository does not have as empty", async () => {
    const { store } = fakeStore({});

    const preview = await previewRestore({ store, archive: pack(), tables: ["tenants"] });

    expect(preview.tables[0]!.added).toHaveLength(3);
    expect(preview.tables[0]!.removed).toEqual([]);
  });
});
