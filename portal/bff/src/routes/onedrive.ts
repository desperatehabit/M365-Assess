// OneDrive usage API (EPIC-025 SPEC.md §2 US-6, §3.5, §6, §7; T-0489).
// Exposes GET /v1/tenants/:tenantId/onedrive behind RBAC SharePoint.Site.Read.
// Read-only: per-user OneDrive usage and sharing state, cursor-paginated.
// Bulk sharing-link removal is handed to EPIC-027
// (POST /v1/tenants/{id}/sharing/links/remove); this route performs no writes.
import { AppError, ErrorCodes } from "../errors.js";
import { requireTenantInScope, type Caller } from "../rbac/authorize.js";
import { paginate, parsePagination } from "../pagination.js";
import type { RequestContext, Route, RouteResponse } from "../server.js";

export const ONEDRIVE_PATH = "/v1/tenants/:tenantId/onedrive";

export const SHAREPOINT_READ_PERMISSION = "SharePoint.Site.Read";
export const ONEDRIVE_UNAUTHENTICATED = "request.unauthenticated";

export interface OneDriveSharingLinkRef {
  readonly linkId: string;
  readonly linkType: string;
  readonly resourceName: string;
  readonly driveId: string;
  readonly itemId: string;
}

export interface OneDriveSharingState {
  readonly total: number;
  readonly anonymous: number;
  readonly organization: number;
  readonly user: number;
}

export interface OneDriveUserUsage {
  readonly userId: string;
  readonly displayName: string;
  readonly userPrincipalName: string;
  readonly hasOneDrive: boolean;
  readonly storageUsedBytes: number | null;
  readonly storageQuotaBytes: number | null;
  readonly storageUsedPercent: number | null;
  readonly lastActivityDate: string | null;
  readonly sharing: OneDriveSharingState;
  readonly sharingLinks: readonly OneDriveSharingLinkRef[];
}

export interface OneDriveUsageSummary {
  readonly totalUsers: number;
  readonly usersWithOneDrive: number;
  readonly totalStorageUsedBytes: number;
  readonly totalStorageQuotaBytes: number;
  readonly usersOverQuotaWarning: number;
  readonly totalSharingLinks: number;
  readonly anonymousLinks: number;
  readonly organizationLinks: number;
  readonly userLinks: number;
}

export interface OneDriveUsageReport {
  readonly tenantId: string;
  readonly generatedAt: string;
  readonly summary: OneDriveUsageSummary;
  readonly users: readonly OneDriveUserUsage[];
}

export interface OneDriveUsageProvider {
  getUsage(tenantId: string): Promise<OneDriveUsageReport>;
}

export interface OneDriveUsageCaller extends Caller {
  readonly userId?: string;
}

export type OneDriveUsageAuthorizer = (
  caller: OneDriveUsageCaller,
  permission: string,
) => void | Promise<void>;

export interface OneDriveUsageRoutesOptions {
  readonly provider: OneDriveUsageProvider;
  readonly resolveCaller: (ctx: RequestContext) => OneDriveUsageCaller | undefined;
  readonly authorize?: OneDriveUsageAuthorizer;
}

function unauthenticatedError(): AppError {
  return new AppError(ONEDRIVE_UNAUTHENTICATED, "authentication required", 401);
}

function requireCaller(
  resolveCaller: (ctx: RequestContext) => OneDriveUsageCaller | undefined,
  ctx: RequestContext,
): OneDriveUsageCaller {
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
  options: OneDriveUsageRoutesOptions,
  caller: OneDriveUsageCaller,
): Promise<void> {
  if (options.authorize) {
    await options.authorize(caller, SHAREPOINT_READ_PERMISSION);
  } else {
    const permissions = caller.permissions ?? [];
    if (!permissions.includes(SHAREPOINT_READ_PERMISSION) && !permissions.includes("*")) {
      throw new AppError(ErrorCodes.forbidden, "forbidden: missing SharePoint.Site.Read", 403);
    }
  }
}

export function createOneDriveUsageRoutes(options: OneDriveUsageRoutesOptions): Route[] {
  return [
    {
      method: "GET",
      path: ONEDRIVE_PATH,
      handler: async (ctx: RequestContext): Promise<RouteResponse> => {
        const caller = requireCaller(options.resolveCaller, ctx);
        const tenantId = requireParam(ctx, "tenantId");

        requireTenantInScope(caller, tenantId);
        await authorizeRead(options, caller);

        const report = await options.provider.getUsage(tenantId);
        const page = paginate(report.users, parsePagination(ctx.query));
        return {
          status: 200,
          headers: { "content-type": "application/json" },
          body: page,
        };
      },
    },
  ];
}

// Route modules own their OpenAPI path items (portal.v1.yaml `paths` is empty
// by design); a wiring ticket merges this fragment into the served document.
export const ONEDRIVE_OPENAPI = {
  paths: {
    "/tenants/{tenantId}/onedrive": {
      get: {
        operationId: "getOneDriveUsage",
        summary:
          "Per-user OneDrive usage and sharing state, cursor-paginated; bulk sharing-link removal is handed to EPIC-027",
        permission: SHAREPOINT_READ_PERMISSION,
        security: [{ bearerAuth: [] }],
        parameters: [
          { name: "tenantId", in: "path", required: true, schema: { type: "string" } },
          { name: "cursor", in: "query", required: false, schema: { type: "string" } },
          {
            name: "limit",
            in: "query",
            required: false,
            schema: { type: "integer", minimum: 1, maximum: 1000, default: 100 },
          },
        ],
        responses: {
          "200": { description: "Cursor-paginated per-user OneDrive usage and sharing state." },
          "401": { description: "Authentication required." },
          "403": { description: "The caller lacks SharePoint.Site.Read or the tenant is out of scope." },
        },
      },
    },
  },
} as const;
