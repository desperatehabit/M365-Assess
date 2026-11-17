import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openSqliteRepository, type SqliteRepository } from "@m365-assess/db";
import { afterEach, describe, expect, it } from "vitest";
import { tenantScope } from "../rbac/scope.js";
import {
  REMEDIATION_APPLY_PERMISSION,
  type CreateSharePointSiteInput,
  type SharePointSitePlan,
  type SharePointSiteResult,
  type SharePointSitesBulkResult,
  type SharePointSitesCreateProvider,
} from "./sharepoint-sites-create.js";
import {
  SHAREPOINT_READ_PERMISSION,
  SHAREPOINT_TEMPLATES_OPENAPI,
  SHAREPOINT_TEMPLATES_PATH,
  SHAREPOINT_TEMPLATE_DEPLOY_PATH,
  SHAREPOINT_TEMPLATE_INVALID,
  SHAREPOINT_TEMPLATE_NOT_FOUND,
  SHAREPOINT_TEMPLATE_PATH,
  SHAREPOINT_WRITE_PERMISSION,
  createSharePointTemplateRoutes,
  type SharePointTemplateAuditEvent,
  type SharePointTemplateCaller,
  type SharePointTemplateCreateInput,
  type SharePointTemplateListOptions,
  type SharePointTemplateRecord,
  type SharePointTemplateRoutesOptions,
  type SharePointTemplateUpdateInput,
  type SharePointTemplatesStore,
} from "./sharepoint-templates.js";

const TENANT_A = "tenant-a";
const TENANT_B = "tenant-b";

class InMemorySharePointTemplatesStore implements SharePointTemplatesStore {
  private readonly rows = new Map<string, SharePointTemplateRecord>();

  async createSharePointTemplate(
    input: SharePointTemplateCreateInput,
  ): Promise<SharePointTemplateRecord> {
    const createdAt = input.createdAt ?? "2026-09-01T00:00:00.000Z";
    const updatedAt = input.updatedAt ?? createdAt;
    const record: SharePointTemplateRecord = {
      id: input.id,
      name: input.name,
      siteType: input.siteType,
      settings: input.settings ?? {},
      variables: input.variables ?? {},
      createdAt,
      updatedAt,
      deletedAt: input.deletedAt ?? null,
    };
    this.rows.set(record.id, record);
    return record;
  }

  async getSharePointTemplate(
    templateId: string,
    options: SharePointTemplateListOptions = {},
  ): Promise<SharePointTemplateRecord | undefined> {
    const row = this.rows.get(templateId);
    if (!row) return undefined;
    if (!options.includeDeleted && row.deletedAt !== null) return undefined;
    return row;
  }

  async listSharePointTemplates(
    options: SharePointTemplateListOptions = {},
  ): Promise<SharePointTemplateRecord[]> {
    return [...this.rows.values()]
      .filter((row) => options.includeDeleted || row.deletedAt === null)
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  async updateSharePointTemplate(
    templateId: string,
    update: SharePointTemplateUpdateInput,
  ): Promise<SharePointTemplateRecord | undefined> {
    const existing = this.rows.get(templateId);
    if (!existing) return undefined;
    const updated: SharePointTemplateRecord = {
      ...existing,
      name: update.name ?? existing.name,
      siteType: update.siteType ?? existing.siteType,
      settings: update.settings === undefined ? existing.settings : update.settings,
      variables: update.variables === undefined ? existing.variables : update.variables,
      updatedAt: "2026-09-02T00:00:00.000Z",
    };
    this.rows.set(templateId, updated);
    return updated;
  }

  async softDeleteSharePointTemplate(
    templateId: string,
    options: { now?: string } = {},
  ): Promise<boolean> {
    const existing = this.rows.get(templateId);
    if (!existing || existing.deletedAt !== null) return false;
    this.rows.set(templateId, {
      ...existing,
      deletedAt: options.now ?? "2026-09-03T00:00:00.000Z",
    });
    return true;
  }
}

class FakeSitesCreateProvider implements SharePointSitesCreateProvider {
  readonly calls: Array<{ tenantId: string; input: CreateSharePointSiteInput; preview: boolean }> =
    [];

