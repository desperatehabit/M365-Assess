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
  openSqliteTemplateRepository,
  type TemplateLibraryItem,
  type TemplateRepository,
} from "@m365-assess/db";
import {
  ErrorCodesCloneNotFound,
  ErrorCodesCloneUnsupported,
  ErrorCodesForbidden,
  TEMPLATE_LIBRARY_CLONE_PATH,
  TEMPLATE_LIBRARY_CLONE_PERMISSION,
  createTemplateLibraryCloneRoute,
} from "./clone-routes.js";
import {
  CA_TEMPLATE_DEPLOY_FLOW,
  INTUNE_TEMPLATE_DEPLOY_FLOW,
  TemplateLibraryCloneService,
  TemplateLibraryItemNotFoundError,
  UnsupportedCloneTypeError,
} from "./clone-service.js";
import type { TemplateLibraryRequestContext } from "./library-routes.js";

const tempDirs: string[] = [];

function tempDbPath(): string {
  const dir = mkdtempSync(join(tmpdir(), "m365-clone-"));
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
    method: "POST",
    path: TEMPLATE_LIBRARY_CLONE_PATH,
    query: new URLSearchParams(),
    headers: {},
    params: { id: "item-1" },
    ...overrides,
  };
}

async function invoke(route: Route, ctx: TemplateLibraryRequestContext): Promise<RouteResponse> {
  try {
    return await route.handler(ctx);
  } catch (error) {
    const appError = normalizeError(error);
    return { status: appError.status, body: toErrorBody(appError, ctx.correlationId) };
  }
}

async function seededService(): Promise<{
  service: TemplateLibraryCloneService;
  repository: TemplateRepository;
  close: () => void;
}> {
  const repository = await openSqliteTemplateRepository({ filename: tempDbPath() });
  return {
    service: new TemplateLibraryCloneService(repository),
    repository,
    close: () => repository.close(),
  };
}

async function seed(
  repository: TemplateRepository,
  id: string,
  extra: Partial<Omit<TemplateLibraryItem, "id">> = {},
): Promise<void> {
  await repository.upsertTemplateLibraryItem({
    id,
    type: "conditional-access",
    name: `Item ${id}`,
    body: JSON.stringify({ displayName: id, state: "enabled" }),
    source: "local",
    repoId: null,
    ...extra,
  });
}

/** Wraps a repository so a test can assert which methods planning touched. */
function trackingRepository(repository: TemplateRepository): {
  proxy: TemplateRepository;
  calls: string[];
} {
  const calls: string[] = [];
  const proxy = new Proxy(repository, {
    get(target, prop) {
      const value = Reflect.get(target, prop);
      if (typeof value === "function") {
        return (...args: unknown[]) => {
          calls.push(String(prop));
          return (value as (...inner: unknown[]) => unknown).apply(target, args);
        };
      }
      return value;
    },
  });
  return { proxy: proxy as TemplateRepository, calls };
}

describe("TemplateLibraryCloneService", () => {
  it("resolves the item type to the owning epic's deploy flow and plans every target", async () => {
    const { service, repository, close } = await seededService();
    try {
      await seed(repository, "ca-1", { type: "conditional-access" });
      await seed(repository, "intune-1", { type: "intune-compliance" });

      const caPlan = await service.planClone("ca-1", ["tenant-a", "tenant-b"]);
      expect(caPlan.flow.id).toBe(CA_TEMPLATE_DEPLOY_FLOW.id);
      expect(caPlan.flow.epic).toBe("EPIC-015");
      expect(caPlan.targets).toEqual(["tenant-a", "tenant-b"]);
      expect(caPlan.actions).toHaveLength(2);
      expect(caPlan.actions[0]?.tenantId).toBe("tenant-a");
      expect(caPlan.actions[0]?.deployPath).toBe("/v1/ca-templates/:id/deploy");
      expect(caPlan.actions[0]?.action).toBe("deploy");
      expect(caPlan.diff.some((line) => line.includes("tenant-a"))).toBe(true);
      expect(caPlan.dryRun).toBe(true);

      const intunePlan = await service.planClone("intune-1", ["tenant-a"]);
      expect(intunePlan.flow.id).toBe(INTUNE_TEMPLATE_DEPLOY_FLOW.id);
      expect(intunePlan.flow.epic).toBe("EPIC-016");
      expect(intunePlan.actions[0]?.deployPath).toBe("/v1/intune-templates/:id/deploy");
    } finally {
      close();
    }
  });

  it("performs no repository write while planning", async () => {
    const { service, repository, close } = await seededService();
    try {
      await seed(repository, "ca-1");
      const { proxy, calls } = trackingRepository(repository);

      const plan = await new TemplateLibraryCloneService(proxy).planClone("ca-1", ["tenant-a"]);

      expect(plan.dryRun).toBe(true);
      expect(calls.every((method) => method === "getTemplateLibraryItem")).toBe(true);
      expect(await repository.getTemplateLibraryItem("ca-1")).toBeDefined();
    } finally {
      close();
    }
  });

  it("rejects a missing item and a type with no owning deploy flow", async () => {
    const { service, repository, close } = await seededService();
    try {
      await seed(repository, "policy-1", { type: "policy" });

      await expect(service.planClone("missing", ["tenant-a"])).rejects.toBeInstanceOf(
        TemplateLibraryItemNotFoundError,
      );
      await expect(service.planClone("policy-1", ["tenant-a"])).rejects.toBeInstanceOf(
        UnsupportedCloneTypeError,
      );
    } finally {
      close();
    }
  });
});

