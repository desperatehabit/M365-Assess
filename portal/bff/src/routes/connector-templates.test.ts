import { mkdtempSync, rmSync } from "node:fs";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import {
  SqliteConnectorTemplateRepository,
  openSqliteConnectorTemplateRepository,
} from "../../../db/src/transport-template-repository.js";
import { loadMigrations, runMigrations } from "../../../db/src/sqlite-repository.js";
import { DEFAULT_HOST } from "../config.js";
import { ErrorCodes, normalizeError, toErrorBody } from "../errors.js";
import { buildServer, type Route, type RouteResponse } from "../server.js";
import {
  CONNECTOR_TEMPLATE_INVALID,
  CONNECTOR_TEMPLATE_NOT_FOUND,
  CONNECTOR_TEMPLATE_PERMISSIONS,
  createConnectorTemplateRoutes,
  type StoredConnectorTemplate,
  type ConnectorTemplateRequestContext,
  type ConnectorTemplateStore,
} from "./connector-templates.js";

const SECRET_REF = "ref://tenants/tenant-test/connector-secret/abc-123";
const MATERIAL = "-----BEGIN CERTIFICATE-----partner-tls-material-----END CERTIFICATE-----";

const CONNECTOR_JSON = {
  name: "Partner inbound",
  type: "inbound",
  senderDomains: "partner.example.com",
  requireTls: true,
  tlsSettings: { secretRef: SECRET_REF },
};

const openServers: Server[] = [];
const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(
    openServers.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => {
          server.close(() => resolve());
        }),
    ),
  );
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
  tempDirs.length = 0;
});

function tempDbPath(): string {
  const dir = mkdtempSync(join(tmpdir(), "m365-connector-templates-"));
  tempDirs.push(dir);
  return join(dir, "portal.db");
}

async function startServer(routes: readonly Route[]): Promise<string> {
  const server = buildServer({ routes });
  await new Promise<void>((resolve) => server.listen(0, DEFAULT_HOST, resolve));
  openServers.push(server);
  const { port } = server.address() as AddressInfo;
  return `http://${DEFAULT_HOST}:${port}`;
}

function context(
  overrides: Partial<ConnectorTemplateRequestContext> = {},
): ConnectorTemplateRequestContext {
  return {
    correlationId: "corr-test",
    method: "POST",
    path: "/v1/connector-templates",
    query: new URLSearchParams(),
    headers: {},
    params: {},
    ...overrides,
  };
}

function handlerFor(routes: readonly Route[], method: string, path: string): Route {
  const route = routes.find((candidate) => candidate.method === method && candidate.path === path);
  if (!route) throw new Error(`no ${method} ${path} route`);
  return route;
}

async function invoke(
  route: Route,
  ctx: ConnectorTemplateRequestContext,
): Promise<RouteResponse> {
  try {
    return await route.handler(ctx);
  } catch (error) {
    const appError = normalizeError(error);
    return { status: appError.status, body: toErrorBody(appError, ctx.correlationId) };
  }
}

class InMemoryConnectorTemplateStore implements ConnectorTemplateStore {
  private readonly rows = new Map<string, StoredConnectorTemplate>();

  async createTemplate(input: {
    id?: string;
    name: string;
    connectorJson: Record<string, unknown>;
    variables?: Array<{ name: string; defaultValue?: string }>;
    source?: string;
    createdAt?: string;
    updatedAt?: string;
  }): Promise<StoredConnectorTemplate> {
    const at = input.createdAt ?? "2026-01-01T00:00:00.000Z";
    const row: StoredConnectorTemplate = {
      id: input.id ?? `template-${this.rows.size + 1}`,
      name: input.name,
      connectorJson: input.connectorJson,
      variables: input.variables ?? [],
      source: input.source ?? "local",
      createdAt: at,
      updatedAt: input.updatedAt ?? at,
      deletedAt: null,
    };
    this.rows.set(row.id, row);
    return { ...row, variables: [...row.variables] };
  }

