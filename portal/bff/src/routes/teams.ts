// Teams list API (EPIC-026 SPEC.md §2 US-1, §3.1, §6, §7, §9; T-0502).
// Exposes GET /v1/tenants/:tenantId/teams with the §3.1 columns:
// Name, Owners, Members, Visibility, Archived, Created, Sensitivity
// and filters (visibility, archived, activity date window).
// Teams are read live by the worker from the Graph Teams scopes (SPEC §7,
// app-only per tenant); this route performs no Graph call directly and no writes.
// Requires RBAC `Teams.Team.Read` and tenant in caller scope.
import { AppError, ErrorCodes } from "../errors.js";
import { parsePagination } from "../pagination.js";
import { requireTenantInScope, type Caller } from "../rbac/authorize.js";
import type { RequestContext, Route, RouteResponse } from "../server.js";

export const TEAMS_PATH = "/v1/tenants/:tenantId/teams";
export const TEAMS_READ_PERMISSION = "Teams.Team.Read";
export const TEAMS_UNAUTHENTICATED = "request.unauthenticated";

export const TEAM_VISIBILITIES = ["public", "private"] as const;

export type TeamVisibility = (typeof TEAM_VISIBILITIES)[number];

export interface TeamItem {
  readonly id: string;
  readonly name: string;
  readonly ownerCount: number;
  readonly memberCount: number;
  readonly visibility: TeamVisibility;
  readonly isArchived: boolean;
  readonly createdDateTime: string;
  readonly sensitivityLabel: string;
}

export interface TeamsFilter {
  readonly visibility?: TeamVisibility;
  readonly archived?: boolean;
  readonly from?: string;
  readonly to?: string;
  readonly cursor: string | null;
  readonly limit: number;
}

export interface TeamsPage {
  readonly tenantId: string;
  readonly totalCount: number;
  readonly items: readonly TeamItem[];
  readonly nextCursor: string | null;
}

export interface TeamsProvider {
  listTeams(tenantId: string, filter: TeamsFilter): Promise<TeamsPage>;
}

export interface TeamsCaller extends Caller {
  readonly userId?: string;
}

export type TeamsAuthorizer = (
  caller: TeamsCaller,
  permission: string,
) => void | Promise<void>;

export interface TeamsRouteOptions {
  readonly provider: TeamsProvider;
  readonly resolveCaller: (ctx: RequestContext) => TeamsCaller | undefined;
  readonly authorize?: TeamsAuthorizer;
}

function unauthenticatedError(): AppError {
  return new AppError(TEAMS_UNAUTHENTICATED, "authentication required", 401);
}

function validationError(message: string, field: string): AppError {
  return new AppError(ErrorCodes.validationFailed, message, 400, [
    { field, reason: "invalid" },
  ]);
}

function requireCaller(
  resolveCaller: (ctx: RequestContext) => TeamsCaller | undefined,
  ctx: RequestContext,
): TeamsCaller {
  const caller = resolveCaller(ctx);
  if (caller === undefined) {
    throw unauthenticatedError();
  }
  return caller;
}

async function ensureRead(options: TeamsRouteOptions, caller: TeamsCaller): Promise<void> {
  if (options.authorize) {
    await options.authorize(caller, TEAMS_READ_PERMISSION);
    return;
  }
  const permissions = caller.permissions ?? [];
  if (!permissions.includes(TEAMS_READ_PERMISSION) && !permissions.includes("*")) {
    throw new AppError(ErrorCodes.forbidden, "forbidden: missing Teams.Team.Read", 403);
  }
}

function requireTenantParam(ctx: RequestContext): string {
  const value = ctx.params["tenantId"];
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new AppError(ErrorCodes.validationFailed, "tenantId is required", 400, [
      { field: "tenantId", reason: "required" },
    ]);
  }
  return value.trim();
}

function optionalText(query: URLSearchParams, name: string): string | undefined {
  const value = query.get(name);
  if (value === null || value.length === 0) {
    return undefined;
  }
  return value;
}

function parseVisibility(query: URLSearchParams): TeamVisibility | undefined {
  const value = optionalText(query, "visibility");
  if (value === undefined) {
    return undefined;
  }
  if (!(TEAM_VISIBILITIES as readonly string[]).includes(value)) {
    throw validationError(
      `visibility must be one of: ${TEAM_VISIBILITIES.join(", ")}`,
      "visibility",
    );
  }
  return value as TeamVisibility;
}

function parseBoolean(query: URLSearchParams, name: string): boolean | undefined {
  const value = optionalText(query, name);
  if (value === undefined) {
    return undefined;
  }
  const lower = value.toLowerCase();
  if (lower === "true" || lower === "1") {
    return true;
  }
  if (lower === "false" || lower === "0") {
    return false;
  }
  throw validationError(`${name} must be a boolean (true or false)`, name);
}

function parseDateParam(query: URLSearchParams, name: string): string | undefined {
  const value = optionalText(query, name);
  if (value === undefined) {
    return undefined;
  }
  if (Number.isNaN(Date.parse(value))) {
    throw validationError(`${name} must be a valid date-time`, name);
  }
  return value;
}

export function parseTeamsFilter(query: URLSearchParams): TeamsFilter {
  const pagination = parsePagination(query);
  return {
    visibility: parseVisibility(query),
    archived: parseBoolean(query, "archived"),
    from: parseDateParam(query, "from"),
    to: parseDateParam(query, "to"),
    cursor: pagination.cursor,
    limit: pagination.limit,
  };
}

export function createTeamsListRoute(options: TeamsRouteOptions): Route {
  return {
    method: "GET",
    path: TEAMS_PATH,
    handler: async (ctx: RequestContext): Promise<RouteResponse> => {
      const caller = requireCaller(options.resolveCaller, ctx);
      const tenantId = requireTenantParam(ctx);

      requireTenantInScope(caller, tenantId);
      await ensureRead(options, caller);

      const filter = parseTeamsFilter(ctx.query);
      const page = await options.provider.listTeams(tenantId, filter);

      return {
        status: 200,
        headers: { "content-type": "application/json" },
        body: page,
      };
    },
  };
}

// Route modules own their OpenAPI path items (portal.v1.yaml `paths` is empty
// by design); a wiring ticket merges this fragment into the served document.
export const TEAMS_OPENAPI = {
  paths: {
    "/tenants/{tenantId}/teams": {
      get: {
        operationId: "listTeams",
        summary: "List teams with §3.1 columns, filters, and cursor pagination",
        permission: TEAMS_READ_PERMISSION,
        security: [{ bearerAuth: [] }],
        parameters: [
          { name: "tenantId", in: "path", required: true, schema: { type: "string" } },
          {
            name: "visibility",
            in: "query",
            required: false,
            schema: { type: "string", enum: [...TEAM_VISIBILITIES] },
          },
          { name: "archived", in: "query", required: false, schema: { type: "boolean" } },
          { name: "from", in: "query", required: false, schema: { type: "string" } },
          { name: "to", in: "query", required: false, schema: { type: "string" } },
          { name: "cursor", in: "query", required: false, schema: { type: "string" } },
          { name: "limit", in: "query", required: false, schema: { type: "integer" } },
        ],
        responses: {
          "200": { description: "The tenant's filtered team page." },
          "400": { description: "A path or query parameter is invalid." },
          "401": { description: "Authentication is required." },
          "403": { description: "The caller lacks the Teams.Team.Read permission." },
        },
      },
    },
  },
} as const;
