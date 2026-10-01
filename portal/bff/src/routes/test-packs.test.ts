// T-0703 — test-pack routes. Asserts the three endpoints are tenant-scoped,
// gated on the tests.read/tests.run seam, and that the run reuses the engine
// through the injected create-run route.

import { describe, expect, it } from "vitest";
import { ALL_TENANTS, tenantScope } from "../rbac/scope.js";
import type { Caller } from "../rbac/authorize.js";
import type { RequestContext, Route, RouteResponse } from "../server.js";
import type { RunsDetailStore } from "./runs-detail.js";
import type { RunRecord } from "./runs-create.js";
import type { TestRun } from "@m365-assess/db";
import {
  TEST_PACKS_READ_PERMISSION,
  TEST_PACKS_RUN_PERMISSION,
  TEST_PACKS_RUN_PATH,
  TEST_PACKS_LIST_PATH,
  TEST_RUNS_DETAIL_PATH,
  createTestPacksRoutes,
  type TestPacksStore,
} from "./test-packs.js";

const TENANT_1 = "11111111-1111-1111-1111-111111111111";
const TENANT_2 = "22222222-2222-2222-2222-222222222222";

const CIS_CHECK_1 = "CA-DEVICE-001";
const CIS_CHECK_2 = "CA-DEVICE-002";

function adminCaller(): Caller {
  return { roles: ["admin"], tenantScope: ALL_TENANTS };
}

function scopedCaller(tenantIds: string[]): Caller {
  return { roles: ["operator"], tenantScope: tenantScope(tenantIds) };
}

function makeContext(overrides: Partial<RequestContext> = {}): RequestContext {
  return {
    correlationId: "corr-1",
    method: "GET",
    path: TEST_PACKS_LIST_PATH,
    query: new URLSearchParams(),
    headers: {},
    params: {},
    ...overrides,
  } as unknown as RequestContext;
}

