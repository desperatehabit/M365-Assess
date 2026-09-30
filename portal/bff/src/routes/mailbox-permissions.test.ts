import { describe, expect, it } from "vitest";
import { tenantScope } from "../rbac/scope.js";
import { MAILBOXES_READ_PERMISSION } from "./mailboxes.js";
import {
  MAILBOX_PERMISSIONS_OPENAPI,
  MAILBOX_PERMISSIONS_PATH,
  MAILBOX_PERMISSIONS_REPORT_OPENAPI,
  MAILBOX_PERMISSIONS_REPORT_PATH,
  MAILBOX_PERMISSIONS_WRITE_PERMISSION,
  SHARING_READ_PERMISSION,
  createMailboxPermissionRoutes,
  createMailboxPermissionsReportRoute,
  parseMailboxPermissionReportFilter,
  type GrantMailboxPermissionInput,
  type MailboxPermissionPlan,
  type MailboxPermissionReportEntry,
  type MailboxPermissionReportFilter,
  type MailboxPermissionResult,
  type MailboxPermissionsCaller,
  type MailboxPermissionsList,
  type MailboxPermissionsProvider,
  type MailboxPermissionsReportPage,
  type MailboxPermissionsReportProvider,
  type RemoveMailboxPermissionInput,
} from "./mailbox-permissions.js";

const TENANT = "tenant-test";
const MAILBOX = "mbx-1";

const LIST: MailboxPermissionsList = {
  tenantId: TENANT,
  mailboxId: MAILBOX,
  permissions: [
    {
      scope: "mailbox",
      permissionType: "FullAccess",
      principal: "delegate@example.invalid",
      accessRights: ["FullAccess"],
      automap: true,
      inherited: false,
    },
  ],
  calendarPermissions: [
    {
      scope: "calendar",
      permissionType: "Calendar",
      principal: "reviewer@example.invalid",
      accessRights: ["Reviewer"],
      automap: false,
      inherited: false,
    },
  ],
  retrievedAt: "2026-09-28T00:00:00.000Z",
};

const GRANT_PLAN: MailboxPermissionPlan = {
  action: "add",
  mailboxId: MAILBOX,
  scope: "mailbox",
  principal: "delegate@example.invalid",
  permissionType: "FullAccess",
  before: null,
  after: {
    principal: "delegate@example.invalid",
    permissionType: "FullAccess",
    accessRights: ["FullAccess"],
    automap: true,
  },
  diff: ["Grant FullAccess on mailbox 'mbx-1' to 'delegate@example.invalid'"],
  valid: true,
  dryRun: true,
  requiresConfirmation: false,
};

const GRANT_RESULT: MailboxPermissionResult = {
  success: true,
  plan: { ...GRANT_PLAN, dryRun: false },
  result: { principal: "delegate@example.invalid", permissionType: "FullAccess" },
  auditEvent: {
    id: "audit-grant",
    tenantId: TENANT,
    action: "mailbox.permission.grant",
    targetId: MAILBOX,
    targetName: MAILBOX,
    timestamp: "2026-09-28T00:00:00.000Z",
    before: null,
    after: { principal: "delegate@example.invalid", permissionType: "FullAccess" },
  },
};

const REMOVE_RESULT: MailboxPermissionResult = {
  success: true,
  plan: {
    action: "remove",
    mailboxId: MAILBOX,
    scope: "mailbox",
    principal: "delegate@example.invalid",
    permissionType: "FullAccess",
    before: { principal: "delegate@example.invalid", permissionType: "FullAccess" },
    after: null,
    diff: ["Remove FullAccess on mailbox 'mbx-1' from 'delegate@example.invalid'"],
    valid: true,
    dryRun: false,
    requiresConfirmation: false,
  },
  result: { removed: true },
  auditEvent: {
    id: "audit-remove",
    tenantId: TENANT,
    action: "mailbox.permission.remove",
    targetId: MAILBOX,
    targetName: MAILBOX,
    timestamp: "2026-09-28T00:00:00.000Z",
    before: { principal: "delegate@example.invalid", permissionType: "FullAccess" },
    after: null,
  },
};

class FakeMailboxPermissionsProvider implements MailboxPermissionsProvider {
  readonly grantCalls: Array<{ tenantId: string; mailboxId: string; input: GrantMailboxPermissionInput; preview: boolean }> = [];
  readonly removeCalls: Array<{ tenantId: string; mailboxId: string; input: RemoveMailboxPermissionInput; preview: boolean }> = [];

