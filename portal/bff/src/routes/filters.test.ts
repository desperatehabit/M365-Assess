import { describe, expect, it } from "vitest";
import { AppError } from "../errors.js";
import { tenantScope } from "../rbac/scope.js";
import {
  FILTERS_PATH,
  FILTERS_READ_PERMISSION,
  createFilterRoutes,
  parseFilterType,
  type FilterItem,
  type FiltersCaller,
  type FiltersPage,
  type FiltersProvider,
  type FilterType,
} from "./filters.js";

const TENANT = "tenant-test";

const SPAM_ITEM: FilterItem = {
  name: "Default",
  priority: 0,
  state: "Enabled",
  summary: "BulkThreshold=6; SpamAction=MoveToJmf",
  lastModified: "2026-09-20T10:00:00.000Z",
};

class FakeFiltersProvider implements FiltersProvider {
  readonly calls: Array<{ tenantId: string; filterType: FilterType }> = [];

  async getFilters(tenantId: string, filterType: FilterType): Promise<FiltersPage> {
    this.calls.push({ tenantId, filterType });
    return {
      tenantId,
      filterType,
      items: [SPAM_ITEM],
      totalCount: 1,
      retrievedAt: "2026-09-28T00:00:00.000Z",
    };
  }
}

describe("Filter policy routes (T-0421)", () => {
  it("exposes GET /v1/tenants/:tenantId/filters/:filterType", () => {
    const routes = createFilterRoutes({
      provider: new FakeFiltersProvider(),
      resolveCaller: () => ({
        tenantScope: tenantScope([TENANT]),
        permissions: [FILTERS_READ_PERMISSION],
      }),
    });
    expect(routes.map((route) => `${route.method} ${route.path}`)).toEqual([
      `GET ${FILTERS_PATH}`,
    ]);
  });

  it("rejects unauthenticated requests with 401", async () => {
    const routes = createFilterRoutes({
      provider: new FakeFiltersProvider(),
      resolveCaller: () => undefined,
    });

    await expect(
      routes[0].handler({
        method: "GET",
        path: `/v1/tenants/${TENANT}/filters/spam`,
        params: { tenantId: TENANT, filterType: "spam" },
        query: new URLSearchParams(),
        headers: {},
      }),
    ).rejects.toMatchObject({ status: 401 });
  });

  it("rejects tenants outside caller scope with 403", async () => {
    const routes = createFilterRoutes({
      provider: new FakeFiltersProvider(),
      resolveCaller: () => ({
        tenantScope: tenantScope(["different-tenant"]),
        permissions: [FILTERS_READ_PERMISSION],
      }),
    });

    await expect(
      routes[0].handler({
        method: "GET",
        path: `/v1/tenants/${TENANT}/filters/spam`,
        params: { tenantId: TENANT, filterType: "spam" },
        query: new URLSearchParams(),
        headers: {},
      }),
    ).rejects.toMatchObject({ status: 403 });
  });

  it("rejects callers missing Exchange.SpamFilter.Read with 403", async () => {
    const routes = createFilterRoutes({
      provider: new FakeFiltersProvider(),
      resolveCaller: () => ({
        tenantScope: tenantScope([TENANT]),
        permissions: ["Identity.User.Read"],
      }),
    });

    await expect(
      routes[0].handler({
        method: "GET",
        path: `/v1/tenants/${TENANT}/filters/spam`,
        params: { tenantId: TENANT, filterType: "spam" },
        query: new URLSearchParams(),
        headers: {},
      }),
    ).rejects.toMatchObject({ status: 403 });
  });

  it("serves all four §3.1 filter types through the provider with no M365 call of its own", async () => {
    const provider = new FakeFiltersProvider();
    const caller: FiltersCaller = {
      tenantScope: tenantScope([TENANT]),
      permissions: [FILTERS_READ_PERMISSION],
    };
    const routes = createFilterRoutes({ provider, resolveCaller: () => caller });

    for (const filterType of ["spam", "antiphish", "malware", "connection"]) {
      const response = await routes[0].handler({
        method: "GET",
        path: `/v1/tenants/${TENANT}/filters/${filterType}`,
        params: { tenantId: TENANT, filterType },
        query: new URLSearchParams(),
        headers: {},
      });
      expect(response.status).toBe(200);
      const body = response.body as { filterType: string; items: FilterItem[]; retrievedAt: string };
      expect(body.filterType).toBe(filterType);
      expect(body.items).toHaveLength(1);
      expect(body.items[0]).toMatchObject({
        name: "Default",
        priority: 0,
        state: "Enabled",
      });
      expect(typeof body.items[0].summary).toBe("string");
      expect(body.retrievedAt).toBe("2026-09-28T00:00:00.000Z");
    }
    expect(provider.calls).toHaveLength(4);
  });

  it("normalizes the anti-phish alias to antiphish", async () => {
    const provider = new FakeFiltersProvider();
    const caller: FiltersCaller = {
      tenantScope: tenantScope([TENANT]),
      permissions: [FILTERS_READ_PERMISSION],
    };
    const routes = createFilterRoutes({ provider, resolveCaller: () => caller });

    const response = await routes[0].handler({
      method: "GET",
      path: `/v1/tenants/${TENANT}/filters/anti-phish`,
      params: { tenantId: TENANT, filterType: "anti-phish" },
      query: new URLSearchParams(),
      headers: {},
    });
    expect(response.status).toBe(200);
    expect(provider.calls[0].filterType).toBe("antiphish");
    expect(parseFilterType("anti-phish")).toBe("antiphish");
  });

  it("rejects a missing or unknown filter type with 400", async () => {
    const caller: FiltersCaller = {
      tenantScope: tenantScope([TENANT]),
      permissions: [FILTERS_READ_PERMISSION],
    };
    const routes = createFilterRoutes({
      provider: new FakeFiltersProvider(),
      resolveCaller: () => caller,
    });

    await expect(
      routes[0].handler({
        method: "GET",
        path: `/v1/tenants/${TENANT}/filters/quarantine`,
        params: { tenantId: TENANT, filterType: "quarantine" },
        query: new URLSearchParams(),
        headers: {},
      }),
    ).rejects.toMatchObject({ status: 400 });

    await expect(
      routes[0].handler({
        method: "GET",
        path: `/v1/tenants/${TENANT}/filters/`,
        params: { tenantId: TENANT, filterType: "" },
        query: new URLSearchParams(),
        headers: {},
      }),
    ).rejects.toMatchObject({ status: 400 });

    expect(() => parseFilterType("quarantine")).toThrow(AppError);
  });
});
