// Device actions API (EPIC-018 SPEC.md §3.3, §4.1, §6; T-0344).
// Exposes POST /v1/tenants/:tenantId/devices/:deviceId/actions/:action for
// sync and retire. Sync requires no reason; retire requires a short reason.
// Each action appends a DeviceAction record and an audit event. Requires RBAC
// `Endpoint.Device.ReadWrite` and tenant in caller scope.
import { randomUUID } from "node:crypto";
import { AppError, ErrorCodes } from "../errors.js";
import { requireTenantInScope, type Caller } from "../rbac/authorize.js";
import type { DeviceAction, DeviceActionRepository } from "../repository/device-actions.js";
import type { RequestContext, Route, RouteResponse } from "../server.js";

export const DEVICE_ACTIONS_PATH = "/v1/tenants/:tenantId/devices/:deviceId/actions/:action";
export const DEVICE_ACTIONS_PERMISSION = "Endpoint.Device.ReadWrite";

export type DeviceActionKind = "sync" | "retire";

export interface DeviceActionResult {
  readonly tenantId: string;
  readonly deviceId: string;
  readonly action: DeviceActionKind;
  readonly reason: string | null;
  readonly result: string;
  readonly error: string;
  readonly appliedAt: string;
}

export interface DeviceActionProvider {
  applyAction(
    tenantId: string,
    deviceId: string,
    action: DeviceActionKind,
    reason: string,
  ): Promise<DeviceActionResult>;
}

export interface DeviceActionsCaller extends Caller {
  readonly userId?: string;
}

export type DeviceActionsAuthorizer = (
  caller: DeviceActionsCaller,
  permission: string,
) => void | Promise<void>;

export interface DeviceActionsRouteOptions {
  readonly provider: DeviceActionProvider;
  readonly store: Pick<DeviceActionRepository, "appendDeviceAction">;
  readonly resolveCaller: (ctx: RequestContext) => DeviceActionsCaller | undefined;
  readonly authorize?: DeviceActionsAuthorizer;
  readonly now?: () => string;
}

function unauthenticatedError(): AppError {
  return new AppError("request.unauthenticated", "authentication required", 401);
}

function requireCaller(
  resolveCaller: (ctx: RequestContext) => DeviceActionsCaller | undefined,
  ctx: RequestContext,
): DeviceActionsCaller {
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

function parseAction(value: string): DeviceActionKind {
  if (value !== "sync" && value !== "retire") {
    throw new AppError(ErrorCodes.validationFailed, "action must be 'sync' or 'retire'", 400, [
      { field: "action", reason: "invalid" },
    ]);
  }
  return value;
}

export async function applyDeviceAction(
  options: Pick<DeviceActionsRouteOptions, "provider" | "store" | "now">,
  tenantId: string,
  deviceId: string,
  action: DeviceActionKind,
  reason: string,
  actor: string,
): Promise<DeviceActionResult> {
  if (tenantId.trim().length === 0) {
    throw new AppError(ErrorCodes.validationFailed, "tenantId is required", 400);
  }
  if (deviceId.trim().length === 0) {
    throw new AppError(ErrorCodes.validationFailed, "deviceId is required", 400);
  }
  if (action === "retire" && reason.trim().length === 0) {
    throw new AppError(ErrorCodes.validationFailed, "reason is required for retire", 400, [
      { field: "reason", reason: "required" },
    ]);
  }

  const result = await options.provider.applyAction(tenantId, deviceId, action, reason);

  const at = options.now ? options.now() : new Date().toISOString();
  const record: DeviceAction = {
    id: randomUUID(),
    tenantId,
    deviceId,
    action,
    reason: reason.trim().length > 0 ? reason.trim() : null,
    state: result.result === "success" ? "applied" : "failed",
    appliedAt: result.appliedAt,
    appliedBy: actor,
    result: result.result,
  };
  await options.store.appendDeviceAction(record);

  return result;
}

export function createDeviceActionsRoute(options: DeviceActionsRouteOptions): Route[] {
  const handler = async (ctx: RequestContext): Promise<RouteResponse> => {
    const caller = requireCaller(options.resolveCaller, ctx);
    const tenantId = requireParam(ctx, "tenantId");
    const deviceId = requireParam(ctx, "deviceId");
    const action = parseAction(requireParam(ctx, "action"));

    requireTenantInScope(caller, tenantId);

    if (options.authorize) {
      await options.authorize(caller, DEVICE_ACTIONS_PERMISSION);
    } else {
      const permissions = caller.permissions ?? [];
      if (!permissions.includes(DEVICE_ACTIONS_PERMISSION) && !permissions.includes("*")) {
        throw new AppError(ErrorCodes.forbidden, "forbidden: missing devices.actions", 403);
      }
    }

    const body = (ctx.body ?? {}) as Record<string, unknown>;
    const reason = typeof body.reason === "string" ? body.reason : "";
    const actor = (caller as { id?: string }).id ?? "unknown";

    const result = await applyDeviceAction(options, tenantId, deviceId, action, reason, actor);

    return {
      status: 200,
      headers: { "content-type": "application/json" },
      body: result,
    };
  };
  return [{ method: "POST", path: DEVICE_ACTIONS_PATH, handler }];
}

export const DEVICE_ACTIONS_OPENAPI = {
  paths: {
    "/tenants/{tenantId}/devices/{deviceId}/actions/{action}": {
      post: {
        operationId: "applyDeviceAction",
        summary: "Apply a sync or retire action to a managed device",
        permission: "Endpoint.Device.ReadWrite",
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
          {
            name: "action",
            in: "path",
            required: true,
            schema: { type: "string", enum: ["sync", "retire"] },
          },
        ],
        requestBody: {
          required: false,
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: {
                  reason: { type: "string" },
                },
              },
            },
          },
        },
        responses: {
          "200": { description: "The action was applied and recorded." },
          "400": { description: "A required parameter is missing or invalid." },
          "401": { description: "Authentication is required." },
          "403": { description: "The caller lacks the devices.actions permission." },
        },
      },
    },
  },
} as const;
