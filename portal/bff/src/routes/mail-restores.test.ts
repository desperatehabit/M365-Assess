import { describe, expect, it } from "vitest";
import { AppError } from "../errors.js";
import { tenantScope } from "../rbac/scope.js";
import {
  MAIL_RESTORES_OPENAPI,
  MAIL_RESTORE_APPLY_PERMISSION,
  MAIL_RESTORE_CONFIRM_REQUIRED,
  MAIL_RESTORE_JOB_PATH,
  MAIL_RESTORE_NOT_FOUND,
  MAIL_RESTORE_PERMISSION,
  MAIL_RESTORES_PATH,
  createMailRestoreRoutes,
  mailRestoreNotFoundError,
  parseMailRestoreInput,
  type MailRestoreAuditEvent,
  type MailRestoreInput,
  type MailRestoreJob,
  type MailRestorePlan,
  type MailRestoreResult,
  type MailRestoresCaller,
  type MailRestoresProvider,
} from "./mail-restores.js";

const TENANT = "tenant-test";

const MAILBOX_JOB: MailRestoreJob = {
  id: "job-1",
  tenantId: TENANT,
  mailboxId: "mbx-soft-1",
  scope: "mailbox",
  target: null,
  state: "completed",
  result: { before: { itemCount: 10 }, after: { itemCount: 15 } },
  createdAt: "2026-09-30T00:00:00.000Z",
  createdBy: "operator-1",
};

const MAILBOX_PLAN: MailRestorePlan = {
  action: "restore",
  mailboxId: "mbx-soft-1",
  scope: "mailbox",
  target: null,
  before: { state: "softDeleted", itemCount: 10 },
  after: { state: "active", itemCount: null },
  diff: ["Restore mailbox 'Departed Operator' (mbx-soft-1) in place"],
  valid: true,
  dryRun: true,
  requiresConfirmation: true,
};

const MAILBOX_RESULT: MailRestoreResult = {
  success: true,
  job: MAILBOX_JOB,
  plan: { ...MAILBOX_PLAN, dryRun: false, requiresConfirmation: false },
  result: { before: { itemCount: 10 }, after: { itemCount: 15 } },
  auditEvent: {
    id: "audit-1",
    tenantId: TENANT,
    action: "mailbox.restore",
    targetId: "mbx-soft-1",
    targetName: "Departed Operator",
    scope: "mailbox",
    timestamp: "2026-09-30T00:00:00.000Z",
    before: { itemCount: 10 },
    after: { itemCount: 15 },
  },
};

const ITEM_PLAN: MailRestorePlan = {
  action: "restore",
  mailboxId: "mbx-live-1",
  scope: "items",
  target: "restore-target",
  before: { state: "active", itemCount: 20 },
  after: { state: "restored", itemCount: null },
  diff: ["Restore items from 'mbx-live-1' into target 'restore-target'"],
  valid: true,
  dryRun: true,
  requiresConfirmation: true,
};

const ITEM_RESULT: MailRestoreResult = {
  success: true,
  job: {
    ...MAILBOX_JOB,
    id: "job-2",
    mailboxId: "mbx-live-1",
    scope: "items",
    target: "restore-target",
    result: { before: { itemCount: 20 }, after: { itemCount: 3 } },
  },
  plan: { ...ITEM_PLAN, dryRun: false, requiresConfirmation: false },
  result: { before: { itemCount: 20 }, after: { itemCount: 3 } },
  auditEvent: {
    id: "audit-2",
    tenantId: TENANT,
    action: "mailbox.restore",
    targetId: "mbx-live-1",
    targetName: "restore-target",
    scope: "items",
    timestamp: "2026-09-30T00:01:00.000Z",
    before: { itemCount: 20 },
    after: { itemCount: 3 },
  },
};

