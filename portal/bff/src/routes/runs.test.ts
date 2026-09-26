import { describe, expect, it } from "vitest";
import { AppError } from "../errors.js";
import { ALL_TENANTS, tenantScope } from "../rbac/scope.js";
import type { Caller } from "../rbac/authorize.js";
import type { Route, RouteHandler, RouteResponse } from "../server.js";
import { createMemoryIdempotencyStore } from "../domain/runs/run-lifecycle.js";
import {
  RUN_ARTIFACT_PATH,
  RUN_CANCEL_PATH,
  RUN_PATH,
  RUN_PERMISSIONS,
  RUN_RESULTS_PATH,
  RUNS_OPENAPI,
  TENANT_RUNS_PATH,
  createRunRoutes,
  type RunArtifact,
  type RunArtifactReader,
  type RunCreateInput,
  type RunFinding,
  type RunQueue,
  type RunRecord,
  type RunRouteOptions,
  type RunSectionRecord,
  type RunStatusPatch,
  type RunStore,
} from "./runs.js";

const NOW = "2026-06-01T00:00:00.000Z";

class MemoryRunStore implements RunStore {
  readonly runs = new Map<string, RunRecord>();
  sections: RunSectionRecord[] = [];
  findings: RunFinding[] = [];

  async createRun(input: RunCreateInput): Promise<RunRecord> {
    const stored: RunRecord = {
      ...input,
      sections: [...input.sections],
      createdAt: input.createdAt ?? NOW,
      updatedAt: input.updatedAt ?? NOW,
    };
    this.runs.set(stored.id, stored);
    return { ...stored, sections: [...stored.sections] };
  }

  async getRunById(runId: string): Promise<RunRecord | undefined> {
    const found = this.runs.get(runId);
    return found === undefined ? undefined : { ...found, sections: [...found.sections] };
  }

  async updateRun(
    tenantId: string,
    runId: string,
    patch: RunStatusPatch,
  ): Promise<RunRecord | undefined> {
    const found = this.runs.get(runId);
    if (found === undefined || found.tenantId !== tenantId) {
      return undefined;
    }
    const next: RunRecord = { ...found, ...patch, updatedAt: NOW };
    this.runs.set(runId, next);
    return { ...next };
  }

  async listRunSections(tenantId: string, runId: string): Promise<RunSectionRecord[]> {
    return this.sections
      .filter((section) => section.tenantId === tenantId && section.runId === runId)
      .map((section) => ({ ...section }));
  }

  async listRunFindings(tenantId: string, runId: string): Promise<RunFinding[]> {
    return this.findings
      .filter((finding) => finding.tenantId === tenantId && finding.runId === runId)
      .map((finding) => ({ ...finding }));
  }
}

class FakeQueue implements RunQueue {
  readonly envelopes: unknown[] = [];
  readonly cancelledJobs: string[] = [];
  cancelResult = true;

  async enqueue(envelope: unknown): Promise<string> {
    this.envelopes.push(envelope);
    return (envelope as { jobId: string }).jobId;
  }

  async cancel(jobId: string): Promise<boolean> {
    this.cancelledJobs.push(jobId);
    return this.cancelResult;
  }
}

class FakeArtifacts implements RunArtifactReader {
  readonly files = new Map<string, RunArtifact>();

  async readArtifact(path: string): Promise<RunArtifact | undefined> {
    return this.files.get(path);
  }
}

function adminCaller(): Caller {
  return { roles: ["admin"], tenantScope: ALL_TENANTS };
}

function scopedCaller(tenantIds: string[]): Caller {
  return { roles: ["operator"], tenantScope: tenantScope(tenantIds) };
}

interface Harness {
  routes: Route[];
  store: MemoryRunStore;
  queue: FakeQueue;
  artifacts: FakeArtifacts;
  seenPermissions: string[];
}

function harness(overrides: Partial<RunRouteOptions> = {}): Harness {
  const store = new MemoryRunStore();
  const queue = new FakeQueue();
  const artifacts = new FakeArtifacts();
  const seenPermissions: string[] = [];
  let sequence = 0;
  const routes = createRunRoutes({
    store,
    queue,
    idempotency: createMemoryIdempotencyStore(),
    artifacts,
    artifactRoot: "/data",
    resolveCaller: () => adminCaller(),
    authorize: (caller, permission) => {
      void caller;
      seenPermissions.push(permission);
    },
    now: () => NOW,
    newIds: () => {
      sequence += 1;
      return { jobId: `job-${sequence}`, runId: `run-${sequence}`, requestId: `req-${sequence}` };
    },
    ...overrides,
  });
  return { routes, store, queue, artifacts, seenPermissions };
}