  async listPermissions(tenantId: string, mailboxId: string): Promise<MailboxPermissionsList> {
    return { ...LIST, tenantId, mailboxId };
  }

  async grantPermission(
    tenantId: string,
    mailboxId: string,
    input: GrantMailboxPermissionInput,
    preview: boolean,
  ): Promise<MailboxPermissionResult | MailboxPermissionPlan> {
    this.grantCalls.push({ tenantId, mailboxId, input, preview });
    return preview ? GRANT_PLAN : GRANT_RESULT;
  }

  async removePermission(
    tenantId: string,
    mailboxId: string,
    input: RemoveMailboxPermissionInput,
    preview: boolean,
  ): Promise<MailboxPermissionResult | MailboxPermissionPlan> {
    this.removeCalls.push({ tenantId, mailboxId, input, preview });
    return preview
      ? { ...REMOVE_RESULT.plan, dryRun: true }
      : REMOVE_RESULT;
  }
}

function readerCaller(): MailboxPermissionsCaller {
  return {
    tenantScope: tenantScope([TENANT]),
    permissions: [MAILBOXES_READ_PERMISSION],
  };
}

function writerCaller(): MailboxPermissionsCaller {
  return {
    tenantScope: tenantScope([TENANT]),
    permissions: [MAILBOX_PERMISSIONS_WRITE_PERMISSION],
  };
}

