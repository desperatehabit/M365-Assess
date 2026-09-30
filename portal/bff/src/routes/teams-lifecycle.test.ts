// T-0505 — teams edit/archive/clone/delete route gating, delete confirmation
// naming the team, EPIC-006 preview/apply, and TeamOperation audit.
// Route-level tests: PATCH/DELETE /v1/tenants/:tenantId/teams/:teamId plus the
// archive and clone subpaths validate teams.write + Remediation.Apply + tenant
// scope, return a plan preview without writing, and on apply record a
// TeamOperation (state + result) plus an audit event. Delete additionally
// requires an explicit confirmation naming the team.

import { describe, expect, it } from "vitest";
import { AppError } from "../errors.js";
import { tenantScope } from "../rbac/scope.js";
import type { RequestContext } from "../server.js";
import {
  REMEDIATION_APPLY_PERMISSION,
  TEAMS_CONFIRM_REQUIRED,
  TEAMS_LIFECYCLE_ARCHIVE_PATH,
  TEAMS_LIFECYCLE_CLONE_PATH,
  TEAMS_LIFECYCLE_ITEM_PATH,
  TEAMS_LIFECYCLE_OPENAPI,
  TEAMS_TEAM_NOT_FOUND,
  TEAMS_WRITE_PERMISSION,
  createTeamsLifecycleRoutes,
  type TeamAuditEvent,
  type TeamLifecycleAction,
  type TeamLifecycleInput,
  type TeamLifecyclePlan,
  type TeamOperationRecord,
  type TeamOperationResult,
  type TeamOperationStore,
  type TeamsLifecycleCaller,
  type TeamsLifecycleProvider,
  type TeamsLifecycleRouteOptions,
} from "./teams-lifecycle.js";

const TENANT = "tenant-a";
const TEAM = "team-1";

function planFor(action: TeamLifecycleAction): TeamLifecyclePlan {
  return {
    action,
    teamId: TEAM,
    targetName: "Project Alpha",
    before: { id: TEAM, displayName: "Project Alpha", isArchived: false },
    after: { id: TEAM, displayName: "Project Alpha" },
    diff: [`${action} team 'Project Alpha' (${TEAM})`],
    valid: true,
    dryRun: true,
    requiresConfirmation: action === "delete",
  };
}

function resultFor(action: TeamLifecycleAction): TeamOperationResult {
  return {
    success: true,
    state: "succeeded",
    operation: action,
    teamId: TEAM,
    targetName: "Project Alpha",
    before: { id: TEAM, displayName: "Project Alpha" },
    after: { id: TEAM, displayName: "Project Alpha" },
    error: null,
    auditEvent: {
      id: `audit-${action}-1`,
      tenantId: TENANT,
      action: `teams.team.${action}`,
      targetId: TEAM,
      targetName: "Project Alpha",
      timestamp: "2026-09-29T00:00:00.000Z",
      result: "success",
      before: { id: TEAM },
      after: { id: TEAM },
    },
  };
}

class FakeLifecycleProvider implements TeamsLifecycleProvider {
  readonly calls: Array<{
    action: TeamLifecycleAction;
    tenantId: string;
    teamId: string;
    input: TeamLifecycleInput;
    preview: boolean;
  }> = [];
  error: unknown = undefined;

  private record(
    action: TeamLifecycleAction,
    tenantId: string,
    teamId: string,
    input: TeamLifecycleInput,
    preview: boolean,
  ): Promise<TeamOperationResult | TeamLifecyclePlan> {
    this.calls.push({ action, tenantId, teamId, input, preview });
    if (this.error !== undefined) {
      throw this.error;
    }
    return Promise.resolve(preview ? planFor(action) : resultFor(action));
  }

  editTeam(
    tenantId: string,
    teamId: string,
    input: TeamLifecycleInput,
    preview: boolean,
  ): Promise<TeamOperationResult | TeamLifecyclePlan> {
    return this.record("edit", tenantId, teamId, input, preview);
  }

