import { describe, expect, it } from "vitest";
import { tenantScope } from "../rbac/scope.js";
import {
  SHAREPOINT_BROWSE_PATH,
  SHAREPOINT_READ_PERMISSION,
  createSharePointBrowseRoute,
  type SharePointBrowseCaller,
  type SharePointBrowseProvider,
  type SharePointSiteBrowser,
} from "./sharepoint-browse.js";

const TENANT = "tenant-browse-test";
const SITE_ID = "contoso.sharepoint.com,11111111-1111-1111-1111-111111111111,22222222-2222-2222-2222-222222222222";

function makeBrowser(overrides: Partial<SharePointSiteBrowser> = {}): SharePointSiteBrowser {
  return {
    tenantId: TENANT,
    siteId: SITE_ID,
    siteUrl: "https://contoso.sharepoint.com/sites/alpha",
    adminCenterUrl:
      "https://admin.microsoft.com/sharepoint?page=siteDetails&modern=true&siteId=11111111-1111-1111-1111-111111111111",
    libraries: [
      {
        id: "drive-documents",
        name: "Documents",
        webUrl: "https://contoso.sharepoint.com/sites/alpha/Shared%20Documents",
        driveType: "documentLibrary",
        quotaUsedBytes: 5368709120,
        quotaTotalBytes: 10737418240,
      },
    ],
    items: [
      {
        id: "item-1",
        name: "Report.docx",
        webUrl: "https://contoso.sharepoint.com/sites/alpha/Shared%20Documents/Report.docx",
        libraryId: "drive-documents",
        libraryName: "Documents",
        isFolder: false,
        sizeBytes: 204800,
        lastModifiedDateTime: "2026-09-01T00:00:00Z",
      },
    ],
    permissions: [
      {
        id: "perm-1",
        roles: ["write"],
        principalType: "siteUser",
        displayName: "Internal User",
        email: "internal@example.invalid",
        loginName: "internal@example.invalid",
        userType: "Member",
        external: false,
        linkType: "",
      },
      {
        id: "perm-2",
        roles: ["read"],
        principalType: "siteUser",
        displayName: "External Guest",
        email: "guest@example.invalid",
        loginName: "guest_example.invalid#ext#@contoso.onmicrosoft.com",
        userType: "Guest",
        external: true,
        linkType: "",
      },
    ],
    externalUsers: [
      {
        displayName: "External Guest",
        email: "guest@example.invalid",
        loginName: "guest_example.invalid#ext#@contoso.onmicrosoft.com",
        principalType: "siteUser",
        permissionId: "perm-2",
        roles: ["read"],
      },
    ],
    handoff: {
      permissionEdits: false,
      sharingPermissionsPath: `/v1/tenants/${TENANT}/sharing/permissions`,
      externalUsersPath: `/v1/tenants/${TENANT}/sharing/external-users`,
      sharingLinksRemovePath: `/v1/tenants/${TENANT}/sharing/links/remove`,
    },
    ...overrides,
  };
}

class FakeSharePointBrowseProvider implements SharePointBrowseProvider {
  readonly calls: Array<{ tenantId: string; siteId: string }> = [];

  constructor(private readonly browser: SharePointSiteBrowser = makeBrowser()) {}

  async browseSite(tenantId: string, siteId: string): Promise<SharePointSiteBrowser> {
    this.calls.push({ tenantId, siteId });
    return this.browser;
  }
}

function browseCall(
  provider: FakeSharePointBrowseProvider,
  caller: SharePointBrowseCaller | undefined,
): Promise<{ status: number; body?: unknown }> {
  const route = createSharePointBrowseRoute({
    provider,
    resolveCaller: () => caller,
  });
  return route.handler({
    method: "GET",
    path: `/v1/tenants/${TENANT}/sharepoint/sites/${SITE_ID}/browse`,
    params: { tenantId: TENANT, siteId: SITE_ID },
    query: new URLSearchParams(),
    headers: {},
  });
}

describe("SharePoint site browser route (T-0488)", () => {
  it("exposes GET /v1/tenants/:tenantId/sharepoint/sites/:siteId/browse", () => {
    const route = createSharePointBrowseRoute({
      provider: new FakeSharePointBrowseProvider(),
      resolveCaller: () => undefined,
    });
    expect(route.method).toBe("GET");
    expect(route.path).toBe(SHAREPOINT_BROWSE_PATH);
  });

  it("rejects unauthenticated requests with 401", async () => {
    const provider = new FakeSharePointBrowseProvider();
    await expect(browseCall(provider, undefined)).rejects.toMatchObject({ status: 401 });
    expect(provider.calls).toHaveLength(0);
  });

  it("rejects a tenant outside caller scope with 403", async () => {
    const provider = new FakeSharePointBrowseProvider();
    const caller: SharePointBrowseCaller = {
      tenantScope: tenantScope(["different-tenant"]),
      permissions: [SHAREPOINT_READ_PERMISSION],
    };
    await expect(browseCall(provider, caller)).rejects.toMatchObject({ status: 403 });
    expect(provider.calls).toHaveLength(0);
  });

  it("rejects a caller without sharepoint.read with 403", async () => {
    const provider = new FakeSharePointBrowseProvider();
    const caller: SharePointBrowseCaller = {
      tenantScope: tenantScope([TENANT]),
      permissions: ["Identity.Group.Read"],
    };
    await expect(browseCall(provider, caller)).rejects.toMatchObject({ status: 403 });
    expect(provider.calls).toHaveLength(0);
  });

  it("lists libraries, permissions, and external users with the admin-center deep link", async () => {
    const provider = new FakeSharePointBrowseProvider();
    const caller: SharePointBrowseCaller = {
      tenantScope: tenantScope([TENANT]),
      permissions: [SHAREPOINT_READ_PERMISSION],
    };

    const response = await browseCall(provider, caller);

    expect(response.status).toBe(200);
    const body = response.body as SharePointSiteBrowser;
    expect(body.tenantId).toBe(TENANT);
    expect(body.siteId).toBe(SITE_ID);
    expect(body.libraries).toHaveLength(1);
    expect(body.libraries[0]?.name).toBe("Documents");
    expect(body.permissions).toHaveLength(2);
    expect(body.permissions[1]?.external).toBe(true);
    expect(body.externalUsers).toHaveLength(1);
    expect(body.externalUsers[0]?.email).toBe("guest@example.invalid");
    expect(body.adminCenterUrl).toContain("admin.microsoft.com/sharepoint");
    expect(body.adminCenterUrl).toContain("11111111-1111-1111-1111-111111111111");
    expect(body.handoff.permissionEdits).toBe(false);
    expect(body.handoff.sharingPermissionsPath).toBe(
      `/v1/tenants/${TENANT}/sharing/permissions`,
    );

    expect(provider.calls).toEqual([{ tenantId: TENANT, siteId: SITE_ID }]);
  });

  it("returns 400 when the siteId path parameter is missing", async () => {
    const provider = new FakeSharePointBrowseProvider();
    const route = createSharePointBrowseRoute({
      provider,
      resolveCaller: () => ({
        tenantScope: tenantScope([TENANT]),
        permissions: [SHAREPOINT_READ_PERMISSION],
      }),
    });
    await expect(
      route.handler({
        method: "GET",
        path: `/v1/tenants/${TENANT}/sharepoint/sites//browse`,
        params: { tenantId: TENANT },
        query: new URLSearchParams(),
        headers: {},
      }),
    ).rejects.toMatchObject({ status: 400 });
    expect(provider.calls).toHaveLength(0);
  });
});
