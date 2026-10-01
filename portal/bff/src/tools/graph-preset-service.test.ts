import { describe, expect, it } from "vitest";
import type { GraphPreset, GraphPresetInput, GraphPresetListOptions } from "@m365-assess/db";
import { ALL_TENANTS } from "../rbac/scope.js";
import type { RouteHandler, RouteResponse } from "../server.js";
import {
  GRAPH_PRESET_ERROR_CODES,
  createGraphPresetService,
  parseGraphPresetInput,
  type GraphPresetCaller,
  type GraphPresetStore,
} from "./graph-preset-service.js";
import {
  GRAPH_PRESET_ITEM_PATH,
  GRAPH_PRESET_PATH,
  createGraphPresetRoutes,
  type GraphPresetRouteOptions,
} from "./graph-preset-routes.js";

const USER = "user-1";
const OTHER = "user-2";
const NOW = "2026-06-01T00:00:00.000Z";

class MemoryPresetStore implements GraphPresetStore {
  readonly rows: GraphPreset[] = [];

  async createGraphPreset(input: GraphPresetInput): Promise<GraphPreset> {
    const preset: GraphPreset = {
      id: input.id,
      name: input.name,
      method: input.method,
      url: input.url,
      body: input.body ?? null,
      createdBy: input.createdBy,
      createdAt: input.createdAt ?? NOW,
      updatedAt: input.updatedAt ?? NOW,
    };
    this.rows.push(preset);
    return preset;
  }

  async getGraphPreset(presetId: string): Promise<GraphPreset | undefined> {
    return this.rows.find((row) => row.id === presetId);
  }

  async listGraphPresets(options: GraphPresetListOptions = {}): Promise<GraphPreset[]> {
    return options.createdBy === undefined
      ? [...this.rows]
      : this.rows.filter((row) => row.createdBy === options.createdBy);
  }

  async deleteGraphPreset(presetId: string): Promise<boolean> {
    const index = this.rows.findIndex((row) => row.id === presetId);
    if (index === -1) return false;
    this.rows.splice(index, 1);
    return true;
  }
}

function caller(role: "admin" | "operator", userId = USER): GraphPresetCaller {
  return { roles: [role], tenantScope: ALL_TENANTS, permissions: ["tools.read"], userId };
}

function harness() {
  const store = new MemoryPresetStore();
  let counter = 0;
  const service = createGraphPresetService({
    store,
    now: () => NOW,
    newId: () => `preset-${(counter += 1)}`,
  });
  return { store, service };
}

const VALID_INPUT = {
  name: "List users",
  method: "GET",
  url: "https://graph.microsoft.com/v1.0/users",
};

describe("parseGraphPresetInput", () => {
  it("parses a minimal preset", () => {
    expect(parseGraphPresetInput(VALID_INPUT)).toEqual(VALID_INPUT);
  });

  it("parses a JSON string payload", () => {
    expect(parseGraphPresetInput(JSON.stringify(VALID_INPUT))).toEqual(VALID_INPUT);
  });

  it("keeps an optional body", () => {
    const body = { displayName: "New user" };
    expect(parseGraphPresetInput({ ...VALID_INPUT, method: "POST", body }).body).toEqual(body);
  });

  it("rejects a non-object payload", () => {
    for (const payload of ["not json", 42, null, true, [1, 2]]) {
      expect(() => parseGraphPresetInput(payload)).toThrowError(
        expect.objectContaining({ code: "request.validation_failed" }),
      );
    }
  });

  it("rejects a missing name or url", () => {
    expect(() => parseGraphPresetInput({ method: "GET", url: VALID_INPUT.url })).toThrowError(
      expect.objectContaining({ code: "request.validation_failed" }),
    );
    expect(() => parseGraphPresetInput({ name: "x", method: "GET" })).toThrowError(
      expect.objectContaining({ code: "request.validation_failed" }),
    );
  });

  it("validates the method against the T-0781 allowlist", () => {
    for (const method of ["HEAD", "OPTIONS", "TRACE", "get", "post"]) {
      expect(() => parseGraphPresetInput({ ...VALID_INPUT, method })).toThrowError(
        expect.objectContaining({ code: GRAPH_PRESET_ERROR_CODES.methodNotAllowed }),
      );
    }
  });

  it("accepts every allowlisted method", () => {
    for (const method of ["GET", "POST", "PATCH", "PUT", "DELETE"]) {
      expect(parseGraphPresetInput({ ...VALID_INPUT, method }).method).toBe(method);
    }
  });
});

