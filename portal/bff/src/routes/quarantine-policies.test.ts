// T-0428 — Quarantine notification and permission policy route gating.
// Route-level tests: the read route serves the §3.5 columns live from EXO
// through the injected provider; the write routes validate Exchange.Quarantine.ReadWrite +
// tenant scope, build a before/after plan with the affected entries shown
// before apply, flag deleting/weakening changes as security-impacting,
// require confirmation for them, support plan preview (preview:true) with
// no tenant write, and enqueue the EPIC-006 gated job with an audit event
// on apply.

import { describe, expect, it } from "vitest";
import { tenantScope } from "../rbac/scope.js";
import type { JobEnvelope } from "@m365-assess/contracts";
import type { RequestContext } from "../server.js";
import {
  QUARANTINE_POLICIES_CONFIRM_REQUIRED,
  QUARANTINE_POLICIES_ITEM_PATH,
  QUARANTINE_POLICIES_NOT_FOUND,
  QUARANTINE_POLICIES_PATH,
  QUARANTINE_POLICIES_READ_PERMISSION,
  QUARANTINE_POLICIES_WRITE_PERMISSION,
  REMEDIATION_APPLY_PERMISSION,
  createQuarantinePoliciesRoutes,
  parseQuarantinePolicyType,
  type QuarantinePolicyPlan,
  type QuarantinePolicyState,
  type QuarantinePoliciesCaller,
  type QuarantinePoliciesPage,
  type QuarantinePoliciesProvider,
  type QuarantinePolicyType,
} from "./quarantine-policies.js";

const TENANT = "tenant-test";

const NOTIFICATION_POLICY = {
  name: "Default notification policy",
  policyType: "notification" as const,
  esnEnabled: true,
  quarantineRetentionPeriod: 15,
  addressForMessages: "",
  lastModified: "2026-09-20T12:00:00Z",
};

const PERMISSION_POLICY = {
  name: "Default permission policy",
  policyType: "permission" as const,
  esnEnabled: false,
  quarantineRetentionPeriod: 15,
  addressForMessages: "",
  lastModified: "2026-09-18T08:00:00Z",
};

const NOTIFICATION_STATE: QuarantinePolicyState = {
  name: "Default notification policy",
  policyType: "notification",
  settings: {
    esnEnabled: true,
    quarantineRetentionPeriod: 15,
    addressForMessages: "",
  },
};

class FakeQuarantinePoliciesProvider implements QuarantinePoliciesProvider {
  readonly getPolicyCalls: Array<{ tenantId: string; policyType: QuarantinePolicyType; policyName: string }> = [];

  async listPolicies(tenantId: string): Promise<QuarantinePoliciesPage> {
    return {
      tenantId,
      items: [NOTIFICATION_POLICY, PERMISSION_POLICY],
      totalCount: 2,
      retrievedAt: "2026-09-28T00:00:00.000Z",
    };
  }

  async getPolicy(
    tenantId: string,
    policyType: QuarantinePolicyType,
    policyName: string,
  ): Promise<QuarantinePolicyState | undefined> {
    this.getPolicyCalls.push({ tenantId, policyType, policyName });
    if (policyType === "notification" && policyName === NOTIFICATION_STATE.name) {
      return NOTIFICATION_STATE;
    }
    return undefined;
  }
}

class FakeQueue {
  readonly enqueued: JobEnvelope[] = [];

  async enqueue(envelope: JobEnvelope): Promise<string> {
    this.enqueued.push(envelope);
    return envelope.jobId;
  }
}

function writerCaller(): QuarantinePoliciesCaller {
  return {
    tenantScope: tenantScope([TENANT]),
    permissions: [QUARANTINE_POLICIES_WRITE_PERMISSION],
    userId: "user-1",
  };
}

function readerCaller(): QuarantinePoliciesCaller {
  return {
    tenantScope: tenantScope([TENANT]),
    permissions: [QUARANTINE_POLICIES_READ_PERMISSION],
  };
}

