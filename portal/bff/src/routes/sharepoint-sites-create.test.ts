import { describe, expect, it } from "vitest";
import { tenantScope } from "../rbac/scope.js";
import {
  SHAREPOINT_SITES_BASE_PATH,
  SHAREPOINT_SITES_CREATE_DESCRIPTION,
  SHAREPOINT_WRITE_PERMISSION,
  createSharePointSitesCreateRoutes,
  validateSharePointSiteInput,
  type CreateSharePointSiteInput,
  type SharePointSitePlan,
  type SharePointSiteResult,
  type SharePointSitesBulkResult,
  type SharePointSitesCreateCaller,
  type SharePointSitesCreateProvider,
} from "./sharepoint-sites-create.js";

const TENANT = "tenant-test";

const SITE_BODY = {
  name: "Project Alpha",
  alias: "project-alpha",
  type: "team",
  owners: ["owner@example.invalid"],
  sharing: "disabled",
};

class FakeSharePointSitesCreateProvider implements SharePointSitesCreateProvider {
  readonly createCalls: Array<{ tenantId: string; input: CreateSharePointSiteInput; preview: boolean }> = [];
  readonly bulkCalls: Array<{
    tenantId: string;
    sites: readonly CreateSharePointSiteInput[];
    csv: string | undefined;
    preview: boolean;
  }> = [];

  async createSite(
    tenantId: string,
    input: CreateSharePointSiteInput,
    preview: boolean,
  ): Promise<SharePointSiteResult | SharePointSitePlan> {
    this.createCalls.push({ tenantId, input, preview });
    const plan: SharePointSitePlan = {
      action: "create",
      targetName: input.name,
      diff: [`Create ${input.type} site '${input.name}'`],
      valid: true,
      dryRun: preview,
    };
    if (preview) return plan;
    return {
      success: true,
      siteId: "site-1",
      plan,
      auditEvent: {
        id: "audit-1",
        tenantId,
        action: "sharepoint.site.create",
        targetId: "site-1",
        targetName: input.name,
        timestamp: "2026-09-26T18:00:00Z",
      },
    };
  }

  async createSitesBulk(
    tenantId: string,
    sites: readonly CreateSharePointSiteInput[],
    csv: string | undefined,
    preview: boolean,
  ): Promise<SharePointSitesBulkResult> {
    this.bulkCalls.push({ tenantId, sites, csv, preview });
    const results = sites.map((site, index) => ({
      row: index + 1,
      name: site.name,
      alias: site.alias,
      status: (index === 1 ? "failed" : preview ? "planned" : "created") as "created" | "planned" | "failed",
      siteId: index === 1 ? null : "site-1",
      error: index === 1 ? "type 'portal' must be team or communication" : null,
    }));
    return {
      success: results.every((r) => r.status !== "failed"),
      total: results.length,
      created: results.filter((r) => r.status === "created").length,
      failed: results.filter((r) => r.status === "failed").length,
      results,
    };
  }
}

