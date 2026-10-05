// T-0422 — Filter write route gating.
// Route-level tests: the write routes validate Exchange.SpamFilter.ReadWrite + tenant scope,
// build a before/after plan via the policy guard, flag disabling/weakening
// changes as security-impacting before apply, require confirmation for them,
// support plan preview (preview:true) with no tenant write, and enqueue the
// EPIC-006 gated job with an audit event on apply.

import { describe, expect, it } from "vitest";
import { tenantScope } from "../rbac/scope.js";
import type { JobEnvelope } from "@m365-assess/contracts";
import type { RequestContext } from "../server.js";
import {
  FILTERS_CONFIRM_REQUIRED,
  FILTERS_ITEM_PATH,
  FILTERS_NOT_FOUND,
  FILTERS_PATH,
  FILTERS_READ_PERMISSION,
  FILTERS_WRITE_PERMISSION,
  REMEDIATION_APPLY_PERMISSION,
  createFilterRoutes,
  type FilterChangePlan,
  type FilterChangeResult,
  type FilterPolicy,
  type FiltersCaller,
  type FiltersPage,
  type FiltersProvider,
  type FilterType,
} from "./filters.js";

const TENANT = "tenant-test";

const SPAM_POLICY: FilterPolicy = {
  name: "Default",
  enabled: true,
  settings: {
    spamAction: "Quarantine",
    highConfidenceSpamAction: "Quarantine",
    bulkThreshold: 6,
    spamZapEnabled: true,
  },
};

class FakeFiltersProvider implements FiltersProvider {
  readonly getFilterPolicyCalls: Array<{ tenantId: string; filterType: FilterType; policyName: string }> = [];

  async getFilters(tenantId: string, filterType: FilterType): Promise<FiltersPage> {
    void tenantId;
    void filterType;
    return { tenantId, filterType, items: [], totalCount: 0, retrievedAt: "2026-09-28T00:00:00.000Z" };
  }

  async getFilterPolicy(
    tenantId: string,
    filterType: FilterType,
    policyName: string,
  ): Promise<FilterPolicy | undefined> {
    this.getFilterPolicyCalls.push({ tenantId, filterType, policyName });
    return policyName === SPAM_POLICY.name ? SPAM_POLICY : undefined;
  }
}

class FakeQueue {
  readonly enqueued: JobEnvelope[] = [];

  async enqueue(envelope: JobEnvelope): Promise<string> {
    this.enqueued.push(envelope);
    return envelope.jobId;
  }
}

function writerCaller() {
  return {
    tenantScope: tenantScope([TENANT]),
    permissions: [FILTERS_WRITE_PERMISSION],
    userId: "user-1",
  };
}

function readerCaller() {
  return {
    tenantScope: tenantScope([TENANT]),
    permissions: [FILTERS_READ_PERMISSION],
  };
}

function routeByPath(routes: ReturnType<typeof createFilterRoutes>, method: string, path: string) {
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
    correlationId: "corr-filters-1",
    method: "GET",
    path,
    query,
    headers: {},
    params: options.params ?? {},
    ...(options.body !== undefined ? { body: options.body } : {}),
  };
}

