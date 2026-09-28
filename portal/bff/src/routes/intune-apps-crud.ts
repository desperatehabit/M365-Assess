// Intune app detail, update, and delete (EPIC-017 SPEC.md §3.1, §7, §8; T-0843).
//
//   GET    /v1/tenants/:tenantId/apps/:appId   one app's configuration (upload / template shape)
//   PATCH  /v1/tenants/:tenantId/apps/:appId   update metadata, commands, install experience, rules
//   DELETE /v1/tenants/:tenantId/apps/:appId   delete; applying needs `confirmName` = the app name
//
// Mount after the fixed /apps/* paths (queue, status, upload, packages): `:appId` would
// otherwise capture them. Reads need `Endpoint.Application.Read`; writes the T-0108 seam
// (`Endpoint.Application.ReadWrite` or `Remediation.Apply`), `preview` returning the plan
// with before/after, and the worker's audit event recorded for every applied write.
import { AppError, ErrorCodes } from "../errors.js";
import { RbacErrorCodes, requireTenantInScope, type Caller } from "../rbac/authorize.js";
import type { RequestContext, Route, RouteResponse } from "../server.js";
import { INTUNE_APPS_READ_PERMISSION, INTUNE_APPS_WRITE_PERMISSION } from "./intune-apps.js";

export const INTUNE_APP_PATH = "/v1/tenants/:tenantId/apps/:appId";
export const REMEDIATION_APPLY_PERMISSION = "Remediation.Apply";
/** Fixed /apps/* segments another route owns; never treated as an app id. */
export const RESERVED_APP_SEGMENTS = ["queue", "status", "upload", "packages"] as const;

const RUN_AS = ["system", "user"];
const RESTART = ["allow", "basedOnReturnCode", "suppress", "force"];
const ARCHITECTURES = ["x86", "x64", "arm64"];
const RULE_TYPES = ["file", "registry", "msi", "script"];
const TEXT_FIELDS: Record<string, number> = {
  displayName: 256,
  description: 10_000,
  publisher: 256,
  installCommandLine: 1024,
  uninstallCommandLine: 1024,
  minimumSupportedWindowsRelease: 16,
};

export interface IntuneAppDetail {
  readonly id: string;
  readonly appType: "win32" | "store";
  readonly odataType: string;
  readonly displayName: string;
  readonly description: string;
  readonly publisher: string;
  readonly runAsAccount: string;
  readonly assignmentCount: number;
  readonly packageIdentifier?: string;
  readonly installCommandLine?: string;
  readonly uninstallCommandLine?: string;
  readonly deviceRestartBehavior?: string;
  readonly applicableArchitectures?: readonly string[];
  readonly minimumSupportedWindowsRelease?: string;
  readonly detectionRules?: readonly Record<string, unknown>[];
}

export interface IntuneAppChangeRequest {
  readonly action: "update" | "delete";
  readonly changes?: Record<string, unknown>;
  readonly confirmName?: string;
  readonly preview: boolean;
  readonly actor: string;
}

export interface IntuneAppChangeResult {
  readonly preview: boolean;
  readonly applied: boolean;
  readonly plan: Record<string, unknown>;
  readonly error?: string | null;
  readonly auditEvent?: Record<string, unknown> | null;
}

export interface IntuneAppWorkerError {
  readonly error: string;
  readonly message: string;
  readonly statusCode: number;
}

/** Runs set-intune-app.ps1 for one tenant. */
export interface IntuneAppCrudProvider {
  getApp(tenantId: string, appId: string): Promise<IntuneAppDetail | IntuneAppWorkerError>;
  changeApp(tenantId: string, appId: string, request: IntuneAppChangeRequest): Promise<IntuneAppChangeResult | IntuneAppWorkerError>;
}

export interface IntuneAppCrudCaller extends Caller {
  readonly userId?: string;
  readonly permissions?: readonly string[];
}

export interface IntuneAppCrudRoutesOptions {
  readonly provider: IntuneAppCrudProvider;
  readonly resolveCaller: (ctx: RequestContext) => IntuneAppCrudCaller | undefined;
  readonly authorize?: (caller: IntuneAppCrudCaller, permission: string) => boolean;
  readonly recordAudit?: (event: Record<string, unknown>) => Promise<void>;
}

function invalid(message: string, field: string, reason = "invalid"): AppError {
  return new AppError(ErrorCodes.validationFailed, message, 400, [{ field, reason }]);
}

function isWorkerError(value: unknown): value is IntuneAppWorkerError {
  return value !== null && typeof value === "object" && "error" in value && "statusCode" in value;
}

