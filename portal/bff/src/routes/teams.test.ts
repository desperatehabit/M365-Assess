import { describe, expect, it } from "vitest";
import { AppError } from "../errors.js";
import { tenantScope } from "../rbac/scope.js";
import {
  TEAMS_OPENAPI,
  TEAMS_PATH,
  TEAMS_READ_PERMISSION,
  createTeamsListRoute,
  parseTeamsFilter,
  type TeamItem,
  type TeamsCaller,
  type TeamsFilter,
  type TeamsPage,
  type TeamsProvider,
} from "./teams.js";

const TENANT = "tenant-test";

function team(overrides: Partial<TeamItem> & { id: string }): TeamItem {
  return {
    name: `Team ${overrides.id}`,
    ownerCount: 2,
    memberCount: 25,
    visibility: "private",
    isArchived: false,
    createdDateTime: "2026-01-15T10:00:00.000Z",
    sensitivityLabel: "",
    ...overrides,
  };
}

class FakeTeamsProvider implements TeamsProvider {
  readonly calls: Array<{ tenantId: string; filter: TeamsFilter }> = [];

  async listTeams(tenantId: string, filter: TeamsFilter): Promise<TeamsPage> {
    this.calls.push({ tenantId, filter });
    return {
      tenantId,
      totalCount: 1,
      items: [team({ id: "team-1" })],
      nextCursor: null,
    };
  }
}

describe("Teams list route (T-0502)", () => {
  it("exposes GET /v1/tenants/:tenantId/teams", () => {
    const route = createTeamsListRoute({
      provider: new FakeTeamsProvider(),
      resolveCaller: () => ({
        tenantScope: tenantScope([TENANT]),
        permissions: [TEAMS_READ_PERMISSION],
      }),
    });
    expect(route.method).toBe("GET");
    expect(route.path).toBe(TEAMS_PATH);
  });

  it("rejects unauthenticated requests with 401", async () => {
    const provider = new FakeTeamsProvider();
    const route = createTeamsListRoute({
      provider,
      resolveCaller: () => undefined,
    });

    await expect(
      route.handler({
        method: "GET",
        path: `/v1/tenants/${TENANT}/teams`,
        params: { tenantId: TENANT },
        query: new URLSearchParams(),
        headers: {},
      }),
    ).rejects.toMatchObject({ status: 401 });
    expect(provider.calls).toHaveLength(0);
  });

  it("rejects tenants outside caller scope with 403", async () => {
    const provider = new FakeTeamsProvider();
    const route = createTeamsListRoute({
      provider,
      resolveCaller: () => ({
        tenantScope: tenantScope(["different-tenant"]),
        permissions: [TEAMS_READ_PERMISSION],
      }),
    });

    await expect(
      route.handler({
        method: "GET",
        path: `/v1/tenants/${TENANT}/teams`,
        params: { tenantId: TENANT },
        query: new URLSearchParams(),
        headers: {},
      }),
    ).rejects.toMatchObject({ status: 403 });
    expect(provider.calls).toHaveLength(0);
  });

  it("rejects callers missing teams.read with 403 and performs no provider call", async () => {
    const provider = new FakeTeamsProvider();
    const route = createTeamsListRoute({
      provider,
      resolveCaller: () => ({
        tenantScope: tenantScope([TENANT]),
        permissions: ["Identity.User.Read"],
      }),
    });

    await expect(
      route.handler({
        method: "GET",
        path: `/v1/tenants/${TENANT}/teams`,
        params: { tenantId: TENANT },
        query: new URLSearchParams(),
        headers: {},
      }),
    ).rejects.toMatchObject({ status: 403 });
    expect(provider.calls).toHaveLength(0);
  });

  it("returns the §3.1 columns, filtered and paginated", async () => {
    const provider = new FakeTeamsProvider();
    const caller: TeamsCaller = {
      tenantScope: tenantScope([TENANT]),
      permissions: [TEAMS_READ_PERMISSION],
    };
    const route = createTeamsListRoute({ provider, resolveCaller: () => caller });

    const response = await route.handler({
      method: "GET",
      path: `/v1/tenants/${TENANT}/teams`,
      params: { tenantId: TENANT },
      query: new URLSearchParams("visibility=public&archived=false&from=2026-01-01&limit=1"),
      headers: {},
    });

    expect(response.status).toBe(200);
    const body = response.body as TeamsPage;
    expect(body.tenantId).toBe(TENANT);
    expect(body.items).toHaveLength(1);
    const item = body.items[0];
    expect(item).toMatchObject({
      id: "team-1",
      name: "Team team-1",
      ownerCount: 2,
      memberCount: 25,
      visibility: "private",
      isArchived: false,
      createdDateTime: "2026-01-15T10:00:00.000Z",
    });
    expect(item?.sensitivityLabel).toBeDefined();
    expect(provider.calls).toHaveLength(1);
    expect(provider.calls[0]?.filter.visibility).toBe("public");
    expect(provider.calls[0]?.filter.archived).toBe(false);
    expect(provider.calls[0]?.filter.from).toBe("2026-01-01");
    expect(provider.calls[0]?.filter.limit).toBe(1);
  });

  it("validates visibility, archived, and activity date filter parameters", () => {
    expect(() => parseTeamsFilter(new URLSearchParams("visibility=secret"))).toThrow(AppError);
    expect(() => parseTeamsFilter(new URLSearchParams("archived=maybe"))).toThrow(AppError);
    expect(() => parseTeamsFilter(new URLSearchParams("from=not-a-date"))).toThrow(AppError);
    expect(() => parseTeamsFilter(new URLSearchParams("to=not-a-date"))).toThrow(AppError);
  });

  it("publishes the teams.read permission through the route module", () => {
    const entry = TEAMS_OPENAPI.paths["/tenants/{tenantId}/teams"];
    expect(entry.get.permission).toBe("teams.read");
    expect(entry.get.operationId).toBe("listTeams");
    expect(TEAMS_READ_PERMISSION).toBe("teams.read");
  });
});