  async getTemplate(
    id: string,
    options: { includeDeleted?: boolean } = {},
  ): Promise<StoredConnectorTemplate | undefined> {
    const row = this.rows.get(id);
    if (!row || (!options.includeDeleted && row.deletedAt !== null)) return undefined;
    return { ...row, variables: [...row.variables] };
  }

  async listTemplates(
    options: { includeDeleted?: boolean } = {},
  ): Promise<StoredConnectorTemplate[]> {
    return [...this.rows.values()]
      .filter((row) => options.includeDeleted === true || row.deletedAt === null)
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((row) => ({ ...row, variables: [...row.variables] }));
  }

  async updateTemplate(
    id: string,
    input: {
      name?: string;
      connectorJson?: Record<string, unknown>;
      variables?: Array<{ name: string; defaultValue?: string }>;
      source?: string;
      updatedAt?: string;
    },
  ): Promise<StoredConnectorTemplate | undefined> {
    const existing = this.rows.get(id);
    if (!existing || existing.deletedAt !== null) return undefined;
    const next: StoredConnectorTemplate = {
      ...existing,
      name: input.name ?? existing.name,
      connectorJson: input.connectorJson ?? existing.connectorJson,
      variables: input.variables ?? existing.variables,
      source: input.source ?? existing.source,
      updatedAt: input.updatedAt ?? "2026-01-02T00:00:00.000Z",
    };
    this.rows.set(id, next);
    return { ...next, variables: [...next.variables] };
  }

  async softDeleteTemplate(id: string): Promise<boolean> {
    const existing = this.rows.get(id);
    if (!existing || existing.deletedAt !== null) return false;
    this.rows.set(id, { ...existing, deletedAt: "2026-01-03T00:00:00.000Z" });
    return true;
  }

  async cloneTemplate(
    sourceId: string,
    input: { id?: string; name: string; createdAt?: string },
  ): Promise<StoredConnectorTemplate | undefined> {
    const source = this.rows.get(sourceId);
    if (!source || source.deletedAt !== null) return undefined;
    const at = input.createdAt ?? "2026-01-04T00:00:00.000Z";
    const row: StoredConnectorTemplate = {
      id: input.id ?? `template-${this.rows.size + 1}`,
      name: input.name,
      connectorJson: source.connectorJson,
      variables: source.variables,
      source: "local",
      createdAt: at,
      updatedAt: at,
      deletedAt: null,
    };
    this.rows.set(row.id, row);
    return { ...row, variables: [...row.variables] };
  }
}

function sqliteStore(): { store: ConnectorTemplateStore; close: () => void } {
  const db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  const schemaVersion = runMigrations(db, loadMigrations());
  return {
    store: new SqliteConnectorTemplateRepository(db, schemaVersion),
    close: () => db.close(),
  };
}

