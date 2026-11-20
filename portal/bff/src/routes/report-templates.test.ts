import { describe, expect, it } from "vitest";
import { REPORT_SCHEMA_VERSION, parseReportTemplate } from "../../../contracts/src/reports.js";
import { AppError } from "../errors.js";
import {
  BUILT_IN_REPORT_TEMPLATES,
  REPORT_TEMPLATE_INVALID,
  REPORT_TEMPLATE_NOT_FOUND,
  REPORT_TEMPLATE_PERMISSIONS,
  REPORT_TEMPLATE_READ_ONLY,
  REPORT_TEMPLATE_TENANT_REQUIRED,
  createReportTemplateRoutes,
  type CloneTemplateInput,
  type CreateTemplateInput,
  type GeneratedReportHandle,
  type ReportTemplateDependencies,
  type ReportTemplateRequest,
  type ReportTemplateRoute,
  type ReportTemplateStore,
  type StoredReportTemplate,
  type TemplateRenderPort,
  type TemplateRenderRequest,
  type UpdateTemplateInput,
} from "./report-templates.js";

const CREATED_AT = "2026-01-01T00:00:00.000Z";

function validDocument(): Record<string, unknown> {
  return {
    schemaVersion: REPORT_SCHEMA_VERSION,
    id: "client-id",
    name: "client-name",
    settings: { title: "Security posture", redact: false },
    pageSetup: { pageSize: "A4", orientation: "portrait", marginMm: 16 },
    blocks: [
      {
        id: "block-1",
        type: "rich-text",
        title: "Analyst note",
        static: true,
        settings: { body: "No critical exposure observed." },
      },
    ],
  };
}

class MemoryTemplateStore implements ReportTemplateStore {
  private readonly records = new Map<string, StoredReportTemplate>();
  private counter = 0;

  async createTemplate(input: CreateTemplateInput): Promise<StoredReportTemplate> {
    const id = input.id ?? `mem-${(this.counter += 1)}`;
    const record: StoredReportTemplate = {
      id,
      name: input.name,
      tenantId: input.tenantId ?? null,
      document: input.document,
      createdBy: input.createdBy ?? null,
      updatedBy: null,
      createdAt: CREATED_AT,
      updatedAt: CREATED_AT,
      deletedAt: null,
    };
    this.records.set(id, record);
    return record;
  }

  async getTemplate(id: string): Promise<StoredReportTemplate | undefined> {
    return this.records.get(id);
  }

  async listTemplates(options: {
    tenantId?: string;
    includeDeleted?: boolean;
  } = {}): Promise<StoredReportTemplate[]> {
    return [...this.records.values()].filter(
      (record) =>
        (options.includeDeleted === true || record.deletedAt === null) &&
        (options.tenantId === undefined ||
          record.tenantId === null ||
          record.tenantId === options.tenantId),
    );
  }

  async updateTemplate(
    id: string,
    input: UpdateTemplateInput,
  ): Promise<StoredReportTemplate | undefined> {
    const existing = this.records.get(id);
    if (!existing || existing.deletedAt !== null) return undefined;
    const updated: StoredReportTemplate = {
      ...existing,
      name: input.name ?? existing.name,
      document: input.document === undefined ? existing.document : input.document,
      updatedBy: input.updatedBy ?? existing.updatedBy,
    };
    this.records.set(id, updated);
    return updated;
  }

  async softDeleteTemplate(id: string): Promise<boolean> {
    const existing = this.records.get(id);
    if (!existing || existing.deletedAt !== null) return false;
    this.records.set(id, { ...existing, deletedAt: "2026-01-02T00:00:00.000Z" });
    return true;
  }

