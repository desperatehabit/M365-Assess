import { describe, expect, it } from "vitest";
import { ALL_TENANTS, tenantScope } from "../rbac/scope.js";
import type { Route, RouteHandler, RouteResponse } from "../server.js";
import {
  TENANT_VARIABLES_OPENAPI,
  TENANT_VARIABLES_PATH,
  TENANT_VARIABLE_PATH,
  TENANT_VARIABLE_PERMISSIONS,
  TENANT_VARIABLE_SECRET_MASK,
  createTenantVariableRoutes,
  type TenantVariableAuditInput,
  type TenantVariableAuditRecord,
  type TenantVariableCaller,
  type TenantVariableRecord,
  type TenantVariableRouteOptions,
  type TenantVariableStore,
} from "./tenant-variables.js";

const NOW = "2026-06-01T00:00:00.000Z";
const SECRET_VALUE = "s3cr3t-value";

class MemoryTenantVariableStore implements TenantVariableStore {
  readonly variables = new Map<string, TenantVariableRecord>();
  readonly events: TenantVariableAuditInput[] = [];

  async getVariable(variableId: string): Promise<TenantVariableRecord | undefined> {
    const found = this.variables.get(variableId);
    return found === undefined ? undefined : { ...found };
  }

  async listVariables(): Promise<TenantVariableRecord[]> {
    return [...this.variables.values()].map((variable) => ({ ...variable }));
  }

  async upsertVariable(input: TenantVariableRecord): Promise<TenantVariableRecord> {
    const stored = { ...input };
    this.variables.set(stored.id, stored);
    return { ...stored };
  }

  async deleteVariable(variableId: string): Promise<boolean> {
    return this.variables.delete(variableId);
  }

  async appendAuditEvent(input: TenantVariableAuditInput): Promise<TenantVariableAuditRecord> {
    this.events.push(input);
    return { ...input, createdAt: input.timestamp };
  }
}

function adminCaller(): TenantVariableCaller {
  return { roles: ["admin"], tenantScope: ALL_TENANTS, userId: "operator-1" };
}

function scopedCaller(tenantIds: string[]): TenantVariableCaller {
  return { roles: ["operator"], tenantScope: tenantScope(tenantIds), userId: "operator-2" };
}

interface Harness {
  routes: Route[];
  store: MemoryTenantVariableStore;
  seenPermissions: string[];
}

