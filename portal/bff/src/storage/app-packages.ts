// App package storage on the artifact tier (EPIC-017 SPEC §4.1, §9, §11.2; T-0322).
//
// Uploaded app packages never touch the database (ADR-0015, SPEC §11.2). They are
// streamed to `<artifactRoot>/app-packages/<tenantId>/<packageId>/package.bin` with a
// size cap enforced while writing, next to a small `meta.json` (name, size, sha256).
//
// The worker reaches a package only through a signed, short-lived URL: an HMAC over
// tenant, package, and expiry, verified in constant time. Callers get a package id,
// never a filesystem path.
import { createHmac, randomUUID, timingSafeEqual, createHash } from "node:crypto";
import { createReadStream, createWriteStream, promises as fs } from "node:fs";
import path from "node:path";
import { Transform, type Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { AppError } from "../errors.js";

export const APP_PACKAGE_DIR = "app-packages";
export const APP_PACKAGE_URL_PATH = "/v1/app-packages";
/** Default cap: comfortably above typical Win32 packages, well under Intune's 30 GB limit. */
export const DEFAULT_APP_PACKAGE_MAX_BYTES = 8 * 1024 ** 3;
export const DEFAULT_APP_PACKAGE_URL_TTL_SECONDS = 15 * 60;
export const MAX_APP_PACKAGE_URL_TTL_SECONDS = 60 * 60;
export const MIN_APP_PACKAGE_SECRET_BYTES = 32;

export const AppPackageErrorCodes = Object.freeze({
  tooLarge: "app-package.too_large",
  notFound: "app-package.not_found",
  invalidSignature: "app-package.invalid_signature",
  expired: "app-package.url_expired",
  invalidTtl: "app-package.invalid_ttl",
});

const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9-]{0,127}$/;
const PACKAGE_FILE = "package.bin";
const META_FILE = "meta.json";

export interface StoredAppPackage {
  readonly packageId: string;
  readonly tenantId: string;
  /** The operator's original file name, sanitised; display only, never a path. */
  readonly fileName: string;
  readonly size: number;
  readonly sha256: string;
  readonly storedAt: string;
}

export interface SignedAppPackageUrl {
  readonly url: string;
  readonly expiresAt: string;
}

export interface VerifiedAppPackageUrl {
  readonly tenantId: string;
  readonly packageId: string;
}

export interface AppPackageStoreOptions {
  /** The artifact tier root (config `artifactPath`). */
  readonly artifactRoot: string;
  /** HMAC key for signed URLs; at least 32 bytes. */
  readonly signingSecret: string | Buffer;
  readonly maxBytes?: number;
  readonly defaultTtlSeconds?: number;
  /** Path prefix of the download route the URL points at. */
  readonly urlPath?: string;
  readonly now?: () => Date;
  readonly newId?: () => string;
}

function requireId(label: string, value: string): string {
  if (!ID_PATTERN.test(value)) {
    throw new AppError("request.validation_failed", `${label} is not a valid identifier`, 400, [
      { field: label, reason: "invalid" },
    ]);
  }
  return value;
}

/** Keeps only a display-safe base name: no directories, control characters, or leading dots. */
export function sanitizePackageFileName(fileName: string): string {
  const base = fileName.split(/[\\/]/).pop() ?? "";
  // eslint-disable-next-line no-control-regex
  const cleaned = base.replace(/[\u0000-\u001f\u007f]/g, "").replace(/^\.+/, "").trim().slice(0, 255);
  return cleaned.length > 0 ? cleaned : "package";
}

function tooLarge(maxBytes: number): AppError {
  return new AppError(AppPackageErrorCodes.tooLarge, `package exceeds the ${maxBytes}-byte limit`, 413);
}

export class AppPackageStore {
  private readonly root: string;
  private readonly secret: Buffer;
  readonly maxBytes: number;
  private readonly defaultTtlSeconds: number;
  private readonly urlPath: string;
  private readonly now: () => Date;
  private readonly newId: () => string;

  constructor(options: AppPackageStoreOptions) {
    if (!options.artifactRoot) throw new Error("artifactRoot is required for app package storage");
    this.secret = Buffer.isBuffer(options.signingSecret)
      ? options.signingSecret
      : Buffer.from(options.signingSecret, "utf8");
    if (this.secret.length < MIN_APP_PACKAGE_SECRET_BYTES) {
      throw new Error(`signingSecret must be at least ${MIN_APP_PACKAGE_SECRET_BYTES} bytes`);
    }
    this.root = path.resolve(options.artifactRoot, APP_PACKAGE_DIR);
    this.maxBytes = options.maxBytes ?? DEFAULT_APP_PACKAGE_MAX_BYTES;
    if (!Number.isInteger(this.maxBytes) || this.maxBytes < 1) throw new Error("maxBytes must be a positive integer");
    this.defaultTtlSeconds = this.checkTtl(options.defaultTtlSeconds ?? DEFAULT_APP_PACKAGE_URL_TTL_SECONDS);
    this.urlPath = (options.urlPath ?? APP_PACKAGE_URL_PATH).replace(/\/+$/, "");
    this.now = options.now ?? (() => new Date());
    this.newId = options.newId ?? randomUUID;
  }

  private dir(tenantId: string, packageId: string): string {
    return path.join(this.root, requireId("tenantId", tenantId), requireId("packageId", packageId));
  }

  private checkTtl(ttlSeconds: number): number {
    if (!Number.isInteger(ttlSeconds) || ttlSeconds < 1 || ttlSeconds > MAX_APP_PACKAGE_URL_TTL_SECONDS) {
      throw new AppError(
        AppPackageErrorCodes.invalidTtl,
        `URL lifetime must be 1-${MAX_APP_PACKAGE_URL_TTL_SECONDS} seconds`,
        400,
      );
    }
    return ttlSeconds;
  }

