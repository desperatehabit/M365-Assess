// T-0584 — Purview retention read + change gating.
// Route-level tests: the read route validates purview.read + tenant scope and
// returns the live page; the change routes validate purview.write, require
// confirmation for disable/delete, enqueue the EPIC-006 gated job, and record
// the CompliancePolicyChange row plus an audit event.

import { describe, expect, it } from "vitest";
import { tenantScope } from "../rbac/scope.js";
import type { JobEnvelope } from "@m365-assess/contracts";
import type { RequestContext } from "../server.js";
import type { CompliancePolicyChange, PurviewComplianceRepository } from "../repository/purview-compliance.js";
import {
  PURVIEW_READ_PERMISSION,
  PURVIEW_RETENTION_CONFIRM_REQUIRED,
  PURVIEW_RETENTION_ITEM_PATH,
  PURVIEW_RETENTION_NOT_FOUND,
  PURVIEW_RETENTION_PATH,
  PURVIEW_WRITE_PERMISSION,
  REMEDIATION_APPLY_PERMISSION,
  createPurviewRetentionRoutes,
  type EditPurviewRetentionInput,
  type PurviewRetentionChangeResult,
  type PurviewRetentionPage,
  type PurviewRetentionPolicy,
  type PurviewRetentionProvider,
} from "./purview-retention.js";

const TENANT = "tenant-test";

const POLICY: PurviewRetentionPolicy = {
  id: "policy-1",
  name: "Finance 7yr",
  state: "enabled",
  locations: ["Exchange", "SharePoint"],
  retentionPeriod: "2555 days",
  disposition: "Delete",
};

const PAGE: PurviewRetentionPage = {
  tenantId: TENANT,
  items: [POLICY],
  nextCursor: null,
  totalCount: 1,
};

class FakeRetentionProvider implements PurviewRetentionProvider {
  readonly getPolicyCalls: Array<{ tenantId: string; policyId: string }> = [];

  async listPolicies(tenantId: string): Promise<PurviewRetentionPage> {
    void tenantId;
    return PAGE;
  }

  async getPolicy(tenantId: string, policyId: string): Promise<PurviewRetentionPolicy | undefined> {
    this.getPolicyCalls.push({ tenantId, policyId });
    return policyId === POLICY.id ? POLICY : undefined;
  }
}

class FakeQueue {
  readonly enqueued: JobEnvelope[] = [];

  async enqueue(envelope: JobEnvelope): Promise<string> {
    this.enqueued.push(envelope);
    return envelope.jobId;
  }
}

class FakeComplianceRepository implements PurviewComplianceRepository {
  readonly schemaVersion = 1;
  readonly changes: CompliancePolicyChange[] = [];

  close(): void {}

  async createTemplate(): Promise<never> {
    throw new Error("not implemented");
  }

  async getTemplate(): Promise<never> {
    throw new Error("not implemented");
  }

  async listTemplates(): Promise<never> {
    throw new Error("not implemented");
  }

  async updateTemplate(): Promise<never> {
    throw new Error("not implemented");
  }

  async softDeleteTemplate(): Promise<never> {
    throw new Error("not implemented");
  }

  async recordPolicyChange(input: {
    id?: string;
    tenantId: string;
    area: "retention";
    policyId: string;
    at?: string;
    by: string;
    before?: Record<string, unknown> | string | null;
    after?: Record<string, unknown> | string | null;
  }): Promise<CompliancePolicyChange> {
    const change: CompliancePolicyChange = {
      id: input.id ?? `change-${this.changes.length + 1}`,
      tenantId: input.tenantId,
      area: input.area,
      policyId: input.policyId,
      at: input.at ?? "2026-09-29T00:00:00.000Z",
      by: input.by,
      before: typeof input.before === "string" ? JSON.parse(input.before) : (input.before ?? null),
      after: typeof input.after === "string" ? JSON.parse(input.after) : (input.after ?? null),
    };
    this.changes.push(change);
    return change;
  }

  async getPolicyChange(): Promise<never> {
    throw new Error("not implemented");
  }