function childRun(tenantId: string): RunRecord {
  return {
    id: "run-1",
    tenantId,
    parentRunId: "parent-1",
    trigger: "api",
    sections: [],
    options: null,
    startedAt: null,
    finishedAt: null,
    status: "succeeded",
    artifactPath: null,
    summaryCounts: null,
    provenance: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
}

function fakeRunRoute(tenantId: string): Route {
  return {
    method: "POST",
    path: "/v1/runs",
    handler: async (): Promise<RouteResponse> => ({
      status: 201,
      body: {
        run: { id: "parent-1", tenantId: "all" },
        children: [childRun(tenantId)],
        enqueuedJobs: ["job-1"],
      },
    }),
  };
}

class FakeDetailStore implements RunsDetailStore {
  async getRunById(): Promise<RunRecord | undefined> {
    return childRun(TENANT_1);
  }

  async listRunFindings(): Promise<readonly { id: string; checkId: string; status: string }[]> {
    return [
      { id: "f-1", checkId: CIS_CHECK_1, status: "Pass" },
      { id: "f-2", checkId: CIS_CHECK_2, status: "Fail" },
    ];
  }
}

class MemoryTestRunStore implements TestPacksStore {
  readonly runs = new Map<string, TestRun>();

  async createTestRun(input: Omit<TestRun, "createdAt">): Promise<TestRun> {
    const run: TestRun = { ...input, createdAt: "2026-01-01T00:00:00.000Z" };
    this.runs.set(run.id, run);
    return run;
  }

  async getTestRun(tenantId: string, runId: string): Promise<TestRun | undefined> {
    const run = this.runs.get(runId);
    return run && run.tenantId === tenantId ? run : undefined;
  }
}

function allowAll(_caller: Caller, _permission: string): void {}

function buildRoutes(options: {
  store?: TestPacksStore;
  runRoute?: Route;
  caller: Caller;
  authorize?: (caller: Caller, permission: string) => void | Promise<void>;
  resolveCaller?: (ctx: RequestContext) => Caller | undefined;
}) {
  return createTestPacksRoutes({
    store: options.store ?? new MemoryTestRunStore(),
    runRoute: options.runRoute ?? fakeRunRoute(TENANT_1),
    detailStore: new FakeDetailStore(),
    resolveCaller: options.resolveCaller ?? (() => options.caller),
    authorize: options.authorize ?? allowAll,
    idGenerator: () => "testrun-1",
    now: () => "2026-06-01T00:00:00.000Z",
  });
}

function findRoute(routes: ReturnType<typeof buildRoutes>, method: string, path: string) {
  const route = routes.find((r) => r.method === method && r.path === path);
  if (!route) throw new Error(`route ${method} ${path} not found`);
  return route;
}

describe("GET /v1/test-packs", () => {
  it("returns the available packs with description and check count", async () => {
    const routes = buildRoutes({ caller: adminCaller() });
    const route = findRoute(routes, "GET", TEST_PACKS_LIST_PATH);
    const response = await route.handler(makeContext({ caller: adminCaller() }));
    expect(response.status).toBe(200);
    const body = response.body as {
      packs: { id: string; name: string; description: string; checkCount: number }[];
    };
    expect(body.packs.map((p) => p.id)).toEqual(["cis", "e8"]);
    for (const pack of body.packs) {
      expect(pack.description).toBeTruthy();
      expect(pack.checkCount).toBeGreaterThan(0);
    }
  });

  it("requires authentication", async () => {
    const routes = buildRoutes({ caller: adminCaller(), resolveCaller: () => undefined });
    const route = findRoute(routes, "GET", TEST_PACKS_LIST_PATH);
    await expect(route.handler(makeContext({ caller: null }))).rejects.toMatchObject({
      status: 401,
    });
  });

  it("requires the tests.read permission", async () => {
    const routes = buildRoutes({
      caller: adminCaller(),
      authorize: () => {
        throw new Error("forbidden");
      },
    });
    const route = findRoute(routes, "GET", TEST_PACKS_LIST_PATH);
    await expect(route.handler(makeContext({ caller: adminCaller() }))).rejects.toThrow(
      "forbidden",
    );
  });
});

describe("POST /v1/test-packs/{id}/run", () => {
  it("runs the pack and returns the scored TestRun", async () => {
    const store = new MemoryTestRunStore();
    const routes = buildRoutes({ caller: adminCaller(), store, runRoute: fakeRunRoute(TENANT_1) });
    const route = findRoute(routes, "POST", TEST_PACKS_RUN_PATH);
    const response = await route.handler(
      makeContext({
        method: "POST",
        path: TEST_PACKS_RUN_PATH,
        params: { id: "cis" },
        body: { tenantId: TENANT_1 },
        caller: adminCaller(),
      }),
    );
    expect(response.status).toBe(201);
    const run = response.body as TestRun;
    expect(run.packId).toBe("cis");
    expect(run.tenantId).toBe(TENANT_1);
    expect(run.score).toBe(50);
    expect(run.results).toEqual([
      { findingId: "f-1", status: "Pass" },
      { findingId: "f-2", status: "Fail" },
    ]);
    expect(store.runs.get(run.id)).toBeDefined();
  });

  it("requires the tests.run permission", async () => {
    const routes = buildRoutes({
      caller: adminCaller(),
      authorize: (caller, permission) => {
        if (permission === TEST_PACKS_RUN_PERMISSION) {
          throw new Error("forbidden");
        }
      },
    });
    const route = findRoute(routes, "POST", TEST_PACKS_RUN_PATH);
    await expect(
      route.handler(
        makeContext({
          method: "POST",
          path: TEST_PACKS_RUN_PATH,
          params: { id: "cis" },
          body: { tenantId: TENANT_1 },
          caller: adminCaller(),
        }),
      ),
    ).rejects.toThrow("forbidden");
  });

  it("rejects a tenant outside the caller scope with 403", async () => {
    const routes = buildRoutes({ caller: scopedCaller([TENANT_1]) });
    const route = findRoute(routes, "POST", TEST_PACKS_RUN_PATH);
    await expect(
      route.handler(
        makeContext({
          method: "POST",
          path: TEST_PACKS_RUN_PATH,
          params: { id: "cis" },
          body: { tenantId: TENANT_2 },
          caller: scopedCaller([TENANT_1]),
        }),
      ),
    ).rejects.toMatchObject({ status: 403, code: "auth.forbidden" });
  });

  it("rejects a missing tenantId with 400", async () => {
    const routes = buildRoutes({ caller: adminCaller() });
    const route = findRoute(routes, "POST", TEST_PACKS_RUN_PATH);
    await expect(
      route.handler(
        makeContext({
          method: "POST",
          path: TEST_PACKS_RUN_PATH,
          params: { id: "cis" },
          body: {},
          caller: adminCaller(),
        }),
      ),
    ).rejects.toMatchObject({ status: 400 });
  });

  it("returns 404 for an unknown pack", async () => {
    const routes = buildRoutes({ caller: adminCaller() });
    const route = findRoute(routes, "POST", TEST_PACKS_RUN_PATH);
    await expect(
      route.handler(
        makeContext({
          method: "POST",
          path: TEST_PACKS_RUN_PATH,
          params: { id: "no-such-pack" },
          body: { tenantId: TENANT_1 },
          caller: adminCaller(),
        }),
      ),
    ).rejects.toMatchObject({ status: 404 });
  });
});

describe("GET /v1/test-runs/{id}", () => {
  it("returns the per-control results and the score", async () => {
    const store = new MemoryTestRunStore();
    await store.createTestRun({
      id: "run-1",
      packId: "cis",
      tenantId: TENANT_1,
      at: "2026-06-01T00:00:00.000Z",
      score: 66.7,
      results: [
        { findingId: "f-1", status: "Pass" },
        { findingId: "f-2", status: "Fail" },
      ],
    });
    const routes = buildRoutes({ caller: adminCaller(), store });
    const route = findRoute(routes, "GET", TEST_RUNS_DETAIL_PATH);
    const response = await route.handler(
      makeContext({
        path: TEST_RUNS_DETAIL_PATH,
        params: { id: "run-1" },
        query: new URLSearchParams({ tenantId: TENANT_1 }),
        caller: adminCaller(),
      }),
    );
    expect(response.status).toBe(200);
    const run = response.body as TestRun;
    expect(run.id).toBe("run-1");
    expect(run.score).toBe(66.7);
    expect(run.results).toHaveLength(2);
  });

  it("requires the tenantId query parameter", async () => {
    const routes = buildRoutes({ caller: adminCaller() });
    const route = findRoute(routes, "GET", TEST_RUNS_DETAIL_PATH);
    await expect(
      route.handler(
        makeContext({
          path: TEST_RUNS_DETAIL_PATH,
          params: { id: "run-1" },
          query: new URLSearchParams(),
          caller: adminCaller(),
        }),
      ),
    ).rejects.toMatchObject({ status: 400 });
  });

  it("returns 404 for an unknown run", async () => {
    const routes = buildRoutes({ caller: adminCaller() });
    const route = findRoute(routes, "GET", TEST_RUNS_DETAIL_PATH);
    await expect(
      route.handler(
        makeContext({
          path: TEST_RUNS_DETAIL_PATH,
          params: { id: "missing" },
          query: new URLSearchParams({ tenantId: TENANT_1 }),
          caller: adminCaller(),
        }),
      ),
    ).rejects.toMatchObject({ status: 404 });
  });

  it("rejects a tenant outside the caller scope with 403", async () => {
    const routes = buildRoutes({ caller: scopedCaller([TENANT_1]) });
    const route = findRoute(routes, "GET", TEST_RUNS_DETAIL_PATH);
    await expect(
      route.handler(
        makeContext({
          path: TEST_RUNS_DETAIL_PATH,
          params: { id: "run-1" },
          query: new URLSearchParams({ tenantId: TENANT_2 }),
          caller: scopedCaller([TENANT_1]),
        }),
      ),
    ).rejects.toMatchObject({ status: 403, code: "auth.forbidden" });
  });
});
