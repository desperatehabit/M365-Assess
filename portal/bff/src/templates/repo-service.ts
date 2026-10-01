// Community template repo service (EPIC-039 SPEC.md §3.2, §5-§8; T-0763).
// Sits on the T-0761 TemplateRepo store: a repo is a global index row, and its
// templates are indexed as community TemplateLibraryItem rows. Fetching is an
// injected seam — v1 is a local-only catalog (SPEC §11.1), so the default
// fetcher returns no templates and the index stays empty until the GitHub
// integration (T-0767) lands. Adding or removing a repo writes an AuditEvent
// through the injected sink. Everything the caller supplies is opaque text:
// untrusted content is never rendered as HTML (SPEC §9 risk).
import { createHash } from "node:crypto";
import { AppError, ErrorCodes } from "../errors.js";
import {
  TEMPLATE_TYPES,
  type TemplateLibraryItem,
  type TemplateRepository,
  type TemplateRepo,
} from "@m365-assess/db";

export const TEMPLATE_REPO_NOT_FOUND = "template.repo_not_found";
export const TEMPLATE_REPO_REF_INVALID = "template.repo_ref_invalid";

/** GitHub install scope for the deferred integration (SPEC §3.2, §11.1). */
export type RepoInstallScope = "user" | "org";

export interface RepoTemplateRef {
  readonly url: string;
  readonly name: string;
}

/**
 * Parses a community repo reference: a full URL (`https://github.com/owner/repo`,
 * optional `.git`) or the `owner/repo` shorthand. The result is derived only
 * from the reference itself; no network access happens here.
 */
export function parseRepoRef(ref: string): RepoTemplateRef {
  const trimmed = ref.trim();
  if (trimmed.length === 0) {
    throw new AppError(TEMPLATE_REPO_REF_INVALID, "repo reference is required", 400, [
      { field: "ref", reason: "required" },
    ]);
  }
  const shorthand = /^([\w.-]+)\/([\w.-]+)$/.exec(trimmed);
  const shorthandOwner = shorthand?.[1];
  const shorthandRepo = shorthand?.[2];
  if (shorthandOwner && shorthandRepo) {
    return {
      url: `https://github.com/${shorthandOwner}/${shorthandRepo}`,
      name: stripGitSuffix(shorthandRepo),
    };
  }
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new AppError(
      TEMPLATE_REPO_REF_INVALID,
      "repo reference must be a URL or owner/repo",
      400,
      [{ field: "ref", reason: "invalid" }],
    );
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new AppError(TEMPLATE_REPO_REF_INVALID, "repo reference must be an http(s) URL", 400, [
      { field: "ref", reason: "invalid_protocol" },
    ]);
  }
  const segments = parsed.pathname.split("/").filter((segment) => segment.length > 0);
  const lastSegment = segments[segments.length - 1];
  if (segments.length < 2 || lastSegment === undefined) {
    throw new AppError(
      TEMPLATE_REPO_REF_INVALID,
      "repo URL must include an owner and a repository",
      400,
      [{ field: "ref", reason: "invalid" }],
    );
  }
  return { url: parsed.toString(), name: stripGitSuffix(lastSegment) };
}

function stripGitSuffix(value: string): string {
  return value.endsWith(".git") ? value.slice(0, -".git".length) : value;
}

/** Deterministic id derived from the URL: stable across re-adds, no path separators. */
export function repoIdForUrl(url: string): string {
  return `repo-${createHash("sha256").update(url).digest("hex").slice(0, 12)}`;
}

function assertTemplateType(type: string): void {
  if (!(TEMPLATE_TYPES as readonly string[]).includes(type)) {
    throw new AppError(
      ErrorCodes.validationFailed,
      `template type ${type} is not registered`,
      400,
      [{ field: "type", reason: "invalid" }],
    );
  }
}

export interface RepoTemplate {
  readonly name: string;
  readonly type: string;
  readonly body: string;
}

/** Fetches a repo's templates; the GitHub integration (T-0767) replaces the default. */
export type RepoTemplateFetcher = (repo: TemplateRepo) => Promise<readonly RepoTemplate[]>;

export interface AddRepoInput {
  /** URL or owner/repo reference to the community repository. */
  readonly ref?: string;
  /** Display name; defaults to the repository name parsed from the reference. */
  readonly name?: string;
  /** Template types the repo provides; each must be in the §9 registry. */
  readonly types: readonly string[];
  readonly writeAccess?: boolean;
  /** GitHub install scope; recorded in the audit event until the integration lands. */
  readonly scope?: RepoInstallScope;
}

export interface RepoAuditContext {
  readonly actorUserId?: string | null;
  readonly correlationId?: string | null;
}

