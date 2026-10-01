// GitHub integration adapter (EPIC-041 SPEC §3.1, §4, §6, §9; T-0802), the
// first adapter registered with the T-0801 registry. It is the opt-in
// dependency for EPIC-039's save-to-GitHub flow (T-0767), not a general-purpose
// connector, so it is a no-op until its config row is explicitly enabled.
//
// The credential is resolved *by reference* from the EPIC-002 store through the
// injected `readSecret` seam; the token is handed only to the transport and is
// never written to a log, an error, or an audit payload. The transport is
// injected so the adapter is unit-testable and the only scope requested is
// contents write (`GITHUB_CONTENTS_WRITE_PERMISSION`). A commit writes the
// template file through the GitHub contents API and records the returned commit
// ref in the audit log.
import { AppError, ErrorCodes } from "../../errors.js";
import {
  type IntegrationAdapter,
  type IntegrationSyncResult,
  type IntegrationTestResult,
} from "../integration-registry.js";
import type { IntegrationConfig } from "@m365-assess/db";

export const GITHUB_KIND = "github";
export const GITHUB_API_BASE = "https://api.github.com";
export const GITHUB_CONTENTS_WRITE_PERMISSION = "contents:write";
export const GITHUB_COMMIT_ACTION = "integration.github.commit";
export const GITHUB_DEFAULT_BRANCH = "main";

export const GITHUB_DISABLED = "integration.github.disabled";
export const GITHUB_NOT_CONFIGURED = "integration.github.not_configured";
export const GITHUB_REPOSITORY_NOT_ALLOWED = "integration.github.repository_not_allowed";
export const GITHUB_AUTH_FAILED = "integration.github.auth_failed";
export const GITHUB_CONFLICT = "integration.github.conflict";
export const GITHUB_UNAVAILABLE = "integration.github.unavailable";

const REPOSITORY_PATTERN = /^[\w.-]+\/[\w.-]+$/;

/** HTTP request the adapter hands to the transport; `token` travels separately. */
export interface GithubTransportRequest {
  readonly method: "GET" | "PUT";
  readonly url: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly body?: string;
}

export interface GithubHttpResponse {
  readonly status: number;
  /** Parsed JSON response body, or null when the response carried none. */
  readonly body: unknown;
}

/** HTTP transport seam. `token` is the resolved secret and must never be logged. */
export interface GithubTransport {
  send(request: GithubTransportRequest, token: string | null): Promise<GithubHttpResponse>;
}

export interface GithubCommitRequest {
  /** `owner/repo`; must be one of the configured repositories. Defaults to the sole one. */
  readonly repository?: string;
  readonly path: string;
  readonly content: string;
  readonly message: string;
  readonly branch?: string;
  /** Blob sha of the existing file, when updating rather than creating. */
  readonly sha?: string;
}

export interface GithubCommitResult {
  readonly commitRef: string;
  readonly contentSha: string;
  readonly repository: string;
  readonly path: string;
  readonly branch: string;
}

export interface GithubCommitContext {
  readonly actorUserId?: string | null;
  readonly correlationId?: string | null;
}

export interface GithubAdapterOptions {
  readonly transport?: GithubTransport;
  /** EPIC-002 reference resolution; resolved on demand, never stored. */
  readonly readSecret?: (ref: string) => Promise<string | null>;
  readonly recordAudit?: (event: Record<string, unknown>) => Promise<void>;
  readonly now?: () => string;
}

type FetchLike = (
  url: string,
  init: { method: string; headers: Record<string, string>; body?: string },
) => Promise<{ status: number; text(): Promise<string> }>;

/** Default transport over the runtime fetch; a test passes its own. */
export function createFetchGithubTransport(fetchImpl?: FetchLike): GithubTransport {
  const doFetch: FetchLike = fetchImpl ?? (globalThis as { fetch: FetchLike }).fetch;
  return {
    async send(request, token) {
      const headers: Record<string, string> = { ...request.headers };
      if (token !== null && token.length > 0) {
        headers["authorization"] = `Bearer ${token}`;
      }
      const init: { method: string; headers: Record<string, string>; body?: string } = {
        method: request.method,
        headers,
      };
      if (request.body !== undefined) init.body = request.body;
      const response = await doFetch(request.url, init);
      const text = await response.text();
      let body: unknown = null;
      if (text.length > 0) {
        try {
          body = JSON.parse(text);
        } catch {
          body = null;
        }
      }
      return { status: response.status, body };
    },
  };
}