describe("connector template routes", () => {
  it("lists, creates, reads, updates, clones, and deletes through the routes", async () => {
    const store = new InMemoryConnectorTemplateStore();
    const routes = createConnectorTemplateRoutes({ store });
    const baseUrl = await startServer(routes);

    const created = await invoke(
      handlerFor(routes, "POST", "/v1/connector-templates"),
      context({
        body: {
          id: "t1",
          name: "Partner inbound",
          connectorJson: CONNECTOR_JSON,
          variables: [{ name: "partnerDomain", defaultValue: "partner.example.com" }],
        },
      }),
    );
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({
      id: "t1",
      name: "Partner inbound",
      source: "local",
    });
    expect((created.body as Record<string, unknown>)["connectorJson"]).toEqual(CONNECTOR_JSON);

    const listResponse = await fetch(`${baseUrl}/v1/connector-templates`);
    expect(listResponse.status).toBe(200);
    const listBody = (await listResponse.json()) as { items: Array<Record<string, unknown>> };
    expect(listBody.items).toHaveLength(1);
    expect(listBody.items[0]?.["variables"]).toEqual([
      { name: "partnerDomain", defaultValue: "partner.example.com" },
    ]);

    const detail = (await (
      await fetch(`${baseUrl}/v1/connector-templates/t1`)
    ).json()) as Record<string, unknown>;
    expect(detail["name"]).toBe("Partner inbound");

    const edited = await invoke(
      handlerFor(routes, "PATCH", "/v1/connector-templates/:id"),
      context({
        method: "PATCH",
        path: "/v1/connector-templates/t1",
        params: { id: "t1" },
        body: { name: "Partner inbound v2" },
      }),
    );
    expect(edited.status).toBe(200);
    expect((edited.body as Record<string, unknown>)["name"]).toBe("Partner inbound v2");

    const cloned = await invoke(
      handlerFor(routes, "POST", "/v1/connector-templates/:id/clone"),
      context({
        method: "POST",
        path: "/v1/connector-templates/t1/clone",
        params: { id: "t1" },
        body: { name: "Partner inbound (copy)" },
      }),
    );
    expect(cloned.status).toBe(201);
    const cloneBody = cloned.body as Record<string, unknown>;
    expect(cloneBody["id"]).not.toBe("t1");
    expect(cloneBody["name"]).toBe("Partner inbound (copy)");
    expect(cloneBody["connectorJson"]).toEqual(CONNECTOR_JSON);
    expect(cloneBody["source"]).toBe("local");

    const deleted = await fetch(`${baseUrl}/v1/connector-templates/t1`, { method: "DELETE" });
    expect(deleted.status).toBe(204);
    expect((await fetch(`${baseUrl}/v1/connector-templates/t1`)).status).toBe(404);
    const afterDelete = (await (
      await fetch(`${baseUrl}/v1/connector-templates`)
    ).json()) as { items: unknown[] };
    expect(afterDelete.items).toHaveLength(1);
  });

  it("defaults a clone name to '<name> (copy)'", async () => {
    const store = new InMemoryConnectorTemplateStore();
    const routes = createConnectorTemplateRoutes({ store });
    await invoke(
      handlerFor(routes, "POST", "/v1/connector-templates"),
      context({ body: { id: "t1", name: "Original", connectorJson: CONNECTOR_JSON } }),
    );

    const cloned = await invoke(
      handlerFor(routes, "POST", "/v1/connector-templates/:id/clone"),
      context({
        method: "POST",
        path: "/v1/connector-templates/t1/clone",
        params: { id: "t1" },
      }),
    );
    expect(cloned.status).toBe(201);
    expect((cloned.body as Record<string, unknown>)["name"]).toBe("Original (copy)");
  });

  it("allows a partial update that omits the name", async () => {
    const store = new InMemoryConnectorTemplateStore();
    const routes = createConnectorTemplateRoutes({ store });
    await invoke(
      handlerFor(routes, "POST", "/v1/connector-templates"),
      context({ body: { id: "t1", name: "Original", connectorJson: CONNECTOR_JSON } }),
    );

    const edited = await invoke(
      handlerFor(routes, "PATCH", "/v1/connector-templates/:id"),
      context({
        method: "PATCH",
        path: "/v1/connector-templates/t1",
        params: { id: "t1" },
        body: { connectorJson: { ...CONNECTOR_JSON, requireTls: false } },
      }),
    );
    expect(edited.status).toBe(200);
    const body = edited.body as Record<string, unknown>;
    expect(body["name"]).toBe("Original");
    expect(body["connectorJson"]).toMatchObject({ requireTls: false });
  });

  it("rejects an update that supplies an empty name", async () => {
    const store = new InMemoryConnectorTemplateStore();
    const routes = createConnectorTemplateRoutes({ store });
    await invoke(
      handlerFor(routes, "POST", "/v1/connector-templates"),
      context({ body: { id: "t1", name: "Original", connectorJson: CONNECTOR_JSON } }),
    );

    const edited = await invoke(
      handlerFor(routes, "PATCH", "/v1/connector-templates/:id"),
      context({
        method: "PATCH",
        path: "/v1/connector-templates/t1",
        params: { id: "t1" },
        body: { name: "" },
      }),
    );
    expect(edited.status).toBe(400);
  });

  it("rejects a community source and a malformed body with 400", async () => {
    const store = new InMemoryConnectorTemplateStore();
    const routes = createConnectorTemplateRoutes({ store });
    const post = handlerFor(routes, "POST", "/v1/connector-templates");

    const community = await invoke(
      post,
      context({
        body: { id: "t2", name: "Community", connectorJson: CONNECTOR_JSON, source: "community" },
      }),
    );
    expect(community.status).toBe(400);
    expect((community.body as Record<string, unknown>)["code"]).toBe(CONNECTOR_TEMPLATE_INVALID);

    const badConnector = await invoke(
      post,
      context({ body: { id: "t3", name: "Bad", connectorJson: "not-an-object" } }),
    );
    expect(badConnector.status).toBe(400);

    const badName = await invoke(
      post,
      context({ body: { id: "t4", name: "", connectorJson: CONNECTOR_JSON } }),
    );
    expect(badName.status).toBe(400);

    const badVariable = await invoke(
      post,
      context({
        body: {
          id: "t5",
          name: "Vars",
          connectorJson: CONNECTOR_JSON,
          variables: [{ name: "not valid" }],
        },
      }),
    );
    expect(badVariable.status).toBe(400);
    expect(
      ((badVariable.body as { details: Array<{ field: string }> }).details ?? []).some(
        (detail) => detail.field === "variables[0].name",
      ),
    ).toBe(true);
  });

  it("rejects connectorJson that carries secret material instead of a reference", async () => {
    const store = new InMemoryConnectorTemplateStore();
    const routes = createConnectorTemplateRoutes({ store });
    const post = handlerFor(routes, "POST", "/v1/connector-templates");

    const topLevel = await invoke(
      post,
      context({
        body: {
          id: "t6",
          name: "Leaky",
          connectorJson: { ...CONNECTOR_JSON, partnerCert: MATERIAL },
        },
      }),
    );
    expect(topLevel.status).toBe(400);
    expect((topLevel.body as Record<string, unknown>)["code"]).toBe(CONNECTOR_TEMPLATE_INVALID);

    const nested = await invoke(
      post,
      context({
        body: {
          id: "t7",
          name: "Nested leaky",
          connectorJson: { ...CONNECTOR_JSON, tlsSettings: { partnerCert: MATERIAL } },
        },
      }),
    );
    expect(nested.status).toBe(400);
    expect(
      ((nested.body as { details: Array<{ field: string }> }).details ?? []).some(
        (detail) => detail.field === "connectorJson.tlsSettings.partnerCert",
      ),
    ).toBe(true);

    expect(await store.listTemplates()).toHaveLength(0);
  });

  it("rejects a malformed secretRef and accepts a well-formed one", async () => {
    const store = new InMemoryConnectorTemplateStore();
    const routes = createConnectorTemplateRoutes({ store });
    const post = handlerFor(routes, "POST", "/v1/connector-templates");

    const malformed = await invoke(
      post,
      context({
        body: {
          id: "t8",
          name: "Bad ref",
          connectorJson: { ...CONNECTOR_JSON, tlsSettings: { secretRef: "not-a-ref" } },
        },
      }),
    );
    expect(malformed.status).toBe(400);
    expect(
      ((malformed.body as { details: Array<{ field: string }> }).details ?? []).some(
        (detail) => detail.field === "connectorJson.tlsSettings.secretRef",
      ),
    ).toBe(true);

    const accepted = await invoke(
      post,
      context({ body: { id: "t9", name: "Good ref", connectorJson: CONNECTOR_JSON } }),
    );
    expect(accepted.status).toBe(201);
    const stored = (accepted.body as Record<string, unknown>)["connectorJson"] as Record<
      string,
      unknown
    >;
    expect((stored["tlsSettings"] as Record<string, unknown>)["secretRef"]).toBe(SECRET_REF);
  });

  it("returns 404 for a missing template and 400 for a non-object body", async () => {
    const store = new InMemoryConnectorTemplateStore();
    const routes = createConnectorTemplateRoutes({ store });

    const missing = await fetch(`${await startServer(routes)}/v1/connector-templates/nope`);
    expect(missing.status).toBe(404);
    const missingBody = (await missing.json()) as Record<string, unknown>;
    expect(missingBody["code"]).toBe(CONNECTOR_TEMPLATE_NOT_FOUND);

    const badBody = await invoke(
      handlerFor(routes, "POST", "/v1/connector-templates"),
      context({ body: "not-json-object" }),
    );
    expect(badBody.status).toBe(400);
    expect((badBody.body as Record<string, unknown>)["code"]).toBe(ErrorCodes.validationFailed);
  });

  it("gates writes behind transport.write and reads behind transport.read", async () => {
    const store = new InMemoryConnectorTemplateStore();
    const routes = createConnectorTemplateRoutes({
      store,
      authorize: (_ctx, permission) => permission === CONNECTOR_TEMPLATE_PERMISSIONS.read,
    });

    const denied = await invoke(
      handlerFor(routes, "POST", "/v1/connector-templates"),
      context({ body: { id: "t10", name: "Denied", connectorJson: CONNECTOR_JSON } }),
    );
    expect(denied.status).toBe(403);
    expect((denied.body as Record<string, unknown>)["code"]).toBe(ErrorCodes.forbidden);

    const list = await fetch(`${await startServer(routes)}/v1/connector-templates`);
    expect(list.status).toBe(200);
  });

  it("default authorizer accepts transport.write or an admin scope", async () => {
    const store = new InMemoryConnectorTemplateStore();
    const routes = createConnectorTemplateRoutes({ store });
    const post = handlerFor(routes, "POST", "/v1/connector-templates");

    const withWrite = await invoke(
      post,
      context({
        body: { id: "t11", name: "Write", connectorJson: CONNECTOR_JSON },
        permissions: [CONNECTOR_TEMPLATE_PERMISSIONS.write],
      }),
    );
    expect(withWrite.status).toBe(201);

    const withAdminScope = await invoke(
      post,
      context({
        body: { id: "t12", name: "Admin", connectorJson: CONNECTOR_JSON },
        permissions: ["*"],
      }),
    );
    expect(withAdminScope.status).toBe(201);

    const withoutWrite = await invoke(
      post,
      context({
        body: { id: "t13", name: "Nope", connectorJson: CONNECTOR_JSON },
        permissions: [CONNECTOR_TEMPLATE_PERMISSIONS.read],
      }),
    );
    expect(withoutWrite.status).toBe(403);
  });

  it("round-trips through the sqlite repository and persists references, not material", async () => {
    const { store, close } = sqliteStore();
    try {
      const routes = createConnectorTemplateRoutes({ store });
      const baseUrl = await startServer(routes);

      await invoke(
        handlerFor(routes, "POST", "/v1/connector-templates"),
        context({
          body: {
            id: "sqlite-1",
            name: "SQLite",
            connectorJson: CONNECTOR_JSON,
            variables: [{ name: "partnerDomain" }],
          },
        }),
      );
      const detail = (await (
        await fetch(`${baseUrl}/v1/connector-templates/sqlite-1`)
      ).json()) as Record<string, unknown>;
      expect(detail["connectorJson"]).toEqual(CONNECTOR_JSON);
      expect(detail["source"]).toBe("local");
      expect(detail["variables"]).toEqual([{ name: "partnerDomain" }]);

      const cloned = await invoke(
        handlerFor(routes, "POST", "/v1/connector-templates/:id/clone"),
        context({
          method: "POST",
          path: "/v1/connector-templates/sqlite-1/clone",
          params: { id: "sqlite-1" },
          body: { name: "SQLite copy" },
        }),
      );
      expect(cloned.status).toBe(201);
      expect((cloned.body as Record<string, unknown>)["id"]).not.toBe("sqlite-1");
    } finally {
      close();
    }
  });
});

