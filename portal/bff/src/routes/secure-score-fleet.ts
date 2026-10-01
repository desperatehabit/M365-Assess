// Secure Score fleet overview (EPIC-031 SPEC.md §2 US-6, §3.5, §6, §7; T-0606).
// Exposes GET /v1/secure-score/fleet: the latest snapshot per visible tenant
// plus a short trend series for the table's sparklines. The fleet view is
// filtered to the caller's tenant scope (SPEC §7); tenant groups (EPIC-002,
// T-0026) resolve into that scope upstream, so this route consumes the concrete
// scope seam and never trusts a client-supplied tenant list. A tenant with no
// snapshot is reported with `hasSnapshot: false` rather than omitted silently.
// Secure Score is read-only (SPEC §8): this route performs no writes.
import { AppError, ErrorCodes } from "../errors.js";
import { isTenantAllowed } from "../rbac/scope.js";
import type {
  SecureScoreRepository,
  SecureScoreSnapshotRecord,
} from "../repository/secure-score.js";
import type { RequestContext, Route, RouteResponse } from "../server.js";
import {
  SECURE_SCORE_READ_PERMISSION,
  type SecureScoreAuthorizer,
  type SecureScoreCaller,
} from "./secure-score.js";

export const SECURE_SCORE_FLEET_PATH = "/v1/secure-score/fleet";
export const SECURE_SCORE_FLEET_UNAUTHENTICATED = "request.unauthenticated";
/** Default number of recent snapshots returned per tenant for sparklines. */
export const SECURE_SCORE_FLEET_TREND_LIMIT = 12;

export interface SecureScoreFleetTrendPoint {
  readonly at: string;
  readonly percentage: number;
}

export interface SecureScoreFleetTenant {
  readonly tenantId: string;
  readonly hasSnapshot: boolean;
  readonly at: string | null;
  readonly current: number | null;
  readonly max: number | null;
  readonly percentage: number | null;
  /** Recent snapshots, oldest first, capped at the trend limit. */
  readonly trend: readonly SecureScoreFleetTrendPoint[];
}

export interface SecureScoreFleet {
  readonly tenants: readonly SecureScoreFleetTenant[];
}

export interface SecureScoreFleetTenantSource {
  /** Every tenant id in the fleet; excluding deleted tenants is the source's concern. */
  listTenantIds(): Promise<readonly string[]>;
}

export interface SecureScoreFleetRouteOptions {
  readonly repository: Pick<SecureScoreRepository, "listSnapshots">;
  readonly tenants: SecureScoreFleetTenantSource;
  readonly resolveCaller: (ctx: RequestContext) => SecureScoreCaller | undefined;
  readonly authorize?: SecureScoreAuthorizer;
  readonly trendLimit?: number;
}

function unauthenticatedError(): AppError {
  return new AppError(SECURE_SCORE_FLEET_UNAUTHENTICATED, "authentication required", 401);
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

async function ensureRead(
  options: SecureScoreFleetRouteOptions,
  caller: SecureScoreCaller,
): Promise<void> {
  if (options.authorize) {
    await options.authorize(caller, SECURE_SCORE_READ_PERMISSION);
    return;
  }
  const permissions = caller.permissions ?? [];
  if (
    !permissions.includes(SECURE_SCORE_READ_PERMISSION) &&
    !permissions.includes("*")
  ) {
    throw new AppError(
      ErrorCodes.forbidden,
      "forbidden: missing secure-score.read",
      403,
      [{ field: "permission", reason: SECURE_SCORE_READ_PERMISSION }],
    );
  }
}

/**
 * Builds one fleet row from a tenant's snapshots. Snapshots are ordered by
 * observation time (then id) so the latest row and the trend tail are stable
 * regardless of the repository's ordering; an empty set yields the explicit
 * "no snapshot" row rather than a missing entry.
 */
export function buildFleetTenant(
  tenantId: string,
  snapshots: readonly SecureScoreSnapshotRecord[],
  trendLimit: number = SECURE_SCORE_FLEET_TREND_LIMIT,
): SecureScoreFleetTenant {
  if (snapshots.length === 0) {
    return {
      tenantId,
      hasSnapshot: false,
      at: null,
      current: null,
      max: null,
      percentage: null,
      trend: [],
    };
  }
  const ordered = [...snapshots].sort(
    (left, right) => left.at.localeCompare(right.at) || left.id.localeCompare(right.id),
  );
  const latest = ordered[ordered.length - 1]!;
  const limit = Math.max(1, Math.floor(trendLimit));
  const trend = ordered.slice(-limit).map((snapshot) => ({
    at: snapshot.at,
    percentage: snapshot.percentage,
  }));
  return {
    tenantId,
    hasSnapshot: true,
    at: latest.at,
    current: latest.current,
    max: latest.max,
    percentage: latest.percentage,
    trend,
  };
}

export function createSecureScoreFleetRoutes(
  options: SecureScoreFleetRouteOptions,
): Route[] {
  const trendLimit = options.trendLimit ?? SECURE_SCORE_FLEET_TREND_LIMIT;
  return [
    {
      method: "GET",
      path: SECURE_SCORE_FLEET_PATH,
      handler: async (ctx: RequestContext): Promise<RouteResponse> => {
        const caller = requireCaller(options.resolveCaller, ctx);
        await ensureRead(options, caller);

        const allTenantIds = await options.tenants.listTenantIds();
        const visible = [...new Set(allTenantIds)]
          .filter((tenantId) => isTenantAllowed(caller.tenantScope, tenantId))
          .sort((left, right) => left.localeCompare(right));

        const tenants = await Promise.all(
          visible.map(async (tenantId) =>
            buildFleetTenant(
              tenantId,
              await options.repository.listSnapshots(tenantId),
              trendLimit,
            ),
          ),
        );

        return {
          status: 200,
          headers: { "content-type": "application/json" },
          body: { tenants } satisfies SecureScoreFleet,
        };
      },
    },
  ];
}

export const SECURE_SCORE_FLEET_OPENAPI = {
  paths: {
    "/secure-score/fleet": {
      get: {
        operationId: "getSecureScoreFleet",
        summary:
          "Latest Secure Score per visible tenant, with a short trend series for sparklines",
        permission: SECURE_SCORE_READ_PERMISSION,
        security: [{ bearerAuth: [] }],
        responses: {
          "200": {
            description:
              "The latest snapshot per tenant in the caller's scope; tenants with no snapshot are reported with hasSnapshot false.",
          },
          "401": { description: "Authentication is required." },
          "403": {
            description:
              "The caller lacks the secure-score.read permission.",
          },
        },
      },
    },
  },
} as const;
