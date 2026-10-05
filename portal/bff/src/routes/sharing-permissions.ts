// Site/OneDrive permissions report read (EPIC-027 SPEC.md §2 US-2, §3.2, §4.1,
// §6; T-0523). Exposes GET /v1/tenants/:tenantId/sharing/permissions with the
// §3.2 columns (Site · Principal · Role · Inherited · Scope) and the role /
// principal-type filters over cursor pagination. The report is explicitly
// read-only: the injected provider is backed by the worker queue running the
// Get-PermissionsReport child job (live Graph/SPO reads, no tenant write), so
// this module holds no M365 SDK call and issues no write. Reads require
// `Sharing.Permissions.Read` (SPEC §7) intersected with the caller tenant scope. Filtering
// is pushed to the worker so the BFF never materializes a large tenant's full
// permission set.
import { AppError, ErrorCodes } from "../errors.js";
import { parsePagination } from "../pagination.js";
import { requireTenantInScope, type Caller } from "../rbac/authorize.js";
import type { RequestContext, Route, RouteResponse } from "../server.js";

export const SHARING_PERMISSIONS_PATH = "/v1/tenants/:tenantId/sharing/permissions";
export const SHARING_READ_PERMISSION = "Sharing.Permissions.Read";
export const SHARING_PERMISSIONS_UNAUTHENTICATED = "request.unauthenticated";

export type SharingPermissionPrincipalType = "user" | "group" | "servicePrincipal";

export interface SharingPermissionItem {
  readonly site: string;
  readonly siteId: string;
  readonly principal: string;
  readonly principalId: string;
  readonly principalType: SharingPermissionPrincipalType;
  readonly role: string;
  readonly roles: readonly string[];
  readonly inherited: boolean;
  readonly scope: string;
}

export interface SharingPermissionsFilter {
  readonly role?: string;
  readonly principalType?: SharingPermissionPrincipalType;
  readonly cursor: string | null;
  readonly limit: number;
}

export interface SharingPermissionsPage {
  readonly tenantId: string;
  readonly totalCount: number;
  readonly items: readonly SharingPermissionItem[];
  readonly nextCursor: string | null;
}

// Queue-backed seam for the report read: the production wiring enqueues a
// get-permissions-report worker job for (tenantId, filter) and serves the worker
// page. Depending on the seam keeps Graph/SPO and process code out of the BFF.
export interface SharingPermissionsProvider {
  listPermissions(tenantId: string, filter: SharingPermissionsFilter): Promise<SharingPermissionsPage>;
}

export interface SharingPermissionsCaller extends Caller {
  readonly userId?: string;
}

export type SharingPermissionsAuthorizer = (
  caller: SharingPermissionsCaller,
  permission: string,
) => void | Promise<void>;

export interface SharingPermissionsRouteOptions {
  readonly provider: SharingPermissionsProvider;
  readonly resolveCaller: (ctx: RequestContext) => SharingPermissionsCaller | undefined;
  readonly authorize?: SharingPermissionsAuthorizer;
}

function unauthenticatedError(): AppError {
  return new AppError(SHARING_PERMISSIONS_UNAUTHENTICATED, "authentication required", 401);
}

function validationError(message: string, field: string): AppError {
  return new AppError(ErrorCodes.validationFailed, message, 400, [
    { field, reason: "invalid" },
  ]);
}

function requireCaller(
  resolveCaller: (ctx: RequestContext) => SharingPermissionsCaller | undefined,
  ctx: RequestContext,
): SharingPermissionsCaller {
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

export function parseSharingPermissionsFilter(query: URLSearchParams): SharingPermissionsFilter {
  const pagination = parsePagination(query);
  const role = optionalText(query, "role");
  const principalType = parseEnum<SharingPermissionPrincipalType>(query, "principalType", [
    "user",
    "group",
    "servicePrincipal",
  ]);

  return {
    role,
    principalType,
    cursor: pagination.cursor,
    limit: pagination.limit,
  };
}

export function createSharingPermissionsRoute(options: SharingPermissionsRouteOptions): Route {
  return {
    method: "GET",
    path: SHARING_PERMISSIONS_PATH,
    handler: async (ctx: RequestContext): Promise<RouteResponse> => {
      const caller = requireCaller(options.resolveCaller, ctx);
      const tenantId = requireTenantParam(ctx);

      requireTenantInScope(caller, tenantId);

      if (options.authorize) {
        await options.authorize(caller, SHARING_READ_PERMISSION);
      } else {
        const permissions = caller.permissions ?? [];
        if (!permissions.includes(SHARING_READ_PERMISSION) && !permissions.includes("*")) {
          throw new AppError(ErrorCodes.forbidden, "forbidden: missing Sharing.Permissions.Read", 403);
        }
      }

      const filter = parseSharingPermissionsFilter(ctx.query);
      const page = await options.provider.listPermissions(tenantId, filter);

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
export const SHARING_PERMISSIONS_OPENAPI = {
  paths: {
    "/tenants/{tenantId}/sharing/permissions": {
      get: {
        operationId: "listSharingPermissions",
        summary: "Site/OneDrive permissions (site, principal, role, inherited, scope) filtered by role and principal type",
        permission: SHARING_READ_PERMISSION,
        security: [{ bearerAuth: [] }],
        parameters: [
          { name: "tenantId", in: "path", required: true, schema: { type: "string" } },
          { name: "role", in: "query", required: false, schema: { type: "string" } },
          {
            name: "principalType",
            in: "query",
            required: false,
            schema: { type: "string", enum: ["user", "group", "servicePrincipal"] },
          },
          { name: "cursor", in: "query", required: false, schema: { type: "string" } },
          { name: "limit", in: "query", required: false, schema: { type: "integer" } },
        ],
        responses: {
          "200": { description: "Cursor-paginated site/OneDrive permission rows." },
          "400": { description: "An unsupported principal-type value was supplied." },
          "401": { description: "Authentication required." },
          "403": { description: "The caller lacks Sharing.Permissions.Read or the tenant is out of scope." },
        },
      },
    },
  },
} as const;
