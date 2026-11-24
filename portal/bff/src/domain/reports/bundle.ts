// Report bundle ZIP container (EPIC-005 SPEC.md §3.4, §6; T-0875).
//
// Packages a generated report's PDF together with selected run artifacts into
// a single stored (uncompressed) ZIP archive with CRC32 integrity metadata,
// matching the binary ZIP layout conventions of backup/archive.ts.
import { AppError } from "../../errors.js";

export const REPORT_BUNDLE_INVALID = "report.bundle.invalid";

export interface ReportBundleEntry {
  readonly name: string;
  readonly data: Buffer;
}

function invalid(message: string, field = "archive", reason = "invalid"): AppError {
  return new AppError(REPORT_BUNDLE_INVALID, message, 400, [{ field, reason }]);
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

function findEndOfCentralDirectory(buffer: Buffer): number {
  for (let i = buffer.length - 22; i >= 0; i -= 1) {
    if (buffer.readUInt32LE(i) === 0x06054b50) {
      return i;
    }
  }
  return -1;
}

/** Builds a stored (uncompressed) ZIP buffer containing the given entries. */
export function buildReportBundleZip(entries: readonly ReportBundleEntry[]): Buffer {
  const localParts: Buffer[] = [];
  const centralParts: Buffer[] = [];
  const dosTime = 0;
  const dosDate = 0x0021; // 1980-01-01, the minimum valid DOS date
  let offset = 0;

  for (const entry of entries) {
    if (typeof entry.name !== "string" || entry.name.trim().length === 0) {
      throw invalid("bundle entry name must be a non-empty string", "entries.name");
    }
    const data = Buffer.isBuffer(entry.data) ? entry.data : Buffer.from(entry.data);
    const nameBuffer = Buffer.from(entry.name, "utf8");
    const crc = crc32(data);
    const size = data.length;

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
    localParts.push(local, nameBuffer, data);

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

    offset += local.length + nameBuffer.length + data.length;
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

/** Reads and validates a stored ZIP archive produced by buildReportBundleZip. */
export function readReportBundleZip(archive: Buffer | Uint8Array): Map<string, Buffer> {
  const buffer = Buffer.isBuffer(archive) ? archive : Buffer.from(archive);
  const eocd = findEndOfCentralDirectory(buffer);
  if (eocd < 0) {
    throw invalid("bundle is not a valid ZIP container", "archive");
  }
  const entryCount = buffer.readUInt16LE(eocd + 10);
  let cursor = buffer.readUInt32LE(eocd + 16);
  const entries = new Map<string, Buffer>();

  for (let i = 0; i < entryCount; i += 1) {
    if (cursor + 46 > buffer.length || buffer.readUInt32LE(cursor) !== 0x02014b50) {
      throw invalid("bundle central directory is corrupt", "archive");
    }
    const method = buffer.readUInt16LE(cursor + 10);
    const expectedCrc = buffer.readUInt32LE(cursor + 16);
    const compressedSize = buffer.readUInt32LE(cursor + 20);
    const uncompressedSize = buffer.readUInt32LE(cursor + 24);
    const nameLength = buffer.readUInt16LE(cursor + 28);
    const extraLength = buffer.readUInt16LE(cursor + 30);
    const commentLength = buffer.readUInt16LE(cursor + 32);
    const localOffset = buffer.readUInt32LE(cursor + 42);
    if (cursor + 46 + nameLength + extraLength + commentLength > buffer.length) {
      throw invalid("bundle central directory entry is truncated", "archive");
    }
    const name = buffer.toString("utf8", cursor + 46, cursor + 46 + nameLength);

    if (localOffset + 30 > buffer.length || buffer.readUInt32LE(localOffset) !== 0x04034b50) {
      throw invalid(`bundle entry '${name}' is corrupt`, "archive");
    }
    if (method !== 0) {
      throw invalid(`bundle entry '${name}' uses unsupported compression`, "archive");
    }
    if (compressedSize !== uncompressedSize) {
      throw invalid(`bundle entry '${name}' has mismatched stored sizes`, "archive");
    }
    const localNameLength = buffer.readUInt16LE(localOffset + 26);
    const localExtraLength = buffer.readUInt16LE(localOffset + 28);
    const dataStart = localOffset + 30 + localNameLength + localExtraLength;
    if (dataStart + compressedSize > buffer.length) {
      throw invalid(`bundle entry '${name}' is truncated`, "archive");
    }
    const data = Buffer.from(buffer.subarray(dataStart, dataStart + compressedSize));
    if (crc32(data) !== expectedCrc) {
      throw invalid(`bundle entry '${name}' failed CRC32 check`, "archive", "crc_mismatch");
    }
    entries.set(name, data);

    cursor += 46 + nameLength + extraLength + commentLength;
  }

  return entries;
}
