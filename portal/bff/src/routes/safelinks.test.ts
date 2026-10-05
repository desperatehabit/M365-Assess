import { describe, expect, it } from "vitest";
import { tenantScope } from "../rbac/scope.js";
import type { CompliancePolicyChange } from "../repository/purview-compliance.js";
import {
  REMEDIATION_APPLY_PERMISSION,
  SAFELINKS_ITEM_PATH,
  SAFELINKS_PATH,
  SAFELINKS_READ_PERMISSION,
  SAFELINKS_WRITE_PERMISSION,
  createSafeLinksRoutes,
  parseSafeLinksFilter,
  type SafeLinksAuditEvent,
  type SafeLinksChangeResult,
  type SafeLinksCaller,
  type SafeLinksPlan,
  type SafeLinksPolicyInput,
  type SafeLinksProvider,
} from "./safelinks.js";

const TENANT = "tenant-test";

const LIST_PAGE = {
  tenantId: TENANT,
  totalCount: 2,
  items: [
    {
      id: "policy-1",
      name: "Executive protection",
      state: "enabled",
      urlRewriting: true,
      scanOnClick: true,
      detonation: true,
      lastModified: "2026-09-20T12:00:00Z",
    },
    {
      id: "policy-2",
      name: "Standard protection",
      state: "disabled",
      urlRewriting: false,
      scanOnClick: true,
      detonation: false,
      lastModified: "2026-09-18T08:00:00Z",
    },
  ],
  nextCursor: null,
};

function planFor(action: SafeLinksPlan["action"], overrides: Partial<SafeLinksPlan> = {}): SafeLinksPlan {
  return {
    action,
    policyId: "policy-1",
    targetName: "Executive protection",
    before: { id: "policy-1", name: "Executive protection", state: "enabled" },
    after: { id: "policy-1", name: "Executive protection", state: "disabled" },
    diff: [`Plan ${action} 'Executive protection'`, "warn: compliance-impacting change"],
    valid: true,
    dryRun: true,
    requiresConfirmation: action === "disable" || action === "delete",
    ...overrides,
  };
}

function resultFor(action: SafeLinksPlan["action"]): SafeLinksChangeResult {
  const plan = planFor(action, { dryRun: false });
  const auditEvent: SafeLinksAuditEvent = {
    id: `audit-${action}-1`,
    tenantId: TENANT,
    action: `safelinks.policy.${action}`,
    targetId: "policy-1",
    targetName: "Executive protection",
    timestamp: "2026-09-28T00:00:00.000Z",
    before: plan.before ?? null,
    after: plan.after ?? null,
  };
  return {
    success: true,
    plan,
    result: { policyId: "policy-1", name: "Executive protection" },
    auditEvent,
  };
}

class FakeSafeLinksProvider implements SafeLinksProvider {
  readonly createCalls: Array<{ tenantId: string; input: SafeLinksPolicyInput; preview: boolean }> = [];
  readonly editCalls: Array<{
    tenantId: string;
    policyId: string;
    input: SafeLinksPolicyInput;
    preview: boolean;
  }> = [];
  readonly deleteCalls: Array<{
    tenantId: string;
    policyId: string;
    confirmName: string;
    preview: boolean;
  }> = [];
  readonly recordedAudits: Record<string, unknown>[] = [];
  readonly recordedChanges: Record<string, unknown>[] = [];

  async listPolicies(tenantId: string) {
    void tenantId;
    return LIST_PAGE;
  }

  async createPolicy(
    tenantId: string,
    input: SafeLinksPolicyInput,
    preview: boolean,
  ): Promise<SafeLinksChangeResult | SafeLinksPlan> {
    this.createCalls.push({ tenantId, input, preview });
    return preview ? planFor("create") : resultFor("create");
  }

  async editPolicy(
    tenantId: string,
    policyId: string,
    input: SafeLinksPolicyInput,
    preview: boolean,
  ): Promise<SafeLinksChangeResult | SafeLinksPlan> {
    this.editCalls.push({ tenantId, policyId, input, preview });
    const action = input.action ?? "edit";
    return preview
      ? planFor(action, { policyId })
      : resultFor(action === "edit" ? "edit" : action === "enable" ? "enable" : "disable");
  }

  async deletePolicy(
    tenantId: string,
    policyId: string,
    confirmName: string,
    preview: boolean,
  ): Promise<SafeLinksChangeResult | SafeLinksPlan> {
    this.deleteCalls.push({ tenantId, policyId, confirmName, preview });
    return preview
      ? planFor("delete", { policyId, targetName: confirmName })
      : resultFor("delete");
  }
}