describe("Mailbox permission routes (T-0384)", () => {
  it("exposes GET, POST, and DELETE on the permissions path", () => {
    const routes = createMailboxPermissionRoutes({
      provider: new FakeMailboxPermissionsProvider(),
      resolveCaller: readerCaller,
    });
    expect(routes.map((route) => `${route.method} ${route.path}`)).toEqual([
      `GET ${MAILBOX_PERMISSIONS_PATH}`,
      `POST ${MAILBOX_PERMISSIONS_PATH}`,
      `DELETE ${MAILBOX_PERMISSIONS_PATH}`,
    ]);
  });

  it("lists mailbox and calendar permissions with principal, access rights, automap, and inherited", async () => {
    const routes = createMailboxPermissionRoutes({
      provider: new FakeMailboxPermissionsProvider(),
      resolveCaller: readerCaller,
    });

    const response = await routes[0]!.handler({
      method: "GET",
      path: `/v1/tenants/${TENANT}/mailboxes/${MAILBOX}/permissions`,
      params: { tenantId: TENANT, mailboxId: MAILBOX },
      query: new URLSearchParams(),
      headers: {},
    });

    expect(response.status).toBe(200);
    const body = response.body as MailboxPermissionsList;
    expect(body.permissions[0]).toMatchObject({
      principal: "delegate@example.invalid",
      accessRights: ["FullAccess"],
      automap: true,
      inherited: false,
    });
    expect(body.calendarPermissions[0]).toMatchObject({
      principal: "reviewer@example.invalid",
      accessRights: ["Reviewer"],
    });
  });

  it("rejects unauthenticated requests with 401", async () => {
    const routes = createMailboxPermissionRoutes({
      provider: new FakeMailboxPermissionsProvider(),
      resolveCaller: () => undefined,
    });

    await expect(
      routes[0]!.handler({
        method: "GET",
        path: `/v1/tenants/${TENANT}/mailboxes/${MAILBOX}/permissions`,
        params: { tenantId: TENANT, mailboxId: MAILBOX },
        query: new URLSearchParams(),
        headers: {},
      }),
    ).rejects.toMatchObject({ status: 401 });
  });

  it("rejects tenant outside caller scope with 403", async () => {
    const routes = createMailboxPermissionRoutes({
      provider: new FakeMailboxPermissionsProvider(),
      resolveCaller: () => ({
        tenantScope: tenantScope(["different-tenant"]),
        permissions: [MAILBOX_PERMISSIONS_WRITE_PERMISSION],
      }),
    });

    await expect(
      routes[1]!.handler({
        method: "POST",
        path: `/v1/tenants/${TENANT}/mailboxes/${MAILBOX}/permissions`,
        params: { tenantId: TENANT, mailboxId: MAILBOX },
        query: new URLSearchParams(),
        headers: {},
        body: { principal: "delegate@example.invalid", permissionType: "FullAccess" },
      }),
    ).rejects.toMatchObject({ status: 403 });
  });

  it("rejects callers missing Mailboxes.Permission.ReadWrite with 403", async () => {
    const routes = createMailboxPermissionRoutes({
      provider: new FakeMailboxPermissionsProvider(),
      resolveCaller: () => ({
        tenantScope: tenantScope([TENANT]),
        permissions: [MAILBOXES_READ_PERMISSION],
      }),
    });

    await expect(
      routes[2]!.handler({
        method: "DELETE",
        path: `/v1/tenants/${TENANT}/mailboxes/${MAILBOX}/permissions`,
        params: { tenantId: TENANT, mailboxId: MAILBOX },
        query: new URLSearchParams(),
        headers: {},
        body: { principal: "delegate@example.invalid", permissionType: "FullAccess" },
      }),
    ).rejects.toMatchObject({ status: 403 });
  });

  it("returns a plan preview for a grant when preview is requested", async () => {
    const provider = new FakeMailboxPermissionsProvider();
    const routes = createMailboxPermissionRoutes({ provider, resolveCaller: writerCaller });

    const response = await routes[1]!.handler({
      method: "POST",
      path: `/v1/tenants/${TENANT}/mailboxes/${MAILBOX}/permissions`,
      params: { tenantId: TENANT, mailboxId: MAILBOX },
      query: new URLSearchParams(),
      headers: {},
      body: { principal: "delegate@example.invalid", permissionType: "FullAccess", preview: true },
    });

    expect(response.status).toBe(200);
    const body = response.body as MailboxPermissionPlan;
    expect(body.dryRun).toBe(true);
    expect(body.diff).toHaveLength(1);
    expect(provider.grantCalls[0]).toMatchObject({ tenantId: TENANT, mailboxId: MAILBOX, preview: true });
  });

  it("applies a grant with before/after and an audit event", async () => {
    const provider = new FakeMailboxPermissionsProvider();
    const routes = createMailboxPermissionRoutes({ provider, resolveCaller: writerCaller });

    const response = await routes[1]!.handler({
      method: "POST",
      path: `/v1/tenants/${TENANT}/mailboxes/${MAILBOX}/permissions`,
      params: { tenantId: TENANT, mailboxId: MAILBOX },
      query: new URLSearchParams(),
      headers: {},
      body: { action: "edit", principal: "delegate@example.invalid", permissionType: "SendAs" },
    });

    expect(response.status).toBe(200);
    const body = response.body as MailboxPermissionResult;
    expect(body.success).toBe(true);
    expect(body.plan.before).toBeNull();
    expect(body.auditEvent?.action).toBe("mailbox.permission.grant");
    expect(body.auditEvent?.after).toMatchObject({ permissionType: "FullAccess" });
    expect(provider.grantCalls[0]?.input.action).toBe("edit");
    expect(provider.grantCalls[0]).toMatchObject({ preview: false });
  });

  it("rejects a grant without a principal with 400", async () => {
    const routes = createMailboxPermissionRoutes({
      provider: new FakeMailboxPermissionsProvider(),
      resolveCaller: writerCaller,
    });

    await expect(
      routes[1]!.handler({
        method: "POST",
        path: `/v1/tenants/${TENANT}/mailboxes/${MAILBOX}/permissions`,
        params: { tenantId: TENANT, mailboxId: MAILBOX },
        query: new URLSearchParams(),
        headers: {},
        body: { permissionType: "FullAccess" },
      }),
    ).rejects.toMatchObject({ status: 400 });
  });

  it("rejects a calendar grant without access rights with 400", async () => {
    const routes = createMailboxPermissionRoutes({
      provider: new FakeMailboxPermissionsProvider(),
      resolveCaller: writerCaller,
    });

    await expect(
      routes[1]!.handler({
        method: "POST",
        path: `/v1/tenants/${TENANT}/mailboxes/${MAILBOX}/permissions`,
        params: { tenantId: TENANT, mailboxId: MAILBOX },
        query: new URLSearchParams(),
        headers: {},
        body: { scope: "calendar", principal: "reviewer@example.invalid" },
      }),
    ).rejects.toMatchObject({ status: 400 });
  });

  it("applies a removal with before/after and an audit event", async () => {
    const provider = new FakeMailboxPermissionsProvider();
    const routes = createMailboxPermissionRoutes({ provider, resolveCaller: writerCaller });

    const response = await routes[2]!.handler({
      method: "DELETE",
      path: `/v1/tenants/${TENANT}/mailboxes/${MAILBOX}/permissions`,
      params: { tenantId: TENANT, mailboxId: MAILBOX },
      query: new URLSearchParams(),
      headers: {},
      body: { principal: "delegate@example.invalid", permissionType: "FullAccess" },
    });

    expect(response.status).toBe(200);
    const body = response.body as MailboxPermissionResult;
    expect(body.success).toBe(true);
    expect(body.plan.before).toMatchObject({ principal: "delegate@example.invalid" });
    expect(body.plan.after).toBeNull();
    expect(body.auditEvent?.action).toBe("mailbox.permission.remove");
    expect(provider.removeCalls[0]).toMatchObject({
      tenantId: TENANT,
      mailboxId: MAILBOX,
      preview: false,
    });
  });
});

