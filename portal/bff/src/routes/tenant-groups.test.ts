import { describe, expect, it } from "vitest";
import { AppError } from "../errors.js";
import type { FilterTenantSnapshot } from "../domain/tenant-group-filter.js";
import { ALL_TENANTS, tenantScope } from "../rbac/scope.js";
import type { Route, RouteHandler, RouteResponse } from "../server.js";
import {
  TENANT_GROUPS_PATH,
  TENANT_GROUP_MEMBER_PATH,
  TENANT_GROUP_MEMBERS_PATH,
  TENANT_GROUP_PATH,
  TENANT_GROUP_PERMISSIONS,
  TENANT_GROUP_PREVIEW_PATH,
  TENANT_GROUPS_OPENAPI,
  createTenantGroupRoutes,
  type TenantGroupAuditInput,
  type TenantGroupAuditRecord,
  type TenantGroupCaller,
  type TenantGroupMembership,
  type TenantGroupRecord,
  type TenantGroupRouteOptions,
  type TenantGroupStore,
} from "./tenant-groups.js";

const NOW = "2026-06-01T00:00:00.000Z";

class MemoryTenantGroupStore implements TenantGroupStore {
  readonly groups = new Map<string, TenantGroupRecord>();
  readonly members = new Map<string, Map<string, TenantGroupMembership>>();
  candidates: FilterTenantSnapshot[] = [];
  readonly events: TenantGroupAuditInput[] = [];

  async listGroups(options: { includeDeleted?: boolean } = {}): Promise<TenantGroupRecord[]> {
    return [...this.groups.values()]
      .filter((group) => options.includeDeleted === true || group.deletedAt === null)
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt))
      .map((group) => ({ ...group }));
  }

  async getGroup(
    groupId: string,
    options: { includeDeleted?: boolean } = {},
  ): Promise<TenantGroupRecord | undefined> {
    const found = this.groups.get(groupId);
    if (found === undefined) return undefined;
    if (options.includeDeleted !== true && found.deletedAt !== null) return undefined;
    return { ...found };
  }

  async upsertGroup(input: TenantGroupRecord): Promise<TenantGroupRecord> {
    const stored = { ...input };
    this.groups.set(stored.id, stored);
    return { ...stored };
  }

  async softDeleteGroup(groupId: string, options: { now?: string } = {}): Promise<boolean> {
    const found = this.groups.get(groupId);
    if (found === undefined || found.deletedAt !== null) return false;
    const at = options.now ?? NOW;
    this.groups.set(groupId, { ...found, deletedAt: at, updatedAt: at });
    return true;
  }

  async listMembers(groupId: string): Promise<TenantGroupMembership[]> {
    return [...(this.members.get(groupId)?.values() ?? [])].map((member) => ({ ...member }));
  }

  async addMember(input: TenantGroupMembership): Promise<TenantGroupMembership> {
    let rows = this.members.get(input.groupId);
    if (rows === undefined) {
      rows = new Map();
      this.members.set(input.groupId, rows);
    }
    const stored = { ...input };
    rows.set(stored.tenantId, stored);
    return { ...stored };
  }

  async removeMember(groupId: string, tenantId: string): Promise<boolean> {
    return this.members.get(groupId)?.delete(tenantId) ?? false;
  }

  async listCandidates(): Promise<FilterTenantSnapshot[]> {
    return this.candidates.map((candidate) => ({ ...candidate }));
  }

  async appendAuditEvent(input: TenantGroupAuditInput): Promise<TenantGroupAuditRecord> {
    this.events.push(input);
    return { ...input, createdAt: input.timestamp };
  }
}

function seedCandidates(store: MemoryTenantGroupStore): void {
  store.candidates = [
    { id: "tenant-a", skus: ["ENTERPRISEPREMIUM"], variables: { tier: "gold" } },
    { id: "tenant-b", skus: ["EMS"], variables: { tier: "silver" } },
  ];
}

function adminCaller(): TenantGroupCaller {
  return { roles: ["admin"], tenantScope: ALL_TENANTS, userId: "operator-1" };
}

function scopedCaller(tenantIds: string[]): TenantGroupCaller {
  return { roles: ["operator"], tenantScope: tenantScope(tenantIds), userId: "operator-2" };
}

interface Harness {
  routes: Route[];
  store: MemoryTenantGroupStore;
  seenPermissions: string[];
}

function harness(overrides: Partial<TenantGroupRouteOptions> = {}): Harness {
  const store = new MemoryTenantGroupStore();
  seedCandidates(store);
  const seenPermissions: string[] = [];
  const routes = createTenantGroupRoutes({
    store,
    resolveCaller: () => adminCaller(),
    authorize: (caller, permission) => {
      void caller;
      seenPermissions.push(permission);
    },
    now: () => NOW,
    ...overrides,
  });
  return { routes, store, seenPermissions };
}