function routeByPath(routes: ReturnType<typeof createQuarantinePoliciesRoutes>, method: string, path: string) {
  const route = routes.find((r) => r.method === method && r.path === path);
  if (!route) throw new Error(`missing route ${method} ${path}`);
  return route;
}

function ctx(
  path: string,
  options: { params?: Record<string, string>; body?: Record<string, unknown>; query?: Record<string, string> } = {},
): RequestContext & { body?: unknown } {
  const query = new URLSearchParams(options.query ?? {});
  return {
    correlationId: "corr-quarantine-1",
    method: "GET",
    path,
    query,
    headers: {},
    params: options.params ?? {},
    ...(options.body !== undefined ? { body: options.body } : {}),
  };
}

describe("Quarantine policy routes (T-0428)", () => {
  it("exposes the read and write paths", () => {
    const routes = createQuarantinePoliciesRoutes({
      provider: new FakeQuarantinePoliciesProvider(),
      queue: new FakeQueue(),
      resolveCaller: writerCaller,
    });
    expect(routes.map((route) => `${route.method} ${route.path}`)).toEqual([
      `GET ${QUARANTINE_POLICIES_PATH}`,
      `POST ${QUARANTINE_POLICIES_PATH}`,
      `PATCH ${QUARANTINE_POLICIES_ITEM_PATH}`,
      `DELETE ${QUARANTINE_POLICIES_ITEM_PATH}`,
    ]);
  });

  it("rejects unauthenticated requests with 401", async () => {
    const routes = createQuarantinePoliciesRoutes({
      provider: new FakeQuarantinePoliciesProvider(),
      resolveCaller: () => undefined,
    });
    await expect(
      routeByPath(routes, "GET", QUARANTINE_POLICIES_PATH).handler(
        ctx(`/v1/tenants/${TENANT}/quarantine-policies`, {
          params: { tenantId: TENANT },
        }),
      ),
    ).rejects.toMatchObject({ status: 401 });
  });

  it("rejects tenant outside caller scope with 403", async () => {
    const routes = createQuarantinePoliciesRoutes({
      provider: new FakeQuarantinePoliciesProvider(),
      resolveCaller: () => ({
        tenantScope: tenantScope(["different-tenant"]),
        permissions: [QUARANTINE_POLICIES_READ_PERMISSION],
      }),
    });
    await expect(
      routeByPath(routes, "GET", QUARANTINE_POLICIES_PATH).handler(
        ctx(`/v1/tenants/${TENANT}/quarantine-policies`, {
          params: { tenantId: TENANT },
        }),
      ),
    ).rejects.toMatchObject({ status: 403 });
  });

  it("rejects reads without Exchange.Quarantine.Read with 403", async () => {
    const routes = createQuarantinePoliciesRoutes({
      provider: new FakeQuarantinePoliciesProvider(),
      resolveCaller: () => ({
        tenantScope: tenantScope([TENANT]),
        permissions: [QUARANTINE_POLICIES_WRITE_PERMISSION],
      }),
    });
    await expect(
      routeByPath(routes, "GET", QUARANTINE_POLICIES_PATH).handler(
        ctx(`/v1/tenants/${TENANT}/quarantine-policies`, {
          params: { tenantId: TENANT },
        }),
      ),
    ).rejects.toMatchObject({ status: 403 });
  });

  it("rejects writes without Exchange.Quarantine.ReadWrite with 403", async () => {
    const routes = createQuarantinePoliciesRoutes({
      provider: new FakeQuarantinePoliciesProvider(),
      queue: new FakeQueue(),
      resolveCaller: readerCaller,
    });
    await expect(
      routeByPath(routes, "POST", QUARANTINE_POLICIES_PATH).handler(
        ctx(`/v1/tenants/${TENANT}/quarantine-policies`, {
          params: { tenantId: TENANT },
          body: { name: "New", policyType: "notification" },
        }),
      ),
    ).rejects.toMatchObject({ status: 403 });
  });

  it("accepts Remediation.Apply through the EPIC-006 gate", async () => {
    const queue = new FakeQueue();
    const routes = createQuarantinePoliciesRoutes({
      provider: new FakeQuarantinePoliciesProvider(),
      queue,
      resolveCaller: () => ({
        tenantScope: tenantScope([TENANT]),
        permissions: [REMEDIATION_APPLY_PERMISSION],
        userId: "user-2",
      }),
    });
    const response = await routeByPath(routes, "POST", QUARANTINE_POLICIES_PATH).handler(
      ctx(`/v1/tenants/${TENANT}/quarantine-policies`, {
        params: { tenantId: TENANT },
        body: { name: "New", policyType: "notification" },
      }),
    );
    expect(response.status).toBe(202);
    expect(queue.enqueued).toHaveLength(1);
    expect(queue.enqueued[0]?.payload).toMatchObject({
      area: "quarantine-policies",
      action: "create",
    });
  });

  it("lists notification and permission policies live with the §3.5 columns", async () => {
    const routes = createQuarantinePoliciesRoutes({
      provider: new FakeQuarantinePoliciesProvider(),
      resolveCaller: readerCaller,
    });
    const response = await routeByPath(routes, "GET", QUARANTINE_POLICIES_PATH).handler(
      ctx(`/v1/tenants/${TENANT}/quarantine-policies`, {
        params: { tenantId: TENANT },
      }),
    );
    expect(response.status).toBe(200);
    const body = response.body as QuarantinePoliciesPage;
    expect(body.tenantId).toBe(TENANT);
    expect(body.totalCount).toBe(2);
    expect(body.items[0]).toMatchObject({
      name: "Default notification policy",
      policyType: "notification",
      esnEnabled: true,
      quarantineRetentionPeriod: 15,
    });
    expect(body.items[1]).toMatchObject({
      name: "Default permission policy",
      policyType: "permission",
    });
  });

  it("parses the policy type and rejects unknown values", () => {
    expect(parseQuarantinePolicyType("notification")).toBe("notification");
    expect(parseQuarantinePolicyType("permission")).toBe("permission");
    expect(() => parseQuarantinePolicyType("spam")).toThrow(
      expect.objectContaining({ status: 400 }),
    );
    expect(() => parseQuarantinePolicyType("")).toThrow(
      expect.objectContaining({ status: 400 }),
    );
  });

  it("creates a policy through the EPIC-006 gated path with before/after and audit", async () => {
    const queue = new FakeQueue();
    const audited: Record<string, unknown>[] = [];
    const routes = createQuarantinePoliciesRoutes({
      provider: new FakeQuarantinePoliciesProvider(),
      queue,
      resolveCaller: writerCaller,
      recordAudit: async (event) => {
        audited.push(event);
      },
    });
    const response = await routeByPath(routes, "POST", QUARANTINE_POLICIES_PATH).handler(
      ctx(`/v1/tenants/${TENANT}/quarantine-policies`, {
        params: { tenantId: TENANT },
        body: {
          name: "Strict notification",
          policyType: "notification",
          settings: { esnEnabled: true, quarantineRetentionPeriod: 30 },
        },
      }),
    );
    expect(response.status).toBe(202);
    const result = response.body as { success: boolean; plan: QuarantinePolicyPlan; jobId: string };
    expect(result.success).toBe(true);
    expect(result.plan.action).toBe("create");
    expect(result.plan.securityImpacting).toBe(false);

    expect(queue.enqueued).toHaveLength(1);
    const envelope = queue.enqueued[0]!;
    expect(envelope.jobType).toBe("remediation");
    expect(envelope.tenantId).toBe(TENANT);
    expect(envelope.payload).toMatchObject({
      area: "quarantine-policies",
      action: "create",
      policyType: "notification",
      policyName: "Strict notification",
      operation: "apply",
    });

    expect(audited).toHaveLength(1);
    expect(audited[0]).toMatchObject({
      action: "quarantine.policy.create",
      tenantId: TENANT,
      actorUserId: "user-1",
    });
  });

  it("previews a create with affected entries and no enqueue or audit", async () => {
    const queue = new FakeQueue();
    const audited: Record<string, unknown>[] = [];
    const routes = createQuarantinePoliciesRoutes({
      provider: new FakeQuarantinePoliciesProvider(),
      queue,
      resolveCaller: writerCaller,
      recordAudit: async (event) => {
        audited.push(event);
      },
    });
    const response = await routeByPath(routes, "POST", QUARANTINE_POLICIES_PATH).handler(
      ctx(`/v1/tenants/${TENANT}/quarantine-policies`, {
        params: { tenantId: TENANT },
        body: {
          name: "Preview policy",
          policyType: "notification",
          settings: { esnEnabled: true },
          preview: true,
        },
      }),
    );
    expect(response.status).toBe(200);
    const plan = response.body as QuarantinePolicyPlan;
    expect(plan.action).toBe("create");
    expect(plan.dryRun).toBe(true);
    expect(plan.affectedEntries).toEqual([
      { name: "Preview policy", policyType: "notification", state: "created" },
    ]);
    expect(queue.enqueued).toHaveLength(0);
    expect(audited).toHaveLength(0);
  });

  it("rejects a create without a name with 400", async () => {
    const routes = createQuarantinePoliciesRoutes({
      provider: new FakeQuarantinePoliciesProvider(),
      queue: new FakeQueue(),
      resolveCaller: writerCaller,
    });
    await expect(
      routeByPath(routes, "POST", QUARANTINE_POLICIES_PATH).handler(
        ctx(`/v1/tenants/${TENANT}/quarantine-policies`, {
          params: { tenantId: TENANT },
          body: { policyType: "notification" },
        }),
      ),
    ).rejects.toMatchObject({ status: 400 });
  });

  it("rejects a create with an unknown policy type with 400", async () => {
    const routes = createQuarantinePoliciesRoutes({
      provider: new FakeQuarantinePoliciesProvider(),
      queue: new FakeQueue(),
      resolveCaller: writerCaller,
    });
    await expect(
      routeByPath(routes, "POST", QUARANTINE_POLICIES_PATH).handler(
        ctx(`/v1/tenants/${TENANT}/quarantine-policies`, {
          params: { tenantId: TENANT },
          body: { name: "New", policyType: "spam" },
        }),
      ),
    ).rejects.toMatchObject({ status: 400 });
  });

  it("edits a policy and records the audit with affected entries", async () => {
    const queue = new FakeQueue();
    const audited: Record<string, unknown>[] = [];
    const routes = createQuarantinePoliciesRoutes({
      provider: new FakeQuarantinePoliciesProvider(),
      queue,
      resolveCaller: writerCaller,
      recordAudit: async (event) => {
        audited.push(event);
      },
    });
    const response = await routeByPath(routes, "PATCH", QUARANTINE_POLICIES_ITEM_PATH).handler(
      ctx(`/v1/tenants/${TENANT}/quarantine-policies/${NOTIFICATION_STATE.name}`, {
        params: { tenantId: TENANT, policyName: NOTIFICATION_STATE.name },
        body: { policyType: "notification", settings: { esnEnabled: true, quarantineRetentionPeriod: 30 } },
      }),
    );
    expect(response.status).toBe(202);
    const result = response.body as { success: boolean; plan: QuarantinePolicyPlan };
    expect(result.success).toBe(true);
    expect(result.plan.action).toBe("edit");
    expect(result.plan.affectedEntries).toEqual([
      { name: NOTIFICATION_STATE.name, policyType: "notification", state: "updated" },
    ]);

    expect(queue.enqueued).toHaveLength(1);
    expect(queue.enqueued[0]?.payload).toMatchObject({
      area: "quarantine-policies",
      action: "edit",
      policyType: "notification",
      policyName: NOTIFICATION_STATE.name,
    });

    expect(audited).toHaveLength(1);
    expect(audited[0]).toMatchObject({
      action: "quarantine.policy.edit",
      targetId: NOTIFICATION_STATE.name,
    });
  });

  it("previews an edit with affected entries before apply", async () => {
    const queue = new FakeQueue();
    const routes = createQuarantinePoliciesRoutes({
      provider: new FakeQuarantinePoliciesProvider(),
      queue,
      resolveCaller: writerCaller,
    });
    const response = await routeByPath(routes, "PATCH", QUARANTINE_POLICIES_ITEM_PATH).handler(
      ctx(`/v1/tenants/${TENANT}/quarantine-policies/${NOTIFICATION_STATE.name}`, {
        params: { tenantId: TENANT, policyName: NOTIFICATION_STATE.name },
        body: { policyType: "notification", settings: { esnEnabled: false }, preview: true },
      }),
    );
    expect(response.status).toBe(200);
    const plan = response.body as QuarantinePolicyPlan;
    expect(plan.action).toBe("edit");
    expect(plan.dryRun).toBe(true);
    expect(plan.securityImpacting).toBe(true);
    expect(plan.requiresConfirmation).toBe(true);
    expect(plan.affectedEntries).toEqual([
      { name: NOTIFICATION_STATE.name, policyType: "notification", state: "updated" },
    ]);
    expect(queue.enqueued).toHaveLength(0);
  });

  it("flags a weakening edit (ESN disabled) as security-impacting and requires confirmation", async () => {
    const routes = createQuarantinePoliciesRoutes({
      provider: new FakeQuarantinePoliciesProvider(),
      queue: new FakeQueue(),
      resolveCaller: writerCaller,
    });
    await expect(
      routeByPath(routes, "PATCH", QUARANTINE_POLICIES_ITEM_PATH).handler(
        ctx(`/v1/tenants/${TENANT}/quarantine-policies/${NOTIFICATION_STATE.name}`, {
          params: { tenantId: TENANT, policyName: NOTIFICATION_STATE.name },
          body: { policyType: "notification", settings: { esnEnabled: false } },
        }),
      ),
    ).rejects.toMatchObject({ status: 400, code: QUARANTINE_POLICIES_CONFIRM_REQUIRED });
  });

  it("flags a weakening edit (retention lowered) as security-impacting", async () => {
    const routes = createQuarantinePoliciesRoutes({
      provider: new FakeQuarantinePoliciesProvider(),
      queue: new FakeQueue(),
      resolveCaller: writerCaller,
    });
    await expect(
      routeByPath(routes, "PATCH", QUARANTINE_POLICIES_ITEM_PATH).handler(
        ctx(`/v1/tenants/${TENANT}/quarantine-policies/${NOTIFICATION_STATE.name}`, {
          params: { tenantId: TENANT, policyName: NOTIFICATION_STATE.name },
          body: { policyType: "notification", settings: { quarantineRetentionPeriod: 5 } },
        }),
      ),
    ).rejects.toMatchObject({ status: 400, code: QUARANTINE_POLICIES_CONFIRM_REQUIRED });
  });

  it("applies a strengthening edit without confirmation", async () => {
    const queue = new FakeQueue();
    const routes = createQuarantinePoliciesRoutes({
      provider: new FakeQuarantinePoliciesProvider(),
      queue,
      resolveCaller: writerCaller,
    });
    const response = await routeByPath(routes, "PATCH", QUARANTINE_POLICIES_ITEM_PATH).handler(
      ctx(`/v1/tenants/${TENANT}/quarantine-policies/${NOTIFICATION_STATE.name}`, {
        params: { tenantId: TENANT, policyName: NOTIFICATION_STATE.name },
        body: { policyType: "notification", settings: { quarantineRetentionPeriod: 30 } },
      }),
    );
    expect(response.status).toBe(202);
    const result = response.body as { plan: QuarantinePolicyPlan };
    expect(result.plan.action).toBe("edit");
    expect(result.plan.securityImpacting).toBe(false);
    expect(queue.enqueued).toHaveLength(1);
  });

  it("returns 404 when the policy does not exist", async () => {
    const routes = createQuarantinePoliciesRoutes({
      provider: new FakeQuarantinePoliciesProvider(),
      queue: new FakeQueue(),
      resolveCaller: writerCaller,
    });
    await expect(
      routeByPath(routes, "PATCH", QUARANTINE_POLICIES_ITEM_PATH).handler(
        ctx(`/v1/tenants/${TENANT}/quarantine-policies/missing`, {
          params: { tenantId: TENANT, policyName: "missing" },
          body: { policyType: "notification", settings: { esnEnabled: true } },
        }),
      ),
    ).rejects.toMatchObject({ status: 404, code: QUARANTINE_POLICIES_NOT_FOUND });
  });

  it("requires confirmation before deleting a policy", async () => {
    const routes = createQuarantinePoliciesRoutes({
      provider: new FakeQuarantinePoliciesProvider(),
      queue: new FakeQueue(),
      resolveCaller: writerCaller,
    });
    await expect(
      routeByPath(routes, "DELETE", QUARANTINE_POLICIES_ITEM_PATH).handler(
        ctx(`/v1/tenants/${TENANT}/quarantine-policies/${NOTIFICATION_STATE.name}`, {
          params: { tenantId: TENANT, policyName: NOTIFICATION_STATE.name },
          body: { policyType: "notification" },
        }),
      ),
    ).rejects.toMatchObject({ status: 400, code: QUARANTINE_POLICIES_CONFIRM_REQUIRED });
  });

  it("previews a delete with affected entries before apply", async () => {
    const queue = new FakeQueue();
    const routes = createQuarantinePoliciesRoutes({
      provider: new FakeQuarantinePoliciesProvider(),
      queue,
      resolveCaller: writerCaller,
    });
    const response = await routeByPath(routes, "DELETE", QUARANTINE_POLICIES_ITEM_PATH).handler(
      ctx(`/v1/tenants/${TENANT}/quarantine-policies/${NOTIFICATION_STATE.name}`, {
        params: { tenantId: TENANT, policyName: NOTIFICATION_STATE.name },
        body: { policyType: "notification", preview: true },
      }),
    );
    expect(response.status).toBe(200);
    const plan = response.body as QuarantinePolicyPlan;
    expect(plan.action).toBe("delete");
    expect(plan.dryRun).toBe(true);
    expect(plan.securityImpacting).toBe(true);
    expect(plan.affectedEntries).toEqual([
      { name: NOTIFICATION_STATE.name, policyType: "notification", state: "deleted" },
    ]);
    expect(queue.enqueued).toHaveLength(0);
  });

  it("deletes a policy through the EPIC-006 gated path with audit", async () => {
    const queue = new FakeQueue();
    const audited: Record<string, unknown>[] = [];
    const routes = createQuarantinePoliciesRoutes({
      provider: new FakeQuarantinePoliciesProvider(),
      queue,
      resolveCaller: writerCaller,
      recordAudit: async (event) => {
        audited.push(event);
      },
    });
    const response = await routeByPath(routes, "DELETE", QUARANTINE_POLICIES_ITEM_PATH).handler(
      ctx(`/v1/tenants/${TENANT}/quarantine-policies/${NOTIFICATION_STATE.name}`, {
        params: { tenantId: TENANT, policyName: NOTIFICATION_STATE.name },
        body: { policyType: "notification", confirm: true },
      }),
    );
    expect(response.status).toBe(202);
    const result = response.body as { success: boolean; plan: QuarantinePolicyPlan };
    expect(result.success).toBe(true);
    expect(result.plan.action).toBe("delete");
    expect(result.plan.securityImpacting).toBe(true);

    expect(queue.enqueued).toHaveLength(1);
    expect(queue.enqueued[0]?.payload).toMatchObject({
      area: "quarantine-policies",
      action: "delete",
      policyType: "notification",
      policyName: NOTIFICATION_STATE.name,
    });

    expect(audited).toHaveLength(1);
    expect(audited[0]).toMatchObject({
      action: "quarantine.policy.delete",
      targetId: NOTIFICATION_STATE.name,
    });
  });
});
