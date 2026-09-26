import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { DEFAULT_HOST } from "../config.js";
import { buildServer } from "../server.js";
import {
  HEALTH_PATH,
  computeHealthReport,
  createHealthRoutes,
  type HealthQueueSource,
  type HealthReport,
  type HealthStorageSource,
} from "./health.js";

const openServers: Server[] = [];

afterEach(async () => {
  await Promise.all(
    openServers.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => {
          server.close(() => resolve());
        }),
    ),
  );
});

async function startServer(options = {}): Promise<string> {
  const routes = createHealthRoutes(options);
  const server = buildServer({ routes });
  await new Promise<void>((resolve) => server.listen(0, DEFAULT_HOST, resolve));
  openServers.push(server);
  const { port } = server.address() as AddressInfo;
  return `http://${DEFAULT_HOST}:${port}`;
}

describe("GET /v1/health", () => {
  it("returns the five fields and reflects repository/queue state", async () => {
    const storage: HealthStorageSource = {
      schemaVersion: 63,
      checkReachability: () => true,
      getLastRunTimestamp: () => "2026-09-25T12:00:00.000Z",
    };
    const queue: HealthQueueSource = {
      depth: 4,
      workerCount: 3,
      checkReachability: () => true,
    };

    const { status, report } = await computeHealthReport({
      version: "1.2.3",
      storage,
      queue,
    });

    expect(status).toBe(200);
    expect(report.status).toBe("healthy");
    expect(report.serviceVersion).toBe("1.2.3");
    expect(report.version).toBe("1.2.3");
    expect(report.storage).toEqual({
      reachable: true,
      status: "ok",
      schemaVersion: 63,
    });
    expect(report.queue).toEqual({
      reachable: true,
      status: "ok",
      depth: 4,
    });
    expect(report.queueDepth).toBe(4);
    expect(report.workerCount).toBe(3);
    expect(report.lastRunAt).toBe("2026-09-25T12:00:00.000Z");
    expect(report.lastRun).toBe("2026-09-25T12:00:00.000Z");
  });

  it("forces storage down and asserts a degraded, structured payload without stack trace", async () => {
    const brokenStorage: HealthStorageSource = {
      checkReachability: () => {
        throw new Error("connection to database refused at /var/lib/db.sqlite");
      },
    };
    const healthyQueue: HealthQueueSource = {
      depth: 1,
      workerCount: 2,
      checkReachability: () => true,
    };

    const { status, report } = await computeHealthReport({
      storage: brokenStorage,
      queue: healthyQueue,
    });

    // Degraded storage remains non-5xx for partial liveness
    expect(status).toBe(200);
    expect(report.status).toBe("degraded");
    expect(report.storage.reachable).toBe(false);
    expect(report.storage.status).toBe("down");
    expect(report.storage.code).toBe("storage.unreachable");
    expect(report.storage.message).toBe("connection to database refused at /var/lib/db.sqlite");
    // Assert no stack trace is leaked in report
    expect(JSON.stringify(report)).not.toContain("at Object.checkReachability");
    expect(JSON.stringify(report)).not.toContain("Error:");

    expect(report.queue.reachable).toBe(true);
    expect(report.queue.status).toBe("ok");
    expect(report.queueDepth).toBe(1);
    expect(report.workerCount).toBe(2);
  });

  it("handles storage check returning false cleanly", async () => {
    const storage: HealthStorageSource = {
      checkReachability: async () => false,
    };

    const { status, report } = await computeHealthReport({ storage });
    expect(status).toBe(200);
    expect(report.status).toBe("degraded");
    expect(report.storage.reachable).toBe(false);
    expect(report.storage.status).toBe("down");
    expect(report.storage.code).toBe("storage.unreachable");
  });

  it("handles queue check failure cleanly", async () => {
    const queue: HealthQueueSource = {
      depth: 0,
      checkReachability: () => {
        throw new Error("queue worker pool unresponsive");
      },
    };

    const { status, report } = await computeHealthReport({ queue });
    expect(status).toBe(200);
    expect(report.status).toBe("degraded");
    expect(report.queue.reachable).toBe(false);
    expect(report.queue.status).toBe("down");
    expect(report.queue.code).toBe("queue.unreachable");
  });

  it("returns 503 for total liveness failure when both storage and queue are down", async () => {
    const brokenStorage: HealthStorageSource = {
      checkReachability: () => false,
    };
    const brokenQueue: HealthQueueSource = {
      checkReachability: () => false,
    };

    const { status, report } = await computeHealthReport({
      storage: brokenStorage,
      queue: brokenQueue,
    });

    expect(status).toBe(503);
    expect(report.status).toBe("unhealthy");
    expect(report.storage.reachable).toBe(false);
    expect(report.queue.reachable).toBe(false);
  });

  it("contains no secrets or tenant identifiers in the response", async () => {
    const storage: HealthStorageSource = {
      schemaVersion: 60,
      getLastRunTimestamp: () => "2026-09-26T00:00:00.000Z",
    };
    const queue: HealthQueueSource = { depth: 2, workerCount: 2 };

    const { report } = await computeHealthReport({ storage, queue });
    const serialized = JSON.stringify(report);

    // No secrets or tenant identifiers
    expect(serialized).not.toMatch(/secret/i);
    expect(serialized).not.toMatch(/password/i);
    expect(serialized).not.toMatch(/thumbprint/i);
    expect(serialized).not.toMatch(/tenantid/i);
    expect(serialized).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i);
  });

  it("serves GET /v1/health via HTTP without authentication or tenant scope", async () => {
    const baseUrl = await startServer({
      version: "0.1.0",
      storage: {
        schemaVersion: 63,
        getLastRunTimestamp: () => "2026-09-24T18:00:00.000Z",
      },
      queue: { depth: 0, workerCount: 2 },
    });

    const response = await fetch(`${baseUrl}${HEALTH_PATH}`);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("application/json");

    const body = (await response.json()) as HealthReport;
    expect(body.status).toBe("healthy");
    expect(body.serviceVersion).toBe("0.1.0");
    expect(body.storage.reachable).toBe(true);
    expect(body.storage.schemaVersion).toBe(63);
    expect(body.queueDepth).toBe(0);
    expect(body.workerCount).toBe(2);
    expect(body.lastRunAt).toBe("2026-09-24T18:00:00.000Z");
  });
});
