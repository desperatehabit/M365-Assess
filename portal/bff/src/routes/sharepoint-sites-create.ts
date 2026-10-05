// SharePoint site create API (EPIC-025 SPEC.md §4.1, §6, §7, §8, §11 item 3; T-0484).
// Exposes POST /v1/tenants/:tenantId/sharepoint/sites for single and bulk (CSV) creation
// with type, owners, template, and sharing settings. Every write routes through EPIC-006
// remediation semantics: preview plans without writing, applies return per-row results
// with an audit event per created site, and a partial success is always explicit.
import { AppError, ErrorCodes } from "../errors.js";
import { requireTenantInScope, type Caller } from "../rbac/authorize.js";
import type { RequestContext, Route, RouteResponse } from "../server.js";

export const SHAREPOINT_SITES_BASE_PATH = "/v1/tenants/:tenantId/sharepoint/sites";

export const SHAREPOINT_WRITE_PERMISSION = "SharePoint.Site.ReadWrite";
export const REMEDIATION_APPLY_PERMISSION = "Remediation.Apply";
export const SHAREPOINT_SITES_UNAUTHENTICATED = "request.unauthenticated";

export const SHAREPOINT_SITE_TYPES = ["team", "communication"] as const;
export const SHAREPOINT_SHARING_OPTIONS = [
  "disabled",
  "externalUserSharingOnly",
  "externalUserAndGuestSharing",
] as const;
export const MAX_SHAREPOINT_BULK_SITES = 200;

export type SharePointSiteType = (typeof SHAREPOINT_SITE_TYPES)[number];
export type SharePointSharing = (typeof SHAREPOINT_SHARING_OPTIONS)[number];

/**
 * OpenAPI request description for POST /v1/tenants/{id}/sharepoint/sites.
 * Documents the bulk CSV schema fixed in T-0484 (SPEC §11 item 3) so the
 * portal.v1.yaml entry can reference it verbatim.
 */
export const SHAREPOINT_SITES_CREATE_DESCRIPTION = [
  "Create one SharePoint site or bulk-create sites from CSV.",
  "Single create body: { name, alias, type (team|communication), owners (UPN array), template? (SharePointTemplate id or name), sharing? (disabled|externalUserSharingOnly|externalUserAndGuestSharing), preview? }.",
  "Bulk create body: { sites: [...] } with the same per-site fields, or { csv: string }.",
  "Bulk CSV schema (header row, one site per row): name, alias (the site URL slug),",
  "type (team|communication), owners (semicolon-separated UPNs), template (optional",
  "SharePointTemplate id or name), sharing",
  "(disabled|externalUserSharingOnly|externalUserAndGuestSharing).",
  "Unknown columns are ignored; a file missing a required column (name, alias, type,",
  "owners, sharing) is rejected before any write. Bulk results carry one entry per row;",
  "a partial success is reported per row, never silently.",
].join(" ");

export const SHAREPOINT_SITES_CREATE_OPENAPI = {
  method: "POST",
  path: "/tenants/{tenantId}/sharepoint/sites",
  description: SHAREPOINT_SITES_CREATE_DESCRIPTION,
} as const;

export interface CreateSharePointSiteInput {
  readonly name: string;
  readonly alias: string;
  readonly type: SharePointSiteType;
  readonly owners: readonly string[];
  readonly template?: string;
  readonly sharing: SharePointSharing;
  readonly preview?: boolean;
}

export interface SharePointSitePlan {
  readonly action: "create";
  readonly targetName: string;
  readonly diff: readonly string[];
  readonly valid: boolean;
  readonly dryRun: boolean;
}

export interface SharePointSiteAuditEvent {
  readonly id: string;
  readonly tenantId: string;
  readonly action: string;
  readonly targetId: string;
  readonly targetName: string;
  readonly timestamp: string;
}

export interface SharePointSiteResult {
  readonly success: boolean;
  readonly siteId: string | null;
  readonly plan: SharePointSitePlan;
  readonly auditEvent?: SharePointSiteAuditEvent;
}

