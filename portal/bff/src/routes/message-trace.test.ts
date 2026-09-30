import { describe, expect, it } from "vitest";
import { decodeCursor, encodeCursor } from "../pagination.js";
import { tenantScope } from "../rbac/scope.js";
import {
  MESSAGE_TRACE_OPENAPI,
  MESSAGE_TRACE_PATH,
  MESSAGE_TRACE_READ_PERMISSION,
  MESSAGE_TRACE_SEARCH_PERMISSION,
  MESSAGE_TRACE_WINDOW_EXCEEDED,
  createMessageTraceRoutes,
  messageTraceWindowExceededError,
  parseMessageTraceInput,
  type MessageTraceAuditEvent,
  type MessageTraceCaller,
  type MessageTracePage,
  type MessageTraceProvider,
} from "./message-trace.js";

const TENANT = "tenant-test";

const TRACE_PAGE: MessageTracePage = {
  tenantId: TENANT,
  items: [
    {
      timestamp: "2026-09-26T10:00:00.000Z",
      sender: "sender@example.com",
      recipient: "recipient@example.com",
      subject: "Quarterly report",
      status: "Delivered",
      event: "Deliver",
    },
    {
      timestamp: "2026-09-26T11:00:00.000Z",
      sender: "sender@example.com",
      recipient: "other@example.com",
      subject: "Invoice 1024",
      status: "Failed",
      event: "Fail",
    },
  ],
  nextCursor: null,
  totalCount: 2,
  retrievedAt: "2026-09-29T00:00:00.000Z",
};

class FakeMessageTraceProvider implements MessageTraceProvider {
  readonly calls: Array<{ tenantId: string; filter: Parameters<MessageTraceProvider["traceMessages"]>[1] }> = [];
  page: MessageTracePage = TRACE_PAGE;
  error: unknown = undefined;

  async traceMessages(tenantId: string, filter: Parameters<MessageTraceProvider["traceMessages"]>[1]): Promise<MessageTracePage> {
    this.calls.push({ tenantId, filter });
    if (this.error !== undefined) {
      throw this.error;
    }
    const start = decodeCursor(filter.cursor);
    const items = this.page.items.slice(start, start + filter.limit);
    const nextOffset = start + items.length;
    return {
      ...this.page,
      items,
      nextCursor: nextOffset < this.page.items.length ? encodeCursor(nextOffset) : null,
    };
  }
}

function readCaller(): MessageTraceCaller {
  return {
    tenantScope: tenantScope([TENANT]),
    permissions: [MESSAGE_TRACE_READ_PERMISSION],
    userId: "operator-1",
  };
}

function searchCaller(): MessageTraceCaller {
  return {
    tenantScope: tenantScope([TENANT]),
    permissions: [MESSAGE_TRACE_SEARCH_PERMISSION],
    userId: "operator-1",
  };
}

function postBody(body: Record<string, unknown>): RequestContext {
  return {
    method: "POST",
    path: `/v1/tenants/${TENANT}/mail/message-trace`,
    params: { tenantId: TENANT },
    query: new URLSearchParams(),
    headers: {},
    body,
  };
}

