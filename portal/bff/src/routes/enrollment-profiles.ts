// Enrollment profile API (EPIC-017 SPEC.md §3.5, §4.4, §5, §6, §7, §8; T-0329).
//
// Live profiles, through set-enrollment-profile.ps1:
//   GET    /v1/tenants/:tenantId/enrollment-profiles                      profiles + token status
//   POST   /v1/tenants/:tenantId/enrollment-profiles                      create (from a body or a template)
//   PATCH  /v1/tenants/:tenantId/enrollment-profiles/:profileId           update
//   DELETE /v1/tenants/:tenantId/enrollment-profiles/:profileId           delete (typed-name confirmation)
//   POST   /v1/tenants/:tenantId/enrollment-profiles/:profileId/assign    Apple ADE: assign device serials
// Portal-wide templates (EnrollmentProfileTemplate, persisted):
//   GET/POST /v1/enrollment-profile-templates, GET/PATCH/DELETE /v1/enrollment-profile-templates/:id
//
// Reads need `Endpoint.Autopilot.Read` (enrollment sits under Autopilot & Enrollment, SPEC §3);
// writes need `Endpoint.Autopilot.ReadWrite` or `Remediation.Apply` (T-0108), support `preview`
// (plan with before/after), and are audited with before/after. Profiles are validated per
// platform before the worker runs. The list carries every Apple ADE and Android token's
// expiry and an `alerts` list of tokens expiring within 30 days or expired, for EPIC-029.
import { randomUUID } from "node:crypto";
import { AppError, ErrorCodes } from "../errors.js";
import { RbacErrorCodes, requireTenantInScope, type Caller } from "../rbac/authorize.js";
import {
  EnrollmentProfileConflictError,
  EnrollmentProfileValidationError,
  isEnrollmentPlatform,
  validateEnrollmentProfile,
  type EnrollmentPlatform,
  type EnrollmentProfileTemplate,
  type EnrollmentProfileTemplateRepository,
} from "../repository/enrollment-profile-templates.js";
import type { RequestContext, Route, RouteResponse } from "../server.js";

export const ENROLLMENT_PROFILES_PATH = "/v1/tenants/:tenantId/enrollment-profiles";
export const ENROLLMENT_PROFILE_PATH = "/v1/tenants/:tenantId/enrollment-profiles/:profileId";
export const ENROLLMENT_PROFILE_ASSIGN_PATH = "/v1/tenants/:tenantId/enrollment-profiles/:profileId/assign";
export const ENROLLMENT_TEMPLATES_PATH = "/v1/enrollment-profile-templates";
export const ENROLLMENT_TEMPLATE_PATH = "/v1/enrollment-profile-templates/:id";

export const ENROLLMENT_READ_PERMISSION = "Endpoint.Autopilot.Read";
export const ENROLLMENT_WRITE_PERMISSION = "Endpoint.Autopilot.ReadWrite";
export const REMEDIATION_APPLY_PERMISSION = "Remediation.Apply";
export const MAX_ASSIGN_SERIALS = 1000;

export interface EnrollmentToken {
  readonly platform: EnrollmentPlatform;
  readonly id: string;
  readonly name: string;
  readonly expiresAt: string | null;
  readonly daysRemaining: number | null;
  readonly state: "ok" | "expiring" | "expired" | "unknown";
  readonly [extra: string]: unknown;
}

export interface EnrollmentProfilesList {
  readonly profiles: readonly Record<string, unknown>[];
  readonly tokens: readonly EnrollmentToken[];
}

export type EnrollmentWriteAction = "create" | "update" | "delete" | "assign";

export interface EnrollmentWriteRequest {
  readonly action: EnrollmentWriteAction;
  readonly platform: EnrollmentPlatform;
  readonly depOnboardingSettingId?: string;
  readonly profileId?: string;
  readonly profile?: Record<string, unknown>;
  readonly serialNumbers?: readonly string[];
  readonly confirmName?: string;
  readonly preview: boolean;
  readonly actor: string;
}

export interface EnrollmentWriteResult {
  readonly preview: boolean;
  readonly profileId?: string;
  readonly plan: Record<string, unknown>;
  readonly auditEvent?: Record<string, unknown> | null;
}

export interface EnrollmentWorkerError {
  readonly error: string;
  readonly message: string;
  readonly statusCode: number;
}

