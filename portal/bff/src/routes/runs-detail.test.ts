import { describe, expect, it } from "vitest";
import { AppError } from "../errors.js";
import { ALL_TENANTS, tenantScope } from "../rbac/scope.js";
import type { Caller } from "../rbac/authorize.js";
import type { RequestContext } from "../server.js";
import {
  RUNS_DETAIL_PATH,
  RUNS_RESULTS_PATH,
  RUNS_DETAIL_PERMISSION,
  RUNS_RESULTS_PERMISSION,
  createRunsDetailRoute,
  createRunsResultsRoute,
  createRunsDetailRoutes,
  normalizeSummaryCounts,
  RUNS_DETAIL_OPENAPI,
  RUNS_RESULTS_OPENAPI,
  type RunDetailRecord,
  type RunDetailResponse,
  type RunFindingRecord,
  type RunIssue,
  type RunResultsResponse,
  type RunSectionRecord,
  type RunsDetailStore,
} from "./runs-detail.js";

const TENANT_1 = "11111111-1111-1111-1111-111111111111";
const TENANT_2 = "22222222-2222-2222-2222-222222222222";
const TENANT_3 = "33333333-3333-3333-3333-333333333333";

class FakeRunsDetailStore implements RunsDetailStore {
  readonly runs = new Map<string, RunDetailRecord>();
  readonly sections = new Map<string, RunSectionRecord[]>();
  readonly findings = new Map<string, RunFindingRecord[]>();
  readonly issues = new Map<string, RunIssue[]>();

  async getRunById(runId: string): Promise<RunDetailRecord | undefined> {
    return this.runs.get(runId);
  }

  async listChildRuns(parentRunId: string): Promise<readonly RunDetailRecord[]> {
    const results: RunDetailRecord[] = [];
    for (const run of this.runs.values()) {
      if (run.parentRunId === parentRunId) {
        results.push(run);
      }
    }
    return results;
  }

  async listRunSections(tenantId: string, runId: string): Promise<readonly RunSectionRecord[]> {
    return this.sections.get(runId) ?? [];
  }

  async listRunFindings(tenantId: string, runId: string): Promise<readonly RunFindingRecord[]> {
    return this.findings.get(runId) ?? [];
  }

  async listRunIssues(tenantId: string, runId: string): Promise<readonly RunIssue[]> {
    return this.issues.get(runId) ?? [];
  }
}

function adminCaller(): Caller {
  return { roles: ["admin"], tenantScope: ALL_TENANTS };
}

function scopedCaller(tenantIds: string[]): Caller {
  return { roles: ["operator"], tenantScope: tenantScope(tenantIds) };
}

function unprivilegedCaller(): Caller {
  return { roles: [], tenantScope: ALL_TENANTS };
}

function createDetailContext(runId: string): RequestContext {
  return {
    correlationId: "corr-detail-1",
    method: "GET",
    path: `/v1/runs/${runId}`,
    query: new URLSearchParams(),
    headers: {},
    params: { runId },
  };
}

function createResultsContext(runId: string, queryStr = ""): RequestContext {
  return {
    correlationId: "corr-results-1",
    method: "GET",
    path: `/v1/runs/${runId}/results`,
    query: new URLSearchParams(queryStr),
    headers: {},
    params: { runId },
  };
}