function harness(overrides: Partial<TenantVariableRouteOptions> = {}): Harness {
  const store = new MemoryTenantVariableStore();
  const seenPermissions: string[] = [];
  const routes = createTenantVariableRoutes({
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
    path: TENANT_VARIABLES_PATH,
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

async function createVariable(
  value: Harness,
  body: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const response = await invoke(value.routes, "POST", TENANT_VARIABLES_PATH, { body });
  expect(response.status).toBe(201);
  return response.body as Record<string, unknown>;
}

function auditAndBodiesContainNoSecret(value: Harness, bodies: unknown[]): void {
  const serialized = JSON.stringify([...bodies, ...value.store.events]);
  expect(serialized).not.toContain(SECRET_VALUE);
}

describe("tenant-variable routes", () => {
  it("creates a tenant variable and reads it back", async () => {
    const value = harness();
    const created = await createVariable(value, {
      id: "var-1",
      name: "tier",
      value: "gold",
      tenantId: "tenant-a",
    });
    expect(created).toMatchObject({ id: "var-1", tenantId: "tenant-a", name: "tier", value: "gold" });

    const response = await invoke(value.routes, "GET", TENANT_VARIABLE_PATH, {
      params: { id: "var-1" },
    });
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ id: "var-1", name: "tier", value: "gold" });
  });

  it("creates a global variable when tenantId is omitted", async () => {
    const value = harness();
    const created = await createVariable(value, { id: "var-g", name: "region", value: "eu" });
    expect(created).toMatchObject({ tenantId: null, name: "region" });
  });

  it("masks secret values in every response and audit record", async () => {
    const value = harness();
    const created = await createVariable(value, {
      id: "var-s",
      name: "api-key",
      value: SECRET_VALUE,
      tenantId: "tenant-a",
      isSecret: true,
    });
    expect(created).toMatchObject({ value: TENANT_VARIABLE_SECRET_MASK, isSecret: true });

    const listed = (await invoke(value.routes, "GET", TENANT_VARIABLES_PATH, {})).body as {
      items: Array<Record<string, unknown>>;
    };
    expect(listed.items).toHaveLength(1);
    expect(listed.items[0]).toMatchObject({ value: TENANT_VARIABLE_SECRET_MASK });

    const updated = await invoke(value.routes, "PATCH", TENANT_VARIABLE_PATH, {
      params: { id: "var-s" },
      body: { value: SECRET_VALUE },
    });
    expect(updated.status).toBe(200);
    expect(updated.body).toMatchObject({ value: TENANT_VARIABLE_SECRET_MASK });

    expect(value.store.events).toHaveLength(2);
    auditAndBodiesContainNoSecret(value, [created, listed, updated.body]);
  });

  it("rejects invalid names, values, and unknown fields", async () => {
    const value = harness();
    await expect(
      invoke(value.routes, "POST", TENANT_VARIABLES_PATH, {
        body: { name: "has space", value: "x" },
      }),
    ).rejects.toMatchObject({ status: 400 });

    await expect(
      invoke(value.routes, "POST", TENANT_VARIABLES_PATH, { body: { name: "ok", value: "" } }),
    ).rejects.toMatchObject({ status: 400 });

    await createVariable(value, { id: "var-1", name: "tier", value: "gold" });
    await expect(
      invoke(value.routes, "PATCH", TENANT_VARIABLE_PATH, {
        params: { id: "var-1" },
        body: { tenantId: "tenant-b" },
      }),
    ).rejects.toMatchObject({ status: 400 });
  });

  it("rejects duplicate names within a scope but allows them across scopes", async () => {
    const value = harness();
    await createVariable(value, { id: "var-1", name: "tier", value: "gold", tenantId: "tenant-a" });
    await expect(
      invoke(value.routes, "POST", TENANT_VARIABLES_PATH, {
        body: { id: "var-2", name: "tier", value: "silver", tenantId: "tenant-a" },
      }),
    ).rejects.toMatchObject({ code: "tenant-variable.conflict", status: 409 });

    const other = await createVariable(value, {
      id: "var-3",
      name: "tier",
      value: "bronze",
      tenantId: "tenant-b",
    });
    expect(other).toMatchObject({ tenantId: "tenant-b" });
  });

  it("scopes reads to the caller and hides out-of-scope rows", async () => {
    const store = new MemoryTenantVariableStore();
    const value = harness({ store, resolveCaller: () => scopedCaller(["tenant-a"]) });
    const admin = harness({ store });
    await createVariable(value, { id: "var-a", name: "tier", value: "gold", tenantId: "tenant-a" });
    await createVariable(admin, { id: "var-b", name: "tier", value: "silver", tenantId: "tenant-b" });
    await createVariable(admin, { id: "var-g", name: "region", value: "eu" });

    const listed = (await invoke(value.routes, "GET", TENANT_VARIABLES_PATH, {})).body as {
      items: Array<Record<string, unknown>>;
    };
    expect(listed.items.map((item) => item["id"]).sort()).toEqual(["var-a", "var-g"]);

    await expect(
      invoke(value.routes, "GET", TENANT_VARIABLE_PATH, { params: { id: "var-b" } }),
    ).rejects.toMatchObject({ status: 404 });
  });

  it("requires the tenant in scope for scoped writes", async () => {
    const store = new MemoryTenantVariableStore();
    const seeded = harness({ store });
    await createVariable(seeded, { id: "var-b", name: "tier", value: "silver", tenantId: "tenant-b" });

    const value = harness({ store, resolveCaller: () => scopedCaller(["tenant-a"]) });

    await expect(
      invoke(value.routes, "POST", TENANT_VARIABLES_PATH, {
        body: { name: "tier", value: "gold", tenantId: "tenant-b" },
      }),
    ).rejects.toMatchObject({ status: 403 });

    await expect(
      invoke(value.routes, "PATCH", TENANT_VARIABLE_PATH, {
        params: { id: "var-b" },
        body: { value: "gold" },
      }),
    ).rejects.toMatchObject({ status: 403 });

    await expect(
      invoke(value.routes, "DELETE", TENANT_VARIABLE_PATH, { params: { id: "var-b" } }),
    ).rejects.toMatchObject({ status: 403 });
  });

  it("deletes a variable and audits the mutation", async () => {
    const value = harness();
    await createVariable(value, { id: "var-1", name: "tier", value: "gold", tenantId: "tenant-a" });

    const removed = await invoke(value.routes, "DELETE", TENANT_VARIABLE_PATH, {
      method: "DELETE",
      params: { id: "var-1" },
    });
    expect(removed.status).toBe(204);

    await expect(
      invoke(value.routes, "GET", TENANT_VARIABLE_PATH, { params: { id: "var-1" } }),
    ).rejects.toMatchObject({ status: 404 });

    expect(value.store.events.map((event) => event.action)).toEqual([
      "tenant-variable.create",
      "tenant-variable.delete",
    ]);
    const deletion = value.store.events[1]!;
    expect(deletion.targetType).toBe("tenant-variable");
    expect(deletion.targetId).toBe("var-1");
    expect(deletion.tenantId).toBe("tenant-a");
  });

  it("requires authentication and checks the documented permissions", async () => {
    const value = harness({ resolveCaller: () => undefined });
    await expect(invoke(value.routes, "GET", TENANT_VARIABLES_PATH, {})).rejects.toMatchObject({
      status: 401,
    });

    const authorized = harness();
    await invoke(authorized.routes, "GET", TENANT_VARIABLES_PATH, {});
    await createVariable(authorized, { name: "tier", value: "gold" });
    expect(authorized.seenPermissions).toEqual([
      TENANT_VARIABLE_PERMISSIONS.read,
      TENANT_VARIABLE_PERMISSIONS.write,
    ]);
  });

  it("publishes an OpenAPI fragment for the variable endpoints", () => {
    expect(TENANT_VARIABLES_OPENAPI.paths["/tenant-variables"].get.operationId).toBe(
      "listTenantVariables",
    );
    expect(TENANT_VARIABLES_OPENAPI.paths["/tenant-variables/{id}"].delete.operationId).toBe(
      "deleteTenantVariable",
    );
  });
});
