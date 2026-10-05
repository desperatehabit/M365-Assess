import { describe, expect, it } from "vitest";
import { tenantScope } from "../rbac/scope.js";
import {
  TEAMS_ACTIVITY_PATH,
  TEAMS_READ_PERMISSION,
  createTeamsActivityRoutes,
  parseTeamsActivityFilter,
  type TeamsActivityCaller,
  type TeamsActivityData,
  type TeamsActivityProvider,
  type TeamsActivityReport,
} from "./teams-activity.js";

const TENANT = "tenant-teams-activity";

class FakeTeamsActivityProvider implements TeamsActivityProvider {
  readonly calls: Array<{ tenantId: string; filter: { period: string; cursor: string | null; limit: number } }> = [];

  constructor(private readonly data: TeamsActivityData) {}

  async getActivity(
    tenantId: string,
    filter: { period: string; cursor: string | null; limit: number },
  ): Promise<TeamsActivityData> {
    this.calls.push({ tenantId, filter });
    return this.data;
  }
}

function makeData(teams: number, users: number): TeamsActivityData {
  return {
    tenantId: TENANT,
    generatedAt: "2026-09-26T12:00:00Z",
    period: "D7",
    startDate: null,
    endDate: null,
    teams: Array.from({ length: teams }, (_, i) => ({
      teamId: `team-${i}`,
      displayName: `Team ${i}`,
      activeUsers: 10 - i,
      messages: 100 - i,
      meetings: 5,
      calls: 2,
      lastActivityDate: "2026-09-25T00:00:00Z",
      source: "graph",
    })),
    users: Array.from({ length: users }, (_, i) => ({
      userId: `user-${i}`,
      displayName: `User ${i}`,
      userPrincipalName: `user${i}@example.invalid`,
      teamId: null,
      active: true,
      messages: 50 - i,
      meetings: 3,
      calls: 1,
      lastActivityDate: "2026-09-25T00:00:00Z",
      source: "graph",
    })),
    sources: { teams: "graph", users: "graph" },
  };
}