describe("Message trace route (T-0462)", () => {
  it("exposes the POST message-trace path", () => {
    const routes = createMessageTraceRoutes({
      provider: new FakeMessageTraceProvider(),
      resolveCaller: readCaller,
    });
    expect(routes.map((route) => `${route.method} ${route.path}`)).toEqual([
      `POST ${MESSAGE_TRACE_PATH}`,
    ]);
  });

  it("rejects unauthenticated requests with 401", async () => {
    const routes = createMessageTraceRoutes({
      provider: new FakeMessageTraceProvider(),
      resolveCaller: () => undefined,
    });

    await expect(routes[0]!.handler(postBody({}))).rejects.toMatchObject({ status: 401 });
  });

  it("rejects a tenant outside the caller scope with 403", async () => {
    const routes = createMessageTraceRoutes({
      provider: new FakeMessageTraceProvider(),
      resolveCaller: () => ({
        tenantScope: tenantScope(["different-tenant"]),
        permissions: [MESSAGE_TRACE_READ_PERMISSION],
      }),
    });

    await expect(routes[0]!.handler(postBody({}))).rejects.toMatchObject({ status: 403 });
  });

  it("rejects callers missing mailtools.read and mailtools.search with 403", async () => {
    const routes = createMessageTraceRoutes({
      provider: new FakeMessageTraceProvider(),
      resolveCaller: () => ({
        tenantScope: tenantScope([TENANT]),
        permissions: ["Identity.User.Read"],
      }),
    });

    await expect(routes[0]!.handler(postBody({}))).rejects.toMatchObject({ status: 403 });
  });

  it("accepts a caller holding mailtools.search", async () => {
    const provider = new FakeMessageTraceProvider();
    const routes = createMessageTraceRoutes({ provider, resolveCaller: searchCaller });

    const response = await routes[0]!.handler(postBody({ subject: "invoice" }));

    expect(response.status).toBe(200);
    expect(provider.calls).toHaveLength(1);
  });

  it("returns the §3.1 trace rows for a scoped filter and audits the query", async () => {
    const provider = new FakeMessageTraceProvider();
    const audits: MessageTraceAuditEvent[] = [];
    const routes = createMessageTraceRoutes({
      provider,
      resolveCaller: readCaller,
      recordAudit: async (event) => {
        audits.push(event);
      },
    });

    const response = await routes[0]!.handler(
      postBody({
        sender: "sender@example.com",
        recipient: "recipient@example.com",
        subject: "Quarterly",
        status: "Delivered",
        startDate: "2026-09-20T00:00:00.000Z",
        endDate: "2026-09-29T00:00:00.000Z",
      }),
    );

    expect(response.status).toBe(200);
    const body = response.body as MessageTracePage;
    expect(body.tenantId).toBe(TENANT);
    expect(body.items).toHaveLength(2);
    expect(body.items[0]).toMatchObject({
      timestamp: "2026-09-26T10:00:00.000Z",
      sender: "sender@example.com",
      recipient: "recipient@example.com",
      subject: "Quarterly report",
      status: "Delivered",
      event: "Deliver",
    });
    expect(provider.calls).toHaveLength(1);
    expect(provider.calls[0]!.filter).toMatchObject({
      sender: "sender@example.com",
      subject: "Quarterly",
      status: "Delivered",
    });
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({
      tenantId: TENANT,
      action: "mail.message_trace.query",
      sender: "sender@example.com",
      subject: "Quarterly",
      resultCount: 2,
    });
  });

  it("maps a provider window breach to a structured error naming the limit", async () => {
    const provider = new FakeMessageTraceProvider();
    provider.error = new Error(
      "message-trace.window_exceeded: the EXO message trace window is 10 days; start date '2026-08-01T00:00:00Z' is outside the window. Use historical search for older messages.",
    );
    const routes = createMessageTraceRoutes({ provider, resolveCaller: readCaller });

    const failure = await routes[0]!
      .handler(postBody({ startDate: "2026-08-01T00:00:00.000Z" }))
      .then(() => {
        throw new Error("expected the trace to fail");
      })
      .catch((error: unknown) => error);

    expect(failure).toMatchObject({ status: 400, code: MESSAGE_TRACE_WINDOW_EXCEEDED });
    expect((failure as Error).message).toMatch(/10 days/);
    expect((failure as Error).message).toMatch(/historical search/);
  });

  it("builds the window error from a bare detail string", () => {
    const error = messageTraceWindowExceededError(
      "message-trace.window_exceeded: the EXO message trace window is 10 days; the requested range spans 30 days.",
    );
    expect(error.status).toBe(400);
    expect(error.code).toBe(MESSAGE_TRACE_WINDOW_EXCEEDED);
    expect(error.message).not.toMatch(/^message-trace\.window_exceeded:/);
    expect(error.message).toMatch(/10 days/);
  });

  it("validates the scoped input", () => {
    const input = parseMessageTraceInput({
      sender: "  sender@example.com  ",
      subject: "invoice",
      startDate: "2026-09-01T00:00:00.000Z",
      endDate: "2026-09-28T00:00:00.000Z",
    });
    expect(input).toMatchObject({ sender: "sender@example.com", subject: "invoice" });
    expect(() => parseMessageTraceInput({ subject: 42 })).toThrow();
    expect(() => parseMessageTraceInput({ startDate: "not-a-date" })).toThrow();
    expect(() =>
      parseMessageTraceInput({
        startDate: "2026-09-28T00:00:00.000Z",
        endDate: "2026-09-01T00:00:00.000Z",
      }),
    ).toThrow();
  });

  it("paginates through the cursor and limit query parameters", async () => {
    const provider = new FakeMessageTraceProvider();
    const routes = createMessageTraceRoutes({ provider, resolveCaller: readCaller });

    const ctx = postBody({});
    ctx.query = new URLSearchParams({ limit: "1" });
    const response = await routes[0]!.handler(ctx);

    expect(response.status).toBe(200);
    const body = response.body as MessageTracePage;
    expect(body.items).toHaveLength(1);
    expect(body.nextCursor).not.toBeNull();
    expect(provider.calls[0]!.filter.limit).toBe(1);
  });

  it("publishes the portal.v1.yaml fragment for the trace query", () => {
    expect(
      MESSAGE_TRACE_OPENAPI.paths["/tenants/{tenantId}/mail/message-trace"],
    ).toBeDefined();
  });
});
