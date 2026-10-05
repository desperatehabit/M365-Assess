// T-0860 — Compliance template CRUD + deploy API.
// Route-level tests: CRUD is gated on purview.templates and persists through the
// injected repository; deploy is gated on purview.write (or Remediation.Apply),
// checks tenant scope per target, enqueues one EPIC-006 gated apply job per
// target, records a CompliancePolicyChange row per target, and reports partial
// failures.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { JobEnvelope } from "@m365-assess/contracts";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { tenantScope } from "../rbac/scope.js";
import type { RequestContext } from "../server.js";
import {
  SqlitePurviewComplianceRepository,
  type ComplianceTemplateRecord,
  type PurviewComplianceRepository,
} from "../repository/purview-compliance.js";
import {
  COMPLIANCE_TEMPLATE_DEPLOY_PATH,
  COMPLIANCE_TEMPLATE_ITEM_PATH,
  COMPLIANCE_TEMPLATES_PATH,
  COMPLIANCE_TEMPLATES_UNAUTHENTICATED,
  PURVIEW_TEMPLATES_PERMISSION,
  PURVIEW_WRITE_PERMISSION,
  REMEDIATION_APPLY_PERMISSION,
  createComplianceTemplatesRoutes,
  type ComplianceTemplatesCaller,
  type ComplianceTemplatesRouteOptions,
} from "./compliance-templates.js";

const TENANT = "tenant-test";
const OTHER_TENANT = "tenant-other";

const BASE_MIGRATION = readFileSync(
  fileURLToPath(new URL("../../../db/migrations/0001_init.sql", import.meta.url)),
  "utf8",
);
const MIGRATION = readFileSync(
  fileURLToPath(new URL("../../../db/migrations/0038_purview_compliance.sql", import.meta.url)),
  "utf8",
);

const openDbs: Database.Database[] = [];

function openRepo(): SqlitePurviewComplianceRepository {
  const db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  db.exec(BASE_MIGRATION);
  db.exec(MIGRATION);
  db.prepare(
    `INSERT INTO tenants (id, source, status, excluded, errorCount, createdAt, updatedAt)
     VALUES (?, 'direct', 'active', 0, 0, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`,
  ).run(TENANT);
  openDbs.push(db);
  return new SqlitePurviewComplianceRepository(db, 38);
}

afterEach(() => {
  for (const db of openDbs.splice(0)) db.close();
});

class FakeRepository implements PurviewComplianceRepository {
  readonly schemaVersion = 38;
  readonly templates = new Map<string, ComplianceTemplateRecord>();
  readonly changes: Array<Record<string, unknown>> = [];
  private seq = 0;

  close(): void {}

  async createTemplate(input: {
    name: string;
    area: "dlp" | "retention" | "label" | "sit" | "safelinks";
    payload: Record<string, unknown>;
    variables?: Record<string, unknown>;
    source?: "local";
  }): Promise<ComplianceTemplateRecord> {
    const id = `tpl-${++this.seq}`;
    const record: ComplianceTemplateRecord = {
      id,
      name: input.name,
      area: input.area,
      payload: input.payload,
      variables: input.variables ?? {},
      source: input.source ?? "local",
      createdAt: "2026-09-29T00:00:00.000Z",
      updatedAt: "2026-09-29T00:00:00.000Z",
      deletedAt: null,
    };
    this.templates.set(id, record);
    return record;
  }

  async getTemplate(id: string): Promise<ComplianceTemplateRecord | undefined> {
    const existing = this.templates.get(id);
    return existing && !existing.deletedAt ? existing : undefined;
  }

  async listTemplates(options: { area?: string } = {}): Promise<ComplianceTemplateRecord[]> {
    return [...this.templates.values()].filter(
      (t) => !t.deletedAt && (options.area === undefined || t.area === options.area),
    );
  }

  async updateTemplate(
    id: string,
    patch: { name?: string; payload?: Record<string, unknown>; variables?: Record<string, unknown> },
  ): Promise<ComplianceTemplateRecord | undefined> {
    const existing = this.templates.get(id);
    if (!existing || existing.deletedAt) return undefined;
    const updated: ComplianceTemplateRecord = {
      ...existing,
      ...(patch.name !== undefined ? { name: patch.name } : {}),
      ...(patch.payload !== undefined ? { payload: patch.payload } : {}),
      ...(patch.variables !== undefined ? { variables: patch.variables } : {}),
      updatedAt: "2026-09-30T00:00:00.000Z",
    };
    this.templates.set(id, updated);
    return updated;
  }