function readerCaller(): SafeLinksCaller {
  return {
    tenantScope: tenantScope([TENANT]),
    permissions: [SAFELINKS_READ_PERMISSION],
    userId: "user-reader",
  };
}

function writerCaller(): SafeLinksCaller {
  return {
    tenantScope: tenantScope([TENANT]),
    permissions: [SAFELINKS_WRITE_PERMISSION],
    userId: "user-writer",
  };
}

function routeByPath(routes: ReturnType<typeof createSafeLinksRoutes>, method: string, path: string) {
  const route = routes.find((r) => r.method === method && r.path === path);
  if (!route) throw new Error(`missing route ${method} ${path}`);
  return route;
}

describe("Safe Links policy read + gated change routes (T-0585)", () => {
  it("exposes the list, create, edit, and delete paths", () => {
    const routes = createSafeLinksRoutes({
      provider: new FakeSafeLinksProvider(),
      resolveCaller: writerCaller,
    });
    expect(routes.map((route) => `${route.method} ${route.path}`)).toEqual([
      `GET ${SAFELINKS_PATH}`,
      `POST ${SAFELINKS_PATH}`,
      `PATCH ${SAFELINKS_ITEM_PATH}`,
      `DELETE ${SAFELINKS_ITEM_PATH}`,
    ]);
  });

  it("rejects unauthenticated requests with 401", async () => {
    const routes = createSafeLinksRoutes({
      provider: new FakeSafeLinksProvider(),
      resolveCaller: () => undefined,
    });
    await expect(
      routeByPath(routes, "GET", SAFELINKS_PATH).handler({
        method: "GET",
        path: `/v1/tenants/${TENANT}/safelinks`,
        params: { tenantId: TENANT },
        query: new URLSearchParams(),
        headers: {},
      }),
    ).rejects.toMatchObject({ status: 401 });
  });

  it("rejects tenant outside caller scope with 403", async () => {
    const routes = createSafeLinksRoutes({
      provider: new FakeSafeLinksProvider(),
      resolveCaller: () => ({
        tenantScope: tenantScope(["different-tenant"]),
        permissions: [SAFELINKS_WRITE_PERMISSION],
      }),
    });
    await expect(
      routeByPath(routes, "GET", SAFELINKS_PATH).handler({
        method: "GET",
        path: `/v1/tenants/${TENANT}/safelinks`,
        params: { tenantId: TENANT },
        query: new URLSearchParams(),
        headers: {},
      }),
    ).rejects.toMatchObject({ status: 403 });
  });

  it("rejects reads without Purview.Compliance.Read with 403", async () => {
    const routes = createSafeLinksRoutes({
      provider: new FakeSafeLinksProvider(),
      resolveCaller: () => ({
        tenantScope: tenantScope([TENANT]),
        permissions: [SAFELINKS_WRITE_PERMISSION],
      }),
    });
    await expect(
      routeByPath(routes, "GET", SAFELINKS_PATH).handler({
        method: "GET",
        path: `/v1/tenants/${TENANT}/safelinks`,
        params: { tenantId: TENANT },
        query: new URLSearchParams(),
        headers: {},
      }),
    ).rejects.toMatchObject({ status: 403 });
  });

  it("rejects writes without Purview.Compliance.ReadWrite with 403", async () => {
    const routes = createSafeLinksRoutes({
      provider: new FakeSafeLinksProvider(),
      resolveCaller: readerCaller,
    });
    await expect(
      routeByPath(routes, "POST", SAFELINKS_PATH).handler({
        method: "POST",
        path: `/v1/tenants/${TENANT}/safelinks`,
        params: { tenantId: TENANT },
        query: new URLSearchParams(),
        headers: {},
        body: { name: "New policy" },
      }),
    ).rejects.toMatchObject({ status: 403 });
  });

  it("accepts Remediation.Apply through the EPIC-006 gate", async () => {
    const provider = new FakeSafeLinksProvider();
    const routes = createSafeLinksRoutes({
      provider,
      resolveCaller: () => ({
        tenantScope: tenantScope([TENANT]),
        permissions: [REMEDIATION_APPLY_PERMISSION],
      }),
    });
    const response = await routeByPath(routes, "POST", SAFELINKS_PATH).handler({
      method: "POST",
      path: `/v1/tenants/${TENANT}/safelinks`,
      params: { tenantId: TENANT },
      query: new URLSearchParams(),
      headers: {},
      body: { name: "New policy" },
    });
    expect(response.status).toBe(201);
    expect(provider.createCalls[0]).toMatchObject({ tenantId: TENANT, preview: false });
  });

  it("lists policies live with the §3.5 columns", async () => {
    const routes = createSafeLinksRoutes({
      provider: new FakeSafeLinksProvider(),
      resolveCaller: readerCaller,
    });
    const response = await routeByPath(routes, "GET", SAFELINKS_PATH).handler({
      method: "GET",
      path: `/v1/tenants/${TENANT}/safelinks`,
      params: { tenantId: TENANT },
      query: new URLSearchParams("search=executive&state=enabled&limit=25"),
      headers: {},
    });
    expect(response.status).toBe(200);
    const body = response.body as typeof LIST_PAGE;
    expect(body.tenantId).toBe(TENANT);
    expect(body.totalCount).toBe(2);
    expect(body.items[0]).toMatchObject({
      name: "Executive protection",
      state: "enabled",
      urlRewriting: true,
      scanOnClick: true,
      detonation: true,
      lastModified: "2026-09-20T12:00:00Z",
    });
  });

  it("parses the list filter with cursor pagination", () => {
    const filter = parseSafeLinksFilter(new URLSearchParams("search=exec&state=disabled&cursor=abc&limit=50"));
    expect(filter).toMatchObject({ search: "exec", state: "disabled", cursor: "abc", limit: 50 });
    expect(parseSafeLinksFilter(new URLSearchParams()).limit).toBe(100);
    expect(() => parseSafeLinksFilter(new URLSearchParams("state=bogus"))).toThrow(
      expect.objectContaining({ status: 400 }),
    );
  });

  it("creates a policy with before/after, an audit event, and a change row", async () => {
    const provider = new FakeSafeLinksProvider();
    const routes = createSafeLinksRoutes({
      provider,
      resolveCaller: writerCaller,
      recordAudit: async (event) => {
        provider.recordedAudits.push(event);
      },
      recordPolicyChange: async (input) => {
        provider.recordedChanges.push(input);
        return { ...input, id: "change-1", at: "2026-09-28T00:00:00.000Z" } as CompliancePolicyChange;
      },
    });
    const response = await routeByPath(routes, "POST", SAFELINKS_PATH).handler({
      method: "POST",
      path: `/v1/tenants/${TENANT}/safelinks`,
      params: { tenantId: TENANT },
      query: new URLSearchParams(),
      headers: {},
      body: {
        name: "New policy",
        settings: { urlRewriting: true, scanOnClick: true, detonation: true },
      },
    });
    expect(response.status).toBe(201);
    const body = response.body as SafeLinksChangeResult;
    expect(body.success).toBe(true);
    expect(body.auditEvent?.action).toBe("safelinks.policy.create");
    expect(provider.createCalls[0]?.input.name).toBe("New policy");
    expect(provider.recordedAudits).toHaveLength(1);
    expect(provider.recordedChanges).toHaveLength(1);
    expect(provider.recordedChanges[0]).toMatchObject({
      tenantId: TENANT,
      area: "safelinks",
      policyId: "policy-1",
      by: "user-writer",
    });
  });

  it("rejects create without a name with 400", async () => {
    const routes = createSafeLinksRoutes({
      provider: new FakeSafeLinksProvider(),
      resolveCaller: writerCaller,
    });
    await expect(
      routeByPath(routes, "POST", SAFELINKS_PATH).handler({
        method: "POST",
        path: `/v1/tenants/${TENANT}/safelinks`,
        params: { tenantId: TENANT },
        query: new URLSearchParams(),
        headers: {},
        body: { settings: { detonation: true } },
      }),
    ).rejects.toMatchObject({ status: 400 });
  });

  it("rejects create with a non-boolean setting with 400", async () => {
    const routes = createSafeLinksRoutes({
      provider: new FakeSafeLinksProvider(),
      resolveCaller: writerCaller,
    });
    await expect(
      routeByPath(routes, "POST", SAFELINKS_PATH).handler({
        method: "POST",
        path: `/v1/tenants/${TENANT}/safelinks`,
        params: { tenantId: TENANT },
        query: new URLSearchParams(),
        headers: {},
        body: { name: "New policy", settings: { detonation: "yes" } },
      }),
    ).rejects.toMatchObject({ status: 400 });
  });

  it("previews a create without recording an audit or change row", async () => {
    const provider = new FakeSafeLinksProvider();
    const routes = createSafeLinksRoutes({
      provider,
      resolveCaller: writerCaller,
      recordAudit: async (event) => {
        provider.recordedAudits.push(event);
      },
      recordPolicyChange: async (input) => {
        provider.recordedChanges.push(input);
        return { ...input, id: "change-1", at: "2026-09-28T00:00:00.000Z" } as CompliancePolicyChange;
      },
    });
    const response = await routeByPath(routes, "POST", SAFELINKS_PATH).handler({
      method: "POST",
      path: `/v1/tenants/${TENANT}/safelinks`,
      params: { tenantId: TENANT },
      query: new URLSearchParams(),
      headers: {},
      body: { name: "Preview policy", preview: true },
    });
    expect(response.status).toBe(200);
    const body = response.body as SafeLinksPlan;
    expect(body.dryRun).toBe(true);
    expect(provider.createCalls[0]?.preview).toBe(true);
    expect(provider.recordedAudits).toHaveLength(0);
    expect(provider.recordedChanges).toHaveLength(0);
  });

  it("edits a policy and records the audit and change row", async () => {
    const provider = new FakeSafeLinksProvider();
    const routes = createSafeLinksRoutes({
      provider,
      resolveCaller: writerCaller,
      recordAudit: async (event) => {
        provider.recordedAudits.push(event);
      },
      recordPolicyChange: async (input) => {
        provider.recordedChanges.push(input);
        return { ...input, id: "change-1", at: "2026-09-28T00:00:00.000Z" } as CompliancePolicyChange;
      },
    });
    const response = await routeByPath(routes, "PATCH", SAFELINKS_ITEM_PATH).handler({
      method: "PATCH",
      path: `/v1/tenants/${TENANT}/safelinks/policy-1`,
      params: { tenantId: TENANT, policyId: "policy-1" },
      query: new URLSearchParams(),
      headers: {},
      body: { action: "edit", settings: { urlRewriting: false } },
    });
    expect(response.status).toBe(200);
    const body = response.body as SafeLinksChangeResult;
    expect(body.auditEvent?.action).toBe("safelinks.policy.edit");
    expect(provider.editCalls[0]).toMatchObject({ tenantId: TENANT, policyId: "policy-1", preview: false });
    expect(provider.editCalls[0]?.input.action).toBe("edit");
    expect(provider.recordedChanges).toHaveLength(1);
  });

  it("rejects an unsupported edit action with 400", async () => {
    const routes = createSafeLinksRoutes({
      provider: new FakeSafeLinksProvider(),
      resolveCaller: writerCaller,
    });
    await expect(
      routeByPath(routes, "PATCH", SAFELINKS_ITEM_PATH).handler({
        method: "PATCH",
        path: `/v1/tenants/${TENANT}/safelinks/policy-1`,
        params: { tenantId: TENANT, policyId: "policy-1" },
        query: new URLSearchParams(),
        headers: {},
        body: { action: "purge" },
      }),
    ).rejects.toMatchObject({ status: 400 });
  });

  it("warns before a compliance-impacting disable and requires explicit confirm", async () => {
    const provider = new FakeSafeLinksProvider();
    const routes = createSafeLinksRoutes({
      provider,
      resolveCaller: writerCaller,
      recordAudit: async (event) => {
        provider.recordedAudits.push(event);
      },
      recordPolicyChange: async (input) => {
        provider.recordedChanges.push(input);
        return { ...input, id: "change-1", at: "2026-09-28T00:00:00.000Z" } as CompliancePolicyChange;
      },
    });

    const preview = await routeByPath(routes, "PATCH", SAFELINKS_ITEM_PATH).handler({
      method: "PATCH",
      path: `/v1/tenants/${TENANT}/safelinks/policy-1`,
      params: { tenantId: TENANT, policyId: "policy-1" },
      query: new URLSearchParams(),
      headers: {},
      body: { action: "disable", preview: true },
    });
    const previewBody = preview.body as SafeLinksPlan;
    expect(previewBody.requiresConfirmation).toBe(true);
    expect(previewBody.diff).toContain("warn: compliance-impacting change");

    await expect(
      routeByPath(routes, "PATCH", SAFELINKS_ITEM_PATH).handler({
        method: "PATCH",
        path: `/v1/tenants/${TENANT}/safelinks/policy-1`,
        params: { tenantId: TENANT, policyId: "policy-1" },
        query: new URLSearchParams(),
        headers: {},
        body: { action: "disable" },
      }),
    ).rejects.toMatchObject({ status: 400 });

    const applied = await routeByPath(routes, "PATCH", SAFELINKS_ITEM_PATH).handler({
      method: "PATCH",
      path: `/v1/tenants/${TENANT}/safelinks/policy-1`,
      params: { tenantId: TENANT, policyId: "policy-1" },
      query: new URLSearchParams(),
      headers: {},
      body: { action: "disable", confirm: true },
    });
    expect(applied.status).toBe(200);
    const body = applied.body as SafeLinksChangeResult;
    expect(body.auditEvent?.action).toBe("safelinks.policy.disable");
    expect(provider.editCalls[0]?.input.action).toBe("disable");
    expect(provider.recordedAudits).toHaveLength(1);
    expect(provider.recordedChanges).toHaveLength(1);
    expect(provider.recordedChanges[0]).toMatchObject({
      tenantId: TENANT,
      area: "safelinks",
      policyId: "policy-1",
      by: "user-writer",
    });
  });

  it("enables a policy without a compliance-impacting warning", async () => {
    const provider = new FakeSafeLinksProvider();
    const routes = createSafeLinksRoutes({ provider, resolveCaller: writerCaller });
    const response = await routeByPath(routes, "PATCH", SAFELINKS_ITEM_PATH).handler({
      method: "PATCH",
      path: `/v1/tenants/${TENANT}/safelinks/policy-1`,
      params: { tenantId: TENANT, policyId: "policy-1" },
      query: new URLSearchParams(),
      headers: {},
      body: { action: "enable" },
    });
    expect(response.status).toBe(200);
    const body = response.body as SafeLinksChangeResult;
    expect(body.plan.requiresConfirmation).toBe(false);
    expect(body.auditEvent?.action).toBe("safelinks.policy.enable");
    expect(provider.editCalls[0]?.input.action).toBe("enable");
  });

  it("deletes a policy with confirmName, an audit event, and a change row", async () => {
    const provider = new FakeSafeLinksProvider();
    const routes = createSafeLinksRoutes({
      provider,
      resolveCaller: writerCaller,
      recordAudit: async (event) => {
        provider.recordedAudits.push(event);
      },
      recordPolicyChange: async (input) => {
        provider.recordedChanges.push(input);
        return { ...input, id: "change-1", at: "2026-09-28T00:00:00.000Z" } as CompliancePolicyChange;
      },
    });
    const response = await routeByPath(routes, "DELETE", SAFELINKS_ITEM_PATH).handler({
      method: "DELETE",
      path: `/v1/tenants/${TENANT}/safelinks/policy-1`,
      params: { tenantId: TENANT, policyId: "policy-1" },
      query: new URLSearchParams(),
      headers: {},
      body: { confirmName: "Executive protection", confirm: true },
    });
    expect(response.status).toBe(200);
    const body = response.body as SafeLinksChangeResult;
    expect(body.auditEvent?.action).toBe("safelinks.policy.delete");
    expect(provider.deleteCalls[0]).toMatchObject({
      tenantId: TENANT,
      policyId: "policy-1",
      confirmName: "Executive protection",
      preview: false,
    });
    expect(provider.recordedAudits).toHaveLength(1);
    expect(provider.recordedChanges).toHaveLength(1);
  });

  it("rejects a delete without confirmName with 400", async () => {
    const routes = createSafeLinksRoutes({
      provider: new FakeSafeLinksProvider(),
      resolveCaller: writerCaller,
    });
    await expect(
      routeByPath(routes, "DELETE", SAFELINKS_ITEM_PATH).handler({
        method: "DELETE",
        path: `/v1/tenants/${TENANT}/safelinks/policy-1`,
        params: { tenantId: TENANT, policyId: "policy-1" },
        query: new URLSearchParams(),
        headers: {},
        body: { confirm: true },
      }),
    ).rejects.toMatchObject({ status: 400 });
  });

  it("rejects a delete without explicit confirm with 400", async () => {
    const routes = createSafeLinksRoutes({
      provider: new FakeSafeLinksProvider(),
      resolveCaller: writerCaller,
    });
    await expect(
      routeByPath(routes, "DELETE", SAFELINKS_ITEM_PATH).handler({
        method: "DELETE",
        path: `/v1/tenants/${TENANT}/safelinks/policy-1`,
        params: { tenantId: TENANT, policyId: "policy-1" },
        query: new URLSearchParams(),
        headers: {},
        body: { confirmName: "Executive protection" },
      }),
    ).rejects.toMatchObject({ status: 400 });
  });
});
