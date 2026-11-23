import { describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { SqliteRepository, loadMigrations, runMigrations } from "@m365-assess/db";
import { AppError } from "../errors.js";
import { ALL_TENANTS, tenantScope } from "../rbac/scope.js";
import type { Caller } from "../rbac/authorize.js";
import type { RequestContext, Route } from "../server.js";
import { createRunStore } from "../adapters/runs.js";
import type { RunRecord } from "./runs-create.js";
import {
  RUNS_LIST_OPENAPI,
  RUNS_LIST_PATH,
  RUNS_LIST_PERMISSION,
  createRunsListRoute,
  type RunListItem,
  type RunListRouteOptions,
  type RunListStore,
  type RunsListResponse,
} from "./runs-list.js";

const TENANT_A = "11111111-1111-1111-1111-111111111111";
const TENANT_B = "22222222-2222-2222-2222-222222222222";
const TENANT_C = "33333333-3333-3333-3333-333333333333";

class MemoryRunListStore implements RunListStore {
  runs: RunListItem[] = [];

  async listRuns(tenantId?: string): Promise<readonly RunListItem[]> {
    if (tenantId) {
      return this.runs.filter((r) => r.tenantId === tenantId);
    }
    return this.runs;
  }
}

function adminCaller(): Caller {
  return { roles: ["admin"], tenantScope: ALL_TENANTS };
}

function scopedCaller(tenantIds: string[]): Caller {
  return { roles: ["operator"], tenantScope: tenantScope(tenantIds) };
}

function runItem(id: string, tenantId: string, extra: Partial<RunListItem> = {}): RunListItem {
  const createdAt = extra.createdAt ?? "2026-06-01T10:00:00.000Z";
  const startedAt = extra.startedAt !== undefined ? extra.startedAt : createdAt;
  const finishedAt = extra.finishedAt !== undefined ? extra.finishedAt : createdAt;
  return {
    id,
    tenantId,
    parentRunId: null,
    trigger: "manual",
    sections: ["Identity", "Security"],
    status: "succeeded",
    options: null,
    startedAt,
    finishedAt,
    durationMs: 300000,
    summaryCounts: { pass: 12, fail: 1 },
    artifactPath: `/artifacts/${id}`,
    provenance: null,
    createdAt,
    updatedAt: finishedAt,
    ...extra,
  };
}

function makeContext(query: Record<string, string> = {}): RequestContext {
  const searchParams = new URLSearchParams(query);
  return {
    correlationId: "corr-1",
    method: "GET",
    path: RUNS_LIST_PATH,
    query: searchParams,
    headers: {},
    params: {},
  };
}

describe("GET /v1/runs (T-0042)", () => {
  it("filters by status, trigger, tenant, date, and section", async () => {
    const store = new MemoryRunListStore();
    store.runs = [
      runItem("run-1", TENANT_A, {
        status: "succeeded",
        trigger: "manual",
        sections: ["Identity", "Security"],
        createdAt: "2026-06-01T10:00:00.000Z",
      }),
      runItem("run-2", TENANT_A, {
        status: "failed",
        trigger: "schedule",
        sections: ["Email"],
        createdAt: "2026-06-02T10:00:00.000Z",
      }),
      runItem("run-3", TENANT_B, {
        status: "queued",
        trigger: "api",
        sections: ["Identity", "Licensing"],
        createdAt: "2026-06-03T10:00:00.000Z",
      }),
    ];

    const route = createRunsListRoute({
      store,
      resolveCaller: () => adminCaller(),
    });

    // 1. Filter by status
    const resStatus = await route.handler(makeContext({ status: "failed" }));
    expect(resStatus.status).toBe(200);
    const bodyStatus = resStatus.body as RunsListResponse;
    expect(bodyStatus.items).toHaveLength(1);
    expect(bodyStatus.items[0].id).toBe("run-2");

    // 2. Filter by trigger
    const resTrigger = await route.handler(makeContext({ trigger: "api" }));
    const bodyTrigger = resTrigger.body as RunsListResponse;
    expect(bodyTrigger.items).toHaveLength(1);
    expect(bodyTrigger.items[0].id).toBe("run-3");

    // 3. Filter by tenant
    const resTenant = await route.handler(makeContext({ tenant: TENANT_B }));
    const bodyTenant = resTenant.body as RunsListResponse;
    expect(bodyTenant.items).toHaveLength(1);
    expect(bodyTenant.items[0].id).toBe("run-3");

    // 4. Filter by section
    const resSection = await route.handler(makeContext({ section: "Email" }));
    const bodySection = resSection.body as RunsListResponse;
    expect(bodySection.items).toHaveLength(1);
    expect(bodySection.items[0].id).toBe("run-2");

    // 5. Filter by date
    const resDate = await route.handler(makeContext({ date: "2026-06-01" }));
    const bodyDate = resDate.body as RunsListResponse;
    expect(bodyDate.items).toHaveLength(1);
    expect(bodyDate.items[0].id).toBe("run-1");

    // 6. Filter by date range (from/to)
    const resDateRange = await route.handler(
      makeContext({
        dateFrom: "2026-06-01T00:00:00.000Z",
        dateTo: "2026-06-02T12:00:00.000Z",
      }),
    );
    const bodyDateRange = resDateRange.body as RunsListResponse;
    expect(bodyDateRange.items).toHaveLength(2);
    expect(bodyDateRange.items.map((i) => i.id).sort()).toEqual(["run-1", "run-2"]);
  });

  it("paginates runs with a forward cursor and limit", async () => {
    const store = new MemoryRunListStore();
    store.runs = [
      runItem("run-1", TENANT_A, { createdAt: "2026-06-01T10:00:00.000Z" }),
      runItem("run-2", TENANT_A, { createdAt: "2026-06-02T10:00:00.000Z" }),
      runItem("run-3", TENANT_A, { createdAt: "2026-06-03T10:00:00.000Z" }),
      runItem("run-4", TENANT_A, { createdAt: "2026-06-04T10:00:00.000Z" }),
      runItem("run-5", TENANT_A, { createdAt: "2026-06-05T10:00:00.000Z" }),
    ];

    const route = createRunsListRoute({
      store,
      resolveCaller: () => adminCaller(),
    });

    // Page 1: limit 2 (sorted newest first)
    const page1Res = await route.handler(makeContext({ limit: "2" }));
    const page1 = page1Res.body as RunsListResponse;
    expect(page1.items).toHaveLength(2);
    expect(page1.items[0].id).toBe("run-5");
    expect(page1.items[1].id).toBe("run-4");
    expect(page1.nextCursor).toBeTruthy();
    expect(page1.total).toBe(5);

    // Page 2: with cursor
    const page2Res = await route.handler(
      makeContext({ limit: "2", cursor: page1.nextCursor! }),
    );
    const page2 = page2Res.body as RunsListResponse;
    expect(page2.items).toHaveLength(2);
    expect(page2.items[0].id).toBe("run-3");
    expect(page2.items[1].id).toBe("run-2");
    expect(page2.nextCursor).toBeTruthy();

    // Page 3: final page
    const page3Res = await route.handler(
      makeContext({ limit: "2", cursor: page2.nextCursor! }),
    );
    const page3 = page3Res.body as RunsListResponse;
    expect(page3.items).toHaveLength(1);
    expect(page3.items[0].id).toBe("run-1");
    expect(page3.nextCursor).toBeNull();
  });

  it("collapses a single-tenant parent and its one child into one row with the child's findings", async () => {
    const store = new MemoryRunListStore();
    store.runs = [
      runItem("parent-single-1", TENANT_A, {
        parentRunId: null,
        status: "queued",
        startedAt: null,
        finishedAt: null,
        summaryCounts: null,
        artifactPath: null,
        createdAt: "2026-06-01T10:00:00.000Z",
      }),
      runItem("child-single-1", TENANT_A, {
        parentRunId: "parent-single-1",
        status: "succeeded",
        summaryCounts: { pass: 42, fail: 3, total: 45 },
        artifactPath: "/artifacts/child-single-1",
        createdAt: "2026-06-01T10:00:00.000Z",
      }),
    ];

    const route = createRunsListRoute({
      store,
      resolveCaller: () => adminCaller(),
    });

    const res = await route.handler(makeContext());
    const body = res.body as RunsListResponse;

    // One logical row, represented by the child that holds the findings.
    expect(body.items).toHaveLength(1);
    expect(body.total).toBe(1);
    expect(body.items[0]?.id).toBe("child-single-1");
    expect(body.items[0]?.tenantId).toBe(TENANT_A);
    expect(body.items[0]?.summaryCounts).toEqual({ pass: 42, fail: 3, total: 45 });
    expect(body.items[0]?.artifactPath).toBe("/artifacts/child-single-1");
    expect(body.items[0]?.status).toBe("succeeded");
    expect(body.items.some((item) => item.id === "parent-single-1")).toBe(false);
  });

  it("nests per-tenant children under one multi-tenant parent row and rolls up its status and counts", async () => {
    const store = new MemoryRunListStore();
    const parent = runItem("parent-bulk-1", TENANT_A, {
      parentRunId: null,
      options: { bulk: true },
      status: "running",
      startedAt: "2026-06-01T10:00:05.000Z",
      finishedAt: null,
      summaryCounts: null,
      artifactPath: null,
      createdAt: "2026-06-01T10:00:00.000Z",
    });
    const child1 = runItem("child-run-1", TENANT_A, {
      parentRunId: "parent-bulk-1",
      status: "succeeded",
      startedAt: "2026-06-01T10:00:05.000Z",
      finishedAt: "2026-06-01T10:05:00.000Z",
      summaryCounts: { pass: 10, fail: 1, info: 2, total: 13 },
      artifactPath: "/artifacts/child-run-1",
      createdAt: "2026-06-01T10:00:01.000Z",
    });
    const child2 = runItem("child-run-2", TENANT_B, {
      parentRunId: "parent-bulk-1",
      status: "failed",
      startedAt: "2026-06-01T10:00:06.000Z",
      finishedAt: "2026-06-01T10:10:00.000Z",
      summaryCounts: { pass: 2, fail: 8, info: 3, total: 13 },
      artifactPath: null,
      createdAt: "2026-06-01T10:00:02.000Z",
    });

    store.runs = [parent, child1, child2];

    const route = createRunsListRoute({
      store,
      resolveCaller: () => adminCaller(),
    });

    const allRes = await route.handler(makeContext());
    const allBody = allRes.body as RunsListResponse;

    // One parent row carrying both children, no separate child rows.
    expect(allBody.items).toHaveLength(1);
    expect(allBody.total).toBe(1);
    const row = allBody.items[0]!;
    expect(row.id).toBe("parent-bulk-1");
    expect(row.children?.map((c) => c.id).sort()).toEqual(["child-run-1", "child-run-2"]);
    expect(row.children?.find((c) => c.id === "child-run-1")?.summaryCounts).toEqual({
      pass: 10,
      fail: 1,
      info: 2,
      total: 13,
    });

    // Status, timing and counts roll up from the children so the parent is not empty.
    expect(row.status).toBe("partial");
    expect(row.startedAt).toBe("2026-06-01T10:00:05.000Z");
    expect(row.finishedAt).toBe("2026-06-01T10:10:00.000Z");
    expect(row.summaryCounts).toMatchObject({ pass: 12, fail: 9, info: 5, total: 26 });

    // Filters match the row or any child: child-run-2 == failed.
    const failedRes = await route.handler(makeContext({ status: "failed" }));
    const failedBody = failedRes.body as RunsListResponse;
    expect(failedBody.items.map((item) => item.id)).toEqual(["parent-bulk-1"]);

    // An explicit ?parentRunId= keeps the flat child listing.
    const childrenRes = await route.handler(makeContext({ parentRunId: "parent-bulk-1" }));    const childrenBody = childrenRes.body as RunsListResponse;
    expect(childrenBody.items).toHaveLength(2);
    expect(childrenBody.items.map((c) => c.id).sort()).toEqual(["child-run-1", "child-run-2"]);
  });

  it("lists an orphaned child on its own when its parent is outside the result set", async () => {
    const store = new MemoryRunListStore();
    store.runs = [
      runItem("child-orphan-1", TENANT_B, {
        parentRunId: "parent-not-visible",
        status: "succeeded",
      }),
    ];

    const route = createRunsListRoute({
      store,
      resolveCaller: () => scopedCaller([TENANT_B]),
    });

    const res = await route.handler(makeContext());
    const body = res.body as RunsListResponse;
    expect(body.items.map((item) => item.id)).toEqual(["child-orphan-1"]);
  });

  it("passes through tenantDisplayName and keeps the tenant ID when the tenant is gone", async () => {
    const store = new MemoryRunListStore();
    store.runs = [
      runItem("run-named", TENANT_A, { tenantDisplayName: "Contoso Ltd" }),
      runItem("run-removed-tenant", TENANT_B, { tenantDisplayName: null }),
    ];

    const route = createRunsListRoute({
      store,
      resolveCaller: () => adminCaller(),
    });

    const res = await route.handler(makeContext());
    const body = res.body as RunsListResponse;

    const named = body.items.find((item) => item.id === "run-named");
    expect(named?.tenantDisplayName).toBe("Contoso Ltd");
    expect(named?.tenantId).toBe(TENANT_A);

    const removed = body.items.find((item) => item.id === "run-removed-tenant");
    expect(removed?.tenantDisplayName ?? null).toBeNull();
    expect(removed?.tenantId).toBe(TENANT_B);
  });

  it("never returns runs for tenants outside the caller scope", async () => {
    const store = new MemoryRunListStore();
    store.runs = [
      runItem("run-allowed", TENANT_A),
      runItem("run-forbidden-b", TENANT_B),
      runItem("run-forbidden-c", TENANT_C),
    ];

    const route = createRunsListRoute({
      store,
      resolveCaller: () => scopedCaller([TENANT_A]),
    });

    // Caller scoped to TENANT_A only sees run-allowed
    const res = await route.handler(makeContext());
    const body = res.body as RunsListResponse;
    expect(body.items).toHaveLength(1);
    expect(body.items[0].id).toBe("run-allowed");
    expect(body.items[0].tenantId).toBe(TENANT_A);

    // If caller explicitly asks for a tenant outside their scope, 403 is thrown
    await expect(route.handler(makeContext({ tenant: TENANT_B }))).rejects.toMatchObject({
      status: 403,
      code: "auth.forbidden",
    });
  });

  it("requires authentication and rejects unauthenticated callers with 401", async () => {
    const store = new MemoryRunListStore();
    const route = createRunsListRoute({
      store,
      resolveCaller: () => undefined,
    });

    await expect(route.handler(makeContext())).rejects.toMatchObject({
      status: 401,
      code: "request.unauthenticated",
    });
  });

  it("matches the OpenAPI document specification", () => {
    const pathItem = RUNS_LIST_OPENAPI["/runs"];
    expect(pathItem).toBeDefined();
    expect(pathItem.get).toBeDefined();
    expect(pathItem.get.operationId).toBe("listRuns");
    expect(pathItem.get.permission).toBe(RUNS_LIST_PERMISSION);

    const paramNames = pathItem.get.parameters.map((p) => p.name);
    expect(paramNames).toContain("status");
    expect(paramNames).toContain("trigger");
    expect(paramNames).toContain("tenant");
    expect(paramNames).toContain("section");
    expect(paramNames).toContain("date");
    expect(paramNames).toContain("dateFrom");
    expect(paramNames).toContain("dateTo");
    expect(paramNames).toContain("parentRunId");
    expect(paramNames).toContain("cursor");
    expect(paramNames).toContain("limit");

    expect(pathItem.get.responses["200"]).toBeDefined();
    expect(pathItem.get.responses["401"]).toBeDefined();
    expect(pathItem.get.responses["403"]).toBeDefined();
  });
});

describe("run store tenant names (T-0918)", () => {
  function runRecord(id: string, tenantId: string, overrides: Partial<RunRecord> = {}): RunRecord {
    return {
      id,
      tenantId,
      parentRunId: null,
      trigger: "manual",
      sections: ["Identity"],
      options: null,
      startedAt: "2026-06-01T10:00:00.000Z",
      finishedAt: "2026-06-01T10:05:00.000Z",
      status: "succeeded",
      artifactPath: `runs/${tenantId}/${id}`,
      summaryCounts: { pass: 3, fail: 1, total: 4 },
      provenance: null,
      createdAt: "2026-06-01T10:00:00.000Z",
      updatedAt: "2026-06-01T10:05:00.000Z",
      ...overrides,
    };
  }

  async function setup() {
    const db = new Database(":memory:");
    const version = runMigrations(db, loadMigrations());
    const repo = new SqliteRepository(db, version, "memory");
    await repo.upsertTenant({
      id: TENANT_A,
      displayName: "Contoso Ltd",
      defaultDomain: "contoso.example",
      initialDomain: null,
      source: "direct",
      status: "active",
      excluded: false,
      lastRunAt: null,
      errorCount: 0,
    });
    await repo.upsertTenant({
      id: TENANT_B,
      displayName: "Fabrikam Inc",
      defaultDomain: null,
      initialDomain: null,
      source: "direct",
      status: "active",
      excluded: false,
      lastRunAt: null,
      errorCount: 0,
    });
    const store = createRunStore(repo, db);
    return { db, repo, store };
  }

  it("resolves the tenant display name on list rows and run detail", async () => {
    const { db, store } = await setup();
    try {
      await store.createRun!(runRecord("run-named", TENANT_A));

      const [listed] = await store.listRuns(TENANT_A);
      expect(listed).toMatchObject({
        id: "run-named",
        tenantId: TENANT_A,
        tenantDisplayName: "Contoso Ltd",
      });

      expect(await store.getRunById("run-named")).toMatchObject({
        id: "run-named",
        tenantDisplayName: "Contoso Ltd",
      });

      // Run-detail children (per-tenant progress rows) carry the name too.
      await store.createRunWithChildren!(
        runRecord("run-parent", TENANT_A),
        [runRecord("run-child", TENANT_B, { parentRunId: "run-parent" })],
      );
      const [child] = await store.listChildRuns("run-parent");
      expect(child).toMatchObject({ id: "run-child", tenantDisplayName: "Fabrikam Inc" });
    } finally {
      db.close();
    }
  });

  it("falls back to the tenant ID when the tenant has been removed", async () => {
    const { db, repo, store } = await setup();
    try {
      await store.createRun!(runRecord("run-orphaned", TENANT_A));
      await repo.softDeleteTenant(TENANT_A);

      const [listed] = await store.listRuns(TENANT_A);
      expect(listed?.tenantId).toBe(TENANT_A);
      expect(listed?.tenantDisplayName ?? null).toBeNull();

      // The default list still includes the deleted tenant's historical run.
      const all = await store.listRuns();
      const fromDefaultList = all.find((run) => run.id === "run-orphaned");
      expect(fromDefaultList?.tenantId).toBe(TENANT_A);
      expect(fromDefaultList?.tenantDisplayName ?? null).toBeNull();

      expect((await store.getRunById("run-orphaned"))?.tenantId).toBe(TENANT_A);
      expect((await store.getRunById("run-orphaned"))?.tenantDisplayName ?? null).toBeNull();
    } finally {
      db.close();
    }
  });
});
