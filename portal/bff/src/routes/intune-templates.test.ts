import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { DEFAULT_HOST } from "../config.js";
import { ErrorCodes, normalizeError, toErrorBody } from "../errors.js";
import { buildServer, type Route, type RouteResponse } from "../server.js";
import {
  INTUNE_POLICY_TYPES,
  InMemoryIntuneTemplateRepository,
  SqliteIntuneTemplateRepository,
  collectPolicyJsonIssues,
  collectPolicyTypeIssues,
  intuneTemplateMigrationSql,
  isSupportedIntunePolicyType,
  type IntuneTemplateRepository,
} from "../repository/intune-templates.js";
import {
  ErrorCodesForbidden,
  ErrorCodesTemplateNotFound,
  INTUNE_TEMPLATE_ADMIN_SCOPE,
  INTUNE_TEMPLATE_PERMISSIONS,
  createIntuneTemplateRoutes,
  type IntuneTemplateRequestContext,
} from "./intune-templates.js";

const POLICY = {
  "@odata.type": "#microsoft.graph.windows10CompliancePolicy",
  displayName: "Require BitLocker",
  settings: { bitLockerEnabled: true },
};

const ASSIGNMENTS = [
  { target: { "@odata.type": "#microsoft.graph.groupAssignmentTarget", groupId: "group-1" } },
  { target: { "@odata.type": "#microsoft.graph.allDevicesAssignmentTarget" }, intent: "apply" },
];

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

