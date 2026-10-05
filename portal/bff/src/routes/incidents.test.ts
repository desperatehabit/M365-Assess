import { describe, expect, it } from "vitest";
import { AppError } from "../errors.js";
import { tenantScope } from "../rbac/scope.js";
import {
  INCIDENTS_ALL_PATH,
  INCIDENTS_OPENAPI,
  INCIDENTS_PATH,
  INCIDENTS_READ_PERMISSION,
  createIncidentsRoutes,
  parseIncidentsFilter,
  type IncidentItem,
  type IncidentsAggregate,
  type IncidentsCaller,
  type IncidentsFilter,
  type IncidentsPage,
  type IncidentsProvider,
} from "./incidents.js";

const TENANT = "tenant-test";
const OTHER_TENANT = "tenant-other";
const OUT_OF_SCOPE = "tenant-outsider";

function incident(overrides: Partial<IncidentItem> & { id: string }): IncidentItem {
  return {
    title: `Incident ${overrides.id}`,
    severity: "high",
    status: "active",
    classification: "truePositive",
    assignedTo: "",
    alertCount: 1,
    lastUpdated: "2026-09-20T12:00:00.000Z",
    tenantId: TENANT,
    ...overrides,
  };
}

class FakeIncidentsProvider implements IncidentsProvider {
  readonly calls: Array<{ tenantId: string; filter: IncidentsFilter }> = [];
  constructor(private readonly byTenant: Record<string, IncidentItem[]>) {}

  async listIncidents(tenantId: string, filter: IncidentsFilter): Promise<IncidentsPage> {
    this.calls.push({ tenantId, filter });
    let items = [...(this.byTenant[tenantId] ?? [])];
    if (filter.severity !== undefined) {
      items = items.filter((item) => item.severity === filter.severity);
    }
    if (filter.status !== undefined) {
      items = items.filter((item) => item.status === filter.status);
    }
    return {
      tenantId,
      totalCount: items.length,
      items,
      nextCursor: null,
    };
  }
}

function routes(
  provider: IncidentsProvider,
  caller: IncidentsCaller | undefined | (() => IncidentsCaller | undefined),
) {
  const resolveCaller = typeof caller === "function" ? caller : () => caller;
  return createIncidentsRoutes({ provider, resolveCaller });
}

function findRoute(
  all: ReturnType<typeof createIncidentsRoutes>,
  path: string,
) {
  const found = all.find((candidate) => candidate.method === "GET" && candidate.path === path);
  if (!found) throw new Error(`route GET ${path} not found`);
  return found;
}