  archiveTeam(
    tenantId: string,
    teamId: string,
    input: TeamLifecycleInput,
    preview: boolean,
  ): Promise<TeamOperationResult | TeamLifecyclePlan> {
    return this.record("archive", tenantId, teamId, input, preview);
  }

  cloneTeam(
    tenantId: string,
    teamId: string,
    input: TeamLifecycleInput,
    preview: boolean,
  ): Promise<TeamOperationResult | TeamLifecyclePlan> {
    return this.record("clone", tenantId, teamId, input, preview);
  }

  deleteTeam(
    tenantId: string,
    teamId: string,
    input: TeamLifecycleInput,
    preview: boolean,
  ): Promise<TeamOperationResult | TeamLifecyclePlan> {
    return this.record("delete", tenantId, teamId, input, preview);
  }
}

class FakeTeamOperationStore implements TeamOperationStore {
  readonly created: Array<{ id: string; operation: string; state: string }> = [];
  readonly updates: Array<{ operationId: string; state?: string; result?: string | null }> = [];
  private counter = 0;

  async createTeamOperation(input: {
    id: string;
    tenantId: string;
    teamId: string;
    operation: string;
    state: string;
    by?: string | null;
    at?: string;
  }): Promise<TeamOperationRecord> {
    this.counter += 1;
    const id = `op-${this.counter}`;
    this.created.push({ id, operation: input.operation, state: input.state });
    return {
      id,
      tenantId: input.tenantId,
      teamId: input.teamId,
      operation: input.operation,
      state: input.state,
      by: input.by ?? null,
      at: input.at ?? "2026-09-29T00:00:00.000Z",
      result: null,
      createdAt: "2026-09-29T00:00:00.000Z",
      updatedAt: "2026-09-29T00:00:00.000Z",
    };
  }

  async updateTeamOperation(
    _tenantId: string,
    operationId: string,
    update: { state?: string; result?: string | null },
  ): Promise<TeamOperationRecord | undefined> {
    this.updates.push({ operationId, state: update.state, result: update.result });
    return undefined;
  }
}

function callerFor(
  tenantIds: readonly string[],
  permissions: readonly string[],
): TeamsLifecycleCaller {
  return {
    userId: "operator-1",
    roles: [],
    tenantScope: tenantScope(tenantIds),
    permissions,
  };
}

function contextFor(
  method: string,
  path: string,
  body: unknown,
  params: Record<string, string> = { tenantId: TENANT, teamId: TEAM },
): RequestContext {
  return {
    correlationId: "corr-1",
    method,
    path,
    query: new URLSearchParams(),
    headers: {},
    params,
    body,
  };
}

interface Harness {
  readonly provider: FakeLifecycleProvider;
  readonly store: FakeTeamOperationStore;
  readonly audits: TeamAuditEvent[];
  readonly routes: ReturnType<typeof createTeamsLifecycleRoutes>;
}

function harness(caller?: TeamsLifecycleCaller): Harness {
  const provider = new FakeLifecycleProvider();
  const store = new FakeTeamOperationStore();
  const audits: TeamAuditEvent[] = [];
  const options: TeamsLifecycleRouteOptions = {
    provider,
    teamOperations: store,
    resolveCaller: () => caller,
    recordAudit: (event) => {
      audits.push(event);
    },
  };
  return { provider, store, audits, routes: createTeamsLifecycleRoutes(options) };
}

const WRITE_CALLER = callerFor([TENANT], [
  TEAMS_WRITE_PERMISSION,
  REMEDIATION_APPLY_PERMISSION,
]);

function routeFor(
  routes: ReturnType<typeof createTeamsLifecycleRoutes>,
  method: string,
  path: string,
) {
  return routes.find((route) => route.method === method && route.path === path)!;
}