function context(overrides: Partial<IntuneTemplateRequestContext> = {}): IntuneTemplateRequestContext {
  return {
    correlationId: "corr-test",
    method: "POST",
    path: "/v1/intune-templates",
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
async function invoke(route: Route, ctx: IntuneTemplateRequestContext): Promise<RouteResponse> {
  try {
    return await route.handler(ctx);
  } catch (error) {
    const appError = normalizeError(error);
    return { status: appError.status, body: toErrorBody(appError, ctx.correlationId) };
  }
}

function sqliteRepository(): { repo: SqliteIntuneTemplateRepository; close: () => void } {
  const db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  return { repo: new SqliteIntuneTemplateRepository(db), close: () => db.close() };
}

function repositoryCases(label: string, factory: () => IntuneTemplateRepository): void {
  describe(`IntuneTemplate repository (${label})`, () => {
    it("round-trips the §5 fields and defaults source to local", async () => {
      const repository = factory();
      const created = await repository.create({
        id: "template-1",
        name: "Require BitLocker",
        platform: "windows10",
        policyType: "compliance",
        policyJson: POLICY,
        assignments: ASSIGNMENTS,
      });

      expect(created).toMatchObject({
        id: "template-1",
        name: "Require BitLocker",
        platform: "windows10",
        policyType: "compliance",
        source: "local",
        deletedAt: null,
      });
      expect(created.policyJson).toEqual(POLICY);
      expect(created.assignments).toEqual(ASSIGNMENTS);

      const fetched = await repository.get("template-1");
      expect(fetched).toEqual(created);
      expect(await repository.list()).toHaveLength(1);
    });

    it("persists assignments and updates them on edit", async () => {
      const repository = factory();
      await repository.create({
        id: "template-2",
        name: "Baseline",
        platform: "windows10",
        policyType: "configuration",
        policyJson: POLICY,
      });

      const edited = await repository.update("template-2", {
        assignments: [ASSIGNMENTS[0]!],
        policyJson: { ...POLICY, displayName: "Baseline v2" },
      });
      expect(edited?.assignments).toHaveLength(1);
      expect(edited?.policyJson["displayName"]).toBe("Baseline v2");
    });

    it("soft deletes so the row survives but is hidden from list", async () => {
      const repository = factory();
      await repository.create({
        id: "template-3",
        name: "Delete me",
        platform: "windows10",
        policyType: "compliance",
        policyJson: POLICY,
      });

      expect(await repository.remove("template-3")).toBe(true);
      expect(await repository.remove("template-3")).toBe(false);
      expect(await repository.get("template-3")).toBeUndefined();
      expect(await repository.get("template-3", { includeDeleted: true })).toBeDefined();
      expect(await repository.list()).toHaveLength(0);
    });

    it("rejects a non-local source, a malformed policyJson, and an unsupported pair", async () => {
      const repository = factory();
      await expect(
        repository.create({
          id: "template-4",
          name: "Community",
          platform: "windows10",
          policyType: "compliance",
          policyJson: POLICY,
          source: "community",
        }),
      ).rejects.toThrow();
      await expect(
        repository.create({
          id: "template-5",
          name: "Bad",
          platform: "windows10",
          policyType: "compliance",
          policyJson: [] as unknown as Record<string, unknown>,
        }),
      ).rejects.toThrow();
      await expect(
        repository.create({
          id: "template-6",
          name: "Mac",
          platform: "macOS",
          policyType: "compliance",
          policyJson: POLICY,
        }),
      ).rejects.toThrow();
    });

    it("rejects a non-array assignments value", async () => {
      const repository = factory();
      await expect(
        repository.create({
          id: "template-7",
          name: "Bad assignments",
          platform: "windows10",
          policyType: "compliance",
          policyJson: POLICY,
          assignments: "group-1" as unknown as [],
        }),
      ).rejects.toThrow();
    });
  });
}

repositoryCases("in-memory", () => new InMemoryIntuneTemplateRepository());
repositoryCases("sqlite", () => sqliteRepository().repo);

describe("migration 0003_intune_templates", () => {
  it("creates the intune_templates table with the §5 columns", () => {
    const db = new Database(":memory:");
    db.exec(intuneTemplateMigrationSql());

    const tables = (
      db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{
        name: string;
      }>
    ).map((row) => row.name);
    expect(tables).toContain("intune_templates");
    const columns = (
      db.prepare("PRAGMA table_info(intune_templates)").all() as Array<{ name: string }>
    ).map((row) => row.name);
    expect(columns).toEqual(
      expect.arrayContaining([
        "id",
        "name",
        "platform",
        "policyType",
        "policyJson",
        "assignments",
        "source",
        "createdAt",
        "updatedAt",
        "deletedAt",
      ]),
    );
    db.close();
  });

  it("constrains source to local in v1", () => {
    const db = new Database(":memory:");
    db.exec(intuneTemplateMigrationSql());
    expect(() =>
      db
        .prepare(
          `INSERT INTO intune_templates (id, name, platform, policyType, policyJson, source, createdAt, updatedAt)
           VALUES ('x', 'x', 'windows10', 'compliance', '{}', 'community', 'now', 'now')`,
        )
        .run(),
    ).toThrow();
    db.close();
  });
});

describe("policy-type registry", () => {
  it("enumerates the v1 Windows configuration and compliance pairs", () => {
    expect(INTUNE_POLICY_TYPES).toEqual(
      expect.arrayContaining([
        { platform: "windows10", policyType: "configuration" },
        { platform: "windows10", policyType: "compliance" },
      ]),
    );
    expect(isSupportedIntunePolicyType("windows10", "compliance")).toBe(true);
    expect(isSupportedIntunePolicyType("macOS", "compliance")).toBe(false);
  });

  it("reports unsupported platform/policyType pairs", () => {
    expect(collectPolicyTypeIssues("windows10", "compliance")).toEqual([]);
    expect(collectPolicyTypeIssues("macOS", "compliance")).not.toEqual([]);
    expect(collectPolicyTypeIssues("windows10", "app-protection")).not.toEqual([]);
  });
});

describe("policyJson validation", () => {
  it("accepts a well-formed policy object", () => {
    expect(collectPolicyJsonIssues(POLICY)).toEqual([]);
  });

  it("rejects non-objects and a non-string @odata.type", () => {
    expect(collectPolicyJsonIssues(null)).not.toEqual([]);
    expect(
      collectPolicyJsonIssues({ displayName: "x", "@odata.type": 7 }),
    ).toEqual([expect.objectContaining({ field: "policyJson.@odata.type" })]);
  });

  it("requires a displayName (or name) and object settings", () => {
    const issues = collectPolicyJsonIssues({ settings: "nope" });
    expect(issues.map((issue) => issue.field)).toEqual(
      expect.arrayContaining(["policyJson.displayName", "policyJson.settings"]),
    );
  });
});

describe("intune-template routes", () => {
  async function routeServer(
    repository: IntuneTemplateRepository,
  ): Promise<{ baseUrl: string; routes: Route[] }> {
    const routes = createIntuneTemplateRoutes(repository);
    const baseUrl = await startServer(routes);
    return { baseUrl, routes };
  }

  it("lists, creates, edits, and deletes through the routes", async () => {
    const repository = new InMemoryIntuneTemplateRepository();
    const { baseUrl, routes } = await routeServer(repository);

    const created = await invoke(
      handlerFor(routes, "POST", "/v1/intune-templates"),
      context({
        body: {
          id: "t1",
          name: "BitLocker",
          platform: "windows10",
          policyType: "compliance",
          policyJson: POLICY,
          assignments: ASSIGNMENTS,
        },
      }),
    );
    expect(created.status).toBe(201);
    expect((created.body as Record<string, unknown>)["source"]).toBe("local");

    const listResponse = await fetch(`${baseUrl}/v1/intune-templates`);
    expect(listResponse.status).toBe(200);
    const listBody = (await listResponse.json()) as { items: unknown[] };
    expect(listBody.items).toHaveLength(1);

    const filtered = (await (
      await fetch(`${baseUrl}/v1/intune-templates?policyType=compliance`)
    ).json()) as { items: unknown[] };
    expect(filtered.items).toHaveLength(1);
    const emptyFilter = (await (
      await fetch(`${baseUrl}/v1/intune-templates?policyType=configuration`)
    ).json()) as { items: unknown[] };
    expect(emptyFilter.items).toHaveLength(0);

    const edited = await invoke(
      handlerFor(routes, "PATCH", "/v1/intune-templates/:id"),
      context({
        method: "PATCH",
        path: "/v1/intune-templates/t1",
        params: { id: "t1" },
        body: { name: "BitLocker v2", assignments: [ASSIGNMENTS[0]!] },
      }),
    );
    expect(edited.status).toBe(200);
    expect((edited.body as Record<string, unknown>)["name"]).toBe("BitLocker v2");
    expect((edited.body as Record<string, unknown>)["assignments"]).toHaveLength(1);

    const detail = (await (await fetch(`${baseUrl}/v1/intune-templates/t1`)).json()) as Record<
      string,
      unknown
    >;
    expect(detail["name"]).toBe("BitLocker v2");

    const deleted = await fetch(`${baseUrl}/v1/intune-templates/t1`, { method: "DELETE" });
    expect(deleted.status).toBe(204);
    expect((await fetch(`${baseUrl}/v1/intune-templates/t1`)).status).toBe(404);
    expect((await fetch(`${baseUrl}/v1/intune-templates`)).status).toBe(200);
  });

  it("clones a live policy's JSON and assignments into a template", async () => {
    const repository = new InMemoryIntuneTemplateRepository();
    const routes = createIntuneTemplateRoutes(repository);

    const cloned = await invoke(handlerFor(routes, "POST", "/v1/intune-templates"), context({
      body: {
        id: "clone-1",
        name: "Clone of live policy",
        platform: "windows10",
        policyType: "configuration",
        policyJson: POLICY,
        assignments: ASSIGNMENTS,
      },
    }));
    expect(cloned.status).toBe(201);
    expect((cloned.body as Record<string, unknown>)["policyJson"]).toEqual(POLICY);
    expect((cloned.body as Record<string, unknown>)["assignments"]).toEqual(ASSIGNMENTS);
  });

  it("rejects a community source, an unsupported pair, and a malformed policyJson with 400", async () => {
    const repository = new InMemoryIntuneTemplateRepository();
    const routes = createIntuneTemplateRoutes(repository);
    const post = handlerFor(routes, "POST", "/v1/intune-templates");

    const community = await invoke(
      post,
      context({
        body: {
          id: "t2",
          name: "Community",
          platform: "windows10",
          policyType: "compliance",
          policyJson: POLICY,
          source: "community",
        },
      }),
    );
    expect(community.status).toBe(400);
    expect((community.body as Record<string, unknown>)["code"]).toBe(ErrorCodes.validationFailed);

    const unsupported = await invoke(
      post,
      context({
        body: {
          id: "t3",
          name: "Mac",
          platform: "macOS",
          policyType: "compliance",
          policyJson: POLICY,
        },
      }),
    );
    expect(unsupported.status).toBe(400);
    expect(
      ((unsupported.body as { details: Array<{ field: string }> }).details ?? []).some(
        (detail) => detail.field === "policyType",
      ),
    ).toBe(true);

    const badPolicy = await invoke(
      post,
      context({
        body: {
          id: "t4",
          name: "Bad",
          platform: "windows10",
          policyType: "compliance",
          policyJson: { displayName: "x", settings: "nope" },
        },
      }),
    );
    expect(badPolicy.status).toBe(400);
    expect(
      ((badPolicy.body as { details: Array<{ field: string }> }).details ?? []).some(
        (detail) => detail.field === "policyJson.settings",
      ),
    ).toBe(true);
  });

  it("returns 404 for a missing template and 400 for a non-object body", async () => {
    const repository = new InMemoryIntuneTemplateRepository();
    const routes = createIntuneTemplateRoutes(repository);

    const missing = await fetch(`${await startServer(routes)}/v1/intune-templates/nope`);
    expect(missing.status).toBe(404);
    const missingBody = (await missing.json()) as Record<string, unknown>;
    expect(missingBody["code"]).toBe(ErrorCodesTemplateNotFound);

    const badBody = await invoke(
      handlerFor(routes, "POST", "/v1/intune-templates"),
      context({ body: "not-json-object" }),
    );
    expect(badBody.status).toBe(400);
  });

  it("gates writes behind intune.templates and reads behind intune.read", async () => {
    const repository = new InMemoryIntuneTemplateRepository();
    const routes = createIntuneTemplateRoutes(repository, {
      authorize: (_ctx, permission) => permission === INTUNE_TEMPLATE_PERMISSIONS.read,
    });

    const denied = await invoke(
      handlerFor(routes, "POST", "/v1/intune-templates"),
      context({
        body: {
          id: "t5",
          name: "Denied",
          platform: "windows10",
          policyType: "compliance",
          policyJson: POLICY,
        },
      }),
    );
    expect(denied.status).toBe(403);
    expect((denied.body as Record<string, unknown>)["code"]).toBe(ErrorCodesForbidden);

    const list = await fetch(`${await startServer(routes)}/v1/intune-templates`);
    expect(list.status).toBe(200);
  });

  it("default authorizer accepts intune.templates or an admin scope", async () => {
    const repository = new InMemoryIntuneTemplateRepository();
    const routes = createIntuneTemplateRoutes(repository);
    const post = handlerFor(routes, "POST", "/v1/intune-templates");

    const withTemplates = await invoke(
      post,
      context({
        body: {
          id: "t6",
          name: "Allowed",
          platform: "windows10",
          policyType: "compliance",
          policyJson: POLICY,
        },
        permissions: [INTUNE_TEMPLATE_PERMISSIONS.templates],
      }),
    );
    expect(withTemplates.status).toBe(201);

    const withAdminScope = await invoke(
      post,
      context({
        body: {
          id: "t7",
          name: "Admin",
          platform: "windows10",
          policyType: "compliance",
          policyJson: POLICY,
        },
        permissions: [INTUNE_TEMPLATE_ADMIN_SCOPE],
      }),
    );
    expect(withAdminScope.status).toBe(201);

    const withoutTemplates = await invoke(
      post,
      context({
        body: {
          id: "t8",
          name: "Nope",
          platform: "windows10",
          policyType: "compliance",
          policyJson: POLICY,
        },
        permissions: [INTUNE_TEMPLATE_PERMISSIONS.read],
      }),
    );
    expect(withoutTemplates.status).toBe(403);
  });

  it("round-trips through the sqlite repository end to end", async () => {
    const { repo } = sqliteRepository();
    const routes = createIntuneTemplateRoutes(repo);
    const baseUrl = await startServer(routes);

    await invoke(
      handlerFor(routes, "POST", "/v1/intune-templates"),
      context({
        body: {
          id: "sqlite-1",
          name: "SQLite",
          platform: "windows10",
          policyType: "compliance",
          policyJson: POLICY,
          assignments: ASSIGNMENTS,
        },
      }),
    );
    const detail = (await (await fetch(`${baseUrl}/v1/intune-templates/sqlite-1`)).json()) as Record<
      string,
      unknown
    >;
    expect(detail["policyJson"]).toEqual(POLICY);
    expect(detail["assignments"]).toEqual(ASSIGNMENTS);
  });
});