  constructor(private readonly failTenants: readonly string[] = []) {}

  async createSite(
    tenantId: string,
    input: CreateSharePointSiteInput,
    preview: boolean,
  ): Promise<SharePointSiteResult | SharePointSitePlan> {
    this.calls.push({ tenantId, input, preview });
    const plan: SharePointSitePlan = {
      action: "create",
      targetName: input.name,
      diff: [`Create ${input.type} site '${input.name}' (${input.alias})`],
      valid: true,
      dryRun: preview,
    };
    if (preview) return plan;
    const failed = this.failTenants.includes(tenantId);
    if (failed) {
      return { success: false, siteId: null, plan };
    }
    return {
      success: true,
      siteId: `site-${tenantId}`,
      plan,
      auditEvent: {
        id: `audit-${tenantId}`,
        tenantId,
        action: "sharepoint.site.create",
        targetId: `site-${tenantId}`,
        targetName: input.name,
        timestamp: "2026-09-01T00:00:00.000Z",
      },
    };
  }

  async createSitesBulk(): Promise<SharePointSitesBulkResult> {
    return { success: true, total: 0, created: 0, failed: 0, results: [] };
  }
}

function callerFor(
  tenantIds: readonly string[],
  permissions: readonly string[],
): SharePointTemplateCaller {
  return {
    userId: "operator-1",
    roles: [],
    tenantScope: tenantScope(tenantIds),
    permissions,
  };
}

function ctxFor(
  method: string,
  path: string,
  body?: unknown,
  params: Record<string, string> = {},
  query = "",
) {
  return {
    correlationId: "corr-sp-tpl",
    method,
    path,
    query: new URLSearchParams(query),
    headers: {},
    params,
    body,
  };
}

const READ_CALLER = callerFor([TENANT_A, TENANT_B], [SHAREPOINT_READ_PERMISSION]);
const WRITE_CALLER = callerFor(
  [TENANT_A, TENANT_B],
  [SHAREPOINT_READ_PERMISSION, SHAREPOINT_WRITE_PERMISSION, REMEDIATION_APPLY_PERMISSION],
);

function buildHarness(
  caller?: SharePointTemplateCaller,
  failTenants: readonly string[] = [],
  store: SharePointTemplatesStore = new InMemorySharePointTemplatesStore(),
) {
  const sitesCreate = new FakeSitesCreateProvider(failTenants);
  const audits: SharePointTemplateAuditEvent[] = [];
  const options: SharePointTemplateRoutesOptions = {
    store,
    sitesCreate,
    resolveCaller: () => caller,
    recordAudit: (event) => {
      audits.push(event);
    },
    newId: (() => {
      let n = 0;
      return () => {
        n += 1;
        return `tpl-${n}`;
      };
    })(),
    now: () => "2026-09-01T00:00:00.000Z",
  };
  const routes = createSharePointTemplateRoutes(options);
  return {
    store,
    sitesCreate,
    audits,
    routes,
    route: (method: string, path: string) => {
      const found = routes.find((r) => r.method === method && r.path === path);
      if (!found) throw new Error(`missing ${method} ${path}`);
      return found;
    },
  };
}

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("SharePoint templates routes (T-0896)", () => {
  it("exposes all CRUD + deploy endpoints and OpenAPI metadata with permissions", () => {
    const { routes } = buildHarness(WRITE_CALLER);
    expect(routes.map((r) => `${r.method} ${r.path}`)).toEqual([
      `GET ${SHAREPOINT_TEMPLATES_PATH}`,
      `POST ${SHAREPOINT_TEMPLATES_PATH}`,
      `GET ${SHAREPOINT_TEMPLATE_PATH}`,
      `PATCH ${SHAREPOINT_TEMPLATE_PATH}`,
      `DELETE ${SHAREPOINT_TEMPLATE_PATH}`,
      `POST ${SHAREPOINT_TEMPLATE_DEPLOY_PATH}`,
    ]);

    expect(SHAREPOINT_TEMPLATES_OPENAPI.paths["/sharepoint/templates"].get.permission).toBe(
      SHAREPOINT_READ_PERMISSION,
    );
    expect(SHAREPOINT_TEMPLATES_OPENAPI.paths["/sharepoint/templates"].post.permission).toBe(
      SHAREPOINT_WRITE_PERMISSION,
    );
    expect(SHAREPOINT_TEMPLATES_OPENAPI.paths["/sharepoint/templates/{id}"].get.permission).toBe(
      SHAREPOINT_READ_PERMISSION,
    );
    expect(SHAREPOINT_TEMPLATES_OPENAPI.paths["/sharepoint/templates/{id}"].patch.permission).toBe(
      SHAREPOINT_WRITE_PERMISSION,
    );
    expect(SHAREPOINT_TEMPLATES_OPENAPI.paths["/sharepoint/templates/{id}"].delete.permission).toBe(
      SHAREPOINT_WRITE_PERMISSION,
    );
    expect(
      SHAREPOINT_TEMPLATES_OPENAPI.paths["/sharepoint/templates/{id}/deploy"].post.permission,
    ).toBe(SHAREPOINT_WRITE_PERMISSION);
  });

  it("wires directly to SqliteRepository without an adapter shim", async () => {
    const dir = mkdtempSync(join(tmpdir(), "m365-sp-tpl-"));
    tempDirs.push(dir);
    const repo: SqliteRepository = await openSqliteRepository({ filename: join(dir, "portal.db") });
    try {
      const storeCheck: SharePointTemplatesStore = repo;
      const { route } = buildHarness(WRITE_CALLER, [], storeCheck);

      const created = await route("POST", SHAREPOINT_TEMPLATES_PATH).handler(
        ctxFor("POST", SHAREPOINT_TEMPLATES_PATH, {
          name: "Engineering Team Site",
          siteType: "team",
          settings: { sharing: "disabled" },
          variables: { alias: "eng" },
        }),
      );
      expect(created.status).toBe(201);
      const id = (created.body as SharePointTemplateRecord).id;

      const listed = await route("GET", SHAREPOINT_TEMPLATES_PATH).handler(
        ctxFor("GET", SHAREPOINT_TEMPLATES_PATH),
      );
      expect((listed.body as { items: SharePointTemplateRecord[] }).items).toHaveLength(1);

      const updated = await route("PATCH", SHAREPOINT_TEMPLATE_PATH).handler(
        ctxFor("PATCH", `/v1/sharepoint/templates/${id}`, { name: "Eng v2" }, { id }),
      );
      expect((updated.body as SharePointTemplateRecord).name).toBe("Eng v2");

      const deleted = await route("DELETE", SHAREPOINT_TEMPLATE_PATH).handler(
        ctxFor("DELETE", `/v1/sharepoint/templates/${id}`, undefined, { id }),
      );
      expect(deleted.status).toBe(204);

      const after = await route("GET", SHAREPOINT_TEMPLATES_PATH).handler(
        ctxFor("GET", SHAREPOINT_TEMPLATES_PATH),
      );
      expect((after.body as { items: SharePointTemplateRecord[] }).items).toHaveLength(0);
    } finally {
      repo.close();
    }
  });

  it("rejects unauthenticated and unauthorized callers", async () => {
    const anon = buildHarness(undefined);
    await expect(
      anon.route("GET", SHAREPOINT_TEMPLATES_PATH).handler(ctxFor("GET", SHAREPOINT_TEMPLATES_PATH)),
    ).rejects.toMatchObject({ status: 401 });

    const reader = buildHarness(READ_CALLER);
    await expect(
      reader
        .route("POST", SHAREPOINT_TEMPLATES_PATH)
        .handler(ctxFor("POST", SHAREPOINT_TEMPLATES_PATH, { name: "X", siteType: "team" })),
    ).rejects.toMatchObject({ status: 403 });

    const noApply = buildHarness(callerFor([TENANT_A], [SHAREPOINT_WRITE_PERMISSION]));
    await noApply.store.createSharePointTemplate({ id: "tpl-1", name: "X", siteType: "team" });
    await expect(
      noApply.route("POST", SHAREPOINT_TEMPLATE_DEPLOY_PATH).handler(
        ctxFor(
          "POST",
          "/v1/sharepoint/templates/tpl-1/deploy",
          { tenantId: TENANT_A },
          { id: "tpl-1" },
        ),
      ),
    ).rejects.toMatchObject({ status: 403 });
  });

  it("validates create and update payloads and returns 404 for missing or deleted templates", async () => {
    const { route } = buildHarness(WRITE_CALLER);

    await expect(
      route("POST", SHAREPOINT_TEMPLATES_PATH).handler(
        ctxFor("POST", SHAREPOINT_TEMPLATES_PATH, { name: "", siteType: "team" }),
      ),
    ).rejects.toMatchObject({ status: 400, code: SHAREPOINT_TEMPLATE_INVALID });

    await expect(
      route("POST", SHAREPOINT_TEMPLATES_PATH).handler(
        ctxFor("POST", SHAREPOINT_TEMPLATES_PATH, { name: "Intranet", siteType: "classic" }),
      ),
    ).rejects.toMatchObject({ status: 400, code: SHAREPOINT_TEMPLATE_INVALID });

    await expect(
      route("POST", SHAREPOINT_TEMPLATES_PATH).handler(
        ctxFor("POST", SHAREPOINT_TEMPLATES_PATH, {
          name: "Intranet",
          siteType: "communication",
          settings: [],
        }),
      ),
    ).rejects.toMatchObject({ status: 400, code: SHAREPOINT_TEMPLATE_INVALID });

    await expect(
      route("GET", SHAREPOINT_TEMPLATE_PATH).handler(
        ctxFor("GET", "/v1/sharepoint/templates/missing", undefined, { id: "missing" }),
      ),
    ).rejects.toMatchObject({ status: 404, code: SHAREPOINT_TEMPLATE_NOT_FOUND });
  });

  it("creates, reads, updates, and soft-deletes templates with audit events", async () => {
    const { route, audits } = buildHarness(WRITE_CALLER);

    const created = await route("POST", SHAREPOINT_TEMPLATES_PATH).handler(
      ctxFor("POST", SHAREPOINT_TEMPLATES_PATH, {
        name: "Project Site",
        siteType: "team",
        settings: {
          name: "{project} Team",
          alias: "{alias}",
          sharing: "externalUserSharingOnly",
          owners: ["owner1@example.invalid"],
        },
        variables: { project: "Apollo", alias: "apollo" },
      }),
    );
    expect(created.status).toBe(201);
    const tpl = created.body as SharePointTemplateRecord;
    expect(tpl.id).toBe("tpl-1");

    const fetched = await route("GET", SHAREPOINT_TEMPLATE_PATH).handler(
      ctxFor("GET", "/v1/sharepoint/templates/tpl-1", undefined, { id: "tpl-1" }),
    );
    expect(fetched.status).toBe(200);
    expect((fetched.body as SharePointTemplateRecord).name).toBe("Project Site");

    const patched = await route("PATCH", SHAREPOINT_TEMPLATE_PATH).handler(
      ctxFor(
        "PATCH",
        "/v1/sharepoint/templates/tpl-1",
        { name: "Project Site v2", siteType: "communication" },
        { id: "tpl-1" },
      ),
    );
    expect(patched.status).toBe(200);
    expect((patched.body as SharePointTemplateRecord).siteType).toBe("communication");

    const deleted = await route("DELETE", SHAREPOINT_TEMPLATE_PATH).handler(
      ctxFor("DELETE", "/v1/sharepoint/templates/tpl-1", undefined, { id: "tpl-1" }),
    );
    expect(deleted.status).toBe(204);
    expect(audits.map((a) => a.action)).toEqual([
      "sharepoint.template.create",
      "sharepoint.template.update",
      "sharepoint.template.delete",
    ]);
  });

  it("previews deployment with variable resolution without applying writes", async () => {
    const { store, sitesCreate, audits, route } = buildHarness(WRITE_CALLER);
    await store.createSharePointTemplate({
      id: "tpl-project",
      name: "Project Blueprint",
      siteType: "team",
      settings: {
        name: "{dept} Hub",
        alias: "{slug}",
        sharing: "disabled",
        owners: ["owner1@example.invalid"],
      },
      variables: { dept: "Default", slug: "default-hub" },
    });

    const response = await route("POST", SHAREPOINT_TEMPLATE_DEPLOY_PATH).handler(
      ctxFor(
        "POST",
        "/v1/sharepoint/templates/tpl-project/deploy",
        {
          preview: true,
          targets: [
            { tenantId: TENANT_A, variables: { dept: "Finance", slug: "finance-hub" } },
            { tenantId: TENANT_B, variables: { dept: "HR", slug: "hr-hub" } },
          ],
        },
        { id: "tpl-project" },
      ),
    );
    expect(response.status).toBe(200);
    const body = response.body as {
      preview: boolean;
      allValid: boolean;
      plans: Array<{ tenantId: string; targetName: string; alias: string; valid: boolean }>;
    };
    expect(body.preview).toBe(true);
    expect(body.allValid).toBe(true);
    expect(body.plans).toHaveLength(2);
    expect(body.plans[0]).toMatchObject({
      tenantId: TENANT_A,
      targetName: "Finance Hub",
      alias: "finance-hub",
      valid: true,
    });
    expect(sitesCreate.calls.every((c) => c.preview === true)).toBe(true);
    expect(audits).toHaveLength(0);
  });

  it("enforces tenant scope and reports partial failures when deploying across targets", async () => {
    const scopedHarness = buildHarness(
      callerFor([TENANT_A], [SHAREPOINT_WRITE_PERMISSION, REMEDIATION_APPLY_PERMISSION]),
    );
    await scopedHarness.store.createSharePointTemplate({
      id: "tpl-1",
      name: "Team Site",
      siteType: "team",
      settings: { name: "Ops", alias: "ops", owners: ["owner@example.invalid"] },
    });
    await expect(
      scopedHarness.route("POST", SHAREPOINT_TEMPLATE_DEPLOY_PATH).handler(
        ctxFor(
          "POST",
          "/v1/sharepoint/templates/tpl-1/deploy",
          { targets: [TENANT_A, TENANT_B] },
          { id: "tpl-1" },
        ),
      ),
    ).rejects.toMatchObject({ status: 403 });

    const partial = buildHarness(WRITE_CALLER, [TENANT_B]);
    await partial.store.createSharePointTemplate({
      id: "tpl-1",
      name: "Team Site",
      siteType: "team",
      settings: {
        name: "Ops {region}",
        alias: "ops-{region}",
        owners: ["owner@example.invalid"],
        sharing: "disabled",
      },
      variables: { region: "us" },
    });

    const res = await partial.route("POST", SHAREPOINT_TEMPLATE_DEPLOY_PATH).handler(
      ctxFor(
        "POST",
        "/v1/sharepoint/templates/tpl-1/deploy",
        {
          targets: [
            { tenantId: TENANT_A, variables: { region: "eu" } },
            { tenantId: TENANT_B, variables: { region: "apac" } },
          ],
        },
        { id: "tpl-1" },
      ),
    );
    expect(res.status).toBe(207);
    const body = res.body as {
      summary: { total: number; created: number; failed: number };
      results: Array<{ tenantId: string; status: string; siteId: string | null }>;
    };
    expect(body.summary).toEqual({ total: 2, created: 1, failed: 1 });
    expect(body.results[0]).toMatchObject({
      tenantId: TENANT_A,
      status: "created",
      siteId: `site-${TENANT_A}`,
    });
    expect(body.results[1]).toMatchObject({
      tenantId: TENANT_B,
      status: "failed",
      siteId: null,
    });
    expect(partial.audits).toHaveLength(2);
  });
});
