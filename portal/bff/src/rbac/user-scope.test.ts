import { describe, expect, it } from "vitest";
import { AppError } from "../errors.js";
import type { RequestContext } from "../server.js";
import {
  PORTAL_USER_PATH,
  PORTAL_USER_SCOPE_PATH,
  PORTAL_USERS_OPENAPI,
  createInMemoryPortalUserStore,
  createPortalUsersRoute,
  resolvePortalUserTenantScope,
  type PortalUserRecord,
  type PortalUserStore,
  type PortalUsersCaller,
} from "../routes/users.js";
import { ALL_TENANTS, isTenantAllowed } from "./scope.js";
import {
  UserScopeCodes,
  intersectUserScope,
  parseUserScopeRow,
  requireUserScope,
  resolveUserScope,
  type GroupTenantResolver,
  type UserScopeRow,
} from "./user-scope.js";

const GROUPS: Readonly<Record<string, readonly string[]>> = {
  "group-a": ["tenant-a1", "tenant-a2"],
  "group-b": ["tenant-b1"],
  "group-empty": [],
};

const resolveGroupTenants: GroupTenantResolver = (groupId) => GROUPS[groupId] ?? [];

function row(targetType: UserScopeRow["targetType"], targetId: string | null = null): UserScopeRow {
  return { targetType, targetId };
}

describe("resolveUserScope", () => {
  it("resolves a direct tenant row to an explicit scope", () => {
    const scope = resolveUserScope({
      rows: [row("tenant", "tenant-a")],
      roles: ["readonly"],
      resolveGroupTenants,
    });
    expect(scope.all).toBe(false);
    expect(scope.tenantIds).toEqual(["tenant-a"]);
  });

  it("expands a group row to its member tenants and unions direct tenants", () => {
    const scope = resolveUserScope({
      rows: [row("group", "group-a"), row("tenant", "tenant-b")],
      roles: ["editor"],
      resolveGroupTenants,
    });
    expect([...scope.tenantIds].sort()).toEqual(["tenant-a1", "tenant-a2", "tenant-b"]);
  });

  it("deduplicates tenants shared across overlapping rows", () => {
    const scope = resolveUserScope({
      rows: [row("tenant", "tenant-a1"), row("group", "group-a")],
      roles: ["admin"],
      resolveGroupTenants,
    });
    expect([...scope.tenantIds].sort()).toEqual(["tenant-a1", "tenant-a2"]);
  });

  it("grants all tenants to a superadmin holding an all row", () => {
    const scope = resolveUserScope({
      rows: [row("all")],
      roles: ["superadmin"],
      resolveGroupTenants,
    });
    expect(scope).toEqual(ALL_TENANTS);
    expect(isTenantAllowed(scope, "any-tenant")).toBe(true);
  });

  it("rejects an all row held by any non-superadmin role", () => {
    for (const role of ["readonly", "editor", "admin"]) {
      expect(() =>
        resolveUserScope({ rows: [row("all")], roles: [role], resolveGroupTenants }),
      ).toThrowError(expect.objectContaining({ code: UserScopeCodes.allForbidden, status: 403 }));
    }
  });

  it("ignores blank and unknown targets, resolving to no tenants", () => {
    const scope = resolveUserScope({
      rows: [row("tenant", "   "), row("group", "missing-group"), row("group", "group-empty")],
      roles: ["readonly"],
      resolveGroupTenants,
    });
    expect(scope.all).toBe(false);
    expect(scope.tenantIds).toEqual([]);
  });
});