describe("Teams lifecycle routes (T-0505)", () => {
  it("exposes edit, delete, archive, and clone paths", () => {
    const { routes } = harness(WRITE_CALLER);
    expect(routes.map((route) => `${route.method} ${route.path}`)).toEqual([
      `PATCH ${TEAMS_LIFECYCLE_ITEM_PATH}`,
      `DELETE ${TEAMS_LIFECYCLE_ITEM_PATH}`,
      `POST ${TEAMS_LIFECYCLE_ARCHIVE_PATH}`,
      `POST ${TEAMS_LIFECYCLE_CLONE_PATH}`,
    ]);
  });

  it("publishes the edit, delete, archive, and clone OpenAPI path items", () => {
    const paths = Object.keys(TEAMS_LIFECYCLE_OPENAPI.paths);
    expect(paths).toContain("/tenants/{tenantId}/teams/{teamId}");
    expect(paths).toContain("/tenants/{tenantId}/teams/{teamId}/archive");
    expect(paths).toContain("/tenants/{tenantId}/teams/{teamId}/clone");
    expect(
      TEAMS_LIFECYCLE_OPENAPI.paths["/tenants/{tenantId}/teams/{teamId}"].delete.permission,
    ).toBe(TEAMS_WRITE_PERMISSION);
  });

  it("rejects unauthenticated requests with 401", async () => {
    const { routes } = harness(undefined);
    await expect(
      routeFor(routes, "DELETE", TEAMS_LIFECYCLE_ITEM_PATH).handler(
        contextFor("DELETE", TEAMS_LIFECYCLE_ITEM_PATH, { confirm: true, confirmName: "Project Alpha" }),
      ),
    ).rejects.toMatchObject({ status: 401 });
  });

  it("rejects a caller missing teams.write with 403 and writes nothing", async () => {
    const { provider, routes } = harness(callerFor([TENANT], [REMEDIATION_APPLY_PERMISSION]));
    await expect(
      routeFor(routes, "PATCH", TEAMS_LIFECYCLE_ITEM_PATH).handler(
        contextFor("PATCH", TEAMS_LIFECYCLE_ITEM_PATH, { changes: { description: "x" } }),
      ),
    ).rejects.toMatchObject({ status: 403 });
    expect(provider.calls).toHaveLength(0);
  });

  it("rejects a caller missing Remediation.Apply on apply with 403", async () => {
    const { provider, routes } = harness(callerFor([TENANT], [TEAMS_WRITE_PERMISSION]));
    await expect(
      routeFor(routes, "POST", TEAMS_LIFECYCLE_ARCHIVE_PATH).handler(
        contextFor("POST", TEAMS_LIFECYCLE_ARCHIVE_PATH, {}),
      ),
    ).rejects.toMatchObject({ status: 403 });
    expect(provider.calls).toHaveLength(0);
  });

  it("rejects an out-of-scope tenant with 403", async () => {
    const { provider, routes } = harness(
      callerFor(["other-tenant"], [TEAMS_WRITE_PERMISSION, REMEDIATION_APPLY_PERMISSION]),
    );
    await expect(
      routeFor(routes, "POST", TEAMS_LIFECYCLE_ARCHIVE_PATH).handler(
        contextFor("POST", TEAMS_LIFECYCLE_ARCHIVE_PATH, {}),
      ),
    ).rejects.toMatchObject({ status: 403 });
    expect(provider.calls).toHaveLength(0);
  });
});

