import { describe, expect, it, vi } from "vitest";
import { normalizeError, toErrorBody } from "../errors.js";
import { tenantScope } from "../rbac/scope.js";
import type { Route, RouteResponse } from "../server.js";
import type {
  TransportTemplateApplyRequest,
  TransportTemplateDeployExecutor,
} from "../domain/transport/template-deploy.js";
import {
  CONNECTOR_TEMPLATE_DEPLOY_PATH,
  REMEDIATION_APPLY_PERMISSION,
  createConnectorTemplateRoutes,
  type ConnectorTemplateRequestContext,
  type ConnectorTemplateStore,
  type StoredConnectorTemplate,
} from "./connector-templates.js";
import {
  TRANSPORT_RULE_TEMPLATE_DEPLOY_PATH,
  createTransportRuleTemplateRoutes,
  type StoredTransportRuleTemplate,
  type TransportRuleTemplateRequestContext,
  type TransportRuleTemplateStore,
} from "./transport-rule-templates.js";

const TENANT_A = "tenant-a";
const TENANT_B = "tenant-b";

const RULE_JSON = {
  name: "Block mail to %partnerDomain%",
  conditions: { recipientDomainIs: ["%partnerDomain%"] },
  actions: { rejectMessage: "%rejectText%" },
};

const CONNECTOR_JSON = {
  name: "Partner %partnerDomain%",
  type: "inbound",
  senderDomains: ["%partnerDomain%"],
};

function ruleTemplate(): StoredTransportRuleTemplate {
  return {
    id: "tpl-rule-1",
    name: "Block partner mail",
    ruleJson: RULE_JSON,
    variables: [{ name: "partnerDomain" }, { name: "rejectText", defaultValue: "Not allowed" }],
    source: "local",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    deletedAt: null,
  };
}

function connectorTemplate(): StoredConnectorTemplate {
  return {
    id: "tpl-conn-1",
    name: "Partner inbound",
    connectorJson: CONNECTOR_JSON,
    variables: [{ name: "partnerDomain" }],
    source: "local",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    deletedAt: null,
  };
}

function ruleStore(template: StoredTransportRuleTemplate): TransportRuleTemplateStore {
  return {
    createTemplate: async () => template,
    getTemplate: async (id) => (id === template.id ? template : undefined),
    listTemplates: async () => [template],
    updateTemplate: async () => template,
    softDeleteTemplate: async () => false,
    cloneTemplate: async () => template,
  };
}

function connectorStore(template: StoredConnectorTemplate): ConnectorTemplateStore {
  return {
    createTemplate: async () => template,
    getTemplate: async (id) => (id === template.id ? template : undefined),
    listTemplates: async () => [template],
    updateTemplate: async () => template,
    softDeleteTemplate: async () => false,
    cloneTemplate: async () => template,
  };
}

function handlerFor(routes: readonly Route[], method: string, path: string): Route {
  const route = routes.find((candidate) => candidate.method === method && candidate.path === path);
  if (!route) throw new Error(`no ${method} ${path} route`);
  return route;
}

async function invoke(
  route: Route,
  ctx: TransportRuleTemplateRequestContext | ConnectorTemplateRequestContext,
): Promise<RouteResponse> {
  try {
    return await route.handler(ctx);
  } catch (error) {
    const appError = normalizeError(error);
    return { status: appError.status, body: toErrorBody(appError, ctx.correlationId) };
  }
}

function context(
  overrides: Partial<TransportRuleTemplateRequestContext> = {},
): TransportRuleTemplateRequestContext & ConnectorTemplateRequestContext {
  return {
    correlationId: "corr-test",
    method: "POST",
    path: "/v1/transport-rule-templates/tpl/deploy",
    query: new URLSearchParams(),
    headers: {},
    params: {},
    ...overrides,
  };
}

const CALLER = {
  roles: [] as const,
  tenantScope: tenantScope([TENANT_A, TENANT_B]),
  userId: "operator-1",
};

function auditCapturingExecutor(
  apply: (request: TransportTemplateApplyRequest) => Promise<{
    before?: Record<string, unknown> | null;
    after?: Record<string, unknown> | null;
    auditEvent: Record<string, unknown>;
  }>,
): TransportTemplateDeployExecutor {
  return { apply: vi.fn(apply) };
}