describe("runs-detail route (GET /v1/runs/:runId)", () => {
  it("rejects unauthenticated requests with 401", async () => {
    const store = new FakeRunsDetailStore();
    const route = createRunsDetailRoute({
      store,
      resolveCaller: () => undefined,
    });

    await expect(route.handler(createDetailContext("run-1"))).rejects.toMatchObject({
      code: "request.unauthenticated",
      status: 401,
    });
  });

  it("refuses callers without runs.read permission with 403", async () => {
    const store = new FakeRunsDetailStore();
    const route = createRunsDetailRoute({
      store,
      resolveCaller: () => unprivilegedCaller(),
    });

    await expect(route.handler(createDetailContext("run-1"))).rejects.toMatchObject({
      code: "auth.forbidden",
      status: 403,
    });
  });

  it("returns 404 when run does not exist", async () => {
    const store = new FakeRunsDetailStore();
    const route = createRunsDetailRoute({
      store,
      resolveCaller: () => adminCaller(),
    });

    await expect(route.handler(createDetailContext("missing-run"))).rejects.toMatchObject({
      code: "run.not_found",
      status: 404,
    });
  });

  it("refuses access to a run for a tenant outside the caller's scope", async () => {
    const store = new FakeRunsDetailStore();
    store.runs.set("run-1", {
      id: "run-1",
      tenantId: TENANT_2,
      parentRunId: null,
      trigger: "manual",
      sections: ["Identity"],
      options: null,
      startedAt: null,
      finishedAt: null,
      status: "succeeded",
      artifactPath: null,
      summaryCounts: null,
      provenance: null,
      createdAt: "2026-06-01T10:00:00.000Z",
      updatedAt: "2026-06-01T10:00:00.000Z",
    });

    const route = createRunsDetailRoute({
      store,
      resolveCaller: () => scopedCaller([TENANT_1]),
    });

    await expect(route.handler(createDetailContext("run-1"))).rejects.toMatchObject({
      code: "auth.forbidden",
      status: 403,
    });
  });

  it("returns single run detail, section rows, and summary counts", async () => {
    const store = new FakeRunsDetailStore();
    store.runs.set("run-1", {
      id: "run-1",
      tenantId: TENANT_1,
      parentRunId: null,
      trigger: "manual",
      sections: ["Identity", "Email"],
      options: null,
      startedAt: "2026-06-01T10:00:00.000Z",
      finishedAt: "2026-06-01T10:05:00.000Z",
      status: "succeeded",
      artifactPath: "/artifacts/run-1",
      summaryCounts: { pass: 15, fail: 2, warning: 1, review: 0, skipped: 3, notLicensed: 1 },
      provenance: null,
      createdAt: "2026-06-01T10:00:00.000Z",
      updatedAt: "2026-06-01T10:05:00.000Z",
    });

    store.sections.set("run-1", [
      {
        id: "sec-1",
        runId: "run-1",
        tenantId: TENANT_1,
        section: "Identity",
        collector: "Entra",
        status: "succeeded",
        startedAt: "2026-06-01T10:00:00.000Z",
        finishedAt: "2026-06-01T10:02:00.000Z",
        createdAt: "2026-06-01T10:00:00.000Z",
        updatedAt: "2026-06-01T10:02:00.000Z",
      },
      {
        id: "sec-2",
        runId: "run-1",
        tenantId: TENANT_1,
        section: "Email",
        collector: "ExchangeOnline",
        status: "succeeded",
        startedAt: "2026-06-01T10:02:00.000Z",
        finishedAt: "2026-06-01T10:05:00.000Z",
        createdAt: "2026-06-01T10:02:00.000Z",
        updatedAt: "2026-06-01T10:05:00.000Z",
      },
    ]);

    const route = createRunsDetailRoute({
      store,
      resolveCaller: () => scopedCaller([TENANT_1]),
    });

    const response = await route.handler(createDetailContext("run-1"));
    expect(response.status).toBe(200);

    const body = response.body as RunDetailResponse;
    expect(body.id).toBe("run-1");
    expect(body.tenantId).toBe(TENANT_1);
    expect(body.status).toBe("succeeded");
    expect(body.sections).toHaveLength(2);
    expect(body.sections[0]?.section).toBe("Identity");
    expect(body.summaryCounts).toEqual({
      pass: 15,
      fail: 2,
      warning: 1,
      review: 0,
      skipped: 3,
      notLicensed: 1,
      total: 22,
    });
  });

  it("aggregates child runs and their metrics for a parent run", async () => {
    const store = new FakeRunsDetailStore();

    // Parent run
    store.runs.set("parent-1", {
      id: "parent-1",
      tenantId: "all",
      parentRunId: null,
      trigger: "manual",
      sections: ["Identity"],
      options: null,
      startedAt: "2026-06-01T10:00:00.000Z",
      finishedAt: "2026-06-01T10:10:00.000Z",
      status: "succeeded",
      artifactPath: null,
      summaryCounts: null,
      provenance: null,
      createdAt: "2026-06-01T10:00:00.000Z",
      updatedAt: "2026-06-01T10:10:00.000Z",
    });

    // Child 1
    store.runs.set("child-1", {
      id: "child-1",
      tenantId: TENANT_1,
      parentRunId: "parent-1",
      trigger: "manual",
      sections: ["Identity"],
      options: null,
      startedAt: "2026-06-01T10:00:00.000Z",
      finishedAt: "2026-06-01T10:05:00.000Z",
      status: "succeeded",
      artifactPath: null,
      summaryCounts: { pass: 10, fail: 1, warning: 0, review: 0, skipped: 1, notLicensed: 0 },
      provenance: null,
      createdAt: "2026-06-01T10:00:00.000Z",
      updatedAt: "2026-06-01T10:05:00.000Z",
    });

    // Child 2
    store.runs.set("child-2", {
      id: "child-2",
      tenantId: TENANT_2,
      parentRunId: "parent-1",
      trigger: "manual",
      sections: ["Identity"],
      options: null,
      startedAt: "2026-06-01T10:00:00.000Z",
      finishedAt: "2026-06-01T10:08:00.000Z",
      status: "succeeded",
      artifactPath: null,
      summaryCounts: { pass: 8, fail: 2, warning: 1, review: 1, skipped: 0, notLicensed: 0 },
      provenance: null,
      createdAt: "2026-06-01T10:00:00.000Z",
      updatedAt: "2026-06-01T10:08:00.000Z",
    });

    store.sections.set("child-1", [
      {
        id: "c1-sec-1",
        runId: "child-1",
        tenantId: TENANT_1,
        section: "Identity",
        status: "succeeded",
        createdAt: "2026-06-01T10:00:00.000Z",
        updatedAt: "2026-06-01T10:05:00.000Z",
      },
    ]);

    store.sections.set("child-2", [
      {
        id: "c2-sec-1",
        runId: "child-2",
        tenantId: TENANT_2,
        section: "Identity",
        status: "succeeded",
        createdAt: "2026-06-01T10:00:00.000Z",
        updatedAt: "2026-06-01T10:08:00.000Z",
      },
    ]);

    const route = createRunsDetailRoute({
      store,
      resolveCaller: () => adminCaller(),
    });

    const response = await route.handler(createDetailContext("parent-1"));
    expect(response.status).toBe(200);

    const body = response.body as RunDetailResponse;
    expect(body.id).toBe("parent-1");
    expect(body.children).toHaveLength(2);
    expect(body.sections).toHaveLength(2);

    // Assert aggregated KPI summaryCounts (pass: 10 + 8 = 18, fail: 1 + 2 = 3)
    expect(body.summaryCounts).toEqual({
      pass: 18,
      fail: 3,
      warning: 1,
      review: 1,
      skipped: 1,
      notLicensed: 0,
      total: 24,
    });
  });

  it("filters parent children according to caller scope", async () => {
    const store = new FakeRunsDetailStore();
    store.runs.set("parent-1", {
      id: "parent-1",
      tenantId: "all",
      parentRunId: null,
      trigger: "manual",
      sections: ["Identity"],
      options: null,
      startedAt: null,
      finishedAt: null,
      status: "succeeded",
      artifactPath: null,
      summaryCounts: null,
      provenance: null,
      createdAt: "2026-06-01T10:00:00.000Z",
      updatedAt: "2026-06-01T10:00:00.000Z",
    });

    store.runs.set("child-1", {
      id: "child-1",
      tenantId: TENANT_1,
      parentRunId: "parent-1",
      trigger: "manual",
      sections: ["Identity"],
      options: null,
      startedAt: null,
      finishedAt: null,
      status: "succeeded",
      artifactPath: null,
      summaryCounts: { pass: 10, fail: 0, warning: 0, review: 0, skipped: 0, notLicensed: 0 },
      provenance: null,
      createdAt: "2026-06-01T10:00:00.000Z",
      updatedAt: "2026-06-01T10:00:00.000Z",
    });

    store.runs.set("child-2", {
      id: "child-2",
      tenantId: TENANT_2,
      parentRunId: "parent-1",
      trigger: "manual",
      sections: ["Identity"],
      options: null,
      startedAt: null,
      finishedAt: null,
      status: "succeeded",
      artifactPath: null,
      summaryCounts: { pass: 20, fail: 0, warning: 0, review: 0, skipped: 0, notLicensed: 0 },
      provenance: null,
      createdAt: "2026-06-01T10:00:00.000Z",
      updatedAt: "2026-06-01T10:00:00.000Z",
    });

    // Caller only has access to TENANT_1
    const route = createRunsDetailRoute({
      store,
      resolveCaller: () => scopedCaller([TENANT_1]),
    });

    const response = await route.handler(createDetailContext("parent-1"));
    expect(response.status).toBe(200);

    const body = response.body as RunDetailResponse;
    expect(body.children).toHaveLength(1);
    expect(body.children![0]?.id).toBe("child-1");
    // Summary count only counts visible children (10 pass instead of 30)
    expect(body.summaryCounts.pass).toBe(10);
  });
});

