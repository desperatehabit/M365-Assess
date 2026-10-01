// T-0425 — bulk quarantine release/delete route gating. Route-level tests:
// the bulk route rejects a batch over the configured cap before any release or
// delete, renders the confirmation count on preview, requires confirm: true to
// apply, enqueues one EPIC-006 gated job, and records a QuarantineAction plus an
// AuditEvent per item with actor, message, and recipient.
import { describe, expect, it } from "vitest";
import type { JobEnvelope } from "@m365-assess/contracts";
import { tenantScope } from "../rbac/scope.js";
import type { RequestContext } from "../server.js";
import {
  QUARANTINE_ACT_PERMISSION,
  REMEDIATION_APPLY_PERMISSION,
  type QuarantineActionRecordInput,
  type QuarantineAuditEvent,
  type QuarantineCaller,
  type QuarantineMessage,
  type QuarantineMessageDetail,
  type QuarantineProvider,
} from "./quarantine.js";
import {
  QUARANTINE_BULK_PATH,
  createQuarantineBulkRoutes,
  type QuarantineBulkPlan,
} from "./quarantine-bulk.js";
import { QUARANTINE_BULK_CAP_EXCEEDED, QUARANTINE_BULK_CONFIRM_REQUIRED } from "../domain/quarantine/bulk.js";

const TENANT = "tenant-test";

function message(id: string, overrides: Partial<QuarantineMessage> = {}): QuarantineMessage {
  return {
    messageId: id,
    tab: "email",
    received: "2026-09-28T09:00:00Z",
    subject: `Subject ${id}`,
    sender: "sender@example.invalid",
    recipient: `user-${id}@example.invalid`,
    reason: "Spam",
    policy: "Default",
    expires: "2026-10-28T09:00:00Z",
    state: "Quarantined",
    direction: "Inbound",
    ...overrides,
  };
}

const MESSAGES: QuarantineMessage[] = [message("message-1"), message("message-2"), message("message-3")];

class FakeQuarantineProvider implements QuarantineProvider {
  async listMessages(): Promise<never> {
    throw new Error("bulk route must not list");
  }

  async getMessage(
    _tenantId: string,
    messageId: string,
  ): Promise<QuarantineMessageDetail | undefined> {
    const found = MESSAGES.find((item) => item.messageId === messageId);
    if (!found) return undefined;
    return { ...found, preview: { source: "exo", available: true } };
  }
}

class FakeQueue {
  readonly enqueued: JobEnvelope[] = [];

  async enqueue(envelope: JobEnvelope): Promise<string> {
    this.enqueued.push(envelope);
    return envelope.jobId;
  }
}

function writerCaller(): QuarantineCaller {
  return {
    tenantScope: tenantScope([TENANT]),
    permissions: [QUARANTINE_ACT_PERMISSION],
    userId: "user-1",
  };
}

function routeFor(options: Parameters<typeof createQuarantineBulkRoutes>[0]) {
  const route = createQuarantineBulkRoutes(options).find(
    (candidate) => candidate.method === "POST" && candidate.path === QUARANTINE_BULK_PATH,
  );
  if (!route) throw new Error(`missing route POST ${QUARANTINE_BULK_PATH}`);
  return route;
}

function ctx(
  body: Record<string, unknown>,
  options: { query?: Record<string, string> } = {},
): RequestContext {
  return {
    correlationId: "corr-quarantine-bulk-1",
    method: "POST",
    path: `/v1/tenants/${TENANT}/quarantine/bulk`,
    query: new URLSearchParams(options.query ?? {}),
    headers: {},
    params: { tenantId: TENANT },
    body,
  };
}

