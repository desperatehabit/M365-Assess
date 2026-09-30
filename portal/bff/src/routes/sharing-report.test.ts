import { describe, expect, it } from "vitest";
import { AppError } from "../errors.js";
import { tenantScope } from "../rbac/scope.js";
import {
  SHARING_REPORT_OPENAPI,
  SHARING_REPORT_PATH,
  SHARING_REPORT_READ_PERMISSION,
  createSharingReportRoute,
  parseSharingReportFilter,
  type SharingReportCaller,
  type SharingReportFilter,
  type SharingReportItem,
  type SharingReportPage,
  type SharingReportProvider,
} from "./sharing-report.js";

const TENANT = "tenant-test";

const ANONYMOUS_LINK: SharingReportItem = {
  siteId: "site-1",
  siteName: "Team Alpha",
  siteUrl: "https://contoso.sharepoint.com/sites/alpha",
  itemId: "item-1",
  itemName: "Budget.xlsx",
  itemUrl: "https://contoso.sharepoint.com/sites/alpha/Budget.xlsx",
  driveId: "drive-1",
  linkId: "perm-anon",
  linkType: "anonymous",
  permissions: "view",
  createdBy: "owner1@example.invalid",
  created: "2026-09-01T00:00:00Z",
  expires: "2026-10-01T00:00:00Z",
};

const ORGANIZATION_LINK: SharingReportItem = {
  siteId: "site-1",
  siteName: "Team Alpha",
  siteUrl: "https://contoso.sharepoint.com/sites/alpha",
  itemId: "item-1",
  itemName: "Budget.xlsx",
  itemUrl: "https://contoso.sharepoint.com/sites/alpha/Budget.xlsx",
  driveId: "drive-1",
  linkId: "perm-org",
  linkType: "organization",
  permissions: "edit",
  createdBy: "owner1@example.invalid",
  created: "2026-08-01T00:00:00Z",
  expires: null,
};

const PEOPLE_LINK: SharingReportItem = {
  siteId: "site-2",
  siteName: "Comm Beta",
  siteUrl: "https://contoso.sharepoint.com/sites/beta",
  itemId: "root",
  itemName: "root",
  itemUrl: "https://contoso.sharepoint.com/sites/beta",
  driveId: "drive-2",
  linkId: "perm-people",
  linkType: "people",
  permissions: "view",
  createdBy: "owner2@example.invalid",
  created: "2026-07-01T00:00:00Z",
  expires: null,
};

class FakeSharingReportProvider implements SharingReportProvider {
  readonly calls: Array<{ tenantId: string; filter: SharingReportFilter }> = [];

  async listLinks(tenantId: string, filter: SharingReportFilter): Promise<SharingReportPage> {
    this.calls.push({ tenantId, filter });
    return {
      tenantId,
      totalCount: 3,
      items: [ANONYMOUS_LINK, ORGANIZATION_LINK, PEOPLE_LINK],
      nextCursor: null,
    };
  }
}

function sharingReaderCaller(): SharingReportCaller {
  return {
    tenantScope: tenantScope([TENANT]),
    permissions: [SHARING_REPORT_READ_PERMISSION],
  };
}

