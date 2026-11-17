// T-0084 — Reports API: executive render, custom render, history, download, bundle
// Tests assert route behaviour without any SQL dependency.

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  buildReportBundleZip,
  readReportBundleZip,
  REPORT_BUNDLE_INVALID,
} from "../domain/reports/bundle.js";
import {
  createReportsRoutes,
  REPORTS_PERMISSIONS,
  REPORT_ARTIFACT_MISSING,
  REPORT_NOT_FOUND,
  REPORT_RUN_NOT_FOUND,
  REPORT_TENANT_REQUIRED,
  type GeneratedReportStore,
  type RenderQueuePort,
  type RunReadPort,
  type AuditPort,
  type ReportsAuthorizer,
  type StoredGeneratedReport,
  type ReportsDependencies,
} from "./reports.js";
import type { RequestContext } from "../server.js";

const tempDirs: string[] = [];
afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

// ─── Stub helpers ─────────────────────────────────────────────────────────────

function makeReport(
  overrides: Partial<StoredGeneratedReport> = {},
): StoredGeneratedReport {
  return {
    id: "rpt-1",
    templateId: null,
    tenantId: "t1",
    status: "queued",
    artifactRef: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    createdBy: "user-1",
    scheduleId: null,
    ...overrides,
  };
}

function makeStore(overrides: Partial<GeneratedReportStore> = {}): GeneratedReportStore {
  return {
    create: vi.fn().mockResolvedValue(makeReport()),
    findById: vi.fn().mockResolvedValue(makeReport()),
    list: vi.fn().mockResolvedValue([makeReport()]),
    update: vi.fn().mockResolvedValue(makeReport()),
    ...overrides,
  };
}

function makeQueue(): RenderQueuePort {
  return { enqueue: vi.fn().mockResolvedValue(undefined) };
}

function makeRuns(overrides: Partial<RunReadPort> = {}): RunReadPort {
  return {
    latestRunId: vi.fn().mockResolvedValue("run-1"),
    executivePayload: vi.fn().mockResolvedValue({
      tenantId: "t1",
      runId: "run-1",
      tenantFacts: {},
      compliance: {},
      secureScore: {},
      actionBuckets: {},
    }),
    runArtifacts: vi.fn().mockResolvedValue([
      { name: "report.html", contentType: "text/html", size: 1024, artifactRef: "art/report.html" },
    ]),
    ...overrides,
  };
}

function makeAudit(): AuditPort {
  return { record: vi.fn().mockResolvedValue(undefined) };
}

function makeAuthorizer(
  hasPermFn: (p: string) => boolean = () => true,
  actor: string | null = "user-1",
): (ctx: RequestContext) => ReportsAuthorizer {
  return () => ({
    hasPermission: hasPermFn,
    actorUserId: () => actor,
  });
}

function makeCtx(
  method: string,
  path: string,
  options: {
    body?: unknown;
    query?: Record<string, string>;
    params?: Record<string, string>;
  } = {},
): RequestContext & { body?: unknown } {
  const qs = new URLSearchParams(options.query ?? {});
  return {
    correlationId: "corr-1",
    method,
    path,
    query: qs,
    headers: {},
    params: options.params ?? {},
    body: options.body,
  };
}

function makeDeps(overrides: Partial<ReportsDependencies> = {}): ReportsDependencies {
  return {
    store: makeStore(),
    queue: makeQueue(),
    runs: makeRuns(),
    audit: makeAudit(),
    authorizer: makeAuthorizer(),
    artifactRoot: path.join(tmpdir(), "reports-test-artifacts"),
    ...overrides,
  };
}

// ─── Route lookup helper ──────────────────────────────────────────────────────

