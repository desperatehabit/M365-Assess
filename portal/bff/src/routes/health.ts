// Health and liveness endpoint (EPIC-001 SPEC.md §2 US-7, §6, §10).
// Reports service version, storage reachability, queue depth, worker count,
// and last run timestamp. Degraded storage/queue state emits a structured
// payload with stable codes rather than a stack trace. Requires no tenant scope
// and performs no tenant work.
import type { RequestContext, Route, RouteResponse } from "../server.js";

export const HEALTH_PATH = "/v1/health";

export type HealthStatus = "healthy" | "degraded" | "unhealthy";

export interface StorageStatus {
  readonly reachable: boolean;
  readonly status: "ok" | "degraded" | "down";
  readonly schemaVersion?: number;
  readonly code?: string;
  readonly message?: string;
}

export interface QueueStatus {
  readonly reachable: boolean;
  readonly status: "ok" | "degraded" | "down";
  readonly depth: number;
  readonly code?: string;
  readonly message?: string;
}

export interface HealthReport {
  readonly status: HealthStatus;
  readonly serviceVersion: string;
  readonly version: string;
  readonly storage: StorageStatus;
  readonly queue: QueueStatus;
  readonly queueDepth: number;
  readonly workerCount: number;
  readonly lastRun: string | null;
  readonly lastRunAt: string | null;
}

export interface HealthStorageSource {
  readonly schemaVersion?: number;
  checkReachability?(): Promise<boolean> | boolean;
  getSchemaVersion?(): Promise<number> | number;
  getLastRunTimestamp?(): Promise<string | null> | string | null;
}

export interface HealthQueueSource {
  readonly depth?: number;
  readonly poolSize?: number;
  readonly workerCount?: number;
  checkReachability?(): Promise<boolean> | boolean;
}

export interface HealthRouteOptions {
  readonly version?: string;
  readonly storage?: HealthStorageSource;
  readonly queue?: HealthQueueSource;
  readonly workerCount?: number;
}

export async function computeHealthReport(
  options: HealthRouteOptions = {},
): Promise<{ status: number; report: HealthReport }> {
  const serviceVersion = options.version ?? "0.0.0";

  let storageStatus: StorageStatus = {
    reachable: true,
    status: "ok",
  };
  let lastRunTimestamp: string | null = null;

  if (options.storage) {
    try {
      if (typeof options.storage.checkReachability === "function") {
        const ok = await options.storage.checkReachability();
        if (!ok) {
          storageStatus = {
            reachable: false,
            status: "down",
            code: "storage.unreachable",
            message: "Storage reachability check failed",
          };
        }
      }

      if (storageStatus.reachable) {
        if (typeof options.storage.getSchemaVersion === "function") {
          const sv = await options.storage.getSchemaVersion();
          storageStatus = { ...storageStatus, schemaVersion: sv };
        } else if (typeof options.storage.schemaVersion === "number") {
          storageStatus = { ...storageStatus, schemaVersion: options.storage.schemaVersion };
        }
      }

      if (storageStatus.reachable && typeof options.storage.getLastRunTimestamp === "function") {
        lastRunTimestamp = await options.storage.getLastRunTimestamp();
      }
    } catch (error) {
      storageStatus = {
        reachable: false,
        status: "down",
        code: "storage.unreachable",
        message: error instanceof Error ? error.message : "Storage access error",
      };
    }
  }

  let queueDepth = 0;
  let queueStatus: QueueStatus = {
    reachable: true,
    status: "ok",
    depth: 0,
  };

  if (options.queue) {
    try {
      if (typeof options.queue.checkReachability === "function") {
        const ok = await options.queue.checkReachability();
        if (!ok) {
          queueStatus = {
            reachable: false,
            status: "down",
            depth: 0,
            code: "queue.unreachable",
            message: "Queue reachability check failed",
          };
        }
      }

      if (queueStatus.reachable) {
        queueDepth = Number(options.queue.depth ?? 0);
        queueStatus = {
          reachable: true,
          status: "ok",
          depth: queueDepth,
        };
      }
    } catch (error) {
      queueStatus = {
        reachable: false,
        status: "down",
        depth: 0,
        code: "queue.unreachable",
        message: error instanceof Error ? error.message : "Queue access error",
      };
    }
  }

  const workerCount =
    options.workerCount ??
    options.queue?.workerCount ??
    options.queue?.poolSize ??
    2;

  const storageDown = !storageStatus.reachable;
  const queueDown = !queueStatus.reachable;
  const totalFailure = storageDown && queueDown;
  const isDegraded = storageDown || queueDown;

  const overallStatus: HealthStatus = totalFailure
    ? "unhealthy"
    : isDegraded
      ? "degraded"
      : "healthy";

  const httpStatus = totalFailure ? 503 : 200;

  const report: HealthReport = {
    status: overallStatus,
    serviceVersion,
    version: serviceVersion,
    storage: storageStatus,
    queue: queueStatus,
    queueDepth,
    workerCount,
    lastRun: lastRunTimestamp,
    lastRunAt: lastRunTimestamp,
  };

  return {
    status: httpStatus,
    report,
  };
}

export function createHealthRoutes(options: HealthRouteOptions = {}): readonly Route[] {
  return [
    {
      method: "GET",
      path: HEALTH_PATH,
      handler: async (_ctx: RequestContext): Promise<RouteResponse> => {
        const { status, report } = await computeHealthReport(options);
        return {
          status,
          body: report,
        };
      },
    },
  ];
}

export const HEALTH_OPENAPI = {
  paths: {
    "/health": {
      get: {
        operationId: "getHealth",
        summary: "Liveness and diagnostics health check",
        description:
          "Reports service version, storage reachability, queue depth, worker count, and last run timestamp.",
        responses: {
          "200": {
            description: "Service is healthy or degraded.",
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/HealthReport" },
              },
            },
          },
          "503": {
            description: "Total liveness failure.",
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/HealthReport" },
              },
            },
          },
        },
      },
    },
  },
  schemas: {
    HealthReport: {
      type: "object",
      required: [
        "status",
        "serviceVersion",
        "storage",
        "queue",
        "queueDepth",
        "workerCount",
        "lastRunAt",
      ],
      properties: {
        status: { type: "string", enum: ["healthy", "degraded", "unhealthy"] },
        serviceVersion: { type: "string" },
        version: { type: "string" },
        storage: {
          type: "object",
          required: ["reachable", "status"],
          properties: {
            reachable: { type: "boolean" },
            status: { type: "string", enum: ["ok", "degraded", "down"] },
            schemaVersion: { type: "integer" },
            code: { type: "string" },
            message: { type: "string" },
          },
        },
        queue: {
          type: "object",
          required: ["reachable", "status", "depth"],
          properties: {
            reachable: { type: "boolean" },
            status: { type: "string", enum: ["ok", "degraded", "down"] },
            depth: { type: "integer" },
            code: { type: "string" },
            message: { type: "string" },
          },
        },
        queueDepth: { type: "integer" },
        workerCount: { type: "integer" },
        lastRun: { type: ["string", "null"] },
        lastRunAt: { type: ["string", "null"] },
      },
    },
  },
} as const;
