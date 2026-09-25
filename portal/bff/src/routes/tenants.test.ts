import { describe, expect, it } from "vitest";
import { AppError } from "../errors.js";
import { ALL_TENANTS, tenantScope } from "../rbac/scope.js";
import type { Route, RouteHandler, RouteResponse } from "../server.js";
import {
  TENANT_PATH,
  TENANT_PERMISSIONS,
  TENANTS_OPENAPI,
  TENANTS_PATH,
  createTenantRoutes,
  type TenantAuditInput,
  type TenantAuditRecord,
  type TenantCaller,
  type TenantListOptions,
  type TenantRecord,
  type TenantRouteOptions,
  type TenantStore,
} from "./tenants.js";

const NOW = "2026-06-01T00:00:00.000Z";

class MemoryTenantStore implements TenantStore {
  readonly records = new Map<string, TenantRecord>();
  readonly members = new Map<string, Set<string>>();
  readonly events: TenantAuditInput[] = [];

  async listTenants(options: TenantListOptions = {}): Promise<TenantRecord[]> {
    return [...this.records.values()]
      .filter((tenant) => options.includeDeleted === true || tenant.deletedAt === null)
      .filter((tenant) => options.status === undefined || tenant.status === options.status)
      .filter((tenant) => options.source === undefined || tenant.source === options.source)
      .filter(
        (tenant) =>
          options.groupId === undefined ||
          this.members.get(options.groupId)?.has(tenant.id) === true,
      )
      .filter(
        (tenant) =>
          options.search === undefined ||
          tenant.id.includes(options.search) ||
          (tenant.displayName ?? "").includes(options.search),
      )
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt));
  }

  async getTenant(
    tenantId: string,
    options: { includeDeleted?: boolean } = {},
  ): Promise<TenantRecord | undefined> {
    const found = this.records.get(tenantId);
    if (found === undefined) return undefined;
    if (options.includeDeleted !== true && found.deletedAt !== null) return undefined;
    return { ...found };
  }

  async upsertTenant(input: TenantRecord): Promise<TenantRecord> {
    const stored = { ...input };
    this.records.set(stored.id, stored);
    return { ...stored };
  }

  async softDeleteTenant(tenantId: string, options: { now?: string } = {}): Promise<boolean> {
    const found = this.records.get(tenantId);
    if (found === undefined || found.deletedAt !== null) return false;
    const at = options.now ?? NOW;
    this.records.set(tenantId, { ...found, deletedAt: at, updatedAt: at });
    return true;
  }

  async appendAuditEvent(input: TenantAuditInput): Promise<TenantAuditRecord> {
    this.events.push(input);
    return { ...input, createdAt: input.timestamp };
  }
}

function record(id: string, extra: Partial<TenantRecord> = {}): TenantRecord {
  return {
    id,
    displayName: `Tenant ${id}`,
    defaultDomain: null,
    initialDomain: null,
    source: "direct",
    status: "active",
    excluded: false,
    excludeReason: null,
    excludeDate: null,
    environment: "global",
    lastRunAt: null,
    errorCount: 0,
    lastError: null,
    createdAt: NOW,
    updatedAt: NOW,
    deletedAt: null,
    ...extra,
  };
}

function adminCaller(): TenantCaller {
  return { roles: ["admin"], tenantScope: ALL_TENANTS, userId: "operator-1" };
}

function scopedCaller(tenantIds: string[]): TenantCaller {
  return { roles: ["operator"], tenantScope: tenantScope(tenantIds), userId: "operator-2" };
}

interface Harness {
  routes: Route[];
  store: MemoryTenantStore;
  seenPermissions: string[];
}

