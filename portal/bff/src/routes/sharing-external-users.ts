// SharePoint external users API (EPIC-027 SPEC.md §2 US-3, §3.3, §6; T-0525).
// Exposes GET /v1/tenants/:tenantId/sharing/external-users with the §3.3
// columns — External user, Email, Sites, Last access, Invited by — plus
// GET .../external-users/:externalUserId/access, the drill-through listing the
// sites/items that one external user can access. External users are aggregated
// live from Graph/SPO by the get-external-users worker (§7); the routes make no
// Graph call themselves and are read-only. Requires RBAC `Sharing.Permissions.Read` and
// tenant in caller scope. Enumeration is cursor-paginated (§9).
import { AppError, ErrorCodes } from "../errors.js";
import { parsePagination } from "../pagination.js";
import { requireTenantInScope, type Caller } from "../rbac/authorize.js";
import type { RequestContext, Route, RouteResponse } from "../server.js";

export const EXTERNAL_USERS_PATH = "/v1/tenants/:tenantId/sharing/external-users";
export const EXTERNAL_USER_ACCESS_PATH = `${EXTERNAL_USERS_PATH}/:externalUserId/access`;
export const SHARING_READ_PERMISSION = "Sharing.Permissions.Read";
export const EXTERNAL_USERS_UNAUTHENTICATED = "request.unauthenticated";

export interface ExternalUserItem {
  readonly externalUserId: string;
  readonly externalUser: string;
  readonly email: string;
  readonly sites: readonly string[];
  readonly siteCount: number;
  readonly accessCount: number;
  readonly lastAccess: string | null;
  readonly invitedBy: string | null;
}

export interface ExternalUsersFilter {
  readonly search?: string;
  readonly cursor: string | null;
  readonly limit: number;
}

export interface ExternalUsersPage {
  readonly tenantId: string;
  readonly totalCount: number;
  readonly items: readonly ExternalUserItem[];
  readonly nextCursor: string | null;
}

export interface ExternalUserAccessItem {
  readonly siteId: string;
  readonly siteName: string;
  readonly siteUrl: string;
  readonly itemId: string | null;
  readonly itemName: string | null;
  readonly roles: readonly string[];
  readonly linkType: string | null;
  readonly invitedBy: string | null;
  readonly invitedAt: string | null;
  readonly lastAccess: string | null;
}

export interface ExternalUserAccessPage {
  readonly tenantId: string;
  readonly externalUserId: string;
  readonly totalCount: number;
  readonly items: readonly ExternalUserAccessItem[];
  readonly nextCursor: string | null;
}

export interface ExternalUsersProvider {
  listExternalUsers(tenantId: string, filter: ExternalUsersFilter): Promise<ExternalUsersPage>;
  listExternalUserAccess(
    tenantId: string,
    externalUserId: string,
    pagination: { readonly cursor: string | null; readonly limit: number },
  ): Promise<ExternalUserAccessPage>;
}

export interface ExternalUsersCaller extends Caller {
  readonly userId?: string;
}

export type ExternalUsersAuthorizer = (
  caller: ExternalUsersCaller,
  permission: string,
) => void | Promise<void>;

export interface ExternalUsersRouteOptions {
  readonly provider: ExternalUsersProvider;
  readonly resolveCaller: (ctx: RequestContext) => ExternalUsersCaller | undefined;
  readonly authorize?: ExternalUsersAuthorizer;
}

function unauthenticatedError(): AppError {
  return new AppError(EXTERNAL_USERS_UNAUTHENTICATED, "authentication required", 401);
}

function requireCaller(
  resolveCaller: (ctx: RequestContext) => ExternalUsersCaller | undefined,
  ctx: RequestContext,
): ExternalUsersCaller {
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

function requireExternalUserIdParam(ctx: RequestContext): string {
  const value = ctx.params["externalUserId"];
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new AppError(ErrorCodes.validationFailed, "externalUserId is required", 400, [
      { field: "externalUserId", reason: "required" },
    ]);
  }
  return value.trim();
}

