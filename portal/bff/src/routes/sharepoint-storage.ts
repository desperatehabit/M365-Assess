// SharePoint storage and version cleanup API (EPIC-025 SPEC.md §3.3, §4.2, §6, §7, §8, §9, §11 item 2; T-0487).
// Exposes:
//   GET  /v1/tenants/:tenantId/sharepoint/sites/:siteId/storage — storage composition
//   POST /v1/tenants/:tenantId/sharepoint/sites/:siteId/versions/cleanup — version cleanup
// The GET requires RBAC SharePoint.Site.Read. The POST requires SharePoint.Cleanup.ReadWrite;
// apply (non-preview) additionally requires Remediation.Apply and a confirmation
// count. The route makes no Graph call itself: it hands the work to a provider
// that enqueues the workers.
import { AppError, ErrorCodes } from "../errors.js";
import { requireTenantInScope, type Caller } from "../rbac/authorize.js";
import type { RequestContext, Route, RouteResponse } from "../server.js";

export const SHAREPOINT_STORAGE_SITE_BASE_PATH = "/v1/tenants/:tenantId/sharepoint/sites/:siteId";
export const SHAREPOINT_STORAGE_PATH = `${SHAREPOINT_STORAGE_SITE_BASE_PATH}/storage`;
export const SHAREPOINT_VERSION_CLEANUP_PATH = `${SHAREPOINT_STORAGE_SITE_BASE_PATH}/versions/cleanup`;

export const SHAREPOINT_READ_PERMISSION = "SharePoint.Site.Read";
export const SHAREPOINT_CLEANUP_PERMISSION = "SharePoint.Cleanup.ReadWrite";
export const REMEDIATION_APPLY_PERMISSION = "Remediation.Apply";
export const SHAREPOINT_STORAGE_UNAUTHENTICATED = "request.unauthenticated";

export const DEFAULT_AGE_THRESHOLD_DAYS = 90;
export const MAX_AGE_THRESHOLD_DAYS = 3650;

export interface SiteStorageComposition {
  readonly tenantId: string;
  readonly siteId: string;
  readonly documentsBytes: number;
  readonly versionsBytes: number;
  readonly recycleBinBytes: number;
  readonly reclaimableBytes: number;
  readonly totalBytes: number;
  readonly generatedAt: string;
}

export interface VersionCleanupPlanEntry {
  readonly versionId: string;
  readonly itemId: string;
  readonly size: number;
  readonly lastModified: string;
  readonly isCurrent: boolean;
  readonly selected: boolean;
  readonly reason: string | null;
}

export interface VersionCleanupPlan {
  readonly jobId: string;
  readonly tenantId: string;
  readonly siteId: string;
  readonly mode: "plan";
  readonly state: "planned";
  readonly ageThresholdDays: number;
  readonly cutoffDate: string;
  readonly versions: readonly VersionCleanupPlanEntry[];
  readonly selectedCount: number;
  readonly reclaimableBytes: number;
  readonly writes: false;
}

export interface VersionCleanupResultRow {
  readonly versionId: string;
  readonly state: string;
  readonly before: unknown;
  readonly after: unknown;
  readonly appliedAt: string | null;
  readonly actor: string;
  readonly error: string | null;
}

export interface VersionCleanupSummary {
  readonly total: number;
  readonly removed: number;
  readonly failed: number;
  readonly skipped: number;
}

export interface VersionCleanupApply {
  readonly jobId: string;
  readonly tenantId: string;
  readonly siteId: string;
  readonly mode: "apply";
  readonly state: string;
  readonly ageThresholdDays: number;
  readonly cutoffDate: string;
  readonly results: readonly VersionCleanupResultRow[];
  readonly auditEvents: readonly Record<string, unknown>[];
  readonly summary: VersionCleanupSummary;
}

export interface VersionCleanupInput {
  readonly preview?: boolean;
  readonly ageThresholdDays?: number;
  readonly includeVersions?: readonly string[];
  readonly excludeVersions?: readonly string[];
  readonly confirmCount?: number;
}

