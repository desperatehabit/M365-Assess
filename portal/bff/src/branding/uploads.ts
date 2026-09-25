// Branding upload validation (EPIC-037 SPEC.md §9, §11.2).
// §11.2 resolves uploads to an explicit allow-list of raster formats
// (PNG/JPEG/WebP) with a maximum byte size and a dimension cap; SVG and
// script-bearing content are rejected. Validated bytes are stored on the
// artifact tier under `branding/` and the database keeps only the returned
// relative reference, never the bytes. Validation runs before any write, so
// a rejected upload never reaches storage.

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

export const BRANDING_ALLOWED_UPLOAD_TYPES = ["png", "jpeg", "webp"] as const;

export type BrandingUploadType = (typeof BRANDING_ALLOWED_UPLOAD_TYPES)[number];

export const BRANDING_MAX_UPLOAD_BYTES = 2 * 1024 * 1024;

export const BRANDING_MAX_IMAGE_DIMENSION = 2048;

export const BRANDING_ASSET_DIR = "branding" as const;

export type BrandingUploadErrorCode =
  | "branding.unsupported_type"
  | "branding.too_large"
  | "branding.dimensions_exceeded"
  | "branding.script_rejected"
  | "branding.invalid_image";

export class BrandingUploadError extends Error {
  readonly code: BrandingUploadErrorCode;

  constructor(code: BrandingUploadErrorCode, message: string) {
    super(message);
    this.name = "BrandingUploadError";
    this.code = code;
  }
}

export type BrandingAssetKind = "logo" | "cover";

export interface BrandingUploadInput {
  readonly bytes: Uint8Array;
  readonly filename?: string;
  readonly contentType?: string;
}

export interface ValidatedBrandingUpload {
  readonly type: BrandingUploadType;
  readonly extension: string;
  readonly width: number;
  readonly height: number;
  readonly size: number;
}

export interface StoredBrandingAsset extends ValidatedBrandingUpload {
  readonly ref: string;
  readonly kind: BrandingAssetKind;
}

type DetectedType = BrandingUploadType | "svg" | "unknown";

const SCRIPT_MARKERS = [
  "<script",
  "javascript:",
  "vbscript:",
  "data:text/html",
  "onerror",
  "onload",
  "<iframe",
  "<html",
  "<?php",
  "<%",
  "eval(",
  "expression(",
];

function fail(code: BrandingUploadErrorCode, message: string): never {
  throw new BrandingUploadError(code, message);
}

function toBytes(input: Uint8Array): Buffer {
  return Buffer.isBuffer(input) ? input : Buffer.from(input.buffer, input.byteOffset, input.byteLength);
}

function detectType(bytes: Buffer, input: BrandingUploadInput): DetectedType {
  const filename = input.filename?.toLowerCase() ?? "";
  const contentType = input.contentType?.toLowerCase() ?? "";
  if (
    filename.endsWith(".svg") ||
    contentType.includes("svg") ||
    contentType.includes("text/html") ||
    contentType.includes("text/xml")
  ) {
    return "svg";
  }
  if (
    bytes.length >= 8 &&
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47 &&
    bytes[4] === 0x0d &&
    bytes[5] === 0x0a &&
    bytes[6] === 0x1a &&
    bytes[7] === 0x0a
  ) {
    return "png";
  }
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return "jpeg";
  }
  if (
    bytes.length >= 12 &&
    bytes.subarray(0, 4).toString("ascii") === "RIFF" &&
    bytes.subarray(8, 12).toString("ascii") === "WEBP"
  ) {
    return "webp";
  }
  const head = bytes.subarray(0, Math.min(bytes.length, 1024)).toString("latin1").toLowerCase();
  if (head.includes("<svg") || (head.includes("<?xml") && head.includes("<"))) {
    return "svg";
  }
  return "unknown";
}

function rejectScriptContent(bytes: Buffer): void {
  const text = bytes.toString("latin1").toLowerCase();
  for (const marker of SCRIPT_MARKERS) {
    if (text.includes(marker)) {
      fail("branding.script_rejected", `Branding upload contains rejected script content (${marker})`);
    }
  }
  if (text.includes("<svg") || text.includes("<?xml")) {
    fail("branding.script_rejected", "Branding upload contains rejected markup content");
  }
}

function readPngDimensions(bytes: Buffer): { width: number; height: number } | null {
  if (bytes.length < 33) return null;
  if (bytes.subarray(12, 16).toString("ascii") !== "IHDR") return null;
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
}