  async softDeleteTemplate(id: string): Promise<boolean> {
    const existing = this.templates.get(id);
    if (!existing || existing.deletedAt) return false;
    this.templates.set(id, { ...existing, deletedAt: "2026-09-30T00:00:00.000Z" });
    return true;
  }

  async recordPolicyChange(input: Record<string, unknown>): Promise<unknown> {
    this.changes.push(input);
    return { id: input["id"], ...input };
  }

  async getPolicyChange(): Promise<undefined> {
    return undefined;
  }

  async listPolicyChanges(): Promise<never[]> {
    return [];
  }
}

class FakeQueue {
  readonly enqueued: JobEnvelope[] = [];

  async enqueue(envelope: JobEnvelope): Promise<string> {
    this.enqueued.push(envelope);
    return envelope.jobId;
  }
}

function templatesCaller(
  permissions: string[] = [PURVIEW_TEMPLATES_PERMISSION, PURVIEW_WRITE_PERMISSION],
  userId = "user-1",
) {
  return { tenantScope: tenantScope([TENANT]), permissions, userId };
}

function makeOptions(
  overrides: {
    repository?: PurviewComplianceRepository;
    queue?: FakeQueue;
    resolveCaller?: () => ComplianceTemplatesCaller | undefined;
    recordAudit?: (event: Record<string, unknown>) => Promise<void>;
  } = {},
): ComplianceTemplatesRouteOptions & { queue: FakeQueue } {
  const queue = overrides.queue ?? new FakeQueue();
  return {
    repository: overrides.repository ?? new FakeRepository(),
    queue,
    resolveCaller: overrides.resolveCaller ?? (() => templatesCaller()),
    ...(overrides.recordAudit !== undefined ? { recordAudit: overrides.recordAudit } : {}),
  };
}

function routeByPath(
  routes: ReturnType<typeof createComplianceTemplatesRoutes>,
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
    query?: Record<string, string>;
    body?: unknown;
    headers?: Record<string, string>;
  } = {},
): RequestContext {
  return {
    correlationId: "corr-templates-1",
    method: "GET",
    path,
    query: new URLSearchParams(options.query ?? {}),
    headers: options.headers ?? {},
    params: options.params ?? {},
    ...(options.body !== undefined ? { body: options.body } : {}),
  };
}

const CREATE_BODY = {
  name: "Block partner mail",
  area: "dlp",
  payload: { name: "Block mail", locations: ["Exchange"] },
  variables: { partnerDomain: "partner.example" },
  source: "local",
};

