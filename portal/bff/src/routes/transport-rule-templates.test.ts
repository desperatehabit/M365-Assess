import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { SqliteTransportRuleTemplateRepository } from "../../../db/src/transport-template-repository.js";
import { loadMigrations, runMigrations } from "../../../db/src/sqlite-repository.js";
import { DEFAULT_HOST } from "../config.js";
import { ErrorCodes, normalizeError, toErrorBody } from "../errors.js";
import { buildServer, type Route, type RouteResponse } from "../server.js";
import {
  TRANSPORT_RULE_TEMPLATE_INVALID,
  TRANSPORT_RULE_TEMPLATE_NOT_FOUND,
  TRANSPORT_RULE_TEMPLATE_PERMISSIONS,
  createTransportRuleTemplateRoutes,
  type StoredTransportRuleTemplate,
  type TransportRuleTemplateRequestContext,
  type TransportRuleTemplateStore,
} from "./transport-rule-templates.js";

const RULE_JSON = {
  name: "Block external forwarding",
  conditions: { fromScope: "NotInOrganization" },
  actions: { rejectMessage: "External forwarding is not allowed" },
  exceptions: null,
};

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

async function startServer(routes: readonly Route[]): Promise<string> {
  const server = buildServer({ routes });
  await new Promise<void>((resolve) => server.listen(0, DEFAULT_HOST, resolve));
  openServers.push(server);
  const { port } = server.address() as AddressInfo;
  return `http://${DEFAULT_HOST}:${port}`;
}

