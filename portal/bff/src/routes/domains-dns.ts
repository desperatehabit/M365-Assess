// DNS analysis and history API (EPIC-034 SPEC.md §3.2, §3.4, §4.2, §6, §7; T-0665).
//
//   POST /v1/tenants/:tenantId/domains/:domain/check-dns   analyse now
//   GET  /v1/tenants/:tenantId/domains/:domain/history     stored checks (trend)
//
// A check inside the configured TTL is served from the dns-cache instead of
// re-resolving (SPEC §11.3), which also caps egress and resolver rate-limit
// pressure (SPEC §9). On a miss the injected analyser runs the T-0664 job, the
// T-0661 repository appends a DomainCheck, and the persisted check is cached.
// History returns the stored checks ordered for the trend view. Both routes
// require RBAC `domains.read` and the tenant in the caller scope. The OpenAPI
// fragment is published here so `portal.v1.yaml` stays untouched (EPIC-001
// SPEC §1).

import { randomUUID } from "node:crypto";
import type { DomainCheck, DomainCheckInput } from "@m365-assess/db";
import type { DnsResultCache } from "../cache/dns-cache.js";
import { AppError, ErrorCodes } from "../errors.js";
import { requireTenantInScope, type Caller } from "../rbac/authorize.js";
import type { RequestContext, Route, RouteResponse } from "../server.js";

// ─── Paths, permissions, error codes ─────────────────────────────────────────

export const DOMAIN_CHECK_DNS_PATH = "/v1/tenants/:tenantId/domains/:domain/check-dns";
export const DOMAIN_HISTORY_PATH = "/v1/tenants/:tenantId/domains/:domain/history";

export const DOMAINS_DNS_READ_PERMISSION = "domains.read";
export const DOMAINS_DNS_UNAUTHENTICATED = "request.unauthenticated";

// ─── Result and dependency seams ─────────────────────────────────────────────

/** The T-0664 analyser result: resolved records, per-family health, actions. */
export interface DnsAnalysisResult {
  readonly records: Record<string, unknown>;
  readonly health: Record<string, unknown>;
  readonly recommendations: readonly string[];
}

/**
 * Queue-backed seam for the analyser: the production wiring enqueues the
 * T-0664 check-domain-dns worker for the tenant and returns its result.
 * Depending on the seam keeps process and DNS code out of the BFF.
 */
export interface DnsAnalyser {
  analyse(tenantId: string, domain: string): Promise<DnsAnalysisResult>;
}

/**
 * Persistence seam over the T-0661 domain repository: checks are append-only
 * and tenant-scoped. `SqliteDomainRepository` satisfies this structurally.
 */
export interface DomainCheckStore {
  appendDomainCheck(input: DomainCheckInput): Promise<DomainCheck>;
  listDomainHistory(tenantId: string, domain: string): Promise<DomainCheck[]>;
}

export interface DomainDnsCheckResponse {
  readonly tenantId: string;
  readonly domain: string;
  readonly check: DomainCheck;
  readonly cached: boolean;
}

export interface DomainDnsHistoryResponse {
  readonly tenantId: string;
  readonly domain: string;
  readonly items: readonly DomainCheck[];
  readonly totalCount: number;
}

