import { describe, expect, it } from "vitest";
import { AppError } from "../errors.js";
import { openSqliteTemplateRepository } from "@m365-assess/db";
import {
  TEMPLATE_REPO_ITEM_PATH,
  TEMPLATE_REPO_TEMPLATES_PATH,
  TEMPLATE_REPOS_PATH,
  TEMPLATE_REPOS_READ_PERMISSION,
  TEMPLATE_REPOS_WRITE_PERMISSION,
  createTemplateRepoRoutes,
  type RepoRoutesCaller,
} from "./repo-routes.js";
import {
  TemplateRepoService,
  parseRepoRef,
  repoIdForUrl,
  TEMPLATE_REPO_NOT_FOUND,
  TEMPLATE_REPO_REF_INVALID,
  type RepoTemplate,
} from "./repo-service.js";

function recordingAudit(): { audit: (event: Record<string, unknown>) => Promise<void>; events: Record<string, unknown>[] } {
  const events: Record<string, unknown>[] = [];
  return {
    events,
    audit: async (event) => {
      events.push(event);
    },
  };
}

async function serviceWithFetcher(templates: readonly RepoTemplate[]) {
  const { audit, events } = recordingAudit();
  const repos = await openSqliteTemplateRepository({ filename: ":memory:" });
  const service = new TemplateRepoService({
    repos,
    audit,
    fetchTemplates: async () => templates,
  });
  return { service, repos, events };
}

function ctxFor(
  method: string,
  path: string,
  caller: RepoRoutesCaller | undefined,
  body?: unknown,
  params: Readonly<Record<string, string>> = {},
) {
  return {
    correlationId: "corr-1",
    method,
    path,
    params,
    query: new URLSearchParams(),
    headers: {},
    body,
    caller,
  };
}

const REPO_CALLER: RepoRoutesCaller = {
  roles: ["admin"],
  tenantScope: { kind: "all" },
  userId: "user-1",
  permissions: [TEMPLATE_REPOS_READ_PERMISSION, TEMPLATE_REPOS_WRITE_PERMISSION],
};

describe("parseRepoRef", () => {
  it("parses the owner/repo shorthand", () => {
    expect(parseRepoRef("owner/repo")).toEqual({
      url: "https://github.com/owner/repo",
      name: "repo",
    });
  });

  it("parses a full URL and strips a .git suffix", () => {
    expect(parseRepoRef("https://github.com/owner/repo.git")).toEqual({
      url: "https://github.com/owner/repo.git",
      name: "repo",
    });
  });

  it("rejects empty and non-URL input", () => {
    expect(() => parseRepoRef("   ")).toThrowError(
      expect.objectContaining({ code: TEMPLATE_REPO_REF_INVALID, status: 400 }) as Error,
    );
    expect(() => parseRepoRef("not a url")).toThrowError(AppError);
    expect(() => parseRepoRef("ftp://example.com/owner/repo")).toThrowError(
      expect.objectContaining({ code: TEMPLATE_REPO_REF_INVALID }) as Error,
    );
  });
});