export interface SharePointSiteRowResult {
  readonly row: number;
  readonly name: string;
  readonly alias: string;
  readonly status: "created" | "planned" | "failed";
  readonly siteId?: string | null;
  readonly error?: string | null;
}

export interface SharePointSitesBulkResult {
  readonly success: boolean;
  readonly total: number;
  readonly created: number;
  readonly failed: number;
  readonly results: readonly SharePointSiteRowResult[];
  readonly auditEvents?: readonly Record<string, unknown>[];
}

export interface SharePointSitesCreateProvider {
  createSite(tenantId: string, input: CreateSharePointSiteInput, preview: boolean): Promise<SharePointSiteResult | SharePointSitePlan>;
  createSitesBulk(
    tenantId: string,
    sites: readonly CreateSharePointSiteInput[],
    csv: string | undefined,
    preview: boolean,
  ): Promise<SharePointSitesBulkResult>;
}

export interface SharePointSitesCreateCaller extends Caller {
  readonly userId?: string;
}

export type SharePointSitesCreateAuthorizer = (
  caller: SharePointSitesCreateCaller,
  permission: string,
) => void | Promise<void>;

export interface SharePointSitesCreateRoutesOptions {
  readonly provider: SharePointSitesCreateProvider;
  readonly resolveCaller: (ctx: RequestContext) => SharePointSitesCreateCaller | undefined;
  readonly authorize?: SharePointSitesCreateAuthorizer;
}

function unauthenticatedError(): AppError {
  return new AppError(SHAREPOINT_SITES_UNAUTHENTICATED, "authentication required", 401);
}

function validationError(message: string, field: string): AppError {
  return new AppError(ErrorCodes.validationFailed, message, 400, [
    { field, reason: "invalid" },
  ]);
}

function requireCaller(
  resolveCaller: (ctx: RequestContext) => SharePointSitesCreateCaller | undefined,
  ctx: RequestContext,
): SharePointSitesCreateCaller {
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

async function authorizeRoute(
  options: SharePointSitesCreateRoutesOptions,
  caller: SharePointSitesCreateCaller,
): Promise<void> {
  if (options.authorize) {
    await options.authorize(caller, SHAREPOINT_WRITE_PERMISSION);
  } else {
    const permissions = caller.permissions ?? [];
    if (!permissions.includes(SHAREPOINT_WRITE_PERMISSION) && !permissions.includes("*")) {
      throw new AppError(ErrorCodes.forbidden, "forbidden: missing SharePoint.Site.ReadWrite", 403);
    }
  }
}

async function authorizeApply(
  options: SharePointSitesCreateRoutesOptions,
  caller: SharePointSitesCreateCaller,
): Promise<void> {
  if (options.authorize) {
    await options.authorize(caller, REMEDIATION_APPLY_PERMISSION);
  } else {
    const permissions = caller.permissions ?? [];
    if (!permissions.includes(REMEDIATION_APPLY_PERMISSION) && !permissions.includes("*")) {
      throw new AppError(ErrorCodes.forbidden, "forbidden: missing Remediation.Apply", 403);
    }
  }
}

const UPN_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const ALIAS_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;

export function validateSharePointSiteInput(value: unknown): { valid: boolean; error?: string; field?: string } {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return { valid: false, error: "site must be an object", field: "site" };
  }
  const site = value as Record<string, unknown>;
  if (typeof site["name"] !== "string" || site["name"].trim().length === 0) {
    return { valid: false, error: "name is required", field: "name" };
  }
  if (typeof site["alias"] !== "string" || site["alias"].trim().length === 0) {
    return { valid: false, error: "alias is required", field: "alias" };
  }
  if (!ALIAS_PATTERN.test(site["alias"].trim())) {
    return { valid: false, error: "alias must be a valid site URL slug", field: "alias" };
  }
  if (typeof site["type"] !== "string" || !(SHAREPOINT_SITE_TYPES as readonly string[]).includes(site["type"].trim().toLowerCase())) {
    return { valid: false, error: "type must be team or communication", field: "type" };
  }
  const owners = site["owners"];
  const ownerList = Array.isArray(owners) ? owners.map((o) => String(o).trim()).filter(Boolean) : [];
  if (ownerList.length === 0) {
    return { valid: false, error: "owners must be a non-empty array of owner UPNs", field: "owners" };
  }
  for (const owner of ownerList) {
    if (!UPN_PATTERN.test(owner)) {
      return { valid: false, error: `owner '${owner}' is not a valid UPN`, field: "owners" };
    }
  }
  if (site["sharing"] !== undefined && !(SHAREPOINT_SHARING_OPTIONS as readonly string[]).includes(String(site["sharing"]).trim())) {
    return {
      valid: false,
      error: "sharing must be disabled, externalUserSharingOnly, or externalUserAndGuestSharing",
      field: "sharing",
    };
  }
  return { valid: true };
}