describe("createGraphPresetService", () => {
  it("lists only the caller's presets", async () => {
    const { store, service } = harness();
    await store.createGraphPreset({
      id: "own",
      ...VALID_INPUT,
      body: null,
      createdBy: USER,
    });
    await store.createGraphPreset({
      id: "theirs",
      ...VALID_INPUT,
      body: null,
      createdBy: OTHER,
    });

    expect((await service.list(caller("operator"))).map((preset) => preset.id)).toEqual(["own"]);
  });

  it("does not widen a list for an admin (per-user reads)", async () => {
    const { store, service } = harness();
    await store.createGraphPreset({ id: "own", ...VALID_INPUT, body: null, createdBy: USER });
    await store.createGraphPreset({ id: "theirs", ...VALID_INPUT, body: null, createdBy: OTHER });

    expect((await service.list(caller("admin"))).map((preset) => preset.id)).toEqual(["own"]);
  });

  it("stamps createdBy and the request fields, storing no credential or secret", async () => {
    const { store, service } = harness();
    const created = await service.create(caller("operator"), VALID_INPUT);

    expect(created).toMatchObject({
      id: "preset-1",
      name: VALID_INPUT.name,
      method: "GET",
      url: VALID_INPUT.url,
      createdBy: USER,
      createdAt: NOW,
      updatedAt: NOW,
    });
    expect(Object.keys(created).sort()).toEqual([
      "body",
      "createdAt",
      "createdBy",
      "id",
      "method",
      "name",
      "updatedAt",
      "url",
    ]);
    expect(JSON.stringify(store.rows)).not.toMatch(/secret|credential|clientId|thumbprint/i);
  });

  it("rejects a method outside the T-0781 allowlist", async () => {
    const { service } = harness();
    await expect(
      service.create(caller("operator"), { ...VALID_INPUT, method: "HEAD" }),
    ).rejects.toMatchObject({ code: GRAPH_PRESET_ERROR_CODES.methodNotAllowed });
  });

  it("requires an authenticated owner", async () => {
    const { service } = harness();
    const anonymous: GraphPresetCaller = { roles: [], tenantScope: ALL_TENANTS, permissions: [] };
    await expect(service.list(anonymous)).rejects.toMatchObject({ status: 401 });
    await expect(service.create(anonymous, VALID_INPUT)).rejects.toMatchObject({ status: 401 });
    await expect(service.remove(anonymous, "preset-1")).rejects.toMatchObject({ status: 401 });
  });

  it("deletes the caller's own preset", async () => {
    const { store, service } = harness();
    const created = await service.create(caller("operator"), VALID_INPUT);
    await service.remove(caller("operator"), created.id);
    expect(await store.getGraphPreset(created.id)).toBeUndefined();
  });

  it("denies a non-admin deleting another user's preset", async () => {
    const { store, service } = harness();
    await store.createGraphPreset({ id: "theirs", ...VALID_INPUT, body: null, createdBy: OTHER });

    await expect(service.remove(caller("operator"), "theirs")).rejects.toMatchObject({
      code: "auth.forbidden",
      status: 403,
    });
    expect(await store.getGraphPreset("theirs")).toBeDefined();
  });

  it("lets an admin delete another user's preset", async () => {
    const { store, service } = harness();
    await store.createGraphPreset({ id: "theirs", ...VALID_INPUT, body: null, createdBy: OTHER });

    await service.remove(caller("admin"), "theirs");
    expect(await store.getGraphPreset("theirs")).toBeUndefined();
  });

  it("reports a missing preset as not found", async () => {
    const { service } = harness();
    await expect(service.remove(caller("operator"), "missing")).rejects.toMatchObject({
      code: GRAPH_PRESET_ERROR_CODES.notFound,
      status: 404,
    });
  });
});