  async cloneTemplate(
    sourceId: string,
    input: CloneTemplateInput,
  ): Promise<StoredReportTemplate | undefined> {
    const source = this.records.get(sourceId);
    if (!source || source.deletedAt !== null) return undefined;
    const id = input.id ?? `mem-${(this.counter += 1)}`;
    const document =
      typeof source.document === "object" &&
      source.document !== null &&
      !Array.isArray(source.document)
        ? { ...(source.document as Record<string, unknown>), id, name: input.name }
        : source.document;
    const record: StoredReportTemplate = {
      ...source,
      id,
      name: input.name,
      tenantId: input.tenantId === undefined ? source.tenantId : input.tenantId,
      document,
      createdBy: input.createdBy ?? null,
      updatedBy: null,
      deletedAt: null,
    };
    this.records.set(id, record);
    return record;
  }
}

class CapturingRenderPort implements TemplateRenderPort {
  readonly requests: TemplateRenderRequest[] = [];

  async enqueue(request: TemplateRenderRequest): Promise<GeneratedReportHandle> {
    this.requests.push(request);
    return {
      id: "report-1",
      templateId: request.templateId,
      tenantId: request.tenantId,
      status: "queued",
      artifactRef: null,
      createdAt: CREATED_AT,
    };
  }
}

interface Harness {
  routes: ReportTemplateRoute[];
  store: MemoryTemplateStore;
  render: CapturingRenderPort;
  permissions: string[];
  authorize?: ReportTemplateDependencies["authorize"];
}

function harness(overrides: Partial<ReportTemplateDependencies> = {}): Harness {
  const store = new MemoryTemplateStore();
  const render = new CapturingRenderPort();
  const permissions: string[] = [];
  const deps: ReportTemplateDependencies = {
    store,
    render,
    contract: { parse: (input) => parseReportTemplate(input) },
    resolveActor: () => "operator-1",
    authorize: {
      requirePermission: (_ctx, permission) => {
        permissions.push(permission);
      },
    },
    ...overrides,
  };
  return {
    routes: createReportTemplateRoutes(deps),
    store,
    render,
    permissions,
    authorize: deps.authorize,
  };
}

function request(overrides: Partial<ReportTemplateRequest> = {}): ReportTemplateRequest {
  return {
    correlationId: "corr-test",
    method: "GET",
    path: "/v1/report-templates",
    query: new URLSearchParams(),
    headers: {},
    params: {},
    ...overrides,
  };
}

function handlerFor(
  routes: ReportTemplateRoute[],
  method: string,
  path: string,
): ReportTemplateRoute["handler"] {
  const route = routes.find((candidate) => candidate.method === method && candidate.path === path);
  if (!route) throw new Error(`no route for ${method} ${path}`);
  return route.handler;
}

async function createTemplate(
  harnessValue: Harness,
  body: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const handler = handlerFor(harnessValue.routes, "POST", "/v1/report-templates");
  const response = await handler(request({ body }));
  expect(response.status).toBe(201);
  return response.body as Record<string, unknown>;
}