function context(
  overrides: Partial<TransportRuleTemplateRequestContext> = {},
): TransportRuleTemplateRequestContext {
  return {
    correlationId: "corr-test",
    method: "POST",
    path: "/v1/transport-rule-templates",
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

/**
 * Runs a handler the way the server does: mapping a thrown AppError to the
 * structured error response `handleRequest` would have produced.
 */
async function invoke(
  route: Route,
  ctx: TransportRuleTemplateRequestContext,
): Promise<RouteResponse> {
  try {
    return await route.handler(ctx);
  } catch (error) {
    const appError = normalizeError(error);
    return { status: appError.status, body: toErrorBody(appError, ctx.correlationId) };
  }
}

class InMemoryTransportRuleTemplateStore implements TransportRuleTemplateStore {
  private readonly rows = new Map<string, StoredTransportRuleTemplate>();

  async createTemplate(input: {
    id?: string;
    name: string;
    ruleJson: Record<string, unknown>;
    variables?: Array<{ name: string; defaultValue?: string }>;
    source?: string;
    createdAt?: string;
    updatedAt?: string;
  }): Promise<StoredTransportRuleTemplate> {
    const at = input.createdAt ?? "2026-01-01T00:00:00.000Z";
    const row: StoredTransportRuleTemplate = {
      id: input.id ?? `template-${this.rows.size + 1}`,
      name: input.name,
      ruleJson: input.ruleJson,
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
  ): Promise<StoredTransportRuleTemplate | undefined> {
    const row = this.rows.get(id);
    if (!row || (!options.includeDeleted && row.deletedAt !== null)) return undefined;
    return { ...row, variables: [...row.variables] };
  }

  async listTemplates(options: { includeDeleted?: boolean } = {}): Promise<StoredTransportRuleTemplate[]> {
    return [...this.rows.values()]
      .filter((row) => options.includeDeleted === true || row.deletedAt === null)
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((row) => ({ ...row, variables: [...row.variables] }));
  }

  async updateTemplate(
    id: string,
    input: {
      name?: string;
      ruleJson?: Record<string, unknown>;
      variables?: Array<{ name: string; defaultValue?: string }>;
      source?: string;
      updatedAt?: string;
    },
  ): Promise<StoredTransportRuleTemplate | undefined> {
    const existing = this.rows.get(id);
    if (!existing || existing.deletedAt !== null) return undefined;
    const next: StoredTransportRuleTemplate = {
      ...existing,
      name: input.name ?? existing.name,
      ruleJson: input.ruleJson ?? existing.ruleJson,
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
  ): Promise<StoredTransportRuleTemplate | undefined> {
    const source = this.rows.get(sourceId);
    if (!source || source.deletedAt !== null) return undefined;
    const at = input.createdAt ?? "2026-01-04T00:00:00.000Z";
    const row: StoredTransportRuleTemplate = {
      id: input.id ?? `template-${this.rows.size + 1}`,
      name: input.name,
      ruleJson: source.ruleJson,
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

function sqliteStore(): { store: TransportRuleTemplateStore; close: () => void } {
  const db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  const schemaVersion = runMigrations(db, loadMigrations());
  return {
    store: new SqliteTransportRuleTemplateRepository(db, schemaVersion),
    close: () => db.close(),
  };
}

describe("transport rule template routes", () => {
  it("lists, creates, reads, updates, clones, and deletes through the routes", async () => {
    const store = new InMemoryTransportRuleTemplateStore();
    const routes = createTransportRuleTemplateRoutes({ store });
    const baseUrl = await startServer(routes);

    const created = await invoke(
      handlerFor(routes, "POST", "/v1/transport-rule-templates"),
      context({
        body: {
          id: "t1",
          name: "Block forwarding",
          ruleJson: RULE_JSON,
          variables: [{ name: "allowedDomain", defaultValue: "example.com" }],
        },
      }),
    );
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({
      id: "t1",
      name: "Block forwarding",
      source: "local",
    });
    expect((created.body as Record<string, unknown>)["ruleJson"]).toEqual(RULE_JSON);

    const listResponse = await fetch(`${baseUrl}/v1/transport-rule-templates`);
    expect(listResponse.status).toBe(200);
    const listBody = (await listResponse.json()) as { items: Array<Record<string, unknown>> };
    expect(listBody.items).toHaveLength(1);
    expect(listBody.items[0]?.["variables"]).toEqual([
      { name: "allowedDomain", defaultValue: "example.com" },
    ]);

    const detail = (await (
      await fetch(`${baseUrl}/v1/transport-rule-templates/t1`)
    ).json()) as Record<string, unknown>;
    expect(detail["name"]).toBe("Block forwarding");

    const edited = await invoke(
      handlerFor(routes, "PATCH", "/v1/transport-rule-templates/:id"),
      context({
        method: "PATCH",
        path: "/v1/transport-rule-templates/t1",
        params: { id: "t1" },
        body: { name: "Block forwarding v2" },
      }),
    );
    expect(edited.status).toBe(200);
    expect((edited.body as Record<string, unknown>)["name"]).toBe("Block forwarding v2");

    const cloned = await invoke(
      handlerFor(routes, "POST", "/v1/transport-rule-templates/:id/clone"),
      context({
        method: "POST",
        path: "/v1/transport-rule-templates/t1/clone",
        params: { id: "t1" },
        body: { name: "Block forwarding (copy)" },
      }),
    );
    expect(cloned.status).toBe(201);
    const cloneBody = cloned.body as Record<string, unknown>;
    expect(cloneBody["id"]).not.toBe("t1");
    expect(cloneBody["name"]).toBe("Block forwarding (copy)");
    expect(cloneBody["ruleJson"]).toEqual(RULE_JSON);
    expect(cloneBody["source"]).toBe("local");

    const deleted = await fetch(`${baseUrl}/v1/transport-rule-templates/t1`, { method: "DELETE" });
    expect(deleted.status).toBe(204);
    expect((await fetch(`${baseUrl}/v1/transport-rule-templates/t1`)).status).toBe(404);
    const afterDelete = (await (
      await fetch(`${baseUrl}/v1/transport-rule-templates`)
    ).json()) as { items: unknown[] };
    expect(afterDelete.items).toHaveLength(1);
  });

  it("defaults a clone name to '<name> (copy)'", async () => {
    const store = new InMemoryTransportRuleTemplateStore();
    const routes = createTransportRuleTemplateRoutes({ store });
    await invoke(
      handlerFor(routes, "POST", "/v1/transport-rule-templates"),
      context({ body: { id: "t1", name: "Original", ruleJson: RULE_JSON } }),
    );

    const cloned = await invoke(
      handlerFor(routes, "POST", "/v1/transport-rule-templates/:id/clone"),
      context({
        method: "POST",
        path: "/v1/transport-rule-templates/t1/clone",
        params: { id: "t1" },
      }),
    );
    expect(cloned.status).toBe(201);
    expect((cloned.body as Record<string, unknown>)["name"]).toBe("Original (copy)");
  });

  it("allows a partial update that omits the name", async () => {
    const store = new InMemoryTransportRuleTemplateStore();
    const routes = createTransportRuleTemplateRoutes({ store });
    await invoke(
      handlerFor(routes, "POST", "/v1/transport-rule-templates"),
      context({ body: { id: "t1", name: "Original", ruleJson: RULE_JSON } }),
    );

    const edited = await invoke(
      handlerFor(routes, "PATCH", "/v1/transport-rule-templates/:id"),
      context({
        method: "PATCH",
        path: "/v1/transport-rule-templates/t1",
        params: { id: "t1" },
        body: { ruleJson: { ...RULE_JSON, name: "Renamed rule" } },
      }),
    );
    expect(edited.status).toBe(200);
    const body = edited.body as Record<string, unknown>;
    expect(body["name"]).toBe("Original");
    expect(body["ruleJson"]).toMatchObject({ name: "Renamed rule" });
  });

  it("rejects an update that supplies an empty name", async () => {
    const store = new InMemoryTransportRuleTemplateStore();
    const routes = createTransportRuleTemplateRoutes({ store });
    await invoke(
      handlerFor(routes, "POST", "/v1/transport-rule-templates"),
      context({ body: { id: "t1", name: "Original", ruleJson: RULE_JSON } }),
    );

    const edited = await invoke(
      handlerFor(routes, "PATCH", "/v1/transport-rule-templates/:id"),
      context({
        method: "PATCH",
        path: "/v1/transport-rule-templates/t1",
        params: { id: "t1" },
        body: { name: "" },
      }),
    );
    expect(edited.status).toBe(400);
  });

  it("rejects a community source and a malformed body with 400", async () => {
    const store = new InMemoryTransportRuleTemplateStore();
    const routes = createTransportRuleTemplateRoutes({ store });
    const post = handlerFor(routes, "POST", "/v1/transport-rule-templates");

    const community = await invoke(
      post,
      context({ body: { id: "t2", name: "Community", ruleJson: RULE_JSON, source: "community" } }),
    );
    expect(community.status).toBe(400);
    expect((community.body as Record<string, unknown>)["code"]).toBe(TRANSPORT_RULE_TEMPLATE_INVALID);

    const badRule = await invoke(
      post,
      context({ body: { id: "t3", name: "Bad", ruleJson: "not-an-object" } }),
    );
    expect(badRule.status).toBe(400);

    const badName = await invoke(post, context({ body: { id: "t4", name: "", ruleJson: RULE_JSON } }));
    expect(badName.status).toBe(400);

    const badVariable = await invoke(
      post,
      context({
        body: { id: "t5", name: "Vars", ruleJson: RULE_JSON, variables: [{ name: "not valid" }] },
      }),
    );
    expect(badVariable.status).toBe(400);
    expect(
      ((badVariable.body as { details: Array<{ field: string }> }).details ?? []).some(
        (detail) => detail.field === "variables[0].name",
      ),
    ).toBe(true);
  });

  it("returns 404 for a missing template and 400 for a non-object body", async () => {
    const store = new InMemoryTransportRuleTemplateStore();
    const routes = createTransportRuleTemplateRoutes({ store });

    const missing = await fetch(`${await startServer(routes)}/v1/transport-rule-templates/nope`);
    expect(missing.status).toBe(404);
    const missingBody = (await missing.json()) as Record<string, unknown>;
    expect(missingBody["code"]).toBe(TRANSPORT_RULE_TEMPLATE_NOT_FOUND);

    const badBody = await invoke(
      handlerFor(routes, "POST", "/v1/transport-rule-templates"),
      context({ body: "not-json-object" }),
    );
    expect(badBody.status).toBe(400);
    expect((badBody.body as Record<string, unknown>)["code"]).toBe(ErrorCodes.validationFailed);
  });

  it("gates writes behind Exchange.Transport.ReadWrite and reads behind Exchange.Transport.Read", async () => {
    const store = new InMemoryTransportRuleTemplateStore();
    const routes = createTransportRuleTemplateRoutes({
      store,
      authorize: (_ctx, permission) => permission === TRANSPORT_RULE_TEMPLATE_PERMISSIONS.read,
    });

    const denied = await invoke(
      handlerFor(routes, "POST", "/v1/transport-rule-templates"),
      context({ body: { id: "t6", name: "Denied", ruleJson: RULE_JSON } }),
    );
    expect(denied.status).toBe(403);
    expect((denied.body as Record<string, unknown>)["code"]).toBe(ErrorCodes.forbidden);

    const list = await fetch(`${await startServer(routes)}/v1/transport-rule-templates`);
    expect(list.status).toBe(200);
  });

  it("default authorizer accepts Exchange.Transport.ReadWrite or an admin scope", async () => {
    const store = new InMemoryTransportRuleTemplateStore();
    const routes = createTransportRuleTemplateRoutes({ store });
    const post = handlerFor(routes, "POST", "/v1/transport-rule-templates");

    const withWrite = await invoke(
      post,
      context({
        body: { id: "t7", name: "Write", ruleJson: RULE_JSON },
        permissions: [TRANSPORT_RULE_TEMPLATE_PERMISSIONS.write],
      }),
    );
    expect(withWrite.status).toBe(201);

    const withAdminScope = await invoke(
      post,
      context({ body: { id: "t8", name: "Admin", ruleJson: RULE_JSON }, permissions: ["*"] }),
    );
    expect(withAdminScope.status).toBe(201);

    const withoutWrite = await invoke(
      post,
      context({
        body: { id: "t9", name: "Nope", ruleJson: RULE_JSON },
        permissions: [TRANSPORT_RULE_TEMPLATE_PERMISSIONS.read],
      }),
    );
    expect(withoutWrite.status).toBe(403);
  });

  it("round-trips through the sqlite repository end to end", async () => {
    const { store, close } = sqliteStore();
    try {
      const routes = createTransportRuleTemplateRoutes({ store });
      const baseUrl = await startServer(routes);

      await invoke(
        handlerFor(routes, "POST", "/v1/transport-rule-templates"),
        context({
          body: {
            id: "sqlite-1",
            name: "SQLite",
            ruleJson: RULE_JSON,
            variables: [{ name: "allowedDomain" }],
          },
        }),
      );
      const detail = (await (
        await fetch(`${baseUrl}/v1/transport-rule-templates/sqlite-1`)
      ).json()) as Record<string, unknown>;
      expect(detail["ruleJson"]).toEqual(RULE_JSON);
      expect(detail["source"]).toBe("local");
      expect(detail["variables"]).toEqual([{ name: "allowedDomain" }]);

      const cloned = await invoke(
        handlerFor(routes, "POST", "/v1/transport-rule-templates/:id/clone"),
        context({
          method: "POST",
          path: "/v1/transport-rule-templates/sqlite-1/clone",
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