/** Runs set-enrollment-profile.ps1 for one tenant. */
export interface EnrollmentProfileProvider {
  list(tenantId: string): Promise<EnrollmentProfilesList>;
  write(tenantId: string, request: EnrollmentWriteRequest): Promise<EnrollmentWriteResult | EnrollmentWorkerError>;
}

export interface EnrollmentCaller extends Caller {
  readonly userId?: string;
  readonly permissions?: readonly string[];
}

export type EnrollmentAuthorizer = (caller: EnrollmentCaller, permission: string) => boolean;

export interface EnrollmentProfileRoutesOptions {
  readonly provider: EnrollmentProfileProvider;
  readonly templates: EnrollmentProfileTemplateRepository;
  readonly resolveCaller: (ctx: RequestContext) => EnrollmentCaller | undefined;
  readonly authorize?: EnrollmentAuthorizer;
  readonly recordAudit?: (event: Record<string, unknown>) => Promise<void>;
  readonly now?: () => Date;
  readonly newId?: () => string;
}

function invalid(message: string, field: string, reason = "invalid"): AppError {
  return new AppError(ErrorCodes.validationFailed, message, 400, [{ field, reason }]);
}

function asBody(value: unknown): Record<string, unknown> {
  if (value === undefined || value === null) return {};
  if (typeof value !== "object" || Array.isArray(value)) throw invalid("Request body must be a JSON object", "body");
  return value as Record<string, unknown>;
}

function isWorkerError(value: unknown): value is EnrollmentWorkerError {
  return value !== null && typeof value === "object" && "error" in value && "statusCode" in value;
}

function mapValidation(error: unknown): never {
  if (error instanceof EnrollmentProfileValidationError) throw invalid(error.message, error.field);
  if (error instanceof EnrollmentProfileConflictError) throw new AppError("enrollment-template.conflict", error.message, 409);
  throw error;
}

function requirePlatform(value: unknown): EnrollmentPlatform {
  if (!isEnrollmentPlatform(value)) throw invalid("platform must be one of: apple-ade, android-enterprise", "platform");
  return value;
}

function optionalId(body: Record<string, unknown>, field: string): string | undefined {
  const value = body[field];
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value !== "string" || !/^[A-Za-z0-9_.:-]{1,128}$/.test(value)) throw invalid(`${field} is not a valid id`, field);
  return value;
}

/** Tokens that need attention: expiring within 30 days, or expired. */
export function tokenAlerts(tokens: readonly EnrollmentToken[]): EnrollmentToken[] {
  return tokens.filter((t) => t.state === "expiring" || t.state === "expired");
}