  async listPolicyChanges(): Promise<never> {
    throw new Error("not implemented");
  }
}

function readerCaller() {
  return {
    tenantScope: tenantScope([TENANT]),
    permissions: [PURVIEW_READ_PERMISSION],
  };
}

function writerCaller() {
  return {
    tenantScope: tenantScope([TENANT]),
    permissions: [PURVIEW_WRITE_PERMISSION],
    userId: "user-1",
  };
}

function routeByPath(routes: ReturnType<typeof createPurviewRetentionRoutes>, method: string, path: string) {
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
    correlationId: "corr-retention-1",
    method: "GET",
    path,
    query,
    headers: {},
    params: options.params ?? {},
    ...(options.body !== undefined ? { body: options.body } : {}),
  };
}

describe("Purview retention read + change routes (T-0584)", () => {
  it("exposes the read and change paths", () => {
    const routes = createPurviewRetentionRoutes({
      provider: new FakeRetentionProvider(),
      queue: new FakeQueue(),
      repository: new FakeComplianceRepository(),
      resolveCaller: writerCaller,
    });
    expect(routes.map((route) => `${route.method} ${route.path}`)).toEqual([
      `GET ${PURVIEW_RETENTION_PATH}`,
      `POST ${PURVIEW_RETENTION_PATH}`,
      `PATCH ${PURVIEW_RETENTION_ITEM_PATH}`,
      `DELETE ${PURVIEW_RETENTION_ITEM_PATH}`,
    ]);
  });

  it("rejects unauthenticated read requests with 401", async () => {
    const routes = createPurviewRetentionRoutes({
      provider: new FakeRetentionProvider(),
      queue: new FakeQueue(),
      repository: new FakeComplianceRepository(),
      resolveCaller: () => undefined,
    });
    await expect(
      routeByPath(routes, "GET", PURVIEW_RETENTION_PATH).handler(
        ctx(`/v1/tenants/${TENANT}/purview/retention`, { params: { tenantId: TENANT } }),
      ),
    ).rejects.toMatchObject({ status: 401 });
  });

  it("rejects tenant outside caller scope with 403", async () => {
    const routes = createPurviewRetentionRoutes({
      provider: new FakeRetentionProvider(),
      queue: new FakeQueue(),
      repository: new FakeComplianceRepository(),
      resolveCaller: () => ({
        tenantScope: tenantScope(["different-tenant"]),
        permissions: [PURVIEW_READ_PERMISSION],
      }),
    });
    await expect(
      routeByPath(routes, "GET", PURVIEW_RETENTION_PATH).handler(
        ctx(`/v1/tenants/${TENANT}/purview/retention`, { params: { tenantId: TENANT } }),
      ),
    ).rejects.toMatchObject({ status: 403 });
  });

  it("rejects callers missing purview.read with 403", async () => {
    const routes = createPurviewRetentionRoutes({
      provider: new FakeRetentionProvider(),
      queue: new FakeQueue(),
      repository: new FakeComplianceRepository(),
      resolveCaller: () => ({
        tenantScope: tenantScope([TENANT]),
        permissions: ["SomeOther.Read"],
      }),
    });
    await expect(
      routeByPath(routes, "GET", PURVIEW_RETENTION_PATH).handler(
        ctx(`/v1/tenants/${TENANT}/purview/retention`, { params: { tenantId: TENANT } }),
      ),
    ).rejects.toMatchObject({ status: 403 });
  });

  it("lists policies live with cursor pagination", async () => {
    const provider = new FakeRetentionProvider();
    const routes = createPurviewRetentionRoutes({
      provider,
      queue: new FakeQueue(),
      repository: new FakeComplianceRepository(),
      resolveCaller: readerCaller,
    });
    const response = await routeByPath(routes, "GET", PURVIEW_RETENTION_PATH).handler(
      ctx(`/v1/tenants/${TENANT}/purview/retention`, {
        params: { tenantId: TENANT },
        query: { limit: "50" },
      }),
    );
    expect(response.status).toBe(200);
    const body = response.body as {
      tenantId: string;
      items: PurviewRetentionPolicy[];
      totalCount: number;
      nextCursor: string | null;
    };
    expect(body.tenantId).toBe(TENANT);
    expect(body.items).toHaveLength(1);
    expect(body.items[0]).toMatchObject({ id: "policy-1", name: "Finance 7yr", state: "enabled" });
    expect(body.totalCount).toBe(1);
    expect(body.nextCursor).toBeNull();
  });

  it("rejects unauthenticated change requests with 401", async () => {
    const routes = createPurviewRetentionRoutes({
      provider: new FakeRetentionProvider(),
      queue: new FakeQueue(),
      repository: new FakeComplianceRepository(),
      resolveCaller: () => undefined,
    });
    await expect(
      routeByPath(routes, "POST", PURVIEW_RETENTION_PATH).handler(
        ctx(`/v1/tenants/${TENANT}/purview/retention`, {
          params: { tenantId: TENANT },
          body: { name: "New policy" },
        }),
      ),
    ).rejects.toMatchObject({ status: 401 });
  });

  it("rejects callers missing purview.write with 403", async () => {
    const routes = createPurviewRetentionRoutes({
      provider: new FakeRetentionProvider(),
      queue: new FakeQueue(),
      repository: new FakeComplianceRepository(),
      resolveCaller: readerCaller,
    });
    await expect(
      routeByPath(routes, "POST", PURVIEW_RETENTION_PATH).handler(
        ctx(`/v1/tenants/${TENANT}/purview/retention`, {
          params: { tenantId: TENANT },
          body: { name: "New policy" },
        }),
      ),
    ).rejects.toMatchObject({ status: 403 });
  });

  it("accepts Remediation.Apply through the EPIC-006 gate", async () => {
    const queue = new FakeQueue();
    const repository = new FakeComplianceRepository();
    const routes = createPurviewRetentionRoutes({
      provider: new FakeRetentionProvider(),
      queue,
      repository,
      resolveCaller: () => ({
        tenantScope: tenantScope([TENANT]),
        permissions: [REMEDIATION_APPLY_PERMISSION],
        userId: "user-2",
      }),
    });
    const response = await routeByPath(routes, "POST", PURVIEW_RETENTION_PATH).handler(
      ctx(`/v1/tenants/${TENANT}/purview/retention`, {
        params: { tenantId: TENANT },
        body: { name: "New policy" },
      }),
    );
    expect(response.status).toBe(202);
    expect(queue.enqueued).toHaveLength(1);
    expect(queue.enqueued[0]?.payload).toMatchObject({ area: "retention", action: "create" });
    expect(repository.changes).toHaveLength(1);
  });

  it("creates a policy through the EPIC-006 gated path and records a change row", async () => {
    const queue = new FakeQueue();
    const repository = new FakeComplianceRepository();
    const audited: Record<string, unknown>[] = [];
    const routes = createPurviewRetentionRoutes({
      provider: new FakeRetentionProvider(),
      queue,
      repository,
      resolveCaller: writerCaller,
      recordAudit: async (event) => {
        audited.push(event);
      },
    });
    const response = await routeByPath(routes, "POST", PURVIEW_RETENTION_PATH).handler(
      ctx(`/v1/tenants/${TENANT}/purview/retention`, {
        params: { tenantId: TENANT },
        body: { name: "New policy", retentionPeriod: "3650 days", disposition: "Keep" },
      }),
    );
    expect(response.status).toBe(202);
    const result = response.body as PurviewRetentionChangeResult;
    expect(result.success).toBe(true);
    expect(result.plan.action).toBe("create");
    expect(result.plan.complianceImpacting).toBe(false);

    expect(queue.enqueued).toHaveLength(1);
    const envelope = queue.enqueued[0]!;
    expect(envelope.jobType).toBe("remediation");
    expect(envelope.tenantId).toBe(TENANT);
    expect(envelope.payload).toMatchObject({
      area: "retention",
      action: "create",
      policyName: "New policy",
      operation: "apply",
    });

    expect(repository.changes).toHaveLength(1);
    expect(repository.changes[0]).toMatchObject({
      tenantId: TENANT,
      area: "retention",
      by: "user-1",
    });
    expect(repository.changes[0]?.before).toBeNull();
    expect(repository.changes[0]?.after).toMatchObject({ name: "New policy" });

    expect(audited).toHaveLength(1);
    expect(audited[0]).toMatchObject({
      action: "retention.policy.create",
      tenantId: TENANT,
      actorUserId: "user-1",
    });
  });

  it("requires confirmation before disabling a policy", async () => {
    const routes = createPurviewRetentionRoutes({
      provider: new FakeRetentionProvider(),
      queue: new FakeQueue(),
      repository: new FakeComplianceRepository(),
      resolveCaller: writerCaller,
    });
    await expect(
      routeByPath(routes, "PATCH", PURVIEW_RETENTION_ITEM_PATH).handler(
        ctx(`/v1/tenants/${TENANT}/purview/retention/${POLICY.id}`, {
          params: { tenantId: TENANT, policyId: POLICY.id },
          body: { enabled: false },
        }),
      ),
    ).rejects.toMatchObject({ status: 400, code: PURVIEW_RETENTION_CONFIRM_REQUIRED });
  });

  it("disables a policy through the EPIC-006 gated path with a change row and audit", async () => {
    const queue = new FakeQueue();
    const repository = new FakeComplianceRepository();
    const audited: Record<string, unknown>[] = [];
    const routes = createPurviewRetentionRoutes({
      provider: new FakeRetentionProvider(),
      queue,
      repository,
      resolveCaller: writerCaller,
      recordAudit: async (event) => {
        audited.push(event);
      },
    });
    const response = await routeByPath(routes, "PATCH", PURVIEW_RETENTION_ITEM_PATH).handler(
      ctx(`/v1/tenants/${TENANT}/purview/retention/${POLICY.id}`, {
        params: { tenantId: TENANT, policyId: POLICY.id },
        body: { enabled: false, confirm: true },
      }),
    );
    expect(response.status).toBe(202);
    const result = response.body as PurviewRetentionChangeResult;
    expect(result.success).toBe(true);
    expect(result.plan.action).toBe("disable");
    expect(result.plan.complianceImpacting).toBe(true);
    expect(result.plan.requiresConfirmation).toBe(true);

    expect(queue.enqueued).toHaveLength(1);
    expect(queue.enqueued[0]?.payload).toMatchObject({
      area: "retention",
      action: "disable",
      policyId: POLICY.id,
      operation: "apply",
    });

    expect(repository.changes).toHaveLength(1);
    expect(repository.changes[0]).toMatchObject({
      tenantId: TENANT,
      area: "retention",
      policyId: POLICY.id,
      by: "user-1",
    });
    expect(repository.changes[0]?.before).toMatchObject({ name: "Finance 7yr", enabled: true });
    expect(repository.changes[0]?.after).toMatchObject({ name: "Finance 7yr", enabled: false });

    expect(audited).toHaveLength(1);
    expect(audited[0]).toMatchObject({
      action: "retention.policy.disable",
      targetId: POLICY.id,
    });
  });

  it("requires confirmation before deleting a policy", async () => {
    const routes = createPurviewRetentionRoutes({
      provider: new FakeRetentionProvider(),
      queue: new FakeQueue(),
      repository: new FakeComplianceRepository(),
      resolveCaller: writerCaller,
    });
    await expect(
      routeByPath(routes, "DELETE", PURVIEW_RETENTION_ITEM_PATH).handler(
        ctx(`/v1/tenants/${TENANT}/purview/retention/${POLICY.id}`, {
          params: { tenantId: TENANT, policyId: POLICY.id },
          body: {},
        }),
      ),
    ).rejects.toMatchObject({ status: 400, code: PURVIEW_RETENTION_CONFIRM_REQUIRED });
  });

  it("deletes a policy through the EPIC-006 gated path with a change row and audit", async () => {
    const queue = new FakeQueue();
    const repository = new FakeComplianceRepository();
    const audited: Record<string, unknown>[] = [];
    const routes = createPurviewRetentionRoutes({
      provider: new FakeRetentionProvider(),
      queue,
      repository,
      resolveCaller: writerCaller,
      recordAudit: async (event) => {
        audited.push(event);
      },
    });
    const response = await routeByPath(routes, "DELETE", PURVIEW_RETENTION_ITEM_PATH).handler(
      ctx(`/v1/tenants/${TENANT}/purview/retention/${POLICY.id}`, {
        params: { tenantId: TENANT, policyId: POLICY.id },
        body: { confirm: true },
      }),
    );
    expect(response.status).toBe(202);
    const result = response.body as PurviewRetentionChangeResult;
    expect(result.success).toBe(true);
    expect(result.plan.action).toBe("delete");
    expect(result.plan.complianceImpacting).toBe(true);

    expect(queue.enqueued).toHaveLength(1);
    expect(queue.enqueued[0]?.payload).toMatchObject({
      area: "retention",
      action: "delete",
      policyId: POLICY.id,
    });

    expect(repository.changes).toHaveLength(1);
    expect(repository.changes[0]?.before).toMatchObject({ name: "Finance 7yr" });
    expect(repository.changes[0]?.after).toBeNull();

    expect(audited).toHaveLength(1);
    expect(audited[0]).toMatchObject({
      action: "retention.policy.delete",
      targetId: POLICY.id,
    });
  });

  it("returns 404 when the policy does not exist", async () => {
    const routes = createPurviewRetentionRoutes({
      provider: new FakeRetentionProvider(),
      queue: new FakeQueue(),
      repository: new FakeComplianceRepository(),
      resolveCaller: writerCaller,
    });
    await expect(
      routeByPath(routes, "PATCH", PURVIEW_RETENTION_ITEM_PATH).handler(
        ctx(`/v1/tenants/${TENANT}/purview/retention/missing-policy`, {
          params: { tenantId: TENANT, policyId: "missing-policy" },
          body: { enabled: false, confirm: true },
        }),
      ),
    ).rejects.toMatchObject({ status: 404, code: PURVIEW_RETENTION_NOT_FOUND });
  });

  it("rejects a patch with no editable fields", async () => {
    const routes = createPurviewRetentionRoutes({
      provider: new FakeRetentionProvider(),
      queue: new FakeQueue(),
      repository: new FakeComplianceRepository(),
      resolveCaller: writerCaller,
    });
    await expect(
      routeByPath(routes, "PATCH", PURVIEW_RETENTION_ITEM_PATH).handler(
        ctx(`/v1/tenants/${TENANT}/purview/retention/${POLICY.id}`, {
          params: { tenantId: TENANT, policyId: POLICY.id },
          body: {},
        }),
      ),
    ).rejects.toMatchObject({ status: 400 });
  });

  it("edits a policy name through the EPIC-006 gated path", async () => {
    const queue = new FakeQueue();
    const repository = new FakeComplianceRepository();
    const routes = createPurviewRetentionRoutes({
      provider: new FakeRetentionProvider(),
      queue,
      repository,
      resolveCaller: writerCaller,
    });
    const response = await routeByPath(routes, "PATCH", PURVIEW_RETENTION_ITEM_PATH).handler(
      ctx(`/v1/tenants/${TENANT}/purview/retention/${POLICY.id}`, {
        params: { tenantId: TENANT, policyId: POLICY.id },
        body: { name: "Finance 10yr" },
      }),
    );
    expect(response.status).toBe(202);
    const result = response.body as PurviewRetentionChangeResult;
    expect(result.plan.action).toBe("edit");
    expect(result.plan.diff).toContain("Rename retention policy from 'Finance 7yr' to 'Finance 10yr'");

    expect(queue.enqueued[0]?.payload).toMatchObject({
      area: "retention",
      action: "edit",
      policyId: POLICY.id,
    });

    expect(repository.changes[0]?.before).toMatchObject({ name: "Finance 7yr" });
    expect(repository.changes[0]?.after).toMatchObject({ name: "Finance 10yr" });
  });
});
