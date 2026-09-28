// Autopilot deployment profile writes (EPIC-017 SPEC.md §3.4, §6, §7, §8; T-0845).
//
//   POST   /v1/tenants/:tenantId/autopilot/profiles                        create (a body or a templateId)
//   PATCH  /v1/tenants/:tenantId/autopilot/profiles/:profileId             update
//   DELETE /v1/tenants/:tenantId/autopilot/profiles/:profileId             delete (typed name; unassigned only)
//   POST   /v1/tenants/:tenantId/autopilot/profiles/:profileId/assignments add / remove group assignments
//   POST   /v1/autopilot/profile-templates/:id/deploy                      a template to many tenants
//
// All behind the T-0108 seam (`Endpoint.Autopilot.ReadWrite` or `Remediation.Apply`) with
// `preview`, through set-autopilot-profile.ps1; each applied write's audit event (before/after
// and result) is recorded. Profile bodies are validated here with the T-0328 rules before the
// worker runs. Deploying to more than one tenant requires `confirmTargetCount` (§8), and
// results are per target so partial failures show.
import { AppError, ErrorCodes } from "../errors.js";
import { RbacErrorCodes, requireTenantInScope, type Caller } from "../rbac/authorize.js";
import {
  AUTOPILOT_PROFILE_TYPES,
  AutopilotProfileValidationError,
  validateAutopilotProfile,
  type AutopilotProfileTemplateRepository,
} from "../repository/autopilot-profiles.js";
import type { RequestContext, Route, RouteResponse } from "../server.js";

export const AUTOPILOT_PROFILES_WRITE_PATH = "/v1/tenants/:tenantId/autopilot/profiles";
export const AUTOPILOT_PROFILE_WRITE_PATH = "/v1/tenants/:tenantId/autopilot/profiles/:profileId";
export const AUTOPILOT_PROFILE_ASSIGNMENTS_PATH = "/v1/tenants/:tenantId/autopilot/profiles/:profileId/assignments";
export const AUTOPILOT_TEMPLATE_DEPLOY_PATH = "/v1/autopilot/profile-templates/:id/deploy";
export const AUTOPILOT_WRITE_PERMISSION = "Endpoint.Autopilot.ReadWrite";
export const REMEDIATION_APPLY_PERMISSION = "Remediation.Apply";
export const MAX_PROFILE_DEPLOY_TARGETS = 100;
export const MAX_ASSIGNMENT_GROUPS = 100;

const GUID = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i;
const PATCH_FORBIDDEN = ["id", "createdDateTime", "lastModifiedDateTime", "assignments", "assignedDevices"];

export type AutopilotProfileAction = "create" | "update" | "delete" | "assign";

export interface AutopilotProfileWriteRequest {
  readonly action: AutopilotProfileAction;
  readonly profileId?: string;
  readonly profile?: Record<string, unknown>;
  readonly addGroupIds?: readonly string[];
  readonly removeGroupIds?: readonly string[];
  readonly confirmName?: string;
  readonly preview: boolean;
  readonly actor: string;
}

export interface AutopilotProfileWriteResult {
  readonly preview: boolean;
  readonly applied: boolean;
  readonly profileId?: string;
  readonly plan: Record<string, unknown>;
  readonly steps?: readonly Record<string, unknown>[];
  readonly error?: string | null;
  readonly auditEvent?: Record<string, unknown> | null;
}

export interface AutopilotProfileWorkerError {
  readonly error: string;
  readonly message: string;
  readonly statusCode: number;
  readonly plan?: Record<string, unknown>;
}

/** Runs set-autopilot-profile.ps1 for one tenant. */
export interface AutopilotProfileWriteProvider {
  write(tenantId: string, request: AutopilotProfileWriteRequest): Promise<AutopilotProfileWriteResult | AutopilotProfileWorkerError>;
}

export interface AutopilotWriteCaller extends Caller {
  readonly userId?: string;
  readonly permissions?: readonly string[];
}

export interface AutopilotProfileWriteRoutesOptions {
  readonly provider: AutopilotProfileWriteProvider;
  readonly templates: AutopilotProfileTemplateRepository;
  readonly resolveCaller: (ctx: RequestContext) => AutopilotWriteCaller | undefined;
  readonly authorize?: (caller: AutopilotWriteCaller, permission: string) => boolean;
  readonly recordAudit?: (event: Record<string, unknown>) => Promise<void>;
}

function invalid(message: string, field: string, reason = "invalid"): AppError {
  return new AppError(ErrorCodes.validationFailed, message, 400, [{ field, reason }]);
}

