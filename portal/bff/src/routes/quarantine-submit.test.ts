// T-0426 — Quarantine submit-for-review with tracked status.
// Route-level tests: POST /v1/tenants/:tenantId/quarantine/:messageId/submit
// requires quarantine.act, routes the submission through the EPIC-006 gated
// queue, records a QuarantineAction with action `submit` plus an AuditEvent,
// and returns the tracked submission status. A later request with refresh:true
// reads the live review state back (not the value captured at submit time) and
// updates the tracked action.

import { describe, expect, it } from "vitest";
import { tenantScope } from "../rbac/scope.js";
import type { JobEnvelope } from "@m365-assess/contracts";
import type { RequestContext } from "../server.js";
import {
  QUARANTINE_ACTION_PATH,
  QUARANTINE_ACT_PERMISSION,
  QUARANTINE_READ_PERMISSION,
  REMEDIATION_APPLY_PERMISSION,
  createQuarantineRoutes,
  parseQuarantineAction,
  quarantineActionResultForSubmission,
  type QuarantineActionRecordInput,
  type QuarantineActionUpdateInput,
  type QuarantineAuditEvent,
  type QuarantineCaller,
  type QuarantineFilter,
  type QuarantineMessageDetail,
  type QuarantinePage,
  type QuarantineProvider,
  type QuarantineSubmission,
  type QuarantineSubmissionStatus,
  type QuarantineSubmitProvider,
  type QuarantineSubmitResult,
} from "./quarantine.js";

const TENANT = "tenant-test";
const MESSAGE_ID = "message-1";

const DETAIL: QuarantineMessageDetail = {
  messageId: MESSAGE_ID,
  tab: "email",
  received: "2026-09-28T09:00:00Z",
  subject: "Invoice overdue",
  sender: "sender@example.invalid",
  recipient: "user@example.invalid",
  reason: "Spam",
  policy: "Default",
  expires: "2026-10-28T09:00:00Z",
  state: "Quarantined",
  direction: "Inbound",
  preview: { source: "exo", available: true, body: "preview body" },
};

class FakeQuarantineProvider implements QuarantineProvider {
  async listMessages(tenantId: string, filter: QuarantineFilter): Promise<QuarantinePage> {
    return {
      tenantId,
      tab: filter.tab,
      items: [DETAIL],
      totalCount: 1,
      nextCursor: null,
      retrievedAt: "2026-09-28T00:00:00.000Z",
    };
  }

  async getMessage(
    tenantId: string,
    messageId: string,
  ): Promise<QuarantineMessageDetail | undefined> {
    return messageId === MESSAGE_ID ? DETAIL : undefined;
  }
}

class FakeQueue {
  readonly enqueued: JobEnvelope[] = [];

  async enqueue(envelope: JobEnvelope): Promise<string> {
    this.enqueued.push(envelope);
    return envelope.jobId;
  }
}

// Reports a sequence of live review states, one per refresh call, so a test can
// prove the route reads the provider each time instead of replaying a value.
class FakeSubmitProvider implements QuarantineSubmitProvider {
  readonly calls: Array<{ tenantId: string; messageId: string }> = [];
  private index = 0;

  constructor(private readonly statuses: QuarantineSubmissionStatus[]) {}

  async getSubmissionStatus(
    tenantId: string,
    messageId: string,
  ): Promise<QuarantineSubmission | undefined> {
    this.calls.push({ tenantId, messageId });
    if (this.statuses.length === 0) return undefined;
    const status = this.statuses[Math.min(this.index, this.statuses.length - 1)]!;
    this.index += 1;
    return {
      submissionId: "submission-1",
      messageId,
      status,
      submittedAt: "2026-09-28T10:00:00.000Z",
      updatedAt: "2026-09-28T11:00:00.000Z",
    };
  }
}

function writerCaller(): QuarantineCaller {
  return {
    tenantScope: tenantScope([TENANT]),
    permissions: [QUARANTINE_ACT_PERMISSION],
    userId: "user-1",
  };
}

function readerCaller(): QuarantineCaller {
  return {
    tenantScope: tenantScope([TENANT]),
    permissions: [QUARANTINE_READ_PERMISSION],
  };
}

function routeByPath(
  routes: ReturnType<typeof createQuarantineRoutes>,
  method: string,
  path: string,
) {
  const route = routes.find((r) => r.method === method && r.path === path);
  if (!route) throw new Error(`missing route ${method} ${path}`);
  return route;
}

