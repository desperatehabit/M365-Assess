// Secure Score trend + snapshot API (EPIC-031 SPEC.md §4.2, §5, §6, §7, §8,
// §11.2; T-0604). Exposes:
//   GET  /v1/tenants/:tenantId/secure-score/trend     -> ordered snapshots
//   POST /v1/tenants/:tenantId/secure-score/snapshot  -> record one now
//
// The trend chart reads the append-only snapshots the daily job records (SPEC
// §4.2); snapshots persist through the T-0601 store and obey its retention
// window, so the on-demand snapshot prunes to the configured window after
// recording. The on-demand read reuses the T-0602 provider. Secure Score stays
// read-only against the tenant (SPEC §8): the only write is a portal-local
// snapshot row. Requires RBAC `Security.SecureScore.Read` and the tenant in caller
// scope (SPEC §7).
import { AppError, ErrorCodes } from "../errors.js";
import { requireTenantInScope } from "../rbac/authorize.js";
import type { RequestContext, Route, RouteResponse } from "../server.js";
import {
  SECURE_SCORE_READ_PERMISSION,
  type SecureScoreAuthorizer,
  type SecureScoreCaller,
  type SecureScoreCategory,
  type SecureScoreProvider,
} from "./secure-score.js";

export const SECURE_SCORE_TREND_PATH = "/v1/tenants/:tenantId/secure-score/trend";
export const SECURE_SCORE_SNAPSHOT_PATH = "/v1/tenants/:tenantId/secure-score/snapshot";
export const SECURE_SCORE_TREND_PERMISSION = SECURE_SCORE_READ_PERMISSION;
export const SECURE_SCORE_TREND_UNAUTHENTICATED = "request.unauthenticated";

/** Snapshot retention window (days) when the caller configures none. */
export const SECURE_SCORE_TREND_RETENTION_DAYS = 90;

/** A stored trend point (SPEC §5). */
export interface SecureScoreTrendSnapshot {
  readonly id: string;
  readonly tenantId: string;
  readonly at: string;
  readonly current: number;
  readonly max: number;
  readonly percentage: number;
  readonly categories: Record<string, unknown>;
}

export interface SecureScoreSnapshotInput {
  readonly tenantId: string;
  readonly at?: string;
  readonly current: number;
  readonly max: number;
  readonly percentage: number;
  readonly categories?: Record<string, unknown>;
}

export interface SecureScoreSnapshotPruneResult {
  readonly prunedSnapshotsCount: number;
}

/** The slice of the T-0601 repository the trend routes use. */
export interface SecureScoreTrendStore {
  listSnapshots(tenantId: string): Promise<readonly SecureScoreTrendSnapshot[]>;
  recordSnapshot(input: SecureScoreSnapshotInput): Promise<SecureScoreTrendSnapshot>;
  pruneSnapshots(options: {
    readonly retentionDays: number;
  }): Promise<SecureScoreSnapshotPruneResult>;
}

export interface SecureScoreTrendRouteOptions {
  /** The T-0602 read path, reused for the on-demand snapshot. */
  readonly provider: SecureScoreProvider;
  /** The T-0601 snapshot store. */
  readonly store: SecureScoreTrendStore;
  readonly resolveCaller: (ctx: RequestContext) => SecureScoreCaller | undefined;
  readonly authorize?: SecureScoreAuthorizer;
  /** Snapshot retention window in days; defaults to SECURE_SCORE_TREND_RETENTION_DAYS. */
  readonly retentionDays?: number;
  readonly now?: () => string;
}

function unauthenticatedError(): AppError {
  return new AppError(SECURE_SCORE_TREND_UNAUTHENTICATED, "authentication required", 401);
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
  options: SecureScoreTrendRouteOptions,
  caller: SecureScoreCaller,
): Promise<void> {
  if (options.authorize) {
    await options.authorize(caller, SECURE_SCORE_TREND_PERMISSION);
    return;
  }
  const permissions = caller.permissions ?? [];
  if (
    !permissions.includes(SECURE_SCORE_TREND_PERMISSION) &&
    !permissions.includes("*")
  ) {
    throw new AppError(
      ErrorCodes.forbidden,
      "forbidden: missing Security.SecureScore.Read",
      403,
      [{ field: "permission", reason: SECURE_SCORE_TREND_PERMISSION }],
    );
  }
}

