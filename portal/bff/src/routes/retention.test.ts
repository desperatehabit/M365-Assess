import { describe, expect, it } from "vitest";
import { tenantScope } from "../rbac/scope.js";
import {
  REMEDIATION_APPLY_PERMISSION,
  RETENTION_ASSIGN_BULK_PATH,
  RETENTION_ASSIGN_PATH,
  RETENTION_POLICIES_PATH,
  RETENTION_TAGS_PATH,
  RETENTION_TAG_ITEM_PATH,
  RETENTION_WRITE_PERMISSION,
  createRetentionRoutes,
  validateRetentionDays,
  validateRetentionTagName,
  type AssignRetentionTagBulkInput,
  type AssignRetentionTagInput,
  type CreateRetentionTagInput,
  type EditRetentionTagInput,
  type RetentionAssignBulkPlan,
  type RetentionAssignBulkResult,
  type RetentionAssignPlan,
  type RetentionAssignResult,
  type RetentionCaller,
  type RetentionProvider,
  type RetentionTagPlan,
  type RetentionTagResult,
} from "./retention.js";

const TENANT = "tenant-test";

const TAG_PLAN: RetentionTagPlan = {
  action: "create",
  targetName: "Finance 7yr",
  before: null,
  after: { name: "Finance 7yr", type: "delete", retentionDays: 2555 },
  diff: ["Create retention tag 'Finance 7yr'"],
  valid: true,
  dryRun: true,
  requiresConfirmation: false,
};

const TAG_RESULT: RetentionTagResult = {
  success: true,
  plan: { ...TAG_PLAN, dryRun: false },
  result: { id: "tag-1", name: "Finance 7yr" },
  auditEvent: {
    id: "audit-tag-1",
    tenantId: TENANT,
    action: "retention.tag.create",
    targetId: "tag-1",
    targetName: "Finance 7yr",
    timestamp: "2026-09-28T00:00:00.000Z",
    before: null,
    after: { name: "Finance 7yr" },
  },
};

const ASSIGN_PLAN: RetentionAssignPlan = {
  action: "assign",
  tagId: "tag-1",
  affectedMailboxes: ["mbx-2"],
  before: { mailboxId: "mbx-2", retentionTag: null },
  after: { mailboxId: "mbx-2", retentionTag: "tag-1" },
  diff: ["Assign retention tag 'tag-1' to mailbox 'mbx-2'"],
  valid: true,
  dryRun: true,
  requiresConfirmation: false,
};

const ASSIGN_RESULT: RetentionAssignResult = {
  success: true,
  plan: { ...ASSIGN_PLAN, dryRun: false },
  result: { mailboxId: "mbx-2", tagId: "tag-1" },
  mailboxOperation: {
    id: "op-1",
    tenantId: TENANT,
    mailboxId: "mbx-2",
    operation: "retention.assign",
    before: { retentionTag: null },
    after: { retentionTag: "tag-1" },
    state: "applied",
  },
  auditEvent: {
    id: "audit-assign-1",
    tenantId: TENANT,
    action: "retention.assign",
    targetId: "mbx-2",
    targetName: "mbx-2",
    timestamp: "2026-09-28T00:00:00.000Z",
    before: { retentionTag: null },
    after: { retentionTag: "tag-1" },
  },
};

const BULK_PLAN: RetentionAssignBulkPlan = {
  action: "assignBulk",
  tagId: "tag-1",
  affectedMailboxes: ["mbx-1", "mbx-2"],
  diff: [
    "Assign retention tag 'tag-1' to mailbox 'mbx-1'",
    "Assign retention tag 'tag-1' to mailbox 'mbx-2'",
  ],
  valid: true,
  dryRun: true,
  requiresConfirmation: false,
};

