import { describe, expect, it } from "vitest";
import { AppError } from "../errors.js";
import { tenantScope } from "../rbac/scope.js";
import {
  DELETED_MAILBOX_CONFIRM_REQUIRED,
  DELETED_MAILBOXES_PATH,
  DELETED_MAILBOXES_READ_PERMISSION,
  DELETED_MAILBOXES_WRITE_PERMISSION,
  DELETED_MAILBOX_NOT_SOFT_DELETED,
  DELETED_MAILBOX_RESTORE_PATH,
  createDeletedMailboxRoutes,
  notSoftDeletedError,
  parseDeletedMailboxesFilter,
  type DeletedMailboxItem,
  type DeletedMailboxRestorePlan,
  type DeletedMailboxRestoreResult,
  type DeletedMailboxesCaller,
  type DeletedMailboxesFilter,
  type DeletedMailboxesPage,
  type DeletedMailboxesProvider,
  type DeletedMailboxRestoreAuditEvent,
  type RestoreDeletedMailboxInput,
} from "./deleted-mailboxes.js";

const TENANT = "tenant-test";

const DELETED_ONE: DeletedMailboxItem = {
  id: "mbx-deleted-1",
  displayName: "Departed Operator",
  primarySmtpAddress: "departed.operator@example.com",
  mailboxType: "UserMailbox",
  deletedAt: "2026-09-10T12:00:00.000Z",
  daysUntilPurge: 12,
};

const DELETED_TWO: DeletedMailboxItem = {
  id: "mbx-deleted-2",
  displayName: "Old Shared",
  primarySmtpAddress: "old.shared@example.com",
  mailboxType: "SharedMailbox",
  deletedAt: "2026-09-20T08:30:00.000Z",
  daysUntilPurge: 22,
};

const RESTORE_PLAN: DeletedMailboxRestorePlan = {
  action: "restore",
  mailboxId: DELETED_ONE.id,
  targetName: "Departed Operator",
  before: { id: DELETED_ONE.id, state: "softDeleted" },
  after: { id: DELETED_ONE.id, state: "active" },
  diff: ["Restore soft-deleted mailbox 'Departed Operator' (mbx-deleted-1)"],
  valid: true,
  dryRun: true,
  requiresConfirmation: true,
};

const RESTORE_RESULT: DeletedMailboxRestoreResult = {
  success: true,
  plan: { ...RESTORE_PLAN, dryRun: false, requiresConfirmation: false },
  result: { id: DELETED_ONE.id, state: "active" },
  auditEvent: {
    id: "audit-restore-1",
    tenantId: TENANT,
    action: "mailbox.restore",
    targetId: DELETED_ONE.id,
    targetName: "Departed Operator",
    timestamp: "2026-09-28T00:00:00.000Z",
    before: { id: DELETED_ONE.id, state: "softDeleted" },
    after: { id: DELETED_ONE.id, state: "active" },
  },
};

class FakeDeletedMailboxesProvider implements DeletedMailboxesProvider {
  readonly listCalls: Array<{ tenantId: string; filter: DeletedMailboxesFilter }> = [];
  readonly restoreCalls: Array<{
    tenantId: string;
    mailboxId: string;
    input: RestoreDeletedMailboxInput;
    preview: boolean;
  }> = [];
  restoreOutcome: DeletedMailboxRestoreResult = RESTORE_RESULT;
  restoreError: unknown = undefined;

  async listDeletedMailboxes(
    tenantId: string,
    filter: DeletedMailboxesFilter,
  ): Promise<DeletedMailboxesPage> {
    this.listCalls.push({ tenantId, filter });
    return {
      tenantId,
      totalCount: 2,
      items: [DELETED_ONE, DELETED_TWO],
      nextCursor: null,
    };
  }

  async restoreMailbox(
    tenantId: string,
    mailboxId: string,
    input: RestoreDeletedMailboxInput,
    preview: boolean,
  ): Promise<DeletedMailboxRestoreResult | DeletedMailboxRestorePlan> {
    this.restoreCalls.push({ tenantId, mailboxId, input, preview });
    if (this.restoreError !== undefined) {
      throw this.restoreError;
    }
    return preview ? RESTORE_PLAN : this.restoreOutcome;
  }
}

function readCaller(): DeletedMailboxesCaller {
  return {
    tenantScope: tenantScope([TENANT]),
    permissions: [DELETED_MAILBOXES_READ_PERMISSION, DELETED_MAILBOXES_WRITE_PERMISSION],
  };
}

