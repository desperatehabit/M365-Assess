import path from "node:path";
import { fileURLToPath } from "node:url";

export const DEFAULT_HOST = "127.0.0.1";
export const DEFAULT_PORT = 8080;
export const DEFAULT_WORKER_POOL_SIZE = 2;

const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export type Environment = Record<string, string | undefined>;

export interface BffConfig {
  readonly host: string;
  readonly port: number;
  readonly workerPoolSize: number;
  readonly storagePath: string;
  readonly artifactPath: string;
  /**
   * Local development only: authenticate every request as this EPIC-001 role until
   * EPIC-038 delivers portal-user token validation. Null (the default) disables it.
   */
  readonly devIdentityRole: DevIdentityRole | null;
  /** Directory of the PowerShell worker entrypoints (portal/workers). */
  readonly workersDir: string;
  /**
   * Partner (MSP) tenant GDAP discovery signs in as. GDAP sync (T-0029) stays disabled
   * until this is set and that tenant has a credential.
   */
  readonly gdapPartnerTenantId: string | null;
  /**
   * HMAC key for signed app-package URLs (T-0322/T-0842), at least 32 bytes. The package
   * upload and download routes are not mounted until it is set. Never logged or returned.
   */
  readonly appPackageSecret: string | null;
  /** Largest app package accepted, in bytes (default 8 GiB). */
  readonly appPackageMaxBytes: number;
  /** Origin workers reach the BFF on to fetch signed package URLs. */
  readonly workerBaseUrl: string;
}

export const DEFAULT_APP_PACKAGE_MAX_BYTES = 8 * 1024 ** 3;
export const MIN_APP_PACKAGE_SECRET_BYTES = 32;

export type DevIdentityRole = "admin" | "operator";

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

const ENV = {
  host: "M365_BFF_HOST",
  port: "M365_BFF_PORT",
  workerPoolSize: "M365_BFF_WORKER_POOL_SIZE",
  storagePath: "M365_BFF_STORAGE_PATH",
  artifactPath: "M365_BFF_ARTIFACT_PATH",
  devIdentity: "M365_BFF_DEV_IDENTITY",
  workersDir: "M365_BFF_WORKERS_DIR",
  gdapPartnerTenantId: "M365_BFF_GDAP_PARTNER_TENANT_ID",
  appPackageSecret: "M365_BFF_APP_PACKAGE_SECRET",
  appPackageMaxBytes: "M365_BFF_APP_PACKAGE_MAX_BYTES",
  workerBaseUrl: "M365_BFF_WORKER_BASE_URL",
} as const;

function readEnv(env: Environment, key: string): string | undefined {
  const value = env[key];
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

export function parsePort(value: string | undefined, fallback = DEFAULT_PORT): number {
  if (value === undefined) {
    return fallback;
  }
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65535) {
    return fallback;
  }
  return parsed;
}

export function parseWorkerPoolSize(
  value: string | undefined,
  fallback = DEFAULT_WORKER_POOL_SIZE,
): number {
  if (value === undefined) {
    return fallback;
  }
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) {
    return fallback;
  }
  return parsed;
}

/**
 * Parse the opt-in dev identity. An unknown value is an error rather than a silent
 * "off", and any value at all is refused when NODE_ENV is production.
 */
export function parseDevIdentityRole(env: Environment): DevIdentityRole | null {
  const value = readEnv(env, ENV.devIdentity);
  if (value === undefined) return null;
  if (readEnv(env, "NODE_ENV") === "production") {
    throw new ConfigError(`${ENV.devIdentity} must not be set when NODE_ENV=production`);
  }
  if (value !== "admin" && value !== "operator") {
    throw new ConfigError(`${ENV.devIdentity} must be "admin" or "operator", got "${value}"`);
  }
  return value;
}

/** The package signing secret, or null when unset; a secret shorter than 32 bytes is an error. */
export function parseAppPackageSecret(env: Environment): string | null {
  const value = readEnv(env, ENV.appPackageSecret);
  if (value === undefined) return null;
  if (Buffer.byteLength(value, "utf8") < MIN_APP_PACKAGE_SECRET_BYTES) {
    // Name the variable, never the value.
    throw new ConfigError(`${ENV.appPackageSecret} must be at least ${MIN_APP_PACKAGE_SECRET_BYTES} bytes`);
  }
  return value;
}

export function parseAppPackageMaxBytes(env: Environment): number {
  const value = readEnv(env, ENV.appPackageMaxBytes);
  if (value === undefined) return DEFAULT_APP_PACKAGE_MAX_BYTES;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    throw new ConfigError(`${ENV.appPackageMaxBytes} must be a positive whole number of bytes, got "${value}"`);
  }
  return parsed;
}

export function parseWorkerBaseUrl(env: Environment, host: string, port: number): string {
  const value = readEnv(env, ENV.workerBaseUrl) ?? `http://${host}:${port}`;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new ConfigError(`${ENV.workerBaseUrl} must be an absolute http(s) URL, got "${value}"`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new ConfigError(`${ENV.workerBaseUrl} must be an absolute http(s) URL, got "${value}"`);
  }
  return url.origin;
}

export function loadConfig(env: Environment = process.env): BffConfig {
  const storagePath = path.resolve(
    readEnv(env, ENV.storagePath) ?? path.join(PACKAGE_ROOT, "data"),
  );
  const artifactPath = path.resolve(
    readEnv(env, ENV.artifactPath) ?? path.join(storagePath, "artifacts"),
  );
  const host = readEnv(env, ENV.host) ?? DEFAULT_HOST;
  const port = parsePort(readEnv(env, ENV.port));
  return {
    host,
    port,
    workerPoolSize: parseWorkerPoolSize(readEnv(env, ENV.workerPoolSize)),
    storagePath,
    artifactPath,
    devIdentityRole: parseDevIdentityRole(env),
    workersDir: path.resolve(readEnv(env, ENV.workersDir) ?? path.join(PACKAGE_ROOT, "..", "workers")),
    gdapPartnerTenantId: readEnv(env, ENV.gdapPartnerTenantId) ?? null,
    appPackageSecret: parseAppPackageSecret(env),
    appPackageMaxBytes: parseAppPackageMaxBytes(env),
    workerBaseUrl: parseWorkerBaseUrl(env, host, port),
  };
}
