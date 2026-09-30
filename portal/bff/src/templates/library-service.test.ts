import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { DEFAULT_HOST } from "../config.js";
import { ErrorCodes, normalizeError, toErrorBody } from "../errors.js";
import { buildServer, type Route, type RouteResponse } from "../server.js";
import { testPortalAccess } from "../rbac/test-portal-access.js";
import {
  InvalidTemplateTypeError,
  TEMPLATE_TYPES,
  openSqliteTemplateRepository,
  type TemplateLibraryItem,
  type TemplateRepository,
} from "@m365-assess/db";
import {
  TEMPLATE_LIBRARY_PATH,
  TEMPLATE_LIBRARY_PERMISSIONS,
  ErrorCodesForbidden,
  ErrorCodesTemplateNotFound,
  createTemplateLibraryRoutes,
  type TemplateLibraryRequestContext,
} from "./library-routes.js";
import { TemplateLibraryRepositoryService, type TemplateLibraryService } from "./library-service.js";

const tempDirs: string[] = [];

function tempDbPath(): string {
  const dir = mkdtempSync(join(tmpdir(), "m365-library-"));
  tempDirs.push(dir);
  return join(dir, "portal.db");
}

afterEach(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
  tempDirs.length = 0;
});

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

function context(overrides: Partial<TemplateLibraryRequestContext> = {}): TemplateLibraryRequestContext {
  return {
    correlationId: "corr-test",
    method: "GET",
    path: TEMPLATE_LIBRARY_PATH,
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
async function invoke(route: Route, ctx: TemplateLibraryRequestContext): Promise<RouteResponse> {
  try {
    return await route.handler(ctx);
  } catch (error) {
    const appError = normalizeError(error);
    return { status: appError.status, body: toErrorBody(appError, ctx.correlationId) };
  }
}

async function seededService(): Promise<{
  service: TemplateLibraryService;
  repository: TemplateRepository;
  close: () => void;
}> {
  const repository = await openSqliteTemplateRepository({ filename: tempDbPath() });
  return {
    service: new TemplateLibraryRepositoryService(repository),
    repository,
    close: () => repository.close(),
  };
}

async function seed(repository: TemplateRepository, id: string, extra: Partial<Omit<TemplateLibraryItem, "id">> = {}): Promise<void> {
  await repository.upsertTemplateLibraryItem({
    id,
    type: "conditional-access",
    name: `Item ${id}`,
    body: JSON.stringify({ displayName: id }),
    source: "local",
    repoId: null,
    ...extra,
  });
}

describe("TemplateLibraryService (sqlite)", () => {
  it("lists local items filterable by type", async () => {
    const { service, repository, close } = await seededService();
    try {
      await seed(repository, "ca-1", { type: "conditional-access", name: "Require MFA" });
      await seed(repository, "group-1", { type: "group", name: "All users" });

      const all = await service.listLocalItems();
      expect(all.map((item) => item.id).sort()).toEqual(["ca-1", "group-1"]);

      const filtered = await service.listLocalItems({ type: "group" });
      expect(filtered.map((item) => item.id)).toEqual(["group-1"]);

      await expect(service.listLocalItems({ type: "bogus" })).rejects.toBeInstanceOf(
        InvalidTemplateTypeError,
      );
    } finally {
      close();
    }
  });

  it("getLocalItem and deleteLocalItem stay local-only", async () => {
    const { service, repository, close } = await seededService();
    try {
      await seed(repository, "local-1");
      await repository.upsertTemplateRepo({
        id: "repo-1",
        url: "https://example.invalid/community",
        name: "Community",
        types: ["conditional-access"],
        writeAccess: false,
        builtin: true,
        signed: false,
        reviewState: "unreviewed",
        trusted: false,
      });
      await seed(repository, "community-1", { source: "community", repoId: "repo-1" });

      expect((await service.getLocalItem("local-1"))?.source).toBe("local");
      expect(await service.getLocalItem("community-1")).toBeUndefined();
      expect(await service.getLocalItem("missing")).toBeUndefined();

      expect(await service.deleteLocalItem("local-1")).toBe(true);
      expect(await service.deleteLocalItem("local-1")).toBe(false);
      expect(await service.deleteLocalItem("community-1")).toBe(false);
      expect(await service.deleteLocalItem("missing")).toBe(false);
    } finally {
      close();
    }
  });
});

describe("template-library routes", () => {
  it("lists local items and filters by type through the route", async () => {
    const { service, repository, close } = await seededService();
    try {
      await seed(repository, "ca-1", { type: "conditional-access" });
      await seed(repository, "group-1", { type: "group" });

      const routes = createTemplateLibraryRoutes(service);
      const baseUrl = await startServer(routes);

      const list = (await (
        await fetch(`${baseUrl}${TEMPLATE_LIBRARY_PATH}`)
      ).json()) as { items: TemplateLibraryItem[] };
      expect(list.items.map((item) => item.id).sort()).toEqual(["ca-1", "group-1"]);

      const filtered = (await (
        await fetch(`${baseUrl}${TEMPLATE_LIBRARY_PATH}?type=${encodeURIComponent("group")}`)
      ).json()) as { items: TemplateLibraryItem[] };
      expect(filtered.items.map((item) => item.id)).toEqual(["group-1"]);
    } finally {
      close();
    }
  });

  it("rejects an unregistered type filter with 400", async () => {
    const { service, repository, close } = await seededService();
    try {
      const routes = createTemplateLibraryRoutes(service);
      const get = handlerFor(routes, "GET", TEMPLATE_LIBRARY_PATH);

      const response = await invoke(get, context({ query: new URLSearchParams({ type: "bogus" }) }));
      expect(response.status).toBe(400);
      expect((response.body as Record<string, unknown>)["code"]).toBe(ErrorCodes.validationFailed);
    } finally {
      close();
    }
  });

  it("gates list behind templates.read and delete behind templates.write", async () => {
    const { service, repository, close } = await seededService();
    try {
      await seed(repository, "item-1");

      const routes = createTemplateLibraryRoutes(service, {
        authorize: (_ctx, permission) => permission === TEMPLATE_LIBRARY_PERMISSIONS.read,
      });
      const baseUrl = await startServer(routes);

      const deniedDelete = await fetch(`${baseUrl}${TEMPLATE_LIBRARY_PATH}/item-1`, {
        method: "DELETE",
      });
      expect(deniedDelete.status).toBe(403);
      expect(((await deniedDelete.json()) as Record<string, unknown>)["code"]).toBe(
        ErrorCodesForbidden,
      );

      const list = await fetch(`${baseUrl}${TEMPLATE_LIBRARY_PATH}`);
      expect(list.status).toBe(200);
    } finally {
      close();
    }
  });

  it("deletes with templates.write and returns 404 for a missing item", async () => {
    const { service, repository, close } = await seededService();
    try {
      await seed(repository, "item-1");

      const routes = createTemplateLibraryRoutes(service, {
        authorize: (_ctx, permission) =>
          permission === TEMPLATE_LIBRARY_PERMISSIONS.read ||
          permission === TEMPLATE_LIBRARY_PERMISSIONS.write,
      });
      const baseUrl = await startServer(routes);

      const deleted = await fetch(`${baseUrl}${TEMPLATE_LIBRARY_PATH}/item-1`, {
        method: "DELETE",
      });
      expect(deleted.status).toBe(204);

      const list = (await (
        await fetch(`${baseUrl}${TEMPLATE_LIBRARY_PATH}`)
      ).json()) as { items: TemplateLibraryItem[] };
      expect(list.items).toEqual([]);

      const missing = await fetch(`${baseUrl}${TEMPLATE_LIBRARY_PATH}/nope`, { method: "DELETE" });
      expect(missing.status).toBe(404);
      expect(((await missing.json()) as Record<string, unknown>)["code"]).toBe(
        ErrorCodesTemplateNotFound,
      );
    } finally {
      close();
    }
  });

  it("resolves both permissions through the T-0743 testPortalAccess path", async () => {
    const { service, repository, close } = await seededService();
    try {
      await seed(repository, "item-1");

      // EPIC-039 names are lowercase (SPEC §7); the roles carry them explicitly
      // because the EPIC-038 base-role patterns are PascalCase (`*.Read`).
      const portalRoles: Record<string, { id: string; include: string[]; exclude: string[] }> = {
        readonly: { id: "readonly", include: [TEMPLATE_LIBRARY_PERMISSIONS.read], exclude: [] },
        editor: {
          id: "editor",
          include: [TEMPLATE_LIBRARY_PERMISSIONS.read, TEMPLATE_LIBRARY_PERMISSIONS.write],
          exclude: [],
        },
      };
      const routes = createTemplateLibraryRoutes(service, {
        authorize: (ctx, permission) =>
          testPortalAccess({
            permission,
            roles: (ctx.caller?.roles ?? []).map(
              (id) => portalRoles[id] ?? { id, include: [], exclude: [] },
            ),
          }).allowed,
      });
      const baseUrl = await startServer(routes);

      const anonList = await fetch(`${baseUrl}${TEMPLATE_LIBRARY_PATH}`);
      expect(anonList.status).toBe(403);

      const readerList = await invoke(
        handlerFor(routes, "GET", TEMPLATE_LIBRARY_PATH),
        context({ caller: { roles: ["readonly"], tenantScope: {} } }),
      );
      expect(readerList.status).toBe(200);

      const readerDelete = await invoke(
        handlerFor(routes, "DELETE", `${TEMPLATE_LIBRARY_PATH}/:id`),
        context({
          method: "DELETE",
          path: `${TEMPLATE_LIBRARY_PATH}/item-1`,
          params: { id: "item-1" },
          caller: { roles: ["readonly"], tenantScope: {} },
        }),
      );
      expect(readerDelete.status).toBe(403);

      const editorDelete = await invoke(
        handlerFor(routes, "DELETE", `${TEMPLATE_LIBRARY_PATH}/:id`),
        context({
          method: "DELETE",
          path: `${TEMPLATE_LIBRARY_PATH}/item-1`,
          params: { id: "item-1" },
          caller: { roles: ["editor"], tenantScope: {} },
        }),
      );
      expect(editorDelete.status).toBe(204);
    } finally {
      close();
    }
  });

  it("default authorizer grants while the portal is unauthenticated", async () => {
    const { service, repository, close } = await seededService();
    try {
      const routes = createTemplateLibraryRoutes(service);
      const baseUrl = await startServer(routes);

      const list = await fetch(`${baseUrl}${TEMPLATE_LIBRARY_PATH}`);
      expect(list.status).toBe(200);
    } finally {
      close();
    }
  });
});

describe("template type registry", () => {
  it("covers the §3.1 checkbox groups", () => {
    for (const type of [
      "conditional-access",
      "intune-configuration",
      "intune-compliance",
      "intune-protection",
      "standards",
      "group",
      "policy",
    ]) {
      expect(TEMPLATE_TYPES).toContain(type);
    }
  });
});