describe("Teams edit (T-0505)", () => {
  it("returns a plan preview without writing when preview requested", async () => {
    const { provider, store, audits, routes } = harness(WRITE_CALLER);
    const response = await routeFor(routes, "PATCH", TEAMS_LIFECYCLE_ITEM_PATH).handler(
      contextFor("PATCH", TEAMS_LIFECYCLE_ITEM_PATH, {
        preview: true,
        changes: { description: "new" },
      }),
    );
    expect(response.status).toBe(200);
    expect((response.body as TeamLifecyclePlan).dryRun).toBe(true);
    expect(provider.calls[0]?.preview).toBe(true);
    expect(provider.calls[0]?.input.changes).toEqual({ description: "new" });
    expect(store.created).toHaveLength(0);
    expect(audits).toHaveLength(0);
  });

  it("applies an edit and records a TeamOperation plus an audit event", async () => {
    const { provider, store, audits, routes } = harness(WRITE_CALLER);
    const response = await routeFor(routes, "PATCH", TEAMS_LIFECYCLE_ITEM_PATH).handler(
      contextFor("PATCH", TEAMS_LIFECYCLE_ITEM_PATH, { changes: { displayName: "Renamed" } }),
    );
    expect(response.status).toBe(200);
    const body = response.body as TeamOperationResult;
    expect(body.operation).toBe("edit");
    expect(body.state).toBe("succeeded");
    expect(provider.calls).toHaveLength(1);
    expect(store.created).toEqual([{ id: "op-1", operation: "edit", state: "running" }]);
    expect(store.updates[0]?.state).toBe("succeeded");
    expect(audits).toHaveLength(1);
    expect(audits[0]?.action).toBe("teams.team.edit");
  });

  it("rejects an edit with no changes before dispatch", async () => {
    const { provider, routes } = harness(WRITE_CALLER);
    await expect(
      routeFor(routes, "PATCH", TEAMS_LIFECYCLE_ITEM_PATH).handler(
        contextFor("PATCH", TEAMS_LIFECYCLE_ITEM_PATH, { changes: {} }),
      ),
    ).rejects.toMatchObject({ status: 400 });
    expect(provider.calls).toHaveLength(0);
  });
});

describe("Teams archive (T-0505)", () => {
  it("returns an archive plan preview without writing", async () => {
    const { provider, store, routes } = harness(WRITE_CALLER);
    const response = await routeFor(routes, "POST", TEAMS_LIFECYCLE_ARCHIVE_PATH).handler(
      contextFor("POST", TEAMS_LIFECYCLE_ARCHIVE_PATH, { preview: true }),
    );
    expect(response.status).toBe(200);
    expect((response.body as TeamLifecyclePlan).action).toBe("archive");
    expect(provider.calls[0]?.preview).toBe(true);
    expect(store.created).toHaveLength(0);
  });

  it("applies an archive without confirmation and records a TeamOperation plus an audit event", async () => {
    const { provider, store, audits, routes } = harness(WRITE_CALLER);
    const response = await routeFor(routes, "POST", TEAMS_LIFECYCLE_ARCHIVE_PATH).handler(
      contextFor("POST", TEAMS_LIFECYCLE_ARCHIVE_PATH, {
        shouldSetSpoSiteReadOnlyForMembers: false,
      }),
    );
    expect(response.status).toBe(200);
    const body = response.body as TeamOperationResult;
    expect(body.operation).toBe("archive");
    expect(provider.calls[0]?.input.shouldSetSpoSiteReadOnlyForMembers).toBe(false);
    expect(store.created).toEqual([{ id: "op-1", operation: "archive", state: "running" }]);
    expect(store.updates[0]?.state).toBe("succeeded");
    expect(audits[0]?.action).toBe("teams.team.archive");
  });
});

describe("Teams clone (T-0505)", () => {
  it("applies a clone and records a TeamOperation plus an audit event", async () => {
    const { provider, store, audits, routes } = harness(WRITE_CALLER);
    const response = await routeFor(routes, "POST", TEAMS_LIFECYCLE_CLONE_PATH).handler(
      contextFor("POST", TEAMS_LIFECYCLE_CLONE_PATH, {
        newName: "Project Alpha (copy)",
        visibility: "private",
      }),
    );
    expect(response.status).toBe(200);
    const body = response.body as TeamOperationResult;
    expect(body.operation).toBe("clone");
    expect(provider.calls[0]?.input.newName).toBe("Project Alpha (copy)");
    expect(store.created[0]?.operation).toBe("clone");
    expect(audits[0]?.action).toBe("teams.team.clone");
  });

  it("rejects a clone without a new name before dispatch", async () => {
    const { provider, routes } = harness(WRITE_CALLER);
    await expect(
      routeFor(routes, "POST", TEAMS_LIFECYCLE_CLONE_PATH).handler(
        contextFor("POST", TEAMS_LIFECYCLE_CLONE_PATH, {}),
      ),
    ).rejects.toMatchObject({ status: 400 });
    expect(provider.calls).toHaveLength(0);
  });
});

