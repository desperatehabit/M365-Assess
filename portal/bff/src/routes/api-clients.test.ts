import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { DEFAULT_HOST } from "../config.js";
import {
  generateApiClientSecret,
  hashApiClientSecret,
  verifyApiClientSecret,
} from "../rbac/api-client-secret.js";
import { buildServer, type Route, type RouteHandler, type RouteResponse } from "../server.js";
import {
  API_CLIENT_PATH,
  API_CLIENT_ROTATE_PATH,
  API_CLIENTS_OPENAPI,
  API_CLIENTS_PATH,
  createApiClientRoutes,
  createInMemoryApiClientStore,
  type ApiClientRecord,
  type ApiClientStore,
} from "./api-clients.js";

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
    path: API_CLIENTS_PATH,
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

function asRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null) {
    throw new Error("expected a JSON object response body");
  }
  return value as Record<string, unknown>;
}

async function createClient(
  store: ApiClientStore,
  overrides: Record<string, unknown> = {},
): Promise<{ response: RouteResponse; body: Record<string, unknown> }> {
  const routes = createApiClientRoutes(store);
  const response = await invoke(routes, "POST", API_CLIENTS_PATH, {
    body: { name: "Reporting Bot", roles: ["readonly"], ...overrides },
  });
  return { response, body: asRecord(response.body) };
}

const openServers: Server[] = [];

afterEach(async () => {
  await Promise.all(
    openServers.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => {
          server.close(() => resolve());
        }),
    ),
  );
});

describe("api client secret", () => {
  it("generates a fresh, high-entropy secret each time", () => {
    const first = generateApiClientSecret();
    const second = generateApiClientSecret();
    expect(first).not.toBe(second);
    expect(first.length).toBeGreaterThanOrEqual(32);
  });

  it("hashes with a salted KDF and verifies the original secret", () => {
    const secret = generateApiClientSecret();
    const hash = hashApiClientSecret(secret);
    expect(hash).not.toContain(secret);
    expect(hash.startsWith("scrypt$")).toBe(true);
    expect(verifyApiClientSecret(secret, hash)).toBe(true);
    expect(verifyApiClientSecret(`${secret}x`, hash)).toBe(false);
  });

  it("salts each hash so equal secrets do not produce equal hashes", () => {
    const secret = generateApiClientSecret();
    expect(hashApiClientSecret(secret)).not.toBe(hashApiClientSecret(secret));
  });

  it("rejects a malformed stored hash instead of throwing", () => {
    expect(verifyApiClientSecret("whatever", "not-a-hash")).toBe(false);
    expect(verifyApiClientSecret("whatever", "scrypt$16384$8$1$onlyfive")).toBe(false);
  });
});

