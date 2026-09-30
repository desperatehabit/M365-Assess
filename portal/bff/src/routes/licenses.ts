// License consumption report API (EPIC-033 SPEC.md §3.1, §4.1, §6; T-0642).
// Exposes GET /v1/tenants/:tenantId/licenses returning per-SKU enabled/assigned/
// available/utilization with monthly cost from pricing (global seed + per-tenant
// override). An unpriced SKU reports "no pricing" rather than zero (SPEC §9).
// Requires RBAC `licenses.read` and tenant in caller scope.
import { AppError, ErrorCodes } from "../errors.js";
import { requireTenantInScope, type Caller } from "../rbac/authorize.js";
import type { RequestContext, Route, RouteResponse } from "../server.js";
import { createTenantWorker, raiseWorkerError, type WorkerRunner } from "../adapters/workers.js";
import type { CredentialStoreRow } from "./credentials.js";

export const LICENSES_PATH = "/v1/tenants/:tenantId/licenses";
export const LICENSES_READ_PERMISSION = "licenses.read";
export const LICENSES_UNAUTHENTICATED = "request.unauthenticated";

export interface LicenseItem {
  readonly skuId: string;
  readonly skuPartNumber: string;
  readonly license: string;
  readonly enabled: number;
  readonly assigned: number;
  readonly available: number;
  readonly suspended: number;
  readonly warning: number;
  readonly utilizationPct: number;
  readonly monthlyCost: string | number;
  readonly currency: string;
}

export interface LicensesResponse {
  readonly tenantId: string;
  readonly items: readonly LicenseItem[];
}

export interface LicensesProvider {
  getLicenses(tenantId: string): Promise<LicensesResponse>;
}

export interface LicensePricingRow {
  readonly skuId: string;
  readonly unitPrice: number;
  readonly currency: string;
}

export interface LicensesPricingSource {
  listLicensePricing(tenantId: string): Promise<LicensePricingRow[]>;
}

export interface LicensesCaller extends Caller {
  readonly userId?: string;
}

export type LicensesAuthorizer = (
  caller: LicensesCaller,
  permission: string,
) => void | Promise<void>;

export interface LicensesRouteOptions {
  readonly provider: LicensesProvider;
  readonly resolveCaller: (ctx: RequestContext) => LicensesCaller | undefined;
  readonly authorize?: LicensesAuthorizer;
}

function unauthenticatedError(): AppError {
  return new AppError(LICENSES_UNAUTHENTICATED, "authentication required", 401);
}

function requireCaller(
  resolveCaller: (ctx: RequestContext) => LicensesCaller | undefined,
  ctx: RequestContext,
): LicensesCaller {
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

export function createLicensesRoute(options: LicensesRouteOptions): Route {
  return {
    method: "GET",
    path: LICENSES_PATH,
    handler: async (ctx: RequestContext): Promise<RouteResponse> => {
      const caller = requireCaller(options.resolveCaller, ctx);
      const tenantId = requireTenantParam(ctx);

      requireTenantInScope(caller, tenantId);

      if (options.authorize) {
        await options.authorize(caller, LICENSES_READ_PERMISSION);
      } else {
        const permissions = caller.permissions ?? [];
        if (!permissions.includes(LICENSES_READ_PERMISSION) && !permissions.includes("*")) {
          throw new AppError(ErrorCodes.forbidden, "forbidden: missing licenses.read", 403);
        }
      }

      const response = await options.provider.getLicenses(tenantId);

      return {
        status: 200,
        headers: { "content-type": "application/json" },
        body: response,
      };
    },
  };
}

export function createLicensesProvider(
  run: WorkerRunner,
  credentials: CredentialStoreRow,
  pricing: LicensesPricingSource,
): LicensesProvider {
  const call = createTenantWorker(run, credentials);
  return {
    async getLicenses(tenantId: string): Promise<LicensesResponse> {
      const pricingRows = await pricing.listLicensePricing(tenantId);
      const result = await call<LicensesResponse>("get-license-report.ps1", tenantId, {
        pricing: pricingRows,
      });
      raiseWorkerError(result);
      return result;
    },
  };
}

export const LICENSES_OPENAPI = {
  paths: {
    "/tenants/{tenantId}/licenses": {
      get: {
        operationId: "getLicenses",
        summary: "License consumption per SKU with utilization and cost",
        permission: "licenses.read",
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
          "200": { description: "Per-SKU license consumption with utilization and monthly cost." },
          "400": { description: "A path parameter is invalid." },
          "401": { description: "Authentication is required." },
          "403": { description: "The caller lacks the licenses.read permission or tenant is out of scope." },
        },
      },
    },
  },
} as const;