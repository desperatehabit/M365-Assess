// T-0424 — Quarantine list, preview, release, and delete route gating.
// Route-level tests: the list route serves the §3.3 columns for the Email,
// Files, and Teams tabs through the injected provider with the §3.3 filters;
// the preview route returns the message metadata and the exo/graph source; the
// action route requires quarantine.act + Remediation.Apply, requires explicit
// confirmation for release/release-to-all/delete, supports plan preview with
// no tenant write, and on apply enqueues the EPIC-006 gated job and writes a
// QuarantineAction plus an AuditEvent.

import { describe, expect, it } from "vitest";
import { tenantScope } from "../rbac/scope.js";
import type { JobEnvelope } from "@m365-assess/contracts";
import type { RequestContext } from "../server.js";
import {
  QUARANTINE_ACTION_PATH,
  QUARANTINE_CONFIRM_REQUIRED,
  QUARANTINE_ITEM_PATH,
  QUARANTINE_NOT_FOUND,
  QUARANTINE_PATH,
  QUARANTINE_READ_PERMISSION,
  QUARANTINE_ACT_PERMISSION,
  REMEDIATION_APPLY_PERMISSION,
  createQuarantineRoutes,
  parseQuarantineAction,
  parseQuarantineTab,
  type QuarantineActionPlan,
  type QuarantineActionRecordInput,
  type QuarantineAuditEvent,
  type QuarantineCaller,
  type QuarantineFilter,
  type QuarantineMessage,
  type QuarantineMessageDetail,
  type QuarantinePage,
  type QuarantineProvider,
} from "./quarantine.js";

const TENANT = "tenant-test";
const MESSAGE_ID = "message-1";

const EMAIL_MESSAGE: QuarantineMessage = {
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
};

const DETAIL: QuarantineMessageDetail = {
  ...EMAIL_MESSAGE,
  preview: { source: "exo", available: true, body: "preview body" },
};

class FakeQuarantineProvider implements QuarantineProvider {
  readonly listCalls: Array<{ tenantId: string; filter: QuarantineFilter }> = [];