describe("compliance templates routes (T-0860)", () => {
  it("exposes the §6 CRUD and deploy paths", () => {
    const routes = createComplianceTemplatesRoutes(makeOptions());
    expect(routes.map((route) => `${route.method} ${route.path}`)).toEqual([
      `GET ${COMPLIANCE_TEMPLATES_PATH}`,
      `POST ${COMPLIANCE_TEMPLATES_PATH}`,
      `GET ${COMPLIANCE_TEMPLATE_ITEM_PATH}`,
      `PATCH ${COMPLIANCE_TEMPLATE_ITEM_PATH}`,
      `DELETE ${COMPLIANCE_TEMPLATE_ITEM_PATH}`,
      `POST ${COMPLIANCE_TEMPLATE_DEPLOY_PATH}`,
    ]);
  });

  it("rejects unauthenticated callers with 401", async () => {
    const routes = createComplianceTemplatesRoutes(
      makeOptions({ resolveCaller: () => undefined }),
    );
    await expect(
      routeByPath(routes, "GET", COMPLIANCE_TEMPLATES_PATH).handler(
        ctx(COMPLIANCE_TEMPLATES_PATH),
      ),
    ).rejects.toMatchObject({ status: 401, code: COMPLIANCE_TEMPLATES_UNAUTHENTICATED });
  });

  it("rejects callers missing purview.templates with a structured 403", async () => {
    const routes = createComplianceTemplatesRoutes(
      makeOptions({ resolveCaller: () => templatesCaller(["purview.read"]) }),
    );
    await expect(
      routeByPath(routes, "GET", COMPLIANCE_TEMPLATES_PATH).handler(
        ctx(COMPLIANCE_TEMPLATES_PATH),
      ),
    ).rejects.toMatchObject({ status: 403, code: "auth.forbidden" });
  });

  it("lists templates filtered by area", async () => {
    const repository = new FakeRepository();
    await repository.createTemplate({ name: "DLP", area: "dlp", payload: {} });
    await repository.createTemplate({ name: "Retention", area: "retention", payload: {} });
    const routes = createComplianceTemplatesRoutes(makeOptions({ repository }));

    const all = await routeByPath(routes, "GET", COMPLIANCE_TEMPLATES_PATH).handler(
      ctx(COMPLIANCE_TEMPLATES_PATH),
    );
    expect((all.body as { items: unknown[] }).items).toHaveLength(2);

    const dlp = await routeByPath(routes, "GET", COMPLIANCE_TEMPLATES_PATH).handler(
      ctx(COMPLIANCE_TEMPLATES_PATH, { query: { area: "dlp" } }),
    );
    const body = dlp.body as { items: Array<{ name: string }>; totalCount: number };
    expect(body.items.map((t) => t.name)).toEqual(["DLP"]);
    expect(body.totalCount).toBe(1);
  });

  it("creates a template, serves it back, updates, and soft-deletes it", async () => {
    const repository = new FakeRepository();
    const routes = createComplianceTemplatesRoutes(makeOptions({ repository }));

    const created = await routeByPath(routes, "POST", COMPLIANCE_TEMPLATES_PATH).handler(
      ctx(COMPLIANCE_TEMPLATES_PATH, { body: CREATE_BODY }),
    );
    expect(created.status).toBe(201);
    const template = created.body as ComplianceTemplateRecord;
    expect(template.id).toBeTruthy();
    expect(template.name).toBe("Block partner mail");
    expect(template.area).toBe("dlp");
    expect(template.source).toBe("local");

    const fetched = await routeByPath(routes, "GET", COMPLIANCE_TEMPLATE_ITEM_PATH).handler(
      ctx(`${COMPLIANCE_TEMPLATES_PATH}/${template.id}`, { params: { id: template.id } }),
    );
    expect(fetched.status).toBe(200);
    expect((fetched.body as ComplianceTemplateRecord).payload).toEqual(CREATE_BODY.payload);

    const updated = await routeByPath(routes, "PATCH", COMPLIANCE_TEMPLATE_ITEM_PATH).handler(
      ctx(`${COMPLIANCE_TEMPLATES_PATH}/${template.id}`, {
        params: { id: template.id },
        body: { name: "Renamed", variables: { partnerDomain: "other.example" } },
      }),
    );
    expect(updated.status).toBe(200);
    expect((updated.body as ComplianceTemplateRecord).name).toBe("Renamed");
    expect((updated.body as ComplianceTemplateRecord).variables).toEqual({
      partnerDomain: "other.example",
    });

    const deleted = await routeByPath(routes, "DELETE", COMPLIANCE_TEMPLATE_ITEM_PATH).handler(
      ctx(`${COMPLIANCE_TEMPLATES_PATH}/${template.id}`, { params: { id: template.id } }),
    );
    expect(deleted.status).toBe(200);
    expect(deleted.body).toEqual({ deleted: true, id: template.id });

    await expect(
      routeByPath(routes, "GET", COMPLIANCE_TEMPLATE_ITEM_PATH).handler(
        ctx(`${COMPLIANCE_TEMPLATES_PATH}/${template.id}`, { params: { id: template.id } }),
      ),
    ).rejects.toMatchObject({ status: 404 });
  });

  it("validates the create body", async () => {
    const routes = createComplianceTemplatesRoutes(makeOptions());
    const list = routeByPath(routes, "POST", COMPLIANCE_TEMPLATES_PATH);

    await expect(
      list.handler(ctx(COMPLIANCE_TEMPLATES_PATH, { body: { ...CREATE_BODY, name: "" } })),
    ).rejects.toMatchObject({ status: 400 });
    await expect(
      list.handler(ctx(COMPLIANCE_TEMPLATES_PATH, { body: { ...CREATE_BODY, area: "bogus" } })),
    ).rejects.toMatchObject({ status: 400 });
    await expect(
      list.handler(ctx(COMPLIANCE_TEMPLATES_PATH, { body: { name: "X", area: "dlp" } })),
    ).rejects.toMatchObject({ status: 400 });
  });

  it("returns a structured 404 for an unknown template", async () => {
    const routes = createComplianceTemplatesRoutes(makeOptions());
    await expect(
      routeByPath(routes, "GET", COMPLIANCE_TEMPLATE_ITEM_PATH).handler(
        ctx(`${COMPLIANCE_TEMPLATES_PATH}/missing`, { params: { id: "missing" } }),
      ),
    ).rejects.toMatchObject({ status: 404 });
  });

  it("round-trips templates through the SQLite repository", async () => {
    const repository = openRepo();
    const routes = createComplianceTemplatesRoutes(makeOptions({ repository }));

    const created = await routeByPath(routes, "POST", COMPLIANCE_TEMPLATES_PATH).handler(
      ctx(COMPLIANCE_TEMPLATES_PATH, { body: CREATE_BODY }),
    );
    expect(created.status).toBe(201);
    const template = created.body as ComplianceTemplateRecord;

    const listed = await routeByPath(routes, "GET", COMPLIANCE_TEMPLATES_PATH).handler(
      ctx(COMPLIANCE_TEMPLATES_PATH, { query: { area: "dlp" } }),
    );
    expect((listed.body as { items: Array<{ id: string }> }).items.map((t) => t.name)).toEqual([
      "Block partner mail",
    ]);

    const deleted = await routeByPath(routes, "DELETE", COMPLIANCE_TEMPLATE_ITEM_PATH).handler(
      ctx(`${COMPLIANCE_TEMPLATES_PATH}/${template.id}`, { params: { id: template.id } }),
    );
    expect(deleted.status).toBe(200);
    const afterDelete = await routeByPath(routes, "GET", COMPLIANCE_TEMPLATES_PATH).handler(
      ctx(COMPLIANCE_TEMPLATES_PATH),
    );
    expect((afterDelete.body as { items: unknown[] }).items).toHaveLength(0);
  });

  it("refuses a deploy to a caller missing purview.write", async () => {
    const routes = createComplianceTemplatesRoutes(
      makeOptions({ resolveCaller: () => templatesCaller([PURVIEW_TEMPLATES_PERMISSION]) }),
    );
    await expect(
      routeByPath(routes, "POST", COMPLIANCE_TEMPLATE_DEPLOY_PATH).handler(
        ctx(`${COMPLIANCE_TEMPLATES_PATH}/tpl-1/deploy`, {
          params: { id: "tpl-1" },
          body: { targets: [TENANT] },
        }),
      ),
    ).rejects.toMatchObject({ status: 403, code: "auth.forbidden" });
  });

  it("accepts Remediation.Apply in place of purview.write for deploy", async () => {
    const repository = new FakeRepository();
    const queue = new FakeQueue();
    const routes = createComplianceTemplatesRoutes(
      makeOptions({
        repository,
        queue,
        resolveCaller: () => templatesCaller([PURVIEW_TEMPLATES_PERMISSION, REMEDIATION_APPLY_PERMISSION]),
      }),
    );
    const created = (await routeByPath(routes, "POST", COMPLIANCE_TEMPLATES_PATH).handler(
      ctx(COMPLIANCE_TEMPLATES_PATH, { body: CREATE_BODY }),
    )) as { body: ComplianceTemplateRecord };

    const response = await routeByPath(routes, "POST", COMPLIANCE_TEMPLATE_DEPLOY_PATH).handler(
      ctx(`${COMPLIANCE_TEMPLATES_PATH}/${created.body.id}/deploy`, {
        params: { id: created.body.id },
        body: { targets: [TENANT], variables: { partnerDomain: "partner.example" } },
      }),
    );
    expect(response.status).toBe(200);
    expect(queue.enqueued).toHaveLength(1);
  });

  it("refuses a deploy for a tenant outside the caller's scope", async () => {
    const repository = new FakeRepository();
    const routes = createComplianceTemplatesRoutes(
      makeOptions({ repository, resolveCaller: () => templatesCaller([PURVIEW_TEMPLATES_PERMISSION, PURVIEW_WRITE_PERMISSION]) }),
    );
    const created = (await routeByPath(routes, "POST", COMPLIANCE_TEMPLATES_PATH).handler(
      ctx(COMPLIANCE_TEMPLATES_PATH, { body: CREATE_BODY }),
    )) as { body: ComplianceTemplateRecord };
    await expect(
      routeByPath(routes, "POST", COMPLIANCE_TEMPLATE_DEPLOY_PATH).handler(
        ctx(`${COMPLIANCE_TEMPLATES_PATH}/${created.body.id}/deploy`, {
          params: { id: created.body.id },
          body: { targets: [OTHER_TENANT] },
        }),
      ),
    ).rejects.toMatchObject({ status: 403 });
  });

  it("requires at least one deploy target", async () => {
    const repository = new FakeRepository();
    const routes = createComplianceTemplatesRoutes(
      makeOptions({ repository, resolveCaller: () => templatesCaller([PURVIEW_TEMPLATES_PERMISSION, PURVIEW_WRITE_PERMISSION]) }),
    );
    const created = (await routeByPath(routes, "POST", COMPLIANCE_TEMPLATES_PATH).handler(
      ctx(COMPLIANCE_TEMPLATES_PATH, { body: CREATE_BODY }),
    )) as { body: ComplianceTemplateRecord };
    await expect(
      routeByPath(routes, "POST", COMPLIANCE_TEMPLATE_DEPLOY_PATH).handler(
        ctx(`${COMPLIANCE_TEMPLATES_PATH}/${created.body.id}/deploy`, {
          params: { id: created.body.id },
          body: { targets: [] },
        }),
      ),
    ).rejects.toMatchObject({ status: 400 });
  });

  it("returns a structured 404 when deploying an unknown template", async () => {
    const routes = createComplianceTemplatesRoutes(
      makeOptions({ resolveCaller: () => templatesCaller([PURVIEW_TEMPLATES_PERMISSION, PURVIEW_WRITE_PERMISSION]) }),
    );
    await expect(
      routeByPath(routes, "POST", COMPLIANCE_TEMPLATE_DEPLOY_PATH).handler(
        ctx(`${COMPLIANCE_TEMPLATES_PATH}/missing/deploy`, {
          params: { id: "missing" },
          body: { targets: [TENANT] },
        }),
      ),
    ).rejects.toMatchObject({ status: 404 });
  });

  it("previews a deploy without enqueueing or recording changes", async () => {
    const repository = new FakeRepository();
    const queue = new FakeQueue();
    const routes = createComplianceTemplatesRoutes(
      makeOptions({ repository, queue, resolveCaller: () => templatesCaller([PURVIEW_TEMPLATES_PERMISSION, PURVIEW_WRITE_PERMISSION]) }),
    );
    const created = (await routeByPath(routes, "POST", COMPLIANCE_TEMPLATES_PATH).handler(
      ctx(COMPLIANCE_TEMPLATES_PATH, { body: CREATE_BODY }),
    )) as { body: ComplianceTemplateRecord };

    const response = await routeByPath(routes, "POST", COMPLIANCE_TEMPLATE_DEPLOY_PATH).handler(
      ctx(`${COMPLIANCE_TEMPLATES_PATH}/${created.body.id}/deploy`, {
        params: { id: created.body.id },
        body: { targets: [TENANT], preview: true },
      }),
    );
    expect(response.status).toBe(200);
    const body = response.body as {
      templateId: string;
      preview: boolean;
      allValid: boolean;
      plans: Array<{ tenantId: string; area: string; diff: string[] }>;
    };
    expect(body.preview).toBe(true);
    expect(body.allValid).toBe(true);
    expect(body.plans).toEqual([
      {
        tenantId: TENANT,
        templateId: created.body.id,
        area: "dlp",
        diff: [`Deploy dlp template 'Block partner mail' to ${TENANT}`],
        valid: true,
      },
    ]);
    expect(queue.enqueued).toHaveLength(0);
    expect(repository.changes).toHaveLength(0);
  });

  it("enqueues one apply job per target and records a change row per target", async () => {
    const repository = new FakeRepository();
    const queue = new FakeQueue();
    const audited: Record<string, unknown>[] = [];
    const routes = createComplianceTemplatesRoutes(
      makeOptions({
        repository,
        queue,
        resolveCaller: () => templatesCaller([PURVIEW_TEMPLATES_PERMISSION, PURVIEW_WRITE_PERMISSION]),
        recordAudit: async (event) => {
          audited.push(event);
        },
      }),
    );
    const created = (await routeByPath(routes, "POST", COMPLIANCE_TEMPLATES_PATH).handler(
      ctx(COMPLIANCE_TEMPLATES_PATH, { body: CREATE_BODY }),
    )) as { body: ComplianceTemplateRecord };

    const response = await routeByPath(routes, "POST", COMPLIANCE_TEMPLATE_DEPLOY_PATH).handler(
      ctx(`${COMPLIANCE_TEMPLATES_PATH}/${created.body.id}/deploy`, {
        params: { id: created.body.id },
        body: { targets: [TENANT], variables: { partnerDomain: "partner.example" } },
      }),
    );
    expect(response.status).toBe(200);
    const body = response.body as {
      templateId: string;
      success: boolean;
      results: Array<{ tenantId: string; success: boolean; state?: string }>;
    };
    expect(body.success).toBe(true);
    expect(body.results).toEqual([{ tenantId: TENANT, success: true, state: "queued" }]);

    expect(queue.enqueued).toHaveLength(1);
    const envelope = queue.enqueued[0]!;
    expect(envelope.jobType).toBe("remediation");
    expect(envelope.tenantId).toBe(TENANT);
    expect(envelope.payload).toMatchObject({
      operation: "apply",
      area: "dlp",
      action: "deploy",
      templateId: created.body.id,
      templateName: "Block partner mail",
      payload: CREATE_BODY.payload,
      variables: { partnerDomain: "partner.example" },
    });

    expect(repository.changes).toHaveLength(1);
    expect(repository.changes[0]).toMatchObject({
      tenantId: TENANT,
      area: "dlp",
      policyId: created.body.id,
      by: "user-1",
    });

    expect(audited).toHaveLength(1);
    expect(audited[0]).toMatchObject({
      action: "compliance.template.deploy",
      tenantId: TENANT,
      targetId: created.body.id,
    });
  });

  it("reports per-target partial failures with 207", async () => {
    const repository = new FakeRepository();
    const queue = new FakeQueue();
    const routes = createComplianceTemplatesRoutes(
      makeOptions({ repository, queue, resolveCaller: () => templatesCaller([PURVIEW_TEMPLATES_PERMISSION, PURVIEW_WRITE_PERMISSION]) }),
    );
    const created = (await routeByPath(routes, "POST", COMPLIANCE_TEMPLATES_PATH).handler(
      ctx(COMPLIANCE_TEMPLATES_PATH, { body: CREATE_BODY }),
    )) as { body: ComplianceTemplateRecord };

    const failing: ComplianceTemplatesRouteOptions["queue"] = {
      enqueue: async (envelope) => {
        if (envelope.tenantId === OTHER_TENANT) throw new Error("worker unavailable");
        return envelope.jobId;
      },
    };
    const failingRoutes = createComplianceTemplatesRoutes({
      repository,
      queue: failing,
      resolveCaller: () => ({
        tenantScope: tenantScope([TENANT, OTHER_TENANT]),
        permissions: [PURVIEW_WRITE_PERMISSION],
        userId: "user-1",
      }),
    });

    const response = await routeByPath(failingRoutes, "POST", COMPLIANCE_TEMPLATE_DEPLOY_PATH).handler(
      ctx(`${COMPLIANCE_TEMPLATES_PATH}/${created.body.id}/deploy`, {
        params: { id: created.body.id },
        body: { targets: [TENANT, OTHER_TENANT] },
      }),
    );
    expect(response.status).toBe(207);
    const body = response.body as {
      success: boolean;
      results: Array<{ tenantId: string; success: boolean; error?: string | null }>;
    };
    expect(body.success).toBe(true);
    expect(body.results).toEqual([
      { tenantId: TENANT, success: true, state: "queued" },
      { tenantId: OTHER_TENANT, success: false, error: "worker unavailable" },
    ]);
  });
});