function findRoute(
  deps: ReportsDependencies,
  method: string,
  path: string,
) {
  const routes = createReportsRoutes(deps);
  const route = routes.find((r) => r.method === method && r.path === path);
  if (!route) throw new Error(`Route not found: ${method} ${path}`);
  return route;
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("POST /v1/reports/executive", () => {
  it("enqueues a render job and returns 202 with the report handle", async () => {
    const queue = makeQueue();
    const audit = makeAudit();
    const deps = makeDeps({ queue, audit });
    const route = findRoute(deps, "POST", "/v1/reports/executive");
    const ctx = makeCtx("POST", "/v1/reports/executive", { body: { tenantId: "t1" } });
    const res = await route.handler(ctx);
    expect(res.status).toBe(202);
    expect((res.body as Record<string, unknown>).status).toBe("queued");
    expect(queue.enqueue).toHaveBeenCalledOnce();
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({ action: "report.generate.executive" }),
    );
  });

  it("returns 403 without reports.generate permission", async () => {
    const deps = makeDeps({
      authorizer: makeAuthorizer((p) => p !== REPORTS_PERMISSIONS.generate),
    });
    const route = findRoute(deps, "POST", "/v1/reports/executive");
    const ctx = makeCtx("POST", "/v1/reports/executive", { body: { tenantId: "t1" } });
    await expect(route.handler(ctx)).rejects.toMatchObject({ status: 403 });
  });

  it("returns 404 when there is no run for the tenant", async () => {
    const deps = makeDeps({ runs: makeRuns({ latestRunId: vi.fn().mockResolvedValue(null) }) });
    const route = findRoute(deps, "POST", "/v1/reports/executive");
    const ctx = makeCtx("POST", "/v1/reports/executive", { body: { tenantId: "t1" } });
    await expect(route.handler(ctx)).rejects.toMatchObject({ code: REPORT_RUN_NOT_FOUND });
  });

  it("returns 400 when tenantId is missing from body", async () => {
    const deps = makeDeps();
    const route = findRoute(deps, "POST", "/v1/reports/executive");
    const ctx = makeCtx("POST", "/v1/reports/executive", { body: {} });
    await expect(route.handler(ctx)).rejects.toMatchObject({ status: 400 });
  });
});

describe("POST /v1/reports/render", () => {
  it("enqueues a custom render job and returns 202", async () => {
    const queue = makeQueue();
    const deps = makeDeps({ queue });
    const route = findRoute(deps, "POST", "/v1/reports/render");
    const ctx = makeCtx("POST", "/v1/reports/render", {
      body: { tenantId: "t1", document: { blocks: [] } },
    });
    const res = await route.handler(ctx);
    expect(res.status).toBe(202);
    expect(queue.enqueue).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ type: "custom" }),
    );
  });

  it("returns 403 without generate permission", async () => {
    const deps = makeDeps({
      authorizer: makeAuthorizer(() => false),
    });
    const route = findRoute(deps, "POST", "/v1/reports/render");
    const ctx = makeCtx("POST", "/v1/reports/render", { body: {} });
    await expect(route.handler(ctx)).rejects.toMatchObject({ status: 403 });
  });
});

describe("GET /v1/reports", () => {
  it("lists reports and returns 200", async () => {
    const deps = makeDeps();
    const route = findRoute(deps, "GET", "/v1/reports");
    const ctx = makeCtx("GET", "/v1/reports");
    const res = await route.handler(ctx);
    expect(res.status).toBe(200);
    const body = res.body as Record<string, unknown>;
    expect(Array.isArray(body.items)).toBe(true);
  });

  it("passes tenantId query parameter to the store", async () => {
    const store = makeStore();
    const deps = makeDeps({ store });
    const route = findRoute(deps, "GET", "/v1/reports");
    const ctx = makeCtx("GET", "/v1/reports", { query: { tenantId: "t1" } });
    await route.handler(ctx);
    expect(store.list).toHaveBeenCalledWith(expect.objectContaining({ tenantId: "t1" }));
  });

  it("returns 403 without read permission", async () => {
    const deps = makeDeps({ authorizer: makeAuthorizer(() => false) });
    const route = findRoute(deps, "GET", "/v1/reports");
    const ctx = makeCtx("GET", "/v1/reports");
    await expect(route.handler(ctx)).rejects.toMatchObject({ status: 403 });
  });
});

