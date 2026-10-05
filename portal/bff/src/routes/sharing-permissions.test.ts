import { describe, expect, it } from "vitest";
import { AppError } from "../errors.js";
import { tenantScope } from "../rbac/scope.js";
import {
  SHARING_PERMISSIONS_OPENAPI,
  SHARING_PERMISSIONS_PATH,
  SHARING_READ_PERMISSION,
  createSharingPermissionsRoute,
  parseSharingPermissionsFilter,
  type SharingPermissionItem,
  type SharingPermissionsCaller,
  type SharingPermissionsFilter,
  type SharingPermissionsPage,
  type SharingPermissionsProvider,
} from "./sharing-permissions.js";

const TENANT = "tenant-test";

const OWNER_ROW: SharingPermissionItem = {
  site: "Team Alpha",
  siteId: "site-1",
  principal: "owner@example.invalid",
  principalId: "user-1",
  principalType: "user",
  role: "owner",
  roles: ["owner"],
  inherited: false,
  scope: "site",
};

const INHERITED_GROUP_ROW: SharingPermissionItem = {
  site: "Comm Beta",
  siteId: "site-2",
  principal: "Engineering",
  principalId: "group-1",
  principalType: "group",
  role: "read",
  roles: ["read"],
  inherited: true,
  scope: "site",
};

class FakeSharingPermissionsProvider implements SharingPermissionsProvider {
  readonly calls: Array<{ tenantId: string; filter: SharingPermissionsFilter }> = [];

  async listPermissions(
    tenantId: string,
    filter: SharingPermissionsFilter,
  ): Promise<SharingPermissionsPage> {
    this.calls.push({ tenantId, filter });
    return {
      tenantId,
      totalCount: 2,
      items: [OWNER_ROW, INHERITED_GROUP_ROW],
      nextCursor: null,
    };
  }
}

function sharingReaderCaller(): SharingPermissionsCaller {
  return {
    tenantScope: tenantScope([TENANT]),
    permissions: [SHARING_READ_PERMISSION],
  };
}

