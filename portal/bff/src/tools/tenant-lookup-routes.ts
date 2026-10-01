// Tenant lookup route (EPIC-040 SPEC.md §3.2, §6; T-0785).
// GET /v1/tenant-lookup?query=<domain-or-tenant-id> returns the tenant ID, name,
// default domain, verified domains, region, and whether the tenant is in the
// portal. Reads require tools.read; the service intersects the resolved tenant
// with the caller's scope, so an out-of-scope caller is denied rather than shown
// details. The OpenAPI fragment is published here so `portal.v1.yaml` stays
// untouched (EPIC-001 SPEC §1).
import { AppError, ErrorCodes } from "../errors.js";
import type { Caller } from "../rbac/authorize.js";
import type { RequestContext, Route } from "../server.js";
import type { TenantLookupService } from "./tenant-lookup-service.js";

export const TENANT_LOOKUP_PATH = "/v1/tenant-lookup";
export const TENANT_LOOKUP_READ_PERMISSION = "tools.read";
export const TENANT_LOOKUP_UNAUTHENTICATED = "request.unauthenticated";

export interface TenantLookupCaller extends Caller {
  readonly userId?: string;
}

export type TenantLookupAuthorizer = (
  caller: TenantLookupCaller,
  permission: string,
) => void | Promise<void>;

export interface TenantLookupRouteOptions {
  readonly service: TenantLookupService;
  readonly resolveCaller: (ctx: RequestContext) => TenantLookupCaller | undefined;
  readonly authorize?: TenantLookupAuthorizer;
}

function unauthenticatedError(): AppError {
  return new AppError(TENANT_LOOKUP_UNAUTHENTICATED, "authentication required", 401);
}

function requireCaller(
  resolveCaller: (ctx: RequestContext) => TenantLookupCaller | undefined,
  ctx: RequestContext,
): TenantLookupCaller {
  const caller = resolveCaller(ctx);
  if (caller === undefined) {
    throw unauthenticatedError();
  }
  return caller;
}

async function requireToolsRead(
  options: TenantLookupRouteOptions,
  caller: TenantLookupCaller,
): Promise<void> {
  if (options.authorize) {
    await options.authorize(caller, TENANT_LOOKUP_READ_PERMISSION);
    return;
  }
  const permissions = caller.permissions ?? [];
  if (!permissions.includes(TENANT_LOOKUP_READ_PERMISSION) && !permissions.includes("*")) {
    throw new AppError(ErrorCodes.forbidden, "forbidden: missing tools.read", 403);
  }
}

function parseQuery(query: URLSearchParams): string {
  const value = query.get("query") ?? "";
  if (value.trim().length === 0) {
    throw new AppError(ErrorCodes.validationFailed, "query is required", 400, [
      { field: "query", reason: "required" },
    ]);
  }
  return value.trim();
}

export function createTenantLookupRoutes(options: TenantLookupRouteOptions): Route[] {
  return [
    {
      method: "GET",
      path: TENANT_LOOKUP_PATH,
      handler: async (ctx) => {
        const caller = requireCaller(options.resolveCaller, ctx);
        await requireToolsRead(options, caller);
        const query = parseQuery(ctx.query);
        const result = await options.service.lookup(query, caller.tenantScope);
        return { status: 200, body: result };
      },
    },
  ];
}

export const TENANT_LOOKUP_OPENAPI = {
  paths: {
    "/tenant-lookup": {
      get: {
        operationId: "lookupTenant",
        summary: "Look up a tenant by domain or tenant ID",
        permission: TENANT_LOOKUP_READ_PERMISSION,
        security: [{ bearerAuth: [] }],
        parameters: [
          {
            name: "query",
            in: "query",
            required: true,
            schema: { type: "string" },
            description: "A verified domain or the tenant's GUID.",
          },
        ],
        responses: {
          "200": {
            description: "The tenant's details and whether it is in the portal.",
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/TenantLookupResult" },
              },
            },
          },
          "400": { description: "A non-empty query parameter is required." },
          "401": { description: "Authentication required." },
          "403": {
            description: "The caller lacks tools.read or the tenant is outside the caller scope.",
          },
          "404": { description: "No tenant matches the query." },
        },
      },
    },
  },
  schemas: {
    TenantLookupResult: {
      type: "object",
      required: ["tenantId", "name", "defaultDomain", "verifiedDomains", "region", "inPortal"],
      properties: {
        tenantId: { type: "string" },
        name: { type: "string" },
        defaultDomain: { type: "string" },
        verifiedDomains: { type: "array", items: { type: "string" } },
        region: { type: "string" },
        inPortal: { type: "boolean" },
      },
    },
  },
} as const;