  async listMessages(tenantId: string, filter: QuarantineFilter): Promise<QuarantinePage> {
    this.listCalls.push({ tenantId, filter });
    return {
      tenantId,
      tab: filter.tab,
      items: [EMAIL_MESSAGE],
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

function ctx(
  path: string,
  options: {
    params?: Record<string, string>;
    body?: Record<string, unknown>;
    query?: Record<string, string>;
  } = {},
): RequestContext & { body?: unknown } {
  const query = new URLSearchParams(options.query ?? {});
  return {
    correlationId: "corr-quarantine-1",
    method: "GET",
    path,
    query,
    headers: {},
    params: options.params ?? {},
    ...(options.body !== undefined ? { body: options.body } : {}),
  };
}

describe("Quarantine routes (T-0424)", () => {
  it("exposes the list, preview, and action paths", () => {
    const routes = createQuarantineRoutes({
      provider: new FakeQuarantineProvider(),
      queue: new FakeQueue(),
      resolveCaller: writerCaller,
    });
    expect(routes.map((route) => `${route.method} ${route.path}`)).toEqual([
      `GET ${QUARANTINE_PATH}`,
      `GET ${QUARANTINE_ITEM_PATH}`,
      `POST ${QUARANTINE_ACTION_PATH}`,
    ]);
  });

  it("rejects unauthenticated requests with 401", async () => {
    const routes = createQuarantineRoutes({
      provider: new FakeQuarantineProvider(),
      resolveCaller: () => undefined,
    });
    await expect(
      routeByPath(routes, "GET", QUARANTINE_PATH).handler(
        ctx(`/v1/tenants/${TENANT}/quarantine`, { params: { tenantId: TENANT } }),
      ),
    ).rejects.toMatchObject({ status: 401 });
  });

  it("rejects a tenant outside the caller scope with 403", async () => {
    const routes = createQuarantineRoutes({
      provider: new FakeQuarantineProvider(),
      resolveCaller: () => ({
        tenantScope: tenantScope(["different-tenant"]),
        permissions: [QUARANTINE_READ_PERMISSION],
      }),
    });
    await expect(
      routeByPath(routes, "GET", QUARANTINE_PATH).handler(
        ctx(`/v1/tenants/${TENANT}/quarantine`, { params: { tenantId: TENANT } }),
      ),
    ).rejects.toMatchObject({ status: 403 });
  });

  it("rejects reads without quarantine.read with 403", async () => {
    const routes = createQuarantineRoutes({
      provider: new FakeQuarantineProvider(),
      resolveCaller: () => ({
        tenantScope: tenantScope([TENANT]),
        permissions: [QUARANTINE_ACT_PERMISSION],
      }),
    });
    await expect(
      routeByPath(routes, "GET", QUARANTINE_PATH).handler(
        ctx(`/v1/tenants/${TENANT}/quarantine`, { params: { tenantId: TENANT } }),
      ),
    ).rejects.toMatchObject({ status: 403 });
  });

  it("rejects actions without quarantine.act with 403", async () => {
    const routes = createQuarantineRoutes({
      provider: new FakeQuarantineProvider(),
      queue: new FakeQueue(),
      resolveCaller: readerCaller,
    });
    await expect(
      routeByPath(routes, "POST", QUARANTINE_ACTION_PATH).handler(
        ctx(`/v1/tenants/${TENANT}/quarantine/${MESSAGE_ID}/release`, {
          params: { tenantId: TENANT, messageId: MESSAGE_ID, action: "release" },
          body: { confirm: true },
        }),
      ),
    ).rejects.toMatchObject({ status: 403 });
  });

  it("accepts Remediation.Apply through the EPIC-006 gate", async () => {
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
    const response = await routeByPath(routes, "POST", QUARANTINE_ACTION_PATH).handler(
      ctx(`/v1/tenants/${TENANT}/quarantine/${MESSAGE_ID}/delete`, {
        params: { tenantId: TENANT, messageId: MESSAGE_ID, action: "delete" },
        body: { confirm: true },
      }),
    );
    expect(response.status).toBe(202);
    expect(queue.enqueued).toHaveLength(1);
    expect(queue.enqueued[0]?.payload).toMatchObject({
      area: "quarantine",
      action: "delete",
      messageId: MESSAGE_ID,
    });
  });

  it("lists the Email tab with the §3.3 columns and passes the filters through", async () => {
    const provider = new FakeQuarantineProvider();
    const routes = createQuarantineRoutes({ provider, resolveCaller: readerCaller });
    const response = await routeByPath(routes, "GET", QUARANTINE_PATH).handler(
      ctx(`/v1/tenants/${TENANT}/quarantine`, {
        params: { tenantId: TENANT },
        query: {
          tab: "email",
          reason: "Spam",
          direction: "Inbound",
          recipient: "user@example.invalid",
          state: "Quarantined",
          dateFrom: "2026-09-01T00:00:00Z",
          dateTo: "2026-09-30T00:00:00Z",
        },
      }),
    );
    expect(response.status).toBe(200);
    const body = response.body as QuarantinePage;
    expect(body.tenantId).toBe(TENANT);
    expect(body.tab).toBe("email");
    expect(body.totalCount).toBe(1);
    expect(body.items[0]).toMatchObject({
      messageId: MESSAGE_ID,
      subject: "Invoice overdue",
      sender: "sender@example.invalid",
      recipient: "user@example.invalid",
      reason: "Spam",
      state: "Quarantined",
    });
    expect(provider.listCalls).toHaveLength(1);
    expect(provider.listCalls[0]?.filter).toMatchObject({
      tab: "email",
      reason: "Spam",
      direction: "Inbound",
      recipient: "user@example.invalid",
      state: "Quarantined",
      dateFrom: "2026-09-01T00:00:00Z",
      dateTo: "2026-09-30T00:00:00Z",
    });
  });

  it("defaults to the Email tab and rejects an unknown tab with 400", async () => {
    const routes = createQuarantineRoutes({
      provider: new FakeQuarantineProvider(),
      resolveCaller: readerCaller,
    });
    const response = await routeByPath(routes, "GET", QUARANTINE_PATH).handler(
      ctx(`/v1/tenants/${TENANT}/quarantine`, { params: { tenantId: TENANT } }),
    );
    expect((response.body as QuarantinePage).tab).toBe("email");

    await expect(
      routeByPath(routes, "GET", QUARANTINE_PATH).handler(
        ctx(`/v1/tenants/${TENANT}/quarantine`, {
          params: { tenantId: TENANT },
          query: { tab: "userReported" },
        }),
      ),
    ).rejects.toMatchObject({ status: 400 });
  });

  it("lists the Files and Teams tabs", async () => {
    const routes = createQuarantineRoutes({
      provider: new FakeQuarantineProvider(),
      resolveCaller: readerCaller,
    });
    for (const tab of ["files", "teams"]) {
      const response = await routeByPath(routes, "GET", QUARANTINE_PATH).handler(
        ctx(`/v1/tenants/${TENANT}/quarantine`, {
          params: { tenantId: TENANT },
          query: { tab },
        }),
      );
      expect((response.body as QuarantinePage).tab).toBe(tab);
    }
  });

  it("previews a message with the exo/graph preview source", async () => {
    const routes = createQuarantineRoutes({
      provider: new FakeQuarantineProvider(),
      resolveCaller: readerCaller,
    });
    const response = await routeByPath(routes, "GET", QUARANTINE_ITEM_PATH).handler(
      ctx(`/v1/tenants/${TENANT}/quarantine/${MESSAGE_ID}`, {
        params: { tenantId: TENANT, messageId: MESSAGE_ID },
      }),
    );
    expect(response.status).toBe(200);
    const detail = response.body as QuarantineMessageDetail;
    expect(detail.messageId).toBe(MESSAGE_ID);
    expect(detail.preview).toMatchObject({ source: "exo", available: true });
  });

  it("returns 404 when previewing an unknown message", async () => {
    const routes = createQuarantineRoutes({
      provider: new FakeQuarantineProvider(),
      resolveCaller: readerCaller,
    });
    await expect(
      routeByPath(routes, "GET", QUARANTINE_ITEM_PATH).handler(
        ctx(`/v1/tenants/${TENANT}/quarantine/missing`, {
          params: { tenantId: TENANT, messageId: "missing" },
        }),
      ),
    ).rejects.toMatchObject({ status: 404, code: QUARANTINE_NOT_FOUND });
  });

  it("rejects an unknown action with 400", async () => {
    const routes = createQuarantineRoutes({
      provider: new FakeQuarantineProvider(),
      queue: new FakeQueue(),
      resolveCaller: writerCaller,
    });
    await expect(
      routeByPath(routes, "POST", QUARANTINE_ACTION_PATH).handler(
        ctx(`/v1/tenants/${TENANT}/quarantine/${MESSAGE_ID}/forward`, {
          params: { tenantId: TENANT, messageId: MESSAGE_ID, action: "forward" },
          body: { confirm: true },
        }),
      ),
    ).rejects.toMatchObject({ status: 400 });
  });

  it("requires confirmation before releasing and records the plan preview with no writes", async () => {
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

    await expect(
      routeByPath(routes, "POST", QUARANTINE_ACTION_PATH).handler(
        ctx(`/v1/tenants/${TENANT}/quarantine/${MESSAGE_ID}/release`, {
          params: { tenantId: TENANT, messageId: MESSAGE_ID, action: "release" },
          body: {},
        }),
      ),
    ).rejects.toMatchObject({ status: 400, code: QUARANTINE_CONFIRM_REQUIRED });
    expect(queue.enqueued).toHaveLength(0);

    const preview = await routeByPath(routes, "POST", QUARANTINE_ACTION_PATH).handler(
      ctx(`/v1/tenants/${TENANT}/quarantine/${MESSAGE_ID}/release`, {
        params: { tenantId: TENANT, messageId: MESSAGE_ID, action: "release" },
        body: { preview: true },
      }),
    );
    expect(preview.status).toBe(200);
    const plan = preview.body as QuarantineActionPlan;
    expect(plan.action).toBe("release");
    expect(plan.dryRun).toBe(true);
    expect(plan.requiresConfirmation).toBe(true);
    expect(plan.securityImpacting).toBe(true);
    expect(plan.recipient).toBe("user@example.invalid");
    expect(queue.enqueued).toHaveLength(0);
    expect(actions).toHaveLength(0);
    expect(audited).toHaveLength(0);
  });

  it("releases to the recipient through the gate and writes a QuarantineAction plus an AuditEvent", async () => {
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
    const response = await routeByPath(routes, "POST", QUARANTINE_ACTION_PATH).handler(
      ctx(`/v1/tenants/${TENANT}/quarantine/${MESSAGE_ID}/release`, {
        params: { tenantId: TENANT, messageId: MESSAGE_ID, action: "release" },
        body: { confirm: true },
      }),
    );
    expect(response.status).toBe(202);
    const result = response.body as { success: boolean; jobId: string; quarantineActionId: string };
    expect(result.success).toBe(true);
    expect(result.quarantineActionId).toBeTruthy();

    expect(queue.enqueued).toHaveLength(1);
    expect(queue.enqueued[0]?.jobType).toBe("remediation");
    expect(queue.enqueued[0]?.payload).toMatchObject({
      area: "quarantine",
      action: "release",
      messageId: MESSAGE_ID,
      recipient: "user@example.invalid",
      operation: "apply",
    });

    expect(actions).toHaveLength(1);
    expect(actions[0]).toMatchObject({
      tenantId: TENANT,
      messageId: MESSAGE_ID,
      action: "release",
      recipient: "user@example.invalid",
      by: "user-1",
      result: "pending",
    });

    expect(audited).toHaveLength(1);
    expect(audited[0]).toMatchObject({
      action: "quarantine.action.release",
      messageId: MESSAGE_ID,
      recipient: "user@example.invalid",
      actorUserId: "user-1",
      correlationId: "corr-quarantine-1",
    });
  });

  it("releases to all recipients with no recipient and requires confirmation", async () => {
    const queue = new FakeQueue();
    const actions: QuarantineActionRecordInput[] = [];
    const routes = createQuarantineRoutes({
      provider: new FakeQuarantineProvider(),
      queue,
      recordAction: (input) => {
        actions.push(input);
      },
      resolveCaller: writerCaller,
    });

    await expect(
      routeByPath(routes, "POST", QUARANTINE_ACTION_PATH).handler(
        ctx(`/v1/tenants/${TENANT}/quarantine/${MESSAGE_ID}/release-to-all`, {
          params: { tenantId: TENANT, messageId: MESSAGE_ID, action: "release-to-all" },
          body: {},
        }),
      ),
    ).rejects.toMatchObject({ status: 400, code: QUARANTINE_CONFIRM_REQUIRED });

    const response = await routeByPath(routes, "POST", QUARANTINE_ACTION_PATH).handler(
      ctx(`/v1/tenants/${TENANT}/quarantine/${MESSAGE_ID}/release-to-all`, {
        params: { tenantId: TENANT, messageId: MESSAGE_ID, action: "release-to-all" },
        body: { confirm: true },
      }),
    );
    expect(response.status).toBe(202);
    expect((response.body as { plan: QuarantineActionPlan }).plan.action).toBe("releaseAll");
    expect(actions[0]).toMatchObject({ action: "releaseAll", recipient: null });
    expect(queue.enqueued[0]?.payload).toMatchObject({ action: "releaseAll", recipient: null });
  });

  it("deletes a message with confirmation and audits it", async () => {
    const queue = new FakeQueue();
    const audited: QuarantineAuditEvent[] = [];
    const routes = createQuarantineRoutes({
      provider: new FakeQuarantineProvider(),
      queue,
      recordAudit: (event) => {
        audited.push(event);
      },
      resolveCaller: writerCaller,
    });
    await expect(
      routeByPath(routes, "POST", QUARANTINE_ACTION_PATH).handler(
        ctx(`/v1/tenants/${TENANT}/quarantine/${MESSAGE_ID}/delete`, {
          params: { tenantId: TENANT, messageId: MESSAGE_ID, action: "delete" },
          body: {},
        }),
      ),
    ).rejects.toMatchObject({ status: 400, code: QUARANTINE_CONFIRM_REQUIRED });

    const response = await routeByPath(routes, "POST", QUARANTINE_ACTION_PATH).handler(
      ctx(`/v1/tenants/${TENANT}/quarantine/${MESSAGE_ID}/delete`, {
        params: { tenantId: TENANT, messageId: MESSAGE_ID, action: "delete" },
        body: { confirm: true },
      }),
    );
    expect(response.status).toBe(202);
    expect(queue.enqueued[0]?.payload).toMatchObject({ action: "delete" });
    expect(audited[0]).toMatchObject({ action: "quarantine.action.delete" });
  });

  it("blocks the sender without confirmation and audits it", async () => {
    const queue = new FakeQueue();
    const actions: QuarantineActionRecordInput[] = [];
    const routes = createQuarantineRoutes({
      provider: new FakeQuarantineProvider(),
      queue,
      recordAction: (input) => {
        actions.push(input);
      },
      resolveCaller: writerCaller,
    });
    const response = await routeByPath(routes, "POST", QUARANTINE_ACTION_PATH).handler(
      ctx(`/v1/tenants/${TENANT}/quarantine/${MESSAGE_ID}/block`, {
        params: { tenantId: TENANT, messageId: MESSAGE_ID, action: "block" },
        body: {},
      }),
    );
    expect(response.status).toBe(202);
    expect((response.body as { plan: QuarantineActionPlan }).plan.securityImpacting).toBe(false);
    expect(actions[0]).toMatchObject({ action: "block" });
    expect(queue.enqueued[0]?.payload).toMatchObject({
      action: "block",
      sender: "sender@example.invalid",
    });
  });

  it("returns 404 when acting on an unknown message", async () => {
    const routes = createQuarantineRoutes({
      provider: new FakeQuarantineProvider(),
      queue: new FakeQueue(),
      resolveCaller: writerCaller,
    });
    await expect(
      routeByPath(routes, "POST", QUARANTINE_ACTION_PATH).handler(
        ctx(`/v1/tenants/${TENANT}/quarantine/missing/delete`, {
          params: { tenantId: TENANT, messageId: "missing", action: "delete" },
          body: { confirm: true },
        }),
      ),
    ).rejects.toMatchObject({ status: 404, code: QUARANTINE_NOT_FOUND });
  });

  it("parses the tab and action aliases and rejects unknown values", () => {
    expect(parseQuarantineTab("email")).toBe("email");
    expect(parseQuarantineTab("Files")).toBe("files");
    expect(parseQuarantineTab("teams-messages")).toBe("teams");
    expect(() => parseQuarantineTab("userReported")).toThrow(
      expect.objectContaining({ status: 400 }),
    );

    expect(parseQuarantineAction("release")).toBe("release");
    expect(parseQuarantineAction("release-to-all")).toBe("releaseAll");
    expect(parseQuarantineAction("releaseAll")).toBe("releaseAll");
    expect(parseQuarantineAction("delete")).toBe("delete");
    expect(parseQuarantineAction("block")).toBe("block");
    expect(() => parseQuarantineAction("forward")).toThrow(
      expect.objectContaining({ status: 400 }),
    );
  });
});
