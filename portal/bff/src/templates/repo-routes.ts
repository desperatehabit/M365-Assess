// Community template repos API (EPIC-039 SPEC.md §3.2, §6, §7; T-0763).
// GET/POST/DELETE /v1/template-repos and GET /v1/template-repos/{id}/templates,
// backed by the TemplateRepoService on the T-0761 store. Reads need
// `templates.read`; adding or removing a repo needs `templates.write` and is
// audited by the service. Browsing is read-only (SPEC §8).
import { AppError, ErrorCodes } from "../errors.js";
import { requirePermission, type Caller } from "../rbac/authorize.js";
import type { Permission } from "../rbac/roles.js";
import type { RequestContext, Route, RouteResponse } from "../server.js";
import {
  type AddRepoInput,
  type RepoInstallScope,
  TemplateRepoService,
} from "./repo-service.js";

export const TEMPLATE_REPOS_PATH = "/v1/template-repos";
export const TEMPLATE_REPO_ITEM_PATH = "/v1/template-repos/:id";
export const TEMPLATE_REPO_TEMPLATES_PATH = "/v1/template-repos/:id/templates";

export const TEMPLATE_REPOS_READ_PERMISSION = "templates.read";
export const TEMPLATE_REPOS_WRITE_PERMISSION = "templates.write";
export const TEMPLATE_REPOS_UNAUTHENTICATED = "request.unauthenticated";

export interface RepoRoutesCaller extends Caller {
  readonly userId?: string;
}

export type RepoRoutesAuthorizer = (
  caller: RepoRoutesCaller,
  permission: string,
) => void | Promise<void>;

export interface TemplateRepoRoutesOptions {
  readonly service: TemplateRepoService;
  readonly resolveCaller: (ctx: RequestContext) => RepoRoutesCaller | undefined;
  readonly authorize?: RepoRoutesAuthorizer;
}

function unauthenticatedError(): AppError {
  return new AppError(TEMPLATE_REPOS_UNAUTHENTICATED, "authentication required", 401);
}

function notFoundError(id: string): AppError {
  return new AppError(ErrorCodes.notFound, `template repo '${id}' not found`, 404);
}

function requireCaller(
  resolveCaller: (ctx: RequestContext) => RepoRoutesCaller | undefined,
  ctx: RequestContext,
): RepoRoutesCaller {
  const caller = resolveCaller(ctx);
  if (caller === undefined) {
    throw unauthenticatedError();
  }
  return caller;
}

function requireIdParam(ctx: RequestContext): string {
  const value = ctx.params["id"];
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new AppError(ErrorCodes.validationFailed, "id is required", 400, [
      { field: "id", reason: "required" },
    ]);
  }
  return value.trim();
}

async function authorizePermission(
  options: TemplateRepoRoutesOptions,
  caller: RepoRoutesCaller,
  permission: string,
): Promise<void> {
  if (options.authorize) {
    await options.authorize(caller, permission);
    return;
  }
  // templates.* is not in the roles.ts union yet (EPIC-038); deny without a seam.
  requirePermission(caller, permission as Permission);
}

function parseScope(value: unknown): RepoInstallScope | undefined {
  return value === "user" || value === "org" ? value : undefined;
}

function parseAddRepoInput(body: unknown): AddRepoInput {
  const record = (body ?? {}) as Record<string, unknown>;
  return {
    ref: typeof record["ref"] === "string" ? record["ref"] : undefined,
    name: typeof record["name"] === "string" ? record["name"] : undefined,
    types: Array.isArray(record["types"]) ? record["types"].map((type) => String(type)) : [],
    writeAccess: record["writeAccess"] === true,
    scope: parseScope(record["scope"]),
  };
}

function auditContext(ctx: RequestContext, caller: RepoRoutesCaller): { actorUserId: string | null; correlationId: string } {
  return { actorUserId: caller.userId ?? null, correlationId: ctx.correlationId };
}

