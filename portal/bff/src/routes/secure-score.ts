// Secure Score current-score API (EPIC-031 SPEC.md §2 US-1, §4.1, §6, §7, §8;
// T-0602). Exposes GET /v1/tenants/:tenantId/secure-score returning the latest
// current/max/percentage, the category split, and the improvement-action list
// with points achieved/available and impact.
//
// Secure Score is read-only (SPEC §8): this route performs no writes and the
// worker issues only GET requests. Improvement actions are returned unmapped
// (check/standardKey null); the action-to-check mapping is T-0603's job. The
// BFF-facing field is `check`, matching the remediation routes' rename of the
// registry check reference.
// Requires RBAC `Security.SecureScore.Read` and the tenant in caller scope.
import { AppError, ErrorCodes } from "../errors.js";
import { requireTenantInScope, type Caller } from "../rbac/authorize.js";
import type { RequestContext, Route, RouteResponse } from "../server.js";
import type { FixTarget } from "../domain/secure-score/mapping.js";

export const SECURE_SCORE_PATH = "/v1/tenants/:tenantId/secure-score";
export const SECURE_SCORE_READ_PERMISSION = "Security.SecureScore.Read";
export const SECURE_SCORE_UNAUTHENTICATED = "request.unauthenticated";

export interface SecureScoreCategory {
  readonly category: string;
  readonly achieved: number;
  readonly available: number;
  readonly percentage: number;
}

/** The improvement action as read by the worker, before mapping. */
export interface ProviderSecureScoreAction {
  readonly id: string;
  readonly title: string;
  readonly category: string;
  readonly pointsAchieved: number;
  readonly pointsAvailable: number;
  readonly impact: string;
  readonly implementationStatus: string;
}

export interface ProviderSecureScore {
  readonly tenantId: string;
  readonly current: number;
  readonly max: number;
  readonly percentage: number;
  readonly categories: readonly SecureScoreCategory[];
  readonly actions: readonly ProviderSecureScoreAction[];
}

/** An improvement action decorated with its (possibly absent) remediation link. */
export interface SecureScoreAction extends ProviderSecureScoreAction {
  readonly check: string | null;
  readonly standardKey: string | null;
}

export interface SecureScore {
  readonly tenantId: string;
  readonly current: number;
  readonly max: number;
  readonly percentage: number;
  readonly categories: readonly SecureScoreCategory[];
  readonly actions: readonly SecureScoreAction[];
}

export interface SecureScoreProvider {
  getSecureScore(tenantId: string): Promise<ProviderSecureScore>;
}

/**
 * Resolves each improvement action to its registry check/standard (T-0603).
 * The shipped registry mapping satisfies `resolve`; the wiring supplies it so the
 * route module stays free of filesystem access. `persist` records a mapped
 * target through the T-0601 repository (an unmapped action is never persisted).
 */
export interface SecureScoreActionMapping {
  readonly resolve: (action: ProviderSecureScoreAction) => FixTarget;
  readonly persist?: (target: FixTarget, ctx: RequestContext) => Promise<void>;
}

export interface SecureScoreCaller extends Caller {
  readonly userId?: string;
}

export type SecureScoreAuthorizer = (
  caller: SecureScoreCaller,
  permission: string,
) => void | Promise<void>;

export interface SecureScoreRouteOptions {
  readonly provider: SecureScoreProvider;
  readonly resolveCaller: (ctx: RequestContext) => SecureScoreCaller | undefined;
  readonly authorize?: SecureScoreAuthorizer;
  /** Applies the action→check/standard mapping (T-0603); omitted means unmapped. */
  readonly mapping?: SecureScoreActionMapping;
}

function unauthenticatedError(): AppError {
  return new AppError(SECURE_SCORE_UNAUTHENTICATED, "authentication required", 401);
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
  options: SecureScoreRouteOptions,
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
      "forbidden: missing Security.SecureScore.Read",
      403,
      [{ field: "permission", reason: SECURE_SCORE_READ_PERMISSION }],
    );
  }
}

function toSecureScore(
  score: ProviderSecureScore,
  mapping?: SecureScoreActionMapping,
): { score: SecureScore; mapped: FixTarget[] } {
  const mapped: FixTarget[] = [];
  return {
    score: {
      tenantId: score.tenantId,
      current: score.current,
      max: score.max,
      percentage: score.percentage,
      categories: score.categories,
      actions: score.actions.map((action) => {
        const target = mapping?.resolve(action);
        if (target?.kind === "mapped") mapped.push(target);
        return {
          ...action,
          check: target?.kind === "mapped" ? target.check : null,
          // A portal-standard-only mapping has no registry check but is still
          // linked to its standard; an unmapped action carries neither.
          standardKey:
            target !== undefined && target.kind !== "unmapped" ? target.standardKey : null,
        };
      }),
    },
    mapped,
  };
}

export function createSecureScoreRoutes(options: SecureScoreRouteOptions): Route[] {
  return [
    {
      method: "GET",
      path: SECURE_SCORE_PATH,
      handler: async (ctx: RequestContext): Promise<RouteResponse> => {
        const caller = requireCaller(options.resolveCaller, ctx);
        const tenantId = requireTenantParam(ctx);

        requireTenantInScope(caller, tenantId);
        await ensureRead(options, caller);

        const score = await options.provider.getSecureScore(tenantId);
        const resolved = toSecureScore(score, options.mapping);
        if (options.mapping?.persist) {
          for (const target of resolved.mapped) {
            await options.mapping.persist(target, ctx);
          }
        }
        return {
          status: 200,
          headers: { "content-type": "application/json" },
          body: resolved.score,
        };
      },
    },
  ];
}

export const SECURE_SCORE_OPENAPI = {
  paths: {
    "/tenants/{tenantId}/secure-score": {
      get: {
        operationId: "getSecureScore",
        summary:
          "Latest Secure Score (current/max/percentage), category split, and improvement actions",
        permission: SECURE_SCORE_READ_PERMISSION,
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
              "The tenant's current Secure Score, category split, and improvement actions with points achieved/available and impact.",
          },
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
