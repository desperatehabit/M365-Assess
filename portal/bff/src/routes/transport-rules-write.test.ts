import { describe, expect, it } from "vitest";
import {
  buildTransportRuleJson,
  TRANSPORT_RULE_UNSUPPORTED_ACTION,
  TRANSPORT_RULE_UNSUPPORTED_CONDITION,
  type TransportRuleFieldInput,
} from "../domain/transport/rule-builder.js";
import { tenantScope } from "../rbac/scope.js";
import {
  TRANSPORT_RULES_ITEM_PATH,
  TRANSPORT_RULES_PATH,
  TRANSPORT_RULE_CONFIRM_REQUIRED,
  TRANSPORT_WRITE_PERMISSION,
  createTransportRulesWriteRoutes,
  type CreateTransportRuleInput,
  type EditTransportRuleInput,
  type TransportRulePlan,
  type TransportRuleResult,
  type TransportRulesWriteCaller,
  type TransportRulesWriteProvider,
} from "./transport-rules.js";

const TENANT = "tenant-test";
const RULE_ID = "rule-1";

const BEFORE_SNAPSHOT: Record<string, unknown> = {
  identity: RULE_ID,
  name: "Quarantine executables",
  enabled: true,
  priority: 0,
  conditions: { HasAttachment: true },
  actions: { Quarantine: true },
  exceptions: {},
};

function planFor(
  action: TransportRulePlan["action"],
  after: Record<string, unknown> | null,
  diff: string[],
): TransportRulePlan {
  return {
    action,
    ruleId: action === "create" ? undefined : RULE_ID,
    targetName: "Quarantine executables",
    before: action === "create" ? null : BEFORE_SNAPSHOT,
    after,
    diff,
    valid: true,
    dryRun: true,
    requiresConfirmation: false,
  };
}

function resultFor(plan: TransportRulePlan, ruleId: string): TransportRuleResult {
  return {
    success: true,
    plan: { ...plan, dryRun: false },
    result: { id: ruleId },
    auditEvent: {
      id: "audit-1",
      tenantId: TENANT,
      action: `transport.rule.${plan.action}`,
      targetId: ruleId,
      targetName: plan.targetName,
      timestamp: "2026-09-28T00:00:00.000Z",
      before: plan.before,
      after: plan.after,
    },
  };
}

class FakeTransportRulesWriteProvider implements TransportRulesWriteProvider {
  readonly createCalls: Array<{
    tenantId: string;
    input: CreateTransportRuleInput;
    preview: boolean;
  }> = [];
  readonly editCalls: Array<{
    tenantId: string;
    ruleId: string;
    input: EditTransportRuleInput;
    preview: boolean;
  }> = [];
  readonly deleteCalls: Array<{ tenantId: string; ruleId: string; preview: boolean }> = [];

  async createRule(
    tenantId: string,
    input: CreateTransportRuleInput,
    preview: boolean,
  ): Promise<TransportRuleResult | TransportRulePlan> {
    this.createCalls.push({ tenantId, input, preview });
    const ruleJson = buildTransportRuleJson(input) as unknown as Record<string, unknown>;
    const plan = planFor("create", ruleJson, [`create transport rule '${input.name}'`]);
    return preview ? plan : resultFor(plan, "rule-new");
  }