describe("connector template storage", () => {
  it("soft-deletes while retaining the row and clones only live templates", async () => {
    const filename = tempDbPath();
    const repo = await openSqliteConnectorTemplateRepository({ filename });
    await repo.createTemplate({ id: "tpl-1", name: "Tpl", connectorJson: CONNECTOR_JSON });

    expect(await repo.softDeleteTemplate("tpl-1", { now: "2026-02-01T00:00:00.000Z" })).toBe(true);
    expect(await repo.getTemplate("tpl-1")).toBeUndefined();
    expect(await repo.listTemplates()).toHaveLength(0);
    expect(await repo.getTemplate("tpl-1", { includeDeleted: true })).toMatchObject({
      deletedAt: "2026-02-01T00:00:00.000Z",
    });
    expect(await repo.cloneTemplate("tpl-1", { id: "tpl-2", name: "copy" })).toBeUndefined();
    expect(await repo.cloneTemplate("missing", { id: "tpl-3", name: "copy" })).toBeUndefined();
    expect(await repo.updateTemplate("tpl-1", { name: "Nope" })).toBeUndefined();
    repo.close();

    const raw = new Database(filename);
    expect(
      raw.prepare("SELECT COUNT(*) AS c FROM connector_templates WHERE id = ?").get("tpl-1"),
    ).toMatchObject({ c: 1 });
    raw.close();
  });

  it("persists connectorJson references and never secret material", async () => {
    const filename = tempDbPath();
    const repo = await openSqliteConnectorTemplateRepository({ filename });
    await repo.createTemplate({ id: "tpl-1", name: "Tpl", connectorJson: CONNECTOR_JSON });
    repo.close();

    const raw = new Database(filename);
    const row = raw
      .prepare("SELECT connectorJson FROM connector_templates WHERE id = ?")
      .get("tpl-1") as { connectorJson: string };
    expect(row.connectorJson).toContain(SECRET_REF);
    expect(row.connectorJson).not.toContain(MATERIAL);
    expect(row.connectorJson).not.toContain("partnerCert");
    raw.close();
  });

  it("constrains source to local in v1", async () => {
    const repo = await openSqliteConnectorTemplateRepository({ filename: tempDbPath() });
    await expect(
      repo.createTemplate({
        id: "x",
        name: "x",
        connectorJson: CONNECTOR_JSON,
        source: "community",
      }),
    ).rejects.toThrow();
    repo.close();
  });
});