describe("template-library clone route", () => {
  it("POST returns a plan naming target tenants and actions without a tenant write", async () => {
    const { service, repository, close } = await seededService();
    try {
      await seed(repository, "ca-1", { type: "conditional-access" });
      const baseUrl = await startServer([createTemplateLibraryCloneRoute(service)]);

      const response = await fetch(`${baseUrl}/v1/template-library/ca-1/clone`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ targets: ["tenant-a", "tenant-b"] }),
      });

      expect(response.status).toBe(200);
      const plan = (await response.json()) as Record<string, unknown>;
      expect(plan["targets"]).toEqual(["tenant-a", "tenant-b"]);
      expect(plan["dryRun"]).toBe(true);
      expect((plan["flow"] as Record<string, unknown>)["epic"]).toBe("EPIC-015");
      const actions = plan["actions"] as Record<string, unknown>[];
      expect(actions).toHaveLength(2);
      expect(actions[0]?.["deployPath"]).toBe("/v1/ca-templates/:id/deploy");
    } finally {
      close();
    }
  });

  it("requires templates.clone", async () => {
    const { service, repository, close } = await seededService();
    try {
      await seed(repository, "ca-1");
      const route = createTemplateLibraryCloneRoute(service, {
        authorize: (_ctx, permission) => permission === "templates.read",
      });

      const response = await invoke(
        route,
        context({ body: { targets: ["tenant-a"] } }),
      );
      expect(response.status).toBe(403);
      expect((response.body as Record<string, unknown>)["code"]).toBe(ErrorCodesForbidden);
    } finally {
      close();
    }
  });

  it("is tenant-scoped: an out-of-scope target is refused", async () => {
    const { service, repository, close } = await seededService();
    try {
      await seed(repository, "ca-1");
      const route = createTemplateLibraryCloneRoute(service, {
        authorize: () => true,
      });

      const response = await invoke(
        route,
        context({
          body: { targets: ["tenant-b"] },
          caller: { roles: ["readonly"], tenantScope: { all: false, tenantIds: ["tenant-a"] } },
        }),
      );
      expect(response.status).toBe(403);
      expect((response.body as Record<string, unknown>)["details"]).toEqual([
        { field: "tenantId", reason: "out_of_scope" },
      ]);
    } finally {
      close();
    }
  });

  it("resolves templates.clone through the T-0743 testPortalAccess path", async () => {
    const { service, repository, close } = await seededService();
    try {
      await seed(repository, "ca-1");
      const portalRoles: Record<string, { id: string; include: string[]; exclude: string[] }> = {
        cloner: { id: "cloner", include: [TEMPLATE_LIBRARY_CLONE_PERMISSION], exclude: [] },
      };
      const route = createTemplateLibraryCloneRoute(service, {
        authorize: (ctx, permission) =>
          testPortalAccess({
            permission,
            roles: (ctx.caller?.roles ?? []).map(
              (id) => portalRoles[id] ?? { id, include: [], exclude: [] },
            ),
          }).allowed,
      });

      const denied = await invoke(route, context({ body: { targets: ["tenant-a"] } }));
      expect(denied.status).toBe(403);

      const allowed = await invoke(
        route,
        context({
          params: { id: "ca-1" },
          body: { targets: ["tenant-a"] },
          caller: { roles: ["cloner"], tenantScope: { all: true, tenantIds: [] } },
        }),
      );
      expect(allowed.status).toBe(200);
      expect((allowed.body as Record<string, unknown>)["dryRun"]).toBe(true);
    } finally {
      close();
    }
  });

  it("rejects a missing target list, a missing item, and an unsupported type", async () => {
    const { service, repository, close } = await seededService();
    try {
      await seed(repository, "policy-1", { type: "policy" });
      const route = createTemplateLibraryCloneRoute(service, { authorize: () => true });

      const noTargets = await invoke(route, context({ body: {} }));
      expect(noTargets.status).toBe(400);
      expect((noTargets.body as Record<string, unknown>)["code"]).toBe(ErrorCodes.validationFailed);

      const missing = await invoke(
        route,
        context({ params: { id: "nope" }, body: { targets: ["tenant-a"] } }),
      );
      expect(missing.status).toBe(404);
      expect((missing.body as Record<string, unknown>)["code"]).toBe(ErrorCodesCloneNotFound);

      const unsupported = await invoke(
        route,
        context({ params: { id: "policy-1" }, body: { targets: ["tenant-a"] } }),
      );
      expect(unsupported.status).toBe(422);
      expect((unsupported.body as Record<string, unknown>)["code"]).toBe(ErrorCodesCloneUnsupported);
    } finally {
      close();
    }
  });
});
