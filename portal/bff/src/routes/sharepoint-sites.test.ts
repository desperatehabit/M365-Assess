import { describe, expect, it } from "vitest";
import { AppError } from "../errors.js";
import { tenantScope } from "../rbac/scope.js";
import {
  SHAREPOINT_SITES_PATH,
  SHAREPOINT_SITES_READ_PERMISSION,
  createSharePointSitesRoute,
  parseSharePointSitesFilter,
  type SharePointSiteItem,
  type SharePointSitesCaller,
  type SharePointSitesFilter,
  type SharePointSitesPage,
  type SharePointSitesProvider,
} from "./sharepoint-sites.js";

const TENANT = "tenant-test";

const TEAM_SITE: SharePointSiteItem = {
  id: "site-1",
  name: "Team Alpha",
  url: "https://contoso.sharepoint.com/sites/alpha",
  type: "team",
  owners: ["owner1@example.invalid"],
  storageUsedMB: 5120,
  storageAllocatedMB: 10240,
  storageUsedPercent: 50,
  lastActivity: "2026-09-01T00:00:00Z",
  sensitivity: "General",
  sharing: "externalUserSharingOnly",
};

const COMMUNICATION_SITE: SharePointSiteItem = {
  id: "site-2",
  name: "Comm Beta",
  url: "https://contoso.sharepoint.com/sites/beta",
  type: "communication",
  owners: [],
  storageUsedMB: 1024,
  storageAllocatedMB: 10240,
  storageUsedPercent: 10,
  lastActivity: "2026-08-01T00:00:00Z",
  sensitivity: "",
  sharing: "disabled",
};

class FakeSharePointSitesProvider implements SharePointSitesProvider {
  readonly calls: Array<{ tenantId: string; filter: SharePointSitesFilter }> = [];

  async listSites(tenantId: string, filter: SharePointSitesFilter): Promise<SharePointSitesPage> {
    this.calls.push({ tenantId, filter });
    return {
      tenantId,
      totalCount: 2,
      items: [TEAM_SITE, COMMUNICATION_SITE],
      nextCursor: null,
    };
  }
}

describe("SharePoint sites list route (T-0482)", () => {
  it("exposes GET /v1/tenants/:tenantId/sharepoint/sites", () => {
    const provider = new FakeSharePointSitesProvider();
    const route = createSharePointSitesRoute({
      provider,
      resolveCaller: () => ({
        tenantScope: tenantScope([TENANT]),
        permissions: [SHAREPOINT_SITES_READ_PERMISSION],
      }),
    });
    expect(route.method).toBe("GET");
    expect(route.path).toBe(SHAREPOINT_SITES_PATH);
  });

  it("rejects unauthenticated requests with 401", async () => {
    const provider = new FakeSharePointSitesProvider();
    const route = createSharePointSitesRoute({
      provider,
      resolveCaller: () => undefined,
    });

    await expect(
      route.handler({
        method: "GET",
        path: `/v1/tenants/${TENANT}/sharepoint/sites`,
        params: { tenantId: TENANT },
        query: new URLSearchParams(),
        headers: {},
      }),
    ).rejects.toMatchObject({ status: 401 });
  });

  it("rejects tenant outside caller scope with 403", async () => {
    const provider = new FakeSharePointSitesProvider();
    const route = createSharePointSitesRoute({
      provider,
      resolveCaller: () => ({
        tenantScope: tenantScope(["different-tenant"]),
        permissions: [SHAREPOINT_SITES_READ_PERMISSION],
      }),
    });

    await expect(
      route.handler({
        method: "GET",
        path: `/v1/tenants/${TENANT}/sharepoint/sites`,
        params: { tenantId: TENANT },
        query: new URLSearchParams(),
        headers: {},
      }),
    ).rejects.toMatchObject({ status: 403 });
  });

  it("rejects callers missing SharePoint.Site.Read with 403", async () => {
    const provider = new FakeSharePointSitesProvider();
    const route = createSharePointSitesRoute({
      provider,
      resolveCaller: () => ({
        tenantScope: tenantScope([TENANT]),
        permissions: ["Identity.Group.Read"],
      }),
    });

    await expect(
      route.handler({
        method: "GET",
        path: `/v1/tenants/${TENANT}/sharepoint/sites`,
        params: { tenantId: TENANT },
        query: new URLSearchParams(),
        headers: {},
      }),
    ).rejects.toMatchObject({ status: 403 });
  });

  it("returns the site list with the §3.1 columns and the filter passed to the provider", async () => {
    const provider = new FakeSharePointSitesProvider();
    const caller: SharePointSitesCaller = {
      tenantScope: tenantScope([TENANT]),
      permissions: [SHAREPOINT_SITES_READ_PERMISSION],
    };
    const route = createSharePointSitesRoute({
      provider,
      resolveCaller: () => caller,
    });

    const response = await route.handler({
      method: "GET",
      path: `/v1/tenants/${TENANT}/sharepoint/sites`,
      params: { tenantId: TENANT },
      query: new URLSearchParams(
        "type=team&sharing=externalUserSharingOnly&storagePercent=25&lastActivity=2026-07-01T00:00:00Z&sensitivity=General",
      ),
      headers: {},
    });

    expect(response.status).toBe(200);
    const body = response.body as SharePointSitesPage;
    expect(body.tenantId).toBe(TENANT);
    expect(body.items).toHaveLength(2);
    expect(body.items[0]?.type).toBe("team");
    expect(body.items[0]?.storageUsedPercent).toBe(50);
    expect(body.items[0]?.sensitivity).toBe("General");
    expect(body.items[0]?.sharing).toBe("externalUserSharingOnly");
    expect(body.items[1]?.type).toBe("communication");
    expect(body.items[1]?.sensitivity).toBe("");

    expect(provider.calls).toHaveLength(1);
    expect(provider.calls[0]?.filter.type).toBe("team");
    expect(provider.calls[0]?.filter.sharing).toBe("externalUserSharingOnly");
    expect(provider.calls[0]?.filter.storagePercent).toBe(25);
    expect(provider.calls[0]?.filter.lastActivity).toBe("2026-07-01T00:00:00Z");
    expect(provider.calls[0]?.filter.sensitivity).toBe("General");
  });

  it("validates enum, range, and date filter parameters", () => {
    expect(() =>
      parseSharePointSitesFilter(new URLSearchParams("type=portal")),
    ).toThrow(AppError);

    expect(() =>
      parseSharePointSitesFilter(new URLSearchParams("sharing=everyone")),
    ).toThrow(AppError);

    expect(() =>
      parseSharePointSitesFilter(new URLSearchParams("storagePercent=150")),
    ).toThrow(AppError);

    expect(() =>
      parseSharePointSitesFilter(new URLSearchParams("storagePercent=half")),
    ).toThrow(AppError);

    expect(() =>
      parseSharePointSitesFilter(new URLSearchParams("lastActivity=not-a-date")),
    ).toThrow(AppError);
  });
});