describe("GET /v1/reports/:id/download", () => {
  it("streams the artifact and content type for a succeeded report", async () => {
    const artifactRoot = mkdtempSync(path.join(tmpdir(), "reports-download-"));
    writeFileSync(path.join(artifactRoot, "report.pdf"), "%PDF-1.4\n");
    const store = makeStore({
      findById: vi.fn().mockResolvedValue(
        makeReport({ status: "succeeded", artifactRef: "report.pdf" }),
      ),
    });
    const audit = makeAudit();
    const deps = makeDeps({ store, audit, artifactRoot });
    const route = findRoute(deps, "GET", "/v1/reports/:id/download");
    const ctx = makeCtx("GET", "/v1/reports/rpt-1/download", { params: { id: "rpt-1" } });
    const res = await route.handler(ctx);
    expect(res.status).toBe(200);
    expect(res.contentType).toBe("application/pdf");
    expect(res.headers?.["Content-Disposition"]).toContain("report.pdf");
    expect(res.stream).toBeDefined();
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({ action: "report.download" }),
    );
  });

  it("returns 404 for an unknown report", async () => {
    const store = makeStore({ findById: vi.fn().mockResolvedValue(undefined) });
    const deps = makeDeps({ store });
    const route = findRoute(deps, "GET", "/v1/reports/:id/download");
    const ctx = makeCtx("GET", "/v1/reports/missing/download", { params: { id: "missing" } });
    await expect(route.handler(ctx)).rejects.toMatchObject({ code: REPORT_NOT_FOUND });
  });

  it("returns 409 when the report is still queued", async () => {
    const deps = makeDeps();
    const route = findRoute(deps, "GET", "/v1/reports/:id/download");
    const ctx = makeCtx("GET", "/v1/reports/rpt-1/download", { params: { id: "rpt-1" } });
    // Default store returns status=queued
    await expect(route.handler(ctx)).rejects.toMatchObject({ status: 409 });
  });
});

