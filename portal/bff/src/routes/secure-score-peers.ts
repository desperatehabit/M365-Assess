// Secure Score peer comparison API (EPIC-031 SPEC.md §2 US-3, §3.3, §6, §7,
// §8, §9, §11.3; T-0605). Exposes GET
// /v1/tenants/:tenantId/secure-score/peers: the similar-organisation and
// all-organisation benchmarks Microsoft reports on the Graph secureScores
// response (averageComparativeScores). The comparison fields are optional in
// Graph and frequently absent; when Microsoft returns none, the route reports
// `available: false` with an empty comparison list rather than an error, and
// never fabricates a benchmark (SPEC §9, §11.3). The provider is the T-0602
// read extended with the comparison fields. Secure Score is read-only (SPEC
// §8): this route performs no writes. Requires RBAC `secure-score.read` and
// the tenant in caller scope (SPEC §7).
import { AppError, ErrorCodes } from "../errors.js";
import { requireTenantInScope } from "../rbac/authorize.js";
import type { RequestContext, Route, RouteResponse } from "../server.js";
import {
  SECURE_SCORE_READ_PERMISSION,
  type ProviderSecureScore,
  type SecureScoreAuthorizer,
  type SecureScoreCaller,
} from "./secure-score.js";

export const SECURE_SCORE_PEERS_PATH = "/v1/tenants/:tenantId/secure-score/peers";
export const SECURE_SCORE_PEERS_PERMISSION = SECURE_SCORE_READ_PERMISSION;
export const SECURE_SCORE_PEERS_UNAUTHENTICATED = "request.unauthenticated";

/** One Graph secureScores averageComparativeScores entry, surfaced verbatim. */
export interface SecureScoreComparison {
  readonly basis: string;
  readonly averageScore: number;
}

/** The T-0602 read extended with the comparison fields Graph may omit. */
export interface ProviderSecureScoreWithComparisons extends ProviderSecureScore {
  readonly averageComparativeScores?: readonly SecureScoreComparison[];
}

export interface SecureScorePeersProvider {
  getSecureScore(tenantId: string): Promise<ProviderSecureScoreWithComparisons>;
}

export interface SecureScorePeersRouteOptions {
  readonly provider: SecureScorePeersProvider;
  readonly resolveCaller: (ctx: RequestContext) => SecureScoreCaller | undefined;
  readonly authorize?: SecureScoreAuthorizer;
}

/** The peer-comparison view; `available` is false when Microsoft provides none. */
export interface SecureScorePeers {
  readonly tenantId: string;
  readonly available: boolean;
  readonly comparisons: readonly SecureScoreComparison[];
}

function unauthenticatedError(): AppError {
  return new AppError(SECURE_SCORE_PEERS_UNAUTHENTICATED, "authentication required", 401);
}

function requireCaller(
  resolveCaller: (ctx: RequestContext) => SecureScoreCaller | undefined,
  ctx: RequestContext,
): SecureScoreCaller {
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

async function ensureRead(
  options: SecureScorePeersRouteOptions,
  caller: SecureScoreCaller,
): Promise<void> {
  if (options.authorize) {
    await options.authorize(caller, SECURE_SCORE_PEERS_PERMISSION);
    return;
  }
  const permissions = caller.permissions ?? [];
  if (
    !permissions.includes(SECURE_SCORE_PEERS_PERMISSION) &&
    !permissions.includes("*")
  ) {
    throw new AppError(
      ErrorCodes.forbidden,
      "forbidden: missing secure-score.read",
      403,
      [{ field: "permission", reason: SECURE_SCORE_PEERS_PERMISSION }],
    );
  }
}

/**
 * Maps the Graph comparison fields to the peer view. Absent or empty
 * comparisons yield `available: false` with no entries; every reported value
 * comes from Microsoft's response.
 */
export function toSecureScorePeers(
  tenantId: string,
  score: ProviderSecureScoreWithComparisons,
): SecureScorePeers {
  const comparisons = score.averageComparativeScores ?? [];
  return {
    tenantId,
    available: comparisons.length > 0,
    comparisons: comparisons.map((entry) => ({
      basis: entry.basis,
      averageScore: entry.averageScore,
    })),
  };
}

export function createSecureScorePeersRoutes(options: SecureScorePeersRouteOptions): Route[] {
  return [
    {
      method: "GET",
      path: SECURE_SCORE_PEERS_PATH,
      handler: async (ctx: RequestContext): Promise<RouteResponse> => {
        const caller = requireCaller(options.resolveCaller, ctx);
        const tenantId = requireTenantParam(ctx);

        requireTenantInScope(caller, tenantId);
        await ensureRead(options, caller);

        const score = await options.provider.getSecureScore(tenantId);
        return {
          status: 200,
          headers: { "content-type": "application/json" },
          body: toSecureScorePeers(tenantId, score),
        };
      },
    },
  ];
}

export const SECURE_SCORE_PEERS_OPENAPI = {
  paths: {
    "/tenants/{tenantId}/secure-score/peers": {
      get: {
        operationId: "getSecureScorePeers",
        summary:
          "Peer comparison benchmarks from Graph secureScores, when Microsoft provides them",
        permission: SECURE_SCORE_PEERS_PERMISSION,
        security: [{ bearerAuth: [] }],
        parameters: [
          {
            name: "tenantId",
            in: "path",
            required: true,
            schema: { type: "string" },
          },
        ],
        responses: {
          "200": {
            description:
              "Peer comparison benchmarks; available is false with no comparisons when Microsoft returns none.",
          },
          "400": { description: "A path parameter is invalid." },
          "401": { description: "Authentication is required." },
          "403": {
            description:
              "The caller lacks the secure-score.read permission or the tenant is out of scope.",
          },
        },
      },
    },
  },
} as const;
