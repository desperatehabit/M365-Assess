// Save template to GitHub (EPIC-039 SPEC.md §3.4, §4.2, §6, §11.1; T-0767).
//
// The GitHub flow is an opt-in that reuses the EPIC-041 GitHub integration
// (T-0802) instead of owning transport: this module defines the commit seam that
// integration implements, and a service that fails closed with a structured
// error until an enabled GitHub integration AND a registered adapter are both
// present. The v1 catalog is local-only (SPEC §11.1), so the default with no
// integration is a no-op that never reaches the network. The route requires
// `templates.write` and every successful commit is written to the audit log.
import { AppError, ErrorCodes } from "../errors.js";
import type { RequestCaller, RequestContext, Route, RouteResponse } from "../server.js";
import type { IntegrationConfig, TemplateLibraryItem } from "@m365-assess/db";
import type {
  TemplateLibraryAuthorizer,
  TemplateLibraryRequestContext,
} from "./library-routes.js";

export const GITHUB_INTEGRATION_KIND = "github" as const;
export const SAVE_TO_GITHUB_PATH = "/v1/template-library/:id/save-to-github" as const;
export const SAVE_TO_GITHUB_PERMISSION = "templates.write" as const;

export const SaveToGitHubErrorCodes = {
  /** No enabled GitHub integration + adapter; the flow is a no-op (fails closed). */
  notConfigured: "template_library.github_not_configured",
  auth: "template_library.github_auth",
  conflict: "template_library.github_conflict",
  notFound: "template_library.not_found",
  invalidRepository: "template_library.github_repository_invalid",
  invalidMessage: "template_library.github_message_invalid",
} as const;

/** The commit the adapter (T-0802) performs; `content` is the template body. */
export interface GitHubCommitRequest {
  readonly repository: string;
  readonly path: string;
  readonly content: string;
  readonly message: string;
}

export interface GitHubCommitResult {
  readonly ref: string;
  readonly sha: string;
  readonly url?: string;
}

/** The EPIC-041 GitHub adapter implements this seam; T-0767 never speaks GitHub itself. */
export interface GitHubCommitAdapter {
  commit(request: GitHubCommitRequest): Promise<GitHubCommitResult>;
}

/** Raised by the adapter so the service can map auth failure to a structured error. */
export class GitHubAuthError extends Error {
  readonly code = SaveToGitHubErrorCodes.auth;

  constructor(message = "GitHub authentication failed") {
    super(message);
    this.name = "GitHubAuthError";
  }
}

/** Raised by the adapter so the service can map a write conflict to a structured error. */
export class GitHubConflictError extends Error {
  readonly code = SaveToGitHubErrorCodes.conflict;

  constructor(message = "GitHub commit conflict") {
    super(message);
    this.name = "GitHubConflictError";
  }
}

/** The narrow slice of the EPIC-041 integration store this service reads. */
export interface GitHubIntegrationConfigReader {
  getIntegrationConfig(kind: string): Promise<IntegrationConfig | undefined>;
}

/** The narrow slice of the T-0761 template store this service reads. */
export interface SaveToGitHubTemplateReader {
  getTemplateLibraryItem(itemId: string): Promise<TemplateLibraryItem | undefined>;
}

export interface SaveToGitHubAuditContext {
  readonly actorUserId?: string | null;
  readonly correlationId?: string | null;
}

export interface SaveToGitHubInput {
  /** Configured repo id or URL the dialog picked. */
  readonly repository?: string;
  readonly message?: string;
  /** Optional explicit file path; defaults to the §9 type + template name. */
  readonly path?: string;
}

export interface SaveToGitHubResult {
  readonly itemId: string;
  readonly repository: string;
  readonly path: string;
  readonly ref: string;
  readonly sha: string;
  readonly url?: string;
  readonly committedAt: string;
}

export interface SaveToGitHubServiceOptions {
  readonly templates: SaveToGitHubTemplateReader;
  readonly integrations: GitHubIntegrationConfigReader;
  /** Absent until the T-0802 GitHub integration is registered; absence fails closed. */
  readonly adapter?: GitHubCommitAdapter;
  readonly audit?: (event: Record<string, unknown>) => Promise<void>;
  readonly now?: () => string;
}

/** `templates/<type>/<slug>.json` — a stable, filesystem-safe path per §5. */
export function templateFilePath(item: Pick<TemplateLibraryItem, "type" | "name">): string {
  const slug =
    item.name
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9._-]+/g, "-")
      .replace(/^-+|-+$/g, "") || "template";
  return `templates/${item.type}/${slug}.json`;
}

export class SaveToGitHubService {
  private readonly templates: SaveToGitHubTemplateReader;
  private readonly integrations: GitHubIntegrationConfigReader;
  private readonly adapter: GitHubCommitAdapter | undefined;
  private readonly audit: (event: Record<string, unknown>) => Promise<void>;
  private readonly now: () => string;

  constructor(options: SaveToGitHubServiceOptions) {
    this.templates = options.templates;
    this.integrations = options.integrations;
    this.adapter = options.adapter;
    this.audit = options.audit ?? (async () => {});
    this.now = options.now ?? (() => new Date().toISOString());
  }