interface GithubConfig {
  readonly repositories: readonly string[];
  readonly branch: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireRepository(value: string, field: string): string {
  const trimmed = value.trim();
  if (!REPOSITORY_PATTERN.test(trimmed)) {
    throw new AppError(
      GITHUB_NOT_CONFIGURED,
      `${field} must be an owner/repo reference`,
      400,
      [{ field, reason: "invalid" }],
    );
  }
  return trimmed;
}

/** Reads and validates the GitHub config from the registry's generic mapping. */
export function parseGithubConfig(config: IntegrationConfig): GithubConfig {
  const mapping = config.mapping;
  const repositories: string[] = [];
  const single = mapping["repository"];
  if (typeof single === "string" && single.trim().length > 0) {
    repositories.push(requireRepository(single, "mapping.repository"));
  }
  const list = mapping["repositories"];
  if (Array.isArray(list)) {
    for (const entry of list) {
      if (typeof entry === "string" && entry.trim().length > 0) {
        repositories.push(requireRepository(entry, "mapping.repositories"));
      }
    }
  }
  if (repositories.length === 0) {
    throw new AppError(
      GITHUB_NOT_CONFIGURED,
      "no GitHub repository configured; set mapping.repository",
      400,
      [{ field: "mapping.repository", reason: "required" }],
    );
  }
  const branchValue = mapping["branch"];
  const branch =
    typeof branchValue === "string" && branchValue.trim().length > 0
      ? branchValue.trim()
      : GITHUB_DEFAULT_BRANCH;
  return { repositories: [...new Set(repositories)], branch };
}

function requireNonEmpty(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new AppError(ErrorCodes.validationFailed, `${field} is required`, 400, [
      { field, reason: "required" },
    ]);
  }
  return value;
}

function readPushPermission(body: unknown): boolean | null {
  if (!isRecord(body) || !isRecord(body["permissions"])) return null;
  const push = body["permissions"]["push"];
  return typeof push === "boolean" ? push : null;
}

function readCommitRefs(body: unknown): { commitRef: string; contentSha: string } | null {
  if (!isRecord(body)) return null;
  const commit = body["commit"];
  const content = body["content"];
  const commitRef = isRecord(commit) ? commit["sha"] : undefined;
  const contentSha = isRecord(content) ? content["sha"] : undefined;
  if (typeof commitRef !== "string" || commitRef.length === 0) return null;
  return { commitRef, contentSha: typeof contentSha === "string" ? contentSha : "" };
}

function contentsUrl(repository: string, path: string): string {
  const encoded = path.split("/").map(encodeURIComponent).join("/");
  return `${GITHUB_API_BASE}/repos/${repository}/contents/${encoded}`;
}

/**
 * GitHub adapter: implements the registry's test/sync contract and adds the
 * commit operation EPIC-039 calls. Every operation fails closed when the
 * integration is not enabled.
 */
export class GithubAdapter implements IntegrationAdapter {
  readonly kind = GITHUB_KIND;
  private readonly transport: GithubTransport;
  private readonly readSecret: (ref: string) => Promise<string | null>;
  private readonly recordAudit: (event: Record<string, unknown>) => Promise<void>;
  private readonly now: () => string;

  constructor(options: GithubAdapterOptions = {}) {
    this.transport = options.transport ?? createFetchGithubTransport();
    this.readSecret = options.readSecret ?? (async () => null);
    this.recordAudit = options.recordAudit ?? (async () => {});
    this.now = options.now ?? (() => new Date().toISOString());
  }

  private async resolveToken(secretRef: string): Promise<string | null> {
    if (secretRef.trim().length === 0) return null;
    try {
      return await this.readSecret(secretRef);
    } catch {
      return null;
    }
  }

  async test(config: IntegrationConfig): Promise<IntegrationTestResult> {
    if (!config.enabled) {
      return { ok: false, message: "GitHub integration is disabled" };
    }
    const repository = parseGithubConfig(config).repositories[0];
    const token = await this.resolveToken(config.secretRef);
    if (token === null) {
      return { ok: false, message: "GitHub credential could not be resolved" };
    }
    let response: GithubHttpResponse;
    try {
      response = await this.transport.send(
        {
          method: "GET",
          url: `${GITHUB_API_BASE}/repos/${repository}`,
          headers: {
            accept: "application/vnd.github+json",
            "user-agent": "m365-assess",
          },
        },
        token,
      );
    } catch {
      return { ok: false, message: "GitHub repository check failed" };
    }
    if (response.status === 401 || response.status === 403) {
      return { ok: false, message: "GitHub authentication failed" };
    }
    if (response.status < 200 || response.status >= 300) {
      return { ok: false, message: `GitHub repository check failed (status ${response.status})` };
    }
    if (readPushPermission(response.body) === false) {
      return {
        ok: false,
        message: `GitHub token lacks ${GITHUB_CONTENTS_WRITE_PERMISSION} access to ${repository}`,
      };
    }
    return { ok: true, message: `GitHub integration ready for ${repository}` };
  }

  async sync(config: IntegrationConfig): Promise<IntegrationSyncResult> {
    if (!config.enabled) {
      return { ok: false, synced: 0, message: "GitHub integration is disabled" };
    }
    return { ok: true, synced: 0, message: "GitHub integration has no sync operation" };
  }

