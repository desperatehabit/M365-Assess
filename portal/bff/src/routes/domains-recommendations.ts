// DNS recommendations API (EPIC-034 SPEC.md §3.3, §4.2, §11.2; T-0666).
//
//   GET /v1/tenants/:tenantId/domains/:domain/recommendations
//
// Serves the ranked, actionable recommendations the Get-DnsRecommendations
// worker derives from a domain's analysed records. Each recommendation names
// the record family, a severity, a plain-language explanation, a remediation
// link, and the module CheckID it maps to (null for families with no module
// check, e.g. MTA-STS/TLS-RPT, which carry a portal instruction instead).
// Recommend-only (SPEC §11.2): the route exposes no write action and never
// changes a DNS record. Requires RBAC `Tenant.Domains.Read` and the tenant in the
// caller scope. The OpenAPI fragment is published here so `portal.v1.yaml`
// stays untouched (EPIC-001 SPEC §1).

import { AppError, ErrorCodes } from "../errors.js";
import { requireTenantInScope, type Caller } from "../rbac/authorize.js";
import type { RequestContext, Route, RouteResponse } from "../server.js";

// ─── Paths, permissions, error codes ─────────────────────────────────────────

export const DOMAIN_RECOMMENDATIONS_PATH =
  "/v1/tenants/:tenantId/domains/:domain/recommendations";

export const DOMAINS_RECOMMENDATIONS_READ_PERMISSION = "Tenant.Domains.Read";
export const DOMAINS_RECOMMENDATIONS_UNAUTHENTICATED = "request.unauthenticated";

// ─── Result and dependency seams ─────────────────────────────────────────────

export type DnsRecommendationSeverity = "high" | "medium" | "low" | "info";

/**
 * One ranked, actionable recommendation. `checkId` maps to the module's DNS
 * CheckID when one exists (DNS-SPF-001 / DNS-DKIM-001 / DNS-DMARC-001 /
 * DNS-MX-001) and is null otherwise, in which case `remediation` carries the
 * portal instruction.
 */
export interface DnsRecommendation {
  readonly recordFamily: string;
  readonly severity: DnsRecommendationSeverity;
  readonly explanation: string;
  readonly remediationUrl: string;
  readonly remediation?: string;
  readonly checkId?: string | null;
}

/**
 * Queue-backed seam for the Get-DnsRecommendations worker: the production
 * wiring runs the worker against the domain's latest analysed records and
 * returns the ranked list. Depending on the seam keeps process and DNS code
 * out of the BFF.
 */
export interface DnsRecommendationsProvider {
  getRecommendations(tenantId: string, domain: string): Promise<readonly DnsRecommendation[]>;
}

export interface DomainRecommendationsResponse {
  readonly tenantId: string;
  readonly domain: string;
  readonly recommendations: readonly DnsRecommendation[];
  readonly totalCount: number;
}

export interface DomainsRecommendationsRouteOptions {
  readonly provider: DnsRecommendationsProvider;
  readonly resolveCaller: (ctx: RequestContext) => Caller | undefined;
  readonly authorize?: (caller: Caller, permission: string) => void | Promise<void>;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function unauthenticatedError(): AppError {
  return new AppError(DOMAINS_RECOMMENDATIONS_UNAUTHENTICATED, "authentication required", 401);
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
  // DNS names are case-insensitive; normalise so the worker sees one spelling.
  return value.trim().toLowerCase();
}

async function authorizeRead(
  options: DomainsRecommendationsRouteOptions,
  caller: Caller,
): Promise<void> {
  if (options.authorize) {
    await options.authorize(caller, DOMAINS_RECOMMENDATIONS_READ_PERMISSION);
    return;
  }
  const permissions = caller.permissions ?? [];
  if (!permissions.includes(DOMAINS_RECOMMENDATIONS_READ_PERMISSION) && !permissions.includes("*")) {
    throw new AppError(ErrorCodes.forbidden, "forbidden: missing Tenant.Domains.Read", 403);
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

export function createDomainsRecommendationsRoutes(
  options: DomainsRecommendationsRouteOptions,
): Route[] {
  return [
    {
      method: "GET",
      path: DOMAIN_RECOMMENDATIONS_PATH,
      handler: async (ctx: RequestContext): Promise<RouteResponse> => {
        const caller = requireCaller(options.resolveCaller, ctx);
        const tenantId = requireTenantParam(ctx);
        const domain = requireDomainParam(ctx);
        requireTenantInScope(caller, tenantId);
        await authorizeRead(options, caller);

        const recommendations = await options.provider.getRecommendations(tenantId, domain);
        const body: DomainRecommendationsResponse = {
          tenantId,
          domain,
          recommendations: [...recommendations],
          totalCount: recommendations.length,
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
  "403": { description: "The caller lacks Tenant.Domains.Read or the tenant is out of scope." },
} as const;

export const DOMAINS_RECOMMENDATIONS_OPENAPI = {
  paths: {
    "/tenants/{tenantId}/domains/{domain}/recommendations": {
      get: {
        tags: ["Domains"],
        operationId: "getDomainDnsRecommendations",
        summary:
          "Ranked, actionable DNS recommendations for a domain; empty when the domain is clean.",
        permission: DOMAINS_RECOMMENDATIONS_READ_PERMISSION,
        security: [{ bearerAuth: [] }],
        parameters: [TENANT_ID_PARAMETER, DOMAIN_PARAMETER],
        responses: {
          "200": {
            description:
              "Ranked recommendations (record family, severity, explanation, remediation link, CheckID).",
          },
          ...ERROR_RESPONSES,
        },
      },
    },
  },
} as const;
