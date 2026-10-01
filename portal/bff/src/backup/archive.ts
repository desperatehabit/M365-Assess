// Versioned JSON backup archive (EPIC-035 SPEC.md §4.1 steps 2-3, §9, §11.2; T-0682).
//
// The archive is a single ZIP container holding `manifest.json` plus one JSON
// dump per configuration table. The manifest records the archive/epic version,
// the producing instance version, the schema version, the timestamp, the table
// list with per-table row counts, and a checksum over the manifest body and the
// dumps. This layer is pure I/O: it never touches the repository or the artifact
// store, and it refuses to pack a table that carries a secret-bearing column so
// a backup can only ever hold credential *references* (SPEC §9).
import { createHash } from "node:crypto";
import { AppError } from "../errors.js";

export const BACKUP_ARCHIVE_FORMAT_VERSION = 1;
export const BACKUP_ARCHIVE_EPIC = "EPIC-035";
export const BACKUP_MANIFEST_FILE = "manifest.json";

export const BACKUP_ARCHIVE_UNSUPPORTED_VERSION = "backup.archive.unsupported_version";
export const BACKUP_ARCHIVE_SCHEMA_MISMATCH = "backup.archive.schema_mismatch";
export const BACKUP_ARCHIVE_CHECKSUM_MISMATCH = "backup.archive.checksum_mismatch";
export const BACKUP_ARCHIVE_INVALID = "backup.archive.invalid";
export const BACKUP_ARCHIVE_SECRET_COLUMN = "backup.archive.secret_column";

export type BackupRow = Record<string, unknown>;

export interface BackupTableDump {
  readonly name: string;
  readonly rows: readonly BackupRow[];
}

export interface BackupManifestTable {
  readonly name: string;
  readonly rowCount: number;
}

export interface BackupManifest {
  readonly archiveVersion: number;
  readonly epic: string;
  readonly schemaVersion: number;
  readonly instanceVersion: string;
  readonly createdAt: string;
  readonly tables: readonly BackupManifestTable[];
  readonly checksum: string;
}

export interface BackupArchiveContents {
  readonly manifest: BackupManifest;
  readonly tables: Readonly<Record<string, readonly BackupRow[]>>;
}

export interface PackBackupArchiveOptions {
  readonly schemaVersion: number;
  readonly instanceVersion: string;
  readonly tables: readonly BackupTableDump[];
  readonly createdAt?: string;
  readonly epic?: string;
}

export interface ReadBackupArchiveOptions {
  readonly instanceSchemaVersion: number;
  readonly expectedArchiveVersion?: number;
}

const TABLE_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.-]*$/;

// Column names are normalised (lowercase, separators dropped) before matching so
// `client_secret`, `clientSecret`, and `Client-Secret` are treated alike.
const SECRET_COLUMN_PATTERN =
  /(password|passwd|pwd|secret|token|apikey|privatekey|clientsecret|clientcert|partnercert|connectionstring|passphrase|credential|certificate|accountkey|accesskey)/;
// A reference or a public identifier (e.g. `secretRef`, `certificateThumbprint`)
// points at material without carrying it, so it is allowed through.
const REFERENCE_SUFFIX_PATTERN = /(ref|reference|thumbprint)$/;

function invalid(message: string, field: string, reason = "invalid"): AppError {
  return new AppError(BACKUP_ARCHIVE_INVALID, message, 400, [{ field, reason }]);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeColumnName(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]/g, "");
}

/** True when a column name looks like it would carry secret material. */
export function isSecretColumn(column: string): boolean {
  const normalized = normalizeColumnName(column);
  if (REFERENCE_SUFFIX_PATTERN.test(normalized)) {
    return false;
  }
  return SECRET_COLUMN_PATTERN.test(normalized);
}

function assertNoSecretColumns(tables: readonly BackupTableDump[]): void {
  const offenders: { table: string; column: string }[] = [];
  for (const table of tables) {
    const seen = new Set<string>();
    for (const row of table.rows) {
      for (const column of Object.keys(row)) {
        if (seen.has(column)) continue;
        seen.add(column);
        if (isSecretColumn(column)) {
          offenders.push({ table: table.name, column });
        }
      }
    }
  }
  if (offenders.length > 0) {
    throw new AppError(
      BACKUP_ARCHIVE_SECRET_COLUMN,
      "backup archive refuses secret-bearing columns; store a credential reference instead",
      400,
      offenders.map((entry) => ({
        field: `${entry.table}.${entry.column}`,
        reason: "secret_column",
        table: entry.table,
        column: entry.column,
      })),
    );
  }
}

