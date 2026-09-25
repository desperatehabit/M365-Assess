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
}

const ENV = {
  host: "M365_BFF_HOST",
  port: "M365_BFF_PORT",
  workerPoolSize: "M365_BFF_WORKER_POOL_SIZE",
  storagePath: "M365_BFF_STORAGE_PATH",
  artifactPath: "M365_BFF_ARTIFACT_PATH",
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

export function loadConfig(env: Environment = process.env): BffConfig {
  const storagePath = path.resolve(
    readEnv(env, ENV.storagePath) ?? path.join(PACKAGE_ROOT, "data"),
  );
  const artifactPath = path.resolve(
    readEnv(env, ENV.artifactPath) ?? path.join(storagePath, "artifacts"),
  );
  return {
    host: readEnv(env, ENV.host) ?? DEFAULT_HOST,
    port: parsePort(readEnv(env, ENV.port)),
    workerPoolSize: parseWorkerPoolSize(readEnv(env, ENV.workerPoolSize)),
    storagePath,
    artifactPath,
  };
}