describe("api client routes", () => {
  it("creates a client, returns the secret once, and stores only the hash", async () => {
    const store = createInMemoryApiClientStore();
    const { response, body } = await createClient(store, {
      roles: ["editor"],
      ipRanges: ["Any"],
      rateLimit: 100,
    });

    expect(response.status).toBe(201);
    expect(typeof body["secret"]).toBe("string");
    expect(body).not.toHaveProperty("secretHash");

    const secret = body["secret"] as string;
    const stored = await store.getApiClient(body["id"] as string);
    expect(stored?.secretHash).toBeDefined();
    expect(stored?.secretHash).not.toBe(secret);
    expect(JSON.stringify(stored)).not.toContain(secret);
    expect(verifyApiClientSecret(secret, stored!.secretHash)).toBe(true);
  });

  it("never returns the secret or its hash from any non-create endpoint", async () => {
    const store = createInMemoryApiClientStore();
    const { body } = await createClient(store);
    const id = body["id"] as string;
    const secret = body["secret"] as string;
    const routes = createApiClientRoutes(store);

    const list = await invoke(routes, "GET", API_CLIENTS_PATH);
    expect(JSON.stringify(list.body)).not.toContain(secret);
    expect(JSON.stringify(list.body)).not.toContain("secretHash");

    const get = await invoke(routes, "GET", API_CLIENT_PATH, { params: { id } });
    expect(get.status).toBe(200);
    expect(JSON.stringify(get.body)).not.toContain(secret);
    expect(get.body).not.toHaveProperty("secretHash");

    const patch = await invoke(routes, "PATCH", API_CLIENT_PATH, {
      params: { id },
      body: { enabled: false },
    });
    expect(JSON.stringify(patch.body)).not.toContain(secret);
    expect(patch.body).not.toHaveProperty("secretHash");
  });

  it("round-trips roles, ipRanges, rateLimit, and enabled through CRUD", async () => {
    const store = createInMemoryApiClientStore();
    const { body } = await createClient(store, {
      roles: ["editor", "readonly"],
      ipRanges: ["10.0.0.0/8", "Any"],
      rateLimit: 250,
      enabled: true,
    });
    const id = body["id"] as string;
    const routes = createApiClientRoutes(store);

    const fetched = asRecord(
      (await invoke(routes, "GET", API_CLIENT_PATH, { params: { id } })).body,
    );
    expect(fetched).toMatchObject({
      name: "Reporting Bot",
      roles: ["editor", "readonly"],
      ipRanges: ["10.0.0.0/8", "Any"],
      rateLimit: 250,
      enabled: true,
    });

    const patched = asRecord(
      (
        await invoke(routes, "PATCH", API_CLIENT_PATH, {
          params: { id },
          body: {
            name: "Renamed Bot",
            roles: ["admin"],
            ipRanges: ["Any"],
            rateLimit: 500,
            enabled: false,
          },
        })
      ).body,
    );
    expect(patched).toMatchObject({
      name: "Renamed Bot",
      roles: ["admin"],
      ipRanges: ["Any"],
      rateLimit: 500,
      enabled: false,
    });

    const persisted = await store.getApiClient(id);
    expect(persisted).toMatchObject({
      roles: ["admin"],
      ipRanges: ["Any"],
      rateLimit: 500,
      enabled: false,
    });
  });

  it("rotates the secret once and invalidates the previous secret", async () => {
    const store = createInMemoryApiClientStore();
    const { body } = await createClient(store);
    const id = body["id"] as string;
    const originalSecret = body["secret"] as string;
    const routes = createApiClientRoutes(store);

    const rotated = asRecord(
      (await invoke(routes, "POST", API_CLIENT_ROTATE_PATH, { params: { id } })).body,
    );
    const newSecret = rotated["secret"] as string;

    expect(newSecret).not.toBe(originalSecret);
    expect(rotated).not.toHaveProperty("secretHash");
    expect(rotated["id"]).toBe(id);

    const stored = await store.getApiClient(id);
    expect(verifyApiClientSecret(newSecret, stored!.secretHash)).toBe(true);
    expect(verifyApiClientSecret(originalSecret, stored!.secretHash)).toBe(false);

    const fetched = await invoke(routes, "GET", API_CLIENT_PATH, { params: { id } });
    expect(JSON.stringify(fetched.body)).not.toContain(newSecret);
    expect(fetched.body).not.toHaveProperty("secretHash");
  });

  it("deletes a client and reports missing ids as structured 404s", async () => {
    const store = createInMemoryApiClientStore();
    const { body } = await createClient(store);
    const id = body["id"] as string;
    const routes = createApiClientRoutes(store);

    const deleted = await invoke(routes, "DELETE", API_CLIENT_PATH, { params: { id } });
    expect(deleted.status).toBe(204);
    expect(await store.getApiClient(id)).toBeUndefined();

    await expect(invoke(routes, "GET", API_CLIENT_PATH, { params: { id } })).rejects.toMatchObject(
      { status: 404 },
    );
    await expect(
      invoke(routes, "POST", API_CLIENT_ROTATE_PATH, { params: { id } }),
    ).rejects.toMatchObject({ status: 404 });
  });

  it("rejects a create without a name", async () => {
    const store = createInMemoryApiClientStore();
    const routes = createApiClientRoutes(store);
    await expect(
      invoke(routes, "POST", API_CLIENTS_PATH, { body: { roles: ["readonly"] } }),
    ).rejects.toMatchObject({ status: 400 });
  });

  it("publishes its OpenAPI path items for every operation", () => {
    expect(API_CLIENTS_OPENAPI.paths["/api-clients"]).toHaveProperty("get");
    expect(API_CLIENTS_OPENAPI.paths["/api-clients"]).toHaveProperty("post");
    expect(API_CLIENTS_OPENAPI.paths["/api-clients/{id}"]).toHaveProperty("get");
    expect(API_CLIENTS_OPENAPI.paths["/api-clients/{id}"]).toHaveProperty("patch");
    expect(API_CLIENTS_OPENAPI.paths["/api-clients/{id}"]).toHaveProperty("delete");
    expect(API_CLIENTS_OPENAPI.paths["/api-clients/{id}/rotate-secret"]).toHaveProperty("post");
  });
});

describe("api client routes over HTTP", () => {
  const seed: ApiClientRecord = {
    id: "client-seed",
    name: "Seed Bot",
    secretHash: hashApiClientSecret("seed-secret"),
    roles: ["readonly"],
    ipRanges: ["Any"],
    rateLimit: null,
    enabled: true,
    lastUsedAt: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };

  async function startServer(routes: readonly Route[]): Promise<string> {
    const server = buildServer({ routes: [...routes] });
    await new Promise<void>((resolve) => server.listen(0, DEFAULT_HOST, resolve));
    openServers.push(server);
    const { port } = server.address() as AddressInfo;
    return `http://${DEFAULT_HOST}:${port}`;
  }

  it("dispatches list, get, and delete through the real server", async () => {
    const store = createInMemoryApiClientStore([seed]);
    const baseUrl = await startServer(createApiClientRoutes(store));

    const list = await fetch(`${baseUrl}${API_CLIENTS_PATH}`);
    expect(list.status).toBe(200);
    const listBody = asRecord(await list.json());
    expect(listBody["items"]).toHaveLength(1);
    expect(JSON.stringify(listBody)).not.toContain(seed.secretHash);

    const get = await fetch(`${baseUrl}${API_CLIENTS_PATH}/client-seed`);
    expect(get.status).toBe(200);
    expect((await get.json()) as Record<string, unknown>).not.toHaveProperty("secretHash");

    const deleted = await fetch(`${baseUrl}${API_CLIENTS_PATH}/client-seed`, { method: "DELETE" });
    expect(deleted.status).toBe(204);
    expect(await store.getApiClient("client-seed")).toBeUndefined();
  });
});
