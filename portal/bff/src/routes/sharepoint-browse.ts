// SharePoint site browser API (EPIC-025 SPEC.md §2 US-5, §3.4, §4.3, §6, §7; T-0488).
// Exposes GET /v1/tenants/:tenantId/sharepoint/sites/:siteId/browse: per-site
// libraries, items, permissions, and external users, read-only, behind RBAC
// `sharepoint.read` and tenant scope. Permission changes are not performed here;
// the response carries the EPIC-027 hand-off paths and an SPO admin-center deep
// link for advanced actions not in v1 (SPEC §11 item 4). The route makes no
// Graph call itself: it hands the site id to a provider that enqueues the
// get-site-browser worker.
import { AppError, ErrorCodes } from "../errors.js";
import { requireTenantInScope, type Caller } from "../rbac/authorize.js";
import type { RequestContext, Route, RouteResponse } from "../server.js";

export const SHAREPOINT_BROWSE_PATH =
  "/v1/tenants/:tenantId/sharepoint/sites/:siteId/browse";

export const SHAREPOINT_READ_PERMISSION = "sharepoint.read";
export const SHAREPOINT_BROWSE_UNAUTHENTICATED = "request.unauthenticated";

export type SharePointPrincipalType =
  | "user"
  | "siteUser"
  | "group"
  | "application"
  | "device"
  | "link";

export interface SharePointSiteLibrary {
  readonly id: string;
  readonly name: string;
  readonly webUrl: string;
  readonly driveType: string;
  readonly quotaUsedBytes: number | null;
  readonly quotaTotalBytes: number | null;
}

export interface SharePointSiteBrowserItem {
  readonly id: string;
  readonly name: string;
  readonly webUrl: string;
  readonly libraryId: string;
  readonly libraryName: string;
  readonly isFolder: boolean;
  readonly sizeBytes: number | null;
  readonly lastModifiedDateTime: string | null;
}

export interface SharePointSitePermission {
  readonly id: string;
  readonly roles: readonly string[];
  readonly principalType: SharePointPrincipalType;
  readonly displayName: string;
  readonly email: string;
  readonly loginName: string;
  readonly userType: string;
  readonly external: boolean;
  readonly linkType: string;
}

export interface SharePointSiteExternalUser {
  readonly displayName: string;
  readonly email: string;
  readonly loginName: string;
  readonly principalType: SharePointPrincipalType;
  readonly permissionId: string;
  readonly roles: readonly string[];
}

export interface SharePointBrowserHandoff {
  readonly permissionEdits: false;
  readonly sharingPermissionsPath: string;
  readonly externalUsersPath: string;
  readonly sharingLinksRemovePath: string;
}

export interface SharePointSiteBrowser {
  readonly tenantId: string;
  readonly siteId: string;
  readonly siteUrl: string;
  readonly adminCenterUrl: string;
  readonly libraries: readonly SharePointSiteLibrary[];
  readonly items: readonly SharePointSiteBrowserItem[];
  readonly permissions: readonly SharePointSitePermission[];
  readonly externalUsers: readonly SharePointSiteExternalUser[];
  readonly handoff: SharePointBrowserHandoff;
}

export interface SharePointBrowseProvider {
  browseSite(tenantId: string, siteId: string): Promise<SharePointSiteBrowser>;
}

export interface SharePointBrowseCaller extends Caller {
  readonly userId?: string;
}

export type SharePointBrowseAuthorizer = (
  caller: SharePointBrowseCaller,
  permission: string,
) => void | Promise<void>;

export interface SharePointBrowseRouteOptions {
  readonly provider: SharePointBrowseProvider;
  readonly resolveCaller: (ctx: RequestContext) => SharePointBrowseCaller | undefined;
  readonly authorize?: SharePointBrowseAuthorizer;
}

export const SHAREPOINT_BROWSE_OPENAPI = {
  paths: {
    "/tenants/{tenantId}/sharepoint/sites/{siteId}/browse": {
      get: {
        operationId: "browseSharePointSite",
        summary:
          "Browse a site's libraries, items, permissions, and external users; permission changes are handed to EPIC-027",
        permission: SHAREPOINT_READ_PERMISSION,
        security: [{ bearerAuth: [] }],
        parameters: [
          { name: "tenantId", in: "path", required: true, schema: { type: "string" } },
          { name: "siteId", in: "path", required: true, schema: { type: "string" } },
        ],
        responses: {
          "200": { description: "Read-only site browser data." },
          "401": { description: "Authentication required." },
          "403": {
            description:
              "The caller lacks sharepoint.read or the tenant is outside the caller scope.",
          },
        },
      },
    },
  },
} as const;

function unauthenticatedError(): AppError {
  return new AppError(SHAREPOINT_BROWSE_UNAUTHENTICATED, "authentication required", 401);
}

function requireCaller(
  resolveCaller: (ctx: RequestContext) => SharePointBrowseCaller | undefined,
  ctx: RequestContext,
): SharePointBrowseCaller {
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
  options: SharePointBrowseRouteOptions,
  caller: SharePointBrowseCaller,
): Promise<void> {
  if (options.authorize) {
    await options.authorize(caller, SHAREPOINT_READ_PERMISSION);
  } else {
    const permissions = caller.permissions ?? [];
    if (!permissions.includes(SHAREPOINT_READ_PERMISSION) && !permissions.includes("*")) {
      throw new AppError(ErrorCodes.forbidden, "forbidden: missing sharepoint.read", 403);
    }
  }
}

export function createSharePointBrowseRoute(options: SharePointBrowseRouteOptions): Route {
  return {
    method: "GET",
    path: SHAREPOINT_BROWSE_PATH,
    handler: async (ctx: RequestContext): Promise<RouteResponse> => {
      const caller = requireCaller(options.resolveCaller, ctx);
      const tenantId = requireParam(ctx, "tenantId");
      const siteId = requireParam(ctx, "siteId");

      requireTenantInScope(caller, tenantId);
      await authorizeRead(options, caller);

      const browser = await options.provider.browseSite(tenantId, siteId);

      return {
        status: 200,
        headers: { "content-type": "application/json" },
        body: browser,
      };
    },
  };
}
