// Sharing links report API (EPIC-027 SPEC.md §2 US-1, §3.1, §4.1, §6; T-0521).
// Exposes GET /v1/tenants/:tenantId/sharing/report with the §3.1 columns:
// Site/OneDrive, Item, Link type (anonymous/organization/people), Permissions
// (view/edit), Created by, Created, Expires — and filters (linkType,
// permissions, site, createdAfter, anonymousOnly) over cursor pagination.
// Requires RBAC `Sharing.Permissions.Read` and tenant in caller scope. The route makes no
// Graph/SPO call itself: it hands the filter to a provider that enqueues the
// get-sharing-report worker, so large tenants are filtered in the worker.
import { AppError, ErrorCodes } from "../errors.js";
import { parsePagination } from "../pagination.js";
import { requireTenantInScope, type Caller } from "../rbac/authorize.js";
import type { RequestContext, Route, RouteResponse } from "../server.js";

export const SHARING_REPORT_PATH = "/v1/tenants/:tenantId/sharing/report";
export const SHARING_REPORT_READ_PERMISSION = "Sharing.Permissions.Read";
export const SHARING_REPORT_UNAUTHENTICATED = "request.unauthenticated";

export type SharingLinkType = "anonymous" | "organization" | "people";
export type SharingLinkPermissions = "view" | "edit";

export interface SharingReportItem {
  readonly siteId: string;
  readonly siteName: string;
  readonly siteUrl: string;
  readonly itemId: string;
  readonly itemName: string;
  readonly itemUrl: string;
  readonly driveId: string;
  readonly linkId: string;
  readonly linkType: SharingLinkType | "";
  readonly permissions: SharingLinkPermissions | "";
  readonly createdBy: string;
  readonly created: string | null;
  readonly expires: string | null;
}

export interface SharingReportFilter {
  readonly linkType?: SharingLinkType;
  readonly permissions?: SharingLinkPermissions;
  readonly site?: string;
  readonly createdAfter?: string;
  readonly anonymousOnly: boolean;
  readonly cursor: string | null;
  readonly limit: number;
}

export interface SharingReportPage {
  readonly tenantId: string;
  readonly totalCount: number;
  readonly items: readonly SharingReportItem[];
  readonly nextCursor: string | null;
}

export interface SharingReportProvider {
  listLinks(tenantId: string, filter: SharingReportFilter): Promise<SharingReportPage>;
}

export interface SharingReportCaller extends Caller {
  readonly userId?: string;
}

export type SharingReportAuthorizer = (
  caller: SharingReportCaller,
  permission: string,
) => void | Promise<void>;

export interface SharingReportRouteOptions {
  readonly provider: SharingReportProvider;
  readonly resolveCaller: (ctx: RequestContext) => SharingReportCaller | undefined;
  readonly authorize?: SharingReportAuthorizer;
}

export const SHARING_REPORT_OPENAPI = {
  paths: {
    "/tenants/{tenantId}/sharing/report": {
      get: {
        operationId: "listSharingReport",
        summary: "Sharing links across sites/OneDrive (filter: linkType, permissions, site, createdAfter, anonymousOnly)",
        permission: SHARING_REPORT_READ_PERMISSION,
        security: [{ bearerAuth: [] }],
        parameters: [
          { name: "tenantId", in: "path", required: true, schema: { type: "string" } },
          {
            name: "linkType",
            in: "query",
            required: false,
            schema: { type: "string", enum: ["anonymous", "organization", "people"] },
          },
          {
            name: "permissions",
            in: "query",
            required: false,
            schema: { type: "string", enum: ["view", "edit"] },
          },
          { name: "site", in: "query", required: false, schema: { type: "string" } },
          { name: "createdAfter", in: "query", required: false, schema: { type: "string", format: "date-time" } },
          { name: "anonymousOnly", in: "query", required: false, schema: { type: "boolean" } },
          { name: "cursor", in: "query", required: false, schema: { type: "string" } },
          { name: "limit", in: "query", required: false, schema: { type: "integer" } },
        ],
        responses: {
          "200": { description: "Cursor-paginated sharing links for the tenant." },
          "400": { description: "An unsupported filter value was supplied." },
          "401": { description: "Authentication required." },
          "403": { description: "The caller lacks Sharing.Permissions.Read or the tenant is outside the caller scope." },
        },
      },
    },
  },
} as const;

function unauthenticatedError(): AppError {
  return new AppError(SHARING_REPORT_UNAUTHENTICATED, "authentication required", 401);
}

function validationError(message: string, field: string): AppError {
  return new AppError(ErrorCodes.validationFailed, message, 400, [
    { field, reason: "invalid" },
  ]);
}

function requireCaller(
  resolveCaller: (ctx: RequestContext) => SharingReportCaller | undefined,
  ctx: RequestContext,
): SharingReportCaller {
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

function parseCreatedAfter(query: URLSearchParams, name: string): string | undefined {
  const value = optionalText(query, name);
  if (value === undefined) {
    return undefined;
  }
  if (Number.isNaN(Date.parse(value))) {
    throw validationError(`${name} must be a date-time string`, name);
  }
  return value;
}

function parseAnonymousOnly(query: URLSearchParams, name: string): boolean {
  const value = optionalText(query, name);
  if (value === undefined) {
    return false;
  }
  const normalized = value.toLowerCase();
  if (normalized === "true" || normalized === "1") {
    return true;
  }
  if (normalized === "false" || normalized === "0") {
    return false;
  }
  throw validationError(`${name} must be true or false`, name);
}

export function parseSharingReportFilter(query: URLSearchParams): SharingReportFilter {
  const pagination = parsePagination(query);
  const linkType = parseEnum<SharingLinkType>(query, "linkType", ["anonymous", "organization", "people"]);
  const permissions = parseEnum<SharingLinkPermissions>(query, "permissions", ["view", "edit"]);
  const site = optionalText(query, "site");
  const createdAfter = parseCreatedAfter(query, "createdAfter");
  const anonymousOnly = parseAnonymousOnly(query, "anonymousOnly");

  return {
    linkType,
    permissions,
    site,
    createdAfter,
    anonymousOnly,
    cursor: pagination.cursor,
    limit: pagination.limit,
  };
}

export function createSharingReportRoute(options: SharingReportRouteOptions): Route {
  return {
    method: "GET",
    path: SHARING_REPORT_PATH,
    handler: async (ctx: RequestContext): Promise<RouteResponse> => {
      const caller = requireCaller(options.resolveCaller, ctx);
      const tenantId = requireTenantParam(ctx);

      requireTenantInScope(caller, tenantId);

      if (options.authorize) {
        await options.authorize(caller, SHARING_REPORT_READ_PERMISSION);
      } else {
        const permissions = caller.permissions ?? [];
        if (!permissions.includes(SHARING_REPORT_READ_PERMISSION) && !permissions.includes("*")) {
          throw new AppError(ErrorCodes.forbidden, "forbidden: missing Sharing.Permissions.Read", 403);
        }
      }

      const filter = parseSharingReportFilter(ctx.query);
      const page = await options.provider.listLinks(tenantId, filter);

      return {
        status: 200,
        headers: { "content-type": "application/json" },
        body: page,
      };
    },
  };
}
