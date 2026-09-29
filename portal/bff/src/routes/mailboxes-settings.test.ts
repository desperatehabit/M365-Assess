import { describe, expect, it } from "vitest";
import { tenantScope } from "../rbac/scope.js";
import {
  MAILBOX_SETTINGS_PATH,
  MAILBOXES_SETTINGS_OPENAPI,
  MAILBOXES_WRITE_PERMISSION,
  createMailboxSettingsRoutes,
  validateMailboxLocale,
  validateMailboxQuota,
  type MailboxSettingsInput,
  type MailboxSettingsPlan,
  type MailboxSettingsProvider,
  type MailboxSettingsResult,
  type MailboxWriteCaller,
} from "./mailboxes.js";

const TENANT = "tenant-test";
const MAILBOX = "mbx-2";

const SETTINGS_PLAN: MailboxSettingsPlan = {
  action: "settings",
  mailboxId: MAILBOX,
  targetName: "Operator One",
  before: { id: MAILBOX, prohibitSendQuota: "49 GB (51318076416 bytes)" },
  after: { id: MAILBOX, prohibitSendQuota: "50 GB" },
  diff: ["Set prohibitSendQuota: 49 GB (51318076416 bytes) -> 50 GB"],
  valid: true,
  dryRun: true,
  requiresConfirmation: false,
};

const SETTINGS_RESULT: MailboxSettingsResult = {
  success: true,
  plan: { ...SETTINGS_PLAN, dryRun: false },
  result: { id: MAILBOX, displayName: "Operator One" },
  operation: {
    id: "operation-1",
    tenantId: TENANT,
    mailboxId: MAILBOX,
    operation: "mailbox.settings",
    before: { id: MAILBOX, prohibitSendQuota: "49 GB (51318076416 bytes)" },
    after: { id: MAILBOX, prohibitSendQuota: "50 GB" },
    state: "applied",
    by: null,
    at: "2026-09-28T00:00:00.000Z",
  },
  auditEvent: {
    id: "audit-1",
    tenantId: TENANT,
    action: "mailbox.settings",
    targetId: MAILBOX,
    targetName: "Operator One",
    timestamp: "2026-09-28T00:00:00.000Z",
    before: { id: MAILBOX, prohibitSendQuota: "49 GB (51318076416 bytes)" },
    after: { id: MAILBOX, prohibitSendQuota: "50 GB" },
  },
};

class FakeMailboxSettingsProvider implements MailboxSettingsProvider {
  readonly calls: Array<{
    tenantId: string;
    mailboxId: string;
    input: MailboxSettingsInput;
    preview: boolean;
  }> = [];

  async setMailboxSettings(
    tenantId: string,
    mailboxId: string,
    input: MailboxSettingsInput,
    preview: boolean,
  ): Promise<MailboxSettingsResult | MailboxSettingsPlan> {
    this.calls.push({ tenantId, mailboxId, input, preview });
    return preview ? SETTINGS_PLAN : SETTINGS_RESULT;
  }
}

function writerCaller(): MailboxWriteCaller {
  return {
    tenantScope: tenantScope([TENANT]),
    permissions: [MAILBOXES_WRITE_PERMISSION],
  };
}

function patchRoute(provider = new FakeMailboxSettingsProvider()) {
  const routes = createMailboxSettingsRoutes({
    provider,
    resolveCaller: writerCaller,
  });
  return { provider, handler: routes[0]!.handler };
}