  /**
   * Streams a package onto the artifact tier. The size cap is enforced as bytes
   * arrive, so an oversized upload is cut off rather than buffered; a declared size
   * over the cap is refused before any byte is written. Partial files are removed.
   */
  async storePackage(
    tenantId: string,
    fileName: string,
    source: Readable | AsyncIterable<Uint8Array>,
    declaredSize?: number,
  ): Promise<StoredAppPackage> {
    if (declaredSize !== undefined && declaredSize > this.maxBytes) throw tooLarge(this.maxBytes);
    const packageId = requireId("packageId", this.newId());
    const dir = this.dir(tenantId, packageId);
    await fs.mkdir(dir, { recursive: true });

    const hash = createHash("sha256");
    let size = 0;
    const maxBytes = this.maxBytes;
    const meter = new Transform({
      transform(chunk: Buffer, _encoding, callback) {
        size += chunk.length;
        if (size > maxBytes) {
          callback(tooLarge(maxBytes));
          return;
        }
        hash.update(chunk);
        callback(null, chunk);
      },
    });

    const partial = path.join(dir, `${PACKAGE_FILE}.partial`);
    try {
      await pipeline(source, meter, createWriteStream(partial, { flags: "wx" }));
      await fs.rename(partial, path.join(dir, PACKAGE_FILE));
      const stored: StoredAppPackage = {
        packageId,
        tenantId,
        fileName: sanitizePackageFileName(fileName),
        size,
        sha256: hash.digest("hex"),
        storedAt: this.now().toISOString(),
      };
      await fs.writeFile(path.join(dir, META_FILE), JSON.stringify(stored), { flag: "wx" });
      return stored;
    } catch (error) {
      await fs.rm(dir, { recursive: true, force: true });
      throw error;
    }
  }

  /** Reads a package's metadata; undefined when the tenant has no such package. */
  async getPackage(tenantId: string, packageId: string): Promise<StoredAppPackage | undefined> {
    try {
      const raw = await fs.readFile(path.join(this.dir(tenantId, packageId), META_FILE), "utf8");
      return JSON.parse(raw) as StoredAppPackage;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
  }

  /** Opens a package for streaming; throws 404 when absent. */
  async openPackage(tenantId: string, packageId: string): Promise<{ meta: StoredAppPackage; stream: Readable }> {
    const meta = await this.getPackage(tenantId, packageId);
    if (!meta) throw new AppError(AppPackageErrorCodes.notFound, "app package not found", 404);
    return { meta, stream: createReadStream(path.join(this.dir(tenantId, packageId), PACKAGE_FILE)) };
  }

  /** Removes a package; returns false when it did not exist. */
  async deletePackage(tenantId: string, packageId: string): Promise<boolean> {
    const dir = this.dir(tenantId, packageId);
    const existed = (await this.getPackage(tenantId, packageId)) !== undefined;
    await fs.rm(dir, { recursive: true, force: true });
    return existed;
  }

  private sign(tenantId: string, packageId: string, expires: number): Buffer {
    return createHmac("sha256", this.secret).update(`app-package:v1\n${tenantId}\n${packageId}\n${expires}`).digest();
  }

  /** Mints a signed URL for a stored package, valid for at most an hour. */
  async createSignedUrl(tenantId: string, packageId: string, ttlSeconds?: number): Promise<SignedAppPackageUrl> {
    const ttl = ttlSeconds === undefined ? this.defaultTtlSeconds : this.checkTtl(ttlSeconds);
    if (!(await this.getPackage(tenantId, packageId))) {
      throw new AppError(AppPackageErrorCodes.notFound, "app package not found", 404);
    }
    const expires = Math.floor(this.now().getTime() / 1000) + ttl;
    const sig = this.sign(tenantId, packageId, expires).toString("base64url");
    const query = new URLSearchParams({ tenant: tenantId, expires: String(expires), sig });
    return {
      url: `${this.urlPath}/${encodeURIComponent(packageId)}?${query.toString()}`,
      expiresAt: new Date(expires * 1000).toISOString(),
    };
  }

  /**
   * Checks a signed URL's package id and query. Throws 403 for a bad or tampered
   * signature and 410 for an expired one; returns the tenant and package it grants.
   */
  verifySignedUrl(packageId: string, query: URLSearchParams): VerifiedAppPackageUrl {
    const invalid = () => new AppError(AppPackageErrorCodes.invalidSignature, "invalid package URL signature", 403);
    const tenantId = query.get("tenant") ?? "";
    const expiresRaw = query.get("expires") ?? "";
    const sig = query.get("sig") ?? "";
    if (!ID_PATTERN.test(tenantId) || !ID_PATTERN.test(packageId) || !/^\d{1,12}$/.test(expiresRaw)) throw invalid();
    const expires = Number(expiresRaw);
    const expected = this.sign(tenantId, packageId, expires);
    const given = Buffer.from(sig, "base64url");
    if (given.length !== expected.length || !timingSafeEqual(given, expected)) throw invalid();
    // A valid signature cannot name a lifetime beyond the cap, but check anyway.
    const nowSeconds = Math.floor(this.now().getTime() / 1000);
    if (expires - nowSeconds > MAX_APP_PACKAGE_URL_TTL_SECONDS) throw invalid();
    if (nowSeconds >= expires) {
      throw new AppError(AppPackageErrorCodes.expired, "package URL has expired", 410);
    }
    return { tenantId, packageId };
  }
}
