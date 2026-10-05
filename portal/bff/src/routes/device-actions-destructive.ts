// Destructive device actions API (EPIC-018 SPEC.md §3.3, §4.1, §6, §11.1; T-0345).
// Exposes POST /v1/tenants/:tenantId/devices/:deviceId/actions/:action for
// wipe and fresh-start. Wipe requires typed device-name confirmation and a
// reason; fresh-start requires a destructive confirmation. When the per-tenant
// two-person rule is enabled, wipe stays pending until a second distinct actor
// approves it. Requires RBAC `Endpoint.Device.ReadWrite` and tenant in scope.
import { randomUUID } from "node:crypto";
import { AppError, ErrorCodes } from "../errors.js";
import { requireTenantInScope, type Caller } from "../rbac/authorize.js";
import type { DeviceAction, DeviceActionRepository } from "../repository/device-actions.js";
import type { DeviceActionPolicyRepository } from "../repository/device-action-policies.js";
import type { RequestContext, Route, RouteResponse } from "../server.js";

export const DEVICE_DESTRUCTIVE_ACTIONS_PATH = "/v1/tenants/:tenantId/devices/:deviceId/device-actions/:action";
export const DEVICE_DESTRUCTIVE_ACTIONS_PERMISSION = "Endpoint.Device.ReadWrite";

export type DestructiveActionKind = "wipe" | "fresh-start";

export interface DestructiveActionResult {
  readonly tenantId: string;
  readonly deviceId: string;
  readonly action: DestructiveActionKind;
  readonly reason: string | null;
  readonly state: "applied" | "pending-approval" | "failed";
  readonly result: string;
  readonly error: string;
  readonly appliedAt: string;
}

export interface DestructiveActionProvider {
  applyAction(
    tenantId: string,
    deviceId: string,
    action: DestructiveActionKind,
    reason: string,
  ): Promise<DestructiveActionResult>;
}

export interface DestructiveActionsCaller extends Caller {
  readonly userId?: string;
}

export type DestructiveActionsAuthorizer = (
  caller: DestructiveActionsCaller,
  permission: string,
) => void | Promise<void>;

export interface DestructiveActionsRouteOptions {
  readonly provider: DestructiveActionProvider;
  readonly store: Pick<DeviceActionRepository, "appendDeviceAction">;
  readonly policyStore: Pick<DeviceActionPolicyRepository, "getPolicy">;
  readonly resolveCaller: (ctx: RequestContext) => DestructiveActionsCaller | undefined;
  readonly authorize?: DestructiveActionsAuthorizer;
  readonly now?: () => string;
}

function unauthenticatedError(): AppError {
  return new AppError("request.unauthenticated", "authentication required", 401);
}

