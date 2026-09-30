import { describe, expect, it } from "vitest";
import { AppError } from "../errors.js";
import type { PermissionRegistryEntry } from "../rbac/permissions.js";
import { PermissionRegistry } from "../rbac/permissions.js";
import { tenantScope } from "../rbac/scope.js";
import {
  ROLE_ASSIGNMENTS_PATH,
  ROLE_CLONE_PATH,
  ROLE_ITEM_PATH,
  ROLE_PREVIEW_PATH,
  ROLES_BUILTIN_IMMUTABLE,
  ROLES_ID_CONFLICT,
  ROLES_IN_USE,
  ROLES_OPENAPI,
  ROLES_PATH,
  ROLES_PERMISSIONS,
  ROLES_READ_PERMISSION,
  createInMemoryRolesStore,
  createRoleAssignmentsRoute,
  createRolesRoutes,
  isSuperadminOnlyRole,
  parseRoleAssignmentsFilter,
  resolveRolePermissions,
  type RoleAssignment,
  type RoleAssignmentsFilter,
  type RoleAssignmentsPage,
  type RoleAssignmentsProvider,
  type RoleAuditEvent,
  type RoleRecord,
  type RoleView,
  type RolesCaller,
  type RolesRouteOptions,
  type RolesStore,
} from "./roles.js";

const TENANT = "tenant-a";

const PERMANENT_ROW: RoleAssignment = {
  id: "ra-1",
  roleDefinitionId: "def-ga",
  roleName: "Global Administrator",
  principalId: "user-1",
  principalDisplayName: "Alice Admin",
  principalEmail: "alice@contoso.com",
  principalType: "user",
  assignmentType: "permanent",
  directoryScopeId: "/",
  scope: "/",
  startDateTime: null,
  endDateTime: null,
  status: "active",
};

const ELIGIBLE_ROW: RoleAssignment = {
  id: "ra-2",
  roleDefinitionId: "def-sa",
  roleName: "Security Administrator",
  principalId: "user-2",
  principalDisplayName: "Bob Security",
  principalEmail: "bob@contoso.com",
  principalType: "user",
  assignmentType: "eligible",
  directoryScopeId: "/",
  scope: "/",
  startDateTime: "2026-09-01T00:00:00Z",
  endDateTime: "2027-09-01T00:00:00Z",
  status: "eligible",
};

class FakeRoleAssignmentsProvider implements RoleAssignmentsProvider {
  readonly calls: Array<{ tenantId: string; filter: RoleAssignmentsFilter }> = [];

  async listRoleAssignments(
    tenantId: string,
    filter: RoleAssignmentsFilter,
  ): Promise<RoleAssignmentsPage> {
    this.calls.push({ tenantId, filter });
    return {
      tenantId,
      totalCount: 2,
      items: [PERMANENT_ROW, ELIGIBLE_ROW],
      nextCursor: null,
    };
  }
}