  async commit(
    config: IntegrationConfig,
    request: GithubCommitRequest,
    context: GithubCommitContext = {},
  ): Promise<GithubCommitResult> {
    if (!config.enabled) {
      throw new AppError(
        GITHUB_DISABLED,
        "GitHub integration is disabled; enable it before committing",
        409,
        [{ field: "enabled", reason: "disabled" }],
      );
    }
    const parsed = parseGithubConfig(config);
    const path = requireNonEmpty(request.path, "path");
    const content = requireNonEmpty(request.content, "content");
    const message = requireNonEmpty(request.message, "message");
    const repository = this.resolveRepository(parsed, request.repository);
    const branch =
      request.branch !== undefined && request.branch.trim().length > 0
        ? request.branch.trim()
        : parsed.branch;

    const token = await this.resolveToken(config.secretRef);
    if (token === null) {
      throw new AppError(GITHUB_AUTH_FAILED, "GitHub credential could not be resolved", 401);
    }

    const payload: Record<string, unknown> = {
      message,
      content: Buffer.from(content, "utf8").toString("base64"),
      branch,
    };
    if (request.sha !== undefined && request.sha.trim().length > 0) {
      payload["sha"] = request.sha.trim();
    }

    let response: GithubHttpResponse;
    try {
      response = await this.transport.send(
        {
          method: "PUT",
          url: contentsUrl(repository, path),
          headers: {
            accept: "application/vnd.github+json",
            "content-type": "application/json",
            "user-agent": "m365-assess",
          },
          body: JSON.stringify(payload),
        },
        token,
      );
    } catch {
      await this.auditFailure(repository, path, branch, message, context, "transport failure");
      throw new AppError(GITHUB_UNAVAILABLE, "GitHub API request failed", 502);
    }

    if (response.status === 401 || response.status === 403) {
      await this.auditFailure(repository, path, branch, message, context, "authentication failed");
      throw new AppError(GITHUB_AUTH_FAILED, "GitHub authentication failed", 401, [
        { field: "secretRef", reason: "auth_failed" },
      ]);
    }
    if (response.status === 409 || response.status === 422) {
      await this.auditFailure(repository, path, branch, message, context, "write conflict");
      throw new AppError(
        GITHUB_CONFLICT,
        "GitHub rejected the commit because the file changed; refresh and retry",
        409,
        [{ field: "path", reason: "conflict" }],
      );
    }
    if (response.status < 200 || response.status >= 300) {
      await this.auditFailure(repository, path, branch, message, context, "upstream failure");
      throw new AppError(
        GITHUB_UNAVAILABLE,
        `GitHub API returned status ${response.status}`,
        502,
      );
    }

    const refs = readCommitRefs(response.body);
    if (refs === null) {
      await this.auditFailure(repository, path, branch, message, context, "missing commit ref");
      throw new AppError(GITHUB_UNAVAILABLE, "GitHub did not return a commit reference", 502);
    }

    await this.recordAudit({
      action: GITHUB_COMMIT_ACTION,
      actorUserId: context.actorUserId ?? null,
      targetType: "integration.github.commit",
      targetId: `${repository}:${path}`,
      result: "success",
      error: null,
      before: null,
      after: {
        commitRef: refs.commitRef,
        contentSha: refs.contentSha,
        repository,
        path,
        branch,
        message,
      },
      correlationId: context.correlationId ?? null,
      createdAt: this.now(),
    });

    return {
      commitRef: refs.commitRef,
      contentSha: refs.contentSha,
      repository,
      path,
      branch,
    };
  }

  private resolveRepository(parsed: GithubConfig, requested?: string): string {
    const configured = parsed.repositories;
    if (requested !== undefined && requested.trim().length > 0) {
      const candidate = requested.trim();
      if (!configured.includes(candidate)) {
        throw new AppError(
          GITHUB_REPOSITORY_NOT_ALLOWED,
          `repository '${candidate}' is not configured for this integration`,
          403,
          [{ field: "repository", reason: "not_allowed" }],
        );
      }
      return candidate;
    }
    const only = configured[0];
    if (configured.length !== 1 || only === undefined) {
      throw new AppError(
        GITHUB_NOT_CONFIGURED,
        "no repository selected; the integration configures more than one",
        400,
        [{ field: "repository", reason: "required" }],
      );
    }
    return only;
  }

  private async auditFailure(
    repository: string,
    path: string,
    branch: string,
    message: string,
    context: GithubCommitContext,
    error: string,
  ): Promise<void> {
    await this.recordAudit({
      action: GITHUB_COMMIT_ACTION,
      actorUserId: context.actorUserId ?? null,
      targetType: "integration.github.commit",
      targetId: `${repository}:${path}`,
      result: "failure",
      error,
      before: null,
      after: { repository, path, branch, message, commitRef: null },
      correlationId: context.correlationId ?? null,
      createdAt: this.now(),
    });
  }
}

export function createGithubAdapter(options: GithubAdapterOptions = {}): GithubAdapter {
  return new GithubAdapter(options);
}

/** Registers the GitHub adapter with the T-0801 registry. */
export function registerGithubAdapter(
  registry: { register(adapter: IntegrationAdapter): void },
  adapter: GithubAdapter = createGithubAdapter(),
): GithubAdapter {
  registry.register(adapter);
  return adapter;
}

export function isGithubAdapter(adapter: IntegrationAdapter): adapter is GithubAdapter {
  return adapter instanceof GithubAdapter;
}
