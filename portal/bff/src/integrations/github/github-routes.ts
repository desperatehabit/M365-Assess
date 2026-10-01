// GitHub integration routes (EPIC-041 SPEC §6; T-0802). Config, test, and the
// commit operation EPIC-039 uses are exposed here, over the T-0801 registry:
// config goes through `putConfig` (so `integrations.manage` and the audit
// snapshot are enforced by the repository), test through `testIntegration`, and
// commit through the registered GitHub adapter. Routes are only wired into the
// server by the app composition root; nothing here names a secret value.
import { randomUUID } from "node:crypto";
import { AppError, ErrorCodes } from "../../errors.js";
import { isAdmin, type Caller } from "../../rbac/authorize.js";
import {
  INTEGRATIONS_MANAGE_PERMISSION,
  IntegrationRegistry,
  type IntegrationCaller,
} from "../integration-registry.js";
import type { RequestContext, Route, RouteHandler, RouteResponse } from "../../server.js";
import type { IntegrationConfigInput } from "@m365-assess/db";
import {
  GITHUB_KIND,
  isGithubAdapter,
  type GithubCommitContext,
  type GithubCommitRequest,
} from "./github-adapter.js";

export const GITHUB_INTEGRATION_PATH = "/v1/integrations/github";
export const GITHUB_INTEGRATION_TEST_PATH = "/v1/integrations/github/test";
export const GITHUB_INTEGRATION_COMMIT_PATH = "/v1/integrations/github/commit";

export const GITHUB_READ_PERMISSION = "integrations.read";

export interface GithubRouteCaller extends Caller {
  readonly userId?: string;
}

export type GithubAuthorizer = (
  caller: GithubRouteCaller,
  permission: string,
) => void | Promise<void>;

export interface GithubIntegrationRouteOptions {
  readonly registry: IntegrationRegistry;
  readonly resolveCaller: (ctx: RequestContext) => GithubRouteCaller | undefined;
  readonly authorize?: GithubAuthorizer;
  readonly readBody?: (ctx: RequestContext) => unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function defaultAuthorize(caller: GithubRouteCaller, permission: string): Promise<void> {
  const granted = caller.permissions ?? [];
  if (granted.includes(permission) || granted.includes("*") || isAdmin(caller)) {
    return;
  }
  throw new AppError(ErrorCodes.forbidden, `forbidden: requires ${permission}`, 403, [
    { field: "permission", reason: permission },
  ]);
}

function requireCaller(
  resolveCaller: (ctx: RequestContext) => GithubRouteCaller | undefined,
  ctx: RequestContext,
): GithubRouteCaller {
  const caller = resolveCaller(ctx);
  if (caller === undefined) {
    throw new AppError(ErrorCodes.forbidden, "authentication required", 401);
  }
  return caller;
}

function readJsonBody(
  ctx: RequestContext,
  readBody: ((ctx: RequestContext) => unknown) | undefined,
): Record<string, unknown> {
  const body = readBody ? readBody(ctx) : ctx.body;
  if (typeof body === "string") {
    try {
      const parsed: unknown = JSON.parse(body);
      if (isRecord(parsed)) return parsed;
    } catch {
      // fall through to the structured error below
    }
  }
  if (!isRecord(body)) {
    throw new AppError(ErrorCodes.validationFailed, "request body must be a JSON object", 400, [
      { field: "body", reason: "invalid" },
    ]);
  }
  return body;
}

function parseConfigInput(body: Record<string, unknown>, id: string): IntegrationConfigInput {
  const enabled = body["enabled"];
  if (typeof enabled !== "boolean") {
    throw new AppError(ErrorCodes.validationFailed, "enabled must be a boolean", 400, [
      { field: "enabled", reason: "invalid" },
    ]);
  }
  const secretRef = body["secretRef"];
  if (typeof secretRef !== "string" || secretRef.trim().length === 0) {
    throw new AppError(ErrorCodes.validationFailed, "secretRef must be a non-empty string", 400, [
      { field: "secretRef", reason: "required" },
    ]);
  }
  const mapping = body["mapping"] ?? {};
  if (!isRecord(mapping)) {
    throw new AppError(ErrorCodes.validationFailed, "mapping must be a JSON object", 400, [
      { field: "mapping", reason: "invalid" },
    ]);
  }
  return { id, kind: GITHUB_KIND, enabled, secretRef: secretRef.trim(), mapping };
}

function parseCommitRequest(body: Record<string, unknown>): GithubCommitRequest {
  const repository = body["repository"];
  if (repository !== undefined && (typeof repository !== "string" || repository.trim().length === 0)) {
    throw new AppError(ErrorCodes.validationFailed, "repository must be a non-empty string", 400, [
      { field: "repository", reason: "invalid" },
    ]);
  }
  return {
    ...(typeof repository === "string" ? { repository: repository.trim() } : {}),
    path: requireString(body, "path"),
    content: requireString(body, "content"),
    message: requireString(body, "message"),
    ...(typeof body["branch"] === "string" ? { branch: body["branch"] } : {}),
    ...(typeof body["sha"] === "string" ? { sha: body["sha"] } : {}),
  };
}

function requireString(body: Record<string, unknown>, field: string): string {
  const value = body[field];
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new AppError(ErrorCodes.validationFailed, `${field} is required`, 400, [
      { field, reason: "required" },
    ]);
  }
  return value;
}

