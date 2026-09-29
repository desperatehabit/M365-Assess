import { describe, expect, it } from "vitest";
import { AppError } from "../errors.js";
import { tenantScope } from "../rbac/scope.js";
import {
  MAILBOXES_PATH,
  MAILBOXES_READ_PERMISSION,
  MAILBOX_DETAIL_PATH,
  createMailboxRoutes,
  parseMailboxesFilter,
  type MailboxDetail,
  type MailboxItem,
  type MailboxesCaller,
  type MailboxesFilter,
  type MailboxesPage,
  type MailboxesProvider,
} from "./mailboxes.js";

const TENANT = "tenant-test";

const SHARED_MAILBOX: MailboxItem = {
  id: "mbx-1",
  displayName: "Support Desk",
  primarySmtpAddress: "support@example.com",
  type: "shared",
  quotaUsed: "1.2 GB (1288490188 bytes)",
  quotaUsedBytes: 1288490188,
  quotaPercent: 2.4,
  archive: true,
  hold: false,
  forwarding: true,
  forwardingTo: "smtp:cover@example.com",
  deliverToMailboxAndForward: true,
  lastActivity: "2026-09-20T10:00:00.000Z",
};

const USER_MAILBOX: MailboxItem = {
  id: "mbx-2",
  displayName: "Operator One",
  primarySmtpAddress: "operator.one@example.com",
  type: "user",
  quotaUsed: "512 MB (536870912 bytes)",
  quotaUsedBytes: 536870912,
  quotaPercent: 1.0,
  archive: false,
  hold: true,
  forwarding: false,
  forwardingTo: null,
  deliverToMailboxAndForward: false,
  lastActivity: null,
};

const DETAIL: MailboxDetail = {
  tenantId: TENANT,
  mailboxId: "mbx-1",
  settings: SHARED_MAILBOX,
  permissions: [
    {
      permissionType: "FullAccess",
      grantedTo: "operator.one@example.com",
      accessRights: ["FullAccess"],
      automap: true,
      inherited: false,
    },
  ],
  calendarPermissions: [
    { user: "Default", accessRights: ["AvailabilityOnly"] },
  ],
  rules: [
    {
      identity: "rule-1",
      name: "Forward cover",
      enabled: true,
      priority: 0,
      forwardTo: "smtp:cover@example.com",
      forwardAsAttachmentTo: null,
      redirectTo: null,
      deleteMessage: false,
    },
  ],
  retrievedAt: "2026-09-28T00:00:00.000Z",
};

class FakeMailboxesProvider implements MailboxesProvider {
  readonly listCalls: Array<{ tenantId: string; filter: MailboxesFilter }> = [];
  readonly detailCalls: Array<{ tenantId: string; mailboxId: string }> = [];

  async listMailboxes(tenantId: string, filter: MailboxesFilter): Promise<MailboxesPage> {
    this.listCalls.push({ tenantId, filter });
    return {
      tenantId,
      totalCount: 2,
      items: [SHARED_MAILBOX, USER_MAILBOX],
      nextCursor: null,
    };
  }

  async getMailbox(tenantId: string, mailboxId: string): Promise<MailboxDetail | null> {
    this.detailCalls.push({ tenantId, mailboxId });
    return mailboxId === DETAIL.mailboxId ? DETAIL : null;
  }
}