function assertTableNames(tables: readonly BackupTableDump[]): void {
  const seen = new Set<string>();
  for (const table of tables) {
    if (typeof table.name !== "string" || !TABLE_NAME_PATTERN.test(table.name)) {
      throw invalid(`table name '${String(table.name)}' is not a valid identifier`, "tables.name");
    }
    const key = table.name.toLowerCase();
    if (key === "manifest") {
      throw invalid("'manifest' is reserved for the archive manifest", "tables.name", "reserved");
    }
    if (seen.has(key)) {
      throw invalid(`duplicate table '${table.name}' in archive`, "tables.name", "duplicate");
    }
    seen.add(key);
  }
}

export function tableDumpFileName(tableName: string): string {
  return `${tableName}.json`;
}

/** Deterministic JSON so the checksum is independent of key insertion order. */
function stableStringify(value: unknown): string {
  if (value === undefined) return "null";
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value) ?? "null";
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableStringify(item)).join(",")}]`;
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`).join(",")}}`;
}

function computeChecksum(
  manifestBody: Omit<BackupManifest, "checksum">,
  tables: readonly BackupTableDump[],
): string {
  const dumps: Record<string, readonly BackupRow[]> = {};
  for (const table of tables) {
    dumps[table.name] = table.rows;
  }
  const canonical = stableStringify({ manifest: manifestBody, dumps });
  return createHash("sha256").update(canonical).digest("hex");
}

const CRC32_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buffer: Buffer): number {
  let crc = 0xffffffff;
  for (let i = 0; i < buffer.length; i += 1) {
    crc = CRC32_TABLE[(crc ^ buffer[i]!) & 0xff]! ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

interface ZipEntry {
  readonly name: string;
  readonly data: Buffer;
}

// Stored (uncompressed) entries: JSON dumps are small and a stored container is
// a valid ZIP while keeping the byte layout stable for integrity checks.
function buildZip(entries: readonly ZipEntry[]): Buffer {
  const localParts: Buffer[] = [];
  const centralParts: Buffer[] = [];
  const dosTime = 0;
  const dosDate = 0x0021; // 1980-01-01, the minimum valid DOS date
  let offset = 0;

  for (const entry of entries) {
    const nameBuffer = Buffer.from(entry.name, "utf8");
    const crc = crc32(entry.data);
    const size = entry.data.length;

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6); // UTF-8 file name
    local.writeUInt16LE(0, 8); // stored
    local.writeUInt16LE(dosTime, 10);
    local.writeUInt16LE(dosDate, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(size, 18);
    local.writeUInt32LE(size, 22);
    local.writeUInt16LE(nameBuffer.length, 26);
    local.writeUInt16LE(0, 28);
    localParts.push(local, nameBuffer, entry.data);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(0, 10); // stored
    central.writeUInt16LE(dosTime, 12);
    central.writeUInt16LE(dosDate, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(size, 20);
    central.writeUInt32LE(size, 24);
    central.writeUInt16LE(nameBuffer.length, 28);
    central.writeUInt16LE(0, 30);
    central.writeUInt16LE(0, 32);
    central.writeUInt16LE(0, 34);
    central.writeUInt16LE(0, 36);
    central.writeUInt32LE(0, 38);
    central.writeUInt32LE(offset, 42);
    centralParts.push(central, nameBuffer);

    offset += local.length + nameBuffer.length + entry.data.length;
  }

  const centralBuffer = Buffer.concat(centralParts);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralBuffer.length, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(0, 20);

  return Buffer.concat([...localParts, centralBuffer, eocd]);
}

function findEndOfCentralDirectory(buffer: Buffer): number {
  for (let i = buffer.length - 22; i >= 0; i -= 1) {
    if (buffer.readUInt32LE(i) === 0x06054b50) {
      return i;
    }
  }
  return -1;
}

function readZip(buffer: Buffer): Map<string, Buffer> {
  const eocd = findEndOfCentralDirectory(buffer);
  if (eocd < 0) {
    throw invalid("archive is not a valid ZIP container", "archive");
  }
  const entryCount = buffer.readUInt16LE(eocd + 10);
  let cursor = buffer.readUInt32LE(eocd + 16);
  const entries = new Map<string, Buffer>();

  for (let i = 0; i < entryCount; i += 1) {
    if (cursor + 46 > buffer.length || buffer.readUInt32LE(cursor) !== 0x02014b50) {
      throw invalid("archive central directory is corrupt", "archive");
    }
    const method = buffer.readUInt16LE(cursor + 10);
    const compressedSize = buffer.readUInt32LE(cursor + 20);
    const nameLength = buffer.readUInt16LE(cursor + 28);
    const extraLength = buffer.readUInt16LE(cursor + 30);
    const commentLength = buffer.readUInt16LE(cursor + 32);
    const localOffset = buffer.readUInt32LE(cursor + 42);
    const name = buffer.toString("utf8", cursor + 46, cursor + 46 + nameLength);

    if (localOffset + 30 > buffer.length || buffer.readUInt32LE(localOffset) !== 0x04034b50) {
      throw invalid(`archive entry '${name}' is corrupt`, "archive");
    }
    if (method !== 0) {
      throw invalid(`archive entry '${name}' uses unsupported compression`, "archive");
    }
    const localNameLength = buffer.readUInt16LE(localOffset + 26);
    const localExtraLength = buffer.readUInt16LE(localOffset + 28);
    const dataStart = localOffset + 30 + localNameLength + localExtraLength;
    if (dataStart + compressedSize > buffer.length) {
      throw invalid(`archive entry '${name}' is truncated`, "archive");
    }
    entries.set(name, Buffer.from(buffer.subarray(dataStart, dataStart + compressedSize)));

    cursor += 46 + nameLength + extraLength + commentLength;
  }

  return entries;
}

function parseManifest(raw: unknown): BackupManifest {
  if (!isRecord(raw)) {
    throw invalid("manifest.json must be a JSON object", "manifest", "invalid_type");
  }
  const { archiveVersion, epic, schemaVersion, instanceVersion, createdAt, tables, checksum } = raw;
  if (typeof archiveVersion !== "number" || !Number.isInteger(archiveVersion)) {
    throw invalid("manifest.archiveVersion must be an integer", "manifest.archiveVersion");
  }
  if (typeof schemaVersion !== "number" || !Number.isInteger(schemaVersion)) {
    throw invalid("manifest.schemaVersion must be an integer", "manifest.schemaVersion");
  }
  if (typeof epic !== "string" || typeof instanceVersion !== "string" || typeof createdAt !== "string") {
    throw invalid("manifest is missing epic, instanceVersion, or createdAt", "manifest");
  }
  if (typeof checksum !== "string" || !/^[0-9a-f]{64}$/.test(checksum)) {
    throw invalid("manifest.checksum must be a sha256 hex digest", "manifest.checksum");
  }
  if (!Array.isArray(tables)) {
    throw invalid("manifest.tables must be an array", "manifest.tables", "invalid_type");
  }
  const parsedTables: BackupManifestTable[] = tables.map((entry, index) => {
    if (!isRecord(entry) || typeof entry["name"] !== "string") {
      throw invalid(`manifest.tables[${index}].name must be a string`, `manifest.tables[${index}].name`);
    }
    if (typeof entry["rowCount"] !== "number" || !Number.isInteger(entry["rowCount"]) || entry["rowCount"] < 0) {
      throw invalid(
        `manifest.tables[${index}].rowCount must be a non-negative integer`,
        `manifest.tables[${index}].rowCount`,
      );
    }
    return { name: entry["name"], rowCount: entry["rowCount"] };
  });
  return {
    archiveVersion,
    epic,
    schemaVersion,
    instanceVersion,
    createdAt,
    tables: parsedTables,
    checksum,
  };
}

/** Packs the manifest and every table dump into a single ZIP archive. */
export function packBackupArchive(options: PackBackupArchiveOptions): Buffer {
  const tables = options.tables;
  assertTableNames(tables);
  assertNoSecretColumns(tables);

  const manifestBody: Omit<BackupManifest, "checksum"> = {
    archiveVersion: BACKUP_ARCHIVE_FORMAT_VERSION,
    epic: options.epic ?? BACKUP_ARCHIVE_EPIC,
    schemaVersion: options.schemaVersion,
    instanceVersion: options.instanceVersion,
    createdAt: options.createdAt ?? new Date().toISOString(),
    tables: tables.map((table) => ({ name: table.name, rowCount: table.rows.length })),
  };
  const manifest: BackupManifest = {
    ...manifestBody,
    checksum: computeChecksum(manifestBody, tables),
  };

  const entries: ZipEntry[] = [
    { name: BACKUP_MANIFEST_FILE, data: Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`, "utf8") },
  ];
  for (const table of tables) {
    entries.push({
      name: tableDumpFileName(table.name),
      data: Buffer.from(JSON.stringify(table.rows), "utf8"),
    });
  }
  return buildZip(entries);
}