describe("Mailbox settings PATCH route (T-0383)", () => {
  it("exposes the PATCH settings path", () => {
    const routes = createMailboxSettingsRoutes({
      provider: new FakeMailboxSettingsProvider(),
      resolveCaller: writerCaller,
    });
    expect(routes.map((route) => `${route.method} ${route.path}`)).toEqual([
      `PATCH ${MAILBOX_SETTINGS_PATH}`,
    ]);
    expect(MAILBOXES_SETTINGS_OPENAPI.paths["/tenants/{tenantId}/mailboxes/{mailboxId}"].patch.operationId).toBe(
      "setMailboxSettings",
    );
  });

  it("rejects unauthenticated requests with 401", async () => {
    const routes = createMailboxSettingsRoutes({
      provider: new FakeMailboxSettingsProvider(),
      resolveCaller: () => undefined,
    });

    await expect(
      routes[0]!.handler({
        method: "PATCH",
        path: `/v1/tenants/${TENANT}/mailboxes/${MAILBOX}`,
        params: { tenantId: TENANT, mailboxId: MAILBOX },
        query: new URLSearchParams(),
        headers: {},
        body: { prohibitSendQuota: "50 GB" },
      }),
    ).rejects.toMatchObject({ status: 401 });
  });

  it("rejects a tenant outside caller scope with 403", async () => {
    const routes = createMailboxSettingsRoutes({
      provider: new FakeMailboxSettingsProvider(),
      resolveCaller: () => ({
        tenantScope: tenantScope(["different-tenant"]),
        permissions: [MAILBOXES_WRITE_PERMISSION],
      }),
    });

    await expect(
      routes[0]!.handler({
        method: "PATCH",
        path: `/v1/tenants/${TENANT}/mailboxes/${MAILBOX}`,
        params: { tenantId: TENANT, mailboxId: MAILBOX },
        query: new URLSearchParams(),
        headers: {},
        body: { prohibitSendQuota: "50 GB" },
      }),
    ).rejects.toMatchObject({ status: 403 });
  });

  it("rejects callers missing Mailboxes.Mailbox.ReadWrite with 403", async () => {
    const routes = createMailboxSettingsRoutes({
      provider: new FakeMailboxSettingsProvider(),
      resolveCaller: () => ({
        tenantScope: tenantScope([TENANT]),
        permissions: ["Mailboxes.Mailbox.Read"],
      }),
    });

    await expect(
      routes[0]!.handler({
        method: "PATCH",
        path: `/v1/tenants/${TENANT}/mailboxes/${MAILBOX}`,
        params: { tenantId: TENANT, mailboxId: MAILBOX },
        query: new URLSearchParams(),
        headers: {},
        body: { prohibitSendQuota: "50 GB" },
      }),
    ).rejects.toMatchObject({ status: 403 });
  });

  it("returns a plan preview with no tenant write when preview is requested", async () => {
    const { provider, handler } = patchRoute();

    const response = await handler({
      method: "PATCH",
      path: `/v1/tenants/${TENANT}/mailboxes/${MAILBOX}`,
      params: { tenantId: TENANT, mailboxId: MAILBOX },
      query: new URLSearchParams(),
      headers: {},
      body: { prohibitSendQuota: "50 GB", preview: true },
    });

    expect(response.status).toBe(200);
    const body = response.body as MailboxSettingsPlan;
    expect(body.dryRun).toBe(true);
    expect(body.action).toBe("settings");
    expect(body.diff).toHaveLength(1);
    expect(provider.calls[0]).toMatchObject({ tenantId: TENANT, mailboxId: MAILBOX, preview: true });
  });

  it("applies quota settings with before/after, an operation, and an audit event", async () => {
    const { provider, handler } = patchRoute();

    const response = await handler({
      method: "PATCH",
      path: `/v1/tenants/${TENANT}/mailboxes/${MAILBOX}`,
      params: { tenantId: TENANT, mailboxId: MAILBOX },
      query: new URLSearchParams(),
      headers: {},
      body: { prohibitSendQuota: "50 GB", hiddenFromAddressListsEnabled: true, confirm: true },
    });

    expect(response.status).toBe(200);
    const body = response.body as MailboxSettingsResult;
    expect(body.success).toBe(true);
    expect(body.plan.before).toMatchObject({ prohibitSendQuota: "49 GB (51318076416 bytes)" });
    expect(body.plan.after).toMatchObject({ prohibitSendQuota: "50 GB" });
    expect(body.operation?.operation).toBe("mailbox.settings");
    expect(body.operation?.state).toBe("applied");
    expect(body.auditEvent?.action).toBe("mailbox.settings");
    expect(body.auditEvent?.before).toMatchObject({ prohibitSendQuota: "49 GB (51318076416 bytes)" });
    expect(provider.calls[0]).toMatchObject({ tenantId: TENANT, mailboxId: MAILBOX, preview: false });
  });

  it("requires explicit confirmation to enable archive or change a hold", async () => {
    const { handler } = patchRoute();

    await expect(
      handler({
        method: "PATCH",
        path: `/v1/tenants/${TENANT}/mailboxes/${MAILBOX}`,
        params: { tenantId: TENANT, mailboxId: MAILBOX },
        query: new URLSearchParams(),
        headers: {},
        body: { archiveEnabled: true },
      }),
    ).rejects.toMatchObject({ status: 400 });

    await expect(
      handler({
        method: "PATCH",
        path: `/v1/tenants/${TENANT}/mailboxes/${MAILBOX}`,
        params: { tenantId: TENANT, mailboxId: MAILBOX },
        query: new URLSearchParams(),
        headers: {},
        body: { litigationHoldEnabled: true },
      }),
    ).rejects.toMatchObject({ status: 400 });
  });

  it("rejects unknown settings and malformed values with 400", async () => {
    const { handler } = patchRoute();

    await expect(
      handler({
        method: "PATCH",
        path: `/v1/tenants/${TENANT}/mailboxes/${MAILBOX}`,
        params: { tenantId: TENANT, mailboxId: MAILBOX },
        query: new URLSearchParams(),
        headers: {},
        body: { forwardingTo: "smtp:cover@example.com" },
      }),
    ).rejects.toMatchObject({ status: 400 });

    await expect(
      handler({
        method: "PATCH",
        path: `/v1/tenants/${TENANT}/mailboxes/${MAILBOX}`,
        params: { tenantId: TENANT, mailboxId: MAILBOX },
        query: new URLSearchParams(),
        headers: {},
        body: { prohibitSendQuota: "huge" },
      }),
    ).rejects.toMatchObject({ status: 400 });

    await expect(
      handler({
        method: "PATCH",
        path: `/v1/tenants/${TENANT}/mailboxes/${MAILBOX}`,
        params: { tenantId: TENANT, mailboxId: MAILBOX },
        query: new URLSearchParams(),
        headers: {},
        body: {},
      }),
    ).rejects.toMatchObject({ status: 400 });
  });

  it("validates quota and locale shapes", () => {
    expect(validateMailboxQuota("50 GB")).toBe(true);
    expect(validateMailboxQuota("Unlimited")).toBe(true);
    expect(validateMailboxQuota("huge")).toBe(false);
    expect(validateMailboxLocale("en-US")).toBe(true);
    expect(validateMailboxLocale("english")).toBe(false);
  });
});