const REPORT_ENTRIES: readonly MailboxPermissionReportEntry[] = [
  {
    mailboxId: "mbx-1",
    mailboxDisplayName: "Support Desk",
    mailboxPrimarySmtp: "support@example.invalid",
    scope: "mailbox",
    permissionType: "FullAccess",
    principal: "delegate@example.invalid",
    accessRights: ["FullAccess"],
    automap: true,
    inherited: false,
  },
  {
    mailboxId: "mbx-1",
    mailboxDisplayName: "Support Desk",
    mailboxPrimarySmtp: "support@example.invalid",
    scope: "calendar",
    permissionType: "Calendar",
    principal: "reviewer@example.invalid",
    accessRights: ["Reviewer"],
    automap: false,
    inherited: false,
  },
];

const REPORT_PAGE: MailboxPermissionsReportPage = {
  tenantId: TENANT,
  items: [...REPORT_ENTRIES],
  nextCursor: null,
  totalCount: REPORT_ENTRIES.length,
  retrievedAt: "2026-09-28T00:00:00.000Z",
};

class FakeMailboxPermissionsReportProvider implements MailboxPermissionsReportProvider {
  readonly calls: Array<{ tenantId: string; filter: MailboxPermissionReportFilter }> = [];

  async listMailboxPermissions(tenantId: string, filter: MailboxPermissionReportFilter): Promise<MailboxPermissionsReportPage> {
    this.calls.push({ tenantId, filter });
    return { ...REPORT_PAGE, tenantId };
  }
}

function sharingReaderCaller(): MailboxPermissionsCaller {
  return {
    tenantScope: tenantScope([TENANT]),
    permissions: [SHARING_READ_PERMISSION],
  };
}