export function createEnrollmentProfileRoutes(options: EnrollmentProfileRoutesOptions): Route[] {
  const now = () => (options.now?.() ?? new Date()).toISOString();
  const newId = options.newId ?? randomUUID;
  const authorize =
    options.authorize ??
    ((caller: EnrollmentCaller, permission: string) => {
      const granted = caller.permissions ?? [];
      return granted.includes(permission) || granted.includes("*");
    });

  const requireCaller = (ctx: RequestContext): EnrollmentCaller => {
    const caller = options.resolveCaller(ctx);
    if (caller === undefined) throw new AppError("request.unauthenticated", "authentication required", 401);
    return caller;
  };
  const requireAny = (caller: EnrollmentCaller, ...permissions: string[]) => {
    if (!permissions.some((p) => authorize(caller, p))) {
      throw new AppError(RbacErrorCodes.forbidden, `forbidden: requires ${permissions.join(" or ")}`, 403);
    }
  };
  const tenantOf = (ctx: RequestContext, caller: EnrollmentCaller): string => {
    const tenantId = ctx.params["tenantId"]?.trim();
    if (!tenantId) throw invalid("tenantId is required", "tenantId", "required");
    requireTenantInScope(caller, tenantId);
    return tenantId;
  };
  const audit = async (event: Record<string, unknown>) => {
    await options.recordAudit?.({ id: newId(), timestamp: now(), ...event });
  };
  const requireTemplate = async (id: string | undefined): Promise<EnrollmentProfileTemplate> => {
    const template = id ? await options.templates.get(id) : undefined;
    if (!template) throw new AppError("enrollment-template.not_found", `enrollment profile template '${id ?? ""}' not found`, 404);
    return template;
  };

  /** Shared write path: authorise, run the worker, audit an applied write. */
  async function write(ctx: RequestContext, build: (caller: EnrollmentCaller, body: Record<string, unknown>) => Promise<Omit<EnrollmentWriteRequest, "actor" | "preview">>): Promise<RouteResponse> {
    const caller = requireCaller(ctx);
    const tenantId = tenantOf(ctx, caller);
    requireAny(caller, ENROLLMENT_WRITE_PERMISSION, REMEDIATION_APPLY_PERMISSION);
    const body = asBody(ctx.body);
    const request: EnrollmentWriteRequest = {
      ...(await build(caller, body)),
      preview: body["preview"] === true || ctx.query.get("preview") === "true",
      actor: caller.userId ?? "unknown",
    };
    const result = await options.provider.write(tenantId, request);
    if (isWorkerError(result)) throw new AppError(result.error, result.message, result.statusCode);
    if (result.auditEvent) await options.recordAudit?.(result.auditEvent);
    const { auditEvent: _omit, ...response } = result;
    return { status: !result.preview && request.action === "create" ? 201 : 200, body: { tenantId, ...response } };
  }

  return [
    {
      method: "GET",
      path: ENROLLMENT_PROFILES_PATH,
      handler: async (ctx): Promise<RouteResponse> => {
        const caller = requireCaller(ctx);
        const tenantId = tenantOf(ctx, caller);
        requireAny(caller, ENROLLMENT_READ_PERMISSION, ENROLLMENT_WRITE_PERMISSION);
        const list = await options.provider.list(tenantId);
        return { status: 200, body: { tenantId, profiles: list.profiles, tokens: list.tokens, alerts: tokenAlerts(list.tokens) } };
      },
    },
    {
      method: "POST",
      path: ENROLLMENT_PROFILES_PATH,
      handler: (ctx) =>
        write(ctx, async (_caller, body) => {
          let platform: EnrollmentPlatform;
          let profile: Record<string, unknown>;
          const templateId = optionalId(body, "templateId");
          if (templateId) {
            const template = await requireTemplate(templateId);
            platform = template.platform;
            if (body["platform"] !== undefined && body["platform"] !== platform) {
              throw invalid(`template '${template.name}' is for ${platform}`, "platform");
            }
            profile = { ...template.profileJson, ...(body["profile"] as Record<string, unknown> | undefined) };
          } else {
            platform = requirePlatform(body["platform"]);
            profile = body["profile"] as Record<string, unknown>;
          }
          try {
            profile = validateEnrollmentProfile(platform, profile);
          } catch (error) {
            mapValidation(error);
          }
          const depOnboardingSettingId = optionalId(body, "depOnboardingSettingId");
          if (platform === "apple-ade" && !depOnboardingSettingId) {
            throw invalid("depOnboardingSettingId (the ADE token) is required for an Apple profile", "depOnboardingSettingId", "required");
          }
          return { action: "create", platform, profile, ...(depOnboardingSettingId ? { depOnboardingSettingId } : {}) };
        }),
    },
    {
      method: "PATCH",
      path: ENROLLMENT_PROFILE_PATH,
      handler: (ctx) =>
        write(ctx, async (_caller, body) => {
          const platform = requirePlatform(body["platform"]);
          let profile: Record<string, unknown>;
          try {
            profile = validateEnrollmentProfile(platform, body["profile"], { partial: true });
          } catch (error) {
            mapValidation(error);
          }
          const depOnboardingSettingId = optionalId(body, "depOnboardingSettingId");
          return { action: "update", platform, profileId: ctx.params["profileId"]!, profile, ...(depOnboardingSettingId ? { depOnboardingSettingId } : {}) };
        }),
    },
    {
      method: "DELETE",
      path: ENROLLMENT_PROFILE_PATH,
      handler: (ctx) =>
        write(ctx, async (_caller, body) => {
          const platform = requirePlatform(body["platform"] ?? ctx.query.get("platform"));
          const depOnboardingSettingId = optionalId({ id: body["depOnboardingSettingId"] ?? ctx.query.get("depOnboardingSettingId") ?? undefined }, "id");
          const confirmName = typeof body["confirmName"] === "string" ? body["confirmName"] : (ctx.query.get("confirmName") ?? "");
          return { action: "delete", platform, profileId: ctx.params["profileId"]!, confirmName, ...(depOnboardingSettingId ? { depOnboardingSettingId } : {}) };
        }),
    },
    {
      method: "POST",
      path: ENROLLMENT_PROFILE_ASSIGN_PATH,
      handler: (ctx) =>
        write(ctx, async (_caller, body) => {
          const platform = requirePlatform(body["platform"]);
          if (platform !== "apple-ade") {
            throw invalid("only Apple ADE profiles are assigned to devices; Android devices enroll with the profile token", "platform");
          }
          const depOnboardingSettingId = optionalId(body, "depOnboardingSettingId");
          if (!depOnboardingSettingId) throw invalid("depOnboardingSettingId is required", "depOnboardingSettingId", "required");
          const raw = body["serialNumbers"];
          if (!Array.isArray(raw) || raw.length === 0) throw invalid("serialNumbers must be a non-empty array", "serialNumbers", "required");
          if (raw.length > MAX_ASSIGN_SERIALS) throw invalid(`at most ${MAX_ASSIGN_SERIALS} serial numbers`, "serialNumbers", "too-many");
          const serialNumbers = [...new Set(raw.map((s) => String(s).trim()).filter(Boolean))];
          if (serialNumbers.some((s) => !/^[A-Za-z0-9-]{1,64}$/.test(s))) throw invalid("serialNumbers contains an invalid serial", "serialNumbers");
          return { action: "assign", platform, profileId: ctx.params["profileId"]!, depOnboardingSettingId, serialNumbers };
        }),
    },

    // ---- Templates ----
    {
      method: "GET",
      path: ENROLLMENT_TEMPLATES_PATH,
      handler: async (ctx): Promise<RouteResponse> => {
        requireAny(requireCaller(ctx), ENROLLMENT_READ_PERMISSION, ENROLLMENT_WRITE_PERMISSION);
        const platform = ctx.query.get("platform");
        const items = await options.templates.list(platform ? requirePlatform(platform) : undefined);
        return { status: 200, body: { totalCount: items.length, items } };
      },
    },
    {
      method: "POST",
      path: ENROLLMENT_TEMPLATES_PATH,
      handler: async (ctx): Promise<RouteResponse> => {
        const caller = requireCaller(ctx);
        requireAny(caller, ENROLLMENT_WRITE_PERMISSION);
        const body = asBody(ctx.body);
        const created = await options.templates
          .create({
            id: newId(),
            name: body["name"] as string,
            platform: body["platform"] as string,
            profileJson: body["profileJson"] as Record<string, unknown>,
            createdBy: caller.userId ?? "unknown",
            createdAt: now(),
          })
          .catch(mapValidation);
        await audit({ tenantId: null, action: "intune.enrollment-template.create", targetId: created.id, targetName: created.name, actor: caller.userId ?? "unknown", before: null, after: created });
        return { status: 201, body: created };
      },
    },
    {
      method: "GET",
      path: ENROLLMENT_TEMPLATE_PATH,
      handler: async (ctx): Promise<RouteResponse> => {
        requireAny(requireCaller(ctx), ENROLLMENT_READ_PERMISSION, ENROLLMENT_WRITE_PERMISSION);
        return { status: 200, body: await requireTemplate(ctx.params["id"]) };
      },
    },
    {
      method: "PATCH",
      path: ENROLLMENT_TEMPLATE_PATH,
      handler: async (ctx): Promise<RouteResponse> => {
        const caller = requireCaller(ctx);
        requireAny(caller, ENROLLMENT_WRITE_PERMISSION);
        const before = await requireTemplate(ctx.params["id"]);
        const body = asBody(ctx.body);
        if (body["platform"] !== undefined && body["platform"] !== before.platform) {
          throw invalid("a template's platform cannot change; create a new template", "platform");
        }
        const patch: Record<string, unknown> = {};
        for (const key of ["name", "profileJson"]) if (body[key] !== undefined) patch[key] = body[key];
        const after = await options.templates.update(before.id, patch, now()).catch(mapValidation);
        if (!after) throw new AppError("enrollment-template.not_found", `enrollment profile template '${before.id}' not found`, 404);
        await audit({ tenantId: null, action: "intune.enrollment-template.update", targetId: after.id, targetName: after.name, actor: caller.userId ?? "unknown", before, after });
        return { status: 200, body: after };
      },
    },
    {
      method: "DELETE",
      path: ENROLLMENT_TEMPLATE_PATH,
      handler: async (ctx): Promise<RouteResponse> => {
        const caller = requireCaller(ctx);
        requireAny(caller, ENROLLMENT_WRITE_PERMISSION);
        const before = await requireTemplate(ctx.params["id"]);
        await options.templates.delete(before.id);
        await audit({ tenantId: null, action: "intune.enrollment-template.delete", targetId: before.id, targetName: before.name, actor: caller.userId ?? "unknown", before, after: null });
        return { status: 204 };
      },
    },
  ];
}