export function createTemplateRepoRoutes(options: TemplateRepoRoutesOptions): Route[] {
  return [
    {
      method: "GET",
      path: TEMPLATE_REPOS_PATH,
      handler: async (ctx: RequestContext): Promise<RouteResponse> => {
        const caller = requireCaller(options.resolveCaller, ctx);
        await authorizePermission(options, caller, TEMPLATE_REPOS_READ_PERMISSION);

        const type = ctx.query.get("type") ?? undefined;
        const repos = await options.service.listRepos(type ? { type } : {});
        return {
          status: 200,
          headers: { "content-type": "application/json" },
          body: { items: repos, totalCount: repos.length },
        };
      },
    },
    {
      method: "POST",
      path: TEMPLATE_REPOS_PATH,
      handler: async (ctx: RequestContext): Promise<RouteResponse> => {
        const caller = requireCaller(options.resolveCaller, ctx);
        await authorizePermission(options, caller, TEMPLATE_REPOS_WRITE_PERMISSION);

        const repo = await options.service.addRepo(parseAddRepoInput(ctx.body), auditContext(ctx, caller));
        return {
          status: 201,
          headers: { "content-type": "application/json" },
          body: repo,
        };
      },
    },
    {
      method: "DELETE",
      path: TEMPLATE_REPO_ITEM_PATH,
      handler: async (ctx: RequestContext): Promise<RouteResponse> => {
        const caller = requireCaller(options.resolveCaller, ctx);
        await authorizePermission(options, caller, TEMPLATE_REPOS_WRITE_PERMISSION);

        const id = requireIdParam(ctx);
        await options.service.removeRepo(id, auditContext(ctx, caller));
        return {
          status: 200,
          headers: { "content-type": "application/json" },
          body: { deleted: true, id },
        };
      },
    },
    {
      method: "GET",
      path: TEMPLATE_REPO_TEMPLATES_PATH,
      handler: async (ctx: RequestContext): Promise<RouteResponse> => {
        const caller = requireCaller(options.resolveCaller, ctx);
        await authorizePermission(options, caller, TEMPLATE_REPOS_READ_PERMISSION);

        const id = requireIdParam(ctx);
        const items = await options.service.getRepoTemplates(id);
        return {
          status: 200,
          headers: { "content-type": "application/json" },
          body: { items, totalCount: items.length },
        };
      },
    },
  ];
}

// ─── OpenAPI fragment (§6) ───────────────────────────────────────────────────

export const TEMPLATE_REPOS_OPENAPI = {
  "/v1/template-repos": {
    get: {
      tags: ["Templates"],
      operationId: "listTemplateRepos",
      summary: "List community template repos.",
      permission: TEMPLATE_REPOS_READ_PERMISSION,
      security: [{ bearerAuth: [] }],
      parameters: [
        { name: "type", in: "query", required: false, schema: { type: "string" } },
      ],
      responses: {
        "200": { description: "Repos.", content: { "application/json": { schema: { $ref: "#/components/schemas/TemplateRepoListResponse" } } } },
        "401": { description: "Unauthenticated.", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
        "403": { description: "Forbidden.", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
      },
    },
    post: {
      tags: ["Templates"],
      operationId: "addTemplateRepo",
      summary: "Add a community template repo.",
      permission: TEMPLATE_REPOS_WRITE_PERMISSION,
      security: [{ bearerAuth: [] }],
      requestBody: {
        required: true,
        content: {
          "application/json": {
            schema: {
              type: "object",
              required: ["ref", "types"],
              properties: {
                ref: { type: "string", description: "URL or owner/repo." },
                name: { type: "string" },
                types: { type: "array", items: { type: "string" } },
                writeAccess: { type: "boolean" },
                scope: { type: "string", enum: ["user", "org"] },
              },
            },
          },
        },
      },
      responses: {
        "201": { description: "Created.", content: { "application/json": { schema: { $ref: "#/components/schemas/TemplateRepo" } } } },
        "400": { description: "Invalid reference or type.", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
        "401": { description: "Unauthenticated.", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
        "403": { description: "Forbidden.", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
      },
    },
  },
  "/v1/template-repos/{id}": {
    delete: {
      tags: ["Templates"],
      operationId: "removeTemplateRepo",
      summary: "Remove a community template repo.",
      permission: TEMPLATE_REPOS_WRITE_PERMISSION,
      security: [{ bearerAuth: [] }],
      parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
      responses: {
        "200": { description: "Removed.", content: { "application/json": { schema: { $ref: "#/components/schemas/TemplateRepoDeleteResponse" } } } },
        "401": { description: "Unauthenticated.", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
        "403": { description: "Forbidden.", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
        "404": { description: "Not found.", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
      },
    },
  },
  "/v1/template-repos/{id}/templates": {
    get: {
      tags: ["Templates"],
      operationId: "getTemplateRepoTemplates",
      summary: "List a repo's indexed templates.",
      permission: TEMPLATE_REPOS_READ_PERMISSION,
      security: [{ bearerAuth: [] }],
      parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
      responses: {
        "200": { description: "Templates.", content: { "application/json": { schema: { $ref: "#/components/schemas/TemplateLibraryItemListResponse" } } } },
        "401": { description: "Unauthenticated.", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
        "403": { description: "Forbidden.", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
        "404": { description: "Not found.", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
      },
    },
  },
} as const;