describe("Mailbox permissions report route (T-0529)", () => {
  it("exposes GET /v1/tenants/:tenantId/mailbox-permissions", () => {
    const route = createMailboxPermissionsReportRoute({
      provider: new FakeMailboxPermissionsReportProvider(),
      resolveCaller: sharingReaderCaller,
    });
    expect(route.method).toBe("GET");
    expect(route.path).toBe(MAILBOX_PERMISSIONS_REPORT_PATH);
  });

  it("lists mailbox and calendar permissions through the provider seam", async () => {
    const provider = new FakeMailboxPermissionsReportProvider();
    const route = createMailboxPermissionsReportRoute({ provider, resolveCaller: sharingReaderCaller });

    const response = await route.handler({
      method: "GET",
      path: `/v1/tenants/${TENANT}/mailbox-permissions`,
      params: { tenantId: TENANT },
      query: new URLSearchParams(),
      headers: {},
    });

    expect(response.status).toBe(200);
    const body = response.body as MailboxPermissionsReportPage;
    expect(body.tenantId).toBe(TENANT);
    expect(body.items).toHaveLength(2);
    expect(body.items[0]).toMatchObject({
      mailboxId: "mbx-1",
      scope: "mailbox",
      permissionType: "FullAccess",
      principal: "delegate@example.invalid",
      accessRights: ["FullAccess"],
      automap: true,
      inherited: false,
    });
    expect(body.items[1]).toMatchObject({
      scope: "calendar",
      permissionType: "Calendar",
      principal: "reviewer@example.invalid",
      accessRights: ["Reviewer"],
    });
    expect(provider.calls[0]).toMatchObject({ tenantId: TENANT, filter: { cursor: null, limit: 100 } });
  });

  it("passes the scope filter through to the provider", async () => {
    const provider = new FakeMailboxPermissionsReportProvider();
    const route = createMailboxPermissionsReportRoute({ provider, resolveCaller: sharingReaderCaller });

    const response = await route.handler({
      method: "GET",
      path: `/v1/tenants/${TENANT}/mailbox-permissions`,
      params: { tenantId: TENANT },
      query: new URLSearchParams("scope=calendar"),
      headers: {},
    });

    expect(response.status).toBe(200);
    expect(provider.calls[0]?.filter.scope).toBe("calendar");
  });

  it("rejects unauthenticated requests with 401", async () => {
    const route = createMailboxPermissionsReportRoute({
      provider: new FakeMailboxPermissionsReportProvider(),
      resolveCaller: () => undefined,
    });

    await expect(
      route.handler({
        method: "GET",
        path: `/v1/tenants/${TENANT}/mailbox-permissions`,
        params: { tenantId: TENANT },
        query: new URLSearchParams(),
        headers: {},
      }),
    ).rejects.toMatchObject({ status: 401 });
  });

  it("rejects tenant outside caller scope with 403", async () => {
    const route = createMailboxPermissionsReportRoute({
      provider: new FakeMailboxPermissionsReportProvider(),
      resolveCaller: () => ({
        tenantScope: tenantScope(["different-tenant"]),
        permissions: [SHARING_READ_PERMISSION],
      }),
    });

    await expect(
      route.handler({
        method: "GET",
        path: `/v1/tenants/${TENANT}/mailbox-permissions`,
        params: { tenantId: TENANT },
        query: new URLSearchParams(),
        headers: {},
      }),
    ).rejects.toMatchObject({ status: 403 });
  });

  it("rejects callers missing sharing.read with 403", async () => {
    const route = createMailboxPermissionsReportRoute({
      provider: new FakeMailboxPermissionsReportProvider(),
      resolveCaller: () => ({
        tenantScope: tenantScope([TENANT]),
        permissions: [MAILBOXES_READ_PERMISSION],
      }),
    });

    await expect(
      route.handler({
        method: "GET",
        path: `/v1/tenants/${TENANT}/mailbox-permissions`,
        params: { tenantId: TENANT },
        query: new URLSearchParams(),
        headers: {},
      }),
    ).rejects.toMatchObject({ status: 403 });
  });

  it("rejects an unsupported scope value with 400", async () => {
    const route = createMailboxPermissionsReportRoute({
      provider: new FakeMailboxPermissionsReportProvider(),
      resolveCaller: sharingReaderCaller,
    });

    await expect(
      route.handler({
        method: "GET",
        path: `/v1/tenants/${TENANT}/mailbox-permissions`,
        params: { tenantId: TENANT },
        query: new URLSearchParams("scope=direct"),
        headers: {},
      }),
    ).rejects.toMatchObject({ status: 400 });
  });

  it("publishes the report path item with the sharing.read permission", () => {
    expect(MAILBOX_PERMISSIONS_REPORT_OPENAPI.paths["/tenants/{tenantId}/mailbox-permissions"].get.permission).toBe(
      "sharing.read",
    );
  });

  it("publishes a report operationId distinct from the mailbox-level permission route", () => {
    const report = MAILBOX_PERMISSIONS_REPORT_OPENAPI.paths["/tenants/{tenantId}/mailbox-permissions"].get.operationId;
    const mailbox = MAILBOX_PERMISSIONS_OPENAPI.paths["/tenants/{tenantId}/mailboxes/{mailboxId}/permissions"].get
      .operationId;
    expect(report).toBe("listMailboxPermissionsReport");
    expect(report).not.toBe(mailbox);
  });
});

describe("Mailbox permissions report filter (T-0529)", () => {
  it("parses scope, search, and pagination", () => {
    const filter = parseMailboxPermissionReportFilter(new URLSearchParams("scope=mailbox&search=delegate&cursor=MTAw&limit=25"));
    expect(filter).toEqual({ scope: "mailbox", search: "delegate", cursor: "MTAw", limit: 25 });
  });

  it("defaults to no scope, no search, and the default page limit", () => {
    const filter = parseMailboxPermissionReportFilter(new URLSearchParams());
    expect(filter).toEqual({ scope: undefined, search: undefined, cursor: null, limit: 100 });
  });
});