describe("Soft-deleted mailbox view and restore routes (T-0388)", () => {
  it("exposes GET deleted-mailboxes and POST restore paths", () => {
    const routes = createDeletedMailboxRoutes({
      provider: new FakeDeletedMailboxesProvider(),
      resolveCaller: readCaller,
    });
    expect(routes.map((route) => `${route.method} ${route.path}`)).toEqual([
      `GET ${DELETED_MAILBOXES_PATH}`,
      `POST ${DELETED_MAILBOX_RESTORE_PATH}`,
    ]);
  });

  it("rejects unauthenticated requests with 401", async () => {
    const routes = createDeletedMailboxRoutes({
      provider: new FakeDeletedMailboxesProvider(),
      resolveCaller: () => undefined,
    });

    await expect(
      routes[0]!.handler({
        method: "GET",
        path: `/v1/tenants/${TENANT}/deleted-mailboxes`,
        params: { tenantId: TENANT },
        query: new URLSearchParams(),
        headers: {},
      }),
    ).rejects.toMatchObject({ status: 401 });
  });

  it("rejects tenant outside caller scope with 403", async () => {
    const routes = createDeletedMailboxRoutes({
      provider: new FakeDeletedMailboxesProvider(),
      resolveCaller: () => ({
        tenantScope: tenantScope(["different-tenant"]),
        permissions: [DELETED_MAILBOXES_READ_PERMISSION],
      }),
    });

    await expect(
      routes[0]!.handler({
        method: "GET",
        path: `/v1/tenants/${TENANT}/deleted-mailboxes`,
        params: { tenantId: TENANT },
        query: new URLSearchParams(),
        headers: {},
      }),
    ).rejects.toMatchObject({ status: 403 });
  });

  it("rejects list callers missing mailboxes.read with 403", async () => {
    const routes = createDeletedMailboxRoutes({
      provider: new FakeDeletedMailboxesProvider(),
      resolveCaller: () => ({
        tenantScope: tenantScope([TENANT]),
        permissions: ["Identity.User.Read"],
      }),
    });

    await expect(
      routes[0]!.handler({
        method: "GET",
        path: `/v1/tenants/${TENANT}/deleted-mailboxes`,
        params: { tenantId: TENANT },
        query: new URLSearchParams(),
        headers: {},
      }),
    ).rejects.toMatchObject({ status: 403 });
  });

  it("rejects restore callers missing mailboxes.write with 403", async () => {
    const routes = createDeletedMailboxRoutes({
      provider: new FakeDeletedMailboxesProvider(),
      resolveCaller: () => ({
        tenantScope: tenantScope([TENANT]),
        permissions: [DELETED_MAILBOXES_READ_PERMISSION],
      }),
    });

    await expect(
      routes[1]!.handler({
        method: "POST",
        path: `/v1/tenants/${TENANT}/deleted-mailboxes/mbx-deleted-1/restore`,
        params: { tenantId: TENANT, mailboxId: "mbx-deleted-1" },
        query: new URLSearchParams(),
        headers: {},
        body: { confirm: true },
      }),
    ).rejects.toMatchObject({ status: 403 });
  });

  it("lists soft-deleted mailboxes with identity and deletion metadata", async () => {
    const provider = new FakeDeletedMailboxesProvider();
    const routes = createDeletedMailboxRoutes({ provider, resolveCaller: readCaller });

    const response = await routes[0]!.handler({
      method: "GET",
      path: `/v1/tenants/${TENANT}/deleted-mailboxes`,
      params: { tenantId: TENANT },
      query: new URLSearchParams("search=departed"),
      headers: {},
    });

    expect(response.status).toBe(200);
    const body = response.body as DeletedMailboxesPage;
    expect(body.tenantId).toBe(TENANT);
    expect(body.items).toHaveLength(2);
    expect(body.items[0]).toMatchObject({
      id: "mbx-deleted-1",
      displayName: "Departed Operator",
      primarySmtpAddress: "departed.operator@example.com",
      mailboxType: "UserMailbox",
      deletedAt: "2026-09-10T12:00:00.000Z",
      daysUntilPurge: 12,
    });
    expect(provider.listCalls).toHaveLength(1);
    expect(provider.listCalls[0]).toMatchObject({
      tenantId: TENANT,
      filter: expect.objectContaining({ search: "departed" }),
    });
  });

  it("returns a plan preview for restore when preview is requested", async () => {
    const provider = new FakeDeletedMailboxesProvider();
    const routes = createDeletedMailboxRoutes({ provider, resolveCaller: readCaller });

    const response = await routes[1]!.handler({
      method: "POST",
      path: `/v1/tenants/${TENANT}/deleted-mailboxes/mbx-deleted-1/restore`,
      params: { tenantId: TENANT, mailboxId: "mbx-deleted-1" },
      query: new URLSearchParams(),
      headers: {},
      body: { preview: true },
    });

    expect(response.status).toBe(200);
    const body = response.body as DeletedMailboxRestorePlan;
    expect(body.action).toBe("restore");
    expect(body.dryRun).toBe(true);
    expect(body.diff).toHaveLength(1);
    expect(provider.restoreCalls[0]).toMatchObject({
      tenantId: TENANT,
      mailboxId: "mbx-deleted-1",
      preview: true,
    });
  });

  it("applies restore with confirmation, before/after, and an audit event", async () => {
    const provider = new FakeDeletedMailboxesProvider();
    const audits: DeletedMailboxRestoreAuditEvent[] = [];
    const routes = createDeletedMailboxRoutes({
      provider,
      resolveCaller: readCaller,
      recordAudit: async (event) => {
        audits.push(event);
      },
    });

    const response = await routes[1]!.handler({
      method: "POST",
      path: `/v1/tenants/${TENANT}/deleted-mailboxes/mbx-deleted-1/restore`,
      params: { tenantId: TENANT, mailboxId: "mbx-deleted-1" },
      query: new URLSearchParams(),
      headers: {},
      body: { confirm: true },
    });

    expect(response.status).toBe(200);
    const body = response.body as DeletedMailboxRestoreResult;
    expect(body.success).toBe(true);
    expect(body.plan.before).toMatchObject({ state: "softDeleted" });
    expect(body.plan.after).toMatchObject({ state: "active" });
    expect(body.auditEvent?.action).toBe("mailbox.restore");
    expect(body.auditEvent?.before).toMatchObject({ state: "softDeleted" });
    expect(body.auditEvent?.after).toMatchObject({ state: "active" });
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({
      action: "mailbox.restore",
      targetId: "mbx-deleted-1",
      tenantId: TENANT,
    });
    expect(provider.restoreCalls[0]).toMatchObject({
      tenantId: TENANT,
      mailboxId: "mbx-deleted-1",
      preview: false,
    });
    expect(provider.restoreCalls[0]?.input.confirm).toBe(true);
  });

  it("rejects restore without confirmation with 400", async () => {
    const provider = new FakeDeletedMailboxesProvider();
    const routes = createDeletedMailboxRoutes({ provider, resolveCaller: readCaller });

    await expect(
      routes[1]!.handler({
        method: "POST",
        path: `/v1/tenants/${TENANT}/deleted-mailboxes/mbx-deleted-1/restore`,
        params: { tenantId: TENANT, mailboxId: "mbx-deleted-1" },
        query: new URLSearchParams(),
        headers: {},
        body: {},
      }),
    ).rejects.toMatchObject({ status: 400, code: DELETED_MAILBOX_CONFIRM_REQUIRED });
    expect(provider.restoreCalls).toHaveLength(0);
  });

  it("returns a structured 4xx when the mailbox is not soft-deleted", async () => {
    const provider = new FakeDeletedMailboxesProvider();
    provider.restoreError = notSoftDeletedError("mbx-live-9");
    const routes = createDeletedMailboxRoutes({ provider, resolveCaller: readCaller });

    await expect(
      routes[1]!.handler({
        method: "POST",
        path: `/v1/tenants/${TENANT}/deleted-mailboxes/mbx-live-9/restore`,
        params: { tenantId: TENANT, mailboxId: "mbx-live-9" },
        query: new URLSearchParams(),
        headers: {},
        body: { confirm: true },
      }),
    ).rejects.toMatchObject({
      status: 404,
      code: DELETED_MAILBOX_NOT_SOFT_DELETED,
    });
  });

  it("maps a worker not-soft-deleted failure to the structured 4xx", async () => {
    const provider = new FakeDeletedMailboxesProvider();
    provider.restoreError = new Error("NotFound: Mailbox 'mbx-live-9' is not in the soft-deleted set");
    const routes = createDeletedMailboxRoutes({ provider, resolveCaller: readCaller });

    await expect(
      routes[1]!.handler({
        method: "POST",
        path: `/v1/tenants/${TENANT}/deleted-mailboxes/mbx-live-9/restore`,
        params: { tenantId: TENANT, mailboxId: "mbx-live-9" },
        query: new URLSearchParams(),
        headers: {},
        body: { confirm: true },
      }),
    ).rejects.toMatchObject({
      status: 404,
      code: DELETED_MAILBOX_NOT_SOFT_DELETED,
    });
  });

  it("builds the structured not-soft-deleted error", () => {
    const error = notSoftDeletedError("mbx-live-9");
    expect(error).toBeInstanceOf(AppError);
    expect(error.status).toBe(404);
    expect(error.code).toBe(DELETED_MAILBOX_NOT_SOFT_DELETED);
  });

  it("parses the deleted-mailbox list filter", () => {
    const filter = parseDeletedMailboxesFilter(new URLSearchParams("search=departed&limit=25"));
    expect(filter.search).toBe("departed");
    expect(filter.limit).toBe(25);
    expect(parseDeletedMailboxesFilter(new URLSearchParams()).search).toBeUndefined();
  });
});
