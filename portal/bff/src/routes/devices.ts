// Managed device list API (EPIC-018 SPEC.md §2 US-1, §3.1, §6; T-0341).
// Exposes GET /v1/tenants/:tenantId/devices with the §3.1 columns:
// Device name, Owner/UPN, Platform, Compliance, Ownership, Last check-in,
// Enrolled, Serial (plus encrypted and OS version) and filters (platform,
// compliance, ownership, last check-in age, encrypted, search).
// Requires RBAC `Endpoint.Device.Read` and tenant in caller scope.
import { AppError, ErrorCodes } from "../errors.js";
import { parsePagination } from "../pagination.js";
import { requireTenantInScope, type Caller } from "../rbac/authorize.js";
import type { RequestContext, Route, RouteResponse } from "../server.js";

export const DEVICES_PATH = "/v1/tenants/:tenantId/devices";
export const DEVICES_READ_PERMISSION = "Endpoint.Device.Read";
export const DEVICES_UNAUTHENTICATED = "request.unauthenticated";

export interface DeviceItem {
  readonly id: string;
  readonly deviceName: string;
  readonly name: string;
  readonly ownerUpn: string;
  readonly platform: string;
  readonly compliance: string;
  readonly ownership: string;
  readonly lastCheckIn: string;
  readonly enrolled: string;
  readonly serial: string;
  readonly encrypted: boolean;
  readonly osVersion: string;
}

export type DevicesLastCheckIn = "7d" | "30d" | "90d";

export interface DevicesFilter {
  readonly platform?: string;
  readonly compliance?: string;
  readonly ownership?: string;
  readonly lastCheckIn?: DevicesLastCheckIn;
  readonly encrypted?: boolean;
  readonly search?: string;
  readonly cursor: string | null;
  readonly limit: number;
}

export interface DevicesPage {
  readonly tenantId: string;
  readonly totalCount: number;
  readonly items: readonly DeviceItem[];
  readonly nextCursor: string | null;
}

export interface DevicesProvider {
  listDevices(tenantId: string, filter: DevicesFilter): Promise<DevicesPage>;
}

export interface DevicesCaller extends Caller {
  readonly userId?: string;
}

export type DevicesAuthorizer = (
  caller: DevicesCaller,
  permission: string,
) => void | Promise<void>;

export interface DevicesListRouteOptions {
  readonly provider: DevicesProvider;
  readonly resolveCaller: (ctx: RequestContext) => DevicesCaller | undefined;
  readonly authorize?: DevicesAuthorizer;
}

function unauthenticatedError(): AppError {
  return new AppError(DEVICES_UNAUTHENTICATED, "authentication required", 401);
}

function validationError(message: string, field: string): AppError {
  return new AppError(ErrorCodes.validationFailed, message, 400, [
    { field, reason: "invalid" },
  ]);
}

function requireCaller(
  resolveCaller: (ctx: RequestContext) => DevicesCaller | undefined,
  ctx: RequestContext,
): DevicesCaller {
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

function parseBoolean(query: URLSearchParams, name: string): boolean | undefined {
  const value = optionalText(query, name);
  if (value === undefined) {
    return undefined;
  }
  const lower = value.toLowerCase();
  if (lower === "true" || lower === "1") {
    return true;
  }
  if (lower === "false" || lower === "0") {
    return false;
  }
  throw validationError(`${name} must be a boolean (true or false)`, name);
}

function parseLastCheckIn(query: URLSearchParams): DevicesLastCheckIn | undefined {
  const value = optionalText(query, "lastCheckIn");
  if (value === undefined) {
    return undefined;
  }
  if (value !== "7d" && value !== "30d" && value !== "90d") {
    throw validationError("lastCheckIn must be one of: 7d, 30d, 90d", "lastCheckIn");
  }
  return value;
}

export function parseDevicesFilter(query: URLSearchParams): DevicesFilter {
  const pagination = parsePagination(query);
  const platform = optionalText(query, "platform");
  const compliance = optionalText(query, "compliance");
  const ownership = optionalText(query, "ownership");
  const lastCheckIn = parseLastCheckIn(query);
  const encrypted = parseBoolean(query, "encrypted");
  const search = optionalText(query, "search");

  return {
    platform,
    compliance,
    ownership,
    lastCheckIn,
    encrypted,
    search,
    cursor: pagination.cursor,
    limit: pagination.limit,
  };
}

export function createDevicesListRoute(options: DevicesListRouteOptions): Route {
  return {
    method: "GET",
    path: DEVICES_PATH,
    handler: async (ctx: RequestContext): Promise<RouteResponse> => {
      const caller = requireCaller(options.resolveCaller, ctx);
      const tenantId = requireTenantParam(ctx);

      requireTenantInScope(caller, tenantId);

      if (options.authorize) {
        await options.authorize(caller, DEVICES_READ_PERMISSION);
      } else {
        const permissions = caller.permissions ?? [];
        if (!permissions.includes(DEVICES_READ_PERMISSION) && !permissions.includes("*")) {
          throw new AppError(ErrorCodes.forbidden, "forbidden: missing devices.read", 403);
        }
      }

      const filter = parseDevicesFilter(ctx.query);
      const page = await options.provider.listDevices(tenantId, filter);

      return {
        status: 200,
        headers: { "content-type": "application/json" },
        body: page,
      };
    },
  };
}

export const DEVICES_OPENAPI = {
  paths: {
    "/tenants/{tenantId}/devices": {
      get: {
        operationId: "listManagedDevices",
        summary: "List, search, and filter managed devices",
        permission: "Endpoint.Device.Read",
        security: [{ bearerAuth: [] }],
        parameters: [
          {
            name: "tenantId",
            in: "path",
            required: true,
            schema: { type: "string" },
          },
          {
            name: "platform",
            in: "query",
            required: false,
            schema: { type: "string" },
          },
          {
            name: "compliance",
            in: "query",
            required: false,
            schema: { type: "string" },
          },
          {
            name: "ownership",
            in: "query",
            required: false,
            schema: { type: "string" },
          },
          {
            name: "lastCheckIn",
            in: "query",
            required: false,
            schema: { type: "string", enum: ["7d", "30d", "90d"] },
          },
          {
            name: "encrypted",
            in: "query",
            required: false,
            schema: { type: "boolean" },
          },
          {
            name: "search",
            in: "query",
            required: false,
            schema: { type: "string" },
          },
        ],
        responses: {
          "200": { description: "The tenant's managed devices, cursor-paginated." },
          "400": { description: "A filter parameter is invalid." },
          "401": { description: "Authentication is required." },
          "403": { description: "The caller lacks the devices.read permission." },
        },
      },
    },
  },
} as const;
