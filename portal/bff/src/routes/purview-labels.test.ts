// T-0587 — Purview sensitivity-label and SIT read + change gating.
// Route-level tests: the read routes validate Purview.Compliance.Read + tenant scope and
// return the live page; the change routes validate Purview.Compliance.ReadWrite, enforce the
// second-reviewer encryption gate, keep label creation and publishing-policy
// assignment separate, enqueue the EPIC-006 gated job, and record the
// CompliancePolicyChange row plus an audit event.

import { describe, expect, it } from "vitest";
import { tenantScope } from "../rbac/scope.js";
import type { JobEnvelope } from "@m365-assess/contracts";
import type { RequestContext } from "../server.js";
import type {
  CompliancePolicyChange,
  PurviewArea,
  PurviewComplianceRepository,
} from "../repository/purview-compliance.js";
import {
  LABEL_ENCRYPTION_REVIEW_NOT_DISTINCT,
  LABEL_ENCRYPTION_REVIEW_REQUIRED,
  PURVIEW_LABEL_ITEM_PATH,
  PURVIEW_LABEL_NOT_FOUND,
  PURVIEW_LABEL_PUBLISH_PATH,
  PURVIEW_LABEL_PUBLISH_SEPARATE,
  PURVIEW_LABELS_PATH,
  PURVIEW_READ_PERMISSION,
  PURVIEW_SIT_BUILTIN_READONLY,
  PURVIEW_SIT_ITEM_PATH,
  PURVIEW_SITS_PATH,
  PURVIEW_WRITE_PERMISSION,
  REMEDIATION_APPLY_PERMISSION,
  createPurviewLabelRoutes,
  type PurviewLabelChangeResult,
  type PurviewLabelPage,
  type PurviewLabelProvider,
  type PurviewSitChangeResult,
  type PurviewSitPage,
  type SensitiveInfoType,
  type SensitivityLabel,
} from "./purview-labels.js";

const TENANT = "tenant-test";

const LABEL: SensitivityLabel = {
  id: "label-1",
  name: "Confidential",
  scope: ["File", "Email"],
  priority: 1,
  encryption: {
    enabled: true,
    protectionType: "Template",
    templateId: "template-1",
    rights: ["principal-a:VIEW"],
  },
  marking: ["header"],
  state: "enabled",
  published: false,
  publishingPolicies: [],
};

const PUBLIC_LABEL: SensitivityLabel = {
  id: "label-2",
  name: "Public",
  scope: ["File"],
  priority: 5,
  encryption: null,
  marking: [],
  state: "enabled",
  published: false,
  publishingPolicies: [],
};

const SIT: SensitiveInfoType = {
  id: "sit-1",
  name: "Credit Card Number",
  type: "builtin",
  patternConfidence: "High",
  basedOn: null,
};

const CUSTOM_SIT: SensitiveInfoType = {
  id: "sit-2",
  name: "Employee Identifier",
  type: "custom",
  patternConfidence: "Medium",
  basedOn: "Credit Card Number",
};

const LABEL_PAGE: PurviewLabelPage = {
  tenantId: TENANT,
  kind: "labels",
  items: [LABEL, PUBLIC_LABEL],
  nextCursor: null,
  totalCount: 2,
};

const SIT_PAGE: PurviewSitPage = {
  tenantId: TENANT,
  kind: "sits",
  items: [SIT, CUSTOM_SIT],
  nextCursor: null,
  totalCount: 2,
};

class FakeLabelProvider implements PurviewLabelProvider {
  readonly getLabelCalls: Array<{ tenantId: string; labelId: string }> = [];

  async listLabels(tenantId: string): Promise<PurviewLabelPage> {
    void tenantId;
    return LABEL_PAGE;
  }

  async getLabel(tenantId: string, labelId: string): Promise<SensitivityLabel | undefined> {
    this.getLabelCalls.push({ tenantId, labelId });
    return [LABEL, PUBLIC_LABEL].find((label) => label.id === labelId);
  }

  async listSits(tenantId: string): Promise<PurviewSitPage> {
    void tenantId;
    return SIT_PAGE;
  }