/** Key the T-0602 category split by category name for the T-0601 JSON object. */
function toSnapshotCategories(
  categories: readonly SecureScoreCategory[],
): Record<string, unknown> {
  const map: Record<string, unknown> = {};
  for (const category of categories) {
    map[category.category] = {
      achieved: category.achieved,
      available: category.available,
      percentage: category.percentage,
    };
  }
  return map;
}

/** Stable time order: by observation time, then id as the tie-break. */
function byObservationOrder(
  left: SecureScoreTrendSnapshot,
  right: SecureScoreTrendSnapshot,
): number {
  return left.at.localeCompare(right.at) || left.id.localeCompare(right.id);
}

export function createSecureScoreTrendRoutes(
  options: SecureScoreTrendRouteOptions,
): Route[] {
  const retentionDays = options.retentionDays ?? SECURE_SCORE_TREND_RETENTION_DAYS;
  const now = options.now ?? (() => new Date().toISOString());

  const trend: Route = {
    method: "GET",
    path: SECURE_SCORE_TREND_PATH,
    handler: async (ctx: RequestContext): Promise<RouteResponse> => {
      const caller = requireCaller(options.resolveCaller, ctx);
      const tenantId = requireTenantParam(ctx);

      requireTenantInScope(caller, tenantId);
      await ensureRead(options, caller);

      const snapshots = [...(await options.store.listSnapshots(tenantId))].sort(
        byObservationOrder,
      );
      return {
        status: 200,
        headers: { "content-type": "application/json" },
        body: { tenantId, snapshots },
      };
    },
  };

  const snapshot: Route = {
    method: "POST",
    path: SECURE_SCORE_SNAPSHOT_PATH,
    handler: async (ctx: RequestContext): Promise<RouteResponse> => {
      const caller = requireCaller(options.resolveCaller, ctx);
      const tenantId = requireTenantParam(ctx);

      requireTenantInScope(caller, tenantId);
      await ensureRead(options, caller);

      const score = await options.provider.getSecureScore(tenantId);
      const recorded = await options.store.recordSnapshot({
        tenantId,
        at: now(),
        current: score.current,
        max: score.max,
        percentage: score.percentage,
        categories: toSnapshotCategories(score.categories),
      });

      // T-0601 retention applies to the trend source (SPEC §4.2): prune after
      // recording so the on-demand path never grows the store past the window.
      let prunedSnapshotsCount = 0;
      if (retentionDays > 0) {
        const pruned = await options.store.pruneSnapshots({ retentionDays });
        prunedSnapshotsCount = pruned.prunedSnapshotsCount;
      }

      return {
        status: 201,
        headers: { "content-type": "application/json" },
        body: { tenantId, snapshot: recorded, prunedSnapshotsCount },
      };
    },
  };

  return [trend, snapshot];
}

export const SECURE_SCORE_TREND_OPENAPI = {
  paths: {
    "/tenants/{tenantId}/secure-score/trend": {
      get: {
        operationId: "getSecureScoreTrend",
        summary: "A tenant's Secure Score snapshots in time order",
        permission: SECURE_SCORE_TREND_PERMISSION,
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
          "200": { description: "The tenant's snapshots, oldest first." },
          "400": { description: "A path parameter is invalid." },
          "401": { description: "Authentication is required." },
          "403": {
            description:
              "The caller lacks the Security.SecureScore.Read permission or the tenant is out of scope.",
          },
        },
      },
    },
    "/tenants/{tenantId}/secure-score/snapshot": {
      post: {
        operationId: "recordSecureScoreSnapshot",
        summary: "Record a Secure Score snapshot on demand",
        permission: SECURE_SCORE_TREND_PERMISSION,
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
          "201": { description: "The recorded snapshot and the pruned-row count." },
          "400": { description: "A path parameter is invalid." },
          "401": { description: "Authentication is required." },
          "403": {
            description:
              "The caller lacks the Security.SecureScore.Read permission or the tenant is out of scope.",
          },
        },
      },
    },
  },
} as const;
