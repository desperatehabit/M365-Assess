// T-0583 — Purview DLP policy change API.
// Route-level tests: the write routes validate Purview.Compliance.ReadWrite (or
// Remediation.Apply) + tenant scope, require an Idempotency-Key, refuse
// disable/delete without confirmation, enqueue the EPIC-006 gated apply job, and
// record the before/after CompliancePolicyChange row plus an audit event. A
// repeated Idempotency-Key replays the queued result instead of applying twice.

import { describe, expect, it } from "vitest";
import type { JobEnvelope } from "@m365-assess/contracts";
import { tenantScope } from "../rbac/scope.js";
import type { RequestContext } from "../server.js";
import type {
  CompliancePolicyChange,
  PurviewComplianceRepository,
} from "../repository/purview-compliance.js";
import {
  DLP_COMPLIANCE_IMPACTING_CODE,
  PURVIEW_DLP_ITEM_PATH,
  PURVIEW_DLP_PATH,
  PURVIEW_DLP_WRITE_NOT_FOUND,
  PURVIEW_WRITE_PERMISSION,
  REMEDIATION_APPLY_PERMISSION,
  createPurviewDlpWriteRoutes,
  type PurviewDlpChangeResult,
  type PurviewDlpWriteIdempotencyStore,
  type PurviewDlpWriteProvider,
} from "./purview-dlp-write.js";
import type { PurviewDlpPolicy } from "./purview-dlp.js";

const TENANT = "tenant-test";

const POLICY: PurviewDlpPolicy = {
  id: "policy-1",
  name: "Finance DLP",
  state: "enabled",
  locations: ["Exchange", "SharePoint"],
  rules: 2,
  lastModified: "2026-05-01T10:00:00.000Z",
};

const DISABLED_POLICY: PurviewDlpPolicy = {
  id: "policy-2",
  name: "Legal Hold DLP",
  state: "disabled",
  locations: ["Teams"],
  rules: 1,
  lastModified: "2026-06-02T11:00:00.000Z",
};

class FakeDlpWriteProvider implements PurviewDlpWriteProvider {
  readonly getCalls: Array<{ tenantId: string; policyId: string }> = [];

