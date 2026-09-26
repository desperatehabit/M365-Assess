import { describe, expect, it } from "vitest";
import { AppError } from "../errors.js";
import { ALL_TENANTS, tenantScope } from "../rbac/scope.js";
import type { Caller } from "../rbac/authorize.js";
import type { RequestContext } from "../server.js";
import { CLI_DEFAULT_SECTIONS } from "../domain/run-plan.js";
import { createMemoryIdempotencyStore, type JobEnvelope } from "../domain/runs/run-lifecycle.js";
import {
  RUNS_CREATE_OPENAPI,
  RUNS_CREATE_PATH,
  RUNS_CREATE_PERMISSION,
  createRunsCreateRoute,
  type RunCreateResponseBody,
  type RunCreateStore,
  type RunQueue,
  type RunRecord,
} from "./runs-create.js";

const TENANT_1 = "11111111-1111-1111-1111-111111111111";
const TENANT_2 = "22222222-2222-2222-2222-222222222222";
const TENANT_3 = "33333333-3333-3333-3333-333333333333";
const GROUP_1 = "group-uuid-1";

class MemoryStore implements RunCreateStore {
  readonly runs = new Map<string, RunRecord>();

  async createRunWithChildren(
    parent: RunRecord,
    children: readonly RunRecord[],
  ): Promise<{ parent: RunRecord; children: readonly RunRecord[] }> {
    this.runs.set(parent.id, parent);
    for (const child of children) {
      this.runs.set(child.id, child);
    }
    return { parent, children };
  }

  async getRunById(runId: string): Promise<RunRecord | undefined> {
    return this.runs.get(runId);
  }
}

class FakeQueue implements RunQueue {
  readonly enqueued: JobEnvelope[] = [];

  async enqueue(envelope: JobEnvelope): Promise<string> {
    this.enqueued.push(envelope);
    return envelope.jobId;
  }
}

class FakeGroupResolver {
  readonly groups = new Map<string, string[]>();

  async resolveGroupMembers(groupId: string): Promise<readonly string[]> {
    return this.groups.get(groupId) ?? [];
  }
}

function adminCaller(): Caller {
  return { roles: ["admin"], tenantScope: ALL_TENANTS };
}

function scopedCaller(tenantIds: string[]): Caller {
  return { roles: ["operator"], tenantScope: tenantScope(tenantIds) };
}

function makeContext(
  bodyObj: Record<string, unknown> = {},
  headers: Record<string, string> = {},
): { ctx: RequestContext; rawBody: string } {
  const rawBody = JSON.stringify(bodyObj);
  return {
    rawBody,
    ctx: {
      correlationId: "corr-123",
      method: "POST",
      path: RUNS_CREATE_PATH,
      query: new URLSearchParams(),
      headers,
      params: {},
    },
  };
}