export interface SharePointStorageProvider {
  getSiteStorage(tenantId: string, siteId: string): Promise<SiteStorageComposition>;
  cleanupVersions(tenantId: string, siteId: string, input: VersionCleanupInput): Promise<VersionCleanupPlan | VersionCleanupApply>;
}

export interface SharePointStorageCaller extends Caller {
  readonly userId?: string;
}

export type SharePointStorageAuthorizer = (
  caller: SharePointStorageCaller,
  permission: string,
) => void | Promise<void>;

export interface SharePointStorageRoutesOptions {
  readonly provider: SharePointStorageProvider;
  readonly resolveCaller: (ctx: RequestContext) => SharePointStorageCaller | undefined;
  readonly authorize?: SharePointStorageAuthorizer;
}

function unauthenticatedError(): AppError {
  return new AppError(SHAREPOINT_STORAGE_UNAUTHENTICATED, "authentication required", 401);
}

function validationError(message: string, field: string): AppError {
  return new AppError(ErrorCodes.validationFailed, message, 400, [
    { field, reason: "invalid" },
  ]);
}

function requireCaller(
  resolveCaller: (ctx: RequestContext) => SharePointStorageCaller | undefined,
  ctx: RequestContext,
): SharePointStorageCaller {
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

function requireSiteParam(ctx: RequestContext): string {
  const value = ctx.params["siteId"];
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new AppError(ErrorCodes.validationFailed, "siteId is required", 400, [
      { field: "siteId", reason: "required" },
    ]);
  }
  return value.trim();
}

async function authorizePermission(
  options: SharePointStorageRoutesOptions,
  caller: SharePointStorageCaller,
  permission: string,
): Promise<void> {
  if (options.authorize) {
    await options.authorize(caller, permission);
  } else {
    const permissions = caller.permissions ?? [];
    if (!permissions.includes(permission) && !permissions.includes("*")) {
      throw new AppError(ErrorCodes.forbidden, `forbidden: missing ${permission}`, 403);
    }
  }
}

function parseAgeThresholdDays(value: unknown): number {
  if (value === undefined || value === null) {
    return DEFAULT_AGE_THRESHOLD_DAYS;
  }
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0 || parsed > MAX_AGE_THRESHOLD_DAYS) {
    throw validationError(
      `ageThresholdDays must be an integer between 0 and ${MAX_AGE_THRESHOLD_DAYS}`,
      "ageThresholdDays",
    );
  }
  return parsed;
}

function parseVersionIdList(value: unknown, field: string): string[] | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string")) {
    throw validationError(`${field} must be an array of version id strings`, field);
  }
  return value.map((entry) => entry as string);
}

function parseConfirmCount(value: unknown): number | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw validationError("confirmCount must be a non-negative integer", "confirmCount");
  }
  return parsed;
}

export function parseVersionCleanupInput(body: Record<string, unknown>): VersionCleanupInput {
  const preview = body["preview"];
  if (preview !== undefined && typeof preview !== "boolean") {
    throw validationError("preview must be a boolean", "preview");
  }
  const ageThresholdDays = parseAgeThresholdDays(body["ageThresholdDays"]);
  const includeVersions = parseVersionIdList(body["includeVersions"], "includeVersions");
  const excludeVersions = parseVersionIdList(body["excludeVersions"], "excludeVersions");
  const confirmCount = parseConfirmCount(body["confirmCount"]);
  return {
    ...(preview !== undefined ? { preview } : {}),
    ageThresholdDays,
    ...(includeVersions !== undefined ? { includeVersions } : {}),
    ...(excludeVersions !== undefined ? { excludeVersions } : {}),
    ...(confirmCount !== undefined ? { confirmCount } : {}),
  };
}

