import { describe, expect, it } from "vitest";
import { tenantScope } from "../rbac/scope.js";
import {
  ONEDRIVE_PATH,
  SHAREPOINT_READ_PERMISSION,
  createOneDriveUsageRoutes,
  type OneDriveUsageCaller,
  type OneDriveUsageProvider,
  type OneDriveUsageReport,
  type OneDriveUserUsage,
} from "./onedrive.js";

const TENANT = "tenant-onedrive-test";

function makeUser(id: string, overrides: Partial<OneDriveUserUsage> = {}): OneDriveUserUsage {
  return {
    userId: id,
    displayName: `User ${id}`,
    userPrincipalName: `user${id}@example.invalid`,
    hasOneDrive: true,
    storageUsedBytes: 5368709120,
    storageQuotaBytes: 1099511627776,
    storageUsedPercent: 4.9,
    lastActivityDate: "2026-09-20T00:00:00Z",
    sharing: { total: 2, anonymous: 1, organization: 1, user: 0 },
    sharingLinks: [
      {
        linkId: `link-${id}-1`,
        linkType: "anonymous",
        resourceName: "root",
        driveId: `drive-${id}`,
        itemId: "root",
      },
    ],
    ...overrides,
  };
}

class FakeOneDriveUsageProvider implements OneDriveUsageProvider {
  readonly calls: Array<{ tenantId: string }> = [];

  constructor(private readonly users: readonly OneDriveUserUsage[] = []) {}

  async getUsage(tenantId: string): Promise<OneDriveUsageReport> {
    this.calls.push({ tenantId });
    return {
      tenantId,
      generatedAt: "2026-09-26T12:00:00Z",
      summary: {
        totalUsers: this.users.length,
        usersWithOneDrive: this.users.filter((u) => u.hasOneDrive).length,
        totalStorageUsedBytes: this.users.reduce((sum, u) => sum + (u.storageUsedBytes ?? 0), 0),
        totalStorageQuotaBytes: this.users.reduce((sum, u) => sum + (u.storageQuotaBytes ?? 0), 0),
        usersOverQuotaWarning: this.users.filter((u) => (u.storageUsedPercent ?? 0) >= 90).length,
        totalSharingLinks: this.users.reduce((sum, u) => sum + u.sharing.total, 0),
        anonymousLinks: this.users.reduce((sum, u) => sum + u.sharing.anonymous, 0),
        organizationLinks: this.users.reduce((sum, u) => sum + u.sharing.organization, 0),
        userLinks: this.users.reduce((sum, u) => sum + u.sharing.user, 0),
      },
      users: this.users,
    };
  }
}

describe("OneDrive usage routes (T-0489)", () => {
  const getRoutes = (provider: FakeOneDriveUsageProvider, caller?: OneDriveUsageCaller) => {
    return createOneDriveUsageRoutes({
      provider,
      resolveCaller: () => caller,
    });
  };
  const getRoute = (provider: FakeOneDriveUsageProvider, caller?: OneDriveUsageCaller) =>
    getRoutes(provider, caller).find((r) => r.method === "GET" && r.path === ONEDRIVE_PATH)!;
  const callGet = (
    provider: FakeOneDriveUsageProvider,
    caller?: OneDriveUsageCaller,
    query: URLSearchParams = new URLSearchParams(),
  ) =>
    getRoute(provider, caller).handler({
      method: "GET",
      path: `/v1/tenants/${TENANT}/onedrive`,
      params: { tenantId: TENANT },
      query,
      headers: {},
    });

  it("rejects unauthenticated requests with 401", async () => {
    const provider = new FakeOneDriveUsageProvider();
    await expect(callGet(provider, undefined)).rejects.toMatchObject({ status: 401 });
  });

  it("rejects tenant outside caller scope with 403", async () => {
    const provider = new FakeOneDriveUsageProvider();
    const caller: OneDriveUsageCaller = {
      tenantScope: tenantScope(["other-tenant"]),
      permissions: [SHAREPOINT_READ_PERMISSION],
    };
    await expect(callGet(provider, caller)).rejects.toMatchObject({ status: 403 });
  });

  it("rejects a caller without SharePoint.Site.Read with 403", async () => {
    const provider = new FakeOneDriveUsageProvider();
    const caller: OneDriveUsageCaller = {
      tenantScope: tenantScope([TENANT]),
      permissions: ["Identity.Group.Read"],
    };
    await expect(callGet(provider, caller)).rejects.toMatchObject({ status: 403 });
  });

  it("lists per-user OneDrive usage and sharing state", async () => {
    const provider = new FakeOneDriveUsageProvider([
      makeUser("1"),
      makeUser("2", {
        hasOneDrive: false,
        storageUsedBytes: null,
        storageQuotaBytes: null,
        storageUsedPercent: null,
        lastActivityDate: null,
        sharing: { total: 0, anonymous: 0, organization: 0, user: 0 },
        sharingLinks: [],
      }),
    ]);
    const caller: OneDriveUsageCaller = {
      tenantScope: tenantScope([TENANT]),
      permissions: [SHAREPOINT_READ_PERMISSION],
    };

    const res = await callGet(provider, caller);

    expect(res.status).toBe(200);
    const body = res.body as { items: OneDriveUserUsage[]; nextCursor: string | null };
    expect(body.items).toHaveLength(2);
    expect(body.items[0]?.userId).toBe("1");
    expect(body.items[0]?.storageUsedBytes).toBe(5368709120);
    expect(body.items[0]?.sharing.total).toBe(2);
    expect(body.items[0]?.sharingLinks[0]?.linkType).toBe("anonymous");
    expect(body.items[1]?.hasOneDrive).toBe(false);
    expect(body.nextCursor).toBeNull();
    expect(provider.calls[0]?.tenantId).toBe(TENANT);
  });

  it("cursor-paginates the per-user rows", async () => {
    const provider = new FakeOneDriveUsageProvider([
      makeUser("1"),
      makeUser("2"),
      makeUser("3"),
    ]);
    const caller: OneDriveUsageCaller = {
      tenantScope: tenantScope([TENANT]),
      permissions: [SHAREPOINT_READ_PERMISSION],
    };

    const firstRes = await callGet(provider, caller, new URLSearchParams("limit=2"));
    const first = firstRes.body as { items: OneDriveUserUsage[]; nextCursor: string | null };
    expect(first.items).toHaveLength(2);
    expect(first.items.map((u) => u.userId)).toEqual(["1", "2"]);
    expect(first.nextCursor).not.toBeNull();

    const secondRes = await callGet(
      provider,
      caller,
      new URLSearchParams(`limit=2&cursor=${first.nextCursor}`),
    );
    const second = secondRes.body as { items: OneDriveUserUsage[]; nextCursor: string | null };
    expect(second.items).toHaveLength(1);
    expect(second.items[0]?.userId).toBe("3");
    expect(second.nextCursor).toBeNull();
  });
});