describe("Filter write routes (T-0422)", () => {
  it("exposes the read and write paths", () => {
    const routes = createFilterRoutes({
      provider: new FakeFiltersProvider(),
      queue: new FakeQueue(),
      resolveCaller: writerCaller,
    });
    expect(routes.map((route) => `${route.method} ${route.path}`)).toEqual([
      `GET ${FILTERS_PATH}`,
      `POST ${FILTERS_PATH}`,
      `PATCH ${FILTERS_ITEM_PATH}`,
      `DELETE ${FILTERS_ITEM_PATH}`,
    ]);
  });

  it("rejects unauthenticated write requests with 401", async () => {
    const routes = createFilterRoutes({
      provider: new FakeFiltersProvider(),
      queue: new FakeQueue(),
      resolveCaller: () => undefined,
    });
    await expect(
      routeByPath(routes, "POST", FILTERS_PATH).handler(
        ctx(`/v1/tenants/${TENANT}/filters/spam`, {
          params: { tenantId: TENANT, filterType: "spam" },
          body: { name: "New" },
        }),
      ),
    ).rejects.toMatchObject({ status: 401 });
  });

  it("rejects callers missing Exchange.SpamFilter.ReadWrite with 403", async () => {
    const routes = createFilterRoutes({
      provider: new FakeFiltersProvider(),
      queue: new FakeQueue(),
      resolveCaller: readerCaller,
    });
    await expect(
      routeByPath(routes, "POST", FILTERS_PATH).handler(
        ctx(`/v1/tenants/${TENANT}/filters/spam`, {
          params: { tenantId: TENANT, filterType: "spam" },
          body: { name: "New" },
        }),
      ),
    ).rejects.toMatchObject({ status: 403 });
  });

  it("accepts Remediation.Apply through the EPIC-006 gate", async () => {
    const queue = new FakeQueue();
    const routes = createFilterRoutes({
      provider: new FakeFiltersProvider(),
      queue,
      resolveCaller: () => ({
        tenantScope: tenantScope([TENANT]),
        permissions: [REMEDIATION_APPLY_PERMISSION],
        userId: "user-2",
      }),
    });
    const response = await routeByPath(routes, "POST", FILTERS_PATH).handler(
      ctx(`/v1/tenants/${TENANT}/filters/spam`, {
        params: { tenantId: TENANT, filterType: "spam" },
        body: { name: "New" },
      }),
    );
    expect(response.status).toBe(202);
    expect(queue.enqueued).toHaveLength(1);
    expect(queue.enqueued[0]?.payload).toMatchObject({ area: "filters", action: "create" });
  });

  it("creates a filter through the EPIC-006 gated path with before/after and audit", async () => {
    const queue = new FakeQueue();
    const audited: Record<string, unknown>[] = [];
    const routes = createFilterRoutes({
      provider: new FakeFiltersProvider(),
      queue,
      resolveCaller: writerCaller,
      recordAudit: async (event) => {
        audited.push(event);
      },
    });
    const response = await routeByPath(routes, "POST", FILTERS_PATH).handler(
      ctx(`/v1/tenants/${TENANT}/filters/spam`, {
        params: { tenantId: TENANT, filterType: "spam" },
        body: { name: "Strict", settings: { spamAction: "Quarantine" } },
      }),
    );
    expect(response.status).toBe(202);
    const result = response.body as FilterChangeResult;
    expect(result.success).toBe(true);
    expect(result.plan.action).toBe("create");
    expect(result.plan.securityImpacting).toBe(false);

    expect(queue.enqueued).toHaveLength(1);
    const envelope = queue.enqueued[0]!;
    expect(envelope.jobType).toBe("remediation");
    expect(envelope.tenantId).toBe(TENANT);
    expect(envelope.payload).toMatchObject({
      area: "filters",
      action: "create",
      filterType: "spam",
      policyName: "Strict",
      operation: "apply",
    });

    expect(audited).toHaveLength(1);
    expect(audited[0]).toMatchObject({
      action: "filters.policy.create",
      tenantId: TENANT,
      actorUserId: "user-1",
    });
  });

  it("previews a create without enqueueing or auditing", async () => {
    const queue = new FakeQueue();
    const audited: Record<string, unknown>[] = [];
    const routes = createFilterRoutes({
      provider: new FakeFiltersProvider(),
      queue,
      resolveCaller: writerCaller,
      recordAudit: async (event) => {
        audited.push(event);
      },
    });
    const response = await routeByPath(routes, "POST", FILTERS_PATH).handler(
      ctx(`/v1/tenants/${TENANT}/filters/spam`, {
        params: { tenantId: TENANT, filterType: "spam" },
        body: { name: "Strict", settings: { spamAction: "Quarantine" }, preview: true },
      }),
    );
    expect(response.status).toBe(200);
    const plan = response.body as FilterChangePlan;
    expect(plan.action).toBe("create");
    expect(plan.dryRun).toBe(true);
    expect(plan.after).toMatchObject({ name: "Strict" });
    expect(queue.enqueued).toHaveLength(0);
    expect(audited).toHaveLength(0);
  });

  it("requires confirmation before disabling a filter", async () => {
    const routes = createFilterRoutes({
      provider: new FakeFiltersProvider(),
      queue: new FakeQueue(),
      resolveCaller: writerCaller,
    });
    await expect(
      routeByPath(routes, "PATCH", FILTERS_ITEM_PATH).handler(
        ctx(`/v1/tenants/${TENANT}/filters/spam/${SPAM_POLICY.name}`, {
          params: { tenantId: TENANT, filterType: "spam", policyName: SPAM_POLICY.name },
          body: { enabled: false },
        }),
      ),
    ).rejects.toMatchObject({ status: 400, code: FILTERS_CONFIRM_REQUIRED });
  });

  it("flags a disabling change as security-impacting in the plan preview", async () => {
    const routes = createFilterRoutes({
      provider: new FakeFiltersProvider(),
      queue: new FakeQueue(),
      resolveCaller: writerCaller,
    });
    const response = await routeByPath(routes, "PATCH", FILTERS_ITEM_PATH).handler(
      ctx(`/v1/tenants/${TENANT}/filters/spam/${SPAM_POLICY.name}`, {
        params: { tenantId: TENANT, filterType: "spam", policyName: SPAM_POLICY.name },
        body: { enabled: false, preview: true },
      }),
    );
    expect(response.status).toBe(200);
    const plan = response.body as FilterChangePlan;
    expect(plan.action).toBe("disable");
    expect(plan.securityImpacting).toBe(true);
    expect(plan.requiresConfirmation).toBe(true);
    expect(plan.warning).toContain("reduces protection");
  });

  it("disables a filter through the EPIC-006 gated path with a change row and audit", async () => {
    const queue = new FakeQueue();
    const audited: Record<string, unknown>[] = [];
    const routes = createFilterRoutes({
      provider: new FakeFiltersProvider(),
      queue,
      resolveCaller: writerCaller,
      recordAudit: async (event) => {
        audited.push(event);
      },
    });
    const response = await routeByPath(routes, "PATCH", FILTERS_ITEM_PATH).handler(
      ctx(`/v1/tenants/${TENANT}/filters/spam/${SPAM_POLICY.name}`, {
        params: { tenantId: TENANT, filterType: "spam", policyName: SPAM_POLICY.name },
        body: { enabled: false, confirm: true },
      }),
    );
    expect(response.status).toBe(202);
    const result = response.body as FilterChangeResult;
    expect(result.success).toBe(true);
    expect(result.plan.action).toBe("disable");
    expect(result.plan.securityImpacting).toBe(true);
    expect(result.plan.requiresConfirmation).toBe(true);

    expect(queue.enqueued).toHaveLength(1);
    expect(queue.enqueued[0]?.payload).toMatchObject({
      area: "filters",
      action: "disable",
      filterType: "spam",
      policyName: SPAM_POLICY.name,
      operation: "apply",
    });

    expect(audited).toHaveLength(1);
    expect(audited[0]).toMatchObject({
      action: "filters.policy.disable",
      targetId: SPAM_POLICY.name,
    });
  });

  it("flags a weakening edit as security-impacting and requires confirmation", async () => {
    const routes = createFilterRoutes({
      provider: new FakeFiltersProvider(),
      queue: new FakeQueue(),
      resolveCaller: writerCaller,
    });
    await expect(
      routeByPath(routes, "PATCH", FILTERS_ITEM_PATH).handler(
        ctx(`/v1/tenants/${TENANT}/filters/spam/${SPAM_POLICY.name}`, {
          params: { tenantId: TENANT, filterType: "spam", policyName: SPAM_POLICY.name },
          body: { settings: { spamAction: "MoveToJmf" } },
        }),
      ),
    ).rejects.toMatchObject({ status: 400, code: FILTERS_CONFIRM_REQUIRED });
  });

  it("applies a strengthening edit without confirmation", async () => {
    const queue = new FakeQueue();
    const routes = createFilterRoutes({
      provider: new FakeFiltersProvider(),
      queue,
      resolveCaller: writerCaller,
    });
    const response = await routeByPath(routes, "PATCH", FILTERS_ITEM_PATH).handler(
      ctx(`/v1/tenants/${TENANT}/filters/spam/${SPAM_POLICY.name}`, {
        params: { tenantId: TENANT, filterType: "spam", policyName: SPAM_POLICY.name },
        body: { settings: { spamAction: "Quarantine", bulkThreshold: 4 } },
      }),
    );
    expect(response.status).toBe(202);
    const result = response.body as FilterChangeResult;
    expect(result.plan.action).toBe("edit");
    expect(result.plan.securityImpacting).toBe(false);
    expect(queue.enqueued).toHaveLength(1);
  });

  it("requires confirmation before deleting a filter", async () => {
    const routes = createFilterRoutes({
      provider: new FakeFiltersProvider(),
      queue: new FakeQueue(),
      resolveCaller: writerCaller,
    });
    await expect(
      routeByPath(routes, "DELETE", FILTERS_ITEM_PATH).handler(
        ctx(`/v1/tenants/${TENANT}/filters/spam/${SPAM_POLICY.name}`, {
          params: { tenantId: TENANT, filterType: "spam", policyName: SPAM_POLICY.name },
          body: {},
        }),
      ),
    ).rejects.toMatchObject({ status: 400, code: FILTERS_CONFIRM_REQUIRED });
  });

  it("deletes a filter through the EPIC-006 gated path with audit", async () => {
    const queue = new FakeQueue();
    const audited: Record<string, unknown>[] = [];
    const routes = createFilterRoutes({
      provider: new FakeFiltersProvider(),
      queue,
      resolveCaller: writerCaller,
      recordAudit: async (event) => {
        audited.push(event);
      },
    });
    const response = await routeByPath(routes, "DELETE", FILTERS_ITEM_PATH).handler(
      ctx(`/v1/tenants/${TENANT}/filters/spam/${SPAM_POLICY.name}`, {
        params: { tenantId: TENANT, filterType: "spam", policyName: SPAM_POLICY.name },
        body: { confirm: true },
      }),
    );
    expect(response.status).toBe(202);
    const result = response.body as FilterChangeResult;
    expect(result.plan.action).toBe("delete");
    expect(result.plan.securityImpacting).toBe(true);

    expect(queue.enqueued).toHaveLength(1);
    expect(queue.enqueued[0]?.payload).toMatchObject({
      area: "filters",
      action: "delete",
      filterType: "spam",
      policyName: SPAM_POLICY.name,
    });

    expect(audited).toHaveLength(1);
    expect(audited[0]).toMatchObject({
      action: "filters.policy.delete",
      targetId: SPAM_POLICY.name,
    });
  });

  it("returns 404 when the filter does not exist", async () => {
    const routes = createFilterRoutes({
      provider: new FakeFiltersProvider(),
      queue: new FakeQueue(),
      resolveCaller: writerCaller,
    });
    await expect(
      routeByPath(routes, "PATCH", FILTERS_ITEM_PATH).handler(
        ctx(`/v1/tenants/${TENANT}/filters/spam/missing`, {
          params: { tenantId: TENANT, filterType: "spam", policyName: "missing" },
          body: { enabled: false, confirm: true },
        }),
      ),
    ).rejects.toMatchObject({ status: 404, code: FILTERS_NOT_FOUND });
  });

  it("rejects a patch with no editable fields", async () => {
    const routes = createFilterRoutes({
      provider: new FakeFiltersProvider(),
      queue: new FakeQueue(),
      resolveCaller: writerCaller,
    });
    await expect(
      routeByPath(routes, "PATCH", FILTERS_ITEM_PATH).handler(
        ctx(`/v1/tenants/${TENANT}/filters/spam/${SPAM_POLICY.name}`, {
          params: { tenantId: TENANT, filterType: "spam", policyName: SPAM_POLICY.name },
          body: {},
        }),
      ),
    ).rejects.toMatchObject({ status: 400 });
  });

  it("rejects a create without a name", async () => {
    const routes = createFilterRoutes({
      provider: new FakeFiltersProvider(),
      queue: new FakeQueue(),
      resolveCaller: writerCaller,
    });
    await expect(
      routeByPath(routes, "POST", FILTERS_PATH).handler(
        ctx(`/v1/tenants/${TENANT}/filters/spam`, {
          params: { tenantId: TENANT, filterType: "spam" },
          body: { settings: {} },
        }),
      ),
    ).rejects.toMatchObject({ status: 400 });
  });
});