async function requireSharingRead(
  options: ExternalUsersRouteOptions,
  caller: ExternalUsersCaller,
): Promise<void> {
  if (options.authorize) {
    await options.authorize(caller, SHARING_READ_PERMISSION);
    return;
  }
  const permissions = caller.permissions ?? [];
  if (!permissions.includes(SHARING_READ_PERMISSION) && !permissions.includes("*")) {
    throw new AppError(ErrorCodes.forbidden, "forbidden: missing Sharing.Permissions.Read", 403);
  }
}

function optionalText(query: URLSearchParams, name: string): string | undefined {
  const value = query.get(name);
  if (value === null || value.length === 0) {
    return undefined;
  }
  return value;
}

export function parseExternalUsersFilter(query: URLSearchParams): ExternalUsersFilter {
  const pagination = parsePagination(query);
  return {
    search: optionalText(query, "search"),
    cursor: pagination.cursor,
    limit: pagination.limit,
  };
}

export function createExternalUsersRoutes(options: ExternalUsersRouteOptions): Route[] {
  const listHandler = async (ctx: RequestContext): Promise<RouteResponse> => {
    const caller = requireCaller(options.resolveCaller, ctx);
    const tenantId = requireTenantParam(ctx);

    requireTenantInScope(caller, tenantId);
    await requireSharingRead(options, caller);

    const filter = parseExternalUsersFilter(ctx.query);
    const page = await options.provider.listExternalUsers(tenantId, filter);

    return {
      status: 200,
      headers: { "content-type": "application/json" },
      body: page,
    };
  };

  const accessHandler = async (ctx: RequestContext): Promise<RouteResponse> => {
    const caller = requireCaller(options.resolveCaller, ctx);
    const tenantId = requireTenantParam(ctx);
    const externalUserId = requireExternalUserIdParam(ctx);

    requireTenantInScope(caller, tenantId);
    await requireSharingRead(options, caller);

    const page = await options.provider.listExternalUserAccess(
      tenantId,
      externalUserId,
      parsePagination(ctx.query),
    );

    return {
      status: 200,
      headers: { "content-type": "application/json" },
      body: page,
    };
  };

  return [
    { method: "GET", path: EXTERNAL_USERS_PATH, handler: listHandler },
    { method: "GET", path: EXTERNAL_USER_ACCESS_PATH, handler: accessHandler },
  ];
}

// Route modules own their OpenAPI path items (portal.v1.yaml `paths` is empty
// by design); a wiring ticket merges this fragment into the served document.
export const SHARING_EXTERNAL_USERS_OPENAPI = {
  paths: {
    "/tenants/{tenantId}/sharing/external-users": {
      get: {
        operationId: "listExternalUsers",
        summary: "List SharePoint external users (External user, Email, Sites, Last access, Invited by)",
        permission: SHARING_READ_PERMISSION,
        security: [{ bearerAuth: [] }],
        parameters: [
          { name: "tenantId", in: "path", required: true, schema: { type: "string" } },
          { name: "search", in: "query", required: false, schema: { type: "string" } },
          { name: "cursor", in: "query", required: false, schema: { type: "string" } },
          { name: "limit", in: "query", required: false, schema: { type: "integer" } },
        ],
        responses: {
          "200": { description: "Cursor-paginated external users with their site counts." },
          "400": { description: "A required path parameter is missing." },
          "401": { description: "Authentication required." },
          "403": { description: "The caller lacks Sharing.Permissions.Read or the tenant is out of scope." },
        },
      },
    },
    "/tenants/{tenantId}/sharing/external-users/{externalUserId}/access": {
      get: {
        operationId: "listExternalUserAccess",
        summary: "List the sites/items one external user can access (drill-through)",
        permission: SHARING_READ_PERMISSION,
        security: [{ bearerAuth: [] }],
        parameters: [
          { name: "tenantId", in: "path", required: true, schema: { type: "string" } },
          { name: "externalUserId", in: "path", required: true, schema: { type: "string" } },
          { name: "cursor", in: "query", required: false, schema: { type: "string" } },
          { name: "limit", in: "query", required: false, schema: { type: "integer" } },
        ],
        responses: {
          "200": { description: "Cursor-paginated sites/items the external user can access." },
          "400": { description: "A required path parameter is missing." },
          "401": { description: "Authentication required." },
          "403": { description: "The caller lacks Sharing.Permissions.Read or the tenant is out of scope." },
        },
      },
    },
  },
} as const;
