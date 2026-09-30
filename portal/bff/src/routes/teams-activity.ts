// Teams activity report API (EPIC-026 SPEC.md §3.2, §4.2, §6, §9; T-0507).
// Exposes GET /v1/tenants/:tenantId/teams/activity behind RBAC teams.read.
// Read-only: the BFF performs no reporting call directly. It enqueues the
// Get-TeamsActivity worker (Graph usage reports with the Teams admin report as
// fallback) and paginates/shapes the result; the worker indicates the source.
import { AppError, ErrorCodes } from "../errors.js";
import { paginate, parsePagination } from "../pagination.js";
import { requireTenantInScope, type Caller } from "../rbac/authorize.js";
import type { RequestContext, Route, RouteResponse } from "../server.js";

export const TEAMS_ACTIVITY_PATH = "/v1/tenants/:tenantId/teams/activity";
export const TEAMS_READ_PERMISSION = "teams.read";
export const TEAMS_ACTIVITY_UNAUTHENTICATED = "request.unauthenticated";

export interface TeamsActivitySources {
  readonly teams: string;
  readonly users: string;
}

export interface TeamsActivityTeamRow {
  readonly teamId: string | null;
  readonly displayName: string;
  readonly activeUsers: number;
  readonly messages: number;
  readonly meetings: number;
  readonly calls: number;
  readonly lastActivityDate: string | null;
  readonly source: string;
}

export interface TeamsActivityUserRow {
  readonly userId: string | null;
  readonly displayName: string;
  readonly userPrincipalName: string;
  readonly teamId: string | null;
  readonly active: boolean;
  readonly messages: number;
  readonly meetings: number;
  readonly calls: number;
  readonly lastActivityDate: string | null;
  readonly source: string;
}

/** The worker's report: full lists, no cursor. */
export interface TeamsActivityData {
  readonly tenantId: string;
  readonly generatedAt: string;
  readonly period: string;
  readonly startDate: string | null;
  readonly endDate: string | null;
  readonly teams: readonly TeamsActivityTeamRow[];
  readonly users: readonly TeamsActivityUserRow[];
  readonly sources: TeamsActivitySources;
}

/** The route's response: both lists cursor-paginated under one offset cursor. */
export interface TeamsActivityReport extends TeamsActivityData {
  readonly nextCursor: string | null;
}

export interface TeamsActivityFilter {
  readonly period: string;
  readonly startDate?: string;
  readonly endDate?: string;
  readonly cursor: string | null;
  readonly limit: number;
}

export interface TeamsActivityProvider {
  getActivity(tenantId: string, filter: TeamsActivityFilter): Promise<TeamsActivityData>;
}

export interface TeamsActivityCaller extends Caller {
  readonly userId?: string;
}

export type TeamsActivityAuthorizer = (
  caller: TeamsActivityCaller,
  permission: string,
) => void | Promise<void>;

export interface TeamsActivityRoutesOptions {
  readonly provider: TeamsActivityProvider;
  readonly resolveCaller: (ctx: RequestContext) => TeamsActivityCaller | undefined;
  readonly authorize?: TeamsActivityAuthorizer;
}

const TEAMS_ACTIVITY_PERIODS = ["D7", "D30", "D90", "D180"] as const;
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

function unauthenticatedError(): AppError {
  return new AppError(TEAMS_ACTIVITY_UNAUTHENTICATED, "authentication required", 401);
}

function validationError(message: string, field: string): AppError {
  return new AppError(ErrorCodes.validationFailed, message, 400, [
    { field, reason: "invalid" },
  ]);
}

function requireCaller(
  resolveCaller: (ctx: RequestContext) => TeamsActivityCaller | undefined,
  ctx: RequestContext,
): TeamsActivityCaller {
  const caller = resolveCaller(ctx);
  if (caller === undefined) {
    throw unauthenticatedError();
  }
  return caller;
}

function requireParam(ctx: RequestContext, name: string): string {
  const value = ctx.params[name];
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new AppError(ErrorCodes.validationFailed, `${name} is required`, 400, [
      { field: name, reason: "required" },
    ]);
  }
  return value.trim();
}