function harness(overrides: Partial<TenantRouteOptions> = {}): Harness {
  const store = new MemoryTenantStore();
  const seenPermissions: string[] = [];
  const routes = createTenantRoutes({
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
    path: TENANTS_PATH,
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

async function createTenant(
  value: Harness,
  body: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const response = await invoke(value.routes, "POST", TENANTS_PATH, { body });
  expect(response.status).toBe(201);
  return response.body as Record<string, unknown>;
}

describe("tenant routes", () => {
  it("creates a tenant and reads it back", async () => {
    const value = harness();
    const created = await createTenant(value, { id: "tenant-a", displayName: "Alpha" });
    expect(created).toMatchObject({
      id: "tenant-a",
      displayName: "Alpha",
      source: "direct",
      status: "active",
      excluded: false,
      errorCount: 0,
    });

    const response = await invoke(value.routes, "GET", TENANT_PATH, {
      params: { id: "tenant-a" },
    });
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ id: "tenant-a", displayName: "Alpha" });
  });

  it("rejects a duplicate create with a structured conflict", async () => {
    const value = harness();
    await createTenant(value, { id: "tenant-a" });
    await expect(
      invoke(value.routes, "POST", TENANTS_PATH, { body: { id: "tenant-a" } }),
    ).rejects.toMatchObject({ code: "tenant.conflict", status: 409 });
  });

  it("rejects a create without an id", async () => {
    const value = harness();
    await expect(
      invoke(value.routes, "POST", TENANTS_PATH, { body: { displayName: "No id" } }),
    ).rejects.toMatchObject({ status: 400 });
  });

  it("lists with status, source, group, and search filters plus pagination", async () => {
    const value = harness();
    await value.store.upsertTenant(record("tenant-a", { displayName: "Alpha" }));
    await value.store.upsertTenant(
      record("tenant-b", {
        displayName: "Beta",
        source: "gdap",
        status: "excluded",
        excluded: true,
        createdAt: "2026-06-02T00:00:00.000Z",
      }),
    );
    value.store.members.set("group-1", new Set(["tenant-a"]));

    const list = (query: URLSearchParams) =>
      invoke(value.routes, "GET", TENANTS_PATH, { query });

    const all = (await list(new URLSearchParams())).body as { items: TenantRecord[] };
    expect(all.items.map((tenant) => tenant.id)).toEqual(["tenant-a", "tenant-b"]);

    const byStatus = (await list(new URLSearchParams({ status: "excluded" }))).body as {
      items: TenantRecord[];
    };
    expect(byStatus.items.map((tenant) => tenant.id)).toEqual(["tenant-b"]);

    const bySource = (await list(new URLSearchParams({ source: "gdap" }))).body as {
      items: TenantRecord[];
    };
    expect(bySource.items.map((tenant) => tenant.id)).toEqual(["tenant-b"]);

    const byGroup = (await list(new URLSearchParams({ groupId: "group-1" }))).body as {
      items: TenantRecord[];
    };
    expect(byGroup.items.map((tenant) => tenant.id)).toEqual(["tenant-a"]);

    const bySearch = (await list(new URLSearchParams({ search: "Alpha" }))).body as {
      items: TenantRecord[];
    };
    expect(bySearch.items.map((tenant) => tenant.id)).toEqual(["tenant-a"]);

    const first = (await list(new URLSearchParams({ limit: "1" }))).body as {
      items: TenantRecord[];
      nextCursor: string | null;
    };
    expect(first.items).toHaveLength(1);
    expect(first.nextCursor).not.toBeNull();
    const second = (await list(
      new URLSearchParams({ limit: "1", cursor: first.nextCursor ?? "" }),
    )).body as { items: TenantRecord[]; nextCursor: string | null };
    expect(second.items).toHaveLength(1);
    expect(second.nextCursor).toBeNull();

    await expect(list(new URLSearchParams({ status: "bogus" }))).rejects.toMatchObject({
      status: 400,
    });
  });

  it("intersects list reads with the caller scope and never widens", async () => {
    const value = harness({ resolveCaller: () => scopedCaller(["tenant-a"]) });
    await value.store.upsertTenant(record("tenant-a"));
    await value.store.upsertTenant(record("tenant-b"));

    const response = await invoke(value.routes, "GET", TENANTS_PATH, {});
    const body = response.body as { items: TenantRecord[] };
    expect(body.items.map((tenant) => tenant.id)).toEqual(["tenant-a"]);
  });

  it("returns a structured 404 for an unknown tenant", async () => {
    const value = harness();
    await expect(
      invoke(value.routes, "GET", TENANT_PATH, { params: { id: "missing" } }),
    ).rejects.toMatchObject({ code: "tenant.not_found", status: 404 });
  });

  it("refuses an out-of-scope tenant without leaking its data", async () => {
    const value = harness({ resolveCaller: () => scopedCaller(["tenant-a"]) });
    await value.store.upsertTenant(record("tenant-b", { displayName: "Hidden Gem Tenant" }));

    const attempt = invoke(value.routes, "GET", TENANT_PATH, { params: { id: "tenant-b" } });
    await expect(attempt).rejects.toMatchObject({ code: "auth.forbidden", status: 403 });
    await expect(attempt).rejects.toSatisfy((error: AppError) => {
      expect(error.code).toBe("auth.forbidden");
      return !JSON.stringify(error).includes("Hidden Gem Tenant");
    });

    const patch = invoke(value.routes, "PATCH", TENANT_PATH, {
      params: { id: "tenant-b" },
      body: { displayName: "Rewritten" },
    });
    await expect(patch).rejects.toMatchObject({ code: "auth.forbidden", status: 403 });
    expect((await value.store.getTenant("tenant-b"))?.displayName).toBe("Hidden Gem Tenant");
  });

  it("requires authentication for every endpoint", async () => {
    const value = harness({ resolveCaller: () => undefined });
    await expect(invoke(value.routes, "GET", TENANTS_PATH, {})).rejects.toMatchObject({
      status: 401,
    });
    await expect(
      invoke(value.routes, "GET", TENANT_PATH, { params: { id: "tenant-a" } }),
    ).rejects.toMatchObject({ status: 401 });
    await expect(
      invoke(value.routes, "POST", TENANTS_PATH, { body: { id: "tenant-a" } }),
    ).rejects.toMatchObject({ status: 401 });
  });

  it("edits a tenant display name and rejects unknown fields", async () => {
    const value = harness();
    await createTenant(value, { id: "tenant-a", displayName: "Before" });

    const updated = await invoke(value.routes, "PATCH", TENANT_PATH, {
      method: "PATCH",
      params: { id: "tenant-a" },
      body: { displayName: "After" },
    });
    expect(updated.status).toBe(200);
    expect(updated.body).toMatchObject({ id: "tenant-a", displayName: "After" });

    await expect(
      invoke(value.routes, "PATCH", TENANT_PATH, {
        method: "PATCH",
        params: { id: "tenant-a" },
        body: { owner: "someone" },
      }),
    ).rejects.toMatchObject({ status: 400 });
  });

  it("round-trips exclude and include with reason and date", async () => {
    const value = harness();
    await createTenant(value, { id: "tenant-a" });

    const excluded = await invoke(value.routes, "PATCH", TENANT_PATH, {
      method: "PATCH",
      params: { id: "tenant-a" },
      body: { excluded: true, excludeReason: "migration hold" },
    });
    expect(excluded.body).toMatchObject({
      excluded: true,
      excludeReason: "migration hold",
      excludeDate: NOW,
      status: "excluded",
    });

    const fetched = await invoke(value.routes, "GET", TENANT_PATH, {
      params: { id: "tenant-a" },
    });
    expect(fetched.body).toMatchObject({
      excluded: true,
      excludeReason: "migration hold",
      excludeDate: NOW,
    });

    const included = await invoke(value.routes, "PATCH", TENANT_PATH, {
      method: "PATCH",
      params: { id: "tenant-a" },
      body: { excluded: false },
    });
    expect(included.body).toMatchObject({
      excluded: false,
      excludeReason: null,
      excludeDate: null,
      status: "active",
    });
  });

  it("increments errorCount on failed connects and flips status at the threshold", async () => {
    const value = harness({ errorThreshold: 3 });
    await createTenant(value, { id: "tenant-a" });

    const fail = () =>
      invoke(value.routes, "PATCH", TENANT_PATH, {
        method: "PATCH",
        params: { id: "tenant-a" },
        body: { recordConnectFailure: true, lastError: "token expired" },
      });

    expect((await fail()).body).toMatchObject({ errorCount: 1, status: "active" });
    expect((await fail()).body).toMatchObject({ errorCount: 2, status: "active" });
    const third = await fail();
    expect(third.body).toMatchObject({
      errorCount: 3,
      status: "error",
      lastError: "token expired",
    });

    await expect(
      invoke(value.routes, "PATCH", TENANT_PATH, {
        method: "PATCH",
        params: { id: "tenant-a" },
        body: { recordConnectFailure: true, recordConnectSuccess: true },
      }),
    ).rejects.toMatchObject({ status: 400 });
  });

  it("resets the error state on a successful connect", async () => {
    const value = harness({ errorThreshold: 1 });
    await createTenant(value, { id: "tenant-a" });
    await invoke(value.routes, "PATCH", TENANT_PATH, {
      method: "PATCH",
      params: { id: "tenant-a" },
      body: { recordConnectFailure: true, lastError: "boom" },
    });

    const recovered = await invoke(value.routes, "PATCH", TENANT_PATH, {
      method: "PATCH",
      params: { id: "tenant-a" },
      body: { recordConnectSuccess: true },
    });
    expect(recovered.body).toMatchObject({ errorCount: 0, lastError: null, status: "active" });
  });

  it("soft-deletes a tenant and hides it from reads", async () => {
    const value = harness();
    await createTenant(value, { id: "tenant-a" });

    const deleted = await invoke(value.routes, "DELETE", TENANT_PATH, {
      method: "DELETE",
      params: { id: "tenant-a" },
    });
    expect(deleted.status).toBe(204);

    await expect(
      invoke(value.routes, "GET", TENANT_PATH, { params: { id: "tenant-a" } }),
    ).rejects.toMatchObject({ code: "tenant.not_found", status: 404 });
    const listed = (await invoke(value.routes, "GET", TENANTS_PATH, {})).body as {
      items: TenantRecord[];
    };
    expect(listed.items).toHaveLength(0);
    expect(
      (await value.store.getTenant("tenant-a", { includeDeleted: true }))?.deletedAt,
    ).toBe(NOW);

    await expect(
      invoke(value.routes, "DELETE", TENANT_PATH, {
        method: "DELETE",
        params: { id: "tenant-a" },
      }),
    ).rejects.toMatchObject({ code: "tenant.not_found", status: 404 });
  });

  it("writes an audit event for every mutation", async () => {
    const value = harness();
    await createTenant(value, { id: "tenant-a" });
    await invoke(value.routes, "PATCH", TENANT_PATH, {
      method: "PATCH",
      params: { id: "tenant-a" },
      body: { excluded: true, excludeReason: "hold" },
    });
    await invoke(value.routes, "DELETE", TENANT_PATH, {
      method: "DELETE",
      params: { id: "tenant-a" },
    });

    expect(value.store.events.map((event) => event.action)).toEqual([
      "tenant.create",
      "tenant.exclude",
      "tenant.delete",
    ]);
    for (const event of value.store.events) {
      expect(event).toMatchObject({
        actorUserId: "operator-1",
        actorType: "user",
        tenantId: "tenant-a",
        targetType: "tenant",
        targetId: "tenant-a",
        result: "success",
        source: "request",
        correlationId: "corr-test",
      });
    }
    const exclude = value.store.events[1]!;
    expect((exclude.before as Record<string, unknown>)?.["excluded"]).toBe(false);
    expect((exclude.after as Record<string, unknown>)?.["excluded"]).toBe(true);
  });

  it("consults the injected authorizer with the tenant permissions", async () => {
    const value = harness();
    await createTenant(value, { id: "tenant-a" });
    await invoke(value.routes, "GET", TENANT_PATH, { params: { id: "tenant-a" } });
    expect(value.seenPermissions).toContain(TENANT_PERMISSIONS.read);
    expect(value.seenPermissions).toContain(TENANT_PERMISSIONS.write);

    const denied = harness({
      authorize: () => {
        throw new AppError("auth.denied", "forbidden", 403);
      },
    });
    await expect(
      invoke(denied.routes, "POST", TENANTS_PATH, { body: { id: "tenant-a" } }),
    ).rejects.toMatchObject({ status: 403 });
  });

  it("publishes OpenAPI path items for all five operations", () => {
    expect(TENANTS_OPENAPI.paths["/tenants"]).toHaveProperty("get");
    expect(TENANTS_OPENAPI.paths["/tenants"]).toHaveProperty("post");
    expect(TENANTS_OPENAPI.paths["/tenants/{id}"]).toHaveProperty("get");
    expect(TENANTS_OPENAPI.paths["/tenants/{id}"]).toHaveProperty("patch");
    expect(TENANTS_OPENAPI.paths["/tenants/{id}"]).toHaveProperty("delete");
    expect(TENANTS_OPENAPI.schemas.TenantUpdate.properties).toHaveProperty("excluded");
    expect(TENANTS_OPENAPI.schemas.TenantUpdate.properties).toHaveProperty(
      "recordConnectFailure",
    );
    expect(TENANTS_OPENAPI.schemas.TenantCreate.required).toContain("id");
  });
});