describe("intersectUserScope", () => {
  it("allows a selection fully inside an explicit scope", () => {
    expect(
      intersectUserScope({ all: false, tenantIds: ["tenant-a", "tenant-b"] }, ["tenant-b"]),
    ).toEqual({ allowed: true, tenantIds: ["tenant-b"] });
  });

  it("denies a request for a tenant outside scope rather than narrowing it", () => {
    expect(intersectUserScope({ all: false, tenantIds: ["tenant-a"] }, ["tenant-b"])).toEqual({
      allowed: false,
      denied: ["tenant-b"],
    });
  });

  it("denies the whole selection when any tenant is outside scope", () => {
    const decision = intersectUserScope(
      { all: false, tenantIds: ["tenant-a"] },
      ["tenant-a", "tenant-b"],
    );
    expect(decision.allowed).toBe(false);
    if (!decision.allowed) {
      expect(decision.denied).toEqual(["tenant-b"]);
    }
  });

  it("grants an all scope exactly the requested list", () => {
    expect(intersectUserScope(ALL_TENANTS, ["tenant-a", "tenant-b"])).toEqual({
      allowed: true,
      tenantIds: ["tenant-a", "tenant-b"],
    });
    expect(intersectUserScope(ALL_TENANTS, [])).toEqual({ allowed: true, tenantIds: [] });
  });

  it("deduplicates the requested selection", () => {
    expect(intersectUserScope(ALL_TENANTS, ["tenant-a", "tenant-a"])).toEqual({
      allowed: true,
      tenantIds: ["tenant-a"],
    });
  });
});