describe("Role assignments route (T-0241)", () => {
  it("exposes GET /v1/tenants/:tenantId/role-assignments", () => {
    const provider = new FakeRoleAssignmentsProvider();
    const route = createRoleAssignmentsRoute({
      provider,
      resolveCaller: () => ({
        tenantScope: tenantScope([TENANT]),
        permissions: [ROLES_READ_PERMISSION],
      }),
    });
    expect(route.method).toBe("GET");
    expect(route.path).toBe(ROLE_ASSIGNMENTS_PATH);
  });

  it("rejects unauthenticated requests with 401", async () => {
    const provider = new FakeRoleAssignmentsProvider();
    const route = createRoleAssignmentsRoute({
      provider,
      resolveCaller: () => undefined,
    });

    await expect(
      route.handler({
        method: "GET",
        path: `/v1/tenants/${TENANT}/role-assignments`,
        params: { tenantId: TENANT },
        query: new URLSearchParams(),
        headers: {},
      }),
    ).rejects.toMatchObject({ status: 401 });
  });

  it("rejects tenant outside caller scope with 403", async () => {
    const provider = new FakeRoleAssignmentsProvider();
    const route = createRoleAssignmentsRoute({
      provider,
      resolveCaller: () => ({
        tenantScope: tenantScope(["other-tenant"]),
        permissions: [ROLES_READ_PERMISSION],
      }),
    });

    await expect(
      route.handler({
        method: "GET",
        path: `/v1/tenants/${TENANT}/role-assignments`,
        params: { tenantId: TENANT },
        query: new URLSearchParams(),
        headers: {},
      }),
    ).rejects.toMatchObject({ status: 403 });
  });

  it("rejects callers missing roles.read with 403", async () => {
    const provider = new FakeRoleAssignmentsProvider();
    const route = createRoleAssignmentsRoute({
      provider,
      resolveCaller: () => ({
        tenantScope: tenantScope([TENANT]),
        permissions: ["Identity.User.Read"],
      }),
    });

    await expect(
      route.handler({
        method: "GET",
        path: `/v1/tenants/${TENANT}/role-assignments`,
        params: { tenantId: TENANT },
        query: new URLSearchParams(),
        headers: {},
      }),
    ).rejects.toMatchObject({ status: 403 });
  });

  it("returns role assignments distinguishing permanent from eligible", async () => {
    const provider = new FakeRoleAssignmentsProvider();
    const caller: RolesCaller = {
      tenantScope: tenantScope([TENANT]),
      permissions: [ROLES_READ_PERMISSION],
    };
    const route = createRoleAssignmentsRoute({
      provider,
      resolveCaller: () => caller,
    });

    const response = await route.handler({
      method: "GET",
      path: `/v1/tenants/${TENANT}/role-assignments`,
      params: { tenantId: TENANT },
      query: new URLSearchParams("role=Administrator&assignmentType=permanent"),
      headers: {},
    });

    expect(response.status).toBe(200);
    const body = response.body as RoleAssignmentsPage;
    expect(body.tenantId).toBe(TENANT);
    expect(body.items).toHaveLength(2);
    expect(body.items[0]?.assignmentType).toBe("permanent");
    expect(body.items[1]?.assignmentType).toBe("eligible");

    expect(provider.calls).toHaveLength(1);
    expect(provider.calls[0]?.filter.role).toBe("Administrator");
    expect(provider.calls[0]?.filter.assignmentType).toBe("permanent");
  });

  it("validates enum parameters in query", () => {
    expect(() =>
      parseRoleAssignmentsFilter(new URLSearchParams("assignmentType=invalidType")),
    ).toThrow(AppError);

    expect(() =>
      parseRoleAssignmentsFilter(new URLSearchParams("principalType=invalidPrincipal")),
    ).toThrow(AppError);
  });
});

