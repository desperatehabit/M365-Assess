// Purview DLP policy read API (EPIC-030 SPEC.md §2 US-1, §3.1, §6, §7; T-0582).
//
// Reads are served live from Purview through the injected provider, which is
// backed by the worker queue (get-purview-dlp.ps1 over the T-0582 Purview
// session seam); this module holds no Purview SDK call and issues no tenant
// write. The list route validates `purview.read` + tenant scope and returns the
// provider's cursor page; the detail route returns one policy. DLP change
// actions (edit/enable/disable/clone/delete) are deferred to their own gated
// tickets, so this module is read-only.
import { AppError, ErrorCodes } from "../errors.js";
import { parsePagination } from "../pagination.js";
import { requireTenantInScope, type Caller } from "../rbac/authorize.js";
import type { RequestContext, Route, RouteResponse } from "../server.js";

export const PURVIEW_DLP_PATH = "/v1/tenants/:tenantId/purview/dlp";
export const PURVIEW_DLP_ITEM_PATH = "/v1/tenants/:tenantId/purview/dlp/:policyId";

export const PURVIEW_READ_PERMISSION = "purview.read";

export const PURVIEW_DLP_UNAUTHENTICATED = "request.unauthenticated";
export const PURVIEW_DLP_NOT_FOUND = "dlp.not_found";

export interface PurviewDlpPolicy {
  readonly id: string;
  readonly name: string;
  readonly state: string;
  readonly locations: readonly string[];
  readonly rules: number;
  readonly lastModified: string | null;
  readonly retrievedAt?: string;
}

export interface PurviewDlpPage {
  readonly tenantId: string;
  readonly items: readonly PurviewDlpPolicy[];
  readonly nextCursor: string | null;
  readonly totalCount: number;
}

export interface PurviewDlpFilter {
  readonly search?: string;
  readonly state?: string;
  readonly limit?: number;
  readonly cursor?: string;
}

export interface PurviewDlpProvider {
  listPolicies(tenantId: string, filter?: PurviewDlpFilter): Promise<PurviewDlpPage>;
  getPolicy(tenantId: string, policyId: string): Promise<PurviewDlpPolicy | undefined>;
}

export interface PurviewDlpCaller extends Caller {
  readonly userId?: string;
}

export type PurviewDlpAuthorizer = (
  caller: PurviewDlpCaller,
  permission: string,
) => void | Promise<void>;

export interface PurviewDlpRouteOptions {
  readonly provider: PurviewDlpProvider;
  readonly resolveCaller: (ctx: RequestContext) => PurviewDlpCaller | undefined;
  readonly authorize?: PurviewDlpAuthorizer;
}

function unauthenticatedError(): AppError {
  return new AppError(PURVIEW_DLP_UNAUTHENTICATED, "authentication required", 401);
}

function validationError(message: string, field: string): AppError {
  return new AppError(ErrorCodes.validationFailed, message, 400, [
    { field, reason: "required" },
  ]);
}

function requireCaller(
  resolveCaller: (ctx: RequestContext) => PurviewDlpCaller | undefined,
  ctx: RequestContext,
): PurviewDlpCaller {
  const caller = resolveCaller(ctx);
  if (caller === undefined) {
    throw unauthenticatedError();
  }
  return caller;
}

function requireParam(ctx: RequestContext, name: string): string {
  const value = ctx.params[name];
  if (typeof value !== "string" || value.trim().length === 0) {
    throw validationError(`${name} is required`, name);
  }
  return value.trim();
}

async function requirePurviewRead(
  options: PurviewDlpRouteOptions,
  caller: PurviewDlpCaller,
): Promise<void> {
  if (options.authorize) {
    await options.authorize(caller, PURVIEW_READ_PERMISSION);
    return;
  }
  const permissions = caller.permissions ?? [];
  if (!permissions.includes(PURVIEW_READ_PERMISSION) && !permissions.includes("*")) {
    throw new AppError(ErrorCodes.forbidden, "forbidden: missing purview.read", 403);
  }
}

export function createPurviewDlpRoutes(options: PurviewDlpRouteOptions): Route[] {
  async function handleList(ctx: RequestContext): Promise<RouteResponse> {
    const caller = requireCaller(options.resolveCaller, ctx);
    const tenantId = requireParam(ctx, "tenantId");
    requireTenantInScope(caller, tenantId);
    await requirePurviewRead(options, caller);

    const query = ctx.query;
    const filter: PurviewDlpFilter = {
      ...(query.get("search") ? { search: query.get("search")! } : {}),
      ...(query.get("state") ? { state: query.get("state")! } : {}),
      limit: parsePagination(query).limit,
      ...(query.get("cursor") ? { cursor: query.get("cursor")! } : {}),
    };
    const page = await options.provider.listPolicies(tenantId, filter);

    return {
      status: 200,
      headers: { "content-type": "application/json" },
      body: {
        tenantId,
        items: page.items,
        nextCursor: page.nextCursor,
        totalCount: page.totalCount,
      },
    };
  }

  async function handleGet(ctx: RequestContext): Promise<RouteResponse> {
    const caller = requireCaller(options.resolveCaller, ctx);
    const tenantId = requireParam(ctx, "tenantId");
    const policyId = requireParam(ctx, "policyId");
    requireTenantInScope(caller, tenantId);
    await requirePurviewRead(options, caller);

    const policy = await options.provider.getPolicy(tenantId, policyId);
    if (!policy) {
      throw new AppError(PURVIEW_DLP_NOT_FOUND, `DLP policy ${policyId} not found`, 404);
    }
    return {
      status: 200,
      headers: { "content-type": "application/json" },
      body: { tenantId, policy },
    };
  }

  return [
    { method: "GET", path: PURVIEW_DLP_PATH, handler: handleList },
    { method: "GET", path: PURVIEW_DLP_ITEM_PATH, handler: handleGet },
  ];
}

export const PURVIEW_DLP_OPENAPI = {
  paths: {
    "/tenants/{tenantId}/purview/dlp": {
      get: {
        operationId: "listPurviewDlpPolicies",
        summary: "List Purview DLP policies live from Purview",
        permission: PURVIEW_READ_PERMISSION,
        security: [{ bearerAuth: [] }],
        parameters: [
          { name: "tenantId", in: "path", required: true, schema: { type: "string" } },
          { name: "search", in: "query", required: false, schema: { type: "string" } },
          { name: "state", in: "query", required: false, schema: { type: "string" } },
          { name: "limit", in: "query", required: false, schema: { type: "integer" } },
          { name: "cursor", in: "query", required: false, schema: { type: "string" } },
        ],
        responses: {
          "200": { description: "The live DLP policies." },
          "401": { description: "Authentication required." },
          "403": { description: "The caller lacks purview.read or the tenant is out of scope." },
        },
      },
    },
    "/tenants/{tenantId}/purview/dlp/{policyId}": {
      get: {
        operationId: "getPurviewDlpPolicy",
        summary: "Read one Purview DLP policy live from Purview",
        permission: PURVIEW_READ_PERMISSION,
        security: [{ bearerAuth: [] }],
        parameters: [
          { name: "tenantId", in: "path", required: true, schema: { type: "string" } },
          { name: "policyId", in: "path", required: true, schema: { type: "string" } },
        ],
        responses: {
          "200": { description: "The live DLP policy." },
          "401": { description: "Authentication required." },
          "403": { description: "The caller lacks purview.read or the tenant is out of scope." },
          "404": { description: "DLP policy not found." },
        },
      },
    },
  },
} as const;
