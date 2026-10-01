// Copilot settings read and standards-style apply (EPIC-041 SPEC.md §3.3, §4,
// §7, §8; T-0806).
//
// GET returns the tenant's current Copilot settings. POST .../apply produces a
// plan before any write: `preview: true` returns the current-vs-proposed diff
// with no write; an apply is a tenant write routed through the EPIC-006
// boundary — it requires the admin role plus `integrations.manage` (SPEC §7),
// an explicit confirmation with a reason, and records an audit event with
// before/after. The route performs no tenant writes itself; the service
// applies through the worker's gated executor, failing closed on any setting
// the portal app is not permitted to change.

import { AppError, ErrorCodes } from "../errors.js";
import {
  isAdmin,
  requirePermission,
  requireTenantInScope,
  type Caller,
} from "../rbac/authorize.js";
import type { Permission } from "../rbac/roles.js";
import type { RequestContext, Route, RouteResponse } from "../server.js";
import {
  CopilotSettingsApplyError,
  CopilotSettingsError,
  CopilotSettingsService,
  type CopilotSettings,
} from "./copilot-settings-service.js";

// ─── Paths, permissions, error codes ─────────────────────────────────────────

export const COPILOT_SETTINGS_PATH = "/v1/tenants/:tenantId/copilot/settings";
export const COPILOT_SETTINGS_APPLY_PATH = "/v1/tenants/:tenantId/copilot/settings/apply";

export const COPILOT_SETTINGS_READ_PERMISSION = "integrations.read";
export const COPILOT_SETTINGS_APPLY_PERMISSION = "integrations.manage";

export const COPILOT_SETTINGS_UNAUTHENTICATED = "request.unauthenticated";
export const COPILOT_SETTINGS_ADMIN_REQUIRED = "copilot.admin_required";
export const COPILOT_SETTINGS_CONFIRM_REQUIRED = "copilot.confirm_required";
export const COPILOT_SETTINGS_UNAVAILABLE = "copilot.unavailable";

// ─── Audit event ──────────────────────────────────────────────────────────────

export interface CopilotSettingsAuditEvent {
  readonly tenantId: string;
  readonly action: "copilot.settingsApply";
  readonly targetId: string;
  readonly result: "success" | "failure";
  readonly before: CopilotSettings | null;
  readonly after: CopilotSettings | null;
  readonly error: string | null;
  readonly actorUserId: string | null;
  readonly correlationId: string;
  readonly createdAt: string;
}

// ─── Route options ────────────────────────────────────────────────────────────

export interface CopilotSettingsRouteOptions {
  readonly service: CopilotSettingsService;
  readonly resolveCaller: (ctx: RequestContext) => Caller | undefined;
  readonly authorize?: (caller: Caller, permission: string) => void | Promise<void>;
  readonly recordAudit?: (event: CopilotSettingsAuditEvent) => Promise<void>;
  readonly now?: () => string;
}

export interface CopilotSettingsRequest extends RequestContext {
  readonly body?: unknown;
}

export interface CopilotSettingsCaller extends Caller {
  readonly userId?: string;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function unauthenticatedError(): AppError {
  return new AppError(COPILOT_SETTINGS_UNAUTHENTICATED, "authentication required", 401);
}

function requireCaller(
  resolveCaller: (ctx: RequestContext) => Caller | undefined,
  ctx: RequestContext,
): CopilotSettingsCaller {
  const caller = resolveCaller(ctx);
  if (caller === undefined) {
    throw unauthenticatedError();
  }
  return caller as CopilotSettingsCaller;
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

function requireBodyRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new AppError(ErrorCodes.validationFailed, "Request body must be a JSON object", 400, [
      { field: "body", reason: "invalid" },
    ]);
  }
  return value as Record<string, unknown>;
}

function requireString(record: Record<string, unknown>, field: string): string {
  const value = record[field];
  if (typeof value !== "string" || value.length === 0) {
    throw new AppError(ErrorCodes.validationFailed, `Missing required string field '${field}'`, 400, [
      { field, reason: "required" },
    ]);
  }
  return value;
}

function optionalBoolean(record: Record<string, unknown>, field: string): boolean | null {
  const value = record[field];
  if (value === undefined || value === null) return null;
  if (typeof value !== "boolean") {
    throw new AppError(ErrorCodes.validationFailed, `Field '${field}' must be a boolean`, 400, [
      { field, reason: "invalid" },
    ]);
  }
  return value;
}

function requireProposedSettings(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new AppError(ErrorCodes.validationFailed, "Field 'settings' must be a JSON object", 400, [
      { field: "settings", reason: "invalid" },
    ]);
  }
  return value as Record<string, unknown>;
}

async function ensureAuthorized(
  options: CopilotSettingsRouteOptions,
  caller: Caller,
  permission: string,
): Promise<void> {
  if (options.authorize) {
    await options.authorize(caller, permission);
    return;
  }
  // The integrations.* tokens are not members of the roles.ts Permission union
  // yet (EPIC-038 wires the full taxonomy). Without an authorize seam a caller
  // is denied, which is the safe default for a write-adjacent endpoint.
  requirePermission(caller, permission as Permission);
}

async function writeSettingsAudit(
  options: CopilotSettingsRouteOptions,
  ctx: RequestContext,
  caller: CopilotSettingsCaller,
  tenantId: string,
  before: CopilotSettings | null,
  after: CopilotSettings | null,
  result: "success" | "failure",
  error: string | null,
): Promise<void> {
  if (!options.recordAudit) {
    return;
  }
  const now = options.now ?? (() => new Date().toISOString());
  await options.recordAudit({
    tenantId,
    action: "copilot.settingsApply",
    targetId: tenantId,
    result,
    before,
    after,
    error,
    actorUserId: caller.userId ?? null,
    correlationId: ctx.correlationId,
    createdAt: now(),
  });
}

