import { describe, expect, it } from "vitest";
import { FORWARDING_SENSITIVE_WARNING } from "../domain/mailboxes/forwarding-guard.js";
import { tenantScope } from "../rbac/scope.js";
import {
  MAILBOX_RULES_BASE_PATH,
  MAILBOX_RULE_ITEM_PATH,
  MAILBOX_RULES_READ_PERMISSION,
  MAILBOX_RULE_CONFIRM_REQUIRED,
  createMailboxRuleRoutes,
  type CreateMailboxRuleInput,
  type EditMailboxRuleInput,
  type MailboxRulePlan,
  type MailboxRuleResult,
  type MailboxRulesCaller,
  type MailboxRulesListResponse,
  type MailboxRulesProvider,
} from "./mailbox-rules.js";
import { MAILBOXES_WRITE_PERMISSION } from "./mailboxes.js";

const TENANT = "tenant-test";
const MAILBOX = "mbx-1";

const LIST_RESPONSE: MailboxRulesListResponse = {
  tenantId: TENANT,
  mailboxId: MAILBOX,
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

function planFor(action: MailboxRulePlan["action"], after: Record<string, unknown> | null): MailboxRulePlan {
  return {
    action,
    mailboxId: MAILBOX,
    targetName: "Forward cover",
    before: null,
    after,
    diff: [`${action} rule 'Forward cover'`],
    valid: true,
    dryRun: true,
    requiresConfirmation: false,
  };
}

function resultFor(plan: MailboxRulePlan, ruleId: string): MailboxRuleResult {
  return {
    success: true,
    plan: { ...plan, dryRun: false },
    result: { id: ruleId },
    auditEvent: {
      id: "audit-1",
      tenantId: TENANT,
      action: `mailbox.rule.${plan.action}`,
      targetId: ruleId,
      targetName: plan.targetName,
      timestamp: "2026-09-28T00:00:00.000Z",
      before: plan.before,
      after: plan.after,
    },
  };
}

class FakeMailboxRulesProvider implements MailboxRulesProvider {
  readonly listCalls: Array<{ tenantId: string; mailboxId: string }> = [];
  readonly createCalls: Array<{ tenantId: string; mailboxId: string; input: CreateMailboxRuleInput; preview: boolean }> = [];
  readonly editCalls: Array<{ tenantId: string; mailboxId: string; ruleId: string; input: EditMailboxRuleInput; preview: boolean }> = [];
  readonly deleteCalls: Array<{ tenantId: string; mailboxId: string; ruleId: string; preview: boolean }> = [];

  async listRules(tenantId: string, mailboxId: string): Promise<MailboxRulesListResponse> {
    this.listCalls.push({ tenantId, mailboxId });
    return LIST_RESPONSE;
  }

  async createRule(
    tenantId: string,
    mailboxId: string,
    input: CreateMailboxRuleInput,
    preview: boolean,
  ): Promise<MailboxRuleResult | MailboxRulePlan> {
    this.createCalls.push({ tenantId, mailboxId, input, preview });
    const plan = planFor("create", { name: input.name, forwardTo: input.forwardTo ?? null });
    return preview ? plan : resultFor(plan, "rule-new");
  }

  async editRule(
    tenantId: string,
    mailboxId: string,
    ruleId: string,
    input: EditMailboxRuleInput,
    preview: boolean,
  ): Promise<MailboxRuleResult | MailboxRulePlan> {
    this.editCalls.push({ tenantId, mailboxId, ruleId, input, preview });
    const plan: MailboxRulePlan = {
      ...planFor("edit", { name: "Forward cover", forwardTo: input.forwardTo ?? null }),
      ruleId,
    };
    return preview ? plan : resultFor(plan, ruleId);
  }

  async deleteRule(
    tenantId: string,
    mailboxId: string,
    ruleId: string,
    preview: boolean,
  ): Promise<MailboxRuleResult | MailboxRulePlan> {
    this.deleteCalls.push({ tenantId, mailboxId, ruleId, preview });
    const plan: MailboxRulePlan = {
      ...planFor("delete", null),
      ruleId,
      before: { identity: ruleId, name: "Forward cover" },
    };
    return preview ? plan : resultFor(plan, ruleId);
  }
}

function readerCaller(): MailboxRulesCaller {
  return {
    tenantScope: tenantScope([TENANT]),
    permissions: [MAILBOX_RULES_READ_PERMISSION],
  };
}

function writerCaller(): MailboxRulesCaller {
  return {
    tenantScope: tenantScope([TENANT]),
    permissions: [MAILBOXES_WRITE_PERMISSION],
  };
}

describe("Mailbox rule routes (T-0385)", () => {
  it("exposes GET/POST rules and PATCH/DELETE rule paths", () => {
    const routes = createMailboxRuleRoutes({
      provider: new FakeMailboxRulesProvider(),
      resolveCaller: readerCaller,
    });
    expect(routes.map((route) => `${route.method} ${route.path}`)).toEqual([
      `GET ${MAILBOX_RULES_BASE_PATH}`,
      `POST ${MAILBOX_RULES_BASE_PATH}`,
      `PATCH ${MAILBOX_RULE_ITEM_PATH}`,
      `DELETE ${MAILBOX_RULE_ITEM_PATH}`,
    ]);
  });

  it("rejects unauthenticated requests with 401", async () => {
    const routes = createMailboxRuleRoutes({
      provider: new FakeMailboxRulesProvider(),
      resolveCaller: () => undefined,
    });

    await expect(
      routes[0]!.handler({
        method: "GET",
        path: `/v1/tenants/${TENANT}/mailboxes/${MAILBOX}/rules`,
        params: { tenantId: TENANT, mailboxId: MAILBOX },
        query: new URLSearchParams(),
        headers: {},
      }),
    ).rejects.toMatchObject({ status: 401 });
  });

  it("rejects tenant outside caller scope with 403", async () => {
    const routes = createMailboxRuleRoutes({
      provider: new FakeMailboxRulesProvider(),
      resolveCaller: () => ({
        tenantScope: tenantScope(["different-tenant"]),
        permissions: [MAILBOX_RULES_READ_PERMISSION],
      }),
    });

    await expect(
      routes[0]!.handler({
        method: "GET",
        path: `/v1/tenants/${TENANT}/mailboxes/${MAILBOX}/rules`,
        params: { tenantId: TENANT, mailboxId: MAILBOX },
        query: new URLSearchParams(),
        headers: {},
      }),
    ).rejects.toMatchObject({ status: 403 });
  });

  it("rejects callers missing Mailboxes.Mailbox.Read on GET with 403", async () => {
    const routes = createMailboxRuleRoutes({
      provider: new FakeMailboxRulesProvider(),
      resolveCaller: () => ({
        tenantScope: tenantScope([TENANT]),
        permissions: ["Identity.User.Read"],
      }),
    });

    await expect(
      routes[0]!.handler({
        method: "GET",
        path: `/v1/tenants/${TENANT}/mailboxes/${MAILBOX}/rules`,
        params: { tenantId: TENANT, mailboxId: MAILBOX },
        query: new URLSearchParams(),
        headers: {},
      }),
    ).rejects.toMatchObject({ status: 403 });
  });

  it("rejects callers missing Mailboxes.Mailbox.ReadWrite on writes with 403", async () => {
    const routes = createMailboxRuleRoutes({
      provider: new FakeMailboxRulesProvider(),
      resolveCaller: () => ({
        tenantScope: tenantScope([TENANT]),
        permissions: [MAILBOX_RULES_READ_PERMISSION],
      }),
    });

    await expect(
      routes[1]!.handler({
        method: "POST",
        path: `/v1/tenants/${TENANT}/mailboxes/${MAILBOX}/rules`,
        params: { tenantId: TENANT, mailboxId: MAILBOX },
        query: new URLSearchParams(),
        headers: {},
        body: { name: "Forward cover", forwardTo: "smtp:cover@example.com", confirm: true },
      }),
    ).rejects.toMatchObject({ status: 403 });
  });

  it("lists inbox rules and forwarding config for the mailbox", async () => {
    const provider = new FakeMailboxRulesProvider();
    const routes = createMailboxRuleRoutes({ provider, resolveCaller: readerCaller });

    const response = await routes[0]!.handler({
      method: "GET",
      path: `/v1/tenants/${TENANT}/mailboxes/${MAILBOX}/rules`,
      params: { tenantId: TENANT, mailboxId: MAILBOX },
      query: new URLSearchParams(),
      headers: {},
    });

    expect(response.status).toBe(200);
    const body = response.body as MailboxRulesListResponse;
    expect(body.mailboxId).toBe(MAILBOX);
    expect(body.rules).toHaveLength(1);
    expect(body.rules[0]?.name).toBe("Forward cover");
    expect(provider.listCalls[0]).toEqual({ tenantId: TENANT, mailboxId: MAILBOX });
  });

  it("surfaces the forwarding warning on a forwarding-enabling preview before apply", async () => {
    const provider = new FakeMailboxRulesProvider();
    const routes = createMailboxRuleRoutes({ provider, resolveCaller: writerCaller });

    const response = await routes[1]!.handler({
      method: "POST",
      path: `/v1/tenants/${TENANT}/mailboxes/${MAILBOX}/rules`,
      params: { tenantId: TENANT, mailboxId: MAILBOX },
      query: new URLSearchParams(),
      headers: {},
      body: { name: "Forward cover", forwardTo: "smtp:cover@example.com", preview: true },
    });

    expect(response.status).toBe(200);
    const body = response.body as MailboxRulePlan;
    expect(body.dryRun).toBe(true);
    expect(body.securitySensitive).toBe(true);
    expect(body.requiresConfirmation).toBe(true);
    expect(body.warning).toBe(FORWARDING_SENSITIVE_WARNING);
    expect(provider.createCalls[0]).toMatchObject({ tenantId: TENANT, preview: true });
  });

  it("refuses a forwarding-enabling apply without explicit confirmation", async () => {
    const provider = new FakeMailboxRulesProvider();
    const routes = createMailboxRuleRoutes({ provider, resolveCaller: writerCaller });

    await expect(
      routes[1]!.handler({
        method: "POST",
        path: `/v1/tenants/${TENANT}/mailboxes/${MAILBOX}/rules`,
        params: { tenantId: TENANT, mailboxId: MAILBOX },
        query: new URLSearchParams(),
        headers: {},
        body: { name: "Forward cover", forwardTo: "smtp:cover@example.com" },
      }),
    ).rejects.toMatchObject({ status: 400, code: MAILBOX_RULE_CONFIRM_REQUIRED });
    expect(provider.createCalls).toHaveLength(0);
  });

  it("applies a confirmed forwarding create with before/after and an audit event", async () => {
    const provider = new FakeMailboxRulesProvider();
    const routes = createMailboxRuleRoutes({ provider, resolveCaller: writerCaller });

    const response = await routes[1]!.handler({
      method: "POST",
      path: `/v1/tenants/${TENANT}/mailboxes/${MAILBOX}/rules`,
      params: { tenantId: TENANT, mailboxId: MAILBOX },
      query: new URLSearchParams(),
      headers: {},
      body: { name: "Forward cover", forwardTo: "smtp:cover@example.com", confirm: true },
    });

    expect(response.status).toBe(201);
    const body = response.body as MailboxRuleResult;
    expect(body.success).toBe(true);
    expect(body.plan.securitySensitive).toBe(true);
    expect(body.plan.warning).toBe(FORWARDING_SENSITIVE_WARNING);
    expect(body.plan.after).toMatchObject({ forwardTo: "smtp:cover@example.com" });
    expect(body.auditEvent?.action).toBe("mailbox.rule.create");
    expect(body.auditEvent?.after).toMatchObject({ forwardTo: "smtp:cover@example.com" });
    expect(provider.createCalls[0]).toMatchObject({ tenantId: TENANT, preview: false });
  });

  it("applies a non-forwarding create without confirmation", async () => {
    const provider = new FakeMailboxRulesProvider();
    const routes = createMailboxRuleRoutes({ provider, resolveCaller: writerCaller });

    const response = await routes[1]!.handler({
      method: "POST",
      path: `/v1/tenants/${TENANT}/mailboxes/${MAILBOX}/rules`,
      params: { tenantId: TENANT, mailboxId: MAILBOX },
      query: new URLSearchParams(),
      headers: {},
      body: { name: "File invoices" },
    });

    expect(response.status).toBe(201);
    const body = response.body as MailboxRuleResult;
    expect(body.success).toBe(true);
    expect(body.plan.securitySensitive).not.toBe(true);
    expect(body.plan.warning).toBeUndefined();
  });

  it("rejects create without a name with 400", async () => {
    const routes = createMailboxRuleRoutes({
      provider: new FakeMailboxRulesProvider(),
      resolveCaller: writerCaller,
    });

    await expect(
      routes[1]!.handler({
        method: "POST",
        path: `/v1/tenants/${TENANT}/mailboxes/${MAILBOX}/rules`,
        params: { tenantId: TENANT, mailboxId: MAILBOX },
        query: new URLSearchParams(),
        headers: {},
        body: { forwardTo: "smtp:cover@example.com", confirm: true },
      }),
    ).rejects.toMatchObject({ status: 400 });
  });

  it("flags a forwarding-enabling edit preview and refuses unconfirmed apply", async () => {
    const provider = new FakeMailboxRulesProvider();
    const routes = createMailboxRuleRoutes({ provider, resolveCaller: writerCaller });

    const preview = await routes[2]!.handler({
      method: "PATCH",
      path: `/v1/tenants/${TENANT}/mailboxes/${MAILBOX}/rules/rule-1`,
      params: { tenantId: TENANT, mailboxId: MAILBOX, ruleId: "rule-1" },
      query: new URLSearchParams(),
      headers: {},
      body: { redirectTo: "smtp:r@example.com", preview: true },
    });
    const previewBody = preview.body as MailboxRulePlan;
    expect(previewBody.securitySensitive).toBe(true);
    expect(previewBody.requiresConfirmation).toBe(true);
    expect(previewBody.warning).toBe(FORWARDING_SENSITIVE_WARNING);

    await expect(
      routes[2]!.handler({
        method: "PATCH",
        path: `/v1/tenants/${TENANT}/mailboxes/${MAILBOX}/rules/rule-1`,
        params: { tenantId: TENANT, mailboxId: MAILBOX, ruleId: "rule-1" },
        query: new URLSearchParams(),
        headers: {},
        body: { redirectTo: "smtp:r@example.com" },
      }),
    ).rejects.toMatchObject({ status: 400, code: MAILBOX_RULE_CONFIRM_REQUIRED });

    const applied = await routes[2]!.handler({
      method: "PATCH",
      path: `/v1/tenants/${TENANT}/mailboxes/${MAILBOX}/rules/rule-1`,
      params: { tenantId: TENANT, mailboxId: MAILBOX, ruleId: "rule-1" },
      query: new URLSearchParams(),
      headers: {},
      body: { redirectTo: "smtp:r@example.com", confirm: true },
    });
    const appliedBody = applied.body as MailboxRuleResult;
    expect(appliedBody.success).toBe(true);
    expect(appliedBody.auditEvent?.action).toBe("mailbox.rule.edit");
  });

  it("rejects an edit with no fields with 400", async () => {
    const routes = createMailboxRuleRoutes({
      provider: new FakeMailboxRulesProvider(),
      resolveCaller: writerCaller,
    });

    await expect(
      routes[2]!.handler({
        method: "PATCH",
        path: `/v1/tenants/${TENANT}/mailboxes/${MAILBOX}/rules/rule-1`,
        params: { tenantId: TENANT, mailboxId: MAILBOX, ruleId: "rule-1" },
        query: new URLSearchParams(),
        headers: {},
        body: {},
      }),
    ).rejects.toMatchObject({ status: 400 });
  });

  it("requires confirmation for rule removal and audits before/after", async () => {
    const provider = new FakeMailboxRulesProvider();
    const routes = createMailboxRuleRoutes({ provider, resolveCaller: writerCaller });

    await expect(
      routes[3]!.handler({
        method: "DELETE",
        path: `/v1/tenants/${TENANT}/mailboxes/${MAILBOX}/rules/rule-1`,
        params: { tenantId: TENANT, mailboxId: MAILBOX, ruleId: "rule-1" },
        query: new URLSearchParams(),
        headers: {},
        body: {},
      }),
    ).rejects.toMatchObject({ status: 400, code: MAILBOX_RULE_CONFIRM_REQUIRED });

    const response = await routes[3]!.handler({
      method: "DELETE",
      path: `/v1/tenants/${TENANT}/mailboxes/${MAILBOX}/rules/rule-1`,
      params: { tenantId: TENANT, mailboxId: MAILBOX, ruleId: "rule-1" },
      query: new URLSearchParams(),
      headers: {},
      body: { confirm: true },
    });

    expect(response.status).toBe(200);
    const body = response.body as MailboxRuleResult;
    expect(body.success).toBe(true);
    expect(body.plan.before).toMatchObject({ name: "Forward cover" });
    expect(body.auditEvent?.action).toBe("mailbox.rule.delete");
    expect(provider.deleteCalls[0]).toMatchObject({
      tenantId: TENANT,
      mailboxId: MAILBOX,
      ruleId: "rule-1",
      preview: false,
    });
  });
});
