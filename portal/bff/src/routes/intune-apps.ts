// Intune app list API (EPIC-017 SPEC.md §3.1, §6, §7, §11; T-0321).
//
// Exposes GET /v1/tenants/:tenantId/apps
//   ?view=catalog  (default) — the app catalog: name, type, platform, assigned count,
//                  publishing state, last modified. v1 lists Win32 and Store apps; the
//                  tenant's apps of other types are counted in `unsupported`, not dropped.
//   ?view=detected — Graph discovered apps on managed devices (§11.4), read live.
//
// An unknown `type` returns 400; a known-but-unsupported `type` returns 501.
// Requires RBAC `Endpoint.Application.Read` and the tenant in caller scope (T-0013).
import { AppError, ErrorCodes } from "../errors.js";
import { parsePagination } from "../pagination.js";
import { requireTenantInScope, type Caller } from "../rbac/authorize.js";
import type { RequestContext, Route, RouteResponse } from "../server.js";
import { isKnownAppType, lookupAppType, supportedAppTypes } from "../domain/intune-app-types.js";

export const INTUNE_APPS_PATH = "/v1/tenants/:tenantId/apps";
export const INTUNE_APPS_READ_PERMISSION = "Endpoint.Application.Read";
export const INTUNE_APPS_WRITE_PERMISSION = "Endpoint.Application.ReadWrite";
export const INTUNE_APPS_UNAUTHENTICATED = "request.unauthenticated";

export type IntuneAppsView = "catalog" | "detected";
const VIEWS: readonly IntuneAppsView[] = ["catalog", "detected"];

export interface IntuneAppItem {
  readonly id: string;
  readonly displayName: string;
  /** Registry type (win32, store, …), or "other" when no entry claims the Graph type. */
  readonly appType: string;
  /** The Graph `@odata.type` the row came from. */
  readonly odataType: string;
  readonly platform: string;
  readonly publisher: string | null;
  /** Number of assignment targets. */
  readonly assignedCount: number;
  /** Graph publishingState: notPublished, processing, or published. */
  readonly publishingState: string | null;
  readonly lastModifiedDateTime: string | null;
}

export interface DetectedAppItem {
  readonly id: string;
  readonly displayName: string;
  readonly version: string | null;
  readonly publisher: string | null;
  readonly platform: string | null;
  readonly deviceCount: number;
  readonly sizeInByte: number | null;
}

/** Tenant apps the v1 catalog does not list, counted by type so they are never silently lost. */
export interface UnsupportedAppCount {
  readonly appType: string;
  readonly count: number;
}

export interface IntuneAppsFilter {
  readonly view: IntuneAppsView;
  /** Restrict the catalog to one supported type; undefined lists every supported type. */
  readonly appType?: string;
  readonly assigned?: boolean;
  readonly search?: string;
  readonly cursor: string | null;
  readonly limit: number;
}

export interface IntuneAppsCatalogPage {
  readonly tenantId: string;
  readonly view: "catalog";
  readonly totalCount: number;
  readonly items: readonly IntuneAppItem[];
  readonly unsupported: readonly UnsupportedAppCount[];
  readonly nextCursor: string | null;
}

export interface IntuneAppsDetectedPage {
  readonly tenantId: string;
  readonly view: "detected";
  readonly totalCount: number;
  readonly items: readonly DetectedAppItem[];
  readonly nextCursor: string | null;
}

export type IntuneAppsPage = IntuneAppsCatalogPage | IntuneAppsDetectedPage;

export interface IntuneAppsProvider {
  listApps(tenantId: string, filter: IntuneAppsFilter): Promise<IntuneAppsPage>;
}

export interface IntuneAppsCaller extends Caller {
  readonly userId?: string;
  readonly permissions?: readonly string[];
}

export type IntuneAppsAuthorizer = (
  caller: IntuneAppsCaller,
  permission: string,
) => void | Promise<void>;

export interface IntuneAppsRoutesOptions {
  readonly provider: IntuneAppsProvider;
  readonly resolveCaller: (ctx: RequestContext) => IntuneAppsCaller | undefined;
  readonly authorize?: IntuneAppsAuthorizer;
}