describe("transport template deploy routes (T-0406)", () => {
  it("previews the resolved transport rule and plan without applying", async () => {
    const executor = auditCapturingExecutor(async () => ({
      auditEvent: { id: "should-not-run" },
    }));
    const routes = createTransportRuleTemplateRoutes({
      store: ruleStore(ruleTemplate()),
      deployExecutor: executor,
      resolveCaller: () => CALLER,
    });

    const response = await invoke(
      handlerFor(routes, "POST", TRANSPORT_RULE_TEMPLATE_DEPLOY_PATH),
      context({
        params: { id: "tpl-rule-1" },
        query: new URLSearchParams("preview=true"),
        body: { targets: [TENANT_A], variables: { partnerDomain: "partner.example.invalid" } },
      }),
    );

    expect(response.status).toBe(200);
    const body = response.body as Record<string, unknown>;
    expect(body["preview"]).toBe(true);
    expect(body["payload"]).toEqual({
      name: "Block mail to partner.example.invalid",
      conditions: { recipientDomainIs: ["partner.example.invalid"] },
      actions: { rejectMessage: "Not allowed" },
    });
    expect((body["targets"] as Array<{ tenantId: string }>)[0]?.tenantId).toBe(TENANT_A);
    expect(executor.apply).not.toHaveBeenCalled();
  });

  it("rejects a missing required variable before touching any target", async () => {
    const executor = auditCapturingExecutor(async () => ({ auditEvent: { id: "no" } }));
    const recordAudit = vi.fn(async () => {});
    const routes = createTransportRuleTemplateRoutes({
      store: ruleStore(ruleTemplate()),
      deployExecutor: executor,
      resolveCaller: () => CALLER,
      recordAudit,
    });

    const response = await invoke(
      handlerFor(routes, "POST", TRANSPORT_RULE_TEMPLATE_DEPLOY_PATH),
      context({
        params: { id: "tpl-rule-1" },
        body: { targets: [TENANT_A, TENANT_B], variables: {} },
      }),
    );

    expect(response.status).toBe(400);
    expect((response.body as Record<string, unknown>)["code"]).toBe(
      "transport_template.missing_variable",
    );
    expect(executor.apply).not.toHaveBeenCalled();
    expect(recordAudit).not.toHaveBeenCalled();
  });

  it("reports a per-target failure without aborting the remaining targets and audits each apply", async () => {
    const audits: Array<Record<string, unknown>> = [];
    const executor = auditCapturingExecutor(async (applyRequest) => {
      if (applyRequest.tenantId === TENANT_B) {
        throw new Error("EXO rejected the rule");
      }
      return {
        before: { name: "before" },
        after: { name: applyRequest.name },
        auditEvent: { id: `audit-${applyRequest.tenantId}`, action: "transport.rule.create" },
      };
    });
    const routes = createTransportRuleTemplateRoutes({
      store: ruleStore(ruleTemplate()),
      deployExecutor: executor,
      resolveCaller: () => CALLER,
      recordAudit: async (event) => {
        audits.push(event);
      },
    });

    const response = await invoke(
      handlerFor(routes, "POST", TRANSPORT_RULE_TEMPLATE_DEPLOY_PATH),
      context({
        params: { id: "tpl-rule-1" },
        body: {
          targets: [TENANT_A, TENANT_B],
          variables: { partnerDomain: "partner.example.invalid" },
        },
      }),
    );

    expect(response.status).toBe(207);
    const body = response.body as Record<string, unknown>;
    expect(body["success"]).toBe(false);
    const results = body["results"] as Array<Record<string, unknown>>;
    expect(results).toHaveLength(2);
    expect(results[0]).toMatchObject({ tenantId: TENANT_A, success: true });
    expect(results[1]).toMatchObject({
      tenantId: TENANT_B,
      success: false,
      error: "EXO rejected the rule",
    });
    expect(executor.apply).toHaveBeenCalledTimes(2);
    expect(audits).toHaveLength(1);
    expect(audits[0]?.["id"]).toBe(`audit-${TENANT_A}`);
  });

  it("rejects a target outside the caller scope before applying", async () => {
    const executor = auditCapturingExecutor(async () => ({ auditEvent: { id: "no" } }));
    const routes = createTransportRuleTemplateRoutes({
      store: ruleStore(ruleTemplate()),
      deployExecutor: executor,
      resolveCaller: () => ({
        roles: [],
        tenantScope: tenantScope([TENANT_A]),
        userId: "operator-1",
      }),
    });

    const response = await invoke(
      handlerFor(routes, "POST", TRANSPORT_RULE_TEMPLATE_DEPLOY_PATH),
      context({
        params: { id: "tpl-rule-1" },
        body: {
          targets: [TENANT_A, TENANT_B],
          variables: { partnerDomain: "partner.example.invalid" },
        },
      }),
    );

    expect(response.status).toBe(403);
    expect(executor.apply).not.toHaveBeenCalled();
  });

  it("deploys a connector per target through the gate and writes an AuditEvent for each", async () => {
    const audits: Array<Record<string, unknown>> = [];
    const executor = auditCapturingExecutor(async (applyRequest) => ({
      before: null,
      after: { name: applyRequest.name },
      auditEvent: { id: `audit-${applyRequest.tenantId}`, action: "connector.create" },
    }));
    const routes = createConnectorTemplateRoutes({
      store: connectorStore(connectorTemplate()),
      deployExecutor: executor,
      resolveCaller: () => CALLER,
      recordAudit: async (event) => {
        audits.push(event);
      },
    });

    const response = await invoke(
      handlerFor(routes, "POST", CONNECTOR_TEMPLATE_DEPLOY_PATH),
      context({
        params: { id: "tpl-conn-1" },
        body: {
          targets: [TENANT_A, TENANT_B],
          variables: { partnerDomain: "partner.example.invalid" },
        },
      }),
    );

    expect(response.status).toBe(200);
    const body = response.body as Record<string, unknown>;
    expect(body["success"]).toBe(true);
    expect(body["kind"]).toBe("connector");
    expect((body["payload"] as Record<string, unknown>)["name"]).toBe(
      "Partner partner.example.invalid",
    );
    expect(executor.apply).toHaveBeenCalledTimes(2);
    expect(audits.map((event) => event["id"])).toEqual([
      `audit-${TENANT_A}`,
      `audit-${TENANT_B}`,
    ]);
  });

  it("gates the deploy behind Exchange.Transport.ReadWrite", async () => {
    const executor = auditCapturingExecutor(async () => ({ auditEvent: { id: "no" } }));
    const routes = createConnectorTemplateRoutes({
      store: connectorStore(connectorTemplate()),
      deployExecutor: executor,
      resolveCaller: () => CALLER,
      authorize: () => false,
    });

    const response = await invoke(
      handlerFor(routes, "POST", CONNECTOR_TEMPLATE_DEPLOY_PATH),
      context({
        params: { id: "tpl-conn-1" },
        body: { targets: [TENANT_A], variables: { partnerDomain: "partner.example.invalid" } },
      }),
    );

    expect(response.status).toBe(403);
    expect(executor.apply).not.toHaveBeenCalled();
  });

  it("accepts the EPIC-006 Remediation.Apply permission for a deploy", async () => {
    const executor = auditCapturingExecutor(async (applyRequest) => ({
      auditEvent: { id: `audit-${applyRequest.tenantId}` },
    }));
    const routes = createConnectorTemplateRoutes({
      store: connectorStore(connectorTemplate()),
      deployExecutor: executor,
      resolveCaller: () => CALLER,
    });

    const response = await invoke(
      handlerFor(routes, "POST", CONNECTOR_TEMPLATE_DEPLOY_PATH),
      context({
        params: { id: "tpl-conn-1" },
        permissions: [REMEDIATION_APPLY_PERMISSION],
        body: { targets: [TENANT_A], variables: { partnerDomain: "partner.example.invalid" } },
      }),
    );

    expect(response.status).toBe(200);
    expect(executor.apply).toHaveBeenCalledTimes(1);
  });
});
