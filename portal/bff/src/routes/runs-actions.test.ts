import { describe, expect, it } from "vitest";
import type { RequestContext } from "../server.js";
import type { Caller } from "../rbac/authorize.js";
import { ALL_TENANTS, tenantScope } from "../rbac/scope.js";
import {
  createRunCancelRoute,
  createRunRetryRoute,
  createRunsActionsRoutes,
  RUNS_CANCEL_OPENAPI,
  RUNS_RETRY_OPENAPI,
  RUNS_ACTIONS_OPENAPI,
  type RunsActionsOptions,
  type RunsActionsStore,
  type RunsActionsQueue,
} from "./runs-actions.js";
import type {
  RunRecord,
  RunSectionRecord,
} from "../domain/run-retry.js";
import type { JobEnvelope } from "@m365-assess/contracts";
import { ProgressEventHub } from "../sse/hub.js";

const NOW = "2026-09-26T12:00:00.000Z";

function makeCaller(overrides: Partial<Caller> = {}): Caller {
  return {
    roles: ["admin"],
    tenantScope: ALL_TENANTS,
    ...overrides,
  };
}

function makeContext(params: Record<string, string> = {}, body?: unknown): RequestContext {
  return {
    correlationId: "corr-test-1",
    params,
    query: new URLSearchParams(),
    headers: { "content-type": "application/json" },
    body,
  };
}

class MemoryStore implements RunsActionsStore {
  readonly runs = new Map<string, RunRecord>();
  readonly sections = new Map<string, RunSectionRecord[]>();

  async getRunById(runId: string): Promise<RunRecord | undefined> {
    return this.runs.get(runId);
  }

  async updateRun(
    _tenantId: string,
    runId: string,
    update: {
      status?: any;
      startedAt?: string | null;
      finishedAt?: string | null;
      updatedAt?: string;
    },
  ): Promise<RunRecord | undefined> {
    const existing = this.runs.get(runId);
    if (!existing) return undefined;
    const updated: RunRecord = {
      ...existing,
      ...update,
    };
    this.runs.set(runId, updated);
    return updated;
  }

  async listChildRuns(parentRunId: string): Promise<readonly RunRecord[]> {
    return [...this.runs.values()].filter((r) => r.parentRunId === parentRunId);
  }

  async listRunSections(_tenantId: string, runId: string): Promise<readonly RunSectionRecord[]> {
    return this.sections.get(runId) ?? [];
  }

  async createRunWithChildren(
    parent: RunRecord,
    children: readonly RunRecord[],
  ): Promise<{ parent: RunRecord; children: readonly RunRecord[] }> {
    this.runs.set(parent.id, parent);
    for (const c of children) {
      this.runs.set(c.id, c);
    }
    return { parent, children };
  }

  async createRun(run: RunRecord): Promise<RunRecord> {
    this.runs.set(run.id, run);
    return run;
  }
}

class FakeQueue implements RunsActionsQueue {
  readonly cancelledJobIds: string[] = [];
  readonly enqueuedEnvelopes: JobEnvelope[] = [];
  cancelResult = true;

  async cancel(jobId: string): Promise<boolean> {
    this.cancelledJobIds.push(jobId);
    return this.cancelResult;
  }

  async enqueue(envelope: JobEnvelope): Promise<string> {
    this.enqueuedEnvelopes.push(envelope);
    return envelope.jobId;
  }
}

