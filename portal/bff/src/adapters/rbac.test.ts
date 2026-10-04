import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { createApp, type App } from "../app.js";
import { loadConfig, type BffConfig } from "../config.js";
import { buildServer } from "../server.js";

const opened: { server: Server; app: App }[] = [];

afterEach(async () => {
  for (const { server, app } of opened.splice(0)) {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    app.close();
  }
});

function config(overrides: Partial<BffConfig> = {}): BffConfig {
  return { ...loadConfig({}), ...overrides };
}

async function serve(role: BffConfig["devIdentityRole"], db: Database.Database) {
  const app = createApp(config({ devIdentityRole: role }), { db });
  const server = buildServer({ routes: app.routes, authenticators: app.authenticators });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  opened.push({ server, app });
  const { port } = server.address() as AddressInfo;
  const base = `http://127.0.0.1:${port}`;
  return {
    app,
    db,
    get: (p: string) => fetch(`${base}${p}`),
    post: (p: string, body: unknown) =>
      fetch(`${base}${p}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      }),
    put: (p: string, body: unknown) =>
      fetch(`${base}${p}`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      }),
  };
}

describe("EPIC-038 routes are mounted (T-0868)", () => {
  it("answers every SPEC §6 endpoint with a non-404 status", async () => {
    const api = await serve("admin", new Database(":memory:"));

    const endpoints: Array<[string, number]> = [
      ["GET /v1/users", (await api.get("/v1/users")).status],
      ["GET /v1/roles", (await api.get("/v1/roles")).status],
      ["GET /v1/api-clients", (await api.get("/v1/api-clients")).status],
      ["GET /openapi.json", (await api.get("/openapi.json")).status],
      ["GET /v1/openapi.json", (await api.get("/v1/openapi.json")).status],
      ["POST /v1/roles/preview", (await api.post("/v1/roles/preview", { include: ["*.Read"], exclude: [] })).status],
      ["POST /v1/access/check", (await api.post("/v1/access/check", { permission: "Tenant.Read" })).status],
    ];

    for (const [label, status] of endpoints) {
      expect(status, label).not.toBe(404);
    }
  });

  it("serves valid OpenAPI 3.1 JSON at /openapi.json", async () => {
    const api = await serve("admin", new Database(":memory:"));
    const response = await api.get("/openapi.json");
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("application/json");
    const document = (await response.json()) as { openapi: string; paths: Record<string, unknown> };
    expect(document.openapi).toBe("3.1.0");
    expect(document.paths["/users"]).toBeDefined();
    expect(document.paths["/roles"]).toBeDefined();
    expect(document.paths["/api-clients"]).toBeDefined();
  });
});

describe("EPIC-038 stores persist through SQLite (T-0868)", () => {
  it("persists a portal user and its scope", async () => {
    const api = await serve("admin", new Database(":memory:"));
    const created = await api.post("/v1/users", {
      upn: "operator@example.invalid",
      displayName: "Operator One",
      role: "readonly",
      scope: { targetType: "tenant", targetId: "tenant-a" },
    });
    expect(created.status).toBe(201);
    const body = (await created.json()) as { id: string; status: string; scope: { targetType: string } };
    expect(body.status).toBe("enabled");
    expect(body.scope).toMatchObject({ targetType: "tenant", targetId: "tenant-a" });

    const row = api.db
      .prepare("SELECT status, roleId FROM portal_users WHERE id = ?")
      .get(body.id);
    expect(row).toEqual({ status: "active", roleId: "readonly" });
    const scope = api.db
      .prepare("SELECT targetType, targetId FROM user_scopes WHERE userId = ?")
      .get(body.id);
    expect(scope).toEqual({ targetType: "tenant", targetId: "tenant-a" });

    const scoped = await api.put(`/v1/users/${body.id}/scope`, {
      targetType: "group",
      targetId: "group-1",
    });
    expect(scoped.status).toBe(200);
    expect(
      api.db.prepare("SELECT targetType, targetId FROM user_scopes WHERE userId = ?").get(body.id),
    ).toEqual({ targetType: "group", targetId: "group-1" });

    const forbidden = await api.put(`/v1/users/${body.id}/scope`, { targetType: "all" });
    expect(forbidden.status).toBe(400);
  });

  it("persists a custom role and lists it beside the builtin roles", async () => {
    const api = await serve("admin", new Database(":memory:"));
    const created = await api.post("/v1/roles", {
      name: "Support",
      include: ["Tenant.*"],
      exclude: [],
    });
    expect(created.status).toBe(201);
    const body = (await created.json()) as { id: string; builtin: boolean };
    expect(body.builtin).toBe(false);

    const row = api.db.prepare("SELECT name, builtin FROM roles WHERE id = ?").get(body.id);
    expect(row).toEqual({ name: "Support", builtin: 0 });

    const list = (await (await api.get("/v1/roles")).json()) as { items: { id: string }[] };
    expect(list.items.map((role) => role.id)).toContain(body.id);
    expect(list.items.map((role) => role.id)).toContain("readonly");
  });

  it("persists an API client with only a secret hash and returns the secret once", async () => {
    const api = await serve("admin", new Database(":memory:"));
    const created = await api.post("/v1/api-clients", {
      name: "Reporting Bot",
      roles: ["readonly"],
      ipRanges: ["10.0.0.0/8"],
      rateLimit: 100,
    });
    expect(created.status).toBe(201);
    const body = (await created.json()) as { id: string; secret: string };
    expect(typeof body.secret).toBe("string");
    expect(body.secret.length).toBeGreaterThan(0);

    const row = api.db
      .prepare("SELECT secretHash, roles FROM api_clients WHERE id = ?")
      .get(body.id) as { secretHash: string; roles: string };
    expect(row.secretHash).not.toBe(body.secret);
    expect(JSON.parse(row.roles)).toEqual(["readonly"]);

    const fetched = (await (await api.get(`/v1/api-clients/${body.id}`)).json()) as Record<string, unknown>;
    expect(fetched["secret"]).toBeUndefined();
    expect(fetched["secretHash"]).toBeUndefined();
  });
});