interface TestContext {
  correlationId: string;
  method: string;
  path: string;
  query: URLSearchParams;
  headers: Record<string, string>;
  params: Record<string, string>;
  body?: unknown;
}

type HandlerContext = Parameters<RouteHandler>[0];

function context(overrides: Partial<TestContext> = {}): HandlerContext {
  return {
    correlationId: "corr-test",
    method: "GET",
    path: TENANT_GROUPS_PATH,
    query: new URLSearchParams(),
    headers: {},
    params: {},
    ...overrides,
  } as unknown as HandlerContext;
}

function findRoute(routes: readonly Route[], method: string, path: string): RouteHandler {
  const route = routes.find((candidate) => candidate.method === method && candidate.path === path);
  if (route === undefined) {
    throw new Error(`no route registered for ${method} ${path}`);
  }
  return route.handler;
}

function invoke(
  routes: readonly Route[],
  method: string,
  path: string,
  overrides: Partial<TestContext> = {},
): Promise<RouteResponse> {
  return Promise.resolve(
    findRoute(routes, method, path)(context({ method, path, ...overrides })),
  );
}

async function createGroup(
  value: Harness,
  body: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const response = await invoke(value.routes, "POST", TENANT_GROUPS_PATH, { body });
  expect(response.status).toBe(201);
  return response.body as Record<string, unknown>;
}