describe("Sharing report route (T-0521)", () => {
  it("exposes GET /v1/tenants/:tenantId/sharing/report", () => {
    const provider = new FakeSharingReportProvider();
    const route = createSharingReportRoute({ provider, resolveCaller: sharingReaderCaller });
    expect(route.method).toBe("GET");
    expect(route.path).toBe(SHARING_REPORT_PATH);
  });

  it("rejects unauthenticated requests with 401", async () => {
    const provider = new FakeSharingReportProvider();
    const route = createSharingReportRoute({ provider, resolveCaller: () => undefined });

    await expect(
      route.handler({
        method: "GET",
        path: `/v1/tenants/${TENANT}/sharing/report`,
        params: { tenantId: TENANT },
        query: new URLSearchParams(),
        headers: {},
      }),
    ).rejects.toMatchObject({ status: 401 });
  });

  it("rejects tenant outside caller scope with 403", async () => {
    const provider = new FakeSharingReportProvider();
    const route = createSharingReportRoute({
      provider,
      resolveCaller: () => ({
        tenantScope: tenantScope(["different-tenant"]),
        permissions: [SHARING_REPORT_READ_PERMISSION],
      }),
    });

    await expect(
      route.handler({
        method: "GET",
        path: `/v1/tenants/${TENANT}/sharing/report`,
        params: { tenantId: TENANT },
        query: new URLSearchParams(),
        headers: {},
      }),
    ).rejects.toMatchObject({ status: 403 });
  });

  it("rejects callers missing sharing.read with 403", async () => {
    const provider = new FakeSharingReportProvider();
    const route = createSharingReportRoute({
      provider,
      resolveCaller: () => ({
        tenantScope: tenantScope([TENANT]),
        permissions: ["sharepoint.read"],
      }),
    });

    await expect(
      route.handler({
        method: "GET",
        path: `/v1/tenants/${TENANT}/sharing/report`,
        params: { tenantId: TENANT },
        query: new URLSearchParams(),
        headers: {},
      }),
    ).rejects.toMatchObject({ status: 403 });
  });

  it("returns the §3.1 columns with the filter passed to the provider", async () => {
    const provider = new FakeSharingReportProvider();
    const route = createSharingReportRoute({ provider, resolveCaller: sharingReaderCaller });

    const response = await route.handler({
      method: "GET",
      path: `/v1/tenants/${TENANT}/sharing/report`,
      params: { tenantId: TENANT },
      query: new URLSearchParams(
        "linkType=organization&permissions=edit&site=alpha&createdAfter=2026-07-01T00:00:00Z",
      ),
      headers: {},
    });

    expect(response.status).toBe(200);
    const body = response.body as SharingReportPage;
    expect(body.tenantId).toBe(TENANT);
    expect(body.items).toHaveLength(3);
    expect(body.items[0]?.linkType).toBe("anonymous");
    expect(body.items[0]?.permissions).toBe("view");
    expect(body.items[0]?.createdBy).toBe("owner1@example.invalid");
    expect(body.items[0]?.created).toBe("2026-09-01T00:00:00Z");
    expect(body.items[0]?.expires).toBe("2026-10-01T00:00:00Z");
    expect(body.items[1]?.permissions).toBe("edit");

    expect(provider.calls).toHaveLength(1);
    expect(provider.calls[0]?.tenantId).toBe(TENANT);
    expect(provider.calls[0]?.filter.linkType).toBe("organization");
    expect(provider.calls[0]?.filter.permissions).toBe("edit");
    expect(provider.calls[0]?.filter.site).toBe("alpha");
    expect(provider.calls[0]?.filter.createdAfter).toBe("2026-07-01T00:00:00Z");
    expect(provider.calls[0]?.filter.anonymousOnly).toBe(false);
  });

  it("pushes the anonymous-only filter to the worker provider", async () => {
    const provider = new FakeSharingReportProvider();
    const route = createSharingReportRoute({ provider, resolveCaller: sharingReaderCaller });

    const response = await route.handler({
      method: "GET",
      path: `/v1/tenants/${TENANT}/sharing/report`,
      params: { tenantId: TENANT },
      query: new URLSearchParams("anonymousOnly=true"),
      headers: {},
    });

    expect(response.status).toBe(200);
    expect(provider.calls[0]?.filter.anonymousOnly).toBe(true);
  });

  it("validates enum, boolean, and date filter parameters", () => {
    expect(() =>
      parseSharingReportFilter(new URLSearchParams("linkType=everyone")),
    ).toThrow(AppError);

    expect(() =>
      parseSharingReportFilter(new URLSearchParams("permissions=full")),
    ).toThrow(AppError);

    expect(() =>
      parseSharingReportFilter(new URLSearchParams("anonymousOnly=maybe")),
    ).toThrow(AppError);

    expect(() =>
      parseSharingReportFilter(new URLSearchParams("createdAfter=not-a-date")),
    ).toThrow(AppError);
  });

  it("publishes the report path item with the sharing.read permission", () => {
    const operation = SHARING_REPORT_OPENAPI.paths["/tenants/{tenantId}/sharing/report"].get;
    expect(operation.operationId).toBe("listSharingReport");
    expect(operation.permission).toBe("sharing.read");
  });
});