describe("POST /v1/reports/:id/bundle", () => {
  it("returns ZIP bundle metadata and base64 payload for a tenanted report (ENOENT fallback)", async () => {
    const store = makeStore({
      findById: vi.fn().mockResolvedValue(
        makeReport({ status: "succeeded", artifactRef: "art/report.pdf" }),
      ),
    });
    const audit = makeAudit();
    const deps = makeDeps({ store, audit });
    const route = findRoute(deps, "POST", "/v1/reports/:id/bundle");
    const ctx = makeCtx("POST", "/v1/reports/rpt-1/bundle", { params: { id: "rpt-1" } });
    const res = await route.handler(ctx);
    expect(res.status).toBe(200);
    const body = res.body as Record<string, unknown>;
    expect(Array.isArray(body.artifacts)).toBe(true);
    expect(body.runId).toBe("run-1");
    expect(body.fileName).toBe("report-rpt-1-bundle.zip");
    expect(body.contentType).toBe("application/zip");
    expect(typeof body.size).toBe("number");
    expect(typeof body.bundleBase64).toBe("string");
    const zip = readReportBundleZip(Buffer.from(body.bundleBase64 as string, "base64"));
    expect(zip.get("report.html")).toEqual(Buffer.alloc(0));
    expect(zip.has("report.pdf")).toBe(false);
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({ action: "report.bundle" }),
    );
  });

  it("reads run artifacts and rendered PDF from disk into the ZIP bundle", async () => {
    const artifactRoot = mkdtempSync(path.join(tmpdir(), "reports-bundle-"));
    tempDirs.push(artifactRoot);
    mkdirSync(path.join(artifactRoot, "runs/t1/run-1/Assessment"), { recursive: true });
    mkdirSync(path.join(artifactRoot, "reports/t1/rpt-1"), { recursive: true });
    writeFileSync(path.join(artifactRoot, "runs/t1/run-1/Assessment/report.html"), "<html>ok</html>");
    writeFileSync(path.join(artifactRoot, "runs/t1/run-1/Assessment/findings.json"), '{"pass":5}');
    writeFileSync(path.join(artifactRoot, "reports/t1/rpt-1/report.pdf"), "%PDF-1.4\nbody");

    const store = makeStore({
      findById: vi.fn().mockResolvedValue(
        makeReport({ status: "succeeded", artifactRef: "reports/t1/rpt-1/report.pdf" }),
      ),
    });
    const runs = makeRuns({
      runArtifacts: vi.fn().mockResolvedValue([
        {
          name: "Assessment/report.html",
          contentType: "text/html",
          size: 15,
          artifactRef: "runs/t1/run-1/Assessment/report.html",
        },
        {
          name: "Assessment/findings.json",
          contentType: "application/json",
          size: 10,
          artifactRef: "runs/t1/run-1/Assessment/findings.json",
        },
      ]),
    });
    const deps = makeDeps({ store, runs, artifactRoot });
    const route = findRoute(deps, "POST", "/v1/reports/:id/bundle");

    const res = await route.handler(makeCtx("POST", "/v1/reports/rpt-1/bundle", { params: { id: "rpt-1" } }));
    expect(res.status).toBe(200);
    const body = res.body as {
      fileName: string;
      contentType: string;
      size: number;
      bundleBase64: string;
      artifacts: Array<{ name: string; contentType: string; size: number; artifactRef: string }>;
    };
    const zipBytes = Buffer.from(body.bundleBase64, "base64");
    expect(body.size).toBe(zipBytes.length);
    const entries = readReportBundleZip(zipBytes);
    expect([...entries.keys()]).toEqual([
      "Assessment/report.html",
      "Assessment/findings.json",
      "report.pdf",
    ]);
    expect(entries.get("Assessment/report.html")?.toString("utf8")).toBe("<html>ok</html>");
    expect(entries.get("Assessment/findings.json")?.toString("utf8")).toBe('{"pass":5}');
    expect(entries.get("report.pdf")?.toString("utf8")).toBe("%PDF-1.4\nbody");
    expect(body.artifacts.map((a) => a.name)).toEqual([
      "Assessment/report.html",
      "Assessment/findings.json",
      "report.pdf",
    ]);
  });

  it("filters runArtifacts by req.body.artifacts when provided and non-empty", async () => {
    const artifactRoot = mkdtempSync(path.join(tmpdir(), "reports-bundle-filter-"));
    tempDirs.push(artifactRoot);
    mkdirSync(path.join(artifactRoot, "runs/t1/run-1"), { recursive: true });
    writeFileSync(path.join(artifactRoot, "runs/t1/run-1/report.html"), "<h1>HTML</h1>");
    writeFileSync(path.join(artifactRoot, "runs/t1/run-1/matrix.xlsx"), "XLSX");

    const store = makeStore({
      findById: vi.fn().mockResolvedValue(makeReport({ status: "succeeded", artifactRef: null })),
    });
    const runs = makeRuns({
      runArtifacts: vi.fn().mockResolvedValue([
        { name: "report.html", contentType: "text/html", size: 13, artifactRef: "runs/t1/run-1/report.html" },
        { name: "matrix.xlsx", contentType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", size: 4, artifactRef: "runs/t1/run-1/matrix.xlsx" },
      ]),
    });
    const deps = makeDeps({ store, runs, artifactRoot });
    const route = findRoute(deps, "POST", "/v1/reports/:id/bundle");

    const filtered = await route.handler(
      makeCtx("POST", "/v1/reports/rpt-1/bundle", {
        params: { id: "rpt-1" },
        body: { artifacts: ["matrix.xlsx"] },
      }),
    );
    const filteredBody = filtered.body as { bundleBase64: string; artifacts: Array<{ name: string }> };
    expect(filteredBody.artifacts.map((a) => a.name)).toEqual(["matrix.xlsx"]);
    const filteredEntries = readReportBundleZip(Buffer.from(filteredBody.bundleBase64, "base64"));
    expect([...filteredEntries.keys()]).toEqual(["matrix.xlsx"]);
    expect(filteredEntries.get("matrix.xlsx")?.toString("utf8")).toBe("XLSX");

    const emptyFilter = await route.handler(
      makeCtx("POST", "/v1/reports/rpt-1/bundle", {
        params: { id: "rpt-1" },
        body: { artifacts: [] },
      }),
    );
    const emptyBody = emptyFilter.body as { artifacts: Array<{ name: string }> };
    expect(emptyBody.artifacts.map((a) => a.name)).toEqual(["report.html", "matrix.xlsx"]);
  });

  it("rejects invalid artifacts filter and path traversal references", async () => {
    const store = makeStore({
      findById: vi.fn().mockResolvedValue(makeReport({ status: "succeeded", artifactRef: null })),
    });
    const route = findRoute(makeDeps({ store }), "POST", "/v1/reports/:id/bundle");

    await expect(
      route.handler(
        makeCtx("POST", "/v1/reports/rpt-1/bundle", {
          params: { id: "rpt-1" },
          body: { artifacts: "report.html" },
        }),
      ),
    ).rejects.toMatchObject({ status: 400 });

    const traversalDeps = makeDeps({
      store,
      runs: makeRuns({
        runArtifacts: vi.fn().mockResolvedValue([
          { name: "secret.txt", contentType: "text/plain", size: 1, artifactRef: "../../etc/passwd" },
        ]),
      }),
    });
    await expect(
      findRoute(traversalDeps, "POST", "/v1/reports/:id/bundle").handler(
        makeCtx("POST", "/v1/reports/rpt-1/bundle", { params: { id: "rpt-1" } }),
      ),
    ).rejects.toMatchObject({ code: REPORT_ARTIFACT_MISSING, status: 400 });

    const absPathDeps = makeDeps({
      store: makeStore({
        findById: vi.fn().mockResolvedValue(makeReport({ status: "succeeded", artifactRef: "/etc/passwd" })),
      }),
      runs: makeRuns({ runArtifacts: vi.fn().mockResolvedValue([]) }),
    });
    await expect(
      findRoute(absPathDeps, "POST", "/v1/reports/:id/bundle").handler(
        makeCtx("POST", "/v1/reports/rpt-1/bundle", { params: { id: "rpt-1" } }),
      ),
    ).rejects.toMatchObject({ code: REPORT_ARTIFACT_MISSING, status: 400 });
  });

  it("returns 400 when report has no tenantId", async () => {
    const store = makeStore({
      findById: vi.fn().mockResolvedValue(makeReport({ tenantId: null })),
    });
    const deps = makeDeps({ store });
    const route = findRoute(deps, "POST", "/v1/reports/:id/bundle");
    const ctx = makeCtx("POST", "/v1/reports/rpt-1/bundle", { params: { id: "rpt-1" } });
    await expect(route.handler(ctx)).rejects.toMatchObject({ code: REPORT_TENANT_REQUIRED });
  });

  it("returns 404 when there is no run for the tenant", async () => {
    const store = makeStore({
      findById: vi.fn().mockResolvedValue(
        makeReport({ status: "succeeded", artifactRef: "art/report.pdf" }),
      ),
    });
    const deps = makeDeps({
      store,
      runs: makeRuns({ latestRunId: vi.fn().mockResolvedValue(null) }),
    });
    const route = findRoute(deps, "POST", "/v1/reports/:id/bundle");
    const ctx = makeCtx("POST", "/v1/reports/rpt-1/bundle", { params: { id: "rpt-1" } });
    await expect(route.handler(ctx)).rejects.toMatchObject({ code: REPORT_RUN_NOT_FOUND });
  });

  it("returns 403 without generate permission", async () => {
    const deps = makeDeps({ authorizer: makeAuthorizer(() => false) });
    const route = findRoute(deps, "POST", "/v1/reports/:id/bundle");
    const ctx = makeCtx("POST", "/v1/reports/rpt-1/bundle", { params: { id: "rpt-1" } });
    await expect(route.handler(ctx)).rejects.toMatchObject({ status: 403 });
  });
});