function readJpegDimensions(bytes: Buffer): { width: number; height: number } | null {
  let offset = 2;
  while (offset + 3 < bytes.length) {
    if (bytes[offset] !== 0xff) return null;
    const marker = bytes[offset + 1] as number;
    if (marker === 0xd8 || marker === 0xd9) {
      offset += 2;
      continue;
    }
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      offset += 2;
      continue;
    }
    if (offset + 3 >= bytes.length) return null;
    const length = bytes.readUInt16BE(offset + 2);
    if (length < 2) return null;
    const isStartOfFrame =
      (marker >= 0xc0 && marker <= 0xc3) ||
      (marker >= 0xc5 && marker <= 0xc7) ||
      (marker >= 0xc9 && marker <= 0xcb) ||
      (marker >= 0xcd && marker <= 0xcf);
    if (isStartOfFrame) {
      if (offset + 8 >= bytes.length) return null;
      return { height: bytes.readUInt16BE(offset + 5), width: bytes.readUInt16BE(offset + 7) };
    }
    offset += 2 + length;
  }
  return null;
}

function readWebpDimensions(bytes: Buffer): { width: number; height: number } | null {
  if (bytes.length < 20) return null;
  const chunk = bytes.subarray(12, 16).toString("ascii");
  if (chunk === "VP8 ") {
    if (bytes.length < 30) return null;
    if (bytes[23] !== 0x9d || bytes[24] !== 0x01 || bytes[25] !== 0x2a) return null;
    return { width: bytes.readUInt16LE(26) & 0x3fff, height: bytes.readUInt16LE(28) & 0x3fff };
  }
  if (chunk === "VP8L") {
    if (bytes.length < 25 || bytes[20] !== 0x2f) return null;
    const packed = bytes.readUInt32LE(21);
    return { width: (packed & 0x3fff) + 1, height: ((packed >> 14) & 0x3fff) + 1 };
  }
  if (chunk === "VP8X") {
    if (bytes.length < 30) return null;
    return {
      width: bytes.readUIntLE(24, 3) + 1,
      height: bytes.readUIntLE(27, 3) + 1,
    };
  }
  return null;
}

export function validateBrandingUpload(input: BrandingUploadInput): ValidatedBrandingUpload {
  const bytes = toBytes(input.bytes);
  if (bytes.length === 0) {
    fail("branding.invalid_image", "Branding upload is empty");
  }
  if (bytes.length > BRANDING_MAX_UPLOAD_BYTES) {
    fail(
      "branding.too_large",
      `Branding upload is ${bytes.length} bytes; the maximum is ${BRANDING_MAX_UPLOAD_BYTES}`,
    );
  }
  const detected = detectType(bytes, input);
  if (detected === "svg" || detected === "unknown") {
    fail(
      "branding.unsupported_type",
      `Branding upload must be one of ${BRANDING_ALLOWED_UPLOAD_TYPES.join(", ")}`,
    );
  }
  rejectScriptContent(bytes);
  const dimensions =
    detected === "png"
      ? readPngDimensions(bytes)
      : detected === "jpeg"
        ? readJpegDimensions(bytes)
        : readWebpDimensions(bytes);
  if (!dimensions || dimensions.width <= 0 || dimensions.height <= 0) {
    fail("branding.invalid_image", "Branding upload is not a decodable raster image");
  }
  if (
    (dimensions as { width: number; height: number }).width > BRANDING_MAX_IMAGE_DIMENSION ||
    (dimensions as { width: number; height: number }).height > BRANDING_MAX_IMAGE_DIMENSION
  ) {
    fail(
      "branding.dimensions_exceeded",
      `Branding image is ${(dimensions as { width: number; height: number }).width}x${(dimensions as { width: number; height: number }).height}; the maximum is ${BRANDING_MAX_IMAGE_DIMENSION}x${BRANDING_MAX_IMAGE_DIMENSION}`,
    );
  }
  return {
    type: detected as BrandingUploadType,
    extension: detected === "jpeg" ? "jpg" : (detected as string),
    width: (dimensions as { width: number; height: number }).width,
    height: (dimensions as { width: number; height: number }).height,
    size: bytes.length,
  };
}

export interface StoreBrandingAssetOptions extends BrandingUploadInput {
  readonly kind: BrandingAssetKind;
  readonly artifactDir: string;
}

export function storeBrandingAsset(options: StoreBrandingAssetOptions): StoredBrandingAsset {
  const validated = validateBrandingUpload(options);
  const fileName = `${options.kind}-${randomUUID()}.${validated.extension}`;
  mkdirSync(join(options.artifactDir, BRANDING_ASSET_DIR), { recursive: true });
  writeFileSync(join(options.artifactDir, BRANDING_ASSET_DIR, fileName), toBytes(options.bytes));
  return { ...validated, ref: `${BRANDING_ASSET_DIR}/${fileName}`, kind: options.kind };
}