function isWorkerError(value: unknown): value is AutopilotProfileWorkerError {
  return value !== null && typeof value === "object" && "error" in value && "statusCode" in value;
}

function asBody(value: unknown): Record<string, unknown> {
  if (value === undefined || value === null) return {};
  if (typeof value !== "object" || Array.isArray(value)) throw invalid("Request body must be a JSON object", "body");
  return value as Record<string, unknown>;
}

/** A full profile body for create/deploy, validated with the T-0328 template rules. */
export function validateFullProfile(profile: unknown): Record<string, unknown> {
  try {
    return JSON.parse(validateAutopilotProfile(profile)) as Record<string, unknown>;
  } catch (error) {
    if (error instanceof AutopilotProfileValidationError) throw invalid(error.message, "profile");
    throw error;
  }
}

/** A partial PATCH body: no Graph-managed fields, and the profile type cannot change. */
export function validatePartialProfile(profile: unknown): Record<string, unknown> {
  if (profile === null || typeof profile !== "object" || Array.isArray(profile)) throw invalid("profile must be a JSON object", "profile");
  const body = profile as Record<string, unknown>;
  if (Object.keys(body).length === 0) throw invalid("profile has no changes", "profile", "required");
  const forbidden = PATCH_FORBIDDEN.filter((f) => f in body);
  if (forbidden.length > 0) throw invalid(`profile must not carry: ${forbidden.join(", ")}`, "profile");
  if ("@odata.type" in body && !(AUTOPILOT_PROFILE_TYPES as readonly unknown[]).includes(body["@odata.type"])) {
    throw invalid("a profile's @odata.type must be an Autopilot deployment profile type", "profile");
  }
  if ("displayName" in body && (typeof body["displayName"] !== "string" || !body["displayName"].trim())) {
    throw invalid("profile.displayName cannot be empty", "profile");
  }
  // The same credential and size rules as a full body, checked on the partial one.
  try {
    validateAutopilotProfile({ "@odata.type": AUTOPILOT_PROFILE_TYPES[0], displayName: "x", ...body });
  } catch (error) {
    if (error instanceof AutopilotProfileValidationError) throw invalid(error.message, "profile");
    throw error;
  }
  return body;
}

function groupIds(value: unknown, field: string): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw invalid(`${field} must be an array of group IDs`, field);
  const ids = [...new Set(value.map((v) => String(v).trim().toLowerCase()))];
  if (ids.some((id) => !GUID.test(id))) throw invalid(`${field} must contain group object IDs`, field);
  return ids;
}