  async editRule(
    tenantId: string,
    ruleId: string,
    input: EditTransportRuleInput,
    preview: boolean,
  ): Promise<TransportRuleResult | TransportRulePlan> {
    this.editCalls.push({ tenantId, ruleId, input, preview });
    const merged = {
      name: input.name ?? (BEFORE_SNAPSHOT["name"] as string),
      enabled: input.enabled ?? (BEFORE_SNAPSHOT["enabled"] as boolean),
      priority: input.priority ?? (BEFORE_SNAPSHOT["priority"] as number),
      conditions:
        input.conditions ?? (BEFORE_SNAPSHOT["conditions"] as TransportRuleFieldInput),
      actions: input.actions ?? (BEFORE_SNAPSHOT["actions"] as TransportRuleFieldInput),
      exceptions: input.exceptions ?? (BEFORE_SNAPSHOT["exceptions"] as TransportRuleFieldInput),
    };
    const ruleJson = buildTransportRuleJson(merged) as unknown as Record<string, unknown>;
    const diff: string[] = [];
    if (input.priority !== undefined && input.priority !== BEFORE_SNAPSHOT["priority"]) {
      diff.push(
        `set priority from '${BEFORE_SNAPSHOT["priority"]}' to '${input.priority}' on rule '${merged.name}'`,
      );
    }
    if (input.enabled !== undefined && input.enabled !== BEFORE_SNAPSHOT["enabled"]) {
      diff.push(`set enabled to '${input.enabled}' on rule '${merged.name}'`);
    }
    if (input.name !== undefined && input.name !== BEFORE_SNAPSHOT["name"]) {
      diff.push(`set name to '${input.name}'`);
    }
    if (diff.length === 0) {
      diff.push(`edit transport rule '${merged.name}'`);
    }
    const plan = planFor("edit", ruleJson, diff);
    return preview ? plan : resultFor(plan, ruleId);
  }

  async deleteRule(
    tenantId: string,
    ruleId: string,
    preview: boolean,
  ): Promise<TransportRuleResult | TransportRulePlan> {
    this.deleteCalls.push({ tenantId, ruleId, preview });
    const plan = planFor("delete", null, [
      `remove transport rule '${BEFORE_SNAPSHOT["name"]}' (${ruleId})`,
    ]);
    return preview ? plan : resultFor(plan, ruleId);
  }
}

function writerCaller(): TransportRulesWriteCaller {
  return {
    tenantScope: tenantScope([TENANT]),
    permissions: [TRANSPORT_WRITE_PERMISSION],
  };
}

function readCaller(): TransportRulesWriteCaller {
  return {
    tenantScope: tenantScope([TENANT]),
    permissions: ["transport.read"],
  };
}