describe("requireUserScope", () => {
  it("returns the permitted selection when every tenant is in scope", () => {
    expect(
      requireUserScope(
        { rows: [row("group", "group-a")], roles: ["readonly"], resolveGroupTenants },
        ["tenant-a2"],
      ),
    ).toEqual(["tenant-a2"]);
  });

  it("throws a structured 403 when any requested tenant is out of scope", () => {
    let thrown: unknown;
    try {
      requireUserScope(
        { rows: [row("tenant", "tenant-a")], roles: ["readonly"], resolveGroupTenants },
        ["tenant-a", "tenant-b"],
      );
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(AppError);
    expect(thrown).toMatchObject({ code: UserScopeCodes.outOfScope, status: 403 });
  });
});

describe("parseUserScopeRow", () => {
  it("defaults an absent scope to all", () => {
    expect(parseUserScopeRow(undefined)).toEqual({ targetType: "all", targetId: null });
  });

  it("parses tenant and group targets, trimming the id", () => {
    expect(parseUserScopeRow({ targetType: "tenant", targetId: " tenant-a " })).toEqual({
      targetType: "tenant",
      targetId: "tenant-a",
    });
    expect(parseUserScopeRow({ targetType: "group", targetId: "group-a" })).toEqual({
      targetType: "group",
      targetId: "group-a",
    });
  });

  it("rejects an unknown target type and a missing target id", () => {
    expect(() => parseUserScopeRow({ targetType: "fleet" })).toThrowError(
      expect.objectContaining({ status: 400 }),
    );
    expect(() => parseUserScopeRow({ targetType: "tenant" })).toThrowError(
      expect.objectContaining({ status: 400 }),
    );
  });
});

// ─── /v1/users scope editing wiring (T-0744 + T-0746) ───────────────────────

function seededUser(overrides: Partial<PortalUserRecord> = {}): PortalUserRecord {
  return {
    id: "user-1",
    upn: "seed@example.invalid",
    displayName: "Seed User",
    role: "readonly",
    status: "enabled",
    scope: { targetType: "tenant", targetId: "tenant-a" },
    lastSeenAt: null,
    createdAt: "2026-09-01T00:00:00.000Z",
    updatedAt: "2026-09-01T00:00:00.000Z",
    ...overrides,
  };
}

function portalOptions(store: PortalUserStore) {
  return createPortalUsersRoute({
    store,
    resolveCaller: () =>
      ({ roles: [], tenantScope: ALL_TENANTS, userId: "actor-1" }) as unknown as PortalUsersCaller,
    authorize: () => {},
  });
}

function handlerFor(routes: ReturnType<typeof createPortalUsersRoute>, method: string, path: string) {
  const route = routes.find((candidate) => candidate.method === method && candidate.path === path);
  if (!route) {
    throw new Error(`${method} ${path} handler is missing`);
  }
  return route.handler;
}

function requestContext(body: unknown): RequestContext {
  return {
    correlationId: "correlation-1",
    method: "PUT",
    path: "/v1/users/user-1/scope",
    query: new URLSearchParams(),
    headers: {},
    params: { id: "user-1" },
    body,
  } as RequestContext;
}

describe("portal user scope editing", () => {
  it("resolves a portal user's group scope to its member tenants", () => {
    const scope = resolvePortalUserTenantScope(
      { role: "readonly", scope: { targetType: "group", targetId: "group-a" } },
      resolveGroupTenants,
    );
    expect([...scope.tenantIds].sort()).toEqual(["tenant-a1", "tenant-a2"]);
  });

  it("denies a read or act on a tenant outside the resolved portal-user scope", () => {
    const scope = resolvePortalUserTenantScope(
      { role: "readonly", scope: { targetType: "tenant", targetId: "tenant-a" } },
      resolveGroupTenants,
    );
    expect(intersectUserScope(scope, ["tenant-b"])).toEqual({
      allowed: false,
      denied: ["tenant-b"],
    });
    expect(intersectUserScope(scope, ["tenant-a"])).toEqual({
      allowed: true,
      tenantIds: ["tenant-a"],
    });
  });

  it("replaces a tenant scope through the UserScope edit path", async () => {
    const store = createInMemoryPortalUserStore([seededUser()]);
    const routes = portalOptions(store);

    const response = await handlerFor(routes, "PUT", PORTAL_USER_SCOPE_PATH)(
      requestContext({ scope: { targetType: "tenant", targetId: "tenant-b" } }),
    );

    expect(response.status).toBe(200);
    expect((response.body as PortalUserRecord).scope).toEqual({
      targetType: "tenant",
      targetId: "tenant-b",
    });
    expect((await store.getUser("user-1"))?.scope.targetId).toBe("tenant-b");
  });

  it("rejects an all scope for a non-superadmin target without persisting it", async () => {
    const store = createInMemoryPortalUserStore([seededUser({ role: "admin" })]);
    const routes = portalOptions(store);

    await expect(
      handlerFor(routes, "PUT", PORTAL_USER_SCOPE_PATH)(requestContext({ targetType: "all" })),
    ).rejects.toMatchObject({ status: 400 });
    expect((await store.getUser("user-1"))?.scope).toEqual({
      targetType: "tenant",
      targetId: "tenant-a",
    });
  });

  it("accepts an all scope for a superadmin target", async () => {
    const store = createInMemoryPortalUserStore([seededUser({ role: "superadmin" })]);
    const routes = portalOptions(store);

    const response = await handlerFor(routes, "PUT", PORTAL_USER_SCOPE_PATH)(
      requestContext({ scope: { targetType: "all" } }),
    );

    expect(response.status).toBe(200);
    expect((response.body as PortalUserRecord).scope).toEqual({
      targetType: "all",
      targetId: null,
    });
  });

  it("rejects an explicit all scope through PATCH for a non-superadmin", async () => {
    const store = createInMemoryPortalUserStore([seededUser({ role: "admin" })]);
    const routes = portalOptions(store);

    await expect(
      handlerFor(routes, "PATCH", PORTAL_USER_PATH)(requestContext({ scope: { targetType: "all" } })),
    ).rejects.toMatchObject({ status: 400 });
  });

  it("publishes the scope edit path under the admin permission", () => {
    expect(PORTAL_USER_SCOPE_PATH).toBe("/v1/users/:id/scope");
    const operation = PORTAL_USERS_OPENAPI.paths["/users/{id}/scope"].put;
    expect(operation.permission).toBe("CIPP.Admin.Users");
    expect(operation.operationId).toBe("updatePortalUserScope");
  });
});
