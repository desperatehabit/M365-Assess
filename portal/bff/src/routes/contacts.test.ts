import { describe, expect, it } from "vitest";
import { tenantScope } from "../rbac/scope.js";
import {
  CONTACTS_PATH,
  CONTACTS_READ_PERMISSION,
  createContactsRoutes,
  parseContactsFilter,
  type ContactItem,
  type ContactsCaller,
  type ContactsFilter,
  type ContactsPage,
  type ContactsProvider,
} from "./contacts.js";

const TENANT = "tenant-test";

const MAIL_CONTACT: ContactItem = {
  id: "contact-1",
  displayName: "Vendor Support",
  externalAddress: "vendor@example.com",
  type: "mailContact",
  hiddenFromGal: false,
  lastModified: "2026-09-20T10:00:00.000Z",
};

const MAIL_USER: ContactItem = {
  id: "contact-2",
  displayName: "External User",
  externalAddress: "external@example.com",
  type: "mailUser",
  hiddenFromGal: true,
  lastModified: "2026-09-21T10:00:00.000Z",
};

class FakeContactsProvider implements ContactsProvider {
  readonly listCalls: Array<{ tenantId: string; filter: ContactsFilter }> = [];

  async listContacts(tenantId: string, filter: ContactsFilter): Promise<ContactsPage> {
    this.listCalls.push({ tenantId, filter });
    return {
      tenantId,
      totalCount: 2,
      items: [MAIL_CONTACT, MAIL_USER],
      nextCursor: null,
    };
  }
}

describe("Contacts list routes (T-0442)", () => {
  it("exposes GET /v1/tenants/:tenantId/contacts", () => {
    const routes = createContactsRoutes({
      provider: new FakeContactsProvider(),
      resolveCaller: () => ({
        tenantScope: tenantScope([TENANT]),
        permissions: [CONTACTS_READ_PERMISSION],
      }),
    });
    expect(routes.map((route) => `${route.method} ${route.path}`)).toEqual([
      `GET ${CONTACTS_PATH}`,
    ]);
  });

  it("rejects unauthenticated requests with 401", async () => {
    const routes = createContactsRoutes({
      provider: new FakeContactsProvider(),
      resolveCaller: () => undefined,
    });

    await expect(
      routes[0]!.handler({
        method: "GET",
        path: `/v1/tenants/${TENANT}/contacts`,
        params: { tenantId: TENANT },
        query: new URLSearchParams(),
        headers: {},
      }),
    ).rejects.toMatchObject({ status: 401 });
  });

  it("rejects tenant outside caller scope with 403", async () => {
    const routes = createContactsRoutes({
      provider: new FakeContactsProvider(),
      resolveCaller: () => ({
        tenantScope: tenantScope(["different-tenant"]),
        permissions: [CONTACTS_READ_PERMISSION],
      }),
    });

    await expect(
      routes[0]!.handler({
        method: "GET",
        path: `/v1/tenants/${TENANT}/contacts`,
        params: { tenantId: TENANT },
        query: new URLSearchParams(),
        headers: {},
      }),
    ).rejects.toMatchObject({ status: 403 });
  });

  it("rejects callers missing contacts.read with 403", async () => {
    const routes = createContactsRoutes({
      provider: new FakeContactsProvider(),
      resolveCaller: () => ({
        tenantScope: tenantScope([TENANT]),
        permissions: ["Identity.User.Read"],
      }),
    });

    await expect(
      routes[0]!.handler({
        method: "GET",
        path: `/v1/tenants/${TENANT}/contacts`,
        params: { tenantId: TENANT },
        query: new URLSearchParams(),
        headers: {},
      }),
    ).rejects.toMatchObject({ status: 403 });
  });

  it("returns filtered, cursor-paginated rows with the §3.1 columns", async () => {
    const provider = new FakeContactsProvider();
    const caller: ContactsCaller = {
      tenantScope: tenantScope([TENANT]),
      permissions: [CONTACTS_READ_PERMISSION],
    };
    const routes = createContactsRoutes({ provider, resolveCaller: () => caller });

    const response = await routes[0]!.handler({
      method: "GET",
      path: `/v1/tenants/${TENANT}/contacts`,
      params: { tenantId: TENANT },
      query: new URLSearchParams("type=mailContact&hidden=false&search=vendor"),
      headers: {},
    });

    expect(response.status).toBe(200);
    const body = response.body as ContactsPage;
    expect(body.tenantId).toBe(TENANT);
    expect(body.items).toHaveLength(2);
    expect(body.items[0]).toMatchObject({
      displayName: "Vendor Support",
      externalAddress: "vendor@example.com",
      type: "mailContact",
      hiddenFromGal: false,
    });
    expect(body.items[1]).toMatchObject({
      displayName: "External User",
      externalAddress: "external@example.com",
      type: "mailUser",
      hiddenFromGal: true,
    });
    expect(provider.listCalls[0]!.filter.type).toBe("mailContact");
    expect(provider.listCalls[0]!.filter.hidden).toBe(false);
    expect(provider.listCalls[0]!.filter.search).toBe("vendor");
  });

  it("parses filter query parameters", () => {
    const filter = parseContactsFilter(
      new URLSearchParams("type=mailUser&hidden=true&search=test&cursor=abc&limit=50"),
    );
    expect(filter.type).toBe("mailUser");
    expect(filter.hidden).toBe(true);
    expect(filter.search).toBe("test");
    expect(filter.cursor).toBe("abc");
    expect(filter.limit).toBe(50);
  });

  it("rejects invalid filter values with 400", () => {
    expect(() => parseContactsFilter(new URLSearchParams("type=invalid"))).toThrow();
    expect(() => parseContactsFilter(new URLSearchParams("hidden=maybe"))).toThrow();
  });
});