function requireCaller(options: IntuneAppsRoutesOptions, ctx: RequestContext): IntuneAppsCaller {
  const caller = options.resolveCaller(ctx);
  if (caller === undefined) {
    throw new AppError(INTUNE_APPS_UNAUTHENTICATED, "authentication required", 401);
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

async function authorizeRead(options: IntuneAppsRoutesOptions, caller: IntuneAppsCaller): Promise<void> {
  if (options.authorize) {
    await options.authorize(caller, INTUNE_APPS_READ_PERMISSION);
    return;
  }
  const permissions = caller.permissions ?? [];
  const allowed =
    permissions.includes(INTUNE_APPS_READ_PERMISSION) ||
    permissions.includes(INTUNE_APPS_WRITE_PERMISSION) ||
    permissions.includes("*");
  if (!allowed) {
    throw new AppError(ErrorCodes.forbidden, `forbidden: missing ${INTUNE_APPS_READ_PERMISSION}`, 403);
  }
}

function optionalText(query: URLSearchParams, name: string): string | undefined {
  const value = query.get(name);
  if (value === null || value.trim().length === 0) return undefined;
  return value.trim();
}

function parseView(query: URLSearchParams): IntuneAppsView {
  const raw = optionalText(query, "view")?.toLowerCase() ?? "catalog";
  if (!(VIEWS as readonly string[]).includes(raw)) {
    throw new AppError(ErrorCodes.validationFailed, `unknown view '${raw}'; supported: ${VIEWS.join(", ")}`, 400, [
      { field: "view", reason: "unknown" },
    ]);
  }
  return raw as IntuneAppsView;
}

function parseAppType(query: URLSearchParams, view: IntuneAppsView): string | undefined {
  const raw = optionalText(query, "type")?.toLowerCase();
  if (raw === undefined) return undefined;
  if (view === "detected") {
    throw new AppError(ErrorCodes.validationFailed, "type does not apply to the detected view", 400, [
      { field: "type", reason: "not-applicable" },
    ]);
  }
  if (!isKnownAppType(raw)) {
    throw new AppError(ErrorCodes.validationFailed, `unknown app type '${raw}'`, 400, [
      { field: "type", reason: "unknown" },
    ]);
  }
  if (!lookupAppType(raw)!.supported) {
    throw new AppError(
      "intune.app-type.unsupported",
      `app type '${raw}' is not yet supported; supported types in v1: ${supportedAppTypes().join(", ")}`,
      501,
    );
  }
  return raw;
}

function parseAssigned(query: URLSearchParams): boolean | undefined {
  const raw = optionalText(query, "assigned")?.toLowerCase();
  if (raw === undefined) return undefined;
  if (raw !== "true" && raw !== "false") {
    throw new AppError(ErrorCodes.validationFailed, "assigned must be true or false", 400, [
      { field: "assigned", reason: "invalid" },
    ]);
  }
  return raw === "true";
}

export function parseIntuneAppsFilter(query: URLSearchParams): IntuneAppsFilter {
  const view = parseView(query);
  const pagination = parsePagination(query);
  return {
    view,
    appType: parseAppType(query, view),
    assigned: parseAssigned(query),
    search: optionalText(query, "search"),
    cursor: pagination.cursor,
    limit: pagination.limit,
  };
}

export function createIntuneAppsRoutes(options: IntuneAppsRoutesOptions): Route[] {
  return [
    {
      method: "GET",
      path: INTUNE_APPS_PATH,
      handler: async (ctx: RequestContext): Promise<RouteResponse> => {
        const caller = requireCaller(options, ctx);
        const tenantId = requireTenantParam(ctx);
        requireTenantInScope(caller, tenantId);
        await authorizeRead(options, caller);

        const filter = parseIntuneAppsFilter(ctx.query);
        const page = await options.provider.listApps(tenantId, filter);
        return { status: 200, body: page };
      },
    },
  ];
}