export function createSharePointStorageRoutes(options: SharePointStorageRoutesOptions): Route[] {
  return [
    {
      method: "GET",
      path: SHAREPOINT_STORAGE_PATH,
      handler: async (ctx: RequestContext): Promise<RouteResponse> => {
        const caller = requireCaller(options.resolveCaller, ctx);
        const tenantId = requireTenantParam(ctx);
        const siteId = requireSiteParam(ctx);

        requireTenantInScope(caller, tenantId);
        await authorizePermission(options, caller, SHAREPOINT_READ_PERMISSION);

        const composition = await options.provider.getSiteStorage(tenantId, siteId);
        return {
          status: 200,
          headers: { "content-type": "application/json" },
          body: composition,
        };
      },
    },
    {
      method: "POST",
      path: SHAREPOINT_VERSION_CLEANUP_PATH,
      handler: async (ctx: RequestContext): Promise<RouteResponse> => {
        const caller = requireCaller(options.resolveCaller, ctx);
        const tenantId = requireTenantParam(ctx);
        const siteId = requireSiteParam(ctx);

        requireTenantInScope(caller, tenantId);
        await authorizePermission(options, caller, SHAREPOINT_CLEANUP_PERMISSION);

        const body = (ctx.body ?? {}) as Record<string, unknown>;
        const input = parseVersionCleanupInput(body);
        const isPreview = input.preview === true;

        if (!isPreview) {
          await authorizePermission(options, caller, REMEDIATION_APPLY_PERMISSION);
          if (input.confirmCount === undefined) {
            throw validationError("confirmCount is required for apply", "confirmCount");
          }
        }

        const result = await options.provider.cleanupVersions(tenantId, siteId, input);
        return {
          status: 200,
          headers: { "content-type": "application/json" },
          body: result,
        };
      },
    },
  ];
}

// Route modules own their OpenAPI path items (portal.v1.yaml `paths` is empty
// by design); a wiring ticket merges this fragment into the served document.
export const SHAREPOINT_STORAGE_OPENAPI = {
  paths: {
    "/tenants/{tenantId}/sharepoint/sites/{siteId}/storage": {
      get: {
        operationId: "getSiteStorage",
        summary: "Storage composition: documents/versions/recycle-bin bytes and reclaimable total",
        permission: SHAREPOINT_READ_PERMISSION,
        security: [{ bearerAuth: [] }],
        parameters: [
          { name: "tenantId", in: "path", required: true, schema: { type: "string" } },
          { name: "siteId", in: "path", required: true, schema: { type: "string" } },
        ],
        responses: {
          "200": { description: "Storage composition for the site." },
          "401": { description: "Authentication required." },
          "403": { description: "The caller lacks SharePoint.Site.Read or the tenant is out of scope." },
        },
      },
    },
    "/tenants/{tenantId}/sharepoint/sites/{siteId}/versions/cleanup": {
      post: {
        operationId: "invokeVersionCleanup",
        summary:
          "Version cleanup: plan preview (age threshold + manual include/exclude override) or apply with confirmation",
        permission: SHAREPOINT_CLEANUP_PERMISSION,
        security: [{ bearerAuth: [] }],
        parameters: [
          { name: "tenantId", in: "path", required: true, schema: { type: "string" } },
          { name: "siteId", in: "path", required: true, schema: { type: "string" } },
        ],
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: {
                  preview: { type: "boolean", description: "When true, only preview the plan." },
                  ageThresholdDays: { type: "integer", minimum: 0, maximum: MAX_AGE_THRESHOLD_DAYS, default: DEFAULT_AGE_THRESHOLD_DAYS },
                  includeVersions: { type: "array", items: { type: "string" }, description: "Version IDs to always include." },
                  excludeVersions: { type: "array", items: { type: "string" }, description: "Version IDs to never include." },
                  confirmCount: { type: "integer", minimum: 0, description: "Required for apply; must equal the planned version count." },
                },
              },
            },
          },
        },
        responses: {
          "200": { description: "The cleanup plan or apply result." },
          "400": { description: "Invalid input or missing confirmation." },
          "401": { description: "Authentication required." },
          "403": { description: "The caller lacks SharePoint.Cleanup.ReadWrite or Remediation.Apply, or the tenant is out of scope." },
        },
      },
    },
  },
} as const;