/** Validates a PATCH body's `changes`; which fields apply to which app type is the worker's call. */
export function parseAppChanges(input: unknown): Record<string, unknown> {
  if (input === null || typeof input !== "object" || Array.isArray(input)) throw invalid("changes must be an object", "changes");
  const changes = input as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(changes)) {
    if (key in TEXT_FIELDS) {
      if (typeof value !== "string") throw invalid(`${key} must be a string`, "changes");
      const trimmed = value.trim();
      if (trimmed.length > TEXT_FIELDS[key]!) throw invalid(`${key} is too long`, "changes");
      if (["displayName", "publisher", "installCommandLine", "uninstallCommandLine"].includes(key) && !trimmed) {
        throw invalid(`${key} cannot be empty`, "changes");
      }
      out[key] = trimmed;
    } else if (key === "runAsAccount") {
      if (!RUN_AS.includes(value as string)) throw invalid(`runAsAccount must be one of: ${RUN_AS.join(", ")}`, "changes");
      out[key] = value;
    } else if (key === "deviceRestartBehavior") {
      if (!RESTART.includes(value as string)) throw invalid(`deviceRestartBehavior must be one of: ${RESTART.join(", ")}`, "changes");
      out[key] = value;
    } else if (key === "applicableArchitectures") {
      if (!Array.isArray(value) || value.length === 0 || !value.every((a) => ARCHITECTURES.includes(a as string))) {
        throw invalid(`applicableArchitectures must list: ${ARCHITECTURES.join(", ")}`, "changes");
      }
      out[key] = [...new Set(value)];
    } else if (key === "detectionRules") {
      if (!Array.isArray(value) || value.length === 0) throw invalid("detectionRules must be a non-empty array", "changes");
      value.forEach((rule, i) => {
        if (rule === null || typeof rule !== "object" || !RULE_TYPES.includes((rule as Record<string, unknown>)["type"] as string)) {
          throw invalid(`detectionRules[${i}].type must be one of: ${RULE_TYPES.join(", ")}`, "changes");
        }
      });
      out[key] = value;
    } else {
      throw invalid(`'${key}' cannot be changed here`, "changes");
    }
  }
  if (Object.keys(out).length === 0) throw invalid("no changes supplied", "changes", "required");
  return out;
}

export function createIntuneAppCrudRoutes(options: IntuneAppCrudRoutesOptions): Route[] {
  const authorize =
    options.authorize ??
    ((caller: IntuneAppCrudCaller, permission: string) => {
      const granted = caller.permissions ?? [];
      return granted.includes(permission) || granted.includes("*");
    });

  const scope = (ctx: RequestContext, write: boolean): { caller: IntuneAppCrudCaller; tenantId: string; appId: string } => {
    const caller = options.resolveCaller(ctx);
    if (caller === undefined) throw new AppError("request.unauthenticated", "authentication required", 401);
    const tenantId = ctx.params["tenantId"]?.trim();
    const appId = ctx.params["appId"]?.trim();
    if (!tenantId) throw invalid("tenantId is required", "tenantId", "required");
    if (!appId || (RESERVED_APP_SEGMENTS as readonly string[]).includes(appId)) {
      throw new AppError(ErrorCodes.routeNotFound, `No route for ${ctx.method} ${ctx.path}`, 404);
    }
    requireTenantInScope(caller, tenantId);
    const needed = write ? [INTUNE_APPS_WRITE_PERMISSION, REMEDIATION_APPLY_PERMISSION] : [INTUNE_APPS_READ_PERMISSION, INTUNE_APPS_WRITE_PERMISSION];
    if (!needed.some((p) => authorize(caller, p))) {
      throw new AppError(RbacErrorCodes.forbidden, `forbidden: requires ${needed.join(" or ")}`, 403);
    }
    return { caller, tenantId, appId };
  };

  const change = async (ctx: RequestContext, action: "update" | "delete"): Promise<RouteResponse> => {
    const { caller, tenantId, appId } = scope(ctx, true);
    const body = (ctx.body ?? {}) as Record<string, unknown>;
    if (typeof body !== "object" || Array.isArray(body)) throw invalid("Request body must be a JSON object", "body");
    const preview = body["preview"] === true || ctx.query.get("preview") === "true";
    const request: IntuneAppChangeRequest =
      action === "update"
        ? { action, changes: parseAppChanges(body["changes"]), preview, actor: caller.userId ?? "unknown" }
        : {
            action,
            confirmName: typeof body["confirmName"] === "string" ? body["confirmName"] : (ctx.query.get("confirmName") ?? ""),
            preview,
            actor: caller.userId ?? "unknown",
          };
    const result = await options.provider.changeApp(tenantId, appId, request);
    if (isWorkerError(result)) throw new AppError(result.error, result.message, result.statusCode);
    if (result.auditEvent) await options.recordAudit?.(result.auditEvent);
    if (!result.preview && result.error) throw new AppError(`intune.app.${action}_failed`, `${action} failed: ${result.error}`, 502);
    const { auditEvent: _omit, ...response } = result;
    return { status: 200, body: { tenantId, appId, ...response } };
  };

  return [
    {
      method: "GET",
      path: INTUNE_APP_PATH,
      handler: async (ctx): Promise<RouteResponse> => {
        const { tenantId, appId } = scope(ctx, false);
        const app = await options.provider.getApp(tenantId, appId);
        if (isWorkerError(app)) throw new AppError(app.error, app.message, app.statusCode);
        return { status: 200, body: app };
      },
    },
    { method: "PATCH", path: INTUNE_APP_PATH, handler: (ctx) => change(ctx, "update") },
    { method: "DELETE", path: INTUNE_APP_PATH, handler: (ctx) => change(ctx, "delete") },
  ];
}