const BULK_RESULT: RetentionAssignBulkResult = {
  success: true,
  plan: { ...BULK_PLAN, dryRun: false },
  results: [
    {
      mailboxId: "mbx-1",
      status: "assigned",
      before: { retentionTag: null },
      after: { retentionTag: "tag-1" },
    },
    {
      mailboxId: "mbx-2",
      status: "assigned",
      before: { retentionTag: null },
      after: { retentionTag: "tag-1" },
    },
  ],
  mailboxOperations: [
    {
      id: "op-b1",
      tenantId: TENANT,
      mailboxId: "mbx-1",
      operation: "retention.assign",
      before: { retentionTag: null },
      after: { retentionTag: "tag-1" },
      state: "applied",
    },
  ],
  auditEvents: [
    {
      id: "audit-b1",
      tenantId: TENANT,
      action: "retention.assign",
      targetId: "mbx-1",
      targetName: "mbx-1",
      timestamp: "2026-09-28T00:00:00.000Z",
      before: { retentionTag: null },
      after: { retentionTag: "tag-1" },
    },
  ],
};

class FakeRetentionProvider implements RetentionProvider {
  readonly assignCalls: Array<{ tenantId: string; input: AssignRetentionTagInput; preview: boolean }> = [];
  readonly assignBulkCalls: Array<{
    tenantId: string;
    input: AssignRetentionTagBulkInput;
    preview: boolean;
  }> = [];
  readonly recordedAudits: Record<string, unknown>[] = [];

  async listPolicies(tenantId: string) {
    return [{ id: "policy-1", name: "Finance policy", enabled: true, tenantId }].map(
      ({ tenantId: _ignored, ...rest }) => rest,
    );
  }

  async listTags(tenantId: string) {
    void tenantId;
    return [
      {
        id: "tag-1",
        name: "Finance 7yr",
        type: "delete",
        retentionDays: 2555,
        retentionAction: "DeleteAndAllowRecovery",
        enabled: true,
      },
    ];
  }

  async createTag(
    tenantId: string,
    input: CreateRetentionTagInput,
    preview: boolean,
  ): Promise<RetentionTagResult | RetentionTagPlan> {
    void tenantId;
    void input;
    return preview ? TAG_PLAN : TAG_RESULT;
  }

  async editTag(
    tenantId: string,
    tagId: string,
    input: EditRetentionTagInput,
    preview: boolean,
  ): Promise<RetentionTagResult | RetentionTagPlan> {
    void tenantId;
    void input;
    const plan: RetentionTagPlan = {
      ...TAG_PLAN,
      action: "edit",
      tagId,
      dryRun: preview,
    };
    return preview
      ? plan
      : {
          success: true,
          plan,
          result: { id: tagId },
          auditEvent: { ...TAG_RESULT.auditEvent!, action: "retention.tag.edit", targetId: tagId },
        };
  }

  async assignTag(
    tenantId: string,
    input: AssignRetentionTagInput,
    preview: boolean,
  ): Promise<RetentionAssignResult | RetentionAssignPlan> {
    this.assignCalls.push({ tenantId, input, preview });
    return preview ? ASSIGN_PLAN : ASSIGN_RESULT;
  }

  async assignTagBulk(
    tenantId: string,
    input: AssignRetentionTagBulkInput,
    preview: boolean,
  ): Promise<RetentionAssignBulkResult | RetentionAssignBulkPlan> {
    this.assignBulkCalls.push({ tenantId, input, preview });
    return preview ? BULK_PLAN : BULK_RESULT;
  }
}

function writerCaller(): RetentionCaller {
  return {
    tenantScope: tenantScope([TENANT]),
    permissions: [RETENTION_WRITE_PERMISSION],
  };
}

function routeByPath(routes: ReturnType<typeof createRetentionRoutes>, method: string, path: string) {
  const route = routes.find((r) => r.method === method && r.path === path);
  if (!route) throw new Error(`missing route ${method} ${path}`);
  return route;
}