describe("Incident list routes (T-0543)", () => {
  it("exposes GET /v1/tenants/:tenantId/incidents and GET /v1/incidents", () => {
    const all = routes(
      new FakeIncidentsProvider({}),
      { tenantScope: tenantScope([TENANT]), permissions: [INCIDENTS_READ_PERMISSION] },
    );
    expect(all).toHaveLength(2);
    expect(findRoute(all, INCIDENTS_PATH).path).toBe("/v1/tenants/:tenantId/incidents");
    expect(findRoute(all, INCIDENTS_ALL_PATH).path).toBe("/v1/incidents");
  });

  it("rejects unauthenticated requests with 401", async () => {
    const all = routes(new FakeIncidentsProvider({}), () => undefined);
    await expect(
      findRoute(all, INCIDENTS_PATH).handler({
        method: "GET",
        path: `/v1/tenants/${TENANT}/incidents`,
        params: { tenantId: TENANT },
        query: new URLSearchParams(),
        headers: {},
      }),
    ).rejects.toMatchObject({ status: 401 });
  });

  it("rejects tenants outside caller scope with 403", async () => {
    const provider = new FakeIncidentsProvider({});
    const all = routes(provider, {
      tenantScope: tenantScope(["different-tenant"]),
      permissions: [INCIDENTS_READ_PERMISSION],
    });
    await expect(
      findRoute(all, INCIDENTS_PATH).handler({
        method: "GET",
        path: `/v1/tenants/${TENANT}/incidents`,
        params: { tenantId: TENANT },
        query: new URLSearchParams(),
        headers: {},
      }),
    ).rejects.toMatchObject({ status: 403 });
    expect(provider.calls).toHaveLength(0);
  });

  it("rejects callers missing Security.Incident.Read with 403 and performs no provider call", async () => {
    const provider = new FakeIncidentsProvider({});
    const all = routes(provider, {
      tenantScope: tenantScope([TENANT]),
      permissions: ["Identity.User.Read"],
    });
    await expect(
      findRoute(all, INCIDENTS_PATH).handler({
        method: "GET",
        path: `/v1/tenants/${TENANT}/incidents`,
        params: { tenantId: TENANT },
        query: new URLSearchParams(),
        headers: {},
      }),
    ).rejects.toMatchObject({ status: 403 });
    expect(provider.calls).toHaveLength(0);
  });

  it("returns the §3.1 columns, filtered and paginated", async () => {
    const provider = new FakeIncidentsProvider({
      [TENANT]: [
        incident({ id: "inc-1", severity: "high", status: "active" }),
        incident({ id: "inc-2", severity: "medium", status: "resolved" }),
      ],
    });
    const caller: IncidentsCaller = {
      tenantScope: tenantScope([TENANT]),
      permissions: [INCIDENTS_READ_PERMISSION],
    };
    const all = routes(provider, caller);
    const response = await findRoute(all, INCIDENTS_PATH).handler({
      method: "GET",
      path: `/v1/tenants/${TENANT}/incidents`,
      params: { tenantId: TENANT },
      query: new URLSearchParams("severity=high&limit=1"),
      headers: {},
    });

    expect(response.status).toBe(200);
    const body = response.body as IncidentsPage;
    expect(body.tenantId).toBe(TENANT);
    expect(body.items).toHaveLength(1);
    const item = body.items[0];
    expect(item).toMatchObject({
      id: "inc-1",
      title: "Incident inc-1",
      severity: "high",
      status: "active",
      classification: "truePositive",
      alertCount: 1,
      tenantId: TENANT,
    });
    expect(item?.assignedTo).toBeDefined();
    expect(item?.lastUpdated).toBeDefined();
    expect(provider.calls).toHaveLength(1);
    expect(provider.calls[0]?.filter.severity).toBe("high");
    expect(provider.calls[0]?.filter.limit).toBe(1);
  });

  it("validates severity and date filter parameters", () => {
    expect(() => parseIncidentsFilter(new URLSearchParams("severity=critical"))).toThrow(
      AppError,
    );
    expect(() => parseIncidentsFilter(new URLSearchParams("from=not-a-date"))).toThrow(
      AppError,
    );
  });

  it("aggregates open incidents by severity only across tenants in caller scope", async () => {
    const provider = new FakeIncidentsProvider({
      [TENANT]: [
        incident({ id: "a-1", severity: "high", status: "active", tenantId: TENANT }),
        incident({ id: "a-2", severity: "low", status: "resolved", tenantId: TENANT }),
      ],
      [OTHER_TENANT]: [
        incident({ id: "b-1", severity: "high", status: "active", tenantId: OTHER_TENANT }),
      ],
      [OUT_OF_SCOPE]: [
        incident({ id: "c-1", severity: "high", status: "active", tenantId: OUT_OF_SCOPE }),
      ],
    });
    const caller: IncidentsCaller = {
      tenantScope: tenantScope([TENANT, OTHER_TENANT]),
      permissions: [INCIDENTS_READ_PERMISSION],
    };
    const all = routes(provider, caller);
    const response = await findRoute(all, INCIDENTS_ALL_PATH).handler({
      method: "GET",
      path: "/v1/incidents",
      params: {},
      query: new URLSearchParams(`tenants=${TENANT},${OTHER_TENANT},${OUT_OF_SCOPE}`),
      headers: {},
    });

    expect(response.status).toBe(200);
    const body = response.body as IncidentsAggregate;
    expect([...body.tenants].sort()).toEqual([OTHER_TENANT, TENANT].sort());
    expect(body.totalOpen).toBe(2);
    expect(body.bySeverity).toMatchObject({ high: 2 });
    expect(body.bySeverity["low"]).toBeUndefined();
    expect(body.items.map((item) => item.id).sort()).toEqual(["a-1", "b-1"]);
    const calledTenants = provider.calls.map((call) => call.tenantId);
    expect(calledTenants).not.toContain(OUT_OF_SCOPE);
  });

  it("refuses the aggregate view without Security.Incident.Read and calls no provider", async () => {
    const provider = new FakeIncidentsProvider({ [TENANT]: [incident({ id: "a-1" })] });
    const all = routes(provider, {
      tenantScope: tenantScope([TENANT]),
      permissions: [],
    });
    await expect(
      findRoute(all, INCIDENTS_ALL_PATH).handler({
        method: "GET",
        path: "/v1/incidents",
        params: {},
        query: new URLSearchParams(`tenants=${TENANT}`),
        headers: {},
      }),
    ).rejects.toMatchObject({ status: 403 });
    expect(provider.calls).toHaveLength(0);
  });

  it("publishes the Security.Incident.Read permission through the route module", () => {
    const entry = INCIDENTS_OPENAPI.paths["/tenants/{tenantId}/incidents"];
    expect(entry.get.permission).toBe("Security.Incident.Read");
    expect(entry.get.operationId).toBe("listIncidents");
    expect(INCIDENTS_READ_PERMISSION).toBe("Security.Incident.Read");
  });
});