describe("report template routes", () => {
  it("creates a template from a valid block document", async () => {
    const value = harness();
    const body = await createTemplate(value, { name: "Quarterly review", document: validDocument() });

    const document = body["document"] as Record<string, unknown>;
    expect(body["id"]).toEqual(expect.any(String));
    expect(body["name"]).toBe("Quarterly review");
    expect(document["id"]).toBe(body["id"]);
    expect(document["name"]).toBe("Quarterly review");
    expect(value.permissions).toContain(REPORT_TEMPLATE_PERMISSIONS.write);
  });

  it("rejects a template whose block document violates the contract", async () => {
    const value = harness();
    const invalid = validDocument();
    invalid["blocks"] = [{ ...(validDocument()["blocks"] as Array<Record<string, unknown>>)[0], type: "iframe" }];

    const handler = handlerFor(value.routes, "POST", "/v1/report-templates");
    await expect(
      handler(request({ body: { name: "Bad", document: invalid } })),
    ).rejects.toMatchObject({ code: REPORT_TEMPLATE_INVALID, status: 400 });

    expect(await value.store.listTemplates()).toHaveLength(0);
  });

  it("rejects a create with no name", async () => {
    const value = harness();
    const handler = handlerFor(value.routes, "POST", "/v1/report-templates");
    await expect(handler(request({ body: { document: validDocument() } }))).rejects.toMatchObject({
      status: 400,
    });
  });

  it("reads a template and returns 404 for an unknown id", async () => {
    const value = harness();
    const created = await createTemplate(value, { name: "One", document: validDocument() });

    const get = handlerFor(value.routes, "GET", "/v1/report-templates/:templateId");
    const found = await get(request({ params: { templateId: String(created["id"]) } }));
    expect(found.status).toBe(200);

    await expect(get(request({ params: { templateId: "missing" } }))).rejects.toMatchObject({
      code: REPORT_TEMPLATE_NOT_FOUND,
      status: 404,
    });
  });

  it("lists templates with cursor pagination", async () => {
    const value = harness();
    await createTemplate(value, { name: "One", document: validDocument() });
    await createTemplate(value, { name: "Two", document: validDocument() });
    await createTemplate(value, { name: "Three", document: validDocument() });

    const list = handlerFor(value.routes, "GET", "/v1/report-templates");
    const names: string[] = [];
    let cursor: string | null = null;
    do {
      const query = new URLSearchParams({ limit: "2" });
      if (cursor !== null) query.set("cursor", cursor);
      const page = await list(request({ query }));
      const body = page.body as {
        items: { name: string }[];
        nextCursor: string | null;
      };
      names.push(...body.items.map((item) => item.name));
      cursor = body.nextCursor;
    } while (cursor !== null);

    // Four built-in starting points precede the three stored templates.
    expect(names).toHaveLength(7);
    expect(names.slice(4)).toEqual(["One", "Two", "Three"]);
  });

  it("updates a template name and rejects an invalid replacement document", async () => {
    const value = harness();
    const created = await createTemplate(value, { name: "One", document: validDocument() });
    const id = String(created["id"]);

    const update = handlerFor(value.routes, "PATCH", "/v1/report-templates/:templateId");
    const updated = await update(
      request({ method: "PATCH", params: { templateId: id }, body: { name: "Renamed" } }),
    );
    expect(updated.status).toBe(200);
    expect((updated.body as Record<string, unknown>)["name"]).toBe("Renamed");

    const invalid = validDocument();
    invalid["blocks"] = [{ ...(validDocument()["blocks"] as Array<Record<string, unknown>>)[0], type: "iframe" }];
    await expect(
      update(request({ method: "PATCH", params: { templateId: id }, body: { document: invalid } })),
    ).rejects.toMatchObject({ code: REPORT_TEMPLATE_INVALID });
  });

  it("soft-deletes a template", async () => {
    const value = harness();
    const created = await createTemplate(value, { name: "One", document: validDocument() });
    const id = String(created["id"]);

    const remove = handlerFor(value.routes, "DELETE", "/v1/report-templates/:templateId");
    const response = await remove(request({ method: "DELETE", params: { templateId: id } }));
    expect(response.status).toBe(204);

    const get = handlerFor(value.routes, "GET", "/v1/report-templates/:templateId");
    await expect(get(request({ params: { templateId: id } }))).rejects.toMatchObject({
      code: REPORT_TEMPLATE_NOT_FOUND,
    });
    await expect(remove(request({ method: "DELETE", params: { templateId: id } }))).rejects.toMatchObject({
      code: REPORT_TEMPLATE_NOT_FOUND,
    });
  });

  it("clones a template with a new id and a default copy name", async () => {
    const value = harness();
    const created = await createTemplate(value, { name: "One", document: validDocument() });
    const id = String(created["id"]);

    const clone = handlerFor(value.routes, "POST", "/v1/report-templates/:templateId/clone");
    const response = await clone(request({ method: "POST", params: { templateId: id } }));
    expect(response.status).toBe(201);
    const cloned = response.body as Record<string, unknown>;
    expect(cloned["id"]).not.toBe(id);
    expect(cloned["name"]).toBe("One (copy)");
    expect((cloned["document"] as Record<string, unknown>)["id"]).toBe(cloned["id"]);
    expect((cloned["document"] as Record<string, unknown>)["blocks"]).toEqual(
      validDocument()["blocks"],
    );
  });

  it("generates from a template through the render path", async () => {
    const value = harness();
    const created = await createTemplate(value, {
      name: "One",
      tenantId: "tenant-a",
      document: validDocument(),
    });
    const id = String(created["id"]);

    const generate = handlerFor(value.routes, "POST", "/v1/report-templates/:templateId/generate");
    const response = await generate(request({ method: "POST", params: { templateId: id } }));
    expect(response.status).toBe(202);
    expect((response.body as Record<string, unknown>)["status"]).toBe("queued");

    expect(value.render.requests).toHaveLength(1);
    expect(value.render.requests[0]).toMatchObject({
      templateId: id,
      tenantId: "tenant-a",
      requestedBy: "operator-1",
      correlationId: "corr-test",
    });
    expect(value.permissions).toContain(REPORT_TEMPLATE_PERMISSIONS.generate);
  });

  it("requires a tenant to generate from a global template", async () => {
    const value = harness();
    const created = await createTemplate(value, { name: "Global", document: validDocument() });
    const generate = handlerFor(value.routes, "POST", "/v1/report-templates/:templateId/generate");

    await expect(
      generate(request({ method: "POST", params: { templateId: String(created["id"]) } })),
    ).rejects.toMatchObject({ code: REPORT_TEMPLATE_TENANT_REQUIRED, status: 400 });

    const response = await generate(
      request({
        method: "POST",
        params: { templateId: String(created["id"]) },
        body: { tenantId: "tenant-b" },
      }),
    );
    expect(response.status).toBe(202);
    expect(value.render.requests[0]?.tenantId).toBe("tenant-b");
  });

  it("gates writes on reports.templates.write and reads on reports.read", async () => {
    const value = harness({
      authorize: {
        requirePermission: (_ctx, permission) => {
          if (permission === REPORT_TEMPLATE_PERMISSIONS.write) {
            throw new AppError("auth.denied", "forbidden", 403);
          }
        },
      },
    });

    const create = handlerFor(value.routes, "POST", "/v1/report-templates");
    await expect(
      create(request({ body: { name: "One", document: validDocument() } })),
    ).rejects.toMatchObject({ status: 403 });

    const list = handlerFor(value.routes, "GET", "/v1/report-templates");
    const response = await list(request());
    expect(response.status).toBe(200);
  });
});

