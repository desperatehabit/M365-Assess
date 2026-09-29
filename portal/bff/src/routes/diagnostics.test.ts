import { describe, expect, it } from "vitest";
import { tenantScope } from "../rbac/scope.js";
import {
  DIAGNOSTICS_ADMIN_SCOPE,
  DIAGNOSTICS_PATH,
  computeDiagnosticsReport,
  createDiagnosticsRoutes,
  type DiagnosticsCacheSource,
  type DiagnosticsTimersSource,
  type HealthQueueSource,
  type HealthStorageSource,
} from "./diagnostics.js";

const ALL_TENANTS = { all: true, tenantIds: [] };

const HEALTH_STORAGE: HealthStorageSource = {
  schemaVersion: 63,
  checkReachability: () => true,
  getLastRunTimestamp: () => "2026-09-25T12:00:00.000Z",
};

const HEALTH_QUEUE: HealthQueueSource = {
  depth: 4,
  workerCount: 3,
  checkReachability: () => true,
};

class FakeCacheSource implements DiagnosticsCacheSource {
  constructor(private readonly entries: number) {}
  async getStatus() {
    return { configured: true, entries: this.entries };
  }
}

class FakeTimersSource implements DiagnosticsTimersSource {
  constructor(
    private readonly state: ReadonlyArray<{
      name: string;
      cron: string;
      type: string;
      timezone: string;
      command: string;
      lastRunAt: string | null;
      nextRunAt: string | null;
    }> = [],
  ) {}
  async listTimerState() {
    return this.state;
  }
}

function createHarness(overrides?: {
  caller?: any;
  cache?: DiagnosticsCacheSource;
  timers?: DiagnosticsTimersSource;
  storage?: HealthStorageSource;
  queue?: HealthQueueSource;
  authorize?: (caller: any, permission: string) => void | Promise<void>;
}) {
  let defaultCaller: any = {
    userId: "user-1",
    roles: ["admin"],
    permissions: [DIAGNOSTICS_ADMIN_SCOPE],
    tenantScope: ALL_TENANTS,
  };
  if (overrides && "caller" in overrides) {
    defaultCaller = overrides.caller;
  }
  const routes = createDiagnosticsRoutes({
    version: "1.2.3",
    storage: overrides?.storage ?? HEALTH_STORAGE,
    queue: overrides?.queue ?? HEALTH_QUEUE,
    resolveCaller: () => defaultCaller,
    ...(overrides?.cache !== undefined ? { cache: overrides.cache } : {}),
    ...(overrides?.timers !== undefined ? { timers: overrides.timers } : {}),
    ...(overrides?.authorize !== undefined ? { authorize: overrides.authorize } : {}),
  });
  const getRoute = (method: string, path: string) => {
    const route = routes.find((r) => r.method === method && r.path === path);
    if (!route) throw new Error(`route not found: ${method} ${path}`);
    return route;
  };
  return { routes, getRoute };
}

function ctxFor() {
  return { path: DIAGNOSTICS_PATH, params: {}, query: new URLSearchParams(), headers: {} } as any;
}

describe("GET /v1/diagnostics", () => {
  it("rejects an unauthenticated caller", async () => {
    const harness = createHarness({ caller: undefined });
    const route = harness.getRoute("GET", DIAGNOSTICS_PATH);
    await expect(route.handler(ctxFor())).rejects.toMatchObject({ status: 401 });
  });

  it("rejects a caller without the admin scope", async () => {
    const harness = createHarness({
      caller: {
        userId: "user-1",
        roles: ["readonly"],
        permissions: ["Tenant.Runs.Read"],
        tenantScope: ALL_TENANTS,
      },
    });
    const route = harness.getRoute("GET", DIAGNOSTICS_PATH);
    await expect(route.handler(ctxFor())).rejects.toMatchObject({ status: 403 });
  });

  it("returns the T-0016 health report plus cache status and timers", async () => {
    const harness = createHarness({
      cache: new FakeCacheSource(7),
      timers: new FakeTimersSource([
        {
          name: "standards",
          cron: "0 0 */12 * * *",
          type: "standards",
          timezone: "UTC",
          command: "Invoke-StandardsRun",
          lastRunAt: "2026-09-25T00:00:00.000Z",
          nextRunAt: "2026-09-25T12:00:00.000Z",
        },
      ]),
    });
    const route = harness.getRoute("GET", DIAGNOSTICS_PATH);
    const res = await route.handler(ctxFor());
    expect(res.status).toBe(200);
    const body = res.body as {
      health: { status: string; serviceVersion: string; queueDepth: number; workerCount: number };
      cache: { configured: boolean; entries: number };
      timers: ReadonlyArray<{ name: string; lastRunAt: string | null; nextRunAt: string | null }>;
    };
    expect(body.health.status).toBe("healthy");
    expect(body.health.serviceVersion).toBe("1.2.3");
    expect(body.health.queueDepth).toBe(4);
    expect(body.health.workerCount).toBe(3);
    expect(body.cache).toEqual({ configured: true, entries: 7 });
    expect(body.timers.length).toBeGreaterThan(0);
    const standards = body.timers.find((timer) => timer.name === "standards");
    expect(standards?.lastRunAt).toBe("2026-09-25T00:00:00.000Z");
    expect(standards?.nextRunAt).toBe("2026-09-25T12:00:00.000Z");
  });

  it("reports the cache as unconfigured and timers without state when no source is wired", async () => {
    const { report } = await computeDiagnosticsReport({
      storage: HEALTH_STORAGE,
      queue: HEALTH_QUEUE,
    });
    expect(report.cache).toEqual({ configured: false, entries: 0 });
    expect(report.timers.length).toBeGreaterThan(0);
    for (const timer of report.timers) {
      expect(timer.lastRunAt).toBeNull();
      expect(timer.nextRunAt).toBeNull();
    }
  });

  it("propagates the 503 status when storage and queue are both down", async () => {
    const down = {
      checkReachability: () => false,
    } as HealthStorageSource;
    const { status, report } = await computeDiagnosticsReport({ storage: down, queue: down });
    expect(status).toBe(503);
    expect(report.health.status).toBe("unhealthy");
  });

  it("contains no tenant data or secrets", async () => {
    const harness = createHarness({
      cache: new FakeCacheSource(3),
      timers: new FakeTimersSource(),
    });
    const route = harness.getRoute("GET", DIAGNOSTICS_PATH);
    const res = await route.handler(ctxFor());
    const serialized = JSON.stringify(res.body);
    expect(serialized).not.toMatch(/tenant/i);
    expect(serialized).not.toMatch(/secret|password|thumbprint/i);
    expect(serialized).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i);
  });
});

describe("route surface", () => {
  it("mounts GET /v1/diagnostics only", () => {
    const harness = createHarness();
    expect(harness.routes.map((r) => `${r.method} ${r.path}`)).toEqual(["GET /v1/diagnostics"]);
  });
});