export function createAutopilotProfileWriteRoutes(options: AutopilotProfileWriteRoutesOptions): Route[] {
  const authorize =
    options.authorize ??
    ((caller: AutopilotWriteCaller, permission: string) => {
      const granted = caller.permissions ?? [];
      return granted.includes(permission) || granted.includes("*");
    });

  const requireWriter = (ctx: RequestContext): AutopilotWriteCaller => {
    const caller = options.resolveCaller(ctx);
    if (caller === undefined) throw new AppError("request.unauthenticated", "authentication required", 401);
    if (!authorize(caller, AUTOPILOT_WRITE_PERMISSION) && !authorize(caller, REMEDIATION_APPLY_PERMISSION)) {
      throw new AppError(RbacErrorCodes.forbidden, `forbidden: requires ${AUTOPILOT_WRITE_PERMISSION} or ${REMEDIATION_APPLY_PERMISSION}`, 403);
    }
    return caller;
  };
  const preview = (ctx: RequestContext, body: Record<string, unknown>) => body["preview"] === true || ctx.query.get("preview") === "true";
  const templateProfile = async (id: string): Promise<Record<string, unknown>> => {
    const template = await options.templates.get(id);
    if (!template) throw new AppError("autopilot-template.not_found", `Autopilot profile template '${id}' not found`, 404);
    return template.profileJson;
  };

  /** Runs one write for one tenant; returns the response body or throws the mapped error. */
  async function run(tenantId: string, request: AutopilotProfileWriteRequest): Promise<Record<string, unknown>> {
    const result = await options.provider.write(tenantId, request);
    if (isWorkerError(result)) throw new AppError(result.error, result.message, result.statusCode);
    if (result.auditEvent) await options.recordAudit?.(result.auditEvent);
    const { auditEvent: _omit, ...body } = result;
    return { tenantId, ...body };
  }

  const tenantWrite = (build: (ctx: RequestContext, body: Record<string, unknown>) => Promise<Omit<AutopilotProfileWriteRequest, "actor" | "preview">>) =>
    async (ctx: RequestContext): Promise<RouteResponse> => {
      const caller = requireWriter(ctx);
      const tenantId = ctx.params["tenantId"]?.trim();
      if (!tenantId) throw invalid("tenantId is required", "tenantId", "required");
      requireTenantInScope(caller, tenantId);
      const body = asBody(ctx.body);
      const request = { ...(await build(ctx, body)), preview: preview(ctx, body), actor: caller.userId ?? "unknown" };
      const response = await run(tenantId, request);
      if (!request.preview && response["error"]) throw new AppError(`autopilot.profile.${request.action}_failed`, `${request.action} failed: ${String(response["error"])}`, 502);
      return { status: !request.preview && request.action === "create" ? 201 : 200, body: response };
    };

  return [
    {
      method: "POST",
      path: AUTOPILOT_PROFILES_WRITE_PATH,
      handler: tenantWrite(async (_ctx, body) => {
        const source = typeof body["templateId"] === "string" ? await templateProfile(body["templateId"]) : body["profile"];
        return { action: "create", profile: validateFullProfile(source) };
      }),
    },
    {
      method: "PATCH",
      path: AUTOPILOT_PROFILE_WRITE_PATH,
      handler: tenantWrite(async (ctx, body) => ({ action: "update", profileId: ctx.params["profileId"]!, profile: validatePartialProfile(body["profile"]) })),
    },
    {
      method: "DELETE",
      path: AUTOPILOT_PROFILE_WRITE_PATH,
      handler: tenantWrite(async (ctx, body) => ({
        action: "delete",
        profileId: ctx.params["profileId"]!,
        confirmName: typeof body["confirmName"] === "string" ? body["confirmName"] : (ctx.query.get("confirmName") ?? ""),
      })),
    },
    {
      method: "POST",
      path: AUTOPILOT_PROFILE_ASSIGNMENTS_PATH,
      handler: tenantWrite(async (ctx, body) => {
        const add = groupIds(body["add"], "add");
        const remove = groupIds(body["remove"], "remove");
        if (add.length + remove.length === 0) throw invalid("add or remove at least one group", "add", "required");
        if (add.length + remove.length > MAX_ASSIGNMENT_GROUPS) throw invalid(`at most ${MAX_ASSIGNMENT_GROUPS} groups per change`, "add", "too-many");
        const overlap = add.filter((id) => remove.includes(id));
        if (overlap.length > 0) throw invalid(`a group cannot be both added and removed: ${overlap.join(", ")}`, "add");
        return { action: "assign", profileId: ctx.params["profileId"]!, addGroupIds: add, removeGroupIds: remove };
      }),
    },
    {
      method: "POST",
      path: AUTOPILOT_TEMPLATE_DEPLOY_PATH,
      handler: async (ctx): Promise<RouteResponse> => {
        const caller = requireWriter(ctx);
        const body = asBody(ctx.body);
        const profile = validateFullProfile(await templateProfile(ctx.params["id"] ?? ""));
        const raw = body["targets"];
        if (!Array.isArray(raw)) throw invalid("targets must be an array of tenant ids", "targets", "required");
        const targets = [...new Set(raw.map((t) => String(t).trim()).filter(Boolean))];
        if (targets.length === 0) throw invalid("at least one target tenant is required", "targets", "required");
        if (targets.length > MAX_PROFILE_DEPLOY_TARGETS) throw invalid(`at most ${MAX_PROFILE_DEPLOY_TARGETS} target tenants`, "targets", "too-many");
        for (const tenantId of targets) requireTenantInScope(caller, tenantId);
        const isPreview = preview(ctx, body);
        if (!isPreview && targets.length > 1 && body["confirmTargetCount"] !== targets.length) {
          throw invalid(`deploying to ${targets.length} tenants requires confirmTargetCount: ${targets.length}`, "confirmTargetCount", "required");
        }

        const results: Record<string, unknown>[] = [];
        for (const tenantId of targets) {
          try {
            const response = await run(tenantId, { action: "create", profile, preview: isPreview, actor: caller.userId ?? "unknown" });
            results.push({ ...response, state: isPreview ? "planned" : response["error"] ? "failed" : "created" });
          } catch (error) {
            results.push({ tenantId, state: "failed", error: error instanceof Error ? error.message : String(error) });
          }
        }
        const count = (state: string) => results.filter((r) => r["state"] === state).length;
        return {
          status: 200,
          body: {
            templateId: ctx.params["id"],
            preview: isPreview,
            targetCount: targets.length,
            summary: isPreview ? { planned: count("planned"), failed: count("failed") } : { created: count("created"), failed: count("failed") },
            results,
          },
        };
      },
    },
  ];
}