describe("Retention policy/tag reads and tag writes (T-0387)", () => {
  it("exposes the policy, tag, and assignment paths", () => {
    const routes = createRetentionRoutes({
      provider: new FakeRetentionProvider(),
      resolveCaller: writerCaller,
    });
    expect(routes.map((route) => `${route.method} ${route.path}`)).toEqual([
      `GET ${RETENTION_POLICIES_PATH}`,
      `GET ${RETENTION_TAGS_PATH}`,
      `POST ${RETENTION_TAGS_PATH}`,
      `PATCH ${RETENTION_TAG_ITEM_PATH}`,
      `POST ${RETENTION_ASSIGN_PATH}`,
      `POST ${RETENTION_ASSIGN_BULK_PATH}`,
    ]);
  });

  it("rejects unauthenticated requests with 401", async () => {
    const routes = createRetentionRoutes({
      provider: new FakeRetentionProvider(),
      resolveCaller: () => undefined,
    });
    await expect(
      routes[0]!.handler({
        method: "GET",
        path: `/v1/tenants/${TENANT}/retention/policies`,
        params: { tenantId: TENANT },
        query: new URLSearchParams(),
        headers: {},
      }),
    ).rejects.toMatchObject({ status: 401 });
  });

  it("rejects tenant outside caller scope with 403", async () => {
    const routes = createRetentionRoutes({
      provider: new FakeRetentionProvider(),
      resolveCaller: () => ({
        tenantScope: tenantScope(["different-tenant"]),
        permissions: [RETENTION_WRITE_PERMISSION],
      }),
    });
    await expect(
      routeByPath(routes, "POST", RETENTION_ASSIGN_PATH).handler({
        method: "POST",
        path: `/v1/tenants/${TENANT}/retention/assign`,
        params: { tenantId: TENANT },
        query: new URLSearchParams(),
        headers: {},
        body: { mailboxId: "mbx-2", tagId: "tag-1" },
      }),
    ).rejects.toMatchObject({ status: 403 });
  });

  it("rejects callers missing Mailboxes.Mailbox.ReadWrite with 403", async () => {
    const routes = createRetentionRoutes({
      provider: new FakeRetentionProvider(),
      resolveCaller: () => ({
        tenantScope: tenantScope([TENANT]),
        permissions: ["Mailboxes.Mailbox.Read"],
      }),
    });
    await expect(
      routeByPath(routes, "POST", RETENTION_ASSIGN_PATH).handler({
        method: "POST",
        path: `/v1/tenants/${TENANT}/retention/assign`,
        params: { tenantId: TENANT },
        query: new URLSearchParams(),
        headers: {},
        body: { mailboxId: "mbx-2", tagId: "tag-1" },
      }),
    ).rejects.toMatchObject({ status: 403 });
  });

  it("accepts Remediation.Apply through the EPIC-006 gate", async () => {
    const provider = new FakeRetentionProvider();
    const routes = createRetentionRoutes({
      provider,
      resolveCaller: () => ({
        tenantScope: tenantScope([TENANT]),
        permissions: [REMEDIATION_APPLY_PERMISSION],
      }),
    });
    const response = await routeByPath(routes, "POST", RETENTION_ASSIGN_PATH).handler({
      method: "POST",
      path: `/v1/tenants/${TENANT}/retention/assign`,
      params: { tenantId: TENANT },
      query: new URLSearchParams(),
      headers: {},
      body: { mailboxId: "mbx-2", tagId: "tag-1" },
    });
    expect(response.status).toBe(200);
    expect(provider.assignCalls[0]).toMatchObject({ tenantId: TENANT, preview: false });
  });

  it("lists policies and tags live", async () => {
    const routes = createRetentionRoutes({
      provider: new FakeRetentionProvider(),
      resolveCaller: () => ({
        tenantScope: tenantScope([TENANT]),
        permissions: ["Mailboxes.Mailbox.Read"],
      }),
    });
    const policies = await routeByPath(routes, "GET", RETENTION_POLICIES_PATH).handler({
      method: "GET",
      path: `/v1/tenants/${TENANT}/retention/policies`,
      params: { tenantId: TENANT },
      query: new URLSearchParams(),
      headers: {},
    });
    expect(policies.status).toBe(200);
    expect((policies.body as { policies: unknown[] }).policies).toHaveLength(1);

    const tags = await routeByPath(routes, "GET", RETENTION_TAGS_PATH).handler({
      method: "GET",
      path: `/v1/tenants/${TENANT}/retention/tags`,
      params: { tenantId: TENANT },
      query: new URLSearchParams(),
      headers: {},
    });
    expect(tags.status).toBe(200);
    expect((tags.body as { tags: { id: string }[] }).tags[0]?.id).toBe("tag-1");
  });

  it("creates a tag with before/after and an audit event", async () => {
    const routes = createRetentionRoutes({ provider: new FakeRetentionProvider(), resolveCaller: writerCaller });
    const response = await routeByPath(routes, "POST", RETENTION_TAGS_PATH).handler({
      method: "POST",
      path: `/v1/tenants/${TENANT}/retention/tags`,
      params: { tenantId: TENANT },
      query: new URLSearchParams(),
      headers: {},
      body: { name: "Finance 7yr", type: "delete", retentionDays: 2555 },
    });
    expect(response.status).toBe(201);
    const body = response.body as RetentionTagResult;
    expect(body.success).toBe(true);
    expect(body.auditEvent?.action).toBe("retention.tag.create");
    expect(body.plan.after).toMatchObject({ name: "Finance 7yr" });
  });

  it("rejects tag create without a name with 400", async () => {
    const routes = createRetentionRoutes({ provider: new FakeRetentionProvider(), resolveCaller: writerCaller });
    await expect(
      routeByPath(routes, "POST", RETENTION_TAGS_PATH).handler({
        method: "POST",
        path: `/v1/tenants/${TENANT}/retention/tags`,
        params: { tenantId: TENANT },
        query: new URLSearchParams(),
        headers: {},
        body: { type: "delete" },
      }),
    ).rejects.toMatchObject({ status: 400 });
  });

  it("edits a tag and rejects an empty edit with 400", async () => {
    const routes = createRetentionRoutes({ provider: new FakeRetentionProvider(), resolveCaller: writerCaller });
    const response = await routeByPath(routes, "PATCH", RETENTION_TAG_ITEM_PATH).handler({
      method: "PATCH",
      path: `/v1/tenants/${TENANT}/retention/tags/tag-1`,
      params: { tenantId: TENANT, tagId: "tag-1" },
      query: new URLSearchParams(),
      headers: {},
      body: { retentionDays: 3650 },
    });
    expect(response.status).toBe(200);
    expect((response.body as RetentionTagResult).auditEvent?.action).toBe("retention.tag.edit");

    await expect(
      routeByPath(routes, "PATCH", RETENTION_TAG_ITEM_PATH).handler({
        method: "PATCH",
        path: `/v1/tenants/${TENANT}/retention/tags/tag-1`,
        params: { tenantId: TENANT, tagId: "tag-1" },
        query: new URLSearchParams(),
        headers: {},
        body: {},
      }),
    ).rejects.toMatchObject({ status: 400 });
  });

  it("previews a single assignment listing the affected mailbox without applying", async () => {
    const provider = new FakeRetentionProvider();
    const routes = createRetentionRoutes({ provider, resolveCaller: writerCaller });
    const response = await routeByPath(routes, "POST", RETENTION_ASSIGN_PATH).handler({
      method: "POST",
      path: `/v1/tenants/${TENANT}/retention/assign`,
      params: { tenantId: TENANT },
      query: new URLSearchParams(),
      headers: {},
      body: { mailboxId: "mbx-2", tagId: "tag-1", preview: true },
    });
    expect(response.status).toBe(200);
    const body = response.body as RetentionAssignPlan;
    expect(body.dryRun).toBe(true);
    expect(body.affectedMailboxes).toEqual(["mbx-2"]);
    expect(provider.assignCalls[0]).toMatchObject({ tenantId: TENANT, preview: true });
  });

  it("applies a single assignment with before/after, a mailbox operation, and an audit event", async () => {
    const provider = new FakeRetentionProvider();
    const routes = createRetentionRoutes({ provider, resolveCaller: writerCaller });
    const response = await routeByPath(routes, "POST", RETENTION_ASSIGN_PATH).handler({
      method: "POST",
      path: `/v1/tenants/${TENANT}/retention/assign`,
      params: { tenantId: TENANT },
      query: new URLSearchParams(),
      headers: {},
      body: { mailboxId: "mbx-2", tagId: "tag-1" },
    });
    expect(response.status).toBe(200);
    const body = response.body as RetentionAssignResult;
    expect(body.success).toBe(true);
    expect(body.plan.affectedMailboxes).toEqual(["mbx-2"]);
    expect(body.plan.before).toMatchObject({ retentionTag: null });
    expect(body.plan.after).toMatchObject({ retentionTag: "tag-1" });
    expect(body.mailboxOperation?.operation).toBe("retention.assign");
    expect(body.auditEvent?.action).toBe("retention.assign");
    expect(provider.assignCalls[0]?.input.confirm).toBe(true);
  });

  it("rejects assignment when confirmation is explicitly withheld with 400", async () => {
    const routes = createRetentionRoutes({ provider: new FakeRetentionProvider(), resolveCaller: writerCaller });
    await expect(
      routeByPath(routes, "POST", RETENTION_ASSIGN_PATH).handler({
        method: "POST",
        path: `/v1/tenants/${TENANT}/retention/assign`,
        params: { tenantId: TENANT },
        query: new URLSearchParams(),
        headers: {},
        body: { mailboxId: "mbx-2", tagId: "tag-1", confirm: false },
      }),
    ).rejects.toMatchObject({ status: 400 });
  });

  it("previews a bulk assignment listing every affected mailbox", async () => {
    const provider = new FakeRetentionProvider();
    const routes = createRetentionRoutes({ provider, resolveCaller: writerCaller });
    const response = await routeByPath(routes, "POST", RETENTION_ASSIGN_BULK_PATH).handler({
      method: "POST",
      path: `/v1/tenants/${TENANT}/retention/assign/bulk`,
      params: { tenantId: TENANT },
      query: new URLSearchParams(),
      headers: {},
      body: { mailboxIds: ["mbx-1", "mbx-2"], tagId: "tag-1", preview: true },
    });
    expect(response.status).toBe(200);
    const body = response.body as RetentionAssignBulkPlan;
    expect(body.dryRun).toBe(true);
    expect(body.affectedMailboxes).toEqual(["mbx-1", "mbx-2"]);
    expect(provider.assignBulkCalls[0]).toMatchObject({ tenantId: TENANT, preview: true });
  });

  it("applies a bulk assignment with per-mailbox results and audit events", async () => {
    const provider = new FakeRetentionProvider();
    const audited: Record<string, unknown>[] = [];
    const routes = createRetentionRoutes({
      provider,
      resolveCaller: writerCaller,
      recordAudit: async (event) => {
        audited.push(event);
      },
    });
    const response = await routeByPath(routes, "POST", RETENTION_ASSIGN_BULK_PATH).handler({
      method: "POST",
      path: `/v1/tenants/${TENANT}/retention/assign/bulk`,
      params: { tenantId: TENANT },
      query: new URLSearchParams(),
      headers: {},
      body: { mailboxIds: ["mbx-1", "mbx-2"], tagId: "tag-1" },
    });
    expect(response.status).toBe(200);
    const body = response.body as RetentionAssignBulkResult;
    expect(body.success).toBe(true);
    expect(body.plan.affectedMailboxes).toEqual(["mbx-1", "mbx-2"]);
    expect(body.results).toHaveLength(2);
    expect(body.mailboxOperations?.[0]?.operation).toBe("retention.assign");
    expect(body.auditEvents).toHaveLength(1);
    expect(audited).toHaveLength(1);
  });

  it("rejects bulk assignment without mailboxes with 400", async () => {
    const routes = createRetentionRoutes({ provider: new FakeRetentionProvider(), resolveCaller: writerCaller });
    await expect(
      routeByPath(routes, "POST", RETENTION_ASSIGN_BULK_PATH).handler({
        method: "POST",
        path: `/v1/tenants/${TENANT}/retention/assign/bulk`,
        params: { tenantId: TENANT },
        query: new URLSearchParams(),
        headers: {},
        body: { mailboxIds: [], tagId: "tag-1" },
      }),
    ).rejects.toMatchObject({ status: 400 });
  });

  it("validates tag names and retention days", () => {
    expect(validateRetentionTagName("Finance 7yr")).toBe(true);
    expect(validateRetentionTagName("   ")).toBe(false);
    expect(validateRetentionDays(2555)).toBe(true);
    expect(validateRetentionDays(0)).toBe(false);
    expect(validateRetentionDays("seven" as unknown as number)).toBe(false);
  });
});
