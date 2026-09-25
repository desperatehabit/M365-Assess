import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  BRANDING_MAX_IMAGE_DIMENSION,
  BRANDING_MAX_UPLOAD_BYTES,
  BrandingUploadError,
  storeBrandingAsset,
  validateBrandingUpload,
} from "./uploads.js";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
  tempDirs.length = 0;
});

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "m365-branding-"));
  tempDirs.push(dir);
  return dir;
}

function expectUploadError(fn: () => unknown, code: string): BrandingUploadError {
  let thrown: unknown;
  try {
    fn();
  } catch (error) {
    thrown = error;
  }
  expect(thrown).toBeInstanceOf(BrandingUploadError);
  const uploadError = thrown as BrandingUploadError;
  expect(uploadError.code).toBe(code);
  return uploadError;
}

function makePng(width: number, height: number): Buffer {
  const header = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.alloc(25);
  ihdr.writeUInt32BE(13, 0);
  ihdr.write("IHDR", 4, "ascii");
  ihdr.writeUInt32BE(width, 8);
  ihdr.writeUInt32BE(height, 12);
  ihdr[16] = 8;
  ihdr[17] = 2;
  const iend = Buffer.alloc(12);
  iend.write("IEND", 4, "ascii");
  return Buffer.concat([header, ihdr, iend]);
}

function makeJpeg(width: number, height: number): Buffer {
  const soi = Buffer.from([0xff, 0xd8]);
  const app0 = Buffer.from([
    0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00, 0x01, 0x00,
    0x01, 0x00, 0x00,
  ]);
  const sof0 = Buffer.alloc(19);
  sof0[0] = 0xff;
  sof0[1] = 0xc0;
  sof0.writeUInt16BE(17, 2);
  sof0[4] = 8;
  sof0.writeUInt16BE(height, 5);
  sof0.writeUInt16BE(width, 7);
  sof0[9] = 3;
  const eoi = Buffer.from([0xff, 0xd9]);
  return Buffer.concat([soi, app0, sof0, eoi]);
}

function riffHeader(form: string, payloadLength: number): Buffer {
  const header = Buffer.alloc(12);
  header.write("RIFF", 0, "ascii");
  header.writeUInt32LE(payloadLength + 4, 4);
  header.write("WEBP", 8, "ascii");
  const chunk = Buffer.alloc(8);
  chunk.write(form, 0, "ascii");
  chunk.writeUInt32LE(payloadLength, 4);
  return Buffer.concat([header, chunk]);
}

function makeWebpLossy(width: number, height: number): Buffer {
  const payload = Buffer.alloc(10);
  payload[3] = 0x9d;
  payload[4] = 0x01;
  payload[5] = 0x2a;
  payload.writeUInt16LE(width, 6);
  payload.writeUInt16LE(height, 8);
  return Buffer.concat([riffHeader("VP8 ", payload.length), payload]);
}

function makeWebpLossless(width: number, height: number): Buffer {
  const payload = Buffer.alloc(5);
  payload[0] = 0x2f;
  payload.writeUInt32LE((width - 1) | ((height - 1) << 14), 1);
  return Buffer.concat([riffHeader("VP8L", payload.length), payload]);
}

function makeWebpExtended(width: number, height: number): Buffer {
  const payload = Buffer.alloc(10);
  payload.writeUIntLE(width - 1, 4, 3);
  payload.writeUIntLE(height - 1, 7, 3);
  return Buffer.concat([riffHeader("VP8X", payload.length), payload]);
}

describe("branding upload validation", () => {
  it("accepts a PNG within the limits", () => {
    const validated = validateBrandingUpload({ bytes: makePng(64, 32) });
    expect(validated).toMatchObject({ type: "png", extension: "png", width: 64, height: 32 });
  });

  it("accepts JPEG and every WebP container", () => {
    expect(validateBrandingUpload({ bytes: makeJpeg(100, 50) })).toMatchObject({
      type: "jpeg",
      extension: "jpg",
      width: 100,
      height: 50,
    });
    expect(validateBrandingUpload({ bytes: makeWebpLossy(16, 16) })).toMatchObject({ type: "webp" });
    expect(validateBrandingUpload({ bytes: makeWebpLossless(16, 16) })).toMatchObject({
      type: "webp",
      width: 16,
      height: 16,
    });
    expect(validateBrandingUpload({ bytes: makeWebpExtended(16, 16) })).toMatchObject({
      type: "webp",
      width: 16,
      height: 16,
    });
  });

  it("rejects SVG bytes with the unsupported-type code", () => {
    const svg = Buffer.from(
      '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"></svg>',
      "utf8",
    );
    expectUploadError(() => validateBrandingUpload({ bytes: svg }), "branding.unsupported_type");
  });

  it("rejects an SVG filename even when the bytes look raster", () => {
    expectUploadError(
      () => validateBrandingUpload({ bytes: makePng(8, 8), filename: "logo.svg" }),
      "branding.unsupported_type",
    );
  });

  it("rejects formats outside the raster allow-list", () => {
    const gif = Buffer.from("GIF89a\x01\x00\x01\x00\x00\x00\x00;", "latin1");
    expectUploadError(() => validateBrandingUpload({ bytes: gif }), "branding.unsupported_type");
  });

  it("rejects script-bearing bytes hiding behind a raster header", () => {
    const polyglot = Buffer.concat([
      makePng(8, 8),
      Buffer.from('<script>alert("x")</script>', "latin1"),
    ]);
    expectUploadError(() => validateBrandingUpload({ bytes: polyglot }), "branding.script_rejected");
  });

  it("rejects uploads over the byte limit", () => {
    const oversized = Buffer.concat([
      makePng(8, 8),
      Buffer.alloc(BRANDING_MAX_UPLOAD_BYTES, 0),
    ]);
    expectUploadError(() => validateBrandingUpload({ bytes: oversized }), "branding.too_large");
  });

  it("rejects images over the dimension cap", () => {
    expectUploadError(
      () => validateBrandingUpload({ bytes: makePng(BRANDING_MAX_IMAGE_DIMENSION + 1, 16) }),
      "branding.dimensions_exceeded",
    );
  });
});

describe("branding asset storage", () => {
  it("stores the validated asset on the artifact tier and returns a reference", () => {
    const artifactDir = tempDir();
    const bytes = makePng(64, 32);
    const stored = storeBrandingAsset({ kind: "logo", artifactDir, bytes });
    expect(stored.ref).toMatch(/^branding\/logo-.*\.png$/);
    expect(readFileSync(join(artifactDir, stored.ref))).toEqual(bytes);
  });

  it("never stores a rejected upload", () => {
    const artifactDir = tempDir();
    const svg = Buffer.from(
      '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"></svg>',
      "utf8",
    );
    expectUploadError(
      () => storeBrandingAsset({ kind: "logo", artifactDir, bytes: svg }),
      "branding.unsupported_type",
    );
    expect(existsSync(join(artifactDir, "branding"))).toBe(false);

    const oversized = Buffer.concat([
      makePng(8, 8),
      Buffer.alloc(BRANDING_MAX_UPLOAD_BYTES, 0),
    ]);
    expectUploadError(
      () => storeBrandingAsset({ kind: "cover", artifactDir, bytes: oversized }),
      "branding.too_large",
    );
    expect(readdirSync(artifactDir)).toEqual([]);
  });
});