class FakeMailRestoresProvider implements MailRestoresProvider {
  readonly planCalls: Array<{ tenantId: string; input: MailRestoreInput; createdBy?: string }> = [];
  readonly applyCalls: Array<{ tenantId: string; input: MailRestoreInput; createdBy?: string }> = [];
  readonly getCalls: Array<{ tenantId: string; jobId: string }> = [];
  planResult: MailRestorePlan = MAILBOX_PLAN;
  applyResult: MailRestoreResult = MAILBOX_RESULT;
  applyError: unknown = undefined;
  job: MailRestoreJob = MAILBOX_JOB;
  getError: unknown = undefined;

  async planRestore(
    tenantId: string,
    input: MailRestoreInput,
    createdBy?: string,
  ): Promise<MailRestorePlan> {
    this.planCalls.push({ tenantId, input, createdBy });
    return this.planResult;
  }

  async applyRestore(
    tenantId: string,
    input: MailRestoreInput,
    createdBy?: string,
  ): Promise<MailRestoreResult> {
    this.applyCalls.push({ tenantId, input, createdBy });
    if (this.applyError !== undefined) {
      throw this.applyError;
    }
    return this.applyResult;
  }

  async getRestoreJob(tenantId: string, jobId: string): Promise<MailRestoreJob> {
    this.getCalls.push({ tenantId, jobId });
    if (this.getError !== undefined) {
      throw this.getError;
    }
    return this.job;
  }
}

function makeCaller(
  permissions: readonly string[] = [MAIL_RESTORE_PERMISSION, MAIL_RESTORE_APPLY_PERMISSION],
): MailRestoresCaller {
  return {
    tenantScope: tenantScope([TENANT]),
    permissions: [...permissions],
    userId: "operator-1",
  };
}

function readCaller(): MailRestoresCaller {
  return makeCaller();
}

function startCtx(body: Record<string, unknown>, query = new URLSearchParams()) {
  return {
    method: "POST",
    path: `/v1/tenants/${TENANT}/mail/restores`,
    params: { tenantId: TENANT },
    query,
    headers: {},
    body,
  };
}

