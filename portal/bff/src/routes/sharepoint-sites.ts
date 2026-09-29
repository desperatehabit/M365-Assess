// SharePoint site list API (EPIC-025 SPEC.md §3.1, §6, §7; T-0482).
// Exposes GET /v1/tenants/:tenantId/sharepoint/sites with the §3.1 columns:
// Name/URL, Type (team/communication), Owners, Storage used, Last activity,
// Sensitivity, External sharing — and filters (type, sharing, storagePercent,
// lastActivity, sensitivity) over cursor pagination.
// Requires RBAC `sharepoint.read` and tenant in caller scope. The route makes
// no Graph call itself: it hands the filter to a provider that enqueues the
// get-sharepoint-sites worker, so large tenants are filtered in the worker.
import { AppError, ErrorCodes } from "../errors.js";
import { parsePagination } from "../pagination.js";
import { requireTenantInScope, type Caller } from "../rbac/authorize.js";
import type { RequestContext, Route, RouteResponse } from "../server.js";

export const SHAREPOINT_SITES_PATH = "/v1/tenants/:tenantId/sharepoint/sites";
export const SHAREPOINT_SITES_READ_PERMISSION = "sharepoint.read";
export const SHAREPOINT_SITES_UNAUTHENTICATED = "request.unauthenticated";

export type SharePointSiteType = "team" | "communication";
export type SharePointSharing =
  | "disabled"
  | "externalUserSharingOnly"
  | "externalUserAndGuestSharing"
  | "existingExternalUserSharingOnly";

export interface SharePointSiteItem {
  readonly id: string;
  readonly name: string;
  readonly url: string;
  readonly type: SharePointSiteType;
  readonly owners: readonly string[];
  readonly storageUsedMB: number | null;
  readonly storageAllocatedMB: number | null;
  readonly storageUsedPercent: number | null;
  readonly lastActivity: string | null;
  readonly sensitivity: string;
  readonly sharing: SharePointSharing | "";
}

export interface SharePointSitesFilter {
  readonly type?: SharePointSiteType;
  readonly sharing?: SharePointSharing;
  readonly storagePercent?: number;
  readonly lastActivity?: string;
  readonly sensitivity?: string;
  readonly cursor: string | null;
  readonly limit: number;
}

export interface SharePointSitesPage {
  readonly tenantId: string;
  readonly totalCount: number;
  readonly items: readonly SharePointSiteItem[];
  readonly nextCursor: string | null;
}

export interface SharePointSitesProvider {
  listSites(tenantId: string, filter: SharePointSitesFilter): Promise<SharePointSitesPage>;
}

export interface SharePointSitesCaller extends Caller {
  readonly userId?: string;
}

export type SharePointSitesAuthorizer = (
  caller: SharePointSitesCaller,
  permission: string,
) => void | Promise<void>;

export interface SharePointSitesListRouteOptions {
  readonly provider: SharePointSitesProvider;
  readonly resolveCaller: (ctx: RequestContext) => SharePointSitesCaller | undefined;
  readonly authorize?: SharePointSitesAuthorizer;
}

export const SHAREPOINT_SITES_OPENAPI = {
  paths: {
    "/tenants/{tenantId}/sharepoint/sites": {
      get: {
        operationId: "listSharePointSites",
        summary: "List SharePoint sites (filter: type, sharing, storagePercent, lastActivity, sensitivity)",
        permission: SHAREPOINT_SITES_READ_PERMISSION,
        security: [{ bearerAuth: [] }],
        parameters: [
          { name: "type", in: "query", required: false, schema: { type: "string", enum: ["team", "communication"] } },
          {
            name: "sharing",
            in: "query",
            required: false,
            schema: {
              type: "string",
              enum: ["disabled", "externalUserSharingOnly", "externalUserAndGuestSharing", "existingExternalUserSharingOnly"],
            },
          },
          { name: "storagePercent", in: "query", required: false, schema: { type: "integer", minimum: 0, maximum: 100 } },
          { name: "lastActivity", in: "query", required: false, schema: { type: "string", format: "date-time" } },
          { name: "sensitivity", in: "query", required: false, schema: { type: "string" } },
          { name: "cursor", in: "query", required: false, schema: { type: "string" } },
          { name: "limit", in: "query", required: false, schema: { type: "integer" } },
        ],
        responses: {
          "200": { description: "Cursor-paginated SharePoint sites for the tenant." },
          "400": { description: "An unsupported filter value was supplied." },
          "401": { description: "Authentication required." },
          "403": { description: "The caller lacks sharepoint.read or the tenant is outside the caller scope." },
        },
      },
    },
  },
} as const;