describe("Teams delete confirmation (T-0505)", () => {
  it("refuses a delete with no confirmation and writes nothing", async () => {
    const { provider, store, audits, routes } = harness(WRITE_CALLER);
    await expect(
      routeFor(routes, "DELETE", TEAMS_LIFECYCLE_ITEM_PATH).handler(
        contextFor("DELETE", TEAMS_LIFECYCLE_ITEM_PATH, {}),
      ),
    ).rejects.toMatchObject({ status: 400, code: TEAMS_CONFIRM_REQUIRED });
    expect(provider.calls).toHaveLength(0);
    expect(store.created).toHaveLength(0);
    expect(audits).toHaveLength(0);
  });

  it("refuses a delete whose confirmation does not name the team and writes nothing", async () => {
    const { provider, store, routes } = harness(WRITE_CALLER);
    await expect(
      routeFor(routes, "DELETE", TEAMS_LIFECYCLE_ITEM_PATH).handler(
        contextFor("DELETE", TEAMS_LIFECYCLE_ITEM_PATH, { confirm: true }),
      ),
    ).rejects.toMatchObject({ status: 400, code: TEAMS_CONFIRM_REQUIRED });
    await expect(
      routeFor(routes, "DELETE", TEAMS_LIFECYCLE_ITEM_PATH).handler(
        contextFor("DELETE", TEAMS_LIFECYCLE_ITEM_PATH, { confirmName: "Project Alpha" }),
      ),
    ).rejects.toMatchObject({ status: 400, code: TEAMS_CONFIRM_REQUIRED });
    expect(provider.calls).toHaveLength(0);
    expect(store.created).toHaveLength(0);
  });

  it("applies a confirmed delete naming the team and records a TeamOperation plus an audit event", async () => {
    const { provider, store, audits, routes } = harness(WRITE_CALLER);
    const response = await routeFor(routes, "DELETE", TEAMS_LIFECYCLE_ITEM_PATH).handler(
      contextFor("DELETE", TEAMS_LIFECYCLE_ITEM_PATH, {
        confirm: true,
        confirmName: "Project Alpha",
      }),
    );
    expect(response.status).toBe(200);
    const body = response.body as TeamOperationResult;
    expect(body.operation).toBe("delete");
    expect(provider.calls[0]?.input.confirmName).toBe("Project Alpha");
    expect(store.created).toEqual([{ id: "op-1", operation: "delete", state: "running" }]);
    expect(store.updates[0]?.state).toBe("succeeded");
    expect(store.updates[0]?.result).toContain('"operation":"delete"');
    expect(audits).toHaveLength(1);
    expect(audits[0]?.action).toBe("teams.team.delete");
  });

  it("maps a provider not-found delete to a structured 404", async () => {
    const { provider, routes } = harness(WRITE_CALLER);
    provider.error = new Error(`NotFound: team '${TEAM}' was not found`);
    await expect(
      routeFor(routes, "DELETE", TEAMS_LIFECYCLE_ITEM_PATH).handler(
        contextFor("DELETE", TEAMS_LIFECYCLE_ITEM_PATH, {
          confirm: true,
          confirmName: "Project Alpha",
        }),
      ),
    ).rejects.toMatchObject({ status: 404, code: TEAMS_TEAM_NOT_FOUND });
  });

  it("maps a worker confirm-name mismatch AppError through unchanged", async () => {
    const { provider, routes } = harness(WRITE_CALLER);
    provider.error = new AppError(TEAMS_CONFIRM_REQUIRED, "name mismatch", 400);
    await expect(
      routeFor(routes, "DELETE", TEAMS_LIFECYCLE_ITEM_PATH).handler(
        contextFor("DELETE", TEAMS_LIFECYCLE_ITEM_PATH, {
          confirm: true,
          confirmName: "Wrong Name",
        }),
      ),
    ).rejects.toMatchObject({ status: 400, code: TEAMS_CONFIRM_REQUIRED });
  });
});
