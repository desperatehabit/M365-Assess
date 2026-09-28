// Intune app assignment API (EPIC-017 SPEC.md §4.2, §6, §7, §8, §9; T-0324).
//
//   POST /v1/tenants/:tenantId/apps/:appId/assign
//
// Behind the T-0108 gated-write seam: `Endpoint.Application.ReadWrite` or
// `Remediation.Apply`. `preview: true` returns the set-intune-app-assignment.ps1 plan (per-target
// add/update/remove against the live assignments, with a planHash) and writes nothing.
// Apply must echo that `confirmPlan` hash; the worker re-plans against live state and
// refuses with 409 if the assignments moved since the preview (SPEC §9). The worker
// checks the app against the T-0321 registry, and every assignment change it reports is
// recorded to the audit trail with actor and result.
import { AppError, ErrorCodes } from "../errors.js";
import { RbacErrorCodes, requireTenantInScope, type Caller } from "../rbac/authorize.js";
import type { RequestContext, Route, RouteResponse } from "../server.js";
import { INTUNE_APPS_WRITE_PERMISSION } from "./intune-apps.js";

export const INTUNE_APP_ASSIGN_PATH = "/v1/tenants/:tenantId/apps/:appId/assign";
export const REMEDIATION_APPLY_PERMISSION = "Remediation.Apply";
export const APP_ASSIGNMENT_INTENTS = ["required", "available", "uninstall"] as const;
export const APP_ASSIGNMENT_MODES = ["merge", "replace"] as const;
export const MAX_APP_ASSIGNMENT_TARGETS = 200;

export type AppAssignmentIntent = (typeof APP_ASSIGNMENT_INTENTS)[number];
export type AppAssignmentMode = (typeof APP_ASSIGNMENT_MODES)[number];

export type AppAssignmentTarget =
  | { readonly groupId: string; readonly intent: AppAssignmentIntent }
  | { readonly target: "allUsers" | "allDevices"; readonly intent: AppAssignmentIntent };

export interface AppAssignmentRequest {
  readonly assignments: readonly AppAssignmentTarget[];
  readonly mode: AppAssignmentMode;
  readonly preview: boolean;
  readonly confirmPlan: string | null;
  readonly actor: string;
}

export interface AppAssignmentChange {
  readonly key: string;
  readonly targetType: string;
  readonly groupId: string | null;
  readonly displayName: string | null;
  readonly from: string | null;
  readonly to: string | null;
  readonly change: "add" | "update" | "remove" | "unchanged";
}

export interface AppAssignmentPlan {
  readonly appId: string;
  readonly appName: string;
  readonly appType: string;
  readonly mode: AppAssignmentMode;
  readonly changes: readonly AppAssignmentChange[];
  readonly before: readonly Record<string, unknown>[];
  readonly after: readonly Record<string, unknown>[];
  readonly issues: readonly string[];
  readonly valid: boolean;
  readonly planHash: string;
  readonly requiresConfirmation: boolean;
}

/** What the worker returns: a plan/apply result, or a structured error. */
export type AppAssignmentWorkerResult =
  | {
      readonly preview: boolean;
      readonly applied: boolean;
      readonly plan: AppAssignmentPlan;
      readonly error?: string | null;
      readonly auditEvents?: readonly Record<string, unknown>[];
    }
  | { readonly error: string; readonly message: string; readonly statusCode: number; readonly plan?: AppAssignmentPlan };

/** Runs the set-intune-app-assignment.ps1 worker for one tenant and app. */
export interface AppAssignmentProvider {
  assign(tenantId: string, appId: string, request: AppAssignmentRequest): Promise<AppAssignmentWorkerResult>;
}

export interface AppAssignmentCaller extends Caller {
  readonly userId?: string;
  readonly permissions?: readonly string[];
}

export type AppAssignmentAuthorizer = (caller: AppAssignmentCaller, permission: string) => boolean;

export interface IntuneAppAssignRouteOptions {
  readonly provider: AppAssignmentProvider;
  readonly resolveCaller: (ctx: RequestContext) => AppAssignmentCaller | undefined;
  readonly authorize?: AppAssignmentAuthorizer;
  readonly recordAudit?: (event: Record<string, unknown>) => Promise<void>;
}

const GUID = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i;

function invalid(message: string, field: string, reason = "invalid"): AppError {
  return new AppError(ErrorCodes.validationFailed, message, 400, [{ field, reason }]);
}