describe("Mailbox restore routes (T-0467)", () => {
  it("exposes the start and progress paths", () => {
    const routes = createMailRestoreRoutes({
      provider: new FakeMailRestoresProvider(),
      resolveCaller: readCaller,
    });
    expect(routes.map((route) => `${route.method} ${route.path}`)).toEqual([
      `POST ${MAIL_RESTORES_PATH}`,
      `GET ${MAIL_RESTORE_JOB_PATH}`,
    ]);
  });

  it("rejects unauthenticated requests with 401", async () => {
    const routes = createMailRestoreRoutes({
      provider: new FakeMailRestoresProvider(),
      resolveCaller: () => undefined,
    });
    await expect(routes[0]!.handler(startCtx({ mailboxId: "mbx-soft-1", preview: true }))).rejects.toMatchObject(
      { status: 401 },
    );
  });

  it("rejects tenants outside caller scope with 403", async () => {
    const routes = createMailRestoreRoutes({
      provider: new FakeMailRestoresProvider(),
      resolveCaller: () => ({
        tenantScope: tenantScope(["different-tenant"]),
        permissions: [MAIL_RESTORE_PERMISSION, MAIL_RESTORE_APPLY_PERMISSION],
      }),
    });
    await expect(routes[0]!.handler(startCtx({ mailboxId: "mbx-soft-1", preview: true }))).rejects.toMatchObject(
      { status: 403 },
    );
  });

  it("refuses callers lacking mailtools.restore with 403", async () => {
    const provider = new FakeMailRestoresProvider();
    const routes = createMailRestoreRoutes({
      provider,
      resolveCaller: () => makeCaller(["Identity.User.Read"]),
    });
    await expect(routes[0]!.handler(startCtx({ mailboxId: "mbx-soft-1", preview: true }))).rejects.toMatchObject(
      { status: 403, code: "auth.forbidden" },
    );
    expect(provider.planCalls).toHaveLength(0);
  });

  it("refuses apply callers lacking Remediation.Apply with 403", async () => {
    const provider = new FakeMailRestoresProvider();
    const routes = createMailRestoreRoutes({
      provider,
      resolveCaller: () => makeCaller([MAIL_RESTORE_PERMISSION]),
    });
    await expect(
      routes[0]!.handler(startCtx({ mailboxId: "mbx-soft-1", confirm: true })),
    ).rejects.toMatchObject({ status: 403, code: "auth.forbidden" });
    expect(provider.applyCalls).toHaveLength(0);
  });

  it("returns a plan preview before any write and restores nothing", async () => {
    const provider = new FakeMailRestoresProvider();
    const audits: MailRestoreAuditEvent[] = [];
    const routes = createMailRestoreRoutes({
      provider,
      resolveCaller: readCaller,
      recordAudit: async (event) => {
        audits.push(event);
      },
    });

    const response = await routes[0]!.handler(startCtx({ mailboxId: "mbx-soft-1", preview: true }));

    expect(response.status).toBe(200);
    const body = response.body as MailRestorePlan;
    expect(body.action).toBe("restore");
    expect(body.dryRun).toBe(true);
    expect(body.requiresConfirmation).toBe(true);
    expect(body.diff).toHaveLength(1);
    expect(provider.planCalls).toHaveLength(1);
    expect(provider.applyCalls).toHaveLength(0);
    expect(audits).toHaveLength(0);
  });

  it("rejects an apply without confirmation with 400 before dispatch", async () => {
    const provider = new FakeMailRestoresProvider();
    const routes = createMailRestoreRoutes({ provider, resolveCaller: readCaller });

    await expect(
      routes[0]!.handler(startCtx({ mailboxId: "mbx-soft-1" })),
    ).rejects.toMatchObject({ status: 400, code: MAIL_RESTORE_CONFIRM_REQUIRED });
    expect(provider.applyCalls).toHaveLength(0);
  });

  it("applies a mailbox-only restore with confirmation, before/after counts, and an audit record", async () => {
    const provider = new FakeMailRestoresProvider();
    const audits: MailRestoreAuditEvent[] = [];
    const routes = createMailRestoreRoutes({
      provider,
      resolveCaller: readCaller,
      recordAudit: async (event) => {
        audits.push(event);
      },
    });

    const response = await routes[0]!.handler(
      startCtx({ mailboxId: "mbx-soft-1", scope: "mailbox", confirm: true }),
    );

    expect(response.status).toBe(202);
    const body = response.body as MailRestoreResult;
    expect(body.success).toBe(true);
    expect(body.job.state).toBe("completed");
    expect(body.job.scope).toBe("mailbox");
    expect(body.result).toMatchObject({ before: { itemCount: 10 }, after: { itemCount: 15 } });
    expect(body.auditEvent?.action).toBe("mailbox.restore");
    expect(body.auditEvent?.before).toMatchObject({ itemCount: 10 });
    expect(body.auditEvent?.after).toMatchObject({ itemCount: 15 });
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({ action: "mailbox.restore", targetId: "mbx-soft-1" });
    expect(provider.applyCalls).toHaveLength(1);
    expect(provider.applyCalls[0]).toMatchObject({
      tenantId: TENANT,
      input: { mailboxId: "mbx-soft-1", scope: "mailbox" },
      createdBy: "operator-1",
    });
  });

  it("accepts an explicitly scoped item-level restore", async () => {
    const provider = new FakeMailRestoresProvider();
    provider.planResult = ITEM_PLAN;
    provider.applyResult = ITEM_RESULT;
    const routes = createMailRestoreRoutes({ provider, resolveCaller: readCaller });

    const preview = await routes[0]!.handler(
      startCtx({ mailboxId: "mbx-live-1", scope: "items", target: "restore-target", preview: true }),
    );
    expect(preview.status).toBe(200);
    expect((preview.body as MailRestorePlan).scope).toBe("items");
    expect(provider.planCalls[0]?.input).toMatchObject({
      scope: "items",
      target: "restore-target",
    });

    const applied = await routes[0]!.handler(
      startCtx({ mailboxId: "mbx-live-1", scope: "items", target: "restore-target", confirm: true }),
    );
    expect(applied.status).toBe(202);
    const body = applied.body as MailRestoreResult;
    expect(body.job.scope).toBe("items");
    expect(body.job.target).toBe("restore-target");
    expect(body.result).toMatchObject({ before: { itemCount: 20 }, after: { itemCount: 3 } });
    expect(provider.applyCalls[0]?.input).toMatchObject({
      scope: "items",
      target: "restore-target",
    });
  });

  it("rejects an item-level restore without a target with 400", async () => {
    const provider = new FakeMailRestoresProvider();
    const routes = createMailRestoreRoutes({ provider, resolveCaller: readCaller });
    await expect(
      routes[0]!.handler(startCtx({ mailboxId: "mbx-live-1", scope: "items", preview: true })),
    ).rejects.toMatchObject({ status: 400 });
    expect(provider.planCalls).toHaveLength(0);
  });

  it("serves progress from the persisted RestoreJob", async () => {
    const provider = new FakeMailRestoresProvider();
    const routes = createMailRestoreRoutes({ provider, resolveCaller: readCaller });

    const response = await routes[1]!.handler({
      method: "GET",
      path: `/v1/tenants/${TENANT}/mail/restores/job-1`,
      params: { tenantId: TENANT, jobId: "job-1" },
      query: new URLSearchParams(),
      headers: {},
    });

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      id: "job-1",
      state: "completed",
      result: { before: { itemCount: 10 }, after: { itemCount: 15 } },
    });
    expect(provider.getCalls).toEqual([{ tenantId: TENANT, jobId: "job-1" }]);
  });

  it("maps a missing job to the structured 404", async () => {
    const provider = new FakeMailRestoresProvider();
    provider.getError = new Error("mail-restores.not_found: job is gone");
    const routes = createMailRestoreRoutes({ provider, resolveCaller: readCaller });

    await expect(
      routes[1]!.handler({
        method: "GET",
        path: `/v1/tenants/${TENANT}/mail/restores/job-9`,
        params: { tenantId: TENANT, jobId: "job-9" },
        query: new URLSearchParams(),
        headers: {},
      }),
    ).rejects.toMatchObject({ status: 404, code: MAIL_RESTORE_NOT_FOUND });
  });

  it("builds the structured not-found error", () => {
    const error = mailRestoreNotFoundError("job-9");
    expect(error).toBeInstanceOf(AppError);
    expect(error.status).toBe(404);
    expect(error.code).toBe(MAIL_RESTORE_NOT_FOUND);
  });

  it("parses the restore input and rejects invalid ones", () => {
    expect(
      parseMailRestoreInput({ mailboxId: "  mbx-soft-1  ", scope: "items", target: " restore-target " }),
    ).toMatchObject({ mailboxId: "mbx-soft-1", scope: "items", target: "restore-target" });
    expect(parseMailRestoreInput({ mailboxId: "mbx-soft-1" })).toMatchObject({ scope: "mailbox" });
    expect(() => parseMailRestoreInput({})).toThrow();
    expect(() => parseMailRestoreInput({ mailboxId: "mbx-1", scope: "everything" })).toThrow();
    expect(() => parseMailRestoreInput({ mailboxId: "mbx-1", scope: "items" })).toThrow();
    expect(() =>
      parseMailRestoreInput({
        mailboxId: "mbx-1",
        scope: "date",
        target: "restore-target",
        startDate: "2026-09-30T00:00:00.000Z",
        endDate: "2026-09-01T00:00:00.000Z",
      }),
    ).toThrow();
  });

  it("publishes the portal.v1.yaml fragment for start and progress", () => {
    expect(MAIL_RESTORES_OPENAPI.paths["/tenants/{tenantId}/mail/restores"]).toBeDefined();
    expect(
      MAIL_RESTORES_OPENAPI.paths["/tenants/{tenantId}/mail/restores/{jobId}"],
    ).toBeDefined();
  });
});
