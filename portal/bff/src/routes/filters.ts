// Filter policy read (EPIC-022 SPEC.md §2 US-1, §3.1, §5, §6; T-0421).
// Exposes GET /v1/tenants/:tenantId/filters/:filterType serving the §3.1
// table — name, priority, state, key settings summary, last modified — for
// spam, anti-phish, malware, and connection filter policies. Policies are
// read live from EXO and never persisted: the injected provider is backed by
// the worker queue (T-0010) running the Get-Filters child job, so this module
// holds no M365 SDK call and issues no tenant write. Reads require
// `spam.read` (SPEC §7) intersected with the caller tenant scope.
import { AppError, ErrorCodes } from "../errors.js";
import { requireTenantInScope, type Caller } from "../rbac/authorize.js";
import type { RequestContext, Route, RouteResponse } from "../server.js";

export const FILTERS_PATH = "/v1/tenants/:tenantId/filters/:filterType";
export const FILTERS_READ_PERMISSION = "spam.read";
export const FILTERS_UNAUTHENTICATED = "request.unauthenticated";
export const FILTER_INVALID_TYPE = "filters.invalid_type";

export const FILTER_TYPES = ["spam", "antiphish", "malware", "connection"] as const;

export type FilterType = (typeof FILTER_TYPES)[number];

export interface FilterItem {
  readonly name: string;
  readonly priority: number | null;
  readonly state: string;
  readonly summary: string;
  readonly lastModified: string | null;
}

export interface FiltersPage {
  readonly tenantId: string;
  readonly filterType: FilterType;
  readonly items: readonly FilterItem[];
  readonly totalCount: number;
  readonly retrievedAt: string;
}

// Queue-backed seam for the filter reads: the production wiring enqueues a
// get-filters worker job for (tenantId, filterType) and serves the worker
// result. Depending on the seam keeps EXO and process code out of the BFF.
export interface FiltersProvider {
  getFilters(tenantId: string, filterType: FilterType): Promise<FiltersPage>;
}

export interface FiltersCaller extends Caller {
  readonly userId?: string;
}

export type FiltersAuthorizer = (
  caller: FiltersCaller,
  permission: string,
) => void | Promise<void>;

export interface FiltersRouteOptions {
  readonly provider: FiltersProvider;
  readonly resolveCaller: (ctx: RequestContext) => FiltersCaller | undefined;
  readonly authorize?: FiltersAuthorizer;
}

function unauthenticatedError(): AppError {
  return new AppError(FILTERS_UNAUTHENTICATED, "authentication required", 401);
}

function validationError(message: string, field: string): AppError {
  return new AppError(ErrorCodes.validationFailed, message, 400, [
    { field, reason: "invalid" },
  ]);
}

function requireCaller(
  resolveCaller: (ctx: RequestContext) => FiltersCaller | undefined,
  ctx: RequestContext,
): FiltersCaller {
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

export function parseFilterType(value: unknown): FilterType {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new AppError(FILTER_INVALID_TYPE, "filterType is required", 400, [
      { field: "filterType", reason: "required" },
    ]);
  }
  const normalized = value.trim().toLowerCase().replace(/-/g, "");
  if (!(FILTER_TYPES as readonly string[]).includes(normalized)) {
    throw validationError(
      `filterType must be one of: spam, antiphish, malware, connection`,
      "filterType",
    );
  }
  return normalized as FilterType;
}

export async function getFilters(
  provider: FiltersProvider,
  tenantId: string,
  filterType: FilterType,
): Promise<{ status: number; body: FiltersPage }> {
  if (tenantId.trim().length === 0) {
    throw new AppError(ErrorCodes.validationFailed, "tenantId is required", 400, [
      { field: "tenantId", reason: "required" },
    ]);
  }
  const page = await provider.getFilters(tenantId, filterType);
  return {
    status: 200,
    body: {
      tenantId,
      filterType,
      items: [...page.items],
      totalCount: page.totalCount,
      retrievedAt: page.retrievedAt,
    },
  };
}

export function createFilterRoutes(options: FiltersRouteOptions): Route[] {
  const listHandler = async (ctx: RequestContext): Promise<RouteResponse> => {
    const caller = requireCaller(options.resolveCaller, ctx);
    const tenantId = requireTenantParam(ctx);
    const filterType = parseFilterType(ctx.params["filterType"]);

    requireTenantInScope(caller, tenantId);

    if (options.authorize) {
      await options.authorize(caller, FILTERS_READ_PERMISSION);
    } else {
      const permissions = caller.permissions ?? [];
      if (!permissions.includes(FILTERS_READ_PERMISSION) && !permissions.includes("*")) {
        throw new AppError(ErrorCodes.forbidden, "forbidden: missing spam.read", 403);
      }
    }

    const result = await getFilters(options.provider, tenantId, filterType);

    return {
      status: result.status,
      headers: { "content-type": "application/json" },
      body: result.body,
    };
  };
  return [{ method: "GET", path: FILTERS_PATH, handler: listHandler }];
}

// Route modules own their OpenAPI path items (portal.v1.yaml `paths` is empty
// by design); a wiring ticket merges this fragment into the served document.
export const FILTERS_OPENAPI = {
  paths: {
    "/tenants/{tenantId}/filters/{filterType}": {
      get: {
        operationId: "getFilters",
        summary: "Filter policies (spam/antiphish/malware/connection) with name, priority, state, key settings summary, last modified",
        permission: FILTERS_READ_PERMISSION,
        security: [{ bearerAuth: [] }],
        parameters: [
          { name: "tenantId", in: "path", required: true, schema: { type: "string" } },
          {
            name: "filterType",
            in: "path",
            required: true,
            schema: { type: "string", enum: ["spam", "antiphish", "malware", "connection"] },
          },
        ],
        responses: {
          "200": { description: "Filter policies with the §3.1 columns, read live from EXO." },
          "400": { description: "An unknown filter type was supplied." },
          "401": { description: "Authentication required." },
          "403": { description: "The caller lacks spam.read or the tenant is out of scope." },
        },
      },
    },
  },
} as const;