function parseTarget(value: unknown, index: number): AppAssignmentTarget {
  const field = `assignments[${index}]`;
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw invalid(`${field} must be an object`, "assignments");
  }
  const record = value as Record<string, unknown>;
  const intent = record["intent"];
  if (!(APP_ASSIGNMENT_INTENTS as readonly unknown[]).includes(intent)) {
    throw invalid(`${field}.intent must be one of: ${APP_ASSIGNMENT_INTENTS.join(", ")}`, "assignments");
  }
  if (typeof record["groupId"] === "string") {
    const groupId = record["groupId"].trim().toLowerCase();
    if (!GUID.test(groupId)) throw invalid(`${field}.groupId must be a group object id`, "assignments");
    return { groupId, intent: intent as AppAssignmentIntent };
  }
  const target = record["target"];
  if (target !== "allUsers" && target !== "allDevices") {
    throw invalid(`${field} needs a groupId or target 'allUsers'/'allDevices'`, "assignments");
  }
  if (target === "allDevices" && intent === "available") {
    throw invalid(`${field}: intent 'available' cannot target All devices`, "assignments");
  }
  return { target, intent: intent as AppAssignmentIntent };
}

function targetKey(target: AppAssignmentTarget): string {
  return "groupId" in target ? `group:${target.groupId}` : target.target;
}

export function parseAppAssignmentRequest(input: unknown, actor: string, previewQuery = false): AppAssignmentRequest {
  const body = input ?? {};
  if (typeof body !== "object" || Array.isArray(body)) throw invalid("Request body must be a JSON object", "body");
  const record = body as Record<string, unknown>;

  const raw = record["assignments"];
  if (!Array.isArray(raw)) throw invalid("assignments must be an array", "assignments", "required");
  if (raw.length > MAX_APP_ASSIGNMENT_TARGETS) {
    throw invalid(`at most ${MAX_APP_ASSIGNMENT_TARGETS} assignments per request`, "assignments", "too-many");
  }
  const assignments = raw.map(parseTarget);
  const intents = new Map<string, string>();
  for (const a of assignments) {
    const key = targetKey(a);
    const seen = intents.get(key);
    if (seen !== undefined && seen !== a.intent) throw invalid(`target '${key}' is requested with two intents`, "assignments");
    intents.set(key, a.intent);
  }

  const mode = record["mode"] ?? "merge";
  if (!(APP_ASSIGNMENT_MODES as readonly unknown[]).includes(mode)) {
    throw invalid(`mode must be one of: ${APP_ASSIGNMENT_MODES.join(", ")}`, "mode");
  }
  if (mode === "merge" && assignments.length === 0) {
    throw invalid("merge mode needs at least one assignment", "assignments", "required");
  }

  const preview = record["preview"] === true || previewQuery;
  const confirmPlan = typeof record["confirmPlan"] === "string" ? record["confirmPlan"].trim() : "";
  if (!preview && !/^[0-9a-f]{64}$/.test(confirmPlan)) {
    throw invalid("apply requires confirmPlan: preview the plan and echo its planHash", "confirmPlan", "required");
  }
  return { assignments, mode: mode as AppAssignmentMode, preview, confirmPlan: preview ? null : confirmPlan, actor };
}

function defaultAuthorize(caller: AppAssignmentCaller, permission: string): boolean {
  const granted = caller.permissions ?? [];
  return granted.includes(permission) || granted.includes("*");
}

export function createIntuneAppAssignRoute(options: IntuneAppAssignRouteOptions): Route {
  return {
    method: "POST",
    path: INTUNE_APP_ASSIGN_PATH,
    handler: async (ctx: RequestContext): Promise<RouteResponse> => {
      const caller = options.resolveCaller(ctx);
      if (caller === undefined) throw new AppError("request.unauthenticated", "authentication required", 401);
      const tenantId = ctx.params["tenantId"]?.trim();
      const appId = ctx.params["appId"]?.trim();
      if (!tenantId) throw invalid("tenantId is required", "tenantId", "required");
      if (!appId) throw invalid("appId is required", "appId", "required");
      requireTenantInScope(caller, tenantId);
      const authorize = options.authorize ?? defaultAuthorize;
      if (!authorize(caller, INTUNE_APPS_WRITE_PERMISSION) && !authorize(caller, REMEDIATION_APPLY_PERMISSION)) {
        throw new AppError(
          RbacErrorCodes.forbidden,
          `forbidden: requires ${INTUNE_APPS_WRITE_PERMISSION} or ${REMEDIATION_APPLY_PERMISSION}`,
          403,
        );
      }

      const request = parseAppAssignmentRequest(ctx.body, caller.userId ?? "unknown", ctx.query.get("preview") === "true");
      const result = await options.provider.assign(tenantId, appId, request);

      if ("statusCode" in result) {
        throw new AppError(result.error, result.message, result.statusCode);
      }
      for (const event of result.auditEvents ?? []) await options.recordAudit?.(event);
      if (!result.preview && result.error) {
        throw new AppError("intune.app.assign.failed", `assignment failed: ${result.error}`, 502);
      }
      return {
        status: 200,
        body: {
          tenantId,
          appId,
          preview: result.preview,
          applied: result.applied,
          plan: result.plan,
          ...(result.preview ? {} : { auditEvents: result.auditEvents ?? [] }),
        },
      };
    },
  };
}