describe("Teams activity routes (T-0507)", () => {
  const getRoutes = (provider: FakeTeamsActivityProvider, caller?: TeamsActivityCaller) => {
    return createTeamsActivityRoutes({
      provider,
      resolveCaller: () => caller,
    });
  };

  const callRoute = (
    route: { handler: (ctx: never) => Promise<{ status: number; body?: unknown }> },
    query: URLSearchParams = new URLSearchParams(),
  ) =>
    route.handler({
      method: "GET",
      path: `/v1/tenants/${TENANT}/teams/activity`,
      params: { tenantId: TENANT },
      query,
      headers: {},
    } as never);

  it("rejects unauthenticated requests with 401", async () => {
    const provider = new FakeTeamsActivityProvider(makeData(1, 1));
    const routes = getRoutes(provider, undefined);
    const route = routes.find((r) => r.path === TEAMS_ACTIVITY_PATH)!;

    await expect(callRoute(route)).rejects.toMatchObject({ status: 401 });
  });

  it("rejects tenant outside caller scope with 403", async () => {
    const provider = new FakeTeamsActivityProvider(makeData(1, 1));
    const caller: TeamsActivityCaller = {
      tenantScope: tenantScope(["other-tenant"]),
      permissions: [TEAMS_READ_PERMISSION],
    };
    const routes = getRoutes(provider, caller);
    const route = routes.find((r) => r.path === TEAMS_ACTIVITY_PATH)!;

    await expect(callRoute(route)).rejects.toMatchObject({ status: 403 });
  });

  it("rejects missing Teams.Team.Read permission with 403", async () => {
    const provider = new FakeTeamsActivityProvider(makeData(1, 1));
    const caller: TeamsActivityCaller = {
      tenantScope: tenantScope([TENANT]),
      permissions: ["Identity.Group.Read"],
    };
    const routes = getRoutes(provider, caller);
    const route = routes.find((r) => r.path === TEAMS_ACTIVITY_PATH)!;

    await expect(callRoute(route)).rejects.toMatchObject({ status: 403 });
  });

  it("refuses a caller holding Teams.Team.ReadWrite but not Teams.Team.Read with 403", async () => {
    const provider = new FakeTeamsActivityProvider(makeData(1, 1));
    const caller: TeamsActivityCaller = {
      tenantScope: tenantScope([TENANT]),
      permissions: ["Teams.Team.ReadWrite"],
    };
    const routes = getRoutes(provider, caller);
    const route = routes.find((r) => r.path === TEAMS_ACTIVITY_PATH)!;

    await expect(callRoute(route)).rejects.toMatchObject({ status: 403 });
    expect(provider.calls).toHaveLength(0);
  });

  it("validates the period query parameter", async () => {
    const provider = new FakeTeamsActivityProvider(makeData(1, 1));
    const caller: TeamsActivityCaller = {
      tenantScope: tenantScope([TENANT]),
      permissions: [TEAMS_READ_PERMISSION],
    };
    const routes = getRoutes(provider, caller);
    const route = routes.find((r) => r.path === TEAMS_ACTIVITY_PATH)!;

    await expect(callRoute(route, new URLSearchParams("period=D45"))).rejects.toMatchObject({ status: 400 });
  });

  it("validates startDate and endDate query parameters", async () => {
    const provider = new FakeTeamsActivityProvider(makeData(1, 1));
    const caller: TeamsActivityCaller = {
      tenantScope: tenantScope([TENANT]),
      permissions: [TEAMS_READ_PERMISSION],
    };
    const routes = getRoutes(provider, caller);
    const route = routes.find((r) => r.path === TEAMS_ACTIVITY_PATH)!;

    await expect(callRoute(route, new URLSearchParams("startDate=09/25/2026"))).rejects.toMatchObject({
      status: 400,
    });
    await expect(callRoute(route, new URLSearchParams("endDate=not-a-date"))).rejects.toMatchObject({
      status: 400,
    });
  });

  it("returns per-team and per-user usage with default period D7", async () => {
    const provider = new FakeTeamsActivityProvider(makeData(2, 3));
    const caller: TeamsActivityCaller = {
      tenantScope: tenantScope([TENANT]),
      permissions: [TEAMS_READ_PERMISSION],
    };
    const routes = getRoutes(provider, caller);
    const route = routes.find((r) => r.path === TEAMS_ACTIVITY_PATH)!;

    const res = await callRoute(route);

    expect(res.status).toBe(200);
    const body = res.body as TeamsActivityReport;
    expect(body.tenantId).toBe(TENANT);
    expect(body.period).toBe("D7");
    expect(body.teams).toHaveLength(2);
    expect(body.users).toHaveLength(3);
    expect(body.teams[0]?.displayName).toBe("Team 0");
    expect(body.teams[0]?.activeUsers).toBe(10);
    expect(body.teams[0]?.messages).toBe(100);
    expect(body.teams[0]?.source).toBe("graph");
    expect(body.users[0]?.userPrincipalName).toBe("user0@example.invalid");
    expect(body.users[0]?.active).toBe(true);
    expect(body.sources.teams).toBe("graph");
    expect(body.nextCursor).toBeNull();
    expect(provider.calls[0]?.filter.period).toBe("D7");
  });

  it("paginates both lists under one cursor", async () => {
    const provider = new FakeTeamsActivityProvider(makeData(5, 250));
    const caller: TeamsActivityCaller = {
      tenantScope: tenantScope([TENANT]),
      permissions: [TEAMS_READ_PERMISSION],
    };
    const routes = getRoutes(provider, caller);
    const route = routes.find((r) => r.path === TEAMS_ACTIVITY_PATH)!;

    const first = await callRoute(route, new URLSearchParams("limit=100"));
    expect(first.status).toBe(200);
    const firstBody = first.body as TeamsActivityReport;
    expect(firstBody.teams).toHaveLength(5);
    expect(firstBody.users).toHaveLength(100);
    expect(firstBody.nextCursor).not.toBeNull();

    const cursor = firstBody.nextCursor!;
    const second = await callRoute(route, new URLSearchParams(`limit=100&cursor=${encodeURIComponent(cursor)}`));
    expect(second.status).toBe(200);
    const secondBody = second.body as TeamsActivityReport;
    expect(secondBody.teams).toHaveLength(0);
    expect(secondBody.users).toHaveLength(100);
    expect(secondBody.nextCursor).not.toBeNull();

    const third = await callRoute(
      route,
      new URLSearchParams(`limit=100&cursor=${encodeURIComponent(secondBody.nextCursor!)}`),
    );
    const thirdBody = third.body as TeamsActivityReport;
    expect(thirdBody.users).toHaveLength(50);
    expect(thirdBody.nextCursor).toBeNull();
  });

  it("passes date filters through to the provider", async () => {
    const provider = new FakeTeamsActivityProvider(makeData(1, 1));
    const caller: TeamsActivityCaller = {
      tenantScope: tenantScope([TENANT]),
      permissions: [TEAMS_READ_PERMISSION],
    };
    const routes = getRoutes(provider, caller);
    const route = routes.find((r) => r.path === TEAMS_ACTIVITY_PATH)!;

    const res = await callRoute(route, new URLSearchParams("period=D30&startDate=2026-09-01&endDate=2026-09-30"));

    expect(res.status).toBe(200);
    expect(provider.calls[0]?.filter.period).toBe("D30");
    expect(provider.calls[0]?.filter.startDate).toBe("2026-09-01");
    expect(provider.calls[0]?.filter.endDate).toBe("2026-09-30");
  });

  it("parses the filter with defaults", () => {
    const filter = parseTeamsActivityFilter(new URLSearchParams());
    expect(filter.period).toBe("D7");
    expect(filter.cursor).toBeNull();
    expect(filter.limit).toBe(100);
    expect(filter.startDate).toBeUndefined();
    expect(filter.endDate).toBeUndefined();
  });
});