describe("runs-actions routes", () => {
  describe("POST /v1/runs/:runId/cancel", () => {
    it("rejects unauthenticated requests with 401", async () => {
      const store = new MemoryStore();
      const queue = new FakeQueue();
      const route = createRunCancelRoute({
        store,
        queue,
        resolveCaller: () => undefined,
      });

      await expect(route.handler(makeContext({ runId: "r-1" }))).rejects.toMatchObject({
        code: "request.unauthenticated",
        status: 401,
      });
    });

    it("rejects caller without runs.cancel permission with 403", async () => {
      const store = new MemoryStore();
      const queue = new FakeQueue();
      const route = createRunCancelRoute({
        store,
        queue,
        resolveCaller: () => makeCaller({ roles: ["operator"] }), // operator only has runs.read
      });

      await expect(route.handler(makeContext({ runId: "r-1" }))).rejects.toMatchObject({
        code: "auth.forbidden",
        status: 403,
      });
    });

    it("rejects caller if tenant is outside caller scope with 403", async () => {
      const store = new MemoryStore();
      const queue = new FakeQueue();
      const run: RunRecord = {
        id: "r-1",
        tenantId: "tenant-forbidden",
        parentRunId: null,
        trigger: "manual",
        sections: ["Tenant"],
        options: null,
        startedAt: NOW,
        finishedAt: null,
        status: "running",
        artifactPath: "runs/tenant-forbidden/r-1",
        summaryCounts: null,
        provenance: { jobId: "job-1" },
        createdAt: NOW,
        updatedAt: NOW,
      };
      await store.createRun(run);

      const route = createRunCancelRoute({
        store,
        queue,
        resolveCaller: () =>
          makeCaller({ tenantScope: tenantScope(["tenant-allowed"]) }),
      });

      await expect(route.handler(makeContext({ runId: "r-1" }))).rejects.toMatchObject({
        code: "auth.forbidden",
        status: 403,
      });
    });

    it("returns 404 if run is not found", async () => {
      const store = new MemoryStore();
      const queue = new FakeQueue();
      const route = createRunCancelRoute({
        store,
        queue,
        resolveCaller: () => makeCaller(),
      });

      await expect(route.handler(makeContext({ runId: "nonexistent" }))).rejects.toMatchObject({
        code: "run.not_found",
        status: 404,
      });
    });

    it("rejects cancelling an already terminal run with 409", async () => {
      const store = new MemoryStore();
      const queue = new FakeQueue();
      const run: RunRecord = {
        id: "r-terminal",
        tenantId: "tenant-1",
        parentRunId: null,
        trigger: "manual",
        sections: ["Tenant"],
        options: null,
        startedAt: NOW,
        finishedAt: NOW,
        status: "succeeded",
        artifactPath: null,
        summaryCounts: null,
        provenance: { jobId: "job-term" },
        createdAt: NOW,
        updatedAt: NOW,
      };
      await store.createRun(run);

      const route = createRunCancelRoute({
        store,
        queue,
        resolveCaller: () => makeCaller(),
      });

      await expect(route.handler(makeContext({ runId: "r-terminal" }))).rejects.toMatchObject({
        code: "run.not_cancellable",
        status: 409,
      });
    });

    it("cancels a running single run, invokes queue.cancel, and publishes to event hub", async () => {
      const store = new MemoryStore();
      const queue = new FakeQueue();
      const hub = new ProgressEventHub();
      const run: RunRecord = {
        id: "r-single",
        tenantId: "tenant-1",
        parentRunId: null,
        trigger: "manual",
        sections: ["Tenant"],
        options: null,
        startedAt: NOW,
        finishedAt: null,
        status: "running",
        artifactPath: "runs/tenant-1/r-single",
        summaryCounts: null,
        provenance: { jobId: "job-single-1" },
        createdAt: NOW,
        updatedAt: NOW,
      };
      await store.createRun(run);

      const route = createRunCancelRoute({
        store,
        queue,
        eventHub: hub,
        resolveCaller: () => makeCaller(),
        now: () => NOW,
      });

      const response = await route.handler(makeContext({ runId: "r-single" }));
      expect(response.status).toBe(200);

      const body = response.body as RunRecord;
      expect(body.id).toBe("r-single");
      expect(body.status).toBe("cancelled");
      expect(body.finishedAt).toBe(NOW);
      // Partial artifacts are retained
      expect(body.artifactPath).toBe("runs/tenant-1/r-single");

      // Verify queue cancel was called
      expect(queue.cancelledJobIds).toEqual(["job-single-1"]);

      // Verify DB was updated
      const inStore = await store.getRunById("r-single");
      expect(inStore?.status).toBe("cancelled");

      // Verify event was emitted to hub
      const events = hub.getEvents("r-single");
      expect(events).toHaveLength(1);
      expect(events[0]?.state).toBe("cancelled");
    });

    it("cancels a multi-tenant parent run and all its active child runs", async () => {
      const store = new MemoryStore();
      const queue = new FakeQueue();
      const hub = new ProgressEventHub();

      const parent: RunRecord = {
        id: "p-1",
        tenantId: "all",
        parentRunId: null,
        trigger: "manual",
        sections: ["Tenant"],
        options: null,
        startedAt: NOW,
        finishedAt: null,
        status: "running",
        artifactPath: null,
        summaryCounts: null,
        provenance: {},
        createdAt: NOW,
        updatedAt: NOW,
      };

      const child1: RunRecord = {
        id: "c-1",
        tenantId: "t-1",
        parentRunId: "p-1",
        trigger: "manual",
        sections: ["Tenant"],
        options: null,
        startedAt: NOW,
        finishedAt: null,
        status: "running",
        artifactPath: "runs/t-1/c-1",
        summaryCounts: null,
        provenance: { jobId: "job-c1" },
        createdAt: NOW,
        updatedAt: NOW,
      };

      const child2: RunRecord = {
        id: "c-2",
        tenantId: "t-2",
        parentRunId: "p-1",
        trigger: "manual",
        sections: ["Tenant"],
        options: null,
        startedAt: NOW,
        finishedAt: NOW,
        status: "succeeded", // already finished
        artifactPath: "runs/t-2/c-2",
        summaryCounts: null,
        provenance: { jobId: "job-c2" },
        createdAt: NOW,
        updatedAt: NOW,
      };

      await store.createRunWithChildren(parent, [child1, child2]);

      const route = createRunCancelRoute({
        store,
        queue,
        eventHub: hub,
        resolveCaller: () => makeCaller(),
        now: () => NOW,
      });

      const response = await route.handler(makeContext({ runId: "p-1" }));
      expect(response.status).toBe(200);

      const body = response.body as any;
      expect(body.id).toBe("p-1");
      expect(body.status).toBe("cancelled");
      expect(body.children).toHaveLength(1);
      expect(body.children[0].id).toBe("c-1");
      expect(body.children[0].status).toBe("cancelled");

      // Only child1 was active and cancelled
      expect(queue.cancelledJobIds).toEqual(["job-c1"]);

      const child2InStore = await store.getRunById("c-2");
      expect(child2InStore?.status).toBe("succeeded"); // untouched
    });
  });

  describe("POST /v1/runs/:runId/retry", () => {
    it("rejects unauthenticated requests with 401", async () => {
      const store = new MemoryStore();
      const queue = new FakeQueue();
      const route = createRunRetryRoute({
        store,
        queue,
        resolveCaller: () => undefined,
      });

      await expect(route.handler(makeContext({ runId: "r-1" }))).rejects.toMatchObject({
        code: "request.unauthenticated",
        status: 401,
      });
    });

    it("rejects unauthorized caller without retry permission with 403", async () => {
      const store = new MemoryStore();
      const queue = new FakeQueue();
      const route = createRunRetryRoute({
        store,
        queue,
        resolveCaller: () => makeCaller({ roles: ["operator"] }),
      });

      await expect(route.handler(makeContext({ runId: "r-1" }))).rejects.toMatchObject({
        code: "auth.forbidden",
        status: 403,
      });
    });

    it("rejects retrying an active run with 409", async () => {
      const store = new MemoryStore();
      const queue = new FakeQueue();
      const run: RunRecord = {
        id: "r-running",
        tenantId: "t-1",
        parentRunId: null,
        trigger: "manual",
        sections: ["Tenant"],
        options: null,
        startedAt: NOW,
        finishedAt: null,
        status: "running",
        artifactPath: null,
        summaryCounts: null,
        provenance: {},
        createdAt: NOW,
        updatedAt: NOW,
      };
      await store.createRun(run);

      const route = createRunRetryRoute({
        store,
        queue,
        resolveCaller: () => makeCaller(),
      });

      await expect(route.handler(makeContext({ runId: "r-running" }))).rejects.toMatchObject({
        code: "run.not_retryable",
        status: 409,
      });
    });

    it("rejects retrying a run with no failures with 400", async () => {
      const store = new MemoryStore();
      const queue = new FakeQueue();
      const run: RunRecord = {
        id: "r-success",
        tenantId: "t-1",
        parentRunId: null,
        trigger: "manual",
        sections: ["Tenant"],
        options: null,
        startedAt: NOW,
        finishedAt: NOW,
        status: "succeeded",
        artifactPath: null,
        summaryCounts: null,
        provenance: {},
        createdAt: NOW,
        updatedAt: NOW,
      };
      await store.createRun(run);
      store.sections.set("r-success", [
        {
          id: "s-1",
          runId: "r-success",
          tenantId: "t-1",
          section: "Tenant",
          status: "succeeded",
          createdAt: NOW,
          updatedAt: NOW,
        },
      ]);

      const route = createRunRetryRoute({
        store,
        queue,
        resolveCaller: () => makeCaller(),
      });

      await expect(route.handler(makeContext({ runId: "r-success" }))).rejects.toMatchObject({
        code: "run.not_retryable",
        status: 400,
      });
    });

    it("retries a single failed run, links via parentRunId, and enqueues failed section", async () => {
      const store = new MemoryStore();
      const queue = new FakeQueue();
      const run: RunRecord = {
        id: "orig-run",
        tenantId: "tenant-a",
        parentRunId: null,
        trigger: "manual",
        sections: ["Tenant", "Identity"],
        options: null,
        startedAt: NOW,
        finishedAt: NOW,
        status: "failed",
        artifactPath: null,
        summaryCounts: null,
        provenance: {},
        createdAt: NOW,
        updatedAt: NOW,
      };
      await store.createRun(run);

      store.sections.set("orig-run", [
        {
          id: "s-1",
          runId: "orig-run",
          tenantId: "tenant-a",
          section: "Tenant",
          status: "succeeded",
          createdAt: NOW,
          updatedAt: NOW,
        },
        {
          id: "s-2",
          runId: "orig-run",
          tenantId: "tenant-a",
          section: "Identity",
          status: "failed",
          createdAt: NOW,
          updatedAt: NOW,
        },
      ]);

      let idCount = 0;
      const idGenerator = () => ({
        runId: `retry-run-${++idCount}`,
        jobId: `retry-job-${idCount}`,
        requestId: `req-${idCount}`,
      });

      const route = createRunRetryRoute({
        store,
        queue,
        resolveCaller: () => makeCaller(),
        idGenerator,
        now: () => NOW,
      });

      const response = await route.handler(makeContext({ runId: "orig-run" }));
      expect(response.status).toBe(201);

      const body = response.body as any;
      expect(body.run.id).toBe("retry-run-1");
      expect(body.run.parentRunId).toBe("orig-run"); // Linked via parentRunId!
      expect(body.run.sections).toEqual(["Identity"]); // Only failed section!
      expect(body.children).toEqual([]);
      expect(body.enqueuedJobs).toEqual(["retry-job-1"]);

      expect(queue.enqueuedEnvelopes).toHaveLength(1);
      expect(queue.enqueuedEnvelopes[0]!.payload.sectionRefs).toEqual(["Identity"]);
    });

    it("retries a multi-tenant parent run and re-enqueues only failed tenants/sections", async () => {
      const store = new MemoryStore();
      const queue = new FakeQueue();

      const parent: RunRecord = {
        id: "orig-parent",
        tenantId: "all",
        parentRunId: null,
        trigger: "manual",
        sections: ["Tenant", "Identity"],
        options: { quickScan: true },
        startedAt: NOW,
        finishedAt: NOW,
        status: "partial",
        artifactPath: null,
        summaryCounts: null,
        provenance: {},
        createdAt: NOW,
        updatedAt: NOW,
      };

      const child1: RunRecord = {
        id: "orig-c1",
        tenantId: "t-1",
        parentRunId: "orig-parent",
        trigger: "manual",
        sections: ["Tenant", "Identity"],
        options: null,
        startedAt: NOW,
        finishedAt: NOW,
        status: "succeeded",
        artifactPath: null,
        summaryCounts: null,
        provenance: {},
        createdAt: NOW,
        updatedAt: NOW,
      };

      const child2: RunRecord = {
        id: "orig-c2",
        tenantId: "t-2",
        parentRunId: "orig-parent",
        trigger: "manual",
        sections: ["Tenant", "Identity"],
        options: null,
        startedAt: NOW,
        finishedAt: NOW,
        status: "failed",
        artifactPath: null,
        summaryCounts: null,
        provenance: {},
        createdAt: NOW,
        updatedAt: NOW,
      };

      await store.createRunWithChildren(parent, [child1, child2]);

      store.sections.set("orig-c1", [
        { id: "1", runId: "orig-c1", tenantId: "t-1", section: "Tenant", status: "succeeded", createdAt: NOW, updatedAt: NOW },
        { id: "2", runId: "orig-c1", tenantId: "t-1", section: "Identity", status: "succeeded", createdAt: NOW, updatedAt: NOW },
      ]);
      store.sections.set("orig-c2", [
        { id: "3", runId: "orig-c2", tenantId: "t-2", section: "Tenant", status: "succeeded", createdAt: NOW, updatedAt: NOW },
        { id: "4", runId: "orig-c2", tenantId: "t-2", section: "Identity", status: "failed", createdAt: NOW, updatedAt: NOW },
      ]);

      let idCount = 0;
      const idGenerator = () => ({
        runId: `retry-${++idCount}`,
        jobId: `retry-job-${idCount}`,
        requestId: `req-${idCount}`,
      });

      const route = createRunRetryRoute({
        store,
        queue,
        resolveCaller: () => makeCaller(),
        idGenerator,
        now: () => NOW,
      });

      const response = await route.handler(makeContext({ runId: "orig-parent" }));
      expect(response.status).toBe(201);

      const body = response.body as any;
      expect(body.run.parentRunId).toBe("orig-parent"); // Linked to original parent!
      expect(body.children).toHaveLength(1); // Only t-2 failed!
      expect(body.children[0].tenantId).toBe("t-2");
      expect(body.children[0].sections).toEqual(["Identity"]); // Only failed section!
      expect(body.enqueuedJobs).toHaveLength(1);

      expect(queue.enqueuedEnvelopes).toHaveLength(1);
      expect(queue.enqueuedEnvelopes[0]!.tenantId).toBe("t-2");
      expect(queue.enqueuedEnvelopes[0]!.payload.sectionRefs).toEqual(["Identity"]);
    });
  });

  describe("createRunsActionsRoutes and OpenAPI exports", () => {
    it("returns both routes from createRunsActionsRoutes", () => {
      const store = new MemoryStore();
      const queue = new FakeQueue();
      const routes = createRunsActionsRoutes({
        store,
        queue,
        resolveCaller: () => makeCaller(),
      });
      expect(routes).toHaveLength(2);
      expect(routes.map((r) => r.path)).toEqual([
        "/v1/runs/:runId/cancel",
        "/v1/runs/:runId/retry",
      ]);
    });

    it("exports OpenAPI schemas matching cancel and retry endpoints", () => {
      expect(RUNS_CANCEL_OPENAPI["/v1/runs/{runId}/cancel"]).toBeDefined();
      expect(RUNS_CANCEL_OPENAPI["/v1/runs/{runId}/cancel"].post.operationId).toBe("cancelRun");

      expect(RUNS_RETRY_OPENAPI["/v1/runs/{runId}/retry"]).toBeDefined();
      expect(RUNS_RETRY_OPENAPI["/v1/runs/{runId}/retry"].post.operationId).toBe("retryRun");

      expect(RUNS_ACTIONS_OPENAPI["/v1/runs/{runId}/cancel"]).toBeDefined();
      expect(RUNS_ACTIONS_OPENAPI["/v1/runs/{runId}/retry"]).toBeDefined();
    });
  });
});
