import { describe, expect, it } from "vitest";
import { tenantScope } from "../rbac/scope.js";
import {
  MAILBOX_CONVERT_PATH,
  MAILBOX_CREATE_PATH,
  MAILBOXES_WRITE_PERMISSION,
  createMailboxWriteRoutes,
  validateMailboxAlias,
  validateMailboxSmtp,
  type ConvertMailboxInput,
  type CreateSharedMailboxInput,
  type MailboxWriteCaller,
  type MailboxWritePlan,
  type MailboxWriteProvider,
  type MailboxWriteResult,
} from "./mailboxes.js";

const TENANT = "tenant-test";

const CREATE_PLAN: MailboxWritePlan = {
  action: "create",
  targetName: "Support Desk",
  before: null,
  after: { displayName: "Support Desk", alias: "support", type: "shared" },
  diff: ["Create shared mailbox 'Support Desk'"],
  valid: true,
  dryRun: true,
  requiresConfirmation: false,
};

const CREATE_RESULT: MailboxWriteResult = {
  success: true,
  plan: { ...CREATE_PLAN, dryRun: false },
  result: { id: "mbx-new", displayName: "Support Desk", type: "shared" },
  auditEvent: {
    id: "audit-1",
    tenantId: TENANT,
    action: "mailbox.create",
    targetId: "mbx-new",
    targetName: "Support Desk",
    timestamp: "2026-09-28T00:00:00.000Z",
    before: null,
    after: { displayName: "Support Desk", type: "shared" },
  },
};

const CONVERT_RESULT: MailboxWriteResult = {
  success: true,
  plan: {
    action: "convert",
    mailboxId: "mbx-2",
    targetName: "Operator One",
    before: { id: "mbx-2", type: "user" },
    after: { id: "mbx-2", type: "shared" },
    diff: ["Convert mailbox 'Operator One' (mbx-2) from user to shared"],
    valid: true,
    dryRun: false,
    requiresConfirmation: false,
  },
  result: { id: "mbx-2", type: "shared" },
  auditEvent: {
    id: "audit-2",
    tenantId: TENANT,
    action: "mailbox.convert",
    targetId: "mbx-2",
    targetName: "Operator One",
    timestamp: "2026-09-28T00:00:00.000Z",
    before: { id: "mbx-2", type: "user" },
    after: { id: "mbx-2", type: "shared" },
  },
};

const NOOP_RESULT: MailboxWriteResult = {
  success: true,
  noop: true,
  plan: {
    action: "convert",
    mailboxId: "mbx-1",
    targetName: "Support Desk",
    before: { id: "mbx-1", type: "shared" },
    after: { id: "mbx-1", type: "shared" },
    diff: ["Mailbox 'Support Desk' (mbx-1) is already shared; no change applied"],
    valid: true,
    dryRun: false,
    requiresConfirmation: false,
  },
  result: { id: "mbx-1", type: "shared", noop: true },
};

class FakeMailboxWriteProvider implements MailboxWriteProvider {
  readonly createCalls: Array<{ tenantId: string; input: CreateSharedMailboxInput; preview: boolean }> = [];
  readonly convertCalls: Array<{
    tenantId: string;
    mailboxId: string;
    input: ConvertMailboxInput;
    preview: boolean;
  }> = [];
  convertOutcome: MailboxWriteResult = CONVERT_RESULT;

  async createSharedMailbox(
    tenantId: string,
    input: CreateSharedMailboxInput,
    preview: boolean,
  ): Promise<MailboxWriteResult | MailboxWritePlan> {
    this.createCalls.push({ tenantId, input, preview });
    return preview ? CREATE_PLAN : CREATE_RESULT;
  }

  async convertToShared(
    tenantId: string,
    mailboxId: string,
    input: ConvertMailboxInput,
    preview: boolean,
  ): Promise<MailboxWriteResult | MailboxWritePlan> {
    this.convertCalls.push({ tenantId, mailboxId, input, preview });
    return preview ? { ...this.convertOutcome.plan, dryRun: true } : this.convertOutcome;
  }
}

function writerCaller(): MailboxWriteCaller {
  return {
    tenantScope: tenantScope([TENANT]),
    permissions: [MAILBOXES_WRITE_PERMISSION],
  };
}