export interface DomainsDnsRouteOptions {
  readonly analyser: DnsAnalyser;
  readonly cache: DnsResultCache<DomainCheck>;
  readonly checks: DomainCheckStore;
  readonly resolveCaller: (ctx: RequestContext) => Caller | undefined;
  readonly authorize?: (caller: Caller, permission: string) => void | Promise<void>;
  readonly now?: () => string;
  readonly idGenerator?: () => string;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function unauthenticatedError(): AppError {
  return new AppError(DOMAINS_DNS_UNAUTHENTICATED, "authentication required", 401);
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

function requireDomainParam(ctx: RequestContext): string {
  const value = ctx.params["domain"];
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new AppError(ErrorCodes.validationFailed, "domain is required", 400, [
      { field: "domain", reason: "required" },
    ]);
  }
  // DNS names are case-insensitive; normalise so cache hits and stored history
  // do not split on case.
  return value.trim().toLowerCase();
}

async function authorizeRead(
  options: DomainsDnsRouteOptions,
  caller: Caller,
): Promise<void> {
  if (options.authorize) {
    await options.authorize(caller, DOMAINS_DNS_READ_PERMISSION);
    return;
  }
  const permissions = caller.permissions ?? [];
  if (!permissions.includes(DOMAINS_DNS_READ_PERMISSION) && !permissions.includes("*")) {
    throw new AppError(ErrorCodes.forbidden, "forbidden: missing domains.read", 403);
  }
}

function json(body: unknown): RouteResponse {
  return {
    status: 200,
    headers: { "content-type": "application/json" },
    body,
  };
}

// ─── Route factory ───────────────────────────────────────────────────────────

export function createDomainsDnsRoutes(options: DomainsDnsRouteOptions): Route[] {
  const now = options.now ?? (() => new Date().toISOString());
  const idGenerator = options.idGenerator ?? randomUUID;

  return [
    {
      method: "POST",
      path: DOMAIN_CHECK_DNS_PATH,
      handler: async (ctx: RequestContext): Promise<RouteResponse> => {
        const caller = requireCaller(options.resolveCaller, ctx);
        const tenantId = requireTenantParam(ctx);
        const domain = requireDomainParam(ctx);
        requireTenantInScope(caller, tenantId);
        await authorizeRead(options, caller);

        const outcome = await options.cache.getOrResolve(tenantId, domain, async () => {
          const result = await options.analyser.analyse(tenantId, domain);
          return options.checks.appendDomainCheck({
            id: idGenerator(),
            tenantId,
            domain,
            at: now(),
            records: result.records,
            health: result.health,
            recommendations: [...result.recommendations],
          });
        });

        const body: DomainDnsCheckResponse = {
          tenantId,
          domain,
          check: outcome.value,
          cached: outcome.cached,
        };
        return json(body);
      },
    },
    {
      method: "GET",
      path: DOMAIN_HISTORY_PATH,
      handler: async (ctx: RequestContext): Promise<RouteResponse> => {
        const caller = requireCaller(options.resolveCaller, ctx);
        const tenantId = requireTenantParam(ctx);
        const domain = requireDomainParam(ctx);
        requireTenantInScope(caller, tenantId);
        await authorizeRead(options, caller);

        const items = await options.checks.listDomainHistory(tenantId, domain);
        const body: DomainDnsHistoryResponse = {
          tenantId,
          domain,
          items,
          totalCount: items.length,
        };
        return json(body);
      },
    },
  ];
}

// ─── OpenAPI fragment (paths published by the route module, SPEC §6) ─────────

const TENANT_ID_PARAMETER = {
  name: "tenantId",
  in: "path",
  required: true,
  schema: { type: "string" },
} as const;

const DOMAIN_PARAMETER = {
  name: "domain",
  in: "path",
  required: true,
  schema: { type: "string" },
} as const;

const ERROR_RESPONSES = {
  "401": { description: "Authentication required." },
  "403": { description: "The caller lacks domains.read or the tenant is out of scope." },
} as const;

export const DOMAINS_DNS_OPENAPI = {
  paths: {
    "/tenants/{tenantId}/domains/{domain}/check-dns": {
      post: {
        tags: ["Domains"],
        operationId: "checkDomainDns",
        summary:
          "Run the DNS analyser for a domain now; repeat calls inside the cache TTL are served from cache.",
        permission: DOMAINS_DNS_READ_PERMISSION,
        security: [{ bearerAuth: [] }],
        parameters: [TENANT_ID_PARAMETER, DOMAIN_PARAMETER],
        responses: {
          "200": {
            description: "The persisted DNS analysis, or the cached result inside the TTL.",
          },
          ...ERROR_RESPONSES,
        },
      },
    },
    "/tenants/{tenantId}/domains/{domain}/history": {
      get: {
        tags: ["Domains"],
        operationId: "getDomainDnsHistory",
        summary: "Ordered stored DNS checks for a domain (trend view).",
        permission: DOMAINS_DNS_READ_PERMISSION,
        security: [{ bearerAuth: [] }],
        parameters: [TENANT_ID_PARAMETER, DOMAIN_PARAMETER],
        responses: {
          "200": { description: "The domain's stored checks ordered by time." },
          ...ERROR_RESPONSES,
        },
      },
    },
  },
} as const;
