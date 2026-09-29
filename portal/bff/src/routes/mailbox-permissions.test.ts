import { describe, expect, it } from "vitest";
import { tenantScope } from "../rbac/scope.js";
import { MAILBOXES_READ_PERMISSION } from "./mailboxes.js";
import {
  MAILBOX_PERMISSIONS_PATH,
  MAILBOX_PERMISSIONS_WRITE_PERMISSION,
  createMailboxPermissionRoutes,
  type GrantMailboxPermissionInput,
  type MailboxPermissionPlan,
  type MailboxPermissionResult,
  type MailboxPermissionsCaller,
  type MailboxPermissionsList,
  type MailboxPermissionsProvider,
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

  it("rejects callers missing mailboxes.permissions with 403", async () => {
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