/**
 * Reads and validates an archive. Integrity is checked before the schema version
 * so a corrupted archive is never treated as a compatible one, and a schema
 * mismatch throws before any contents are returned (nothing is partially read).
 */
export function readBackupArchive(
  archive: Buffer | Uint8Array,
  options: ReadBackupArchiveOptions,
): BackupArchiveContents {
  const buffer = Buffer.isBuffer(archive) ? archive : Buffer.from(archive);
  const entries = readZip(buffer);

  const manifestBytes = entries.get(BACKUP_MANIFEST_FILE);
  if (!manifestBytes) {
    throw invalid(`archive is missing ${BACKUP_MANIFEST_FILE}`, "manifest", "missing");
  }
  let rawManifest: unknown;
  try {
    rawManifest = JSON.parse(manifestBytes.toString("utf8"));
  } catch {
    throw invalid("manifest.json is not valid JSON", "manifest", "invalid_json");
  }
  const manifest = parseManifest(rawManifest);

  const expectedArchiveVersion = options.expectedArchiveVersion ?? BACKUP_ARCHIVE_FORMAT_VERSION;
  if (manifest.archiveVersion !== expectedArchiveVersion) {
    throw new AppError(
      BACKUP_ARCHIVE_UNSUPPORTED_VERSION,
      `archive format version ${manifest.archiveVersion} is not supported (expected ${expectedArchiveVersion})`,
      400,
      [
        {
          field: "archiveVersion",
          reason: "unsupported",
          actual: manifest.archiveVersion,
          expected: expectedArchiveVersion,
        },
      ],
    );
  }

  const tables: Record<string, readonly BackupRow[]> = {};
  const dumps: BackupTableDump[] = [];
  for (const table of manifest.tables) {
    const dumpBytes = entries.get(tableDumpFileName(table.name));
    if (!dumpBytes) {
      throw invalid(`archive is missing the dump for table '${table.name}'`, `tables.${table.name}`, "missing");
    }
    let rows: unknown;
    try {
      rows = JSON.parse(dumpBytes.toString("utf8"));
    } catch {
      throw invalid(`dump for table '${table.name}' is not valid JSON`, `tables.${table.name}`, "invalid_json");
    }
    if (!Array.isArray(rows) || rows.some((row) => !isRecord(row))) {
      throw invalid(`dump for table '${table.name}' must be an array of objects`, `tables.${table.name}`);
    }
    if (rows.length !== table.rowCount) {
      throw invalid(
        `dump for table '${table.name}' has ${rows.length} rows but the manifest records ${table.rowCount}`,
        `tables.${table.name}`,
        "row_count_mismatch",
      );
    }
    tables[table.name] = rows as BackupRow[];
    dumps.push({ name: table.name, rows: rows as BackupRow[] });
  }

  const { checksum, ...manifestBody } = manifest;
  const recomputed = computeChecksum(manifestBody, dumps);
  if (recomputed !== checksum) {
    throw new AppError(
      BACKUP_ARCHIVE_CHECKSUM_MISMATCH,
      "backup archive checksum does not match its contents",
      400,
      [{ field: "checksum", reason: "mismatch", actual: recomputed, expected: checksum }],
    );
  }

  if (manifest.schemaVersion !== options.instanceSchemaVersion) {
    throw new AppError(
      BACKUP_ARCHIVE_SCHEMA_MISMATCH,
      `backup schema version ${manifest.schemaVersion} does not match instance schema version ${options.instanceSchemaVersion}`,
      409,
      [
        {
          field: "schemaVersion",
          reason: "mismatch",
          actual: manifest.schemaVersion,
          expected: options.instanceSchemaVersion,
        },
      ],
    );
  }

  return { manifest, tables };
}