interface TestContext {
  correlationId: string;
  method: string;
  path: string;
  query: URLSearchParams;
  headers: Record<string, string>;
  params: Record<string, string>;
  body?: unknown;
}

type HandlerContext = Parameters<RouteHandler>[0];

function context(overrides: Partial<TestContext> = {}): HandlerContext {
  return {
    correlationId: "corr-test",
    method: "GET",
    path: RUN_PATH,
    query: new URLSearchParams(),
    headers: {},
    params: {},
    ...overrides,
  } as unknown as HandlerContext;
}

function findRoute(routes: readonly Route[], method: string, path: string): RouteHandler {
  const route = routes.find((candidate) => candidate.method === method && candidate.path === path);
  if (route === undefined) {
    throw new Error(`no route registered for ${method} ${path}`);
  }
  return route.handler;
}

function invoke(
  routes: readonly Route[],
  method: string,
  path: string,
  overrides: Partial<TestContext> = {},
): Promise<RouteResponse> {
  return Promise.resolve(
    findRoute(routes, method, path)(context({ method, path, ...overrides })),
  );
}

function section(runId: string, tenantId: string, name: string): RunSectionRecord {
  return {
    id: `${runId}-${name}`,
    runId,
    tenantId,
    section: name,
    collector: `${name}.ps1`,
    status: "succeeded",
    startedAt: NOW,
    finishedAt: NOW,
    createdAt: NOW,
    updatedAt: NOW,
  };
}

function finding(runId: string, tenantId: string, checkId: string): RunFinding {
  return {
    id: `${runId}-${checkId}`,
    runId,
    tenantId,
    status: "Fail",
    severity: "High",
    category: "Identity",
    collector: "Identity.ps1",
    controlName: `Control ${checkId}`,
    currentValue: "current",
    recommendedValue: "recommended",
    evidence: null,
    frameworkRefs: [],
    remediationMode: null,
    createdAt: NOW,
    updatedAt: NOW,
    ...{ checkId },
  } as RunFinding;
}

async function createRun(
  value: Harness,
  tenantId: string,
  body: unknown = { sections: ["Identity"] },
  headers: Record<string, string> = {},
): Promise<RunRecord> {
  const response = await invoke(value.routes, "POST", TENANT_RUNS_PATH, {
    params: { tenantId },
    headers,
    body,
  });
  return response.body as RunRecord;
}