function submitCtx(
  options: {
    body?: Record<string, unknown>;
    query?: Record<string, string>;
  } = {},
): RequestContext {
  return {
    correlationId: "corr-quarantine-submit-1",
    method: "POST",
    path: `/v1/tenants/${TENANT}/quarantine/${MESSAGE_ID}/submit`,
    query: new URLSearchParams(options.query ?? {}),
    headers: {},
    params: { tenantId: TENANT, messageId: MESSAGE_ID, action: "submit" },
    ...(options.body !== undefined ? { body: options.body } : {}),
  };
}

function submit(routes: ReturnType<typeof createQuarantineRoutes>, body: Record<string, unknown>) {
  return routeByPath(routes, "POST", QUARANTINE_ACTION_PATH).handler(submitCtx({ body }));
}

describe("Quarantine submit-for-review (T-0426)", () => {
  it("parses submit as an action", () => {
    expect(parseQuarantineAction("submit")).toBe("submit");
    expect(parseQuarantineAction("submit-for-review")).toBe("submit");
    expect(parseQuarantineAction("Submit")).toBe("submit");
  });

  it("submits a message for review and returns a tracked submission status", async () => {
    const queue = new FakeQueue();
    const routes = createQuarantineRoutes({
      provider: new FakeQuarantineProvider(),
      queue,
      resolveCaller: writerCaller,
    });

    const response = await submit(routes, {});
    expect(response.status).toBe(202);
    const result = response.body as QuarantineSubmitResult;
    expect(result.success).toBe(true);
    expect(result.action).toBe("submit");
    expect(result.messageId).toBe(MESSAGE_ID);
    expect(result.status).toBe("pending");
    expect(result.submissionId).toBeTruthy();
    expect(result.jobId).toBeTruthy();
  });

  it("routes the submission through the EPIC-006 gated path", async () => {
    const queue = new FakeQueue();
    const routes = createQuarantineRoutes({
      provider: new FakeQuarantineProvider(),
      queue,
      resolveCaller: writerCaller,
    });

    await submit(routes, {});
    expect(queue.enqueued).toHaveLength(1);
    expect(queue.enqueued[0]?.jobType).toBe("remediation");
    expect(queue.enqueued[0]?.payload).toMatchObject({
      area: "quarantine",
      action: "submit",
      messageId: MESSAGE_ID,
      operation: "apply",
    });
  });

  it("records a QuarantineAction with action submit plus an AuditEvent", async () => {
    const queue = new FakeQueue();
    const actions: QuarantineActionRecordInput[] = [];
    const audited: QuarantineAuditEvent[] = [];
    const routes = createQuarantineRoutes({
      provider: new FakeQuarantineProvider(),
      queue,
      recordAction: (input) => {
        actions.push(input);
      },
      recordAudit: (event) => {
        audited.push(event);
      },
      resolveCaller: writerCaller,
    });

    const response = await submit(routes, {});
    const result = response.body as QuarantineSubmitResult;

    expect(actions).toHaveLength(1);
    expect(actions[0]).toMatchObject({
      tenantId: TENANT,
      messageId: MESSAGE_ID,
      action: "submit",
      recipient: null,
      by: "user-1",
      result: "pending",
    });
    expect(result.quarantineActionId).toBe(actions[0]?.id);

    expect(audited).toHaveLength(1);
    expect(audited[0]).toMatchObject({
      action: "quarantine.action.submit",
      messageId: MESSAGE_ID,
      actorUserId: "user-1",
      correlationId: "corr-quarantine-submit-1",
      result: "pending",
    });
    expect(result.auditEventId).toBe(audited[0]?.id);
  });

  it("accepts Remediation.Apply through the gate", async () => {
    const queue = new FakeQueue();
    const routes = createQuarantineRoutes({
      provider: new FakeQuarantineProvider(),
      queue,
      resolveCaller: () => ({
        tenantScope: tenantScope([TENANT]),
        permissions: [REMEDIATION_APPLY_PERMISSION],
        userId: "user-2",
      }),
    });

    const response = await submit(routes, {});
    expect(response.status).toBe(202);
    expect(queue.enqueued).toHaveLength(1);
  });

  it("rejects a submit without quarantine.act with 403", async () => {
    const routes = createQuarantineRoutes({
      provider: new FakeQuarantineProvider(),
      queue: new FakeQueue(),
      resolveCaller: readerCaller,
    });
    await expect(submit(routes, {})).rejects.toMatchObject({ status: 403 });
  });

  it("rejects an unauthenticated submit with 401", async () => {
    const routes = createQuarantineRoutes({
      provider: new FakeQuarantineProvider(),
      queue: new FakeQueue(),
      resolveCaller: () => undefined,
    });
    await expect(submit(routes, {})).rejects.toMatchObject({ status: 401 });
  });

  it("rejects a tenant outside the caller scope with 403", async () => {
    const routes = createQuarantineRoutes({
      provider: new FakeQuarantineProvider(),
      queue: new FakeQueue(),
      resolveCaller: () => ({
        tenantScope: tenantScope(["different-tenant"]),
        permissions: [QUARANTINE_ACT_PERMISSION],
      }),
    });
    await expect(submit(routes, {})).rejects.toMatchObject({ status: 403 });
  });

  it("returns 404 for an unknown message", async () => {
    const routes = createQuarantineRoutes({
      provider: new FakeQuarantineProvider(),
      queue: new FakeQueue(),
      resolveCaller: writerCaller,
    });
    const ctx = submitCtx({});
    ctx.params["messageId"] = "missing";
    await expect(
      routeByPath(routes, "POST", QUARANTINE_ACTION_PATH).handler(ctx),
    ).rejects.toMatchObject({ status: 404 });
  });

  it("refresh reads the live review state and updates the tracked action, not the stale value", async () => {
    const queue = new FakeQueue();
    const actions: QuarantineActionRecordInput[] = [];
    const updates: QuarantineActionUpdateInput[] = [];
    const audited: QuarantineAuditEvent[] = [];
    const provider = new FakeSubmitProvider(["inReview", "released"]);
    const routes = createQuarantineRoutes({
      provider: new FakeQuarantineProvider(),
      queue,
      submitProvider: provider,
      recordAction: (input) => {
        actions.push(input);
      },
      updateAction: (input) => {
        updates.push(input);
      },
      recordAudit: (event) => {
        audited.push(event);
      },
      resolveCaller: writerCaller,
    });

    const first = await submit(routes, { refresh: true });
    expect(first.status).toBe(200);
    expect((first.body as QuarantineSubmitResult).status).toBe("inReview");

    const second = await submit(routes, { refresh: true });
    expect(second.status).toBe(200);
    expect((second.body as QuarantineSubmitResult).status).toBe("released");

    expect(provider.calls).toHaveLength(2);
    expect(updates).toEqual([
      expect.objectContaining({ tenantId: TENANT, messageId: MESSAGE_ID, action: "submit", result: "pending" }),
      expect.objectContaining({ tenantId: TENANT, messageId: MESSAGE_ID, action: "submit", result: "success" }),
    ]);

    // A refresh is a read: no new submission, no new QuarantineAction, no new audit.
    expect(queue.enqueued).toHaveLength(0);
    expect(actions).toHaveLength(0);
    expect(audited).toHaveLength(0);
  });

  it("refresh reads the live state from the query flag too", async () => {
    const provider = new FakeSubmitProvider(["rejected"]);
    const routes = createQuarantineRoutes({
      provider: new FakeQuarantineProvider(),
      queue: new FakeQueue(),
      submitProvider: provider,
      resolveCaller: writerCaller,
    });

    const response = await routeByPath(routes, "POST", QUARANTINE_ACTION_PATH).handler(
      submitCtx({ query: { refresh: "true" } }),
    );
    expect(response.status).toBe(200);
    expect((response.body as QuarantineSubmitResult).status).toBe("rejected");
  });

  it("refresh returns 404 when no submission is tracked", async () => {
    const routes = createQuarantineRoutes({
      provider: new FakeQuarantineProvider(),
      queue: new FakeQueue(),
      submitProvider: new FakeSubmitProvider([]),
      resolveCaller: writerCaller,
    });
    await expect(submit(routes, { refresh: true })).rejects.toMatchObject({
      status: 404,
      code: "quarantine.submission_not_found",
    });
  });

  it("refresh without a status provider is an internal error", async () => {
    const routes = createQuarantineRoutes({
      provider: new FakeQuarantineProvider(),
      queue: new FakeQueue(),
      resolveCaller: writerCaller,
    });
    await expect(submit(routes, { refresh: true })).rejects.toMatchObject({ status: 500 });
  });

  it("maps a review state onto the tracked action result", () => {
    expect(quarantineActionResultForSubmission("pending")).toBe("pending");
    expect(quarantineActionResultForSubmission("inReview")).toBe("pending");
    expect(quarantineActionResultForSubmission("reviewed")).toBe("success");
    expect(quarantineActionResultForSubmission("released")).toBe("success");
    expect(quarantineActionResultForSubmission("rejected")).toBe("failure");
  });
});