function toCreateInput(site: Record<string, unknown>, preview: boolean): CreateSharePointSiteInput {
  const owners = (site["owners"] as unknown[]).map((o) => String(o).trim()).filter(Boolean);
  return {
    name: (site["name"] as string).trim(),
    alias: (site["alias"] as string).trim(),
    type: (site["type"] as string).trim().toLowerCase() as SharePointSiteType,
    owners,
    ...(typeof site["template"] === "string" && site["template"].trim() ? { template: site["template"].trim() } : {}),
    sharing: (typeof site["sharing"] === "string" && site["sharing"].trim()
      ? site["sharing"].trim()
      : "disabled") as SharePointSharing,
    preview,
  };
}

export function createSharePointSitesCreateRoutes(options: SharePointSitesCreateRoutesOptions): Route[] {
  return [
    {
      method: "POST",
      path: SHAREPOINT_SITES_BASE_PATH,
      handler: async (ctx: RequestContext): Promise<RouteResponse> => {
        const caller = requireCaller(options.resolveCaller, ctx);
        const tenantId = requireTenantParam(ctx);
        requireTenantInScope(caller, tenantId);
        await authorizeRoute(options, caller);

        const body = (ctx.body ?? {}) as Record<string, unknown>;
        const isPreview = Boolean(body.preview || ctx.query.get("preview") === "true");
        if (!isPreview) {
          await authorizeApply(options, caller);
        }

        if (typeof body["csv"] === "string" || Array.isArray(body["sites"])) {
          if (typeof body["csv"] === "string") {
            if (body["csv"].trim().length === 0) {
              throw validationError("csv must not be empty", "csv");
            }
            const result = await options.provider.createSitesBulk(tenantId, [], body["csv"], isPreview);
            return { status: 200, headers: { "content-type": "application/json" }, body: result };
          }
          const rawSites = body["sites"] as unknown[];
          if (rawSites.length === 0) {
            throw validationError("sites must be a non-empty array", "sites");
          }
          if (rawSites.length > MAX_SHAREPOINT_BULK_SITES) {
            throw validationError(`at most ${MAX_SHAREPOINT_BULK_SITES} sites per bulk create`, "sites");
          }
          const sites = rawSites.map((entry, index) => {
            const check = validateSharePointSiteInput(entry);
            if (!check.valid) {
              throw validationError(`sites[${index}]: ${check.error}`, check.field ?? "sites");
            }
            return toCreateInput(entry as Record<string, unknown>, isPreview);
          });
          const result = await options.provider.createSitesBulk(tenantId, sites, undefined, isPreview);
          return { status: 200, headers: { "content-type": "application/json" }, body: result };
        }

        const check = validateSharePointSiteInput(body);
        if (!check.valid) {
          throw validationError(check.error ?? "invalid site", check.field ?? "site");
        }
        const input = toCreateInput(body, isPreview);
        const result = await options.provider.createSite(tenantId, input, isPreview);
        return {
          status: isPreview ? 200 : 201,
          headers: { "content-type": "application/json" },
          body: result,
        };
      },
    },
  ];
}