describe("SharePoint sites create routes (T-0484)", () => {
  const getRoutes = (provider: FakeSharePointSitesCreateProvider, caller?: SharePointSitesCreateCaller) => {
    return createSharePointSitesCreateRoutes({
      provider,
      resolveCaller: () => caller,
    });
  };
  const postRoute = (provider: FakeSharePointSitesCreateProvider, caller?: SharePointSitesCreateCaller) =>
    getRoutes(provider, caller).find((r) => r.method === "POST" && r.path === SHAREPOINT_SITES_BASE_PATH)!;

  it("documents the bulk CSV schema in the OpenAPI request description", () => {
    for (const token of ["name", "alias", "type", "owners", "template", "sharing", "team|communication"]) {
      expect(SHAREPOINT_SITES_CREATE_DESCRIPTION).toContain(token);
    }
  });

  it("validates site input accurately", () => {
    expect(validateSharePointSiteInput(SITE_BODY).valid).toBe(true);
    expect(validateSharePointSiteInput({ ...SITE_BODY, type: "portal" }).valid).toBe(false);
    expect(validateSharePointSiteInput({ ...SITE_BODY, alias: "not a slug!" }).valid).toBe(false);
    expect(validateSharePointSiteInput({ ...SITE_BODY, owners: [] }).valid).toBe(false);
    expect(validateSharePointSiteInput({ ...SITE_BODY, sharing: "everyone" }).valid).toBe(false);
  });

  it("rejects unauthenticated requests with 401", async () => {
    const provider = new FakeSharePointSitesCreateProvider();
    await expect(
      postRoute(provider, undefined).handler({
        method: "POST",
        path: `/v1/tenants/${TENANT}/sharepoint/sites`,
        params: { tenantId: TENANT },
        query: new URLSearchParams(),
        headers: {},
        body: SITE_BODY,
      }),
    ).rejects.toMatchObject({ status: 401 });
  });

  it("rejects callers missing SharePoint.Site.ReadWrite with 403", async () => {
    const provider = new FakeSharePointSitesCreateProvider();
    const caller: SharePointSitesCreateCaller = {
      tenantScope: tenantScope([TENANT]),
      permissions: ["SharePoint.Site.Read"],
    };
    await expect(
      postRoute(provider, caller).handler({
        method: "POST",
        path: `/v1/tenants/${TENANT}/sharepoint/sites`,
        params: { tenantId: TENANT },
        query: new URLSearchParams(),
        headers: {},
        body: SITE_BODY,
      }),
    ).rejects.toMatchObject({ status: 403 });
    expect(provider.createCalls).toHaveLength(0);
  });

  it("rejects out-of-scope tenants with 403", async () => {
    const provider = new FakeSharePointSitesCreateProvider();
    const caller: SharePointSitesCreateCaller = {
      tenantScope: tenantScope(["other-tenant"]),
      permissions: [SHAREPOINT_WRITE_PERMISSION],
    };
    await expect(
      postRoute(provider, caller).handler({
        method: "POST",
        path: `/v1/tenants/${TENANT}/sharepoint/sites`,
        params: { tenantId: TENANT },
        query: new URLSearchParams(),
        headers: {},
        body: SITE_BODY,
      }),
    ).rejects.toMatchObject({ status: 403 });
    expect(provider.createCalls).toHaveLength(0);
  });

  it("returns a plan preview on single create when preview requested", async () => {
    const provider = new FakeSharePointSitesCreateProvider();
    const caller: SharePointSitesCreateCaller = {
      tenantScope: tenantScope([TENANT]),
      permissions: [SHAREPOINT_WRITE_PERMISSION],
    };
    const response = await postRoute(provider, caller).handler({
      method: "POST",
      path: `/v1/tenants/${TENANT}/sharepoint/sites`,
      params: { tenantId: TENANT },
      query: new URLSearchParams("preview=true"),
      headers: {},
      body: SITE_BODY,
    });
    expect(response.status).toBe(200);
    const body = response.body as SharePointSitePlan;
    expect(body.valid).toBe(true);
    expect(body.dryRun).toBe(true);
    expect(provider.createCalls[0]?.preview).toBe(true);
  });

  it("creates a single site and returns the audit record on apply", async () => {
    const provider = new FakeSharePointSitesCreateProvider();
    const caller: SharePointSitesCreateCaller = {
      tenantScope: tenantScope([TENANT]),
      permissions: ["Remediation.Apply"],
    };
    const response = await postRoute(provider, caller).handler({
      method: "POST",
      path: `/v1/tenants/${TENANT}/sharepoint/sites`,
      params: { tenantId: TENANT },
      query: new URLSearchParams(),
      headers: {},
      body: SITE_BODY,
    });
    expect(response.status).toBe(201);
    const body = response.body as SharePointSiteResult;
    expect(body.success).toBe(true);
    expect(body.auditEvent?.action).toBe("sharepoint.site.create");
    expect(body.auditEvent?.targetId).toBe("site-1");
  });

  it("rejects an invalid single create before dispatch", async () => {
    const provider = new FakeSharePointSitesCreateProvider();
    const caller: SharePointSitesCreateCaller = {
      tenantScope: tenantScope([TENANT]),
      permissions: [SHAREPOINT_WRITE_PERMISSION],
    };
    await expect(
      postRoute(provider, caller).handler({
        method: "POST",
        path: `/v1/tenants/${TENANT}/sharepoint/sites`,
        params: { tenantId: TENANT },
        query: new URLSearchParams(),
        headers: {},
        body: { ...SITE_BODY, type: "portal" },
      }),
    ).rejects.toMatchObject({ status: 400 });
    expect(provider.createCalls).toHaveLength(0);
  });

  it("returns one result per row for a mixed-result bulk import", async () => {
    const provider = new FakeSharePointSitesCreateProvider();
    const caller: SharePointSitesCreateCaller = {
      tenantScope: tenantScope([TENANT]),
      permissions: [SHAREPOINT_WRITE_PERMISSION],
    };
    const response = await postRoute(provider, caller).handler({
      method: "POST",
      path: `/v1/tenants/${TENANT}/sharepoint/sites`,
      params: { tenantId: TENANT },
      query: new URLSearchParams(),
      headers: {},
      body: {
        sites: [
          SITE_BODY,
          { ...SITE_BODY, name: "Second Site", alias: "second-site" },
        ],
      },
    });
    expect(response.status).toBe(200);
    const body = response.body as SharePointSitesBulkResult;
    expect(body.total).toBe(2);
    expect(body.results).toHaveLength(2);
    expect(body.results[0]?.status).toBe("created");
    expect(body.results[1]?.status).toBe("failed");
    expect(body.failed).toBe(1);
    expect(provider.bulkCalls).toHaveLength(1);
  });

  it("rejects an empty bulk CSV before dispatch", async () => {
    const provider = new FakeSharePointSitesCreateProvider();
    const caller: SharePointSitesCreateCaller = {
      tenantScope: tenantScope([TENANT]),
      permissions: [SHAREPOINT_WRITE_PERMISSION],
    };
    await expect(
      postRoute(provider, caller).handler({
        method: "POST",
        path: `/v1/tenants/${TENANT}/sharepoint/sites`,
        params: { tenantId: TENANT },
        query: new URLSearchParams(),
        headers: {},
        body: { csv: "   " },
      }),
    ).rejects.toMatchObject({ status: 400 });
    expect(provider.bulkCalls).toHaveLength(0);
  });

  it("forwards a bulk CSV to the provider for schema validation", async () => {
    const provider = new FakeSharePointSitesCreateProvider();
    const caller: SharePointSitesCreateCaller = {
      tenantScope: tenantScope([TENANT]),
      permissions: [SHAREPOINT_WRITE_PERMISSION],
    };
    const csv = "name,alias,type,owners,template,sharing\nAlpha Site,alpha-site,team,owner@example.invalid,,disabled";
    const response = await postRoute(provider, caller).handler({
      method: "POST",
      path: `/v1/tenants/${TENANT}/sharepoint/sites`,
      params: { tenantId: TENANT },
      query: new URLSearchParams(),
      headers: {},
      body: { csv },
    });
    expect(response.status).toBe(200);
    expect(provider.bulkCalls[0]?.csv).toBe(csv);
  });
});