describe("Mailbox shared create/convert routes (T-0382)", () => {
  it("exposes POST create and POST convert paths", () => {
    const routes = createMailboxWriteRoutes({
      provider: new FakeMailboxWriteProvider(),
      resolveCaller: writerCaller,
    });
    expect(routes.map((route) => `${route.method} ${route.path}`)).toEqual([
      `POST ${MAILBOX_CREATE_PATH}`,
      `POST ${MAILBOX_CONVERT_PATH}`,
    ]);
  });

  it("rejects unauthenticated requests with 401", async () => {
    const routes = createMailboxWriteRoutes({
      provider: new FakeMailboxWriteProvider(),
      resolveCaller: () => undefined,
    });

    await expect(
      routes[0]!.handler({
        method: "POST",
        path: `/v1/tenants/${TENANT}/mailboxes`,
        params: { tenantId: TENANT },
        query: new URLSearchParams(),
        headers: {},
        body: { displayName: "Support Desk" },
      }),
    ).rejects.toMatchObject({ status: 401 });
  });

  it("rejects tenant outside caller scope with 403", async () => {
    const routes = createMailboxWriteRoutes({
      provider: new FakeMailboxWriteProvider(),
      resolveCaller: () => ({
        tenantScope: tenantScope(["different-tenant"]),
        permissions: [MAILBOXES_WRITE_PERMISSION],
      }),
    });

    await expect(
      routes[1]!.handler({
        method: "POST",
        path: `/v1/tenants/${TENANT}/mailboxes/mbx-2/convert`,
        params: { tenantId: TENANT, mailboxId: "mbx-2" },
        query: new URLSearchParams(),
        headers: {},
        body: {},
      }),
    ).rejects.toMatchObject({ status: 403 });
  });

  it("rejects callers missing mailboxes.write with 403", async () => {
    const routes = createMailboxWriteRoutes({
      provider: new FakeMailboxWriteProvider(),
      resolveCaller: () => ({
        tenantScope: tenantScope([TENANT]),
        permissions: ["mailboxes.read"],
      }),
    });

    await expect(
      routes[0]!.handler({
        method: "POST",
        path: `/v1/tenants/${TENANT}/mailboxes`,
        params: { tenantId: TENANT },
        query: new URLSearchParams(),
        headers: {},
        body: { displayName: "Support Desk" },
      }),
    ).rejects.toMatchObject({ status: 403 });
  });

  it("returns a plan preview for create when preview is requested", async () => {
    const provider = new FakeMailboxWriteProvider();
    const routes = createMailboxWriteRoutes({ provider, resolveCaller: writerCaller });

    const response = await routes[0]!.handler({
      method: "POST",
      path: `/v1/tenants/${TENANT}/mailboxes`,
      params: { tenantId: TENANT },
      query: new URLSearchParams(),
      headers: {},
      body: { displayName: "Support Desk", alias: "support", preview: true },
    });

    expect(response.status).toBe(200);
    const body = response.body as MailboxWritePlan;
    expect(body.dryRun).toBe(true);
    expect(body.action).toBe("create");
    expect(body.diff).toHaveLength(1);
    expect(provider.createCalls[0]).toMatchObject({ tenantId: TENANT, preview: true });
  });

  it("applies create with before/after and an audit event", async () => {
    const provider = new FakeMailboxWriteProvider();
    const routes = createMailboxWriteRoutes({ provider, resolveCaller: writerCaller });

    const response = await routes[0]!.handler({
      method: "POST",
      path: `/v1/tenants/${TENANT}/mailboxes`,
      params: { tenantId: TENANT },
      query: new URLSearchParams(),
      headers: {},
      body: { displayName: "Support Desk", alias: "support" },
    });

    expect(response.status).toBe(201);
    const body = response.body as MailboxWriteResult;
    expect(body.success).toBe(true);
    expect(body.plan.before).toBeNull();
    expect(body.plan.after).toMatchObject({ type: "shared" });
    expect(body.auditEvent?.action).toBe("mailbox.create");
    expect(provider.createCalls[0]).toMatchObject({ tenantId: TENANT, preview: false });
  });

  it("rejects create without displayName with 400", async () => {
    const routes = createMailboxWriteRoutes({
      provider: new FakeMailboxWriteProvider(),
      resolveCaller: writerCaller,
    });

    await expect(
      routes[0]!.handler({
        method: "POST",
        path: `/v1/tenants/${TENANT}/mailboxes`,
        params: { tenantId: TENANT },
        query: new URLSearchParams(),
        headers: {},
        body: { alias: "support" },
      }),
    ).rejects.toMatchObject({ status: 400 });
  });

  it("rejects create with an invalid alias or SMTP address with 400", async () => {
    const routes = createMailboxWriteRoutes({
      provider: new FakeMailboxWriteProvider(),
      resolveCaller: writerCaller,
    });

    await expect(
      routes[0]!.handler({
        method: "POST",
        path: `/v1/tenants/${TENANT}/mailboxes`,
        params: { tenantId: TENANT },
        query: new URLSearchParams(),
        headers: {},
        body: { displayName: "Support Desk", alias: "not an alias!" },
      }),
    ).rejects.toMatchObject({ status: 400 });

    await expect(
      routes[0]!.handler({
        method: "POST",
        path: `/v1/tenants/${TENANT}/mailboxes`,
        params: { tenantId: TENANT },
        query: new URLSearchParams(),
        headers: {},
        body: { displayName: "Support Desk", primarySmtpAddress: "not-an-address" },
      }),
    ).rejects.toMatchObject({ status: 400 });
  });

  it("applies convert with before/after and an audit event", async () => {
    const provider = new FakeMailboxWriteProvider();
    const routes = createMailboxWriteRoutes({ provider, resolveCaller: writerCaller });

    const response = await routes[1]!.handler({
      method: "POST",
      path: `/v1/tenants/${TENANT}/mailboxes/mbx-2/convert`,
      params: { tenantId: TENANT, mailboxId: "mbx-2" },
      query: new URLSearchParams(),
      headers: {},
      body: {},
    });

    expect(response.status).toBe(200);
    const body = response.body as MailboxWriteResult;
    expect(body.success).toBe(true);
    expect(body.noop).not.toBe(true);
    expect(body.plan.before).toMatchObject({ type: "user" });
    expect(body.plan.after).toMatchObject({ type: "shared" });
    expect(body.auditEvent?.action).toBe("mailbox.convert");
    expect(provider.convertCalls[0]).toMatchObject({
      tenantId: TENANT,
      mailboxId: "mbx-2",
      preview: false,
    });
    expect(provider.convertCalls[0]?.input.confirm).toBe(true);
  });

  it("returns a structured no-op when the mailbox is already shared", async () => {
    const provider = new FakeMailboxWriteProvider();
    provider.convertOutcome = NOOP_RESULT;
    const routes = createMailboxWriteRoutes({ provider, resolveCaller: writerCaller });

    const response = await routes[1]!.handler({
      method: "POST",
      path: `/v1/tenants/${TENANT}/mailboxes/mbx-1/convert`,
      params: { tenantId: TENANT, mailboxId: "mbx-1" },
      query: new URLSearchParams(),
      headers: {},
      body: {},
    });

    expect(response.status).toBe(200);
    const body = response.body as MailboxWriteResult;
    expect(body.success).toBe(true);
    expect(body.noop).toBe(true);
    expect(body.plan.before).toEqual(body.plan.after);
    expect(provider.convertCalls[0]?.mailboxId).toBe("mbx-1");
  });

  it("rejects convert when confirmation is explicitly withheld with 400", async () => {
    const routes = createMailboxWriteRoutes({
      provider: new FakeMailboxWriteProvider(),
      resolveCaller: writerCaller,
    });

    await expect(
      routes[1]!.handler({
        method: "POST",
        path: `/v1/tenants/${TENANT}/mailboxes/mbx-2/convert`,
        params: { tenantId: TENANT, mailboxId: "mbx-2" },
        query: new URLSearchParams(),
        headers: {},
        body: { confirm: false },
      }),
    ).rejects.toMatchObject({ status: 400 });
  });

  it("validates mailbox alias and SMTP shapes", () => {
    expect(validateMailboxAlias("support.desk_01")).toBe(true);
    expect(validateMailboxAlias("not an alias!")).toBe(false);
    expect(validateMailboxSmtp("support@example.com")).toBe(true);
    expect(validateMailboxSmtp("not-an-address")).toBe(false);
  });
});