describe("built-in report templates (T-0923)", () => {
  it("ships four read-only starting points whose documents satisfy the contract", () => {
    expect(BUILT_IN_REPORT_TEMPLATES.map((template) => template.name)).toEqual([
      "Executive summary",
      "Technical findings",
      "Compliance (per framework)",
      "Remediation plan",
    ]);
    for (const template of BUILT_IN_REPORT_TEMPLATES) {
      expect(template.tenantId).toBeNull();
      expect(() => parseReportTemplate(template.document)).not.toThrow();
      expect((template.document as { blocks: unknown[] }).blocks.length).toBeGreaterThan(1);
    }
  });

  it("lists and reads built-ins with a read-only marker", async () => {
    const value = harness();
    const list = await handlerFor(value.routes, "GET", "/v1/report-templates")(request());
    const items = (list.body as { items: Record<string, unknown>[] }).items;
    expect(items).toHaveLength(4);
    expect(items.every((item) => item["readOnly"] === true)).toBe(true);
    expect(items.every((item) => item["builtIn"] === true)).toBe(true);

    const get = handlerFor(value.routes, "GET", "/v1/report-templates/:templateId");
    const builtIn = await get(
      request({ params: { templateId: "builtin-executive-summary" } }),
    );
    expect(builtIn.status).toBe(200);
    expect((builtIn.body as Record<string, unknown>)["readOnly"]).toBe(true);
    expect((builtIn.body as Record<string, unknown>)["name"]).toBe("Executive summary");
  });

  it("refuses to update or delete a built-in", async () => {
    const value = harness();
    const update = handlerFor(value.routes, "PATCH", "/v1/report-templates/:templateId");
    await expect(
      update(
        request({
          method: "PATCH",
          params: { templateId: "builtin-technical-findings" },
          body: { name: "Changed" },
        }),
      ),
    ).rejects.toMatchObject({ code: REPORT_TEMPLATE_READ_ONLY, status: 409 });

    const remove = handlerFor(value.routes, "DELETE", "/v1/report-templates/:templateId");
    await expect(
      remove(
        request({
          method: "DELETE",
          params: { templateId: "builtin-compliance" },
        }),
      ),
    ).rejects.toMatchObject({ code: REPORT_TEMPLATE_READ_ONLY, status: 409 });
    expect(await value.store.listTemplates()).toHaveLength(0);
  });

  it("clones a built-in into an editable stored template", async () => {
    const value = harness();
    const clone = handlerFor(value.routes, "POST", "/v1/report-templates/:templateId/clone");
    const response = await clone(
      request({
        method: "POST",
        params: { templateId: "builtin-remediation-plan" },
        body: { name: "Q4 remediation" },
      }),
    );
    expect(response.status).toBe(201);
    const cloned = response.body as Record<string, unknown>;
    expect(cloned["id"]).not.toBe("builtin-remediation-plan");
    expect(cloned["name"]).toBe("Q4 remediation");
    expect(cloned["readOnly"]).toBeUndefined();
    const document = cloned["document"] as Record<string, unknown>;
    expect(document["id"]).toBe(cloned["id"]);
    expect(document["name"]).toBe("Q4 remediation");
    expect((document["blocks"] as unknown[]).length).toBe(5);
    expect(await value.store.listTemplates()).toHaveLength(1);
  });

  it("generates a report from a built-in when a tenant is supplied", async () => {
    const value = harness();
    const generate = handlerFor(value.routes, "POST", "/v1/report-templates/:templateId/generate");
    await expect(
      generate(
        request({
          method: "POST",
          params: { templateId: "builtin-executive-summary" },
        }),
      ),
    ).rejects.toMatchObject({ code: REPORT_TEMPLATE_TENANT_REQUIRED });

    const response = await generate(
      request({
        method: "POST",
        params: { templateId: "builtin-executive-summary" },
        body: { tenantId: "tenant-a" },
      }),
    );
    expect(response.status).toBe(202);
    expect(value.render.requests[0]?.templateId).toBe("builtin-executive-summary");
  });
});

