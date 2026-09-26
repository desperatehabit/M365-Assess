// Tenant user directory read (EPIC-011 SPEC §3.1, §3.2, §4.1, §6, §11.2).
// GET /v1/tenants/{id}/users lists, searches, and filters tenant users with
// the §3.1 columns (display name, UPN, type, licenses, MFA state, last
// sign-in, status, department) as a cursor-paginated page. The inactive,
// guest, and sign-in report views share this read: `?report=` maps onto the
// same provider call with preset filters. User objects are never mirrored;
// the injected provider is backed by the worker queue (T-0010) running the
// Get-TenantUsers child job live against Graph, so this module holds no Graph
// client and issues no tenant write. Reads require `users.read` (SPEC §7)
// intersected with the caller tenant scope.
import { AppError, ErrorCodes } from "../errors.js";
import { parsePagination } from "../pagination.js";
import { requireTenantInScope, type Caller } from "../rbac/authorize.js";
import type { RequestContext, Route, RouteResponse } from "../server.js";

export const TENANT_USERS_PATH = "/v1/tenants/:tenantId/users";
export const USERS_PERMISSION = "users.read";

export const USERS_UNAUTHENTICATED = "request.unauthenticated";
export const USERS_REPORT_CONFLICT = "users.report_conflict";

export type TenantUserType = "member" | "guest";
export type TenantUserStatus = "enabled" | "disabled";
export type TenantUserLicense = "licensed" | "unlicensed";
export type TenantUserMfaState = "registered" | "notRegistered" | "unknown";
export type TenantUsersReport = "inactive" | "guest" | "signin";

export interface TenantUser {
  readonly id: string;
  readonly displayName: string | null;
  readonly userPrincipalName: string;
  readonly userType: TenantUserType;
  readonly licenses: readonly string[];
  readonly mfaState: TenantUserMfaState;
  readonly lastSignInDateTime: string | null;
  readonly status: TenantUserStatus;
  readonly department: string | null;
}

export interface TenantUsersFilter {
  readonly search?: string;
  readonly status?: TenantUserStatus;
  readonly type?: TenantUserType;
  readonly license?: TenantUserLicense;
  readonly mfaState?: TenantUserMfaState;
  readonly department?: string;
  readonly inactiveDays?: number;
  readonly report?: TenantUsersReport;
  readonly cursor: string | null;
  readonly limit: number;
}

export interface TenantUsersPage {
  readonly items: readonly TenantUser[];
  readonly nextCursor: string | null;
}

// Queue-backed seam for the directory read: the production wiring enqueues a
// tenant-users worker job for (tenantId, filter) and serves the worker page.
// Depending on the seam keeps Graph and process code out of the BFF.
export interface TenantUsersProvider {
  listUsers(tenantId: string, filter: TenantUsersFilter): Promise<TenantUsersPage>;
}

export interface UsersCaller extends Caller {
  readonly userId?: string;
}

export type UsersAuthorizer = (
  caller: UsersCaller,
  permission: string,
) => void | Promise<void>;

export interface TenantUsersRouteOptions {
  readonly provider: TenantUsersProvider;
  readonly resolveCaller: (ctx: RequestContext) => UsersCaller | undefined;
  readonly authorize?: UsersAuthorizer;
}

function unauthenticatedError(): AppError {
  return new AppError(USERS_UNAUTHENTICATED, "authentication required", 401);
}

function validationError(message: string, field: string): AppError {
  return new AppError(ErrorCodes.validationFailed, message, 400, [
    { field, reason: "invalid" },
  ]);
}

function requireCaller(
  resolveCaller: (ctx: RequestContext) => UsersCaller | undefined,
  ctx: RequestContext,
): UsersCaller {
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

function optionalText(query: URLSearchParams, name: string): string | undefined {
  const value = query.get(name);
  if (value === null || value.length === 0) {
    return undefined;
  }
  return value;
}

function parseEnum<T extends string>(
  query: URLSearchParams,
  name: string,
  allowed: readonly T[],
): T | undefined {
  const value = optionalText(query, name);
  if (value === undefined) {
    return undefined;
  }
  if (!(allowed as readonly string[]).includes(value)) {
    throw validationError(`${name} must be one of: ${allowed.join(", ")}`, name);
  }
  return value as T;
}

function parseInactiveDays(query: URLSearchParams): number | undefined {
  const value = optionalText(query, "inactiveDays");
  if (value === undefined) {
    return undefined;
  }
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 3650) {
    throw validationError("inactiveDays must be an integer between 1 and 3650", "inactiveDays");
  }
  return parsed;
}

const USER_STATUSES: readonly TenantUserStatus[] = ["enabled", "disabled"];
const USER_TYPES: readonly TenantUserType[] = ["member", "guest"];
const USER_LICENSES: readonly TenantUserLicense[] = ["licensed", "unlicensed"];
const USER_MFA_STATES: readonly TenantUserMfaState[] = ["registered", "notRegistered", "unknown"];
const USER_REPORTS: readonly TenantUsersReport[] = ["inactive", "guest", "signin"];

export const DEFAULT_INACTIVE_REPORT_DAYS = 90;