describe("TemplateRepoService", () => {
  it("adds a repo with parsed url/name, indexes templates, and audits the change", async () => {
    const templates: RepoTemplate[] = [
      { name: "Baseline CA", type: "conditional-access", body: "{}" },
      { name: "Device baseline", type: "baseline", body: "{}" },
    ];
    const { service, repos, events } = await serviceWithFetcher(templates);
    try {
      const repo = await service.addRepo(
        { ref: "owner/repo", types: ["conditional-access", "baseline"] },
        { actorUserId: "user-1", correlationId: "corr-1" },
      );

      expect(repo.id).toBe(repoIdForUrl("https://github.com/owner/repo"));
      expect(repo.url).toBe("https://github.com/owner/repo");
      expect(repo.name).toBe("repo");
      expect(repo.builtin).toBe(false);
      expect(repo.writeAccess).toBe(false);
      expect(repo.reviewState).toBe("unreviewed");

      const items = await service.getRepoTemplates(repo.id);
      expect(items.map((item) => item.name)).toEqual(["Baseline CA", "Device baseline"]);
      expect(items.every((item) => item.source === "community" && item.repoId === repo.id)).toBe(true);

      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        action: "template.repo.add",
        actorUserId: "user-1",
        targetType: "template-repo",
        targetId: repo.id,
        result: "success",
        correlationId: "corr-1",
      });
      expect(events[0]["after"]).toMatchObject({ url: repo.url, types: ["conditional-access", "baseline"] });
    } finally {
      repos.close();
    }
  });

  it("keeps the index empty with the default fetcher (v1 local-only catalog)", async () => {
    const { audit, events } = recordingAudit();
    const repos = await openSqliteTemplateRepository({ filename: ":memory:" });
    const service = new TemplateRepoService({ repos, audit });
    try {
      const repo = await service.addRepo({ ref: "https://github.com/owner/repo", types: ["standards"] });
      expect(await service.getRepoTemplates(repo.id)).toEqual([]);
    } finally {
      repos.close();
    }
  });

  it("rejects unregistered template types with 400", async () => {
    const { service, repos } = await serviceWithFetcher([]);
    try {
      await expect(service.addRepo({ ref: "owner/repo", types: ["not-a-type"] })).rejects.toMatchObject({
        status: 400,
      });
    } finally {
      repos.close();
    }
  });

  it("re-indexing replaces the stored index", async () => {
    let templates: RepoTemplate[] = [{ name: "First", type: "group", body: "{}" }];
    const { audit, events } = recordingAudit();
    const repos = await openSqliteTemplateRepository({ filename: ":memory:" });
    const service = new TemplateRepoService({ repos, audit, fetchTemplates: async () => templates });
    try {
      const repo = await service.addRepo({ ref: "owner/repo", types: ["group"] });
      templates = [{ name: "Second", type: "group", body: "{}" }];
      await service.addRepo({ ref: "owner/repo", types: ["group"] });

      const items = await service.getRepoTemplates(repo.id);
      expect(items.map((item) => item.name)).toEqual(["Second"]);
    } finally {
      repos.close();
    }
  });

  it("removes a repo and its indexed templates, auditing the change", async () => {
    const { service, repos, events } = await serviceWithFetcher([
      { name: "Baseline CA", type: "conditional-access", body: "{}" },
    ]);
    try {
      const repo = await service.addRepo({ ref: "owner/repo", types: ["conditional-access"] });
      events.length = 0;

      const removed = await service.removeRepo(repo.id, { actorUserId: "user-1" });
      expect(removed.id).toBe(repo.id);
      expect(await repos.getTemplateRepo(repo.id)).toBeUndefined();
      expect(await repos.listTemplateLibraryItems({ repoId: repo.id })).toEqual([]);
      await expect(service.getRepoTemplates(repo.id)).rejects.toMatchObject({ status: 404 });

      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        action: "template.repo.remove",
        actorUserId: "user-1",
        targetType: "template-repo",
        targetId: repo.id,
      });
    } finally {
      repos.close();
    }
  });

  it("throws 404 when removing or reading an unknown repo", async () => {
    const { service, repos } = await serviceWithFetcher([]);
    try {
      await expect(service.removeRepo("repo-missing")).rejects.toMatchObject({
        code: TEMPLATE_REPO_NOT_FOUND,
        status: 404,
      });
      await expect(service.getRepoTemplates("repo-missing")).rejects.toMatchObject({
        code: TEMPLATE_REPO_NOT_FOUND,
        status: 404,
      });
    } finally {
      repos.close();
    }
  });

  it("filters repos by type", async () => {
    const { service, repos } = await serviceWithFetcher([]);
    try {
      await service.addRepo({ ref: "owner/ca-repo", types: ["conditional-access"] });
      await service.addRepo({ ref: "owner/standards-repo", types: ["standards", "baseline"] });

      const all = await service.listRepos();
      expect(all).toHaveLength(2);
      const filtered = await service.listRepos({ type: "baseline" });
      expect(filtered).toHaveLength(1);
      expect(filtered[0].name).toBe("standards-repo");
    } finally {
      repos.close();
    }
  });
});