  async getPolicy(tenantId: string, policyId: string): Promise<PurviewDlpPolicy | undefined> {
    this.getCalls.push({ tenantId, policyId });
    return [POLICY, DISABLED_POLICY].find((policy) => policy.id === policyId);
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
    area: "dlp";
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

function writerCaller() {
  return {
    tenantScope: tenantScope([TENANT]),
    permissions: [PURVIEW_WRITE_PERMISSION],
    roles: [],
    userId: "user-1",
  };
}

function routeByPath(
  routes: ReturnType<typeof createPurviewDlpWriteRoutes>,
  method: string,
  path: string,
) {
  const route = routes.find((r) => r.method === method && r.path === path);
  if (!route) throw new Error(`missing route ${method} ${path}`);
  return route;
}

function ctx(
  path: string,
  options: {
    params?: Record<string, string>;
    body?: Record<string, unknown>;
    headers?: Record<string, string>;
  } = {},
): RequestContext {
  return {
    correlationId: "corr-dlp-write-1",
    method: "POST",
    path,
    query: new URLSearchParams(),
    headers: { "idempotency-key": "idem-1", ...(options.headers ?? {}) },
    params: options.params ?? {},
    ...(options.body !== undefined ? { body: options.body } : {}),
  };
}

function makeRoutes(
  overrides: {
    provider?: PurviewDlpWriteProvider;
    queue?: FakeQueue;
    repository?: FakeComplianceRepository;
    resolveCaller?: () => ReturnType<typeof writerCaller> | undefined;
    recordAudit?: (event: Record<string, unknown>) => Promise<void>;
    idempotency?: PurviewDlpWriteIdempotencyStore;
  } = {},
) {
  return createPurviewDlpWriteRoutes({
    provider: overrides.provider ?? new FakeDlpWriteProvider(),
    queue: overrides.queue ?? new FakeQueue(),
    repository: overrides.repository ?? new FakeComplianceRepository(),
    resolveCaller: overrides.resolveCaller ?? writerCaller,
    ...(overrides.recordAudit ? { recordAudit: overrides.recordAudit } : {}),
    ...(overrides.idempotency ? { idempotency: overrides.idempotency } : {}),
  });
}

describe("Purview DLP change routes (T-0583)", () => {
  it("exposes the create, edit, and delete paths", () => {
    const routes = makeRoutes();
    expect(routes.map((route) => `${route.method} ${route.path}`)).toEqual([
      `POST ${PURVIEW_DLP_PATH}`,
      `PATCH ${PURVIEW_DLP_ITEM_PATH}`,
      `DELETE ${PURVIEW_DLP_ITEM_PATH}`,
    ]);
  });

  it("rejects unauthenticated writes with 401", async () => {
    const routes = makeRoutes({ resolveCaller: () => undefined });
    await expect(
      routeByPath(routes, "POST", PURVIEW_DLP_PATH).handler(
        ctx(`/v1/tenants/${TENANT}/purview/dlp`, {
          params: { tenantId: TENANT },
          body: { name: "New DLP" },
        }),
      ),
    ).rejects.toMatchObject({ status: 401 });
  });

  it("rejects a tenant outside caller scope with 403", async () => {
    const routes = createPurviewDlpWriteRoutes({
      provider: new FakeDlpWriteProvider(),
      queue: new FakeQueue(),
      repository: new FakeComplianceRepository(),
      resolveCaller: () => ({
        tenantScope: tenantScope(["different-tenant"]),
        permissions: [PURVIEW_WRITE_PERMISSION],
        roles: [],
        userId: "user-1",
      }),
    });
    await expect(
      routeByPath(routes, "POST", PURVIEW_DLP_PATH).handler(
        ctx(`/v1/tenants/${TENANT}/purview/dlp`, {
          params: { tenantId: TENANT },
          body: { name: "New DLP" },
        }),
      ),
    ).rejects.toMatchObject({ status: 403 });
  });

  it("rejects callers missing Purview.Compliance.ReadWrite with a structured 403", async () => {
    const routes = makeRoutes({
      resolveCaller: () => ({
        tenantScope: tenantScope([TENANT]),
        permissions: ["SomeOther.Read"],
        roles: [],
        userId: "user-1",
      }),
    });
    await expect(
      routeByPath(routes, "POST", PURVIEW_DLP_PATH).handler(
        ctx(`/v1/tenants/${TENANT}/purview/dlp`, {
          params: { tenantId: TENANT },
          body: { name: "New DLP" },
        }),
      ),
    ).rejects.toMatchObject({ status: 403, code: "auth.forbidden" });
  });

  it("requires an Idempotency-Key", async () => {
    const routes = makeRoutes();
    await expect(
      routeByPath(routes, "POST", PURVIEW_DLP_PATH).handler(
        ctx(`/v1/tenants/${TENANT}/purview/dlp`, {
          params: { tenantId: TENANT },
          body: { name: "New DLP" },
          headers: { "idempotency-key": "" },
        }),
      ),
    ).rejects.toMatchObject({ status: 400 });
  });

  it("creates a DLP policy through the EPIC-006 gated path and records a change row", async () => {
    const queue = new FakeQueue();
    const repository = new FakeComplianceRepository();
    const audited: Record<string, unknown>[] = [];
    const routes = makeRoutes({
      queue,
      repository,
      recordAudit: async (event) => {
        audited.push(event);
      },
    });

    const response = await routeByPath(routes, "POST", PURVIEW_DLP_PATH).handler(
      ctx(`/v1/tenants/${TENANT}/purview/dlp`, {
        params: { tenantId: TENANT },
        body: { name: "New DLP", locations: ["Exchange"] },
      }),
    );

    expect(response.status).toBe(202);
    const result = response.body as PurviewDlpChangeResult;
    expect(result.success).toBe(true);
    expect(result.plan.action).toBe("create");
    expect(result.plan.complianceImpacting).toBe(false);
    expect(result.plan.diff).toContain("Create DLP policy 'New DLP'");

    expect(queue.enqueued).toHaveLength(1);
    expect(queue.enqueued[0]?.jobType).toBe("remediation");
    expect(queue.enqueued[0]?.tenantId).toBe(TENANT);
    expect(queue.enqueued[0]?.payload).toMatchObject({
      area: "dlp",
      action: "create",
      policyName: "New DLP",
      operation: "apply",
      idempotencyKey: "idem-1",
    });

    expect(repository.changes).toHaveLength(1);
    expect(repository.changes[0]).toMatchObject({ tenantId: TENANT, area: "dlp", by: "user-1" });
    expect(repository.changes[0]?.before).toBeNull();
    expect(repository.changes[0]?.after).toMatchObject({ name: "New DLP", enabled: true });

    expect(audited).toHaveLength(1);
    expect(audited[0]).toMatchObject({
      action: "dlp.policy.create",
      tenantId: TENANT,
      actorUserId: "user-1",
    });
  });

  it("replays a repeated Idempotency-Key instead of applying twice", async () => {
    const queue = new FakeQueue();
    const repository = new FakeComplianceRepository();
    const routes = makeRoutes({ queue, repository });
    const path = `/v1/tenants/${TENANT}/purview/dlp`;
    const request = () =>
      ctx(path, { params: { tenantId: TENANT }, body: { name: "New DLP" } });

    const first = await routeByPath(routes, "POST", PURVIEW_DLP_PATH).handler(request());
    const second = await routeByPath(routes, "POST", PURVIEW_DLP_PATH).handler(request());

    expect(first.status).toBe(202);
    expect(second.status).toBe(200);
    expect(second.body).toMatchObject({ replayed: true, jobId: (first.body as PurviewDlpChangeResult).jobId });
    expect(queue.enqueued).toHaveLength(1);
    expect(repository.changes).toHaveLength(1);
  });

  it("accepts Remediation.Apply through the EPIC-006 gate", async () => {
    const queue = new FakeQueue();
    const routes = makeRoutes({
      queue,
      resolveCaller: () => ({
        tenantScope: tenantScope([TENANT]),
        permissions: [REMEDIATION_APPLY_PERMISSION],
        roles: [],
        userId: "user-2",
      }),
    });
    const response = await routeByPath(routes, "POST", PURVIEW_DLP_PATH).handler(
      ctx(`/v1/tenants/${TENANT}/purview/dlp`, {
        params: { tenantId: TENANT },
        body: { name: "New DLP" },
      }),
    );
    expect(response.status).toBe(202);
    expect(queue.enqueued).toHaveLength(1);
  });

  it("requires confirmation before disabling a policy and flags it compliance-impacting", async () => {
    const routes = makeRoutes();
    await expect(
      routeByPath(routes, "PATCH", PURVIEW_DLP_ITEM_PATH).handler(
        ctx(`/v1/tenants/${TENANT}/purview/dlp/${POLICY.id}`, {
          params: { tenantId: TENANT, policyId: POLICY.id },
          body: { enabled: false },
        }),
      ),
    ).rejects.toMatchObject({ status: 400, code: DLP_COMPLIANCE_IMPACTING_CODE });
  });

  it("disables a policy through the EPIC-006 gated path with a change row and audit", async () => {
    const queue = new FakeQueue();
    const repository = new FakeComplianceRepository();
    const audited: Record<string, unknown>[] = [];
    const routes = makeRoutes({
      queue,
      repository,
      recordAudit: async (event) => {
        audited.push(event);
      },
    });

    const response = await routeByPath(routes, "PATCH", PURVIEW_DLP_ITEM_PATH).handler(
      ctx(`/v1/tenants/${TENANT}/purview/dlp/${POLICY.id}`, {
        params: { tenantId: TENANT, policyId: POLICY.id },
        body: { enabled: false, confirm: true },
      }),
    );

    expect(response.status).toBe(202);
    const result = response.body as PurviewDlpChangeResult;
    expect(result.plan.action).toBe("disable");
    expect(result.plan.complianceImpacting).toBe(true);
    expect(result.plan.requiresConfirmation).toBe(true);
    expect(result.plan.warning).toBeDefined();

    expect(queue.enqueued[0]?.payload).toMatchObject({
      area: "dlp",
      action: "disable",
      policyId: POLICY.id,
      operation: "apply",
    });

    expect(repository.changes).toHaveLength(1);
    expect(repository.changes[0]?.before).toMatchObject({ name: "Finance DLP", enabled: true });
    expect(repository.changes[0]?.after).toMatchObject({ name: "Finance DLP", enabled: false });

    expect(audited[0]).toMatchObject({ action: "dlp.policy.disable", targetId: POLICY.id });
  });

  it("enables a disabled policy without confirmation", async () => {
    const queue = new FakeQueue();
    const routes = makeRoutes({ queue });
    const response = await routeByPath(routes, "PATCH", PURVIEW_DLP_ITEM_PATH).handler(
      ctx(`/v1/tenants/${TENANT}/purview/dlp/${DISABLED_POLICY.id}`, {
        params: { tenantId: TENANT, policyId: DISABLED_POLICY.id },
        body: { enabled: true },
      }),
    );
    expect(response.status).toBe(202);
    const result = response.body as PurviewDlpChangeResult;
    expect(result.plan.action).toBe("enable");
    expect(result.plan.complianceImpacting).toBe(false);
    expect(queue.enqueued[0]?.payload).toMatchObject({ area: "dlp", action: "enable" });
  });

  it("edits a policy through the EPIC-006 gated path", async () => {
    const queue = new FakeQueue();
    const repository = new FakeComplianceRepository();
    const routes = makeRoutes({ queue, repository });
    const response = await routeByPath(routes, "PATCH", PURVIEW_DLP_ITEM_PATH).handler(
      ctx(`/v1/tenants/${TENANT}/purview/dlp/${POLICY.id}`, {
        params: { tenantId: TENANT, policyId: POLICY.id },
        body: { name: "Finance DLP v2" },
      }),
    );
    expect(response.status).toBe(202);
    const result = response.body as PurviewDlpChangeResult;
    expect(result.plan.action).toBe("edit");
    expect(result.plan.diff).toContain("Rename DLP policy from 'Finance DLP' to 'Finance DLP v2'");
    expect(repository.changes[0]?.before).toMatchObject({ name: "Finance DLP" });
    expect(repository.changes[0]?.after).toMatchObject({ name: "Finance DLP v2" });
  });

  it("rejects a patch with no editable fields", async () => {
    const routes = makeRoutes();
    await expect(
      routeByPath(routes, "PATCH", PURVIEW_DLP_ITEM_PATH).handler(
        ctx(`/v1/tenants/${TENANT}/purview/dlp/${POLICY.id}`, {
          params: { tenantId: TENANT, policyId: POLICY.id },
          body: {},
        }),
      ),
    ).rejects.toMatchObject({ status: 400 });
  });

  it("requires confirmation before deleting a policy", async () => {
    const routes = makeRoutes();
    await expect(
      routeByPath(routes, "DELETE", PURVIEW_DLP_ITEM_PATH).handler(
        ctx(`/v1/tenants/${TENANT}/purview/dlp/${POLICY.id}`, {
          params: { tenantId: TENANT, policyId: POLICY.id },
          body: {},
        }),
      ),
    ).rejects.toMatchObject({ status: 400, code: DLP_COMPLIANCE_IMPACTING_CODE });
  });

  it("deletes a policy through the EPIC-006 gated path with a change row and audit", async () => {
    const queue = new FakeQueue();
    const repository = new FakeComplianceRepository();
    const audited: Record<string, unknown>[] = [];
    const routes = makeRoutes({
      queue,
      repository,
      recordAudit: async (event) => {
        audited.push(event);
      },
    });

    const response = await routeByPath(routes, "DELETE", PURVIEW_DLP_ITEM_PATH).handler(
      ctx(`/v1/tenants/${TENANT}/purview/dlp/${POLICY.id}`, {
        params: { tenantId: TENANT, policyId: POLICY.id },
        body: { confirm: true },
      }),
    );

    expect(response.status).toBe(202);
    const result = response.body as PurviewDlpChangeResult;
    expect(result.plan.action).toBe("delete");
    expect(result.plan.complianceImpacting).toBe(true);

    expect(queue.enqueued[0]?.payload).toMatchObject({
      area: "dlp",
      action: "delete",
      policyId: POLICY.id,
    });

    expect(repository.changes[0]?.before).toMatchObject({ name: "Finance DLP" });
    expect(repository.changes[0]?.after).toBeNull();

    expect(audited[0]).toMatchObject({ action: "dlp.policy.delete", targetId: POLICY.id });
  });

  it("returns 404 when the policy does not exist", async () => {
    const routes = makeRoutes();
    await expect(
      routeByPath(routes, "PATCH", PURVIEW_DLP_ITEM_PATH).handler(
        ctx(`/v1/tenants/${TENANT}/purview/dlp/missing`, {
          params: { tenantId: TENANT, policyId: "missing" },
          body: { enabled: false, confirm: true },
        }),
      ),
    ).rejects.toMatchObject({ status: 404, code: PURVIEW_DLP_WRITE_NOT_FOUND });
  });
});
