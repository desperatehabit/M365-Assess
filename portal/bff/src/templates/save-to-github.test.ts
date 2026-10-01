import { describe, expect, it } from "vitest";
import { AppError, normalizeError, toErrorBody } from "../errors.js";
import type { IntegrationConfig, TemplateLibraryItem } from "@m365-assess/db";
import {
  GITHUB_INTEGRATION_KIND,
  GitHubAuthError,
  GitHubConflictError,
  SAVE_TO_GITHUB_PATH,
  SAVE_TO_GITHUB_PERMISSION,
  SaveToGitHubErrorCodes,
  SaveToGitHubService,
  createSaveToGitHubRoute,
  templateFilePath,
  type GitHubCommitAdapter,
  type GitHubCommitRequest,
  type GitHubCommitResult,
  type GitHubIntegrationConfigReader,
  type SaveToGitHubTemplateReader,
} from "./save-to-github.js";
import type {
  TemplateLibraryAuthorizer,
  TemplateLibraryRequestContext,
} from "./library-routes.js";

function item(overrides: Partial<TemplateLibraryItem> = {}): TemplateLibraryItem {
  return {
    id: "item-1",
    type: "standards",
    name: "My Template",
    body: JSON.stringify({ displayName: "My Template" }),
    source: "local",
    repoId: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    deletedAt: null,
    ...overrides,
  };
}

function integration(overrides: Partial<IntegrationConfig> = {}): IntegrationConfig {
  return {
    id: "int-1",
    kind: GITHUB_INTEGRATION_KIND,
    enabled: true,
    secretRef: "secret/github-token",
    mapping: {},
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

function templateReader(record?: TemplateLibraryItem): SaveToGitHubTemplateReader {
  return {
    getTemplateLibraryItem: async (id) => (record && record.id === id ? record : undefined),
  };
}

function integrationReader(config?: IntegrationConfig): GitHubIntegrationConfigReader {
  return {
    getIntegrationConfig: async (kind) =>
      config && config.kind === kind ? config : undefined,
  };
}

function recordingAdapter(
  result: GitHubCommitResult = { ref: "refs/heads/main", sha: "abc123" },
): { adapter: GitHubCommitAdapter; requests: GitHubCommitRequest[] } {
  const requests: GitHubCommitRequest[] = [];
  return {
    adapter: {
      commit: async (request) => {
        requests.push(request);
        return result;
      },
    },
    requests,
  };
}

function recordingAudit(): {
  audit: (event: Record<string, unknown>) => Promise<void>;
  events: Record<string, unknown>[];
} {
  const events: Record<string, unknown>[] = [];
  return {
    audit: async (event) => {
      events.push(event);
    },
    events,
  };
}

function context(
  overrides: Partial<TemplateLibraryRequestContext> = {},
): TemplateLibraryRequestContext {
  return {
    correlationId: "corr-test",
    method: "POST",
    path: SAVE_TO_GITHUB_PATH,
    query: new URLSearchParams(),
    headers: {},
    params: { id: "item-1" },
    ...overrides,
  };
}

describe("SaveToGitHubService", () => {
  it("is not configured without an adapter, even when the integration is enabled", async () => {
    const service = new SaveToGitHubService({
      templates: templateReader(item()),
      integrations: integrationReader(integration()),
    });
    await expect(service.isConfigured()).resolves.toBe(false);
  });

  it("is not configured when the adapter is registered but the integration is disabled", async () => {
    const service = new SaveToGitHubService({
      templates: templateReader(item()),
      integrations: integrationReader(integration({ enabled: false })),
      adapter: recordingAdapter().adapter,
    });
    await expect(service.isConfigured()).resolves.toBe(false);
  });

  it("is configured when the adapter is registered and the integration is enabled", async () => {
    const service = new SaveToGitHubService({
      templates: templateReader(item()),
      integrations: integrationReader(integration()),
      adapter: recordingAdapter().adapter,
    });
    await expect(service.isConfigured()).resolves.toBe(true);
  });

  it("fails closed without reaching the adapter when no integration is configured", async () => {
    const { adapter, requests } = recordingAdapter();
    const { audit, events } = recordingAudit();
    const service = new SaveToGitHubService({
      templates: templateReader(item()),
      integrations: integrationReader(undefined),
      adapter,
      audit,
    });

    await expect(
      service.save("item-1", { repository: "owner/repo", message: "save" }),
    ).rejects.toMatchObject({
      code: SaveToGitHubErrorCodes.notConfigured,
      status: 409,
    });
    expect(requests).toHaveLength(0);
    expect(events).toHaveLength(0);
  });

  it("commits the template and audits the commit when the integration is enabled", async () => {
    const { adapter, requests } = recordingAdapter({
      ref: "refs/heads/main",
      sha: "sha-1",
      url: "https://github.com/owner/repo/commit/sha-1",
    });
    const { audit, events } = recordingAudit();
    const service = new SaveToGitHubService({
      templates: templateReader(item()),
      integrations: integrationReader(integration()),
      adapter,
      audit,
      now: () => "2026-01-02T00:00:00.000Z",
    });

    const result = await service.save(
      "item-1",
      { repository: "owner/repo", message: "Update template" },
      { actorUserId: "user-1", correlationId: "corr-1" },
    );

    expect(requests).toEqual([
      {
        repository: "owner/repo",
        path: "templates/standards/my-template.json",
        content: item().body,
        message: "Update template",
      },
    ]);
    expect(result).toMatchObject({
      itemId: "item-1",
      repository: "owner/repo",
      ref: "refs/heads/main",
      sha: "sha-1",
      committedAt: "2026-01-02T00:00:00.000Z",
    });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      action: "template.github.commit",
      actorUserId: "user-1",
      targetType: "template-library-item",
      targetId: "item-1",
      result: "success",
      correlationId: "corr-1",
      after: { repository: "owner/repo", ref: "refs/heads/main", sha: "sha-1" },
    });
  });

  it("maps an adapter auth failure to a structured error", async () => {
    const adapter: GitHubCommitAdapter = {
      commit: async () => {
        throw new GitHubAuthError();
      },
    };
    const service = new SaveToGitHubService({
      templates: templateReader(item()),
      integrations: integrationReader(integration()),
      adapter,
    });

    await expect(
      service.save("item-1", { repository: "owner/repo", message: "save" }),
    ).rejects.toMatchObject({
      code: SaveToGitHubErrorCodes.auth,
      status: 401,
    });
  });

  it("maps an adapter conflict to a structured error", async () => {
    const adapter: GitHubCommitAdapter = {
      commit: async () => {
        throw new GitHubConflictError();
      },
    };
    const service = new SaveToGitHubService({
      templates: templateReader(item()),
      integrations: integrationReader(integration()),
      adapter,
    });

    await expect(
      service.save("item-1", { repository: "owner/repo", message: "save" }),
    ).rejects.toMatchObject({
      code: SaveToGitHubErrorCodes.conflict,
      status: 409,
    });
  });

  it("requires a repository and a commit message", async () => {
    const service = new SaveToGitHubService({
      templates: templateReader(item()),
      integrations: integrationReader(integration()),
      adapter: recordingAdapter().adapter,
    });

    await expect(service.save("item-1", { message: "save" })).rejects.toMatchObject({
      code: SaveToGitHubErrorCodes.invalidRepository,
      status: 400,
    });
    await expect(
      service.save("item-1", { repository: "owner/repo" }),
    ).rejects.toMatchObject({
      code: SaveToGitHubErrorCodes.invalidMessage,
      status: 400,
    });
  });

  it("derives a filesystem-safe path from the type and name", () => {
    expect(templateFilePath({ type: "conditional-access", name: "MFA / Admins!" })).toBe(
      "templates/conditional-access/mfa-admins.json",
    );
  });
});

