// Licence optimization API (EPIC-033 SPEC.md §3.2, §4.2, §6, §11.1; T-0643).
// GET /v1/tenants/:tenantId/licenses/optimization groups assignments into unused
// (assigned but inactive past the configurable window, default 30 days), overused
// (Graph assignment errors), and expiring (upcoming SKU expiry), each row listing
// the affected users. Advisory only: no licence is removed by this endpoint.
// Requires RBAC `Tenant.Licenses.Read` and tenant in caller scope.
import { AppError, ErrorCodes } from "../errors.js";
import { requireTenantInScope, type Caller } from "../rbac/authorize.js";
import type { RequestContext, Route, RouteResponse } from "../server.js";
import { createTenantWorker, raiseWorkerError, type WorkerRunner } from "../adapters/workers.js";
import type { CredentialStoreRow } from "./credentials.js";
import {
  DEFAULT_INACTIVITY_DAYS,
  classifyLicenseOptimization,
  type LicenseOptimizationInput,
  type LicenseOptimizationResult,
} from "../domain/license-optimization.js";

export const LICENSE_OPTIMIZATION_PATH = "/v1/tenants/:tenantId/licenses/optimization";
export const LICENSE_OPTIMIZATION_READ_PERMISSION = "Tenant.Licenses.Read";
export const LICENSE_OPTIMIZATION_UNAUTHENTICATED = "request.unauthenticated";

export type LicenseOptimizationResponse = LicenseOptimizationResult;

export interface LicenseOptimizationProvider {
  getOptimization(tenantId: string, inactivityDays: number): Promise<LicenseOptimizationResponse>;
}

export interface LicenseOptimizationCaller extends Caller {
  readonly userId?: string;
}

export type LicenseOptimizationAuthorizer = (
  caller: LicenseOptimizationCaller,
  permission: string,
) => void | Promise<void>;

export interface LicenseOptimizationRouteOptions {
  readonly provider: LicenseOptimizationProvider;
  readonly resolveCaller: (ctx: RequestContext) => LicenseOptimizationCaller | undefined;
  readonly authorize?: LicenseOptimizationAuthorizer;
}

function unauthenticatedError(): AppError {
  return new AppError(LICENSE_OPTIMIZATION_UNAUTHENTICATED, "authentication required", 401);
}

function requireCaller(
  resolveCaller: (ctx: RequestContext) => LicenseOptimizationCaller | undefined,
  ctx: RequestContext,
): LicenseOptimizationCaller {
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

/** Reads the configurable window from `?inactivityDays=`; defaults to 30. */
export function parseInactivityDays(query: URLSearchParams): number {
  const raw = query.get("inactivityDays");
  if (raw === null || raw.trim().length === 0) {
    return DEFAULT_INACTIVITY_DAYS;
  }
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1 || value > 3650) {
    throw new AppError(ErrorCodes.validationFailed, "inactivityDays must be a positive integer", 400, [
      { field: "inactivityDays", reason: "invalid" },
    ]);
  }
  return value;
}

export function createLicenseOptimizationRoute(options: LicenseOptimizationRouteOptions): Route {
  return {
    method: "GET",
    path: LICENSE_OPTIMIZATION_PATH,
    handler: async (ctx: RequestContext): Promise<RouteResponse> => {
      const caller = requireCaller(options.resolveCaller, ctx);
      const tenantId = requireTenantParam(ctx);

      requireTenantInScope(caller, tenantId);

      if (options.authorize) {
        await options.authorize(caller, LICENSE_OPTIMIZATION_READ_PERMISSION);
      } else {
        const permissions = caller.permissions ?? [];
        if (!permissions.includes(LICENSE_OPTIMIZATION_READ_PERMISSION) && !permissions.includes("*")) {
          throw new AppError(ErrorCodes.forbidden, "forbidden: missing Tenant.Licenses.Read", 403);
        }
      }

      const inactivityDays = parseInactivityDays(ctx.query);
      const response = await options.provider.getOptimization(tenantId, inactivityDays);

      return {
        status: 200,
        headers: { "content-type": "application/json" },
        body: response,
      };
    },
  };
}

export function createLicenseOptimizationProvider(
  run: WorkerRunner,
  credentials: CredentialStoreRow,
): LicenseOptimizationProvider {
  const call = createTenantWorker(run, credentials);
  return {
    async getOptimization(tenantId: string, inactivityDays: number): Promise<LicenseOptimizationResponse> {
      const result = await call<LicenseOptimizationInput>("get-license-optimization.ps1", tenantId, {
        inactivityDays,
      });
      raiseWorkerError(result);
      return classifyLicenseOptimization(result, { inactivityDays });
    },
  };
}

export const LICENSE_OPTIMIZATION_OPENAPI = {
  paths: {
    "/tenants/{tenantId}/licenses/optimization": {
      get: {
        operationId: "getLicenseOptimization",
        summary: "Advisory unused, overused, and expiring licence findings with affected users",
        permission: "Tenant.Licenses.Read",
        security: [{ bearerAuth: [] }],
        parameters: [
          {
            name: "tenantId",
            in: "path",
            required: true,
            schema: { type: "string" },
          },
          {
            name: "inactivityDays",
            in: "query",
            required: false,
            description: "Days without activity before an assigned licence is unused. Defaults to 30.",
            schema: { type: "integer", minimum: 1, maximum: 3650, default: 30 },
          },
        ],
        responses: {
          "200": { description: "Grouped unused, overused, and expiring licences with affected users." },
          "400": { description: "A path or query parameter is invalid." },
          "401": { description: "Authentication is required." },
          "403": { description: "The caller lacks the Tenant.Licenses.Read permission or tenant is out of scope." },
        },
      },
    },
  },
} as const;
