// MDE onboarding coverage API (EPIC-019 SPEC.md §2 US-5, §3.5, §4.4, §6; T-0370).
// Exposes GET /v1/tenants/:tenantId/defender/mde-onboarding returning
// onboarded vs total devices by platform with gap lists. Coverage is computed
// by the worker from EPIC-018 device records plus the T-0361 Defender state
// (SPEC §4.4); each gap carries the onboarding deployment policy link
// (SPEC §3.5). This route performs no writes.
// Requires RBAC `Security.Defender.Read` (defender.read) and tenant in caller scope.
import { AppError, ErrorCodes } from "../errors.js";
import { requireTenantInScope, type Caller } from "../rbac/authorize.js";
import type { RequestContext, Route, RouteResponse } from "../server.js";

export const MDE_ONBOARDING_PATH = "/v1/tenants/:tenantId/defender/mde-onboarding";
export const MDE_ONBOARDING_READ_PERMISSION = "Security.Defender.Read";
export const MDE_ONBOARDING_UNAUTHENTICATED = "request.unauthenticated";

export interface MdeOnboardingGap {
  readonly id: string;
  readonly deviceName: string;
  readonly platform: string;
  readonly policyUrl: string;
}

export interface MdeOnboardingPlatformCoverage {
  readonly platform: string;
  readonly total: number;
  readonly onboarded: number;
  readonly notOnboarded: number;
  readonly coveragePct: number;
  readonly gaps: readonly MdeOnboardingGap[];
}

export interface MdeOnboardingTotals {
  readonly total: number;
  readonly onboarded: number;
  readonly notOnboarded: number;
  readonly coveragePct: number;
}

export interface MdeOnboarding {
  readonly tenantId: string;
  readonly deploymentPolicyUrl: string;
  readonly platforms: readonly MdeOnboardingPlatformCoverage[];
  readonly totals: MdeOnboardingTotals;
}

export interface MdeOnboardingProvider {
  getMdeOnboarding(tenantId: string): Promise<MdeOnboarding>;
}

export interface MdeOnboardingCaller extends Caller {
  readonly userId?: string;
}

export type MdeOnboardingAuthorizer = (
  caller: MdeOnboardingCaller,
  permission: string,
) => void | Promise<void>;

export interface MdeOnboardingRouteOptions {
  readonly provider: MdeOnboardingProvider;
  readonly resolveCaller: (ctx: RequestContext) => MdeOnboardingCaller | undefined;
  readonly authorize?: MdeOnboardingAuthorizer;
}

function unauthenticatedError(): AppError {
  return new AppError(MDE_ONBOARDING_UNAUTHENTICATED, "authentication required", 401);
}

function requireCaller(
  resolveCaller: (ctx: RequestContext) => MdeOnboardingCaller | undefined,
  ctx: RequestContext,
): MdeOnboardingCaller {
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
  options: MdeOnboardingRouteOptions,
  caller: MdeOnboardingCaller,
): Promise<void> {
  if (options.authorize) {
    await options.authorize(caller, MDE_ONBOARDING_READ_PERMISSION);
    return;
  }
  const permissions = caller.permissions ?? [];
  if (
    !permissions.includes(MDE_ONBOARDING_READ_PERMISSION) &&
    !permissions.includes("*")
  ) {
    throw new AppError(ErrorCodes.forbidden, "forbidden: missing defender.read", 403);
  }
}

export function createMdeOnboardingRoutes(options: MdeOnboardingRouteOptions): Route[] {
  return [
    {
      method: "GET",
      path: MDE_ONBOARDING_PATH,
      handler: async (ctx: RequestContext): Promise<RouteResponse> => {
        const caller = requireCaller(options.resolveCaller, ctx);
        const tenantId = requireTenantParam(ctx);

        requireTenantInScope(caller, tenantId);
        await ensureRead(options, caller);

        const coverage = await options.provider.getMdeOnboarding(tenantId);
        return {
          status: 200,
          headers: { "content-type": "application/json" },
          body: coverage,
        };
      },
    },
  ];
}

export const MDE_ONBOARDING_OPENAPI = {
  paths: {
    "/tenants/{tenantId}/defender/mde-onboarding": {
      get: {
        operationId: "getMdeOnboarding",
        summary: "MDE onboarding coverage: onboarded vs total devices by platform with gaps",
        permission: "Security.Defender.Read",
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
          "200": { description: "The tenant's MDE onboarding coverage by platform." },
          "400": { description: "A path parameter is invalid." },
          "401": { description: "Authentication is required." },
          "403": { description: "The caller lacks the defender.read permission." },
        },
      },
    },
  },
} as const;