// ─── Route factory ────────────────────────────────────────────────────────────

export function createCopilotSettingsRoutes(options: CopilotSettingsRouteOptions): Route[] {
  const now = options.now ?? (() => new Date().toISOString());

  // GET /v1/tenants/:tenantId/copilot/settings — current tenant settings.
  async function handleGet(ctx: CopilotSettingsRequest): Promise<RouteResponse> {
    const caller = requireCaller(options.resolveCaller, ctx);
    await ensureAuthorized(options, caller, COPILOT_SETTINGS_READ_PERMISSION);
    const tenantId = requireTenantParam(ctx);
    requireTenantInScope(caller, tenantId);

    const settings = await options.service.getSettings(tenantId);
    return {
      status: 200,
      body: { tenantId, settings, retrievedAt: now() },
    };
  }

  // POST /v1/tenants/:tenantId/copilot/settings/apply — plan preview or apply.
  async function handleApply(ctx: CopilotSettingsRequest): Promise<RouteResponse> {
    const caller = requireCaller(options.resolveCaller, ctx);
    const tenantId = requireTenantParam(ctx);
    const body = requireBodyRecord(ctx.body);

    const preview = optionalBoolean(body, "preview");
    const confirm = optionalBoolean(body, "confirm");

    // Authorize before any tenant read: a preview needs read, an apply is a
    // tenant write gated by the admin role plus integrations.manage (SPEC §7).
    if (preview === true) {
      await ensureAuthorized(options, caller, COPILOT_SETTINGS_READ_PERMISSION);
    } else {
      if (!isAdmin(caller)) {
        throw new AppError(
          COPILOT_SETTINGS_ADMIN_REQUIRED,
          "applying Copilot settings requires the admin role",
          403,
          [{ field: "role", reason: "admin_required" }],
        );
      }
      await ensureAuthorized(options, caller, COPILOT_SETTINGS_APPLY_PERMISSION);
    }
    requireTenantInScope(caller, tenantId);

    const proposed = requireProposedSettings(body["settings"]);

    try {
      if (preview === true) {
        const current = await options.service.getSettings(tenantId);
        const plan = options.service.buildPlan(current, proposed);
        return {
          status: 200,
          body: {
            tenantId,
            dryRun: true,
            current,
            proposed: plan.proposed,
            changes: plan.changes,
            hasChanges: plan.hasChanges,
            applied: null,
          },
        };
      }

      if (confirm !== true) {
        throw new AppError(
          COPILOT_SETTINGS_CONFIRM_REQUIRED,
          'applying Copilot settings requires { "confirm": true } and a reason',
          400,
          [{ field: "confirm", reason: "required" }],
        );
      }
      const reason = requireString(body, "reason");

      const result = await options.service.apply(tenantId, proposed, { dryRun: false });
      await writeSettingsAudit(
        options,
        ctx,
        caller,
        tenantId,
        result.before,
        result.after,
        "success",
        null,
      );
      return {
        status: 200,
        body: {
          tenantId,
          dryRun: false,
          reason,
          before: result.before,
          proposed: result.proposed,
          changes: result.plan.changes,
          hasChanges: result.plan.hasChanges,
          after: result.after,
        },
      };
    } catch (error) {
      if (error instanceof CopilotSettingsApplyError) {
        await writeSettingsAudit(
          options,
          ctx,
          caller,
          tenantId,
          error.before,
          null,
          "failure",
          error.message,
        );
        throw new AppError(COPILOT_SETTINGS_UNAVAILABLE, error.message, 502);
      }
      if (error instanceof CopilotSettingsError) {
        throw new AppError(error.code, error.message, 400, [
          { field: "settings", reason: error.code },
        ]);
      }
      throw error;
    }
  }

  return [
    { method: "GET", path: COPILOT_SETTINGS_PATH, handler: handleGet },
    { method: "POST", path: COPILOT_SETTINGS_APPLY_PATH, handler: handleApply },
  ];
}

// ─── OpenAPI fragment (paths published by the route module, §6) ───────────────

export const COPILOT_SETTINGS_OPENAPI = {
  paths: {
    "/tenants/{tenantId}/copilot/settings": {
      get: {
        operationId: "getCopilotSettings",
        summary: "Read the tenant's current Copilot settings.",
        permission: COPILOT_SETTINGS_READ_PERMISSION,
        security: [{ bearerAuth: [] }],
        parameters: [
          { name: "tenantId", in: "path", required: true, schema: { type: "string" } },
        ],
        responses: {
          "200": { description: "The current settings with their capture time." },
          "401": { description: "Authentication required." },
          "403": { description: "The caller lacks integrations.read or the tenant is out of scope." },
        },
      },
    },
    "/tenants/{tenantId}/copilot/settings/apply": {
      post: {
        operationId: "applyCopilotSettings",
        summary:
          "Preview (preview: true) or apply Copilot settings; apply needs the admin role, integrations.manage, confirm, and a reason",
        permission: COPILOT_SETTINGS_APPLY_PERMISSION,
        security: [{ bearerAuth: [] }],
        parameters: [
          { name: "tenantId", in: "path", required: true, schema: { type: "string" } },
        ],
        responses: {
          "200": {
            description:
              "The plan (preview) or the applied result with before/after and the change list.",
          },
          "400": {
            description:
              "Missing confirmation/reason, a non-permitted setting, or an invalid value.",
          },
          "401": { description: "Authentication required." },
          "403": {
            description:
              "The caller lacks the admin role or integrations.manage, or the tenant is out of scope.",
          },
          "502": { description: "The worker could not apply the settings." },
        },
      },
    },
  },
} as const;