describe("createSaveToGitHubRoute", () => {
  async function invoke(
    route: ReturnType<typeof createSaveToGitHubRoute>,
    ctx: TemplateLibraryRequestContext,
  ): Promise<{ status: number; body: unknown }> {
    try {
      const response = await route.handler(ctx);
      return { status: response.status, body: response.body };
    } catch (error) {
      const appError: AppError = normalizeError(error);
      return { status: appError.status, body: toErrorBody(appError, ctx.correlationId) };
    }
  }

  function routeFor(
    authorize?: TemplateLibraryAuthorizer,
  ): ReturnType<typeof createSaveToGitHubRoute> {
    const { adapter } = recordingAdapter();
    const service = new SaveToGitHubService({
      templates: templateReader(item()),
      integrations: integrationReader(integration()),
      adapter,
      audit: recordingAudit().audit,
    });
    return createSaveToGitHubRoute(service, authorize ? { authorize } : {});
  }

  it("requires the templates.write permission", async () => {
    const route = routeFor(() => false);
    const result = await invoke(
      route,
      context({ body: { repository: "owner/repo", message: "save" } }),
    );
    expect(result.status).toBe(403);
  });

  it("rejects a request without a template id", async () => {
    const route = routeFor();
    const result = await invoke(route, context({ params: {} }));
    expect(result.status).toBe(400);
  });

  it("fails closed with a structured error when the integration is absent", async () => {
    const service = new SaveToGitHubService({
      templates: templateReader(item()),
      integrations: integrationReader(undefined),
      adapter: recordingAdapter().adapter,
    });
    const route = createSaveToGitHubRoute(service);
    const result = await invoke(
      route,
      context({ body: { repository: "owner/repo", message: "save" } }),
    );
    expect(result.status).toBe(409);
    expect((result.body as { code?: string }).code).toBe(
      SaveToGitHubErrorCodes.notConfigured,
    );
  });

  it("commits through the route when configured and authorized", async () => {
    const { adapter, requests } = recordingAdapter();
    const service = new SaveToGitHubService({
      templates: templateReader(item()),
      integrations: integrationReader(integration()),
      adapter,
      audit: recordingAudit().audit,
    });
    const route = createSaveToGitHubRoute(service, {
      authorize: (ctx, permission) => permission === SAVE_TO_GITHUB_PERMISSION,
    });
    const result = await invoke(
      route,
      context({ body: { repository: "owner/repo", message: "save" } }),
    );
    expect(result.status).toBe(200);
    expect(requests).toHaveLength(1);
    expect((result.body as { sha?: string }).sha).toBe("abc123");
  });
});