export interface TemplateRepoServiceOptions {
  readonly repos: TemplateRepository;
  readonly audit?: (event: Record<string, unknown>) => Promise<void>;
  readonly fetchTemplates?: RepoTemplateFetcher;
  readonly now?: () => string;
}

export class TemplateRepoService {
  private readonly repos: TemplateRepository;
  private readonly audit: (event: Record<string, unknown>) => Promise<void>;
  private readonly fetchTemplates: RepoTemplateFetcher;
  private readonly now: () => string;

  constructor(options: TemplateRepoServiceOptions) {
    this.repos = options.repos;
    this.audit = options.audit ?? (async () => {});
    this.fetchTemplates = options.fetchTemplates ?? (async () => []);
    this.now = options.now ?? (() => new Date().toISOString());
  }

  async listRepos(options: { type?: string } = {}): Promise<TemplateRepo[]> {
    const repos = await this.repos.listTemplateRepos();
    return options.type ? repos.filter((repo) => repo.types.includes(options.type!)) : repos;
  }

  async addRepo(input: AddRepoInput, context: RepoAuditContext = {}): Promise<TemplateRepo> {
    const ref = parseRepoRef(input.ref ?? "");
    const types = [...input.types];
    for (const type of types) assertTemplateType(type);
    const repo: TemplateRepo = await this.repos.upsertTemplateRepo({
      id: repoIdForUrl(ref.url),
      url: ref.url,
      name: input.name?.trim() ? input.name.trim() : ref.name,
      types,
      writeAccess: input.writeAccess ?? false,
      builtin: false,
      signed: false,
      reviewState: "unreviewed",
      trusted: false,
    });
    await this.indexTemplates(repo);
    await this.recordAudit("template.repo.add", context, {
      targetType: "template-repo",
      targetId: repo.id,
      after: {
        id: repo.id,
        url: repo.url,
        name: repo.name,
        types: repo.types,
        writeAccess: repo.writeAccess,
        scope: input.scope ?? null,
      },
    });
    return repo;
  }

  async removeRepo(repoId: string, context: RepoAuditContext = {}): Promise<TemplateRepo> {
    const existing = await this.repos.getTemplateRepo(repoId);
    if (!existing) {
      throw new AppError(TEMPLATE_REPO_NOT_FOUND, `template repo '${repoId}' not found`, 404);
    }
    await this.repos.softDeleteTemplateRepo(repoId);
    const items = await this.repos.listTemplateLibraryItems({ repoId });
    for (const item of items) {
      await this.repos.softDeleteTemplateLibraryItem(item.id);
    }
    await this.recordAudit("template.repo.remove", context, {
      targetType: "template-repo",
      targetId: existing.id,
      before: {
        id: existing.id,
        url: existing.url,
        name: existing.name,
        types: existing.types,
      },
    });
    return existing;
  }

  async getRepoTemplates(repoId: string): Promise<TemplateLibraryItem[]> {
    const repo = await this.repos.getTemplateRepo(repoId);
    if (!repo) {
      throw new AppError(TEMPLATE_REPO_NOT_FOUND, `template repo '${repoId}' not found`, 404);
    }
    return this.repos.listTemplateLibraryItems({ repoId });
  }

  /**
   * Re-indexes a repo's templates: the fetched set replaces the stored index
   * (deterministic ids make re-indexing idempotent). Validates every fetched
   * type before mutating anything so a bad fetch cannot half-index a repo.
   */
  private async indexTemplates(repo: TemplateRepo): Promise<void> {
    const templates = await this.fetchTemplates(repo);
    for (const template of templates) assertTemplateType(template.type);
    const existing = await this.repos.listTemplateLibraryItems({ repoId: repo.id });
    for (const item of existing) {
      await this.repos.softDeleteTemplateLibraryItem(item.id);
    }
    for (const template of templates) {
      const id = `${repo.id}-${createHash("sha256")
        .update(`${template.type}:${template.name}`)
        .digest("hex")
        .slice(0, 12)}`;
      await this.repos.upsertTemplateLibraryItem({
        id,
        type: template.type,
        name: template.name,
        body: template.body,
        source: "community",
        repoId: repo.id,
      });
    }
  }

  private async recordAudit(
    action: string,
    context: RepoAuditContext,
    target: { targetType: string; targetId: string; after?: Record<string, unknown>; before?: Record<string, unknown> },
  ): Promise<void> {
    await this.audit({
      action,
      actorUserId: context.actorUserId ?? null,
      targetType: target.targetType,
      targetId: target.targetId,
      after: target.after ?? null,
      before: target.before ?? null,
      result: "success",
      correlationId: context.correlationId ?? null,
    });
  }
}