describe("graph-preset routes", () => {
  function routeOptions(
    service: ReturnType<typeof createGraphPresetService>,
    overrides: Partial<GraphPresetRouteOptions> = {},
  ): GraphPresetRouteOptions {
    return {
      service,
      resolveCaller: () => caller("operator"),
      ...overrides,
    };
  }

  type HandlerContext = Parameters<RouteHandler>[0];

  function context(overrides: Partial<HandlerContext> = {}): HandlerContext {
    return {
      correlationId: "corr-test",
      method: "GET",
      path: GRAPH_PRESET_PATH,
      query: new URLSearchParams(),
      headers: {},
      params: {},
      ...overrides,
    } as unknown as HandlerContext;
  }

  function invoke(
    routes: ReturnType<typeof createGraphPresetRoutes>,
    method: string,
    path: string,
    overrides: Partial<HandlerContext> = {},
  ): Promise<RouteResponse> {
    const route = routes.find((candidate) => candidate.method === method && candidate.path === path);
    if (route === undefined) throw new Error(`no route for ${method} ${path}`);
    return Promise.resolve(route.handler(context(overrides)));
  }

  it("exposes GET and POST on the collection and DELETE on the item", () => {
    const { service } = harness();
    const routes = createGraphPresetRoutes(routeOptions(service));
    expect(routes.map((route) => `${route.method} ${route.path}`)).toEqual([
      `GET ${GRAPH_PRESET_PATH}`,
      `POST ${GRAPH_PRESET_PATH}`,
      `DELETE ${GRAPH_PRESET_ITEM_PATH}`,
    ]);
  });

  it("lists the caller's presets", async () => {
    const { store, service } = harness();
    await store.createGraphPreset({ id: "own", ...VALID_INPUT, body: null, createdBy: USER });
    await store.createGraphPreset({ id: "theirs", ...VALID_INPUT, body: null, createdBy: OTHER });

    const routes = createGraphPresetRoutes(routeOptions(service));
    const response = await invoke(routes, "GET", GRAPH_PRESET_PATH);
    expect(response.status).toBe(200);
    expect((response.body as { presets: GraphPreset[] }).presets.map((preset) => preset.id)).toEqual([
      "own",
    ]);
  });

  it("creates a preset owned by the caller", async () => {
    const { service } = harness();
    const routes = createGraphPresetRoutes(routeOptions(service));
    const response = await invoke(routes, "POST", GRAPH_PRESET_PATH, {
      method: "POST",
      body: VALID_INPUT,
    });
    expect(response.status).toBe(201);
    expect((response.body as { preset: GraphPreset }).preset).toMatchObject({
      name: VALID_INPUT.name,
      method: "GET",
      url: VALID_INPUT.url,
      createdBy: USER,
    });
  });

  it("rejects a preset with a non-allowlisted method", async () => {
    const { service } = harness();
    const routes = createGraphPresetRoutes(routeOptions(service));
    await expect(
      invoke(routes, "POST", GRAPH_PRESET_PATH, {
        method: "POST",
        body: { ...VALID_INPUT, method: "HEAD" },
      }),
    ).rejects.toMatchObject({ status: 400 });
  });

  it("rejects an anonymous caller with 401", async () => {
    const { service } = harness();
    const routes = createGraphPresetRoutes(routeOptions(service, { resolveCaller: () => undefined }));
    await expect(invoke(routes, "GET", GRAPH_PRESET_PATH)).rejects.toMatchObject({ status: 401 });
  });

  it("rejects a caller lacking tools.read with 403", async () => {
    const { service } = harness();
    const routes = createGraphPresetRoutes(
      routeOptions(service, {
        resolveCaller: () => ({ roles: ["operator"], tenantScope: ALL_TENANTS, permissions: [], userId: USER }),
      }),
    );
    await expect(invoke(routes, "GET", GRAPH_PRESET_PATH)).rejects.toMatchObject({ status: 403 });
  });

  it("deletes the caller's own preset", async () => {
    const { service } = harness();
    const routes = createGraphPresetRoutes(routeOptions(service));
    const created = await service.create(caller("operator"), VALID_INPUT);
    const response = await invoke(routes, "DELETE", GRAPH_PRESET_ITEM_PATH, {
      method: "DELETE",
      path: GRAPH_PRESET_ITEM_PATH,
      params: { id: created.id },
    });
    expect(response.status).toBe(200);
    expect(response.body).toEqual({ id: created.id, deleted: true });
  });

  it("denies a non-admin deleting another user's preset with 403", async () => {
    const { store, service } = harness();
    await store.createGraphPreset({ id: "theirs", ...VALID_INPUT, body: null, createdBy: OTHER });
    const routes = createGraphPresetRoutes(routeOptions(service));
    await expect(
      invoke(routes, "DELETE", GRAPH_PRESET_ITEM_PATH, {
        method: "DELETE",
        path: GRAPH_PRESET_ITEM_PATH,
        params: { id: "theirs" },
      }),
    ).rejects.toMatchObject({ status: 403 });
  });

  it("lets an admin delete another user's preset", async () => {
    const { store, service } = harness();
    await store.createGraphPreset({ id: "theirs", ...VALID_INPUT, body: null, createdBy: OTHER });
    const routes = createGraphPresetRoutes(
      routeOptions(service, { resolveCaller: () => caller("admin") }),
    );
    const response = await invoke(routes, "DELETE", GRAPH_PRESET_ITEM_PATH, {
      method: "DELETE",
      path: GRAPH_PRESET_ITEM_PATH,
      params: { id: "theirs" },
    });
    expect(response.status).toBe(200);
    expect(await store.getGraphPreset("theirs")).toBeUndefined();
  });

  it("reports a missing preset as 404", async () => {
    const { service } = harness();
    const routes = createGraphPresetRoutes(routeOptions(service));
    await expect(
      invoke(routes, "DELETE", GRAPH_PRESET_ITEM_PATH, {
        method: "DELETE",
        path: GRAPH_PRESET_ITEM_PATH,
        params: { id: "missing" },
      }),
    ).rejects.toMatchObject({ status: 404 });
  });
});