describe("Mailbox list and detail routes (T-0381)", () => {
  it("exposes GET /v1/tenants/:tenantId/mailboxes and the detail path", () => {
    const routes = createMailboxRoutes({
      provider: new FakeMailboxesProvider(),
      resolveCaller: () => ({
        tenantScope: tenantScope([TENANT]),
        permissions: [MAILBOXES_READ_PERMISSION],
      }),
    });
    expect(routes.map((route) => `${route.method} ${route.path}`)).toEqual([
      `GET ${MAILBOXES_PATH}`,
      `GET ${MAILBOX_DETAIL_PATH}`,
    ]);
  });

  it("rejects unauthenticated requests with 401", async () => {
    const routes = createMailboxRoutes({
      provider: new FakeMailboxesProvider(),
      resolveCaller: () => undefined,
    });

    await expect(
      routes[0]!.handler({
        method: "GET",
        path: `/v1/tenants/${TENANT}/mailboxes`,
        params: { tenantId: TENANT },
        query: new URLSearchParams(),
        headers: {},
      }),
    ).rejects.toMatchObject({ status: 401 });
  });

  it("rejects tenant outside caller scope with 403", async () => {
    const routes = createMailboxRoutes({
      provider: new FakeMailboxesProvider(),
      resolveCaller: () => ({
        tenantScope: tenantScope(["different-tenant"]),
        permissions: [MAILBOXES_READ_PERMISSION],
      }),
    });

    await expect(
      routes[0]!.handler({
        method: "GET",
        path: `/v1/tenants/${TENANT}/mailboxes`,
        params: { tenantId: TENANT },
        query: new URLSearchParams(),
        headers: {},
      }),
    ).rejects.toMatchObject({ status: 403 });
  });

  it("rejects callers missing mailboxes.read with 403", async () => {
    const routes = createMailboxRoutes({
      provider: new FakeMailboxesProvider(),
      resolveCaller: () => ({
        tenantScope: tenantScope([TENANT]),
        permissions: ["Identity.User.Read"],
      }),
    });

    await expect(
      routes[1]!.handler({
        method: "GET",
        path: `/v1/tenants/${TENANT}/mailboxes/mbx-1`,
        params: { tenantId: TENANT, mailboxId: "mbx-1" },
        query: new URLSearchParams(),
        headers: {},
      }),
    ).rejects.toMatchObject({ status: 403 });
  });

  it("returns filtered, cursor-paginated rows with the §3.1 columns", async () => {
    const provider = new FakeMailboxesProvider();
    const caller: MailboxesCaller = {
      tenantScope: tenantScope([TENANT]),
      permissions: [MAILBOXES_READ_PERMISSION],
    };
    const routes = createMailboxRoutes({ provider, resolveCaller: () => caller });

    const response = await routes[0]!.handler({
      method: "GET",
      path: `/v1/tenants/${TENANT}/mailboxes`,
      params: { tenantId: TENANT },
      query: new URLSearchParams("type=shared&forwarding=true&archive=true&search=support"),
      headers: {},
    });

    expect(response.status).toBe(200);
    const body = response.body as MailboxesPage;
    expect(body.tenantId).toBe(TENANT);
    expect(body.items).toHaveLength(2);
    expect(body.items[0]).toMatchObject({
      displayName: "Support Desk",
      primarySmtpAddress: "support@example.com",
      type: "shared",
      quotaUsed: "1.2 GB (1288490188 bytes)",
      archive: true,
      hold: false,
      forwarding: true,
      lastActivity: "2026-09-20T10:00:00.000Z",
    });

    expect(provider.listCalls).toHaveLength(1);
    expect(provider.listCalls[0]?.filter.type).toBe("shared");
    expect(provider.listCalls[0]?.filter.forwarding).toBe(true);
    expect(provider.listCalls[0]?.filter.archive).toBe(true);
    expect(provider.listCalls[0]?.filter.search).toBe("support");
  });

  it("returns the off-canvas detail settings, permissions, and rules", async () => {
    const provider = new FakeMailboxesProvider();
    const caller: MailboxesCaller = {
      tenantScope: tenantScope([TENANT]),
      permissions: [MAILBOXES_READ_PERMISSION],
    };
    const routes = createMailboxRoutes({ provider, resolveCaller: () => caller });

    const response = await routes[1]!.handler({
      method: "GET",
      path: `/v1/tenants/${TENANT}/mailboxes/mbx-1`,
      params: { tenantId: TENANT, mailboxId: "mbx-1" },
      query: new URLSearchParams(),
      headers: {},
    });

    expect(response.status).toBe(200);
    const body = response.body as MailboxDetail;
    expect(body.mailboxId).toBe("mbx-1");
    expect(body.settings.primarySmtpAddress).toBe("support@example.com");
    expect(body.permissions).toHaveLength(1);
    expect(body.permissions[0]?.permissionType).toBe("FullAccess");
    expect(body.calendarPermissions).toHaveLength(1);
    expect(body.rules).toHaveLength(1);
    expect(body.rules[0]?.name).toBe("Forward cover");
    expect(provider.detailCalls[0]).toEqual({ tenantId: TENANT, mailboxId: "mbx-1" });
  });

  it("returns 404 for an unknown mailbox", async () => {
    const caller: MailboxesCaller = {
      tenantScope: tenantScope([TENANT]),
      permissions: [MAILBOXES_READ_PERMISSION],
    };
    const routes = createMailboxRoutes({
      provider: new FakeMailboxesProvider(),
      resolveCaller: () => caller,
    });

    await expect(
      routes[1]!.handler({
        method: "GET",
        path: `/v1/tenants/${TENANT}/mailboxes/missing`,
        params: { tenantId: TENANT, mailboxId: "missing" },
        query: new URLSearchParams(),
        headers: {},
      }),
    ).rejects.toMatchObject({ status: 404 });
  });

  it("validates the §3.1 filter parameters", () => {
    expect(() => parseMailboxesFilter(new URLSearchParams("type=notAType"))).toThrow(AppError);
    expect(() => parseMailboxesFilter(new URLSearchParams("hold=maybe"))).toThrow(AppError);
    expect(() => parseMailboxesFilter(new URLSearchParams("quotaPercent=101"))).toThrow(AppError);
    expect(() => parseMailboxesFilter(new URLSearchParams("inactiveDays=0"))).toThrow(AppError);
  });
});
