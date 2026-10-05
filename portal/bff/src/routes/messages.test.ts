import { describe, expect, it } from "vitest";
import { tenantScope } from "../rbac/scope.js";
import {
  MESSAGE_DETAIL_PATH,
  MESSAGE_NOT_FOUND,
  MESSAGES_CONTENT_PERMISSION,
  MESSAGES_READ_PERMISSION,
  createMessageRoutes,
  getMessageDetail,
  hasMessageContentAccess,
  type MessageDetail,
  type MessageReadAuditEvent,
  type MessagesCaller,
  type MessagesProvider,
} from "./messages.js";

const TENANT = "tenant-test";
const MESSAGE_ID = "message-1";

const GATED_DETAIL: MessageDetail = {
  tenantId: TENANT,
  messageId: MESSAGE_ID,
  subject: "Quarterly report",
  sender: "sender@example.com",
  recipients: ["recipient@example.com"],
  receivedAt: "2026-09-26T10:00:00.000Z",
  status: "Delivered",
  size: "12 KB",
  deliveryEvents: [
    { timestamp: "2026-09-26T10:00:01.000Z", event: "Receive", detail: "Received by connector" },
    { timestamp: "2026-09-26T10:00:04.000Z", event: "Deliver", detail: "Delivered to mailbox" },
  ],
  connectors: ["Inbound from partner"],
  filtersHit: ["SpamFilterVerdict: Pass"],
  headers: [{ name: "Authentication-Results", value: "dkim=pass" }],
  body: null,
  bodyGated: true,
  bodyGateReason: "The message body requires the Exchange.MailContent.Reveal permission.",
  retrievedAt: "2026-09-26T10:01:00.000Z",
};

const UNGATED_DETAIL: MessageDetail = {
  ...GATED_DETAIL,
  body: "<p>Hello</p>",
  bodyGated: false,
  bodyGateReason: "",
};

class FakeMessagesProvider implements MessagesProvider {
  readonly calls: Array<{ tenantId: string; messageId: string; includeBody: boolean }> = [];
  detail: MessageDetail | null = GATED_DETAIL;

  async getMessage(
    tenantId: string,
    messageId: string,
    includeBody: boolean,
  ): Promise<MessageDetail | null> {
    this.calls.push({ tenantId, messageId, includeBody });
    if (this.detail === null) {
      return null;
    }
    return includeBody ? { ...this.detail, ...UNGATED_DETAIL } : { ...this.detail, ...GATED_DETAIL };
  }
}

function readCaller(): MessagesCaller {
  return {
    tenantScope: tenantScope([TENANT]),
    permissions: [MESSAGES_READ_PERMISSION],
  };
}

function contentCaller(): MessagesCaller {
  return {
    tenantScope: tenantScope([TENANT]),
    permissions: [MESSAGES_READ_PERMISSION, MESSAGES_CONTENT_PERMISSION],
  };
}