  /** True only when the integration is enabled AND its adapter is registered. */
  async isConfigured(): Promise<boolean> {
    if (this.adapter === undefined) return false;
    const config = await this.integrations.getIntegrationConfig(GITHUB_INTEGRATION_KIND);
    return config?.enabled === true;
  }

  async save(
    itemId: string,
    input: SaveToGitHubInput = {},
    context: SaveToGitHubAuditContext = {},
  ): Promise<SaveToGitHubResult> {
    const adapter = await this.requireAdapter();
    const item = await this.templates.getTemplateLibraryItem(itemId);
    if (!item) {
      throw new AppError(SaveToGitHubErrorCodes.notFound, "Template library item not found", 404);
    }
    const repository = requireRepository(input.repository);
    const message = requireMessage(input.message);
    const path = input.path?.trim() ? input.path.trim() : templateFilePath(item);

    let commit: GitHubCommitResult;
    try {
      commit = await adapter.commit({ repository, path, content: item.body, message });
    } catch (error) {
      if (error instanceof GitHubAuthError) {
        throw new AppError(SaveToGitHubErrorCodes.auth, error.message, 401, [
          { field: "integration", reason: "auth" },
        ]);
      }
      if (error instanceof GitHubConflictError) {
        throw new AppError(SaveToGitHubErrorCodes.conflict, error.message, 409, [
          { field: "repository", reason: "conflict" },
        ]);
      }
      throw error;
    }

    const committedAt = this.now();
    await this.audit({
      action: "template.github.commit",
      actorUserId: context.actorUserId ?? null,
      targetType: "template-library-item",
      targetId: item.id,
      before: null,
      after: {
        repository,
        path,
        ref: commit.ref,
        sha: commit.sha,
        url: commit.url ?? null,
      },
      result: "success",
      correlationId: context.correlationId ?? null,
    });

    return {
      itemId: item.id,
      repository,
      path,
      ref: commit.ref,
      sha: commit.sha,
      ...(commit.url === undefined ? {} : { url: commit.url }),
      committedAt,
    };
  }

  private async requireAdapter(): Promise<GitHubCommitAdapter> {
    if (this.adapter === undefined) {
      throw notConfiguredError();
    }
    const config = await this.integrations.getIntegrationConfig(GITHUB_INTEGRATION_KIND);
    if (config?.enabled !== true) {
      throw notConfiguredError();
    }
    return this.adapter;
  }
}

function notConfiguredError(): AppError {
  return new AppError(
    SaveToGitHubErrorCodes.notConfigured,
    "GitHub integration is not configured",
    409,
    [{ field: "integration", reason: "not_configured" }],
  );
}

function requireRepository(repository: string | undefined): string {
  const value = repository?.trim();
  if (!value) {
    throw new AppError(
      SaveToGitHubErrorCodes.invalidRepository,
      "a target repository is required",
      400,
      [{ field: "repository", reason: "required" }],
    );
  }
  return value;
}

function requireMessage(message: string | undefined): string {
  const value = message?.trim();
  if (!value) {
    throw new AppError(
      SaveToGitHubErrorCodes.invalidMessage,
      "a commit message is required",
      400,
      [{ field: "message", reason: "required" }],
    );
  }
  return value;
}

/** The caller shape the route needs to record the commit actor. */
export interface SaveToGitHubCaller extends RequestCaller {
  readonly userId?: string;
}

export interface SaveToGitHubRouteOptions {
  readonly authorize?: TemplateLibraryAuthorizer;
}

function defaultAuthorize(ctx: TemplateLibraryRequestContext, permission: string): boolean {
  const granted = ctx.permissions;
  if (granted === undefined) {
    return true;
  }
  return granted.includes(permission) || granted.includes("*");
}

function readString(body: unknown, key: string): string | undefined {
  const record =
    typeof body === "object" && body !== null && !Array.isArray(body)
      ? (body as Record<string, unknown>)
      : {};
  const value = record[key];
  return typeof value === "string" ? value : undefined;
}

export function createSaveToGitHubRoute(
  service: SaveToGitHubService,
  options: SaveToGitHubRouteOptions = {},
): Route {
  const authorize = options.authorize ?? defaultAuthorize;

  return {
    method: "POST",
    path: SAVE_TO_GITHUB_PATH,
    handler: async (ctx: RequestContext): Promise<RouteResponse> => {
      const context = ctx as TemplateLibraryRequestContext;
      if (!authorize(context, SAVE_TO_GITHUB_PERMISSION)) {
        throw new AppError(
          ErrorCodes.forbidden,
          `Missing required permission '${SAVE_TO_GITHUB_PERMISSION}'`,
          403,
        );
      }

      const itemId = (ctx.params["id"] ?? "").trim();
      if (itemId.length === 0) {
        throw new AppError(ErrorCodes.validationFailed, "template id is required", 400, [
          { field: "id", reason: "required" },
        ]);
      }

      const caller = ctx.caller as SaveToGitHubCaller | null | undefined;
      const result = await service.save(
        itemId,
        {
          repository: readString(ctx.body, "repository") ?? readString(ctx.body, "repoId"),
          message: readString(ctx.body, "message"),
          path: readString(ctx.body, "path"),
        },
        {
          actorUserId: caller?.userId ?? null,
          correlationId: ctx.correlationId,
        },
      );
      return {
        status: 200,
        headers: { "content-type": "application/json" },
        body: result,
      };
    },
  };
}