describe("Transport rule write routes (T-0402)", () => {
  it("exposes POST rules and PATCH/DELETE rule paths", () => {
    const routes = createTransportRulesWriteRoutes({
      provider: new FakeTransportRulesWriteProvider(),
      resolveCaller: writerCaller,
    });
    expect(routes.map((route) => `${route.method} ${route.path}`)).toEqual([
      `POST ${TRANSPORT_RULES_PATH}`,
      `PATCH ${TRANSPORT_RULES_ITEM_PATH}`,
      `DELETE ${TRANSPORT_RULES_ITEM_PATH}`,
    ]);
  });

  it("rejects unauthenticated requests with 401", async () => {
    const routes = createTransportRulesWriteRoutes({
      provider: new FakeTransportRulesWriteProvider(),
      resolveCaller: () => undefined,
    });

    await expect(
      routes[0]!.handler({
        method: "POST",
        path: `/v1/tenants/${TENANT}/transport-rules`,
        params: { tenantId: TENANT },
        query: new URLSearchParams(),
        headers: {},
        body: { name: "Quarantine executables", confirm: true },
      }),
    ).rejects.toMatchObject({ status: 401 });
  });

  it("rejects tenant outside caller scope with 403", async () => {
    const routes = createTransportRulesWriteRoutes({
      provider: new FakeTransportRulesWriteProvider(),
      resolveCaller: () => ({
        tenantScope: tenantScope(["tenant-other"]),
        permissions: [TRANSPORT_WRITE_PERMISSION],
      }),
    });

    await expect(
      routes[0]!.handler({
        method: "POST",
        path: `/v1/tenants/${TENANT}/transport-rules`,
        params: { tenantId: TENANT },
        query: new URLSearchParams(),
        headers: {},
        body: { name: "Quarantine executables", confirm: true },
      }),
    ).rejects.toMatchObject({ status: 403 });
  });

  it("rejects callers missing transport.write on writes with 403", async () => {
    const routes = createTransportRulesWriteRoutes({
      provider: new FakeTransportRulesWriteProvider(),
      resolveCaller: readCaller,
    });

    await expect(
      routes[0]!.handler({
        method: "POST",
        path: `/v1/tenants/${TENANT}/transport-rules`,
        params: { tenantId: TENANT },
        query: new URLSearchParams(),
        headers: {},
        body: { name: "Quarantine executables", confirm: true },
      }),
    ).rejects.toMatchObject({ status: 403 });
  });

  it("previews a create with the rule JSON and makes no tenant write", async () => {
    const provider = new FakeTransportRulesWriteProvider();
    const routes = createTransportRulesWriteRoutes({ provider, resolveCaller: writerCaller });

    const response = await routes[0]!.handler({
      method: "POST",
      path: `/v1/tenants/${TENANT}/transport-rules`,
      params: { tenantId: TENANT },
      query: new URLSearchParams(),
      headers: {},
      body: {
        name: "Quarantine executables",
        conditions: { HasAttachment: true, AttachmentExtensionMatchesWords: ["exe", "bat"] },
        actions: { Quarantine: true },
        preview: true,
      },
    });

    expect(response.status).toBe(200);
    const body = response.body as TransportRulePlan;
    expect(body.action).toBe("create");
    expect(body.dryRun).toBe(true);
    expect(body.after).toMatchObject({
      name: "Quarantine executables",
      enabled: true,
      priority: 0,
    });
    expect(body.after?.["parameters"]).toMatchObject({
      HasAttachment: true,
      AttachmentExtensionMatchesWords: ["exe", "bat"],
      Quarantine: true,
    });
    expect(provider.createCalls[0]).toMatchObject({ tenantId: TENANT, preview: true });
  });

  it("refuses a create apply without explicit confirmation", async () => {
    const provider = new FakeTransportRulesWriteProvider();
    const routes = createTransportRulesWriteRoutes({ provider, resolveCaller: writerCaller });

    await expect(
      routes[0]!.handler({
        method: "POST",
        path: `/v1/tenants/${TENANT}/transport-rules`,
        params: { tenantId: TENANT },
        query: new URLSearchParams(),
        headers: {},
        body: { name: "Quarantine executables" },
      }),
    ).rejects.toMatchObject({ status: 400, code: TRANSPORT_RULE_CONFIRM_REQUIRED });
    expect(provider.createCalls).toHaveLength(0);
  });

  it("applies a confirmed create with before/after and an audit event", async () => {
    const provider = new FakeTransportRulesWriteProvider();
    const routes = createTransportRulesWriteRoutes({ provider, resolveCaller: writerCaller });

    const response = await routes[0]!.handler({
      method: "POST",
      path: `/v1/tenants/${TENANT}/transport-rules`,
      params: { tenantId: TENANT },
      query: new URLSearchParams(),
      headers: {},
      body: { name: "Quarantine executables", actions: { Quarantine: true }, confirm: true },
    });

    expect(response.status).toBe(201);
    const body = response.body as TransportRuleResult;
    expect(body.success).toBe(true);
    expect(body.plan.dryRun).toBe(false);
    expect(body.auditEvent?.action).toBe("transport.rule.create");
    expect(body.auditEvent?.targetId).toBe("rule-new");
    expect(body.auditEvent?.after).toMatchObject({ name: "Quarantine executables" });
    expect(provider.createCalls[0]).toMatchObject({ tenantId: TENANT, preview: false });
  });

  it("rejects a create without a name with 400", async () => {
    const routes = createTransportRulesWriteRoutes({
      provider: new FakeTransportRulesWriteProvider(),
      resolveCaller: writerCaller,
    });

    await expect(
      routes[0]!.handler({
        method: "POST",
        path: `/v1/tenants/${TENANT}/transport-rules`,
        params: { tenantId: TENANT },
        query: new URLSearchParams(),
        headers: {},
        body: { actions: { Quarantine: true }, confirm: true },
      }),
    ).rejects.toMatchObject({ status: 400 });
  });

  it("rejects an unsupported condition with a structured error and no write", async () => {
    const provider = new FakeTransportRulesWriteProvider();
    const routes = createTransportRulesWriteRoutes({ provider, resolveCaller: writerCaller });

    await expect(
      routes[0]!.handler({
        method: "POST",
        path: `/v1/tenants/${TENANT}/transport-rules`,
        params: { tenantId: TENANT },
        query: new URLSearchParams(),
        headers: {},
        body: {
          name: "Bad condition",
          conditions: { FromMemberOfExecutive: ["execs@example.invalid"] },
          preview: true,
        },
      }),
    ).rejects.toMatchObject({
      status: 400,
      code: TRANSPORT_RULE_UNSUPPORTED_CONDITION,
      details: [{ field: "FromMemberOfExecutive", reason: "unsupported" }],
    });
    expect(provider.createCalls).toHaveLength(0);
  });

  it("rejects an unsupported action with a structured error", async () => {
    const routes = createTransportRulesWriteRoutes({
      provider: new FakeTransportRulesWriteProvider(),
      resolveCaller: writerCaller,
    });

    await expect(
      routes[0]!.handler({
        method: "POST",
        path: `/v1/tenants/${TENANT}/transport-rules`,
        params: { tenantId: TENANT },
        query: new URLSearchParams(),
        headers: {},
        body: { name: "Bad action", actions: { HardDeleteMessage: true }, preview: true },
      }),
    ).rejects.toMatchObject({ status: 400, code: TRANSPORT_RULE_UNSUPPORTED_ACTION });
  });

  it("previews a priority change with the rule JSON and an explicit diff", async () => {
    const provider = new FakeTransportRulesWriteProvider();
    const routes = createTransportRulesWriteRoutes({ provider, resolveCaller: writerCaller });

    const response = await routes[1]!.handler({
      method: "PATCH",
      path: `/v1/tenants/${TENANT}/transport-rules/${RULE_ID}`,
      params: { tenantId: TENANT, ruleId: RULE_ID },
      query: new URLSearchParams(),
      headers: {},
      body: { priority: 2, preview: true },
    });

    expect(response.status).toBe(200);
    const body = response.body as TransportRulePlan;
    expect(body.action).toBe("edit");
    expect(body.dryRun).toBe(true);
    expect(body.after?.["priority"]).toBe(2);
    expect(body.before).toMatchObject({ name: "Quarantine executables", priority: 0 });
    expect(body.diff.join(" ")).toMatch(/priority/);
    expect(provider.editCalls[0]).toMatchObject({ tenantId: TENANT, ruleId: RULE_ID, preview: true });
  });

  it("previews an enable/disable change with before/after state", async () => {
    const provider = new FakeTransportRulesWriteProvider();
    const routes = createTransportRulesWriteRoutes({ provider, resolveCaller: writerCaller });

    const response = await routes[1]!.handler({
      method: "PATCH",
      path: `/v1/tenants/${TENANT}/transport-rules/${RULE_ID}`,
      params: { tenantId: TENANT, ruleId: RULE_ID },
      query: new URLSearchParams(),
      headers: {},
      body: { enabled: false, preview: true },
    });

    const body = response.body as TransportRulePlan;
    expect(body.after?.["enabled"]).toBe(false);
    expect(body.before).toMatchObject({ enabled: true });
    expect(body.diff.join(" ")).toMatch(/enabled/);
  });

  it("refuses an edit apply without explicit confirmation", async () => {
    const provider = new FakeTransportRulesWriteProvider();
    const routes = createTransportRulesWriteRoutes({ provider, resolveCaller: writerCaller });

    await expect(
      routes[1]!.handler({
        method: "PATCH",
        path: `/v1/tenants/${TENANT}/transport-rules/${RULE_ID}`,
        params: { tenantId: TENANT, ruleId: RULE_ID },
        query: new URLSearchParams(),
        headers: {},
        body: { priority: 3 },
      }),
    ).rejects.toMatchObject({ status: 400, code: TRANSPORT_RULE_CONFIRM_REQUIRED });
    expect(provider.editCalls).toHaveLength(0);
  });

  it("applies a confirmed edit with before/after and an audit event", async () => {
    const provider = new FakeTransportRulesWriteProvider();
    const routes = createTransportRulesWriteRoutes({ provider, resolveCaller: writerCaller });

    const response = await routes[1]!.handler({
      method: "PATCH",
      path: `/v1/tenants/${TENANT}/transport-rules/${RULE_ID}`,
      params: { tenantId: TENANT, ruleId: RULE_ID },
      query: new URLSearchParams(),
      headers: {},
      body: { priority: 1, confirm: true },
    });

    expect(response.status).toBe(200);
    const body = response.body as TransportRuleResult;
    expect(body.success).toBe(true);
    expect(body.auditEvent?.action).toBe("transport.rule.edit");
    expect(body.auditEvent?.targetId).toBe(RULE_ID);
    expect(body.auditEvent?.before).toMatchObject({ priority: 0 });
    expect(body.auditEvent?.after).toMatchObject({ priority: 1 });
    expect(provider.editCalls[0]).toMatchObject({ tenantId: TENANT, ruleId: RULE_ID, preview: false });
  });

  it("rejects an edit with no fields with 400", async () => {
    const routes = createTransportRulesWriteRoutes({
      provider: new FakeTransportRulesWriteProvider(),
      resolveCaller: writerCaller,
    });

    await expect(
      routes[1]!.handler({
        method: "PATCH",
        path: `/v1/tenants/${TENANT}/transport-rules/${RULE_ID}`,
        params: { tenantId: TENANT, ruleId: RULE_ID },
        query: new URLSearchParams(),
        headers: {},
        body: {},
      }),
    ).rejects.toMatchObject({ status: 400 });
  });

  it("previews a delete with the current rule as before", async () => {
    const provider = new FakeTransportRulesWriteProvider();
    const routes = createTransportRulesWriteRoutes({ provider, resolveCaller: writerCaller });

    const response = await routes[2]!.handler({
      method: "DELETE",
      path: `/v1/tenants/${TENANT}/transport-rules/${RULE_ID}`,
      params: { tenantId: TENANT, ruleId: RULE_ID },
      query: new URLSearchParams(),
      headers: {},
      body: { preview: true },
    });

    expect(response.status).toBe(200);
    const body = response.body as TransportRulePlan;
    expect(body.action).toBe("delete");
    expect(body.dryRun).toBe(true);
    expect(body.before).toMatchObject({ name: "Quarantine executables" });
    expect(body.after).toBeNull();
    expect(provider.deleteCalls[0]).toMatchObject({ tenantId: TENANT, ruleId: RULE_ID, preview: true });
  });

  it("refuses a delete apply without explicit confirmation", async () => {
    const provider = new FakeTransportRulesWriteProvider();
    const routes = createTransportRulesWriteRoutes({ provider, resolveCaller: writerCaller });

    await expect(
      routes[2]!.handler({
        method: "DELETE",
        path: `/v1/tenants/${TENANT}/transport-rules/${RULE_ID}`,
        params: { tenantId: TENANT, ruleId: RULE_ID },
        query: new URLSearchParams(),
        headers: {},
        body: {},
      }),
    ).rejects.toMatchObject({ status: 400, code: TRANSPORT_RULE_CONFIRM_REQUIRED });
    expect(provider.deleteCalls).toHaveLength(0);
  });

  it("applies a confirmed delete with before/after and an audit event", async () => {
    const provider = new FakeTransportRulesWriteProvider();
    const routes = createTransportRulesWriteRoutes({ provider, resolveCaller: writerCaller });

    const response = await routes[2]!.handler({
      method: "DELETE",
      path: `/v1/tenants/${TENANT}/transport-rules/${RULE_ID}`,
      params: { tenantId: TENANT, ruleId: RULE_ID },
      query: new URLSearchParams(),
      headers: {},
      body: { confirm: true },
    });

    expect(response.status).toBe(200);
    const body = response.body as TransportRuleResult;
    expect(body.success).toBe(true);
    expect(body.auditEvent?.action).toBe("transport.rule.delete");
    expect(body.auditEvent?.targetId).toBe(RULE_ID);
    expect(body.auditEvent?.before).toMatchObject({ name: "Quarantine executables" });
    expect(body.auditEvent?.after).toBeNull();
    expect(provider.deleteCalls[0]).toMatchObject({ tenantId: TENANT, ruleId: RULE_ID, preview: false });
  });
});