describe("Message viewer detail route (T-0464)", () => {
  it("exposes GET message detail path", () => {
    const routes = createMessageRoutes({
      provider: new FakeMessagesProvider(),
      resolveCaller: readCaller,
    });
    expect(routes.map((route) => `${route.method} ${route.path}`)).toEqual([
      `GET ${MESSAGE_DETAIL_PATH}`,
    ]);
  });

  it("rejects unauthenticated requests with 401", async () => {
    const routes = createMessageRoutes({
      provider: new FakeMessagesProvider(),
      resolveCaller: () => undefined,
    });

    await expect(
      routes[0]!.handler({
        method: "GET",
        path: `/v1/tenants/${TENANT}/mail/messages/${MESSAGE_ID}`,
        params: { tenantId: TENANT, messageId: MESSAGE_ID },
        query: new URLSearchParams(),
        headers: {},
      }),
    ).rejects.toMatchObject({ status: 401 });
  });

  it("rejects tenant outside caller scope with 403", async () => {
    const routes = createMessageRoutes({
      provider: new FakeMessagesProvider(),
      resolveCaller: () => ({
        tenantScope: tenantScope(["different-tenant"]),
        permissions: [MESSAGES_READ_PERMISSION],
      }),
    });

    await expect(
      routes[0]!.handler({
        method: "GET",
        path: `/v1/tenants/${TENANT}/mail/messages/${MESSAGE_ID}`,
        params: { tenantId: TENANT, messageId: MESSAGE_ID },
        query: new URLSearchParams(),
        headers: {},
      }),
    ).rejects.toMatchObject({ status: 403 });
  });

  it("rejects callers missing Exchange.MailTools.Read with 403", async () => {
    const routes = createMessageRoutes({
      provider: new FakeMessagesProvider(),
      resolveCaller: () => ({
        tenantScope: tenantScope([TENANT]),
        permissions: ["Identity.User.Read"],
      }),
    });

    await expect(
      routes[0]!.handler({
        method: "GET",
        path: `/v1/tenants/${TENANT}/mail/messages/${MESSAGE_ID}`,
        params: { tenantId: TENANT, messageId: MESSAGE_ID },
        query: new URLSearchParams(),
        headers: {},
      }),
    ).rejects.toMatchObject({ status: 403 });
  });

  it("returns events, connectors, filters, and headers with the body gated", async () => {
    const provider = new FakeMessagesProvider();
    const audits: MessageReadAuditEvent[] = [];
    const routes = createMessageRoutes({
      provider,
      resolveCaller: readCaller,
      recordAudit: async (event) => {
        audits.push(event);
      },
    });

    const response = await routes[0]!.handler({
      method: "GET",
      path: `/v1/tenants/${TENANT}/mail/messages/${MESSAGE_ID}`,
      params: { tenantId: TENANT, messageId: MESSAGE_ID },
      query: new URLSearchParams(),
      headers: {},
    });

    expect(response.status).toBe(200);
    const body = response.body as MessageDetail;
    expect(body.deliveryEvents).toHaveLength(2);
    expect(body.connectors).toEqual(["Inbound from partner"]);
    expect(body.filtersHit).toEqual(["SpamFilterVerdict: Pass"]);
    expect(body.headers).toEqual([{ name: "Authentication-Results", value: "dkim=pass" }]);
    expect(body.body).toBeNull();
    expect(body.bodyGated).toBe(true);
    expect(body.bodyGateReason.length).toBeGreaterThan(0);
    expect(provider.calls).toEqual([{ tenantId: TENANT, messageId: MESSAGE_ID, includeBody: false }]);
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({
      tenantId: TENANT,
      action: "mail.message.read",
      targetId: MESSAGE_ID,
      includeBody: false,
      bodyGated: true,
    });
  });

  it("returns the body for callers holding Exchange.MailContent.Reveal and audits the read", async () => {
    const provider = new FakeMessagesProvider();
    const audits: MessageReadAuditEvent[] = [];
    const routes = createMessageRoutes({
      provider,
      resolveCaller: contentCaller,
      recordAudit: async (event) => {
        audits.push(event);
      },
    });

    const response = await routes[0]!.handler({
      method: "GET",
      path: `/v1/tenants/${TENANT}/mail/messages/${MESSAGE_ID}`,
      params: { tenantId: TENANT, messageId: MESSAGE_ID },
      query: new URLSearchParams(),
      headers: {},
    });

    expect(response.status).toBe(200);
    const body = response.body as MessageDetail;
    expect(body.body).toBe("<p>Hello</p>");
    expect(body.bodyGated).toBe(false);
    expect(provider.calls).toEqual([{ tenantId: TENANT, messageId: MESSAGE_ID, includeBody: true }]);
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({
      tenantId: TENANT,
      action: "mail.message.read",
      targetId: MESSAGE_ID,
      includeBody: true,
      bodyGated: false,
    });
  });

  it("returns 404 for an unknown message", async () => {
    const provider = new FakeMessagesProvider();
    provider.detail = null;
    const routes = createMessageRoutes({ provider, resolveCaller: readCaller });

    await expect(
      routes[0]!.handler({
        method: "GET",
        path: `/v1/tenants/${TENANT}/mail/messages/missing`,
        params: { tenantId: TENANT, messageId: "missing" },
        query: new URLSearchParams(),
        headers: {},
      }),
    ).rejects.toMatchObject({ status: 404, code: MESSAGE_NOT_FOUND });
  });

  it("grants content access to wildcard callers only", () => {
    expect(
      hasMessageContentAccess({
        tenantScope: tenantScope([TENANT]),
        permissions: [MESSAGES_READ_PERMISSION, MESSAGES_CONTENT_PERMISSION],
      }),
    ).toBe(true);
    expect(
      hasMessageContentAccess({ tenantScope: tenantScope([TENANT]), permissions: ["*"] }),
    ).toBe(true);
    expect(hasMessageContentAccess(readCaller())).toBe(false);
  });

  it("validates tenant and message ids on the helper", async () => {
    const provider = new FakeMessagesProvider();
    await expect(getMessageDetail(provider, " ", MESSAGE_ID, false)).rejects.toMatchObject({
      status: 400,
    });
    await expect(getMessageDetail(provider, TENANT, " ", false)).rejects.toMatchObject({
      status: 400,
    });
  });
});