describe("run routes", () => {
  it("creates a run, persists it queued, and enqueues one reference-only job", async () => {
    const value = harness();
    const response = await invoke(value.routes, "POST", TENANT_RUNS_PATH, {
      params: { tenantId: "tenant-a" },
      body: { sections: ["Identity", "mail"], trigger: "manual" },
    });
    expect(response.status).toBe(201);
    const run = response.body as RunRecord;
    expect(run).toMatchObject({
      id: "run-1",
      tenantId: "tenant-a",
      trigger: "manual",
      sections: ["Identity", "mail"],
      status: "queued",
      artifactPath: "runs/tenant-a/run-1",
      startedAt: null,
      finishedAt: null,
    });
    expect(run.provenance).toMatchObject({ jobId: "job-1", requestId: "req-1" });

    const stored = await value.store.getRunById("run-1");
    expect(stored).toMatchObject({ id: "run-1", tenantId: "tenant-a", status: "queued" });

    expect(value.queue.envelopes).toHaveLength(1);
    expect(value.queue.envelopes[0]).toMatchObject({
      schemaVersion: "v1",
      jobId: "job-1",
      jobType: "assessment",
      tenantId: "tenant-a",
      runId: "run-1",
      payload: {
        contextRef: "runs/tenant-a/run-1/context.json",
        outputRef: "runs/tenant-a/run-1",
        credentialRef: "tenants/tenant-a/credential",
        sectionRefs: ["Identity", "mail"],
        artifactRefs: [],
      },
    });
    expect(JSON.stringify(value.queue.envelopes[0])).not.toContain("secret");
  });

  it("replays an Idempotency-Key with the original run and no second job", async () => {
    const value = harness();
    const headers = { "idempotency-key": "key-1" };
    const first = await invoke(value.routes, "POST", TENANT_RUNS_PATH, {
      params: { tenantId: "tenant-a" },
      headers,
      body: { sections: ["Identity"] },
    });
    expect(first.status).toBe(201);

    const replay = await invoke(value.routes, "POST", TENANT_RUNS_PATH, {
      params: { tenantId: "tenant-a" },
      headers,
      body: { sections: ["other"] },
    });
    expect(replay.status).toBe(200);
    expect(replay.body).toEqual(first.body);
    expect(value.queue.envelopes).toHaveLength(1);
    expect(value.store.runs.size).toBe(1);
  });

  it("treats the same key in another tenant and a fresh key as new runs", async () => {
    const value = harness();
    await invoke(value.routes, "POST", TENANT_RUNS_PATH, {
      params: { tenantId: "tenant-a" },
      headers: { "idempotency-key": "key-1" },
      body: {},
    });
    const other = await invoke(value.routes, "POST", TENANT_RUNS_PATH, {
      params: { tenantId: "tenant-b" },
      headers: { "idempotency-key": "key-1" },
      body: {},
    });
    expect(other.status).toBe(201);
    expect((other.body as RunRecord).tenantId).toBe("tenant-b");
    const fresh = await invoke(value.routes, "POST", TENANT_RUNS_PATH, {
      params: { tenantId: "tenant-a" },
      headers: { "idempotency-key": "key-2" },
      body: {},
    });
    expect(fresh.status).toBe(201);
    expect(value.queue.envelopes).toHaveLength(3);
  });

  it("rejects invalid create input and keys with structured errors", async () => {
    const value = harness();
    const post = (body: unknown, headers: Record<string, string> = {}) =>
      invoke(value.routes, "POST", TENANT_RUNS_PATH, {
        params: { tenantId: "tenant-a" },
        headers,
        body,
      });
    await expect(post({ trigger: "nightly" })).rejects.toMatchObject({ status: 400 });
    await expect(post({ sections: [""] })).rejects.toMatchObject({ status: 400 });
    await expect(post({ tenants: ["a"] })).rejects.toMatchObject({ status: 400 });
    await expect(post({}, { "idempotency-key": "k".repeat(257) })).rejects.toMatchObject({
      status: 400,
    });
    expect(value.queue.envelopes).toHaveLength(0);
  });

  it("persists runs over two tenants and serves detail plus paginated results", async () => {
    const value = harness();
    const first = await createRun(value, "tenant-a");
    const second = await createRun(value, "tenant-b", { sections: ["mail"] });
    value.store.sections.push(section(first.id, "tenant-a", "Identity"));
    value.store.findings.push(
      finding(first.id, "tenant-a", "CA-001"),
      finding(first.id, "tenant-a", "CA-002"),
      finding(first.id, "tenant-a", "CA-003"),
      finding(second.id, "tenant-b", "CA-001"),
    );

    const detail = await invoke(value.routes, "GET", RUN_PATH, {
      params: { runId: first.id },
    });
    expect(detail.status).toBe(200);
    expect(detail.body).toMatchObject({ id: first.id, tenantId: "tenant-a" });
    expect((detail.body as { sections: RunSectionRecord[] }).sections).toHaveLength(1);

    const pageOne = (await invoke(value.routes, "GET", RUN_RESULTS_PATH, {
      params: { runId: first.id },
      query: new URLSearchParams({ limit: "2" }),
    })).body as { runId: string; items: RunFinding[]; nextCursor: string | null };
    expect(pageOne.runId).toBe(first.id);
    expect(pageOne.items).toHaveLength(2);
    expect(pageOne.nextCursor).not.toBeNull();

    const pageTwo = (await invoke(value.routes, "GET", RUN_RESULTS_PATH, {
      params: { runId: first.id },
      query: new URLSearchParams({ limit: "2", cursor: pageOne.nextCursor ?? "" }),
    })).body as { items: RunFinding[]; nextCursor: string | null };
    expect(pageTwo.items).toHaveLength(1);
    expect(pageTwo.nextCursor).toBeNull();

    const other = (await invoke(value.routes, "GET", RUN_RESULTS_PATH, {
      params: { runId: second.id },
    })).body as { items: RunFinding[] };
    expect(other.items).toHaveLength(1);

    const served = [...pageOne.items, ...pageTwo.items].map(
      (item) => (item as unknown as Record<string, unknown>)["checkId"],
    );
    expect(served).toEqual(["CA-001", "CA-002", "CA-003"]);
  });

  it("refuses tenants outside the caller scope without leaking rows", async () => {
    const value = harness({ resolveCaller: () => scopedCaller(["tenant-a"]) });
    const run = await createRun(value, "tenant-a");
    value.store.findings.push(finding(run.id, "tenant-a", "CA-001"));
    await value.store.createRun({
      id: "run-hidden",
      tenantId: "tenant-b",
      trigger: "manual",
      sections: [],
      startedAt: null,
      finishedAt: null,
      status: "running",
      artifactPath: null,
      summaryCounts: null,
      provenance: { jobId: "job-hidden" },
    });

    await expect(
      invoke(value.routes, "GET", RUN_PATH, { params: { runId: "run-hidden" } }),
    ).rejects.toMatchObject({ code: "auth.forbidden", status: 403 });
    await expect(
      invoke(value.routes, "GET", RUN_RESULTS_PATH, { params: { runId: "run-hidden" } }),
    ).rejects.toMatchObject({ code: "auth.forbidden", status: 403 });
    await expect(
      invoke(value.routes, "POST", RUN_CANCEL_PATH, { params: { runId: "run-hidden" } }),
    ).rejects.toMatchObject({ code: "auth.forbidden", status: 403 });
    await expect(
      invoke(value.routes, "POST", TENANT_RUNS_PATH, {
        params: { tenantId: "tenant-b" },
        body: {},
      }),
    ).rejects.toMatchObject({ code: "auth.forbidden", status: 403 });
    expect(value.queue.envelopes).toHaveLength(1);
  });

  it("requires authentication for every endpoint", async () => {
    const value = harness({ resolveCaller: () => undefined });
    await expect(
      invoke(value.routes, "POST", TENANT_RUNS_PATH, {
        params: { tenantId: "tenant-a" },
        body: {},
      }),
    ).rejects.toMatchObject({ status: 401 });
    await expect(
      invoke(value.routes, "GET", RUN_PATH, { params: { runId: "run-1" } }),
    ).rejects.toMatchObject({ status: 401 });
    await expect(
      invoke(value.routes, "GET", RUN_RESULTS_PATH, { params: { runId: "run-1" } }),
    ).rejects.toMatchObject({ status: 401 });
    await expect(
      invoke(value.routes, "GET", RUN_ARTIFACT_PATH, {
        params: { runId: "run-1", name: "report.html" },
      }),
    ).rejects.toMatchObject({ status: 401 });
    await expect(
      invoke(value.routes, "POST", RUN_CANCEL_PATH, { params: { runId: "run-1" } }),
    ).rejects.toMatchObject({ status: 401 });
  });

  it("returns a structured 404 for an unknown run", async () => {
    const value = harness();
    await expect(
      invoke(value.routes, "GET", RUN_PATH, { params: { runId: "missing" } }),
    ).rejects.toMatchObject({ code: "run.not_found", status: 404 });
    await expect(
      invoke(value.routes, "GET", RUN_RESULTS_PATH, { params: { runId: "missing" } }),
    ).rejects.toMatchObject({ code: "run.not_found", status: 404 });
    await expect(
      invoke(value.routes, "POST", RUN_CANCEL_PATH, { params: { runId: "missing" } }),
    ).rejects.toMatchObject({ code: "run.not_found", status: 404 });
  });

  it("serves artifacts from the recorded reference with content types", async () => {
    const value = harness();
    const run = await createRun(value, "tenant-a");
    value.artifacts.files.set("/data/runs/tenant-a/run-1/report.html", {
      bytes: new TextEncoder().encode("<html></html>"),
      contentType: "text/html; charset=utf-8",
    });
    value.artifacts.files.set("/data/runs/tenant-a/run-1/export.json", {
      bytes: new TextEncoder().encode("{}"),
      contentType: "application/json; charset=utf-8",
    });

    const html = await invoke(value.routes, "GET", RUN_ARTIFACT_PATH, {
      params: { runId: run.id, name: "report.html" },
    });
    expect(html.status).toBe(200);
    expect(html.contentType).toBe("text/html; charset=utf-8");
    expect(String(html.raw)).toContain("<html>");

    const json = await invoke(value.routes, "GET", RUN_ARTIFACT_PATH, {
      params: { runId: run.id, name: "export.json" },
    });
    expect(json.contentType).toBe("application/json; charset=utf-8");
  });

  it("maps artifact misses to 404 and unsafe names to 400", async () => {
    const value = harness();
    const run = await createRun(value, "tenant-a");
    await expect(
      invoke(value.routes, "GET", RUN_ARTIFACT_PATH, {
        params: { runId: run.id, name: "missing.html" },
      }),
    ).rejects.toMatchObject({ code: "run.artifact_not_found", status: 404 });
    await expect(
      invoke(value.routes, "GET", RUN_ARTIFACT_PATH, {
        params: { runId: run.id, name: "../runs.json" },
      }),
    ).rejects.toMatchObject({ status: 400 });
    await expect(
      invoke(value.routes, "GET", RUN_ARTIFACT_PATH, {
        params: { runId: run.id, name: "notes.txt" },
      }),
    ).rejects.toMatchObject({ status: 400 });

    await value.store.createRun({
      id: "run-bare",
      tenantId: "tenant-a",
      trigger: "manual",
      sections: [],
      startedAt: null,
      finishedAt: null,
      status: "succeeded",
      artifactPath: null,
      summaryCounts: null,
      provenance: null,
    });
    await expect(
      invoke(value.routes, "GET", RUN_ARTIFACT_PATH, {
        params: { runId: "run-bare", name: "report.html" },
      }),
    ).rejects.toMatchObject({ code: "run.artifact_not_found", status: 404 });
  });

  it("cancels a queued run through the queue and records the terminal state", async () => {
    const value = harness();
    const run = await createRun(value, "tenant-a");
    const response = await invoke(value.routes, "POST", RUN_CANCEL_PATH, {
      params: { runId: run.id },
    });
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ id: run.id, status: "cancelled", finishedAt: NOW });
    expect(value.queue.cancelledJobs).toEqual(["job-1"]);
    expect((await value.store.getRunById(run.id))?.status).toBe("cancelled");
  });

  it("refuses to cancel terminal runs or inactive jobs", async () => {
    const value = harness();
    const run = await createRun(value, "tenant-a");
    await value.store.updateRun("tenant-a", run.id, { status: "succeeded", finishedAt: NOW });
    await expect(
      invoke(value.routes, "POST", RUN_CANCEL_PATH, { params: { runId: run.id } }),
    ).rejects.toMatchObject({ code: "run.not_cancellable", status: 409 });

    const active = await createRun(value, "tenant-a");
    value.queue.cancelResult = false;
    await expect(
      invoke(value.routes, "POST", RUN_CANCEL_PATH, { params: { runId: active.id } }),
    ).rejects.toMatchObject({ code: "run.not_cancellable", status: 409 });
    expect((await value.store.getRunById(active.id))?.status).toBe("queued");
  });

  it("consults the injected authorizer and falls back to the run permissions", async () => {
    const value = harness();
    await createRun(value, "tenant-a");
    await invoke(value.routes, "GET", RUN_PATH, { params: { runId: "run-1" } });
    expect(value.seenPermissions).toContain(RUN_PERMISSIONS.read);
    expect(value.seenPermissions).toContain(RUN_PERMISSIONS.create);

    const denied = harness({
      authorize: () => {
        throw new AppError("auth.denied", "forbidden", 403);
      },
    });
    await expect(
      invoke(denied.routes, "POST", TENANT_RUNS_PATH, {
        params: { tenantId: "tenant-a" },
        body: {},
      }),
    ).rejects.toMatchObject({ status: 403 });

    const rbac = harness({ authorize: undefined, resolveCaller: () => scopedCaller(["tenant-a"]) });
    await expect(
      invoke(rbac.routes, "POST", TENANT_RUNS_PATH, {
        params: { tenantId: "tenant-a" },
        body: {},
      }),
    ).rejects.toMatchObject({ code: "auth.forbidden", status: 403 });
    await rbac.store.createRun({
      id: "run-9",
      tenantId: "tenant-a",
      trigger: "manual",
      sections: [],
      startedAt: null,
      finishedAt: null,
      status: "queued",
      artifactPath: "runs/tenant-a/run-9",
      summaryCounts: null,
      provenance: { jobId: "job-9" },
    });
    const readable = await invoke(rbac.routes, "GET", RUN_PATH, {
      params: { runId: "run-9" },
    });
    expect(readable.status).toBe(200);
  });

  it("publishes an OpenAPI fragment matching the five endpoints exactly", () => {
    const routes = harness().routes;
    const toOpenApiPath = (path: string): string =>
      path.replace(/:([A-Za-z0-9_]+)/g, "{$1}");
    const byRoute = new Map(
      routes.map((route) => [`${route.method} ${toOpenApiPath(route.path)}`, route]),
    );
    const documented = new Map<string, string>();
    for (const [path, item] of Object.entries(RUNS_OPENAPI.paths)) {
      for (const [method, operation] of Object.entries(
        item as Record<string, { operationId: string }>,
      )) {
        documented.set(`${method.toUpperCase()} /v1${path}`, operation.operationId);
      }
    }
    expect([...documented.keys()].sort()).toEqual([...byRoute.keys()].sort());
    expect(RUNS_OPENAPI.schemas.RunFinding.properties).toHaveProperty("checkId");
    expect(RUNS_OPENAPI.schemas.RunCreate.additionalProperties).toBe(false);
  });
});