describe("POST /v1/runs (T-0043)", () => {
  it("creates a single-tenant run producing a parent run, child run, and 1 enqueued job with CLI default sections", async () => {
    const store = new MemoryStore();
    const queue = new FakeQueue();

    let seq = 0;
    const idGenerator = () => {
      seq += 1;
      return { runId: `run-${seq}`, jobId: `job-${seq}`, requestId: `req-${seq}` };
    };

    const route = createRunsCreateRoute({
      store,
      queue,
      resolveCaller: () => adminCaller(),
      idGenerator,
      readBody: async () => JSON.stringify({ tenantId: TENANT_1, options: { quickScan: true } }),
    });

    const { ctx } = makeContext();
    const response = await route.handler(ctx);
    expect(response.status).toBe(201);

    const body = response.body as RunCreateResponseBody;
    expect(body.run.id).toBe("run-1");
    expect(body.run.parentRunId).toBeNull();
    expect(body.run.sections).toEqual(CLI_DEFAULT_SECTIONS);
    expect(body.run.options).toEqual({ quickScan: true });

    expect(body.children).toHaveLength(1);
    expect(body.children[0].id).toBe("run-2");
    expect(body.children[0].parentRunId).toBe("run-1");
    expect(body.children[0].tenantId).toBe(TENANT_1);
    expect(body.children[0].options).toEqual({ quickScan: true });

    expect(body.enqueuedJobs).toEqual(["job-2"]);
    expect(queue.enqueued).toHaveLength(1);
    expect(queue.enqueued[0].tenantId).toBe(TENANT_1);
    expect(queue.enqueued[0].runId).toBe("run-2");
  });

  it("creates a multi-tenant/group run producing a parent run, per-tenant child runs, and one job per tenant", async () => {
    const store = new MemoryStore();
    const queue = new FakeQueue();
    const groupResolver = new FakeGroupResolver();
    groupResolver.groups.set(GROUP_1, [TENANT_2, TENANT_3]);

    let seq = 0;
    const idGenerator = () => {
      seq += 1;
      return { runId: `run-${seq}`, jobId: `job-${seq}`, requestId: `req-${seq}` };
    };

    const route = createRunsCreateRoute({
      store,
      queue,
      groupResolver,
      resolveCaller: () => adminCaller(),
      idGenerator,
      readBody: async () =>
        JSON.stringify({
          tenants: [TENANT_1],
          groups: [GROUP_1],
          sections: ["Identity", "Email"],
          options: { redact: true, skipPurview: true },
        }),
    });

    const { ctx } = makeContext();
    const response = await route.handler(ctx);
    expect(response.status).toBe(201);

    const body = response.body as RunCreateResponseBody;
    expect(body.run.id).toBe("run-1");
    expect(body.run.parentRunId).toBeNull();
    expect(body.run.sections).toEqual(["Identity", "Email"]);
    expect(body.run.options).toEqual({ redact: true, skipPurview: true });

    expect(body.children).toHaveLength(3);
    const childTenants = body.children.map((c) => c.tenantId).sort();
    expect(childTenants).toEqual([TENANT_1, TENANT_2, TENANT_3]);
    for (const child of body.children) {
      expect(child.parentRunId).toBe("run-1");
      expect(child.sections).toEqual(["Identity", "Email"]);
      expect(child.options).toEqual({ redact: true, skipPurview: true });
    }

    expect(body.enqueuedJobs).toHaveLength(3);
    expect(queue.enqueued).toHaveLength(3);
  });

  it("rejects run creation with 403 when a requested tenant is outside the caller scope", async () => {
    const store = new MemoryStore();
    const queue = new FakeQueue();

    const route = createRunsCreateRoute({
      store,
      queue,
      resolveCaller: () => scopedCaller([TENANT_1]),
      readBody: async () => JSON.stringify({ tenants: [TENANT_1, TENANT_2] }),
    });

    const { ctx } = makeContext();
    await expect(route.handler(ctx)).rejects.toMatchObject({
      status: 403,
      code: "auth.forbidden",
    });

    // Queue must remain untouched
    expect(queue.enqueued).toHaveLength(0);
  });

  it("rejects run creation with 403 when a group member is outside caller scope", async () => {
    const store = new MemoryStore();
    const queue = new FakeQueue();
    const groupResolver = new FakeGroupResolver();
    groupResolver.groups.set(GROUP_1, [TENANT_1, TENANT_2]);

    const route = createRunsCreateRoute({
      store,
      queue,
      groupResolver,
      resolveCaller: () => scopedCaller([TENANT_1]),
      readBody: async () => JSON.stringify({ groups: [GROUP_1] }),
    });

    const { ctx } = makeContext();
    await expect(route.handler(ctx)).rejects.toMatchObject({
      status: 403,
      code: "auth.forbidden",
    });
  });

  it("supports Idempotency-Key header to prevent duplicate runs and job enqueues", async () => {
    const store = new MemoryStore();
    const queue = new FakeQueue();
    const idempotency = createMemoryIdempotencyStore();

    let seq = 0;
    const idGenerator = () => {
      seq += 1;
      return { runId: `run-${seq}`, jobId: `job-${seq}`, requestId: `req-${seq}` };
    };

    const route = createRunsCreateRoute({
      store,
      queue,
      idempotency,
      resolveCaller: () => adminCaller(),
      idGenerator,
      readBody: async () => JSON.stringify({ tenantId: TENANT_1 }),
    });

    const { ctx } = makeContext({}, { "idempotency-key": "test-key-abc" });

    // First request: 201 Created
    const res1 = await route.handler(ctx);
    expect(res1.status).toBe(201);
    expect((res1.body as RunCreateResponseBody).run.id).toBe("run-1");
    expect(queue.enqueued).toHaveLength(1);

    // Second request with same idempotency-key: 200 Replay, no new jobs enqueued
    const res2 = await route.handler(ctx);
    expect(res2.status).toBe(200);
    expect((res2.body as RunCreateResponseBody).run.id).toBe("run-1");
    expect(queue.enqueued).toHaveLength(1);
  });

  it("matches the OpenAPI specification", () => {
    const pathItem = RUNS_CREATE_OPENAPI["/runs"];
    expect(pathItem).toBeDefined();
    expect(pathItem.post).toBeDefined();
    expect(pathItem.post.operationId).toBe("createRun");
    expect(pathItem.post.permission).toBe(RUNS_CREATE_PERMISSION);

    expect(pathItem.post.parameters).toHaveLength(1);
    expect(pathItem.post.parameters[0].name).toBe("Idempotency-Key");

    expect(pathItem.post.responses["201"]).toBeDefined();
    expect(pathItem.post.responses["200"]).toBeDefined();
    expect(pathItem.post.responses["400"]).toBeDefined();
    expect(pathItem.post.responses["401"]).toBeDefined();
    expect(pathItem.post.responses["403"]).toBeDefined();
  });
});