describe("report bundle ZIP domain (T-0875)", () => {
  it("round-trips empty and multi-entry ZIP archives and verifies CRC32", () => {
    const emptyZip = buildReportBundleZip([]);
    expect(readReportBundleZip(emptyZip).size).toBe(0);

    const archive = buildReportBundleZip([
      { name: "nested/hello.txt", data: Buffer.from("hello world", "utf8") },
      { name: "data.bin", data: Buffer.from([0x00, 0xff, 0x10, 0x20]) },
    ]);
    const extracted = readReportBundleZip(archive);
    expect(extracted.get("nested/hello.txt")?.toString("utf8")).toBe("hello world");
    expect(extracted.get("data.bin")).toEqual(Buffer.from([0x00, 0xff, 0x10, 0x20]));

    const corrupted = Buffer.from(archive);
    const idx = corrupted.indexOf("hello world");
    corrupted[idx] = "H".charCodeAt(0);
    expect(() => readReportBundleZip(corrupted)).toThrowError(
      expect.objectContaining({ code: REPORT_BUNDLE_INVALID, status: 400 }),
    );
    expect(() => readReportBundleZip(Buffer.from("not-a-zip"))).toThrowError(
      expect.objectContaining({ code: REPORT_BUNDLE_INVALID, status: 400 }),
    );
  });
});

