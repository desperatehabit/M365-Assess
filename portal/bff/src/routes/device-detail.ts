// Device detail API (EPIC-018 SPEC.md §2 US-2, §3.2, §6; T-0342).
// Exposes GET /v1/tenants/:tenantId/devices/:deviceId with the §3.2 tab data:
// Overview, Hardware, Software, Policies, Encryption. Requires RBAC
// `Endpoint.Device.Read` and tenant in caller scope.
import { AppError, ErrorCodes } from "../errors.js";
import { requireTenantInScope, type Caller } from "../rbac/authorize.js";
import type { RequestContext, Route, RouteResponse } from "../server.js";

export const DEVICE_DETAIL_PATH = "/v1/tenants/:tenantId/devices/:deviceId";
export const DEVICE_DETAIL_READ_PERMISSION = "Endpoint.Device.Read";

export interface DeviceOverview {
  readonly deviceName: string;
  readonly ownerUpn: string;
  readonly platform: string;
  readonly osVersion: string;
  readonly compliance: string;
  readonly ownership: string;
  readonly lastCheckIn: string;
  readonly enrolled: string;
  readonly serial: string;
  readonly encrypted: boolean;
  readonly deviceType: string;
  readonly managementState: string;
}

export interface DeviceHardware {
  readonly model: string;
  readonly manufacturer: string;
  readonly serialNumber: string;
  readonly storageSpace: number;
  readonly totalStorage: number;
  readonly phoneNumber: string;
  readonly imei: string;
}

export interface DeviceSoftware {
  readonly id: string;
  readonly displayName: string;
  readonly version: string;
  readonly publisher: string;
}

export interface DevicePolicy {
  readonly id: string;
  readonly displayName: string;
  readonly state: string;
  readonly lastReported: string;
  readonly type: string;
}

export interface DeviceEncryption {
  readonly encrypted: boolean;
  readonly keyType: string;
}

export interface DeviceDetailResult {
  readonly tenantId: string;
  readonly deviceId: string;
  readonly overview: DeviceOverview;
  readonly hardware: DeviceHardware;
  readonly software: readonly DeviceSoftware[];
  readonly policies: readonly DevicePolicy[];
  readonly encryption: DeviceEncryption;
  readonly retrievedAt: string;
}

export interface DeviceDetailProvider {
  getDevice(tenantId: string, deviceId: string): Promise<DeviceDetailResult>;
}

export interface DeviceDetailCaller extends Caller {
  readonly userId?: string;
}

export type DeviceDetailAuthorizer = (
  caller: DeviceDetailCaller,
  permission: string,
) => void | Promise<void>;

export interface DeviceDetailRouteOptions {
  readonly provider: DeviceDetailProvider;
  readonly resolveCaller: (ctx: RequestContext) => DeviceDetailCaller | undefined;
  readonly authorize?: DeviceDetailAuthorizer;
}

function unauthenticatedError(): AppError {
  return new AppError("request.unauthenticated", "authentication required", 401);
}

function requireCaller(
  resolveCaller: (ctx: RequestContext) => DeviceDetailCaller | undefined,
  ctx: RequestContext,
): DeviceDetailCaller {
  const caller = resolveCaller(ctx);
  if (caller === undefined) {
    throw unauthenticatedError();
  }
  return caller;
}

function requireParam(ctx: RequestContext, name: string): string {
  const value = ctx.params[name];
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new AppError(ErrorCodes.validationFailed, `${name} is required`, 400, [
      { field: name, reason: "required" },
    ]);
  }
  return value.trim();
}

export function createDeviceDetailRoute(options: DeviceDetailRouteOptions): Route[] {
  const handler = async (ctx: RequestContext): Promise<RouteResponse> => {
    const caller = requireCaller(options.resolveCaller, ctx);
    const tenantId = requireParam(ctx, "tenantId");
    const deviceId = requireParam(ctx, "deviceId");

    requireTenantInScope(caller, tenantId);

    if (options.authorize) {
      await options.authorize(caller, DEVICE_DETAIL_READ_PERMISSION);
    } else {
      const permissions = caller.permissions ?? [];
      if (!permissions.includes(DEVICE_DETAIL_READ_PERMISSION) && !permissions.includes("*")) {
        throw new AppError(ErrorCodes.forbidden, "forbidden: missing devices.read", 403);
      }
    }

    const result = await options.provider.getDevice(tenantId, deviceId);

    return {
      status: 200,
      headers: { "content-type": "application/json" },
      body: result,
    };
  };
  return [{ method: "GET", path: DEVICE_DETAIL_PATH, handler }];
}

export const DEVICE_DETAIL_OPENAPI = {
  paths: {
    "/tenants/{tenantId}/devices/{deviceId}": {
      get: {
        operationId: "getManagedDevice",
        summary: "Get a managed device's detail tabs (overview, hardware, software, policies, encryption)",
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
            name: "deviceId",
            in: "path",
            required: true,
            schema: { type: "string" },
          },
        ],
        responses: {
          "200": { description: "The device's detail tab data." },
          "400": { description: "A required path parameter is missing." },
          "401": { description: "Authentication is required." },
          "403": { description: "The caller lacks the devices.read permission." },
        },
      },
    },
  },
} as const;
