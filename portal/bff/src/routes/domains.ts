// Domain inventory API (EPIC-034 SPEC.md §3.1, §4.1, §6; T-0662).
// Exposes GET /v1/tenants/:tenantId/domains with §3.1 columns:
// Domain, Type (initial/verified/managed), Verification, DNS health (badge),
// Services (MX target), Last checked.
// Requires RBAC `domains.read` and tenant in caller scope.
import { AppError, ErrorCodes } from "../errors.js";
import { parsePagination } from "../pagination.js";
import { requireTenantInScope, type Caller } from "../rbac/authorize.js";
import type Database from "better-sqlite3";
import type { RequestContext, Route, RouteResponse } from "../server.js";

export const DOMAINS_PATH = "/v1/tenants/:tenantId/domains";
export const DOMAINS_READ_PERMISSION = "domains.read";
export const DOMAINS_UNAUTHENTICATED = "request.unauthenticated";

export interface DomainItem {
  readonly domain: string;
  readonly type: "initial" | "verified" | "managed" | string;
  readonly verification: "verified" | "unverified" | string;
  readonly dnsHealth?: string | null;
  readonly services?: string | null;
  readonly lastChecked?: string | null;
}

export interface DomainsFilter {
  readonly cursor: string | null;
  readonly limit: number;
}

export interface DomainsPage {
  readonly tenantId: string;
  readonly totalCount: number;
  readonly items: readonly DomainItem[];
  readonly nextCursor: string | null;
}

export interface DomainsProvider {
  listDomains(tenantId: string, filter: DomainsFilter, latestChecks: readonly DomainCheck[]): Promise<DomainsPage>;
}

export interface DomainCheck {
  readonly id: string;
  readonly tenantId: string;
  readonly domain: string;
  readonly at: string;
  readonly records: string;
  readonly health: string;
  readonly recommendations: string;
}

export interface DomainsRouteOptions {
  readonly provider: DomainsProvider;
  readonly db: Database.Database;
  readonly resolveCaller: (ctx: RequestContext) => Caller | undefined;
  readonly authorize?: (caller: Caller, permission: string) => void | Promise<void>;
}

function unauthenticatedError(): AppError {
  return new AppError(DOMAINS_UNAUTHENTICATED, "authentication required", 401);
}

function requireCaller(
  resolveCaller: (ctx: RequestContext) => Caller | undefined,
  ctx: RequestContext,
): Caller {
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

export function parseDomainsFilter(query: URLSearchParams): DomainsFilter {
  const pagination = parsePagination(query);
  return {
    cursor: pagination.cursor,
    limit: pagination.limit,
  };
}

function getLatestDomainChecks(db: Database.Database, tenantId: string): DomainCheck[] {
  const rows = db
    .prepare(
      `SELECT id, tenantId, domain, "at", records, health, recommendations
         FROM domain_checks
        WHERE tenantId = ?
        ORDER BY "at" DESC`,
    )
    .all(tenantId) as DomainCheck[];

  // Keep only the latest check per domain
  const latestPerDomain = new Map<string, DomainCheck>();
  for (const row of rows) {
    if (!latestPerDomain.has(row.domain)) {
      latestPerDomain.set(row.domain, row);
    }
  }
  return [...latestPerDomain.values()];
}

export function createDomainsRoute(options: DomainsRouteOptions): Route {
  return {
    method: "GET",
    path: DOMAINS_PATH,
    handler: async (ctx: RequestContext): Promise<RouteResponse> => {
      const caller = requireCaller(options.resolveCaller, ctx);
      const tenantId = requireTenantParam(ctx);

      requireTenantInScope(caller, tenantId);

      if (options.authorize) {
        await options.authorize(caller, DOMAINS_READ_PERMISSION);
      } else {
        const permissions = caller.permissions ?? [];
        if (!permissions.includes(DOMAINS_READ_PERMISSION) && !permissions.includes("*")) {
          throw new AppError(ErrorCodes.forbidden, "forbidden: missing domains.read", 403);
        }
      }

      const filter = parseDomainsFilter(ctx.query);
      const latestChecks = getLatestDomainChecks(options.db, tenantId);
      const page = await options.provider.listDomains(tenantId, filter, latestChecks);

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
export const DOMAINS_OPENAPI = {
  paths: {
    "/tenants/{tenantId}/domains": {
      get: {
        operationId: "listTenantDomains",
        summary: "List tenant domains with type, verification, DNS health, and last-checked",
        permission: DOMAINS_READ_PERMISSION,
        security: [{ bearerAuth: [] }],
        parameters: [
          { name: "tenantId", in: "path", required: true, schema: { type: "string" } },
          { name: "cursor", in: "query", required: false, schema: { type: "string" } },
          { name: "limit", in: "query", required: false, schema: { type: "integer" } },
        ],
        responses: {
          "200": { description: "Cursor-paginated domain inventory with DNS health and last-checked." },
          "401": { description: "Authentication required." },
          "403": { description: "The caller lacks domains.read or the tenant is out of scope." },
        },
      },
    },
  },
} as const;