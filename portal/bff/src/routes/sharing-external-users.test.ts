import { describe, expect, it } from "vitest";
import { tenantScope } from "../rbac/scope.js";
import {
  EXTERNAL_USER_ACCESS_PATH,
  EXTERNAL_USERS_PATH,
  SHARING_EXTERNAL_USERS_OPENAPI,
  SHARING_READ_PERMISSION,
  createExternalUsersRoutes,
  parseExternalUsersFilter,
  type ExternalUserAccessItem,
  type ExternalUserAccessPage,
  type ExternalUserItem,
  type ExternalUsersCaller,
  type ExternalUsersFilter,
  type ExternalUsersPage,
  type ExternalUsersProvider,
} from "./sharing-external-users.js";

const TENANT = "tenant-test";
const EXTERNAL = "jane@partner.invalid";

const EXTERNAL_USER: ExternalUserItem = {
  externalUserId: EXTERNAL,
  externalUser: "Jane External",
  email: EXTERNAL,
  sites: ["Team Alpha"],
  siteCount: 1,
  accessCount: 2,
  lastAccess: "2026-09-20T00:00:00Z",
  invitedBy: "Owner One",
};

const SAM_USER: ExternalUserItem = {
  externalUserId: "sam@fabrikam.invalid",
  externalUser: "Sam Partner",
  email: "sam@fabrikam.invalid",
  sites: ["Comm Beta"],
  siteCount: 1,
  accessCount: 1,
  lastAccess: null,
  invitedBy: "Owner Two",
};

const ACCESS_ENTRIES: readonly ExternalUserAccessItem[] = [
  {
    siteId: "site-1",
    siteName: "Team Alpha",
    siteUrl: "https://contoso.sharepoint.com/sites/alpha",
    itemId: null,
    itemName: null,
    roles: ["write"],
    linkType: null,
    invitedBy: "Owner One",
    invitedAt: "2026-03-01T00:00:00Z",
    lastAccess: "2026-09-20T00:00:00Z",
  },
  {
    siteId: "site-1",
    siteName: "Team Alpha",
    siteUrl: "https://contoso.sharepoint.com/sites/alpha",
    itemId: "item-9",
    itemName: "Plan.docx",
    roles: ["read"],
    linkType: "organization",
    invitedBy: "Owner One",
    invitedAt: "2026-04-02T00:00:00Z",
    lastAccess: "2026-09-20T00:00:00Z",
  },
];

class FakeExternalUsersProvider implements ExternalUsersProvider {
  readonly listCalls: Array<{ tenantId: string; filter: ExternalUsersFilter }> = [];
  readonly accessCalls: Array<{
    tenantId: string;
    externalUserId: string;
    pagination: { cursor: string | null; limit: number };
  }> = [];

  async listExternalUsers(tenantId: string, filter: ExternalUsersFilter): Promise<ExternalUsersPage> {
    this.listCalls.push({ tenantId, filter });
    return {
      tenantId,
      totalCount: 2,
      items: [EXTERNAL_USER, SAM_USER],
      nextCursor: null,
    };
  }

  async listExternalUserAccess(
    tenantId: string,
    externalUserId: string,
    pagination: { cursor: string | null; limit: number },
  ): Promise<ExternalUserAccessPage> {
    this.accessCalls.push({ tenantId, externalUserId, pagination });
    return {
      tenantId,
      externalUserId,
      totalCount: ACCESS_ENTRIES.length,
      items: [...ACCESS_ENTRIES],
      nextCursor: null,
    };
  }
}

function readerCaller(): ExternalUsersCaller {
  return {
    tenantScope: tenantScope([TENANT]),
    permissions: [SHARING_READ_PERMISSION],
  };
}

function requestContext(path: string, params: Record<string, string>, query = new URLSearchParams()) {
  return { method: "GET", path, params, query, headers: {} };
}