describe("tenant-group routes", () => {
  it("creates a static group and reads it back", async () => {
    const value = harness();
    const created = await createGroup(value, { id: "group-1", name: "Gold", kind: "static" });
    expect(created).toMatchObject({ id: "group-1", name: "Gold", kind: "static", filter: null });

    const response = await invoke(value.routes, "GET", TENANT_GROUP_PATH, {
      params: { id: "group-1" },
    });
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ id: "group-1", name: "Gold" });
  });

  it("rejects a dynamic group without a filter and with an unsupported expression", async () => {
    const value = harness();
    await expect(
      invoke(value.routes, "POST", TENANT_GROUPS_PATH, {
        body: { name: "Dyn", kind: "dynamic" },
      }),
    ).rejects.toMatchObject({ status: 400 });

    const attempt = invoke(value.routes, "POST", TENANT_GROUPS_PATH, {
      body: { name: "Dyn", kind: "dynamic", filter: { expression: "sku contains 'EMS'" } },
    });
    await expect(attempt).rejects.toMatchObject({
      code: "tenant-group.unsupported_filter",
      status: 400,
    });
  });

  it("rejects a static group carrying a filter", async () => {
    const value = harness();
    await expect(
      invoke(value.routes, "POST", TENANT_GROUPS_PATH, {
        body: { name: "Mixed", kind: "static", filter: { sku: "EMS" } },
      }),
    ).rejects.toMatchObject({ status: 400 });
  });

  it("adds and removes static members and returns the correct member set", async () => {
    const value = harness();
    await createGroup(value, { id: "group-1", name: "Gold", kind: "static" });

    const added = await invoke(value.routes, "POST", TENANT_GROUP_MEMBERS_PATH, {
      method: "POST",
      params: { id: "group-1" },
      body: { tenantId: "tenant-a" },
    });
    expect(added.status).toBe(201);

    const listed = (await invoke(value.routes, "GET", TENANT_GROUP_MEMBERS_PATH, {
      params: { id: "group-1" },
    })).body as { items: string[] };
    expect(listed.items).toEqual(["tenant-a"]);

    const removed = await invoke(value.routes, "DELETE", TENANT_GROUP_MEMBER_PATH, {
      method: "DELETE",
      params: { id: "group-1", tenantId: "tenant-a" },
    });
    expect(removed.status).toBe(204);

    const after = (await invoke(value.routes, "GET", TENANT_GROUP_MEMBERS_PATH, {
      params: { id: "group-1" },
    })).body as { items: string[] };
    expect(after.items).toEqual([]);
  });

  it("resolves dynamic members from the filter and previews them", async () => {
    const value = harness();
    await createGroup(value, {
      id: "group-dyn",
      name: "Premium",
      kind: "dynamic",
      filter: { sku: "ENTERPRISEPREMIUM" },
    });

    const members = (await invoke(value.routes, "GET", TENANT_GROUP_MEMBERS_PATH, {
      params: { id: "group-dyn" },
    })).body as { items: string[] };
    expect(members.items).toEqual(["tenant-a"]);

    const preview = (await invoke(value.routes, "GET", TENANT_GROUP_PREVIEW_PATH, {
      params: { id: "group-dyn" },
    })).body as { items: string[]; total: number };
    expect(preview).toEqual({ items: ["tenant-a"], total: 1 });

    await createGroup(value, {
      id: "group-var",
      name: "Silver tier",
      kind: "dynamic",
      filter: { variable: "tier", value: "silver" },
    });
    const variablePreview = (await invoke(value.routes, "GET", TENANT_GROUP_PREVIEW_PATH, {
      params: { id: "group-var" },
    })).body as { items: string[]; total: number };
    expect(variablePreview).toEqual({ items: ["tenant-b"], total: 1 });
  });

  it("refuses static membership writes on dynamic groups", async () => {
    const value = harness();
    await createGroup(value, {
      id: "group-dyn",
      name: "Premium",
      kind: "dynamic",
      filter: { sku: "ENTERPRISEPREMIUM" },
    });

    await expect(
      invoke(value.routes, "POST", TENANT_GROUP_MEMBERS_PATH, {
        method: "POST",
        params: { id: "group-dyn" },
        body: { tenantId: "tenant-b" },
      }),
    ).rejects.toMatchObject({ code: "tenant-group.dynamic_group", status: 400 });

    await expect(
      invoke(value.routes, "DELETE", TENANT_GROUP_MEMBER_PATH, {
        method: "DELETE",
        params: { id: "group-dyn", tenantId: "tenant-a" },
      }),
    ).rejects.toMatchObject({ code: "tenant-group.dynamic_group", status: 400 });
  });

  it("scopes membership to the caller and refuses out-of-scope tenants", async () => {
    const value = harness({ resolveCaller: () => scopedCaller(["tenant-a"]) });
    await createGroup(value, { id: "group-1", name: "Gold", kind: "static" });

    const denied = invoke(value.routes, "POST", TENANT_GROUP_MEMBERS_PATH, {
      method: "POST",
      params: { id: "group-1" },
      body: { tenantId: "tenant-b" },
    });
    await expect(denied).rejects.toMatchObject({ code: "auth.forbidden", status: 403 });
    expect(await value.store.listMembers("group-1")).toHaveLength(0);

    await invoke(value.routes, "POST", TENANT_GROUP_MEMBERS_PATH, {
      method: "POST",
      params: { id: "group-1" },
      body: { tenantId: "tenant-a" },
    });
    await value.store.addMember({
      groupId: "group-1",
      tenantId: "tenant-b",
      createdAt: NOW,
      updatedAt: NOW,
    });

    const listed = (await invoke(value.routes, "GET", TENANT_GROUP_MEMBERS_PATH, {
      params: { id: "group-1" },
    })).body as { items: string[] };
    expect(listed.items).toEqual(["tenant-a"]);
  });

  it("requires authentication for every endpoint", async () => {
    const value = harness({ resolveCaller: () => undefined });
    await expect(invoke(value.routes, "GET", TENANT_GROUPS_PATH, {})).rejects.toMatchObject({
      status: 401,
    });
    await expect(
      invoke(value.routes, "POST", TENANT_GROUPS_PATH, { body: { name: "x", kind: "static" } }),
    ).rejects.toMatchObject({ status: 401 });
    await expect(
      invoke(value.routes, "GET", TENANT_GROUP_PREVIEW_PATH, { params: { id: "group-1" } }),
    ).rejects.toMatchObject({ status: 401 });
  });

  it("returns a structured 404 for unknown groups, tenants, and memberships", async () => {
    const value = harness();
    await expect(
      invoke(value.routes, "GET", TENANT_GROUP_PATH, { params: { id: "missing" } }),
    ).rejects.toMatchObject({ code: "tenant-group.not_found", status: 404 });

    await createGroup(value, { id: "group-1", name: "Gold", kind: "static" });
    await expect(
      invoke(value.routes, "POST", TENANT_GROUP_MEMBERS_PATH, {
        method: "POST",
        params: { id: "group-1" },
        body: { tenantId: "tenant-unknown" },
      }),
    ).rejects.toMatchObject({ code: "tenant.not_found", status: 404 });

    await expect(
      invoke(value.routes, "DELETE", TENANT_GROUP_MEMBER_PATH, {
        method: "DELETE",
        params: { id: "group-1", tenantId: "tenant-a" },
      }),
    ).rejects.toMatchObject({ code: "tenant-group.member_not_found", status: 404 });
  });

  it("renames a group, replaces a dynamic filter, and soft-deletes", async () => {
    const value = harness();
    await createGroup(value, {
      id: "group-dyn",
      name: "Before",
      kind: "dynamic",
      filter: { sku: "EMS" },
    });

    const renamed = await invoke(value.routes, "PATCH", TENANT_GROUP_PATH, {
      method: "PATCH",
      params: { id: "group-dyn" },
      body: { name: "After" },
    });
    expect(renamed.body).toMatchObject({ name: "After", filterSummary: "SKU = EMS" });

    const refiltered = await invoke(value.routes, "PATCH", TENANT_GROUP_PATH, {
      method: "PATCH",
      params: { id: "group-dyn" },
      body: { filter: { variable: "tier", value: "gold" } },
    });
    expect(refiltered.body).toMatchObject({ filterSummary: "%tier% = gold" });

    await expect(
      invoke(value.routes, "PATCH", TENANT_GROUP_PATH, {
        method: "PATCH",
        params: { id: "group-dyn" },
        body: { kind: "static" },
      }),
    ).rejects.toMatchObject({ status: 400 });

    const deleted = await invoke(value.routes, "DELETE", TENANT_GROUP_PATH, {
      method: "DELETE",
      params: { id: "group-dyn" },
    });
    expect(deleted.status).toBe(204);
    await expect(
      invoke(value.routes, "GET", TENANT_GROUP_PATH, { params: { id: "group-dyn" } }),
    ).rejects.toMatchObject({ code: "tenant-group.not_found", status: 404 });
  });

  it("writes an audit event for every mutation", async () => {
    const value = harness();
    await createGroup(value, { id: "group-1", name: "Gold", kind: "static" });
    await invoke(value.routes, "PATCH", TENANT_GROUP_PATH, {
      method: "PATCH",
      params: { id: "group-1" },
      body: { name: "Gold renamed" },
    });
    await invoke(value.routes, "POST", TENANT_GROUP_MEMBERS_PATH, {
      method: "POST",
      params: { id: "group-1" },
      body: { tenantId: "tenant-a" },
    });
    await invoke(value.routes, "DELETE", TENANT_GROUP_MEMBER_PATH, {
      method: "DELETE",
      params: { id: "group-1", tenantId: "tenant-a" },
    });
    await invoke(value.routes, "DELETE", TENANT_GROUP_PATH, {
      method: "DELETE",
      params: { id: "group-1" },
    });

    expect(value.store.events.map((event) => event.action)).toEqual([
      "tenant-group.create",
      "tenant-group.update",
      "tenant-group.member.add",
      "tenant-group.member.remove",
      "tenant-group.delete",
    ]);
    for (const event of value.store.events) {
      expect(event).toMatchObject({
        actorUserId: "operator-1",
        actorType: "user",
        targetType: "tenant-group",
        targetId: "group-1",
        result: "success",
        source: "request",
        correlationId: "corr-test",
      });
    }
    const memberAdd = value.store.events[2]!;
    expect(memberAdd.tenantId).toBe("tenant-a");
    expect(value.store.events[0]!.tenantId).toBeNull();
  });

  it("consults the injected authorizer with the group permissions", async () => {
    const value = harness();
    await createGroup(value, { id: "group-1", name: "Gold", kind: "static" });
    await invoke(value.routes, "GET", TENANT_GROUP_PATH, { params: { id: "group-1" } });
    expect(value.seenPermissions).toContain(TENANT_GROUP_PERMISSIONS.read);
    expect(value.seenPermissions).toContain(TENANT_GROUP_PERMISSIONS.write);

    const denied = harness({
      authorize: () => {
        throw new AppError("auth.denied", "forbidden", 403);
      },
    });
    await expect(
      invoke(denied.routes, "POST", TENANT_GROUPS_PATH, { body: { name: "x", kind: "static" } }),
    ).rejects.toMatchObject({ status: 403 });
  });

  it("publishes OpenAPI path items for CRUD, membership, and preview", () => {
    expect(TENANT_GROUPS_OPENAPI.paths["/tenant-groups"]).toHaveProperty("get");
    expect(TENANT_GROUPS_OPENAPI.paths["/tenant-groups"]).toHaveProperty("post");
    expect(TENANT_GROUPS_OPENAPI.paths["/tenant-groups/{id}"]).toHaveProperty("patch");
    expect(TENANT_GROUPS_OPENAPI.paths["/tenant-groups/{id}"]).toHaveProperty("delete");
    expect(TENANT_GROUPS_OPENAPI.paths["/tenant-groups/{id}/members"]).toHaveProperty("post");
    expect(TENANT_GROUPS_OPENAPI.paths["/tenant-groups/{id}/members/{tenantId}"]).toHaveProperty(
      "delete",
    );
    expect(TENANT_GROUPS_OPENAPI.paths["/tenant-groups/{id}/preview"]).toHaveProperty("get");
    expect(TENANT_GROUPS_OPENAPI.schemas.TenantGroupCreate.required).toContain("kind");
  });
});