  async getSit(tenantId: string, sitId: string): Promise<SensitiveInfoType | undefined> {
    void tenantId;
    return [SIT, CUSTOM_SIT].find((sit) => sit.id === sitId);
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
    area: PurviewArea;
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
      at: input.at ?? "2026-09-30T00:00:00.000Z",
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

function routeByPath(
  routes: ReturnType<typeof createPurviewLabelRoutes>,
  method: string,
  path: string,
) {
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
    correlationId: "corr-labels-1",
    method: "GET",
    path,
    query,
    headers: {},
    params: options.params ?? {},
    ...(options.body !== undefined ? { body: options.body } : {}),
  };
}

function makeRoutes(
  overrides: {
    provider?: PurviewLabelProvider;
    queue?: FakeQueue;
    repository?: FakeComplianceRepository;
    resolveCaller?: () => ReturnType<typeof writerCaller> | undefined;
    recordAudit?: (event: Record<string, unknown>) => Promise<void>;
  } = {},
) {
  return createPurviewLabelRoutes({
    provider: overrides.provider ?? new FakeLabelProvider(),
    queue: overrides.queue ?? new FakeQueue(),
    repository: overrides.repository ?? new FakeComplianceRepository(),
    resolveCaller: overrides.resolveCaller ?? writerCaller,
    ...(overrides.recordAudit ? { recordAudit: overrides.recordAudit } : {}),
  });
}

describe("Purview labels + SITs read + change routes (T-0587)", () => {
  it("exposes the read, change, and publish paths", () => {
    const routes = makeRoutes();
    expect(routes.map((route) => `${route.method} ${route.path}`)).toEqual([
      `GET ${PURVIEW_LABELS_PATH}`,
      `POST ${PURVIEW_LABELS_PATH}`,
      `GET ${PURVIEW_LABEL_ITEM_PATH}`,
      `PATCH ${PURVIEW_LABEL_ITEM_PATH}`,
      `DELETE ${PURVIEW_LABEL_ITEM_PATH}`,
      `POST ${PURVIEW_LABEL_PUBLISH_PATH}`,
      `GET ${PURVIEW_SITS_PATH}`,
      `POST ${PURVIEW_SITS_PATH}`,
      `GET ${PURVIEW_SIT_ITEM_PATH}`,
      `PATCH ${PURVIEW_SIT_ITEM_PATH}`,
      `DELETE ${PURVIEW_SIT_ITEM_PATH}`,
    ]);
  });

  it("rejects unauthenticated reads with 401", async () => {
    const routes = makeRoutes({ resolveCaller: () => undefined });
    await expect(
      routeByPath(routes, "GET", PURVIEW_LABELS_PATH).handler(
        ctx(`/v1/tenants/${TENANT}/purview/labels`, { params: { tenantId: TENANT } }),
      ),
    ).rejects.toMatchObject({ status: 401 });
  });

  it("rejects a tenant outside caller scope with 403", async () => {
    const routes = createPurviewLabelRoutes({
      provider: new FakeLabelProvider(),
      queue: new FakeQueue(),
      repository: new FakeComplianceRepository(),
      resolveCaller: () => ({
        tenantScope: tenantScope(["different-tenant"]),
        permissions: [PURVIEW_READ_PERMISSION],
      }),
    });
    await expect(
      routeByPath(routes, "GET", PURVIEW_LABELS_PATH).handler(
        ctx(`/v1/tenants/${TENANT}/purview/labels`, { params: { tenantId: TENANT } }),
      ),
    ).rejects.toMatchObject({ status: 403 });
  });

  it("rejects callers missing Purview.Compliance.Read with 403", async () => {
    const routes = makeRoutes({
      resolveCaller: () => ({
        tenantScope: tenantScope([TENANT]),
        permissions: ["SomeOther.Read"],
      }),
    });
    await expect(
      routeByPath(routes, "GET", PURVIEW_SITS_PATH).handler(
        ctx(`/v1/tenants/${TENANT}/purview/sits`, { params: { tenantId: TENANT } }),
      ),
    ).rejects.toMatchObject({ status: 403 });
  });

  it("lists labels with the §3.3 columns and pagination metadata", async () => {
    const routes = makeRoutes({ resolveCaller: readerCaller });
    const response = await routeByPath(routes, "GET", PURVIEW_LABELS_PATH).handler(
      ctx(`/v1/tenants/${TENANT}/purview/labels`, {
        params: { tenantId: TENANT },
        query: { limit: "50" },
      }),
    );
    expect(response.status).toBe(200);
    const body = response.body as {
      tenantId: string;
      kind: string;
      items: SensitivityLabel[];
      totalCount: number;
      nextCursor: string | null;
    };
    expect(body.tenantId).toBe(TENANT);
    expect(body.kind).toBe("labels");
    expect(body.items).toHaveLength(2);
    expect(body.items[0]).toMatchObject({
      id: "label-1",
      name: "Confidential",
      priority: 1,
      state: "enabled",
    });
    expect(body.items[0]?.encryption).toMatchObject({ enabled: true, templateId: "template-1" });
    expect(body.totalCount).toBe(2);
    expect(body.nextCursor).toBeNull();
  });

  it("gets one label and 404s when it is missing", async () => {
    const routes = makeRoutes({ resolveCaller: readerCaller });
    const response = await routeByPath(routes, "GET", PURVIEW_LABEL_ITEM_PATH).handler(
      ctx(`/v1/tenants/${TENANT}/purview/labels/${LABEL.id}`, {
        params: { tenantId: TENANT, labelId: LABEL.id },
      }),
    );
    expect(response.status).toBe(200);
    expect((response.body as { label: SensitivityLabel }).label.id).toBe(LABEL.id);

    await expect(
      routeByPath(routes, "GET", PURVIEW_LABEL_ITEM_PATH).handler(
        ctx(`/v1/tenants/${TENANT}/purview/labels/missing`, {
          params: { tenantId: TENANT, labelId: "missing" },
        }),
      ),
    ).rejects.toMatchObject({ status: 404, code: PURVIEW_LABEL_NOT_FOUND });
  });

  it("lists SITs with the §3.4 columns", async () => {
    const routes = makeRoutes({ resolveCaller: readerCaller });
    const response = await routeByPath(routes, "GET", PURVIEW_SITS_PATH).handler(
      ctx(`/v1/tenants/${TENANT}/purview/sits`, { params: { tenantId: TENANT } }),
    );
    expect(response.status).toBe(200);
    const body = response.body as { kind: string; items: SensitiveInfoType[] };
    expect(body.kind).toBe("sits");
    expect(body.items).toHaveLength(2);
    expect(body.items[0]).toMatchObject({
      id: "sit-1",
      name: "Credit Card Number",
      type: "builtin",
      patternConfidence: "High",
    });
    expect(body.items[1]).toMatchObject({ type: "custom", basedOn: "Credit Card Number" });
  });

  it("rejects callers missing Purview.Compliance.ReadWrite with 403", async () => {
    const routes = makeRoutes({ resolveCaller: readerCaller });
    await expect(
      routeByPath(routes, "POST", PURVIEW_LABELS_PATH).handler(
        ctx(`/v1/tenants/${TENANT}/purview/labels`, {
          params: { tenantId: TENANT },
          body: { name: "New label" },
        }),
      ),
    ).rejects.toMatchObject({ status: 403 });
  });

  it("accepts Remediation.Apply through the EPIC-006 gate", async () => {
    const queue = new FakeQueue();
    const repository = new FakeComplianceRepository();
    const routes = createPurviewLabelRoutes({
      provider: new FakeLabelProvider(),
      queue,
      repository,
      resolveCaller: () => ({
        tenantScope: tenantScope([TENANT]),
        permissions: [REMEDIATION_APPLY_PERMISSION],
        userId: "user-2",
      }),
    });
    const response = await routeByPath(routes, "POST", PURVIEW_LABELS_PATH).handler(
      ctx(`/v1/tenants/${TENANT}/purview/labels`, {
        params: { tenantId: TENANT },
        body: { name: "New label" },
      }),
    );
    expect(response.status).toBe(202);
    expect(queue.enqueued).toHaveLength(1);
    expect(queue.enqueued[0]?.payload).toMatchObject({ area: "label", action: "create" });
    expect(repository.changes).toHaveLength(1);
  });

  it("creates a non-encryption label through the EPIC-006 gated path and records a change row", async () => {
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
    const response = await routeByPath(routes, "POST", PURVIEW_LABELS_PATH).handler(
      ctx(`/v1/tenants/${TENANT}/purview/labels`, {
        params: { tenantId: TENANT },
        body: { name: "Internal", scope: ["File"], priority: 3 },
      }),
    );
    expect(response.status).toBe(202);
    const result = response.body as PurviewLabelChangeResult;
    expect(result.success).toBe(true);
    expect(result.plan.action).toBe("create");
    expect(result.plan.encryptionChanged).toBe(false);
    expect(result.plan.requiresSecondReview).toBe(false);

    expect(queue.enqueued).toHaveLength(1);
    expect(queue.enqueued[0]?.payload).toMatchObject({
      area: "label",
      action: "create",
      policyName: "Internal",
      operation: "apply",
    });
    expect(queue.enqueued[0]?.payload).not.toHaveProperty("encryptionApproval");

    expect(repository.changes).toHaveLength(1);
    expect(repository.changes[0]).toMatchObject({ tenantId: TENANT, area: "label", by: "user-1" });
    expect(repository.changes[0]?.after).toMatchObject({ name: "Internal", priority: 3 });

    expect(audited).toHaveLength(1);
    expect(audited[0]).toMatchObject({
      action: "label.policy.create",
      tenantId: TENANT,
      actorUserId: "user-1",
    });
  });

  it("refuses an encryption change without a second reviewer", async () => {
    const queue = new FakeQueue();
    const repository = new FakeComplianceRepository();
    const routes = makeRoutes({ queue, repository });
    await expect(
      routeByPath(routes, "POST", PURVIEW_LABELS_PATH).handler(
        ctx(`/v1/tenants/${TENANT}/purview/labels`, {
          params: { tenantId: TENANT },
          body: { name: "Secret", encryption: { enabled: true, templateId: "template-1" } },
        }),
      ),
    ).rejects.toMatchObject({ status: 409, code: LABEL_ENCRYPTION_REVIEW_REQUIRED });
    expect(queue.enqueued).toHaveLength(0);
    expect(repository.changes).toHaveLength(0);
  });

  it("refuses an encryption change approved by the requester", async () => {
    const routes = makeRoutes();
    await expect(
      routeByPath(routes, "POST", PURVIEW_LABELS_PATH).handler(
        ctx(`/v1/tenants/${TENANT}/purview/labels`, {
          params: { tenantId: TENANT },
          body: {
            name: "Secret",
            encryption: { enabled: true, templateId: "template-1" },
            encryptionApproval: { reviewerId: "user-1", approvedAt: "2026-09-30T00:00:00.000Z" },
          },
        }),
      ),
    ).rejects.toMatchObject({ status: 409, code: LABEL_ENCRYPTION_REVIEW_NOT_DISTINCT });
  });

  it("applies an encryption change once a distinct reviewer approves and records the approval", async () => {
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
    const response = await routeByPath(routes, "POST", PURVIEW_LABELS_PATH).handler(
      ctx(`/v1/tenants/${TENANT}/purview/labels`, {
        params: { tenantId: TENANT },
        body: {
          name: "Secret",
          encryption: { enabled: true, templateId: "template-1" },
          encryptionApproval: { reviewerId: "user-2", approvedAt: "2026-09-30T00:00:00.000Z" },
        },
      }),
    );
    expect(response.status).toBe(202);
    const result = response.body as PurviewLabelChangeResult;
    expect(result.plan.encryptionChanged).toBe(true);
    expect(result.plan.requiresSecondReview).toBe(true);
    expect(result.plan.encryptionApproval).toMatchObject({ reviewerId: "user-2" });

    expect(queue.enqueued[0]?.payload).toMatchObject({
      area: "label",
      action: "create",
      encryptionApproval: { reviewerId: "user-2" },
    });
    expect(repository.changes[0]?.after).toMatchObject({
      encryptionApproval: { reviewerId: "user-2" },
    });
    expect(audited[0]?.after).toMatchObject({ encryptionApproval: { reviewerId: "user-2" } });
  });

  it("rejects publishing-policy fields on label creation so publishing stays a separate operation", async () => {
    const queue = new FakeQueue();
    const routes = makeRoutes({ queue });
    await expect(
      routeByPath(routes, "POST", PURVIEW_LABELS_PATH).handler(
        ctx(`/v1/tenants/${TENANT}/purview/labels`, {
          params: { tenantId: TENANT },
          body: { name: "Internal", publishingPolicyName: "Default Policy" },
        }),
      ),
    ).rejects.toMatchObject({ status: 400, code: PURVIEW_LABEL_PUBLISH_SEPARATE });
    expect(queue.enqueued).toHaveLength(0);
  });

  it("assigns a publishing policy as a separate operation", async () => {
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
    const response = await routeByPath(routes, "POST", PURVIEW_LABEL_PUBLISH_PATH).handler(
      ctx(`/v1/tenants/${TENANT}/purview/labels/${LABEL.id}/publish`, {
        params: { tenantId: TENANT, labelId: LABEL.id },
        body: { publishingPolicyName: "Default Policy" },
      }),
    );
    expect(response.status).toBe(202);
    const result = response.body as PurviewLabelChangeResult;
    expect(result.plan.action).toBe("publish");
    expect(result.plan.encryptionChanged).toBe(false);
    expect(queue.enqueued[0]?.payload).toMatchObject({
      area: "label",
      action: "publish",
      publishingPolicyName: "Default Policy",
    });
    expect(repository.changes[0]?.after).toMatchObject({
      publishingPolicies: ["Default Policy"],
    });
    expect(audited[0]).toMatchObject({ action: "label.policy.publish" });
  });

  it("requires a publishing policy on the publish operation", async () => {
    const routes = makeRoutes();
    await expect(
      routeByPath(routes, "POST", PURVIEW_LABEL_PUBLISH_PATH).handler(
        ctx(`/v1/tenants/${TENANT}/purview/labels/${LABEL.id}/publish`, {
          params: { tenantId: TENANT, labelId: LABEL.id },
          body: {},
        }),
      ),
    ).rejects.toMatchObject({ status: 400 });
  });

  it("refuses to weaken encryption on edit without a second reviewer", async () => {
    const routes = makeRoutes();
    await expect(
      routeByPath(routes, "PATCH", PURVIEW_LABEL_ITEM_PATH).handler(
        ctx(`/v1/tenants/${TENANT}/purview/labels/${LABEL.id}`, {
          params: { tenantId: TENANT, labelId: LABEL.id },
          body: { encryption: { enabled: false } },
        }),
      ),
    ).rejects.toMatchObject({ status: 409, code: LABEL_ENCRYPTION_REVIEW_REQUIRED });
  });

  it("edits non-encryption fields without review", async () => {
    const queue = new FakeQueue();
    const repository = new FakeComplianceRepository();
    const routes = makeRoutes({ queue, repository });
    const response = await routeByPath(routes, "PATCH", PURVIEW_LABEL_ITEM_PATH).handler(
      ctx(`/v1/tenants/${TENANT}/purview/labels/${LABEL.id}`, {
        params: { tenantId: TENANT, labelId: LABEL.id },
        body: { name: "Highly Confidential" },
      }),
    );
    expect(response.status).toBe(202);
    const result = response.body as PurviewLabelChangeResult;
    expect(result.plan.action).toBe("edit");
    expect(result.plan.encryptionChanged).toBe(false);
    expect(result.plan.diff).toContain(
      "Rename sensitivity label from 'Confidential' to 'Highly Confidential'",
    );
    expect(repository.changes[0]?.before).toMatchObject({ name: "Confidential" });
    expect(repository.changes[0]?.after).toMatchObject({ name: "Highly Confidential" });
  });

  it("requires confirmation before deleting a label", async () => {
    const routes = makeRoutes();
    await expect(
      routeByPath(routes, "DELETE", PURVIEW_LABEL_ITEM_PATH).handler(
        ctx(`/v1/tenants/${TENANT}/purview/labels/${LABEL.id}`, {
          params: { tenantId: TENANT, labelId: LABEL.id },
          body: {},
        }),
      ),
    ).rejects.toMatchObject({ status: 400 });
  });

  it("requires a second reviewer before deleting an encrypted label", async () => {
    const routes = makeRoutes();
    await expect(
      routeByPath(routes, "DELETE", PURVIEW_LABEL_ITEM_PATH).handler(
        ctx(`/v1/tenants/${TENANT}/purview/labels/${LABEL.id}`, {
          params: { tenantId: TENANT, labelId: LABEL.id },
          body: { confirm: true },
        }),
      ),
    ).rejects.toMatchObject({ status: 409, code: LABEL_ENCRYPTION_REVIEW_REQUIRED });
  });

  it("creates, edits, and deletes a custom SIT through the EPIC-006 gated path", async () => {
    const queue = new FakeQueue();
    const repository = new FakeComplianceRepository();
    const routes = makeRoutes({ queue, repository });

    const created = await routeByPath(routes, "POST", PURVIEW_SITS_PATH).handler(
      ctx(`/v1/tenants/${TENANT}/purview/sits`, {
        params: { tenantId: TENANT },
        body: { name: "Employee Identifier", patternConfidence: "Medium" },
      }),
    );
    expect(created.status).toBe(202);
    expect((created.body as PurviewSitChangeResult).plan.action).toBe("create");

    const edited = await routeByPath(routes, "PATCH", PURVIEW_SIT_ITEM_PATH).handler(
      ctx(`/v1/tenants/${TENANT}/purview/sits/${CUSTOM_SIT.id}`, {
        params: { tenantId: TENANT, sitId: CUSTOM_SIT.id },
        body: { patternConfidence: "High" },
      }),
    );
    expect(edited.status).toBe(202);
    expect((edited.body as PurviewSitChangeResult).plan.diff.join(" ")).toContain(
      "pattern confidence",
    );

    const deleted = await routeByPath(routes, "DELETE", PURVIEW_SIT_ITEM_PATH).handler(
      ctx(`/v1/tenants/${TENANT}/purview/sits/${CUSTOM_SIT.id}`, {
        params: { tenantId: TENANT, sitId: CUSTOM_SIT.id },
        body: { confirm: true },
      }),
    );
    expect(deleted.status).toBe(202);
    expect((deleted.body as PurviewSitChangeResult).plan.action).toBe("delete");

    expect(queue.enqueued.map((envelope) => envelope.payload["action"])).toEqual([
      "create",
      "edit",
      "delete",
    ]);
    expect(repository.changes.map((change) => change.area)).toEqual(["sit", "sit", "sit"]);
  });

  it("refuses to edit or delete a built-in SIT", async () => {
    const routes = makeRoutes();
    await expect(
      routeByPath(routes, "PATCH", PURVIEW_SIT_ITEM_PATH).handler(
        ctx(`/v1/tenants/${TENANT}/purview/sits/${SIT.id}`, {
          params: { tenantId: TENANT, sitId: SIT.id },
          body: { name: "Renamed" },
        }),
      ),
    ).rejects.toMatchObject({ status: 409, code: PURVIEW_SIT_BUILTIN_READONLY });

    await expect(
      routeByPath(routes, "DELETE", PURVIEW_SIT_ITEM_PATH).handler(
        ctx(`/v1/tenants/${TENANT}/purview/sits/${SIT.id}`, {
          params: { tenantId: TENANT, sitId: SIT.id },
          body: { confirm: true },
        }),
      ),
    ).rejects.toMatchObject({ status: 409, code: PURVIEW_SIT_BUILTIN_READONLY });
  });

  it("rejects a label patch with no editable fields", async () => {
    const routes = makeRoutes();
    await expect(
      routeByPath(routes, "PATCH", PURVIEW_LABEL_ITEM_PATH).handler(
        ctx(`/v1/tenants/${TENANT}/purview/labels/${LABEL.id}`, {
          params: { tenantId: TENANT, labelId: LABEL.id },
          body: {},
        }),
      ),
    ).rejects.toMatchObject({ status: 400 });
  });
});