describe("SharePoint external users routes (T-0525)", () => {
  it("exposes GET list and GET access routes", () => {
    const routes = createExternalUsersRoutes({
      provider: new FakeExternalUsersProvider(),
      resolveCaller: readerCaller,
    });
    expect(routes.map((route) => `${route.method} ${route.path}`)).toEqual([
      `GET ${EXTERNAL_USERS_PATH}`,
      `GET ${EXTERNAL_USER_ACCESS_PATH}`,
    ]);
  });

  it("returns the §3.3 columns and passes the filter to the provider", async () => {
    const provider = new FakeExternalUsersProvider();
    const routes = createExternalUsersRoutes({ provider, resolveCaller: readerCaller });

    const response = await routes[0]!.handler(
      requestContext(`/v1/tenants/${TENANT}/sharing/external-users`, { tenantId: TENANT }, new URLSearchParams("search=jane&limit=25")),
    );

    expect(response.status).toBe(200);
    const body = response.body as ExternalUsersPage;
    expect(body.tenantId).toBe(TENANT);
    expect(body.items).toHaveLength(2);
    expect(body.items[0]).toMatchObject({
      externalUser: "Jane External",
      email: EXTERNAL,
      sites: ["Team Alpha"],
      siteCount: 1,
      lastAccess: "2026-09-20T00:00:00Z",
      invitedBy: "Owner One",
    });
    expect(provider.listCalls[0]).toMatchObject({
      tenantId: TENANT,
      filter: { search: "jane", cursor: null, limit: 25 },
    });
  });

  it("pages enumeration with the cursor and returns nextCursor", async () => {
    const provider = new FakeExternalUsersProvider();
    const routes = createExternalUsersRoutes({ provider, resolveCaller: readerCaller });

    const response = await routes[0]!.handler(
      requestContext(
        `/v1/tenants/${TENANT}/sharing/external-users`,
        { tenantId: TENANT },
        new URLSearchParams("cursor=MTAw&limit=1"),
      ),
    );

    expect(response.status).toBe(200);
    expect(provider.listCalls[0]?.filter).toMatchObject({ cursor: "MTAw", limit: 1 });
  });

  it("drills through to the sites/items one external user can access", async () => {
    const provider = new FakeExternalUsersProvider();
    const routes = createExternalUsersRoutes({ provider, resolveCaller: readerCaller });

    const response = await routes[1]!.handler(
      requestContext(
        `/v1/tenants/${TENANT}/sharing/external-users/${encodeURIComponent(EXTERNAL)}/access`,
        { tenantId: TENANT, externalUserId: EXTERNAL },
        new URLSearchParams("limit=50"),
      ),
    );

    expect(response.status).toBe(200);
    const body = response.body as ExternalUserAccessPage;
    expect(body.externalUserId).toBe(EXTERNAL);
    expect(body.items).toHaveLength(2);
    expect(body.items[0]).toMatchObject({ siteName: "Team Alpha", roles: ["write"] });
    expect(body.items[1]).toMatchObject({ itemName: "Plan.docx", linkType: "organization" });
    expect(provider.accessCalls[0]).toMatchObject({
      tenantId: TENANT,
      externalUserId: EXTERNAL,
      pagination: { cursor: null, limit: 50 },
    });
  });

  it("rejects unauthenticated requests with 401", async () => {
    const routes = createExternalUsersRoutes({
      provider: new FakeExternalUsersProvider(),
      resolveCaller: () => undefined,
    });

    await expect(
      routes[0]!.handler(requestContext(`/v1/tenants/${TENANT}/sharing/external-users`, { tenantId: TENANT })),
    ).rejects.toMatchObject({ status: 401 });
    await expect(
      routes[1]!.handler(
        requestContext(
          `/v1/tenants/${TENANT}/sharing/external-users/${EXTERNAL}/access`,
          { tenantId: TENANT, externalUserId: EXTERNAL },
        ),
      ),
    ).rejects.toMatchObject({ status: 401 });
  });

  it("rejects a tenant outside caller scope with 403", async () => {
    const routes = createExternalUsersRoutes({
      provider: new FakeExternalUsersProvider(),
      resolveCaller: () => ({
        tenantScope: tenantScope(["different-tenant"]),
        permissions: [SHARING_READ_PERMISSION],
      }),
    });

    await expect(
      routes[0]!.handler(requestContext(`/v1/tenants/${TENANT}/sharing/external-users`, { tenantId: TENANT })),
    ).rejects.toMatchObject({ status: 403 });
  });

  it("rejects callers missing sharing.read with 403", async () => {
    const routes = createExternalUsersRoutes({
      provider: new FakeExternalUsersProvider(),
      resolveCaller: () => ({
        tenantScope: tenantScope([TENANT]),
        permissions: ["Identity.Group.Read"],
      }),
    });

    await expect(
      routes[0]!.handler(requestContext(`/v1/tenants/${TENANT}/sharing/external-users`, { tenantId: TENANT })),
    ).rejects.toMatchObject({ status: 403 });
  });

  it("rejects a drill-through without an external user id with 400", async () => {
    const routes = createExternalUsersRoutes({
      provider: new FakeExternalUsersProvider(),
      resolveCaller: readerCaller,
    });

    await expect(
      routes[1]!.handler(
        requestContext(`/v1/tenants/${TENANT}/sharing/external-users//access`, {
          tenantId: TENANT,
          externalUserId: "",
        }),
      ),
    ).rejects.toMatchObject({ status: 400 });
  });

  it("publishes both path items with the sharing.read permission", () => {
    const list = SHARING_EXTERNAL_USERS_OPENAPI.paths["/tenants/{tenantId}/sharing/external-users"].get;
    const access =
      SHARING_EXTERNAL_USERS_OPENAPI.paths[
        "/tenants/{tenantId}/sharing/external-users/{externalUserId}/access"
      ].get;
    expect(list.permission).toBe("sharing.read");
    expect(access.permission).toBe("sharing.read");
    expect(list.operationId).not.toBe(access.operationId);
  });
});

describe("External users filter (T-0525)", () => {
  it("parses search and pagination", () => {
    const filter = parseExternalUsersFilter(new URLSearchParams("search=jane&cursor=MTAw&limit=25"));
    expect(filter).toEqual({ search: "jane", cursor: "MTAw", limit: 25 });
  });

  it("defaults to no search and the default page limit", () => {
    expect(parseExternalUsersFilter(new URLSearchParams())).toEqual({
      search: undefined,
      cursor: null,
      limit: 100,
    });
  });
});
