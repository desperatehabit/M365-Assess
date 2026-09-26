import { describe, expect, it } from "vitest";
import { AppError } from "../errors.js";
import { ALL_TENANTS, tenantScope } from "../rbac/scope.js";
import type { Caller } from "../rbac/authorize.js";
import type { RequestContext } from "../server.js";
import { ProgressEventHub } from "../sse/hub.js";
import {
  RUNS_EVENTS_PATH,
  RUNS_EVENTS_PERMISSION,
  createRunsEventsRoute,
  parseSseStream,
  type RunAuditEventInput,
  type RunEventsRecord,
  type RunEventsStore,
  type RunsEventsRequestContext,
} from "./runs-events.js";
import { parseProgressEvent } from "@m365-assess/contracts/events";

const TENANT_1 = "11111111-1111-1111-1111-111111111111";
const TENANT_2 = "22222222-2222-2222-2222-222222222222";
const RUN_ID = "run-1234-abcd";

class FakeRunEventsStore implements RunEventsStore {
  readonly runs = new Map<string, RunEventsRecord>();
  readonly audits: RunAuditEventInput[] = [];

  async getRunById(runId: string): Promise<RunEventsRecord | undefined> {
    return this.runs.get(runId);
  }

  async appendAuditEvent(event: RunAuditEventInput): Promise<unknown> {
    this.audits.push(event);
    return event;
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

function createContext(runId: string, extra: Partial<RunsEventsRequestContext> = {}): RunsEventsRequestContext {
  return {
    correlationId: "corr-1",
    method: "GET",
    path: `/v1/runs/${runId}/events`,
    query: new URLSearchParams(),
    headers: {},
    params: { runId },
    ...extra,
  };
}

describe("runs-events route (GET /v1/runs/:runId/events)", () => {
  it("rejects unauthenticated requests with 401", async () => {
    const store = new FakeRunEventsStore();
    const hub = new ProgressEventHub();
    const route = createRunsEventsRoute({
      store,
      hub,
      resolveCaller: () => undefined,
    });

    await expect(route.handler(createContext(RUN_ID))).rejects.toMatchObject({
      code: "request.unauthenticated",
      status: 401,
    });
  });

  it("refuses callers lacking runs.read permission with 403", async () => {
    const store = new FakeRunEventsStore();
    const hub = new ProgressEventHub();
    const route = createRunsEventsRoute({
      store,
      hub,
      resolveCaller: () => unprivilegedCaller(),
    });

    await expect(route.handler(createContext(RUN_ID))).rejects.toMatchObject({
      code: "auth.forbidden",
      status: 403,
    });
  });

  it("returns 404 when run does not exist", async () => {
    const store = new FakeRunEventsStore();
    const hub = new ProgressEventHub();
    const route = createRunsEventsRoute({
      store,
      hub,
      resolveCaller: () => adminCaller(),
    });

    await expect(route.handler(createContext("missing-run"))).rejects.toMatchObject({
      code: "run.not_found",
      status: 404,
    });
  });

  it("refuses subscription to a run outside the caller's tenant scope with 403", async () => {
    const store = new FakeRunEventsStore();
    store.runs.set(RUN_ID, {
      id: RUN_ID,
      tenantId: TENANT_2,
      status: "running",
    });

    const hub = new ProgressEventHub();
    const route = createRunsEventsRoute({
      store,
      hub,
      resolveCaller: () => scopedCaller([TENANT_1]), // Caller only has access to TENANT_1
    });

    await expect(route.handler(createContext(RUN_ID))).rejects.toMatchObject({
      code: "auth.forbidden",
      status: 403,
    });
    // Audits must not be written if refused
    expect(store.audits).toHaveLength(0);
  });

  it("records an audit event upon successful subscription", async () => {
    const store = new FakeRunEventsStore();
    store.runs.set(RUN_ID, {
      id: RUN_ID,
      tenantId: TENANT_1,
      status: "succeeded",
    });

    const hub = new ProgressEventHub();
    await hub.publish({
      runId: RUN_ID,
      tenantId: TENANT_1,
      jobId: "job-1",
      state: "succeeded",
    });

    const route = createRunsEventsRoute({
      store,
      hub,
      resolveCaller: () => scopedCaller([TENANT_1]),
    });

    const response = await route.handler(createContext(RUN_ID));
    expect(response.status).toBe(200);

    expect(store.audits).toHaveLength(1);
    expect(store.audits[0]).toMatchObject({
      action: "runs.events.subscribe",
      tenantId: TENANT_1,
      targetType: "run",
      targetId: RUN_ID,
      result: "success",
    });
  });

  it("streams ordered, versioned events until terminal and closes stream (driving a stubbed job)", async () => {
    const store = new FakeRunEventsStore();
    store.runs.set(RUN_ID, {
      id: RUN_ID,
      tenantId: TENANT_1,
      status: "queued",
    });

    const hub = new ProgressEventHub();
    const route = createRunsEventsRoute({
      store,
      hub,
      resolveCaller: () => adminCaller(),
    });

    // Start background stubbed job driving progress events
    setTimeout(async () => {
      await hub.publish({
        runId: RUN_ID,
        tenantId: TENANT_1,
        jobId: "job-1",
        state: "queued",
        message: "Job queued",
      });
      await hub.publish({
        runId: RUN_ID,
        tenantId: TENANT_1,
        jobId: "job-1",
        state: "running",
        message: "Starting assessment",
      });
      await hub.publish({
        runId: RUN_ID,
        tenantId: TENANT_1,
        jobId: "job-1",
        state: "running",
        section: "Identity",
        sectionState: "running",
        completed: 1,
        total: 10,
      });
      await hub.publish({
        runId: RUN_ID,
        tenantId: TENANT_1,
        jobId: "job-1",
        state: "running",
        section: "Identity",
        sectionState: "succeeded",
        completed: 5,
        total: 10,
      });
      // Terminal event closes stream
      await hub.publish({
        runId: RUN_ID,
        tenantId: TENANT_1,
        jobId: "job-1",
        state: "succeeded",
        completed: 10,
        total: 10,
        message: "Assessment finished successfully",
      });
    }, 10);

    const result = await route.handler(createContext(RUN_ID));
    expect(result.status).toBe(200);
    expect(result.contentType).toBe("text/event-stream; charset=utf-8");

    const rawStream = typeof result.raw === "string" ? result.raw : result.raw?.toString("utf8") ?? "";
    const parsedBlocks = parseSseStream(rawStream);

    expect(parsedBlocks).toHaveLength(5);

    // Verify ordering and structure
    const parsedEvents = parsedBlocks.map((b) => parseProgressEvent(b.data));

    expect(parsedEvents.map((e) => e.sequence)).toEqual([0, 1, 2, 3, 4]);
    expect(parsedEvents.map((e) => e.state)).toEqual([
      "queued",
      "running",
      "running",
      "running",
      "succeeded",
    ]);
    expect(parsedEvents[2]?.section).toBe("Identity");
    expect(parsedEvents[2]?.sectionState).toBe("running");
    expect(parsedEvents[3]?.sectionState).toBe("succeeded");
    expect(parsedEvents[4]?.state).toBe("succeeded");
  });

  it("pushes real-time events to sink callback and handles failed terminal close", async () => {
    const store = new FakeRunEventsStore();
    store.runs.set(RUN_ID, {
      id: RUN_ID,
      tenantId: TENANT_1,
      status: "running",
    });

    const hub = new ProgressEventHub();
    const route = createRunsEventsRoute({
      store,
      hub,
      resolveCaller: () => adminCaller(),
    });

    const realTimeChunks: string[] = [];
    const ctx = createContext(RUN_ID, {
      sink: (chunk) => realTimeChunks.push(chunk),
    });

    setTimeout(async () => {
      await hub.publish({
        runId: RUN_ID,
        tenantId: TENANT_1,
        jobId: "job-1",
        state: "running",
        section: "Security",
        sectionState: "running",
      });
      await hub.publish({
        runId: RUN_ID,
        tenantId: TENANT_1,
        jobId: "job-1",
        state: "failed",
        section: "Security",
        sectionState: "failed",
        message: "Assessment execution failed",
      });
    }, 10);

    const result = await route.handler(ctx);
    expect(result.status).toBe(200);
    expect(realTimeChunks).toHaveLength(2);

    const parsedFirst = parseProgressEvent(parseSseStream(realTimeChunks[0]!)[0]!.data);
    const parsedSecond = parseProgressEvent(parseSseStream(realTimeChunks[1]!)[0]!.data);

    expect(parsedFirst.sequence).toBe(0);
    expect(parsedFirst.section).toBe("Security");
    expect(parsedSecond.sequence).toBe(1);
    expect(parsedSecond.state).toBe("failed");
  });

  it("replays full past history for late-connecting subscribers", async () => {
    const store = new FakeRunEventsStore();
    store.runs.set(RUN_ID, {
      id: RUN_ID,
      tenantId: TENANT_1,
      status: "succeeded",
    });

    const hub = new ProgressEventHub();
    await hub.publish({
      runId: RUN_ID,
      tenantId: TENANT_1,
      jobId: "job-1",
      state: "running",
    });
    await hub.publish({
      runId: RUN_ID,
      tenantId: TENANT_1,
      jobId: "job-1",
      state: "succeeded",
    });

    const route = createRunsEventsRoute({
      store,
      hub,
      resolveCaller: () => adminCaller(),
    });

    const response = await route.handler(createContext(RUN_ID));
    const events = parseSseStream(response.raw as string).map((b) => parseProgressEvent(b.data));

    expect(events).toHaveLength(2);
    expect(events[0]?.state).toBe("running");
    expect(events[1]?.state).toBe("succeeded");
  });

  it("never exposes secret tokens or tenant PII in the stream", async () => {
    const store = new FakeRunEventsStore();
    store.runs.set(RUN_ID, {
      id: RUN_ID,
      tenantId: TENANT_1,
      status: "succeeded",
    });

    const hub = new ProgressEventHub();
    await hub.publish({
      runId: RUN_ID,
      tenantId: TENANT_1,
      jobId: "job-1",
      state: "succeeded",
      message: "Worker processed tenant admin operator.jane@acme.corp with Bearer supersecrettoken123 and password=mypassword",
    });

    const route = createRunsEventsRoute({
      store,
      hub,
      resolveCaller: () => adminCaller(),
    });

    const response = await route.handler(createContext(RUN_ID));
    const raw = response.raw as string;

    expect(raw).not.toContain("operator.jane@acme.corp");
    expect(raw).toContain("[redacted-email]");
    expect(raw).not.toContain("supersecrettoken123");
    expect(raw).not.toContain("mypassword");
  });
});
