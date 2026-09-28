// Defender status API (EPIC-019 SPEC.md §2 US-1, §3.1, §6; T-0361).
// Exposes GET /v1/tenants/:tenantId/defender/status returning current vs
// recommended per policy area. The data is read live by the worker from the
// module's Defender assessment sources (Get-DefenderPolicyReport.ps1 and the
// Defender*Checks.ps1 collectors); this route performs no writes.
// v1 supports AV/EDR/ASR (SPEC §11.2); the other registry areas are
// surfaced as not-yet-supported. An optional `area` query narrows the
// response to one area: unknown areas return 400, known-but-unsupported
// areas return 501.
// Requires RBAC `Security.Defender.Read` and tenant in caller scope.
import { AppError, ErrorCodes } from "../errors.js";
import { requireTenantInScope, type Caller } from "../rbac/authorize.js";
import type { RequestContext, Route, RouteResponse } from "../server.js";
import {
  isKnownDefenderPolicyArea,
  lookupDefenderPolicyArea,
} from "../domain/defender-policy-areas.js";

export const DEFENDER_STATUS_PATH = "/v1/tenants/:tenantId/defender/status";
export const DEFENDER_STATUS_READ_PERMISSION = "Security.Defender.Read";
export const DEFENDER_STATUS_UNAUTHENTICATED = "request.unauthenticated";

export interface DefenderAreaStatus {
  readonly area: string;
  readonly displayName: string;
  readonly source: string;
  readonly supported: boolean;
  readonly current: string;
  readonly recommended: string;
  readonly status: string;
}

export interface DefenderStatus {
  readonly tenantId: string;
  readonly areas: readonly DefenderAreaStatus[];
}

export interface DefenderStatusProvider {
  getDefenderStatus(tenantId: string): Promise<DefenderStatus>;
}

export interface DefenderStatusCaller extends Caller {
  readonly userId?: string;
}

export type DefenderStatusAuthorizer = (
  caller: DefenderStatusCaller,
  permission: string,
) => void | Promise<void>;

export interface DefenderStatusRouteOptions {
  readonly provider: DefenderStatusProvider;
  readonly resolveCaller: (ctx: RequestContext) => DefenderStatusCaller | undefined;
  readonly authorize?: DefenderStatusAuthorizer;
}

function unauthenticatedError(): AppError {
  return new AppError(DEFENDER_STATUS_UNAUTHENTICATED, "authentication required", 401);
}

function requireCaller(
  resolveCaller: (ctx: RequestContext) => DefenderStatusCaller | undefined,
  ctx: RequestContext,
): DefenderStatusCaller {
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
  options: DefenderStatusRouteOptions,
  caller: DefenderStatusCaller,
): Promise<void> {
  if (options.authorize) {
    await options.authorize(caller, DEFENDER_STATUS_READ_PERMISSION);
    return;
  }
  const permissions = caller.permissions ?? [];
  if (
    !permissions.includes(DEFENDER_STATUS_READ_PERMISSION) &&
    !permissions.includes("*")
  ) {
    throw new AppError(ErrorCodes.forbidden, "forbidden: missing defender.read", 403);
  }
}

function requestedArea(query: URLSearchParams): string | undefined {
  const value = query.get("area");
  if (value === null || value.length === 0) {
    return undefined;
  }
  return value.trim().toLowerCase();
}

function requireSupportedArea(area: string): void {
  if (!isKnownDefenderPolicyArea(area)) {
    throw new AppError(
      ErrorCodes.validationFailed,
      `unknown Defender policy area '${area}'; supported: av, edr, asr, compliance, firewall, exclusions`,
      400,
      [{ field: "area", reason: "unknown" }],
    );
  }
  const entry = lookupDefenderPolicyArea(area);
  if (entry === undefined || !entry.supported) {
    throw new AppError(
      "defender.area.unsupported",
      `Defender policy area '${area}' is not yet supported; supported areas in v1: av, edr, asr`,
      501,
    );
  }
}

export function createDefenderStatusRoutes(options: DefenderStatusRouteOptions): Route[] {
  return [
    {
      method: "GET",
      path: DEFENDER_STATUS_PATH,
      handler: async (ctx: RequestContext): Promise<RouteResponse> => {
        const caller = requireCaller(options.resolveCaller, ctx);
        const tenantId = requireTenantParam(ctx);

        requireTenantInScope(caller, tenantId);
        await ensureRead(options, caller);

        const area = requestedArea(ctx.query);
        if (area !== undefined) {
          requireSupportedArea(area);
        }

        const status = await options.provider.getDefenderStatus(tenantId);
        if (area === undefined) {
          return {
            status: 200,
            headers: { "content-type": "application/json" },
            body: status,
          };
        }
        return {
          status: 200,
          headers: { "content-type": "application/json" },
          body: {
            tenantId: status.tenantId,
            areas: status.areas.filter((entry) => entry.area === area),
          },
        };
      },
    },
  ];
}

export const DEFENDER_STATUS_OPENAPI = {
  paths: {
    "/tenants/{tenantId}/defender/status": {
      get: {
        operationId: "getDefenderStatus",
        summary: "Defender configuration state per policy area (current vs recommended)",
        permission: "Security.Defender.Read",
        security: [{ bearerAuth: [] }],
        parameters: [
          {
            name: "tenantId",
            in: "path",
            required: true,
            schema: { type: "string" },
          },
          {
            name: "area",
            in: "query",
            required: false,
            schema: {
              type: "string",
              enum: ["av", "edr", "asr", "compliance", "firewall", "exclusions"],
            },
          },
        ],
        responses: {
          "200": { description: "The tenant's Defender status per policy area." },
          "400": { description: "A path or query parameter is invalid." },
          "401": { description: "Authentication is required." },
          "403": { description: "The caller lacks the defender.read permission." },
          "501": { description: "The requested policy area is not yet supported." },
        },
      },
    },
  },
} as const;