describe("report template tenant scope (T-0823)", () => {
  it("hides and refuses other tenants' templates but keeps global ones open", async () => {
    const value = harness({ tenantAccess: (_ctx, tenantId) => tenantId === "tenant-a" });
    const mine = await createTemplate(value, { name: "Mine", tenantId: "tenant-a", document: validDocument() });
    const global = await createTemplate(value, { name: "Global", document: validDocument() });
    const other = await value.store.createTemplate({
      id: "other",
      name: "Other",
      tenantId: "tenant-b",
      document: validDocument(),
      createdBy: null,
      actorUserId: null,
      correlationId: null,
    });

    const list = await handlerFor(value.routes, "GET", "/v1/report-templates")(request());
    const ids = (list.body as { items: { id: string }[] }).items.map((t) => t.id).sort();
    expect(ids).toEqual(
      [
        String(mine["id"]),
        String(global["id"]),
        "builtin-executive-summary",
        "builtin-technical-findings",
        "builtin-compliance",
        "builtin-remediation-plan",
      ].sort(),
    );

    const get = handlerFor(value.routes, "GET", "/v1/report-templates/:templateId");
    await expect(get(request({ params: { templateId: other.id } }))).rejects.toMatchObject({ status: 403 });
    const create = handlerFor(value.routes, "POST", "/v1/report-templates");
    await expect(create(request({ body: { name: "X", tenantId: "tenant-b", document: validDocument() } }))).rejects.toMatchObject({ status: 403 });
    const generate = handlerFor(value.routes, "POST", "/v1/report-templates/:templateId/generate");
    await expect(
      generate(request({ params: { templateId: String(global["id"]) }, body: { tenantId: "tenant-b" } })),
    ).rejects.toMatchObject({ status: 403 });
    expect(value.render.requests).toHaveLength(0);
  });
});