describe("Sharing permissions report route (T-0523)", () => {
  it("exposes GET /v1/tenants/:tenantId/sharing/permissions", () => {
    const route = createSharingPermissionsRoute({
      provider: new FakeSharingPermissionsProvider(),
      resolveCaller: sharingReaderCaller,
    });
    expect(route.method).toBe("GET");
    expect(route.path).toBe(SHARING_PERMISSIONS_PATH);
  });

  it("lists the §3.2 columns through the provider seam", async () => {
    const provider = new FakeSharingPermissionsProvider();
    const route = createSharingPermissionsRoute({ provider, resolveCaller: sharingReaderCaller });

    const response = await route.handler({
      method: "GET",
      path: `/v1/tenants/${TENANT}/sharing/permissions`,
      params: { tenantId: TENANT },
      query: new URLSearchParams(),
      headers: {},
    });

    expect(response.status).toBe(200);
    const body = response.body as SharingPermissionsPage;
    expect(body.tenantId).toBe(TENANT);
    expect(body.totalCount).toBe(2);
    expect(body.items).toHaveLength(2);
    expect(body.items[0]).toMatchObject({
      site: "Team Alpha",
      principal: "owner@example.invalid",
      principalType: "user",
      role: "owner",
      inherited: false,
      scope: "site",
    });
    expect(body.items[1]).toMatchObject({
      site: "Comm Beta",
      principalType: "group",
      role: "read",
      inherited: true,
    });
    expect(provider.calls[0]).toMatchObject({ tenantId: TENANT, filter: { cursor: null, limit: 100 } });
  });

  it("passes the role and principal-type filters through to the provider", async () => {
    const provider = new FakeSharingPermissionsProvider();
    const route = createSharingPermissionsRoute({ provider, resolveCaller: sharingReaderCaller });

    const response = await route.handler({
      method: "GET",
      path: `/v1/tenants/${TENANT}/sharing/permissions`,
      params: { tenantId: TENANT },
      query: new URLSearchParams("role=owner&principalType=user&limit=25&cursor=MTAw"),
      headers: {},
    });

    expect(response.status).toBe(200);
    expect(provider.calls).toHaveLength(1);
    expect(provider.calls[0]?.filter).toMatchObject({
      role: "owner",
      principalType: "user",
      cursor: "MTAw",
      limit: 25,
    });
  });

  it("rejects unauthenticated requests with 401", async () => {
    const route = createSharingPermissionsRoute({
      provider: new FakeSharingPermissionsProvider(),
      resolveCaller: () => undefined,
    });

    await expect(
      route.handler({
        method: "GET",
        path: `/v1/tenants/${TENANT}/sharing/permissions`,
        params: { tenantId: TENANT },
        query: new URLSearchParams(),
        headers: {},
      }),
    ).rejects.toMatchObject({ status: 401 });
  });

  it("rejects a tenant outside the caller scope with 403", async () => {
    const route = createSharingPermissionsRoute({
      provider: new FakeSharingPermissionsProvider(),
      resolveCaller: () => ({
        tenantScope: tenantScope(["different-tenant"]),
        permissions: [SHARING_READ_PERMISSION],
      }),
    });

    await expect(
      route.handler({
        method: "GET",
        path: `/v1/tenants/${TENANT}/sharing/permissions`,
        params: { tenantId: TENANT },
        query: new URLSearchParams(),
        headers: {},
      }),
    ).rejects.toMatchObject({ status: 403 });
  });

  it("rejects callers missing Sharing.Permissions.Read with 403", async () => {
    const route = createSharingPermissionsRoute({
      provider: new FakeSharingPermissionsProvider(),
      resolveCaller: () => ({
        tenantScope: tenantScope([TENANT]),
        permissions: ["SharePoint.Site.Read"],
      }),
    });

    await expect(
      route.handler({
        method: "GET",
        path: `/v1/tenants/${TENANT}/sharing/permissions`,
        params: { tenantId: TENANT },
        query: new URLSearchParams(),
        headers: {},
      }),
    ).rejects.toMatchObject({ status: 403 });
  });

  it("rejects an unsupported principal type with 400", async () => {
    const route = createSharingPermissionsRoute({
      provider: new FakeSharingPermissionsProvider(),
      resolveCaller: sharingReaderCaller,
    });

    await expect(
      route.handler({
        method: "GET",
        path: `/v1/tenants/${TENANT}/sharing/permissions`,
        params: { tenantId: TENANT },
        query: new URLSearchParams("principalType=everyone"),
        headers: {},
      }),
    ).rejects.toMatchObject({ status: 400 });
  });

  it("honors the authorizer seam when supplied", async () => {
    const provider = new FakeSharingPermissionsProvider();
    const seen: string[] = [];
    const route = createSharingPermissionsRoute({
      provider,
      resolveCaller: sharingReaderCaller,
      authorize: (_caller, permission) => {
        seen.push(permission);
      },
    });

    await route.handler({
      method: "GET",
      path: `/v1/tenants/${TENANT}/sharing/permissions`,
      params: { tenantId: TENANT },
      query: new URLSearchParams(),
      headers: {},
    });

    expect(seen).toEqual([SHARING_READ_PERMISSION]);
  });
});

describe("Sharing permissions OpenAPI fragment (T-0523)", () => {
  it("publishes the read path item with the Sharing.Permissions.Read permission", () => {
    expect(SHARING_PERMISSIONS_OPENAPI.paths["/tenants/{tenantId}/sharing/permissions"].get.permission).toBe(
      "Sharing.Permissions.Read",
    );
  });

  it("publishes the listSharingPermissions operation", () => {
    expect(
      SHARING_PERMISSIONS_OPENAPI.paths["/tenants/{tenantId}/sharing/permissions"].get.operationId,
    ).toBe("listSharingPermissions");
  });
});

describe("Sharing permissions filter (T-0523)", () => {
  it("parses role, principal type, and pagination", () => {
    const filter = parseSharingPermissionsFilter(
      new URLSearchParams("role=owner&principalType=user&cursor=MTAw&limit=25"),
    );
    expect(filter).toEqual({
      role: "owner",
      principalType: "user",
      cursor: "MTAw",
      limit: 25,
    });
  });

  it("defaults to no filters and the default page limit", () => {
    const filter = parseSharingPermissionsFilter(new URLSearchParams());
    expect(filter).toEqual({
      role: undefined,
      principalType: undefined,
      cursor: null,
      limit: 100,
    });
  });

  it("rejects an unknown principal type", () => {
    expect(() => parseSharingPermissionsFilter(new URLSearchParams("principalType=robot"))).toThrow(AppError);
  });
});
