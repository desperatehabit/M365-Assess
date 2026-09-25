import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { DEFAULT_HOST } from "../config.js";
import { ErrorCodes, normalizeError, toErrorBody } from "../errors.js";
import { buildServer, type Route, type RouteResponse } from "../server.js";
import {
  InMemoryCaTemplateRepository,
  SqliteCaTemplateRepository,
  caTemplateMigrationSql,
  collectPolicyJsonIssues,
  type CaTemplateRepository,
} from "../repository/ca-templates.js";
import {
  CA_TEMPLATE_ADMIN_SCOPE,
  CA_TEMPLATE_PERMISSIONS,
  ErrorCodesForbidden,
  ErrorCodesTemplateNotFound,
  createCaTemplateRoutes,
  type CaTemplateRequestContext,
} from "./ca-templates.js";

const POLICY = {
  displayName: "Require MFA for admins",
  state: "enabled",
  conditions: { users: { includeRoles: ["role"] } },
  grantControls: { operator: "OR", builtInControls: ["mfa"] },
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
  overrides: Partial<CaTemplateRequestContext> = {},
): CaTemplateRequestContext {
  return {
    correlationId: "corr-test",
    method: "POST",
    path: "/v1/ca-templates",
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
async function invoke(route: Route, ctx: CaTemplateRequestContext): Promise<RouteResponse> {
  try {
    return await route.handler(ctx);
  } catch (error) {
    const appError = normalizeError(error);
    return { status: appError.status, body: toErrorBody(appError, ctx.correlationId) };
  }
}

function sqliteRepository(): { repo: SqliteCaTemplateRepository; close: () => void } {
  const db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  return { repo: new SqliteCaTemplateRepository(db), close: () => db.close() };
}

function repositoryCases(
  label: string,
  factory: () => CaTemplateRepository,
): void {
  describe(`CaTemplate repository (${label})`, () => {
    it("round-trips the §5 fields and defaults source to local", async () => {
      const repository = factory();
      const created = await repository.create({
        id: "template-1",
        name: "Require MFA for admins",
        policyJson: POLICY,
        category: "identity",
      });

      expect(created).toMatchObject({
        id: "template-1",
        name: "Require MFA for admins",
        source: "local",
        category: "identity",
        version: 1,
        deletedAt: null,
      });
      expect(created.policyJson).toEqual(POLICY);
      expect(created.createdAt).toEqual(expect.any(String));

      const fetched = await repository.get("template-1");
      expect(fetched).toEqual(created);
      expect(await repository.list()).toHaveLength(1);
    });

    it("increments version on edit and snapshots each revision", async () => {
      const repository = factory();
      await repository.create({ id: "template-2", name: "Baseline", policyJson: POLICY });

      const edited = await repository.update("template-2", {
        name: "Baseline v2",
        policyJson: { ...POLICY, state: "enabledForReportingButNotEnforced" },
      });
      expect(edited?.version).toBe(2);
      expect(edited?.name).toBe("Baseline v2");

      const history = await repository.listVersions("template-2");
      expect(history.map((entry) => entry.version)).toEqual([1, 2]);
      expect(history[0]?.policyJson["state"]).toBe("enabled");
      expect((await repository.getVersion("template-2", 2))?.policyJson["state"]).toBe(
        "enabledForReportingButNotEnforced",
      );
    });

    it("soft deletes so the row survives but is hidden from list", async () => {
      const repository = factory();
      await repository.create({ id: "template-3", name: "Delete me", policyJson: POLICY });

      expect(await repository.remove("template-3")).toBe(true);
      expect(await repository.remove("template-3")).toBe(false);
      expect(await repository.get("template-3")).toBeUndefined();
      expect(await repository.get("template-3", { includeDeleted: true })).toBeDefined();
      expect(await repository.list()).toHaveLength(0);
    });

    it("rejects a non-local source and a malformed policyJson", async () => {
      const repository = factory();
      await expect(
        repository.create({
          id: "template-4",
          name: "Community",
          policyJson: POLICY,
          source: "community",
        }),
      ).rejects.toThrow();
      await expect(
        repository.create({ id: "template-5", name: "Bad", policyJson: [] as unknown as Record<string, unknown> }),
      ).rejects.toThrow();
    });
  });
}

repositoryCases("in-memory", () => new InMemoryCaTemplateRepository());
repositoryCases("sqlite", () => sqliteRepository().repo);

describe("migration 0003", () => {
  it("creates the versioned ca_templates table and history", () => {
    const db = new Database(":memory:");
    db.exec(caTemplateMigrationSql());

    const tables = (
      db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{
        name: string;
      }>
    ).map((row) => row.name);
    expect(tables).toEqual(
      expect.arrayContaining(["ca_templates", "ca_template_versions"]),
    );
    const columns = (
      db.prepare("PRAGMA table_info(ca_templates)").all() as Array<{ name: string }>
    ).map((row) => row.name);
    expect(columns).toEqual(
      expect.arrayContaining([
        "id",
        "name",
        "policyJson",
        "source",
        "category",
        "version",
        "createdAt",
        "updatedAt",
        "deletedAt",
      ]),
    );
    db.close();
  });

  it("constrains source to local in v1", () => {
    const db = new Database(":memory:");
    db.exec(caTemplateMigrationSql());
    expect(() =>
      db
        .prepare(
          `INSERT INTO ca_templates (id, name, policyJson, source, version, createdAt, updatedAt)
           VALUES ('x', 'x', '{}', 'community', 1, 'now', 'now')`,
        )
        .run(),
    ).toThrow();
    db.close();
  });
});

describe("policyJson validation", () => {
  it("accepts a well-formed CA policy object", () => {
    expect(collectPolicyJsonIssues(POLICY)).toEqual([]);
  });

  it("rejects non-objects and unknown state values", () => {
    expect(collectPolicyJsonIssues(null)).not.toEqual([]);
    expect(collectPolicyJsonIssues({ displayName: "x", state: "maybe" })).toEqual([
      expect.objectContaining({ field: "policyJson.state" }),
    ]);
  });

  it("requires a displayName (or name) and object conditions", () => {
    const issues = collectPolicyJsonIssues({ conditions: "nope" });
    expect(issues.map((issue) => issue.field)).toEqual(
      expect.arrayContaining(["policyJson.displayName", "policyJson.conditions"]),
    );
  });
});

describe("ca-template routes", () => {
  async function routeServer(
    repository: CaTemplateRepository,
  ): Promise<{ baseUrl: string; routes: Route[] }> {
    const routes = createCaTemplateRoutes(repository);
    const baseUrl = await startServer(routes);
    return { baseUrl, routes };
  }

  it("lists, creates, edits, and deletes through the routes", async () => {
    const repository = new InMemoryCaTemplateRepository();
    const { baseUrl, routes } = await routeServer(repository);

    const created = await invoke(handlerFor(routes, "POST", "/v1/ca-templates"),
      context({ body: { id: "t1", name: "MFA", policyJson: POLICY, category: "identity" } }),
    );
    expect(created.status).toBe(201);
    expect((created.body as Record<string, unknown>)["source"]).toBe("local");

    const listResponse = await fetch(`${baseUrl}/v1/ca-templates`);
    expect(listResponse.status).toBe(200);
    const listBody = (await listResponse.json()) as { items: unknown[] };
    expect(listBody.items).toHaveLength(1);

    const filtered = (await (
      await fetch(`${baseUrl}/v1/ca-templates?category=identity`)
    ).json()) as { items: unknown[] };
    expect(filtered.items).toHaveLength(1);
    const emptyFilter = (await (
      await fetch(`${baseUrl}/v1/ca-templates?category=other`)
    ).json()) as { items: unknown[] };
    expect(emptyFilter.items).toHaveLength(0);

    const edited = await invoke(handlerFor(routes, "PATCH", "/v1/ca-templates/:id"),
      context({
        method: "PATCH",
        path: "/v1/ca-templates/t1",
        params: { id: "t1" },
        body: { name: "MFA v2", policyJson: { ...POLICY, state: "disabled" } },
      }),
    );
    expect(edited.status).toBe(200);
    expect((edited.body as Record<string, unknown>)["version"]).toBe(2);

    const detail = (await (await fetch(`${baseUrl}/v1/ca-templates/t1`)).json()) as Record<
      string,
      unknown
    >;
    expect(detail["name"]).toBe("MFA v2");

    const versions = (await (
      await fetch(`${baseUrl}/v1/ca-templates/t1/versions`)
    ).json()) as { items: unknown[] };
    expect(versions.items).toHaveLength(2);

    const deleted = await fetch(`${baseUrl}/v1/ca-templates/t1`, { method: "DELETE" });
    expect(deleted.status).toBe(204);
    expect((await fetch(`${baseUrl}/v1/ca-templates/t1`)).status).toBe(404);
    expect((await fetch(`${baseUrl}/v1/ca-templates`)).status).toBe(200);
  });

  it("rejects a community source and a malformed policyJson with 400", async () => {
    const repository = new InMemoryCaTemplateRepository();
    const routes = createCaTemplateRoutes(repository);
    const post = handlerFor(routes, "POST", "/v1/ca-templates");

    const community = await invoke(post,
      context({ body: { id: "t2", name: "Community", policyJson: POLICY, source: "community" } }),
    );
    expect(community.status).toBe(400);
    expect((community.body as Record<string, unknown>)["code"]).toBe(ErrorCodes.validationFailed);

    const badPolicy = await invoke(post,
      context({ body: { id: "t3", name: "Bad", policyJson: { displayName: "x", state: "nope" } } }),
    );
    expect(badPolicy.status).toBe(400);
    expect(
      ((badPolicy.body as { details: Array<{ field: string }> }).details ?? []).some(
        (detail) => detail.field === "policyJson.state",
      ),
    ).toBe(true);
  });

  it("returns 404 for a missing template and 400 for a non-object body", async () => {
    const repository = new InMemoryCaTemplateRepository();
    const routes = createCaTemplateRoutes(repository);

    const missing = await fetch(`${await startServer(routes)}/v1/ca-templates/nope`);
    expect(missing.status).toBe(404);
    const missingBody = (await missing.json()) as Record<string, unknown>;
    expect(missingBody["code"]).toBe(ErrorCodesTemplateNotFound);

    const badBody = await invoke(handlerFor(routes, "POST", "/v1/ca-templates"),
      context({ body: "not-json-object" }),
    );
    expect(badBody.status).toBe(400);
  });

  it("gates writes behind ca.deploy and reads behind ca.read", async () => {
    const repository = new InMemoryCaTemplateRepository();
    const routes = createCaTemplateRoutes(repository, {
      authorize: (_ctx, permission) => permission === CA_TEMPLATE_PERMISSIONS.read,
    });

    const denied = await invoke(handlerFor(routes, "POST", "/v1/ca-templates"),
      context({ body: { id: "t4", name: "Denied", policyJson: POLICY } }),
    );
    expect(denied.status).toBe(403);
    expect((denied.body as Record<string, unknown>)["code"]).toBe(ErrorCodesForbidden);

    const list = await fetch(`${await startServer(routes)}/v1/ca-templates`);
    expect(list.status).toBe(200);
  });

  it("default authorizer accepts ca.deploy or an admin scope", async () => {
    const repository = new InMemoryCaTemplateRepository();
    const routes = createCaTemplateRoutes(repository);
    const post = handlerFor(routes, "POST", "/v1/ca-templates");

    const withDeploy = await invoke(
      post,
      context({
        body: { id: "t5", name: "Deploy", policyJson: POLICY },
        permissions: [CA_TEMPLATE_PERMISSIONS.deploy],
      }),
    );
    expect(withDeploy.status).toBe(201);

    const withAdminScope = await invoke(
      post,
      context({
        body: { id: "t6", name: "Admin", policyJson: POLICY },
        permissions: [CA_TEMPLATE_ADMIN_SCOPE],
      }),
    );
    expect(withAdminScope.status).toBe(201);

    const withoutDeploy = await invoke(
      post,
      context({
        body: { id: "t7", name: "Nope", policyJson: POLICY },
        permissions: [CA_TEMPLATE_PERMISSIONS.read],
      }),
    );
    expect(withoutDeploy.status).toBe(403);
  });

  it("round-trips through the sqlite repository end to end", async () => {
    const { repo } = sqliteRepository();
    const routes = createCaTemplateRoutes(repo);
    const baseUrl = await startServer(routes);

    await invoke(handlerFor(routes, "POST", "/v1/ca-templates"),
      context({ body: { id: "sqlite-1", name: "SQLite", policyJson: POLICY } }),
    );
    const detail = (await (await fetch(`${baseUrl}/v1/ca-templates/sqlite-1`)).json()) as Record<
      string,
      unknown
    >;
    expect(detail["policyJson"]).toEqual(POLICY);
    expect(detail["version"]).toBe(1);
  });
});