export function parseTenantUsersFilter(query: URLSearchParams): TenantUsersFilter {
  const pagination = parsePagination(query);
  const report = parseEnum(query, "report", USER_REPORTS);
  const type = parseEnum(query, "type", USER_TYPES);
  if (report === "guest" && type !== undefined && type !== "guest") {
    throw new AppError(
      USERS_REPORT_CONFLICT,
      "report=guest cannot be combined with a non-guest type filter",
      400,
      [{ field: "type", reason: "conflict" }],
    );
  }
  const inactiveDays = parseInactiveDays(query);
  const search = optionalText(query, "search");
  const status = parseEnum(query, "status", USER_STATUSES);
  const license = parseEnum(query, "license", USER_LICENSES);
  const mfaState = parseEnum(query, "mfaState", USER_MFA_STATES);
  const department = optionalText(query, "department");
  const filter: { -readonly [K in keyof TenantUsersFilter]: TenantUsersFilter[K] } = {
    cursor: pagination.cursor,
    limit: pagination.limit,
  };
  if (search !== undefined) {
    filter.search = search;
  }
  if (status !== undefined) {
    filter.status = status;
  }
  if (license !== undefined) {
    filter.license = license;
  }
  if (mfaState !== undefined) {
    filter.mfaState = mfaState;
  }
  if (department !== undefined) {
    filter.department = department;
  }
  if (report === "guest") {
    filter.type = "guest";
  } else if (type !== undefined) {
    filter.type = type;
  }
  if (report === "inactive") {
    filter.report = report;
    filter.inactiveDays = inactiveDays ?? DEFAULT_INACTIVE_REPORT_DAYS;
  } else {
    if (inactiveDays !== undefined) {
      filter.inactiveDays = inactiveDays;
    }
    if (report !== undefined) {
      filter.report = report;
    }
  }
  return filter;
}

export async function getTenantUsers(
  provider: TenantUsersProvider,
  tenantId: string,
  filter: TenantUsersFilter,
): Promise<{ status: number; body: TenantUsersPage }> {
  if (tenantId.trim().length === 0) {
    throw new AppError(ErrorCodes.validationFailed, "tenantId is required", 400, [
      { field: "tenantId", reason: "required" },
    ]);
  }
  const page = await provider.listUsers(tenantId, filter);
  return { status: 200, body: { items: [...page.items], nextCursor: page.nextCursor } };
}

export function createTenantUsersRoute(options: TenantUsersRouteOptions): Route[] {
  const handler = async (ctx: RequestContext): Promise<RouteResponse> => {
    const caller = requireCaller(options.resolveCaller, ctx);
    if (options.authorize) {
      await options.authorize(caller, USERS_PERMISSION);
    }
    const tenantId = requireTenantParam(ctx);
    requireTenantInScope(caller, tenantId);
    const filter = parseTenantUsersFilter(ctx.query);
    const result = await getTenantUsers(options.provider, tenantId, filter);
    return { status: result.status, body: result.body };
  };
  return [{ method: "GET", path: TENANT_USERS_PATH, handler }];
}

// Route modules own their OpenAPI path items (portal.v1.yaml `paths` is empty
// by design); a wiring ticket merges this fragment into the served document.
export const USERS_OPENAPI = {
  paths: {
    "/tenants/{tenantId}/users": {
      get: {
        operationId: "listTenantUsers",
        summary: "List, search, and filter tenant users (filter: status/type/license/mfaState/department/sign-in age/report)",
        permission: USERS_PERMISSION,
        security: [{ bearerAuth: [] }],
        parameters: [
          { name: "tenantId", in: "path", required: true, schema: { type: "string" } },
          { name: "search", in: "query", required: false, schema: { type: "string" } },
          {
            name: "status",
            in: "query",
            required: false,
            schema: { type: "string", enum: ["enabled", "disabled"] },
          },
          {
            name: "type",
            in: "query",
            required: false,
            schema: { type: "string", enum: ["member", "guest"] },
          },
          {
            name: "license",
            in: "query",
            required: false,
            schema: { type: "string", enum: ["licensed", "unlicensed"] },
          },
          {
            name: "mfaState",
            in: "query",
            required: false,
            schema: { type: "string", enum: ["registered", "notRegistered", "unknown"] },
          },
          { name: "department", in: "query", required: false, schema: { type: "string" } },
          {
            name: "inactiveDays",
            in: "query",
            required: false,
            schema: { type: "integer", minimum: 1, maximum: 3650 },
          },
          {
            name: "report",
            in: "query",
            required: false,
            schema: { type: "string", enum: ["inactive", "guest", "signin"] },
          },
          { name: "cursor", in: "query", required: false, schema: { type: "string" } },
          { name: "limit", in: "query", required: false, schema: { type: "integer" } },
        ],
        responses: {
          "200": { description: "Cursor-paginated users with the §3.1 columns." },
          "400": { description: "An unsupported filter value was supplied." },
          "401": { description: "Authentication required." },
          "403": { description: "The caller lacks users.read or the tenant is out of scope." },
        },
      },
    },
  },
} as const;