describe("runs-results route (GET /v1/runs/:runId/results)", () => {
  it("rejects unauthenticated requests with 401", async () => {
    const store = new FakeRunsDetailStore();
    const route = createRunsResultsRoute({
      store,
      resolveCaller: () => undefined,
    });

    await expect(route.handler(createResultsContext("run-1"))).rejects.toMatchObject({
      code: "request.unauthenticated",
      status: 401,
    });
  });

  it("returns paginated findings and issue log", async () => {
    const store = new FakeRunsDetailStore();
    store.runs.set("run-1", {
      id: "run-1",
      tenantId: TENANT_1,
      parentRunId: null,
      trigger: "manual",
      sections: ["Identity"],
      options: null,
      startedAt: null,
      finishedAt: null,
      status: "succeeded",
      artifactPath: null,
      summaryCounts: null,
      provenance: null,
      createdAt: "2026-06-01T10:00:00.000Z",
      updatedAt: "2026-06-01T10:00:00.000Z",
    });

    const sampleFindings: RunFindingRecord[] = [
      {
        id: "find-1",
        runId: "run-1",
        tenantId: TENANT_1,
        status: "Pass",
        severity: "High",
        category: "Identity",
        createdAt: "2026-06-01T10:00:00.000Z",
        updatedAt: "2026-06-01T10:00:00.000Z",
      },
      {
        id: "find-2",
        runId: "run-1",
        tenantId: TENANT_1,
        status: "Fail",
        severity: "Critical",
        category: "Identity",
        createdAt: "2026-06-01T10:00:00.000Z",
        updatedAt: "2026-06-01T10:00:00.000Z",
      },
      {
        id: "find-3",
        runId: "run-1",
        tenantId: TENANT_1,
        status: "Warning",
        severity: "Medium",
        category: "Identity",
        createdAt: "2026-06-01T10:00:00.000Z",
        updatedAt: "2026-06-01T10:00:00.000Z",
      },
    ];
    store.findings.set("run-1", sampleFindings);

    const sampleIssues: RunIssue[] = [
      {
        level: "WARNING",
        section: "Identity",
        collector: "Entra",
        message: "Graph API returned 429 throttling warning; retried successfully",
      },
    ];
    store.issues.set("run-1", sampleIssues);

    const route = createRunsResultsRoute({
      store,
      resolveCaller: () => scopedCaller([TENANT_1]),
    });

    // Request page 1 with limit=2
    const responsePage1 = await route.handler(createResultsContext("run-1", "limit=2"));
    expect(responsePage1.status).toBe(200);

    const body1 = responsePage1.body as RunResultsResponse;
    expect(body1.runId).toBe("run-1");
    expect(body1.tenantId).toBe(TENANT_1);
    expect(body1.total).toBe(3);
    expect(body1.items).toHaveLength(2);
    expect(body1.nextCursor).not.toBeNull();
    expect(body1.issues).toHaveLength(1);
    expect(body1.issues[0]?.message).toContain("throttling");

    // Request page 2 with cursor
    const responsePage2 = await route.handler(
      createResultsContext("run-1", `limit=2&cursor=${encodeURIComponent(body1.nextCursor!)}`),
    );
    expect(responsePage2.status).toBe(200);

    const body2 = responsePage2.body as RunResultsResponse;
    expect(body2.items).toHaveLength(1);
    expect(body2.items[0]?.id).toBe("find-3");
    expect(body2.nextCursor).toBeNull();
  });

  it("reads issues from run options/provenance when store method is omitted", async () => {
    const store = new FakeRunsDetailStore();
    store.runs.set("run-opt", {
      id: "run-opt",
      tenantId: TENANT_1,
      parentRunId: null,
      trigger: "manual",
      sections: ["Identity"],
      options: {
        issues: [
          { level: "INFO", message: "Option issue message" },
        ],
      },
      startedAt: null,
      finishedAt: null,
      status: "succeeded",
      artifactPath: null,
      summaryCounts: null,
      provenance: null,
      createdAt: "2026-06-01T10:00:00.000Z",
      updatedAt: "2026-06-01T10:00:00.000Z",
    });

    const route = createRunsResultsRoute({
      store: {
        getRunById: (id) => store.getRunById(id),
        listRunSections: (t, r) => store.listRunSections(t, r),
        listRunFindings: (t, r) => store.listRunFindings(t, r),
      },
      resolveCaller: () => scopedCaller([TENANT_1]),
    });

    const response = await route.handler(createResultsContext("run-opt"));
    const body = response.body as RunResultsResponse;
    expect(body.issues).toHaveLength(1);
    expect(body.issues[0]?.message).toBe("Option issue message");
  });

  it("aggregates findings and issues across child runs for a parent run", async () => {
    const store = new FakeRunsDetailStore();
    store.runs.set("parent-1", {
      id: "parent-1",
      tenantId: "all",
      parentRunId: null,
      trigger: "manual",
      sections: ["Identity"],
      options: null,
      startedAt: null,
      finishedAt: null,
      status: "succeeded",
      artifactPath: null,
      summaryCounts: null,
      provenance: null,
      createdAt: "2026-06-01T10:00:00.000Z",
      updatedAt: "2026-06-01T10:00:00.000Z",
    });

    store.runs.set("child-1", {
      id: "child-1",
      tenantId: TENANT_1,
      parentRunId: "parent-1",
      trigger: "manual",
      sections: ["Identity"],
      options: null,
      startedAt: null,
      finishedAt: null,
      status: "succeeded",
      artifactPath: null,
      summaryCounts: null,
      provenance: null,
      createdAt: "2026-06-01T10:00:00.000Z",
      updatedAt: "2026-06-01T10:00:00.000Z",
    });

    store.runs.set("child-2", {
      id: "child-2",
      tenantId: TENANT_2,
      parentRunId: "parent-1",
      trigger: "manual",
      sections: ["Identity"],
      options: null,
      startedAt: null,
      finishedAt: null,
      status: "succeeded",
      artifactPath: null,
      summaryCounts: null,
      provenance: null,
      createdAt: "2026-06-01T10:00:00.000Z",
      updatedAt: "2026-06-01T10:00:00.000Z",
    });

    store.findings.set("child-1", [
      { id: "c1-f1", runId: "child-1", tenantId: TENANT_1, status: "Pass", createdAt: "", updatedAt: "" },
    ]);
    store.findings.set("child-2", [
      { id: "c2-f1", runId: "child-2", tenantId: TENANT_2, status: "Fail", createdAt: "", updatedAt: "" },
    ]);

    store.issues.set("child-1", [{ message: "Child 1 issue" }]);
    store.issues.set("child-2", [{ message: "Child 2 issue" }]);

    const route = createRunsResultsRoute({
      store,
      resolveCaller: () => adminCaller(),
    });

    const response = await route.handler(createResultsContext("parent-1"));
    const body = response.body as RunResultsResponse;

    expect(body.total).toBe(2);
    expect(body.items).toHaveLength(2);
    expect(body.issues).toHaveLength(2);
  });
});

describe("createRunsDetailRoutes factory", () => {
  it("creates both detail and results routes with valid OpenAPI definitions", () => {
    const store = new FakeRunsDetailStore();
    const routes = createRunsDetailRoutes({
      store,
      resolveCaller: () => adminCaller(),
    });

    expect(routes).toHaveLength(2);
    expect(routes[0]?.path).toBe(RUNS_DETAIL_PATH);
    expect(routes[1]?.path).toBe(RUNS_RESULTS_PATH);

    expect(RUNS_DETAIL_OPENAPI["/v1/runs/{runId}"]).toBeDefined();
    expect(RUNS_RESULTS_OPENAPI["/v1/runs/{runId}/results"]).toBeDefined();
  });
});