describe("Bulk quarantine routes (T-0425)", () => {
  it("exposes the bulk path", () => {
    const routes = createQuarantineBulkRoutes({
      provider: new FakeQuarantineProvider(),
      resolveCaller: writerCaller,
    });
    expect(routes.map((route) => `${route.method} ${route.path}`)).toEqual([
      `POST ${QUARANTINE_BULK_PATH}`,
    ]);
  });

  it("rejects unauthenticated requests with 401", async () => {
    const route = routeFor({
      provider: new FakeQuarantineProvider(),
      resolveCaller: () => undefined,
    });
    await expect(
      route.handler(ctx({ action: "delete", messageIds: ["message-1"], confirm: true })),
    ).rejects.toMatchObject({ status: 401 });
  });

  it("rejects a tenant outside the caller scope with 403", async () => {
    const route = routeFor({
      provider: new FakeQuarantineProvider(),
      resolveCaller: () => ({
        tenantScope: tenantScope(["different-tenant"]),
        permissions: [QUARANTINE_ACT_PERMISSION],
      }),
    });
    await expect(
      route.handler(ctx({ action: "delete", messageIds: ["message-1"], confirm: true })),
    ).rejects.toMatchObject({ status: 403 });
  });

  it("rejects a caller without quarantine.act with 403", async () => {
    const route = routeFor({
      provider: new FakeQuarantineProvider(),
      resolveCaller: () => ({
        tenantScope: tenantScope([TENANT]),
        permissions: [],
        userId: "user-1",
      }),
    });
    await expect(
      route.handler(ctx({ action: "delete", messageIds: ["message-1"], confirm: true })),
    ).rejects.toMatchObject({ status: 403 });
  });

  it("accepts Remediation.Apply through the EPIC-006 gate", async () => {
    const queue = new FakeQueue();
    const route = routeFor({
      provider: new FakeQuarantineProvider(),
      queue,
      resolveCaller: () => ({
        tenantScope: tenantScope([TENANT]),
        permissions: [REMEDIATION_APPLY_PERMISSION],
        userId: "user-2",
      }),
    });
    const response = await route.handler(
      ctx({ action: "delete", messageIds: ["message-1"], confirm: true }),
    );
    expect(response.status).toBe(202);
    expect(queue.enqueued).toHaveLength(1);
  });

  it("rejects a batch over the configured cap before any release or delete", async () => {
    const queue = new FakeQueue();
    const actions: QuarantineActionRecordInput[] = [];
    const audited: QuarantineAuditEvent[] = [];
    const route = routeFor({
      provider: new FakeQuarantineProvider(),
      queue,
      cap: 2,
      recordAction: (input) => {
        actions.push(input);
      },
      recordAudit: (event) => {
        audited.push(event);
      },
      resolveCaller: writerCaller,
    });

    await expect(
      route.handler(
        ctx({
          action: "delete",
          messageIds: ["message-1", "message-2", "message-3"],
          confirm: true,
        }),
      ),
    ).rejects.toMatchObject({ status: 400, code: QUARANTINE_BULK_CAP_EXCEEDED });

    expect(queue.enqueued).toHaveLength(0);
    expect(actions).toHaveLength(0);
    expect(audited).toHaveLength(0);
  });

  it("shows the confirmation count on preview and writes nothing", async () => {
    const queue = new FakeQueue();
    const actions: QuarantineActionRecordInput[] = [];
    const route = routeFor({
      provider: new FakeQuarantineProvider(),
      queue,
      cap: 5,
      recordAction: (input) => {
        actions.push(input);
      },
      resolveCaller: writerCaller,
    });

    const response = await route.handler(
      ctx({ action: "release", messageIds: ["message-1", "message-2"], preview: true }),
    );
    expect(response.status).toBe(200);
    const plan = response.body as QuarantineBulkPlan;
    expect(plan.count).toBe(2);
    expect(plan.cap).toBe(5);
    expect(plan.dryRun).toBe(true);
    expect(plan.confirmation).toMatchObject({ count: 2, cap: 5, confirmed: false });
    expect(plan.items.map((item) => item.messageId)).toEqual(["message-1", "message-2"]);
    expect(queue.enqueued).toHaveLength(0);
    expect(actions).toHaveLength(0);
  });

  it("proceeds only on confirm, naming the count in the refusal", async () => {
    const queue = new FakeQueue();
    const route = routeFor({
      provider: new FakeQuarantineProvider(),
      queue,
      resolveCaller: writerCaller,
    });

    let message = "";
    try {
      await route.handler(ctx({ action: "delete", messageIds: ["message-1", "message-2"] }));
    } catch (error) {
      expect(error).toMatchObject({ status: 400, code: QUARANTINE_BULK_CONFIRM_REQUIRED });
      message = (error as Error).message;
    }
    expect(message).toContain("2");
    expect(queue.enqueued).toHaveLength(0);
  });

  it("enqueues one gated job and audits each item with actor, message, and recipient", async () => {
    const queue = new FakeQueue();
    const actions: QuarantineActionRecordInput[] = [];
    const audited: QuarantineAuditEvent[] = [];
    const route = routeFor({
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

    const response = await route.handler(
      ctx({ action: "release", messageIds: ["message-1", "message-2"], confirm: true }),
    );
    expect(response.status).toBe(202);
    const result = response.body as { count: number; items: { messageId: string }[] };
    expect(result.count).toBe(2);
    expect(result.items.map((item) => item.messageId)).toEqual(["message-1", "message-2"]);

    expect(queue.enqueued).toHaveLength(1);
    expect(queue.enqueued[0]?.jobType).toBe("remediation");
    expect(queue.enqueued[0]?.payload).toMatchObject({
      area: "quarantine-bulk",
      action: "release",
      operation: "apply",
      confirm: true,
    });
    expect((queue.enqueued[0]?.payload as { messages: unknown[] }).messages).toHaveLength(2);

    expect(actions).toHaveLength(2);
    expect(actions[0]).toMatchObject({
      tenantId: TENANT,
      messageId: "message-1",
      action: "release",
      recipient: "user-message-1@example.invalid",
      by: "user-1",
      result: "pending",
    });

    expect(audited).toHaveLength(2);
    expect(audited[0]).toMatchObject({
      action: "quarantine.bulk.release",
      messageId: "message-1",
      recipient: "user-message-1@example.invalid",
      actorUserId: "user-1",
      correlationId: "corr-quarantine-bulk-1",
    });
  });

  it("releases to all with a null recipient per item", async () => {
    const queue = new FakeQueue();
    const actions: QuarantineActionRecordInput[] = [];
    const route = routeFor({
      provider: new FakeQuarantineProvider(),
      queue,
      recordAction: (input) => {
        actions.push(input);
      },
      resolveCaller: writerCaller,
    });

    const response = await route.handler(
      ctx({ action: "release-to-all", messageIds: ["message-1"], confirm: true }),
    );
    expect(response.status).toBe(202);
    expect(actions[0]).toMatchObject({ action: "releaseAll", recipient: null });
    expect(
      (queue.enqueued[0]?.payload as { messages: { recipient: string | null }[] }).messages[0]
        ?.recipient,
    ).toBeNull();
  });

  it("returns 404 for a selected message that does not exist, writing nothing", async () => {
    const queue = new FakeQueue();
    const route = routeFor({
      provider: new FakeQuarantineProvider(),
      queue,
      resolveCaller: writerCaller,
    });
    await expect(
      route.handler(
        ctx({ action: "delete", messageIds: ["message-1", "missing"], confirm: true }),
      ),
    ).rejects.toMatchObject({ status: 404 });
    expect(queue.enqueued).toHaveLength(0);
  });
});