describe("migration 0028", () => {
  it("applies with the base migrations, is re-runnable, and advances SchemaVersion", async () => {
    const filename = tempDbPath();
    const migrations = loadMigrations();
    const expected = migrations.reduce((max, migration) => Math.max(max, migration.version), 0);
    const migration = migrations.find((m) => m.version === 28);
    expect(migration?.name).toBe("0028_connector_templates.sql");

    const first = await openSqliteConnectorTemplateRepository({ filename });
    expect(first.schemaVersion).toBe(expected);
    first.close();

    const raw = new Database(filename);
    expect(
      raw.prepare("SELECT COUNT(*) AS c FROM schema_versions WHERE version = 28").get(),
    ).toMatchObject({ c: 1 });
    const tables = (
      raw.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{
        name: string;
      }>
    ).map((row) => row.name);
    expect(tables).toEqual(expect.arrayContaining(["connector_templates"]));
    const columns = (
      raw.prepare("PRAGMA table_info(connector_templates)").all() as Array<{ name: string }>
    ).map((row) => row.name);
    expect(columns).toEqual(
      expect.arrayContaining([
        "id",
        "name",
        "connectorJson",
        "variables",
        "source",
        "createdAt",
        "updatedAt",
        "deletedAt",
      ]),
    );
    raw.close();

    const second = await openSqliteConnectorTemplateRepository({ filename });
    expect(second.schemaVersion).toBe(expected);
    second.close();

    const rawAgain = new Database(filename);
    expect(
      rawAgain.prepare("SELECT COUNT(*) AS c FROM schema_versions WHERE version = 28").get(),
    ).toMatchObject({ c: 1 });
    rawAgain.close();
  });
});