async function authorizeRead(
  options: TeamsActivityRoutesOptions,
  caller: TeamsActivityCaller,
): Promise<void> {
  if (options.authorize) {
    await options.authorize(caller, TEAMS_READ_PERMISSION);
  } else {
    const permissions = caller.permissions ?? [];
    const hasPermission =
      permissions.includes(TEAMS_READ_PERMISSION) ||
      permissions.includes("*");
    if (!hasPermission) {
      throw new AppError(
        ErrorCodes.forbidden,
        "forbidden: missing teams.read permission",
        403,
      );
    }
  }
}

function parsePeriod(query: URLSearchParams): string {
  const raw = query.get("period");
  if (raw === null || raw === "") {
    return "D7";
  }
  if (!(TEAMS_ACTIVITY_PERIODS as readonly string[]).includes(raw)) {
    throw validationError(`period must be one of: ${TEAMS_ACTIVITY_PERIODS.join(", ")}`, "period");
  }
  return raw;
}

function parseDateFilter(query: URLSearchParams, name: string): string | undefined {
  const raw = query.get(name);
  if (raw === null || raw === "") {
    return undefined;
  }
  if (!DATE_PATTERN.test(raw) || Number.isNaN(Date.parse(raw))) {
    throw validationError(`${name} must be a date in yyyy-MM-dd format`, name);
  }
  return raw;
}

export function parseTeamsActivityFilter(query: URLSearchParams): TeamsActivityFilter {
  const pagination = parsePagination(query);
  const filter: {
    -readonly [K in keyof TeamsActivityFilter]: TeamsActivityFilter[K];
  } = {
    period: parsePeriod(query),
    cursor: pagination.cursor,
    limit: pagination.limit,
  };
  const startDate = parseDateFilter(query, "startDate");
  if (startDate !== undefined) {
    filter.startDate = startDate;
  }
  const endDate = parseDateFilter(query, "endDate");
  if (endDate !== undefined) {
    filter.endDate = endDate;
  }
  return filter;
}

export function createTeamsActivityRoutes(options: TeamsActivityRoutesOptions): Route[] {
  return [
    {
      method: "GET",
      path: TEAMS_ACTIVITY_PATH,
      handler: async (ctx: RequestContext): Promise<RouteResponse> => {
        const caller = requireCaller(options.resolveCaller, ctx);
        const tenantId = requireParam(ctx, "tenantId");

        requireTenantInScope(caller, tenantId);
        await authorizeRead(options, caller);

        const filter = parseTeamsActivityFilter(ctx.query);
        const data = await options.provider.getActivity(tenantId, filter);

        const teamsPage = paginate(data.teams, filter);
        const usersPage = paginate(data.users, filter);
        const report: TeamsActivityReport = {
          ...data,
          teams: teamsPage.items,
          users: usersPage.items,
          nextCursor: teamsPage.nextCursor ?? usersPage.nextCursor,
        };

        return {
          status: 200,
          headers: { "content-type": "application/json" },
          body: report,
        };
      },
    },
  ];
}

// Route modules own their OpenAPI path items (portal.v1.yaml `paths` is empty
// by design); a wiring ticket merges this fragment into the served document.
export const TEAMS_ACTIVITY_OPENAPI = {
  paths: {
    "/tenants/{tenantId}/teams/activity": {
      get: {
        operationId: "getTeamsActivity",
        summary: "Teams activity report with per-team and per-user usage",
        permission: TEAMS_READ_PERMISSION,
        security: [{ bearerAuth: [] }],
        parameters: [
          { name: "tenantId", in: "path", required: true, schema: { type: "string" } },
          {
            name: "period",
            in: "query",
            required: false,
            schema: { type: "string", enum: ["D7", "D30", "D90", "D180"], default: "D7" },
          },
          { name: "startDate", in: "query", required: false, schema: { type: "string", format: "date" } },
          { name: "endDate", in: "query", required: false, schema: { type: "string", format: "date" } },
          { name: "cursor", in: "query", required: false, schema: { type: "string" } },
          { name: "limit", in: "query", required: false, schema: { type: "integer", minimum: 1, maximum: 1000 } },
        ],
        responses: {
          "200": { description: "Paginated per-team and per-user Teams activity." },
        },
      },
    },
  },
} as const;
