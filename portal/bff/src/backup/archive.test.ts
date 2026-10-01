// Tests for the versioned JSON backup archive: round-trip, checksum integrity,
// schema-version refusal, and secret-column rejection (EPIC-035 §4.1, §9;
// T-0682).
import { describe, expect, it } from "vitest";
import { AppError } from "../errors.js";
import {
  BACKUP_ARCHIVE_CHECKSUM_MISMATCH,
  BACKUP_ARCHIVE_FORMAT_VERSION,
  BACKUP_ARCHIVE_INVALID,
  BACKUP_ARCHIVE_SCHEMA_MISMATCH,
  BACKUP_ARCHIVE_SECRET_COLUMN,
  BACKUP_ARCHIVE_UNSUPPORTED_VERSION,
  BACKUP_MANIFEST_FILE,
  isSecretColumn,
  packBackupArchive,
  readBackupArchive,
  type BackupTableDump,
} from "./archive.js";

const INSTANCE_VERSION = "0.0.0";
const SCHEMA_VERSION = 7;

const TABLES: readonly BackupTableDump[] = [
  {
    name: "tenants",
    rows: [
      { id: "tenant-a", displayName: "Alpha", credentialRef: "ref://tenants/a/cred" },
      { id: "tenant-b", displayName: "Bravo", credentialRef: "ref://tenants/b/cred" },
    ],
  },
  { name: "settings", rows: [{ key: "theme", value: "dark" }] },
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

function captureError(fn: () => unknown): AppError {
  try {
    fn();
  } catch (error) {
    return error as AppError;
  }
  throw new Error("expected the function to throw");
}

function mutate(buffer: Buffer, from: string, to: string): Buffer {
  expect(from.length).toBe(to.length);
  const copy = Buffer.from(buffer);
  const index = copy.indexOf(from);
  expect(index).toBeGreaterThanOrEqual(0);
  Buffer.from(to).copy(copy, index);
  return copy;
}

describe("packBackupArchive / readBackupArchive round-trip (T-0682)", () => {
  it("preserves the manifest and every table dump", () => {
    const contents = readBackupArchive(pack(), { instanceSchemaVersion: SCHEMA_VERSION });

    expect(contents.manifest).toMatchObject({
      archiveVersion: BACKUP_ARCHIVE_FORMAT_VERSION,
      epic: "EPIC-035",
      schemaVersion: SCHEMA_VERSION,
      instanceVersion: INSTANCE_VERSION,
      createdAt: "2026-01-02T03:04:05.000Z",
      tables: [
        { name: "tenants", rowCount: 2 },
        { name: "settings", rowCount: 1 },
      ],
    });
    expect(contents.manifest.checksum).toMatch(/^[0-9a-f]{64}$/);
    expect(contents.tables["tenants"]).toEqual(TABLES[0]!.rows);
    expect(contents.tables["settings"]).toEqual(TABLES[1]!.rows);
  });

  it("writes the manifest as manifest.json inside the container", () => {
    const bytes = pack();
    expect(bytes.includes(Buffer.from(BACKUP_MANIFEST_FILE))).toBe(true);
  });

  it("rejects a non-integer or missing table name", () => {
    const error = captureError(() =>
      packBackupArchive({
        schemaVersion: SCHEMA_VERSION,
        instanceVersion: INSTANCE_VERSION,
        tables: [{ name: "bad/name", rows: [] }],
      }),
    );
    expect(error).toMatchObject({ code: BACKUP_ARCHIVE_INVALID, status: 400 });
  });
});

describe("checksum validation (T-0682)", () => {
  it("fails with a structured error when a table dump is mutated", () => {
    const mutated = mutate(pack(), '"Bravo"', '"Brava"');

    const error = captureError(() => readBackupArchive(mutated, { instanceSchemaVersion: SCHEMA_VERSION }));
    expect(error).toMatchObject({
      code: BACKUP_ARCHIVE_CHECKSUM_MISMATCH,
      status: 400,
    });
    expect(error.details?.[0]?.field).toBe("checksum");
  });

  it("fails when the stored checksum itself is tampered with", () => {
    const original = pack();
    const contents = readBackupArchive(original, { instanceSchemaVersion: SCHEMA_VERSION });
    const mutated = mutate(original, contents.manifest.checksum, "0".repeat(64));

    const error = captureError(() => readBackupArchive(mutated, { instanceSchemaVersion: SCHEMA_VERSION }));
    expect(error.code).toBe(BACKUP_ARCHIVE_CHECKSUM_MISMATCH);
  });
});

describe("schema version refusal (T-0682)", () => {
  it("refuses a manifest whose schema version is newer than the instance", () => {
    const archive = pack({ schemaVersion: SCHEMA_VERSION + 1 });
    const error = captureError(() =>
      readBackupArchive(archive, { instanceSchemaVersion: SCHEMA_VERSION }),
    );
    expect(error).toMatchObject({ code: BACKUP_ARCHIVE_SCHEMA_MISMATCH, status: 409 });
    expect(error.details?.[0]).toMatchObject({
      field: "schemaVersion",
      actual: SCHEMA_VERSION + 1,
      expected: SCHEMA_VERSION,
    });
  });

  it("refuses a manifest whose schema version is older than the instance", () => {
    const archive = pack({ schemaVersion: SCHEMA_VERSION - 1 });
    const error = captureError(() =>
      readBackupArchive(archive, { instanceSchemaVersion: SCHEMA_VERSION }),
    );
    expect(error).toMatchObject({ code: BACKUP_ARCHIVE_SCHEMA_MISMATCH, status: 409 });
  });

  it("refuses an unsupported archive format version", () => {
    const archive = pack();
    const error = captureError(() =>
      readBackupArchive(archive, { instanceSchemaVersion: SCHEMA_VERSION, expectedArchiveVersion: 99 }),
    );
    expect(error).toMatchObject({ code: BACKUP_ARCHIVE_UNSUPPORTED_VERSION, status: 400 });
  });
});

describe("secret-bearing columns (T-0682)", () => {
  it("rejects a table that seeds a secret-looking column", () => {
    const error = captureError(() =>
      packBackupArchive({
        schemaVersion: SCHEMA_VERSION,
        instanceVersion: INSTANCE_VERSION,
        tables: [{ name: "credentials", rows: [{ id: "cred-1", clientSecret: "do-not-back-this-up" }] }],
      }),
    );
    expect(error).toMatchObject({ code: BACKUP_ARCHIVE_SECRET_COLUMN, status: 400 });
    expect(error.details?.[0]).toMatchObject({
      field: "credentials.clientSecret",
      reason: "secret_column",
    });
  });

  it("allows credential references and public thumbprints", () => {
    const archive = packBackupArchive({
      schemaVersion: SCHEMA_VERSION,
      instanceVersion: INSTANCE_VERSION,
      tables: [
        {
          name: "credentials",
          rows: [{ credentialRef: "ref://x", secretRef: "ref://y", certificateThumbprint: "abc123" }],
        },
      ],
    });
    expect(readBackupArchive(archive, { instanceSchemaVersion: SCHEMA_VERSION }).tables["credentials"]).toHaveLength(1);
  });

  it("classifies columns by name", () => {
    for (const column of ["password", "client_secret", "apiKey", "privateKey", "accessToken", "connectionString"]) {
      expect(isSecretColumn(column)).toBe(true);
    }
    for (const column of ["credentialRef", "secretRef", "certificateThumbprint", "displayName"]) {
      expect(isSecretColumn(column)).toBe(false);
    }
  });
});

describe("malformed archives (T-0682)", () => {
  it("rejects bytes that are not a ZIP container", () => {
    const error = captureError(() =>
      readBackupArchive(Buffer.from("not a zip"), { instanceSchemaVersion: SCHEMA_VERSION }),
    );
    expect(error).toMatchObject({ code: BACKUP_ARCHIVE_INVALID, status: 400 });
  });
});