describe("tenant scope (T-0823)", () => {
  const scoped = (allowed: string[]) => (): ReportsAuthorizer => ({
    hasPermission: () => true,
    actorUserId: () => "user-1",
    canAccessTenant: (tenantId) => allowed.includes(tenantId),
  });

  it("hides reports for tenants outside the caller's scope from history", async () => {
    const store = makeStore({
      list: vi.fn().mockResolvedValue([makeReport({ id: "a", tenantId: "t1" }), makeReport({ id: "b", tenantId: "t2" }), makeReport({ id: "g", tenantId: null })]),
    });
    const route = findRoute(makeDeps({ store, authorizer: scoped(["t1"]) }), "GET", "/v1/reports");
    const res = await route.handler(makeCtx("GET", "/v1/reports"));
    expect((res.body as { items: { id: string }[] }).items.map((r) => r.id)).toEqual(["a", "g"]);
    await expect(route.handler(makeCtx("GET", "/v1/reports", { query: { tenantId: "t2" } }))).rejects.toMatchObject({ status: 403 });
  });

  it("refuses to generate, download, or bundle for an out-of-scope tenant", async () => {
    const queue = makeQueue();
    const deps = makeDeps({
      queue,
      authorizer: scoped(["t1"]),
      store: makeStore({ findById: vi.fn().mockResolvedValue(makeReport({ tenantId: "t2", status: "succeeded", artifactRef: "a.pdf" })) }),
    });
    await expect(
      findRoute(deps, "POST", "/v1/reports/executive").handler(makeCtx("POST", "/v1/reports/executive", { body: { tenantId: "t2" } })),
    ).rejects.toMatchObject({ status: 403 });
    await expect(
      findRoute(deps, "GET", "/v1/reports/:id/download").handler(makeCtx("GET", "/v1/reports/r/download", { params: { id: "r" } })),
    ).rejects.toMatchObject({ status: 403 });
    await expect(
      findRoute(deps, "POST", "/v1/reports/:id/bundle").handler(makeCtx("POST", "/v1/reports/r/bundle", { params: { id: "r" } })),
    ).rejects.toMatchObject({ status: 403 });
    expect(queue.enqueue).not.toHaveBeenCalled();
  });
});