describe("template repo routes", () => {
  function routesFor(service: TemplateRepoService, caller: RepoRoutesCaller | undefined) {
    return createTemplateRepoRoutes({
      service,
      resolveCaller: () => caller,
      authorize: (c, permission) => {
        const granted = c.permissions ?? [];
        if (!granted.includes(permission) && !granted.includes("*")) {
          throw new AppError("auth.forbidden", "forbidden", 403);
        }
      },
    });
  }

  function handlerFor(
    routes: ReturnType<typeof routesFor>,
    method: string,
    path: string,
    caller: RepoRoutesCaller | undefined,
    body?: unknown,
    params: Readonly<Record<string, string>> = {},
  ) {
    const route = routes.find((r) => r.method === method && r.path === path)!;
    return route.handler(ctxFor(method, path, caller, body, params));
  }

  it("rejects unauthenticated requests with 401", async () => {
    const { service, repos } = await serviceWithFetcher([]);
    try {
      const routes = routesFor(service, undefined);
      await expect(handlerFor(routes, "GET", TEMPLATE_REPOS_PATH, undefined)).rejects.toMatchObject({
        status: 401,
      });
    } finally {
      repos.close();
    }
  });

  it("rejects readers adding or removing repos with 403", async () => {
    const { service, repos } = await serviceWithFetcher([]);
    try {
      const reader: RepoRoutesCaller = {
        roles: ["operator"],
        tenantScope: { kind: "all" },
        permissions: [TEMPLATE_REPOS_READ_PERMISSION],
      };
      const routes = routesFor(service, reader);
      await expect(
        handlerFor(routes, "POST", TEMPLATE_REPOS_PATH, reader, { ref: "owner/repo", types: [] }),
      ).rejects.toMatchObject({ status: 403 });
      await expect(
        handlerFor(routes, "DELETE", TEMPLATE_REPO_ITEM_PATH, reader, undefined, { id: "repo-1" }),
      ).rejects.toMatchObject({ status: 403 });
    } finally {
      repos.close();
    }
  });

  it("adds a repo through POST and audits the change", async () => {
    const { service, repos, events } = await serviceWithFetcher([]);
    try {
      const routes = routesFor(service, REPO_CALLER);
      const response = await handlerFor(routes, "POST", TEMPLATE_REPOS_PATH, REPO_CALLER, {
        ref: "owner/repo",
        types: ["standards"],
        scope: "org",
      });
      expect(response.status).toBe(201);
      const repo = response.body as { id: string; name: string };
      expect(repo.name).toBe("repo");

      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        action: "template.repo.add",
        actorUserId: "user-1",
        targetId: repo.id,
      });
    } finally {
      repos.close();
    }
  });

  it("lists repos and their indexed templates", async () => {
    const { service, repos } = await serviceWithFetcher([
      { name: "Baseline CA", type: "conditional-access", body: "{}" },
    ]);
    try {
      const routes = routesFor(service, REPO_CALLER);
      const created = (await handlerFor(routes, "POST", TEMPLATE_REPOS_PATH, REPO_CALLER, {
        ref: "owner/repo",
        types: ["conditional-access"],
      })).body as { id: string };

      const list = await handlerFor(routes, "GET", TEMPLATE_REPOS_PATH, REPO_CALLER);
      expect(list.body).toMatchObject({ totalCount: 1 });

      const templates = await handlerFor(routes, "GET", TEMPLATE_REPO_TEMPLATES_PATH, REPO_CALLER, undefined, {
        id: created.id,
      });
      expect(templates.body).toMatchObject({
        totalCount: 1,
        items: [{ name: "Baseline CA", source: "community" }],
      });
    } finally {
      repos.close();
    }
  });

  it("removes a repo through DELETE", async () => {
    const { service, repos, events } = await serviceWithFetcher([]);
    try {
      const routes = routesFor(service, REPO_CALLER);
      const created = (await handlerFor(routes, "POST", TEMPLATE_REPOS_PATH, REPO_CALLER, {
        ref: "owner/repo",
        types: [],
      })).body as { id: string };

      const removed = await handlerFor(routes, "DELETE", TEMPLATE_REPO_ITEM_PATH, REPO_CALLER, undefined, {
        id: created.id,
      });
      expect(removed.body).toEqual({ deleted: true, id: created.id });
      expect(events.some((event) => event["action"] === "template.repo.remove")).toBe(true);

      await expect(
        handlerFor(routes, "GET", TEMPLATE_REPO_TEMPLATES_PATH, REPO_CALLER, undefined, { id: created.id }),
      ).rejects.toMatchObject({ status: 404 });
    } finally {
      repos.close();
    }
  });
});