describe("Custom roles CRUD (T-0745)", () => {
  const READ = ROLES_PERMISSIONS.read;
  const WRITE = ROLES_PERMISSIONS.readWrite;

  function callerWith(permissions: readonly string[]): RolesCaller {
    return { roles: [], tenantScope: tenantScope([TENANT]), permissions, userId: "admin-1" };
  }

  function optionsFor(store: RolesStore, overrides: Partial<RolesRouteOptions> = {}): RolesRouteOptions {
    return {
      store,
      permissionRegistry: PermissionRegistry,
      resolveCaller: () => callerWith([READ, WRITE]),
      now: () => "2026-09-29T00:00:00.000Z",
      ...overrides,
    };
  }

  function invoke(
    routes: ReturnType<typeof createRolesRoutes>,
    method: string,
    path: string,
    overrides: { params?: Record<string, string>; body?: unknown } = {},
  ): Promise<{ status: number; body?: unknown; raw?: string }> {
    const route = routes.find((candidate) => candidate.method === method && candidate.path === path);
    if (route === undefined) {
      throw new Error(`no route registered for ${method} ${path}`);
    }
    return Promise.resolve(
      route.handler({
        correlationId: "corr-roles",
        method,
        path,
        query: new URLSearchParams(),
        headers: {},
        params: {},
        ...overrides,
      } as unknown as Parameters<typeof route.handler>[0]),
    );
  }

  function asView(body: unknown): RoleView {
    if (typeof body !== "object" || body === null) {
      throw new Error("expected an object response body");
    }
    return body as RoleView;
  }

  it("creates a custom role, flags Remediation.Apply roles superadmin-only, and audits them", async () => {
    const store = createInMemoryRolesStore();
    const audited: RoleAuditEvent[] = [];
    const routes = createRolesRoutes(
      optionsFor(store, {
        recordAudit: async (event) => {
          audited.push(event);
        },
      }),
    );

    const created = asView(
      (
        await invoke(routes, "POST", ROLES_PATH, {
          body: { id: "role-rem-op", name: "Remediation Operator", include: ["Remediation.Apply"] },
        })
      ).body,
    );
    expect(created.id).toBe("role-rem-op");
    expect(created.builtin).toBe(false);
    expect(created.superadminOnly).toBe(true);
    expect(created.usageCount).toBe(0);
    expect(audited).toHaveLength(1);
    expect(audited[0]).toMatchObject({
      action: "roles.create",
      roleId: "role-rem-op",
      roleName: "Remediation Operator",
      superadminOnly: true,
      actorUserId: "admin-1",
      correlationId: "corr-roles",
      createdAt: "2026-09-29T00:00:00.000Z",
    });

    const plain = asView(
      (
        await invoke(routes, "POST", ROLES_PATH, {
          body: { id: "role-reader", name: "Reader", include: ["*.Read"] },
        })
      ).body,
    );
    expect(plain.superadminOnly).toBe(false);
    expect(audited).toHaveLength(1);
  });

  it("flags a role whose include wildcard grants Remediation.Apply but not one that excludes it", async () => {
    const store = createInMemoryRolesStore();
    const routes = createRolesRoutes(optionsFor(store));

    const wildcard = asView(
      (await invoke(routes, "POST", ROLES_PATH, { body: { id: "r1", name: "Wild", include: ["*"] } }))
        .body,
    );
    expect(wildcard.superadminOnly).toBe(true);

    const excluded = asView(
      (
        await invoke(routes, "POST", ROLES_PATH, {
          body: { id: "r2", name: "Excluded", include: ["Remediation.*"], exclude: ["Remediation.Apply"] },
        })
      ).body,
    );
    expect(excluded.superadminOnly).toBe(false);
  });

  it("lists base roles first, then custom roles, with usage counts", async () => {
    const store = createInMemoryRolesStore({
      roles: [
        { id: "role-custom", name: "Custom", include: ["*.Read"], exclude: [], builtin: false },
      ],
      usage: { admin: 2, "role-custom": 1 },
    });
    const routes = createRolesRoutes(optionsFor(store));

    const response = await invoke(routes, "GET", ROLES_PATH);
    expect(response.status).toBe(200);
    const items = (response.body as { items: RoleView[] }).items;
    expect(items.map((item) => item.id)).toEqual([
      "readonly",
      "editor",
      "admin",
      "superadmin",
      "role-custom",
    ]);
    expect(items[0]?.builtin).toBe(true);
    expect(items[2]?.id).toBe("admin");
    expect(items[2]?.usageCount).toBe(2);
    expect(items[4]?.builtin).toBe(false);
    expect(items[4]?.usageCount).toBe(1);
  });

  it("reads a base role and a custom role by id", async () => {
    const store = createInMemoryRolesStore({
      roles: [{ id: "role-custom", name: "Custom", include: [], exclude: [], builtin: false }],
    });
    const routes = createRolesRoutes(optionsFor(store));

    const base = asView(
      (await invoke(routes, "GET", ROLE_ITEM_PATH, { params: { id: "editor" } })).body,
    );
    expect(base.builtin).toBe(true);
    expect(base.include).toEqual(["*.Read", "*.ReadWrite"]);

    const custom = asView(
      (await invoke(routes, "GET", ROLE_ITEM_PATH, { params: { id: "role-custom" } })).body,
    );
    expect(custom.builtin).toBe(false);

    await expect(
      invoke(routes, "GET", ROLE_ITEM_PATH, { params: { id: "role-missing" } }),
    ).rejects.toMatchObject({ status: 404 });
  });

  it("updates a custom role's patterns and audits when it gains Remediation.Apply", async () => {
    const store = createInMemoryRolesStore({
      roles: [{ id: "role-custom", name: "Custom", include: ["*.Read"], exclude: [], builtin: false }],
    });
    const audited: RoleAuditEvent[] = [];
    const routes = createRolesRoutes(
      optionsFor(store, {
        recordAudit: async (event) => {
          audited.push(event);
        },
      }),
    );

    const updated = asView(
      (
        await invoke(routes, "PATCH", ROLE_ITEM_PATH, {
          params: { id: "role-custom" },
          body: { include: ["Remediation.Apply"] },
        })
      ).body,
    );
    expect(updated.include).toEqual(["Remediation.Apply"]);
    expect(updated.superadminOnly).toBe(true);
    expect(audited).toHaveLength(1);
    expect(audited[0]?.action).toBe("roles.update");
  });

  it("rejects mutations targeting a builtin role with 409", async () => {
    const store = createInMemoryRolesStore();
    const routes = createRolesRoutes(optionsFor(store));

    await expect(
      invoke(routes, "PATCH", ROLE_ITEM_PATH, {
        params: { id: "editor" },
        body: { include: ["*"] },
      }),
    ).rejects.toMatchObject({ status: 409, code: ROLES_BUILTIN_IMMUTABLE });

    await expect(
      invoke(routes, "DELETE", ROLE_ITEM_PATH, { params: { id: "admin" } }),
    ).rejects.toMatchObject({ status: 409, code: ROLES_BUILTIN_IMMUTABLE });

    await expect(
      invoke(routes, "POST", ROLES_PATH, { body: { id: "superadmin", name: "Copy" } }),
    ).rejects.toMatchObject({ status: 409, code: ROLES_BUILTIN_IMMUTABLE });
  });

  it("blocks deleting a role in use and deletes one that is not", async () => {
    const store = createInMemoryRolesStore({
      roles: [
        { id: "role-free", name: "Free", include: [], exclude: [], builtin: false },
        { id: "role-used", name: "Used", include: [], exclude: [], builtin: false },
      ],
      usage: { "role-used": 2 },
    });
    const routes = createRolesRoutes(optionsFor(store));

    await expect(
      invoke(routes, "DELETE", ROLE_ITEM_PATH, { params: { id: "role-used" } }),
    ).rejects.toMatchObject({ status: 409, code: ROLES_IN_USE });

    const deleted = await invoke(routes, "DELETE", ROLE_ITEM_PATH, { params: { id: "role-free" } });
    expect(deleted.status).toBe(204);
    expect(await store.getRole("role-free")).toBeUndefined();
  });

  it("rejects a duplicate custom role id with 409", async () => {
    const store = createInMemoryRolesStore({
      roles: [{ id: "role-taken", name: "Taken", include: [], exclude: [], builtin: false }],
    });
    const routes = createRolesRoutes(optionsFor(store));

    await expect(
      invoke(routes, "POST", ROLES_PATH, { body: { id: "role-taken", name: "Again" } }),
    ).rejects.toMatchObject({ status: 409, code: ROLES_ID_CONFLICT });
  });

  it("clones a base role into a custom one with the same patterns", async () => {
    const store = createInMemoryRolesStore();
    const routes = createRolesRoutes(optionsFor(store));

    const cloned = asView(
      (await invoke(routes, "POST", ROLE_CLONE_PATH, { params: { id: "editor" } })).body,
    );
    expect(cloned.id).not.toBe("editor");
    expect(cloned.name).toBe("editor (copy)");
    expect(cloned.builtin).toBe(false);
    expect(cloned.include).toEqual(["*.Read", "*.ReadWrite"]);
    expect(cloned.exclude).toEqual(["CIPP.Admin.*", "CIPP.SuperAdmin.*", "CIPP.AppSettings.*", "Remediation.Apply"]);
    expect(cloned.superadminOnly).toBe(false);

    const renamed = asView(
      (
        await invoke(routes, "POST", ROLE_CLONE_PATH, {
          params: { id: "editor" },
          body: { name: "Editor Copy" },
        })
      ).body,
    );
    expect(renamed.name).toBe("Editor Copy");
    expect(renamed.builtin).toBe(false);

    await expect(
      invoke(routes, "POST", ROLE_CLONE_PATH, { params: { id: "role-missing" } }),
    ).rejects.toMatchObject({ status: 404 });
  });

  it("audits a clone that grants Remediation.Apply and flags it superadmin-only", async () => {
    const store = createInMemoryRolesStore();
    const audited: RoleAuditEvent[] = [];
    const routes = createRolesRoutes(
      optionsFor(store, {
        recordAudit: async (event) => {
          audited.push(event);
        },
      }),
    );

    const cloned = asView(
      (await invoke(routes, "POST", ROLE_CLONE_PATH, { params: { id: "superadmin" } })).body,
    );
    expect(cloned.superadminOnly).toBe(true);
    expect(cloned.include).toEqual(["*"]);
    expect(audited).toHaveLength(1);
    expect(audited[0]).toMatchObject({
      action: "roles.create",
      roleId: cloned.id,
      superadminOnly: true,
      actorUserId: "admin-1",
      correlationId: "corr-roles",
    });

    const plain = asView(
      (await invoke(routes, "POST", ROLE_CLONE_PATH, { params: { id: "editor" } })).body,
    );
    expect(plain.superadminOnly).toBe(false);
    expect(audited).toHaveLength(1);
  });

  it("previews effective permissions through the T-0743 include/exclude resolution", async () => {
    const store = createInMemoryRolesStore();
    const routes = createRolesRoutes(optionsFor(store));

    const readOnly = (await invoke(routes, "POST", ROLE_PREVIEW_PATH, {
      body: { include: ["*.Read"] },
    })).body as { permissions: string[] };
    expect(readOnly.permissions).toContain("Tenant.Runs.Read");
    expect(readOnly.permissions).toContain("CIPP.ApiClients.Read");
    expect(readOnly.permissions).not.toContain("Tenant.Runs.ReadWrite");
    expect(readOnly.permissions).not.toContain("Remediation.Apply");

    const wildcard = (await invoke(routes, "POST", ROLE_PREVIEW_PATH, {
      body: { include: ["*"], exclude: ["Remediation.Apply"] },
    })).body as { permissions: string[] };
    expect(wildcard.permissions).toContain("Tenant.Runs.ReadWrite");
    expect(wildcard.permissions).not.toContain("Remediation.Apply");
  });

  it("resolves patterns and the superadmin flag through the shared T-0743 matcher", () => {
    const registry: readonly PermissionRegistryEntry[] = [
      { method: "GET", path: "/v1/things", permission: "Thing.Read" },
      { method: "POST", path: "/v1/things", permission: "Thing.ReadWrite" },
      { method: "POST", path: "/v1/things/apply", permission: "Remediation.Apply" },
    ];

    expect(resolveRolePermissions(["*.Read"], [], registry)).toEqual(["Thing.Read"]);
    expect(resolveRolePermissions(["*"], ["Remediation.Apply"], registry)).toEqual([
      "Thing.Read",
      "Thing.ReadWrite",
    ]);
    expect(resolveRolePermissions(["Remediation.*"], ["Remediation.Apply"], registry)).toEqual([]);

    expect(isSuperadminOnlyRole(["Remediation.Apply"], [])).toBe(true);
    expect(isSuperadminOnlyRole(["*"], [])).toBe(true);
    expect(isSuperadminOnlyRole(["Remediation.*"], ["Remediation.Apply"])).toBe(false);
    expect(isSuperadminOnlyRole(["*.Read"], [])).toBe(false);
  });

  it("rejects unauthenticated requests and callers missing the roles permissions", async () => {
    const store = createInMemoryRolesStore();
    const routes = createRolesRoutes(optionsFor(store, { resolveCaller: () => undefined }));

    await expect(invoke(routes, "GET", ROLES_PATH)).rejects.toMatchObject({ status: 401 });
    await expect(invoke(routes, "POST", ROLES_PATH, { body: { name: "X" } })).rejects.toMatchObject({
      status: 401,
    });

    const readOnlyRoutes = createRolesRoutes(
      optionsFor(store, { resolveCaller: () => callerWith([READ]) }),
    );
    await expect(
      invoke(readOnlyRoutes, "POST", ROLES_PATH, { body: { name: "X" } }),
    ).rejects.toMatchObject({ status: 403 });
    await expect(
      invoke(readOnlyRoutes, "POST", ROLE_PREVIEW_PATH, { body: { include: ["*"] } }),
    ).resolves.toMatchObject({ status: 200 });
  });

  it("validates the create, patch, and preview bodies", async () => {
    const store = createInMemoryRolesStore({
      roles: [{ id: "role-x", name: "X", include: [], exclude: [], builtin: false }],
    });
    const routes = createRolesRoutes(optionsFor(store));

    await expect(invoke(routes, "POST", ROLES_PATH, { body: { include: [] } })).rejects.toMatchObject({
      status: 400,
    });
    await expect(
      invoke(routes, "POST", ROLES_PATH, { body: { name: "X", include: ["*.Read", ""] } }),
    ).rejects.toMatchObject({ status: 400 });
    await expect(
      invoke(routes, "PATCH", ROLE_ITEM_PATH, {
        params: { id: "role-x" },
        body: { include: "*.Read" },
      }),
    ).rejects.toMatchObject({ status: 400 });
    await expect(
      invoke(routes, "POST", ROLE_PREVIEW_PATH, { body: { include: [7] } }),
    ).rejects.toMatchObject({ status: 400 });
  });

  it("publishes every operation through the OpenAPI fragment", () => {
    expect(ROLES_OPENAPI.paths["/roles"]).toHaveProperty("get");
    expect(ROLES_OPENAPI.paths["/roles"]).toHaveProperty("post");
    expect(ROLES_OPENAPI.paths["/roles/{id}"]).toHaveProperty("get");
    expect(ROLES_OPENAPI.paths["/roles/{id}"]).toHaveProperty("patch");
    expect(ROLES_OPENAPI.paths["/roles/{id}"]).toHaveProperty("delete");
    expect(ROLES_OPENAPI.paths["/roles/{id}/clone"]).toHaveProperty("post");
    expect(ROLES_OPENAPI.paths["/roles/preview"]).toHaveProperty("post");
  });
});