function requireCaller(
  resolveCaller: (ctx: RequestContext) => DestructiveActionsCaller | undefined,
  ctx: RequestContext,
): DestructiveActionsCaller {
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

function parseAction(value: string): DestructiveActionKind {
  if (value !== "wipe" && value !== "fresh-start") {
    throw new AppError(ErrorCodes.validationFailed, "action must be 'wipe' or 'fresh-start'", 400, [
      { field: "action", reason: "invalid" },
    ]);
  }
  return value;
}

export async function applyDestructiveAction(
  options: Pick<DestructiveActionsRouteOptions, "provider" | "store" | "policyStore" | "now">,
  tenantId: string,
  deviceId: string,
  deviceName: string,
  action: DestructiveActionKind,
  reason: string,
  typedConfirmation: string,
  actor: string,
): Promise<DestructiveActionResult> {
  if (tenantId.trim().length === 0) {
    throw new AppError(ErrorCodes.validationFailed, "tenantId is required", 400);
  }
  if (deviceId.trim().length === 0) {
    throw new AppError(ErrorCodes.validationFailed, "deviceId is required", 400);
  }

  const at = options.now ? options.now() : new Date().toISOString();

  const needsTwoPersonRule = action === "wipe";
  const policy = await options.policyStore.getPolicy(tenantId);
  const twoPersonRule = needsTwoPersonRule && policy.twoPersonRule;

  const confirmed = typedConfirmation.trim() === deviceName.trim();
  if (!confirmed) {
    throw new AppError(ErrorCodes.validationFailed, "typed confirmation must match the device name", 400, [
      { field: "typedConfirmation", reason: "mismatch" },
    ]);
  }

  if (reason.trim().length === 0) {
    throw new AppError(ErrorCodes.validationFailed, "reason is required", 400, [
      { field: "reason", reason: "required" },
    ]);
  }

  if (twoPersonRule) {
    const record: DeviceAction = {
      id: randomUUID(),
      tenantId,
      deviceId,
      action,
      reason: reason.trim(),
      state: "pending-approval",
      appliedAt: at,
      appliedBy: actor,
      result: "pending",
    };
    await options.store.appendDeviceAction(record);
    return {
      tenantId,
      deviceId,
      action,
      reason: reason.trim(),
      state: "pending-approval",
      result: "pending",
      error: "",
      appliedAt: at,
    };
  }

  const result = await options.provider.applyAction(tenantId, deviceId, action, reason);

  const record: DeviceAction = {
    id: randomUUID(),
    tenantId,
    deviceId,
    action,
    reason: reason.trim(),
    state: result.result === "success" ? "applied" : "failed",
    appliedAt: result.appliedAt,
    appliedBy: actor,
    result: result.result,
  };
  await options.store.appendDeviceAction(record);

  return result;
}

export function createDestructiveActionsRoute(options: DestructiveActionsRouteOptions): Route[] {
  const handler = async (ctx: RequestContext): Promise<RouteResponse> => {
    const caller = requireCaller(options.resolveCaller, ctx);
    const tenantId = requireParam(ctx, "tenantId");
    const deviceId = requireParam(ctx, "deviceId");
    const action = parseAction(requireParam(ctx, "action"));

    requireTenantInScope(caller, tenantId);

    if (options.authorize) {
      await options.authorize(caller, DEVICE_DESTRUCTIVE_ACTIONS_PERMISSION);
    } else {
      const permissions = caller.permissions ?? [];
      if (!permissions.includes(DEVICE_DESTRUCTIVE_ACTIONS_PERMISSION) && !permissions.includes("*")) {
        throw new AppError(ErrorCodes.forbidden, "forbidden: missing devices.actions", 403);
      }
    }

    const body = (ctx.body ?? {}) as Record<string, unknown>;
    const deviceName = typeof body.deviceName === "string" ? body.deviceName : "";
    const reason = typeof body.reason === "string" ? body.reason : "";
    const typedConfirmation = typeof body.typedConfirmation === "string" ? body.typedConfirmation : "";
    const actor = (caller as { id?: string }).id ?? "unknown";

    const result = await applyDestructiveAction(
      options,
      tenantId,
      deviceId,
      deviceName,
      action,
      reason,
      typedConfirmation,
      actor,
    );

    return {
      status: 200,
      headers: { "content-type": "application/json" },
      body: result,
    };
  };
  return [{ method: "POST", path: DEVICE_DESTRUCTIVE_ACTIONS_PATH, handler }];
}

export const DEVICE_DESTRUCTIVE_ACTIONS_OPENAPI = {
  paths: {
    "/tenants/{tenantId}/devices/{deviceId}/device-actions/{action}": {
      post: {
        operationId: "applyDestructiveDeviceAction",
        summary: "Apply a wipe or fresh-start action to a managed device",
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
            schema: { type: "string", enum: ["wipe", "fresh-start"] },
          },
        ],
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["deviceName", "reason", "typedConfirmation"],
                properties: {
                  deviceName: { type: "string" },
                  reason: { type: "string" },
                  typedConfirmation: { type: "string" },
                },
              },
            },
          },
        },
        responses: {
          "200": { description: "The action was applied or is pending approval." },
          "400": { description: "A required parameter is missing or invalid." },
          "401": { description: "Authentication is required." },
          "403": { description: "The caller lacks the devices.actions permission." },
        },
      },
    },
  },
} as const;