/** The registry caller the route vouches for after its own authorization. */
function asIntegrationCaller(caller: GithubRouteCaller): IntegrationCaller {
  if (caller.permissions?.includes(INTEGRATIONS_MANAGE_PERMISSION)) {
    return { permissions: caller.permissions };
  }
  return { permissions: [INTEGRATIONS_MANAGE_PERMISSION] };
}

export function createGithubIntegrationRoutes(
  options: GithubIntegrationRouteOptions,
): Route[] {
  const authorize: GithubAuthorizer = options.authorize ?? defaultAuthorize;

  const getHandler: RouteHandler = async (ctx): Promise<RouteResponse> => {
    const caller = requireCaller(options.resolveCaller, ctx);
    await authorize(caller, GITHUB_READ_PERMISSION);
    const config = await options.registry.getConfig(GITHUB_KIND);
    return { status: 200, body: { integration: config ?? null } };
  };

  const putHandler: RouteHandler = async (ctx): Promise<RouteResponse> => {
    const caller = requireCaller(options.resolveCaller, ctx);
    await authorize(caller, INTEGRATIONS_MANAGE_PERMISSION);
    const existing = await options.registry.getConfig(GITHUB_KIND);
    const input = parseConfigInput(
      readJsonBody(ctx, options.readBody),
      existing?.id ?? randomUUID(),
    );
    const config = await options.registry.putConfig(
      GITHUB_KIND,
      input,
      asIntegrationCaller(caller),
    );
    return { status: 200, body: { integration: config } };
  };

  const testHandler: RouteHandler = async (ctx): Promise<RouteResponse> => {
    const caller = requireCaller(options.resolveCaller, ctx);
    await authorize(caller, INTEGRATIONS_MANAGE_PERMISSION);
    const test = await options.registry.testIntegration(GITHUB_KIND);
    return { status: 200, body: { test } };
  };

  const commitHandler: RouteHandler = async (ctx): Promise<RouteResponse> => {
    const caller = requireCaller(options.resolveCaller, ctx);
    await authorize(caller, INTEGRATIONS_MANAGE_PERMISSION);
    const adapter = options.registry.resolve(GITHUB_KIND);
    if (!isGithubAdapter(adapter)) {
      throw new AppError(ErrorCodes.notFound, "github adapter is not registered", 404, [
        { field: "kind", reason: "unknown_kind" },
      ]);
    }
    const config = await options.registry.getConfig(GITHUB_KIND);
    if (config === undefined) {
      throw new AppError(
        ErrorCodes.notFound,
        `no integration config for kind '${GITHUB_KIND}'`,
        404,
        [{ field: "kind", reason: "not_configured" }],
      );
    }
    const request = parseCommitRequest(readJsonBody(ctx, options.readBody));
    const context: GithubCommitContext = {
      actorUserId: caller.userId ?? null,
      correlationId: ctx.correlationId,
    };
    const commit = await adapter.commit(config, request, context);
    return { status: 200, body: { commit } };
  };

  return [
    { method: "GET", path: GITHUB_INTEGRATION_PATH, handler: getHandler },
    { method: "PUT", path: GITHUB_INTEGRATION_PATH, handler: putHandler },
    { method: "POST", path: GITHUB_INTEGRATION_TEST_PATH, handler: testHandler },
    { method: "POST", path: GITHUB_INTEGRATION_COMMIT_PATH, handler: commitHandler },
  ];
}

export const GITHUB_INTEGRATION_OPENAPI = {
  paths: {
    "/integrations/github": {
      get: {
        operationId: "getGithubIntegration",
        summary: "Read the GitHub integration config",
        permission: GITHUB_READ_PERMISSION,
        security: [{ bearerAuth: [] }],
        responses: {
          "200": { description: "The GitHub integration config, or null when unconfigured." },
          "401": { description: "Authentication required." },
          "403": { description: "The caller lacks integrations.read." },
        },
      },
      put: {
        operationId: "putGithubIntegration",
        summary: "Enable or update the GitHub integration config",
        permission: INTEGRATIONS_MANAGE_PERMISSION,
        security: [{ bearerAuth: [] }],
        responses: {
          "200": { description: "The upserted GitHub integration config." },
          "400": { description: "Invalid config body." },
          "401": { description: "Authentication required." },
          "403": { description: "The caller lacks integrations.manage." },
        },
      },
    },
    "/integrations/github/test": {
      post: {
        operationId: "testGithubIntegration",
        summary: "Check the stored credential against the configured repository",
        permission: INTEGRATIONS_MANAGE_PERMISSION,
        security: [{ bearerAuth: [] }],
        responses: {
          "200": { description: "The test result." },
          "401": { description: "Authentication required." },
          "403": { description: "The caller lacks integrations.manage." },
          "404": { description: "The integration is not configured." },
        },
      },
    },
    "/integrations/github/commit": {
      post: {
        operationId: "commitGithubIntegration",
        summary: "Commit a template file through the enabled GitHub integration",
        permission: INTEGRATIONS_MANAGE_PERMISSION,
        security: [{ bearerAuth: [] }],
        responses: {
          "200": { description: "The commit reference and content sha." },
          "400": { description: "Missing or invalid commit body." },
          "401": { description: "The stored GitHub credential failed." },
          "403": { description: "The caller lacks integrations.manage, or the repo is not configured." },
          "404": { description: "The integration is not configured." },
          "409": { description: "The integration is disabled, or the file changed upstream." },
          "502": { description: "The GitHub API was unavailable." },
        },
      },
    },
  },
} as const;
