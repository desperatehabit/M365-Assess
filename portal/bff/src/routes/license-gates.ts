// Licence gate API (EPIC-033 SPEC.md §3.5, §6, §7, §9; T-0646).
// Exposes GET /v1/tenants/:tenantId/licenses/gates.
// Returns the per-feature available/gated map (with the required service plan ids)
// backed by the module's licensing-overlay.json, so UI surfaces can render the
// shared license-missing state instead of failing silently.
import { AppError, ErrorCodes } from "../errors.js";
import { requireTenantInScope, type Caller } from "../rbac/authorize.js";
import type { RequestContext, Route, RouteResponse } from "../server.js";

export const LICENSE_GATES_PATH = "/v1/tenants/:tenantId/licenses/gates";
export const LICENSE_GATES_READ_PERMISSION = "licenses.read";
export const LICENSE_GATES_UNAUTHENTICATED = "request.unauthenticated";

export type LicenseGateStatus = "available" | "gated";

export interface LicenseGateFeature {
  readonly status: LicenseGateStatus;
  readonly requiredPlans: readonly string[];
  readonly missingPlans: readonly string[];
}

export interface LicenseGatesResponse {
  readonly tenantId: string;
  readonly gates: Readonly<Record<string, LicenseGateFeature>>;
}

export interface LicenseGatesProvider {
  getLicenseGates(tenantId: string): Promise<LicenseGatesResponse>;
}

export interface LicenseGatesCaller extends Caller {
  readonly userId?: string;
}

export type LicenseGatesAuthorizer = (
  caller: LicenseGatesCaller,
  permission: string,
) => void | Promise<void>;

export interface LicenseGatesRoutesOptions {
  readonly provider: LicenseGatesProvider;
  readonly resolveCaller: (ctx: RequestContext) => LicenseGatesCaller | undefined;
  readonly authorize?: LicenseGatesAuthorizer;
}

function unauthenticatedError(): AppError {
  return new AppError(LICENSE_GATES_UNAUTHENTICATED, "authentication required", 401);
}

function requireCaller(
  resolveCaller: (ctx: RequestContext) => LicenseGatesCaller | undefined,
  ctx: RequestContext,
): LicenseGatesCaller {
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

async function authorizeRead(
  options: LicenseGatesRoutesOptions,
  caller: LicenseGatesCaller,
): Promise<void> {
  if (options.authorize) {
    await options.authorize(caller, LICENSE_GATES_READ_PERMISSION);
    return;
  }
  const permissions = caller.permissions ?? [];
  const allowed = permissions.includes(LICENSE_GATES_READ_PERMISSION) || permissions.includes("*");
  if (!allowed) {
    throw new AppError(
      ErrorCodes.forbidden,
      `forbidden: read requires ${LICENSE_GATES_READ_PERMISSION}`,
      403,
    );
  }
}

export function createLicenseGatesRoutes(options: LicenseGatesRoutesOptions): Route[] {
  return [
    // GET /v1/tenants/:tenantId/licenses/gates
    {
      method: "GET",
      path: LICENSE_GATES_PATH,
      handler: async (ctx: RequestContext): Promise<RouteResponse> => {
        const caller = requireCaller(options.resolveCaller, ctx);
        const tenantId = requireTenantParam(ctx);
        requireTenantInScope(caller, tenantId);
        await authorizeRead(options, caller);

        const result = await options.provider.getLicenseGates(tenantId);
        return {
          status: 200,
          body: result,
        };
      },
    },
  ];
}