function unauthenticatedError(): AppError {
  return new AppError(SHAREPOINT_SITES_UNAUTHENTICATED, "authentication required", 401);
}

function validationError(message: string, field: string): AppError {
  return new AppError(ErrorCodes.validationFailed, message, 400, [
    { field, reason: "invalid" },
  ]);
}

function requireCaller(
  resolveCaller: (ctx: RequestContext) => SharePointSitesCaller | undefined,
  ctx: RequestContext,
): SharePointSitesCaller {
  const caller = resolveCaller(ctx);
  if (caller === undefined) {
    throw unauthenticatedError();
  }
  return caller;
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

function parseEnum<T extends string>(
  query: URLSearchParams,
  name: string,
  allowed: readonly T[],
): T | undefined {
  const value = optionalText(query, name);
  if (value === undefined) {
    return undefined;
  }
  if (!(allowed as readonly string[]).includes(value)) {
    throw validationError(`${name} must be one of: ${allowed.join(", ")}`, name);
  }
  return value as T;
}

function parseStoragePercent(query: URLSearchParams, name: string): number | undefined {
  const value = optionalText(query, name);
  if (value === undefined) {
    return undefined;
  }
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0 || parsed > 100) {
    throw validationError(`${name} must be an integer between 0 and 100`, name);
  }
  return parsed;
}

function parseLastActivity(query: URLSearchParams, name: string): string | undefined {
  const value = optionalText(query, name);
  if (value === undefined) {
    return undefined;
  }
  if (Number.isNaN(Date.parse(value))) {
    throw validationError(`${name} must be a date-time string`, name);
  }
  return value;
}

export function parseSharePointSitesFilter(query: URLSearchParams): SharePointSitesFilter {
  const pagination = parsePagination(query);
  const type = parseEnum<SharePointSiteType>(query, "type", ["team", "communication"]);
  const sharing = parseEnum<SharePointSharing>(query, "sharing", [
    "disabled",
    "externalUserSharingOnly",
    "externalUserAndGuestSharing",
    "existingExternalUserSharingOnly",
  ]);
  const storagePercent = parseStoragePercent(query, "storagePercent");
  const lastActivity = parseLastActivity(query, "lastActivity");
  const sensitivity = optionalText(query, "sensitivity");

  return {
    type,
    sharing,
    storagePercent,
    lastActivity,
    sensitivity,
    cursor: pagination.cursor,
    limit: pagination.limit,
  };
}

export function createSharePointSitesRoute(options: SharePointSitesListRouteOptions): Route {
  return {
    method: "GET",
    path: SHAREPOINT_SITES_PATH,
    handler: async (ctx: RequestContext): Promise<RouteResponse> => {
      const caller = requireCaller(options.resolveCaller, ctx);
      const tenantId = requireTenantParam(ctx);

      requireTenantInScope(caller, tenantId);

      if (options.authorize) {
        await options.authorize(caller, SHAREPOINT_SITES_READ_PERMISSION);
      } else {
        const permissions = caller.permissions ?? [];
        if (!permissions.includes(SHAREPOINT_SITES_READ_PERMISSION) && !permissions.includes("*")) {
          throw new AppError(ErrorCodes.forbidden, "forbidden: missing sharepoint.read", 403);
        }
      }

      const filter = parseSharePointSitesFilter(ctx.query);
      const page = await options.provider.listSites(tenantId, filter);

      return {
        status: 200,
        headers: { "content-type": "application/json" },
        body: page,
      };
    },
  };
}
