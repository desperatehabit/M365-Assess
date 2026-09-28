// Application template API (EPIC-017 SPEC.md §3.3, §5, §6, §7, §8; T-0327).
//
//   GET    /v1/app-templates              list          (Endpoint.Application.Read)
//   POST   /v1/app-templates              create        (Endpoint.Application.ReadWrite)
//   GET    /v1/app-templates/:id          read
//   PATCH  /v1/app-templates/:id          update
//   DELETE /v1/app-templates/:id          delete
//   POST   /v1/app-templates/:id/deploy   deploy to tenants (ReadWrite or Remediation.Apply)
//
// Deploy, per target tenant:
//   1. Resolve every `%name%` token in the config (EPIC-002 semantics): template default, then
//      global variables, then the tenant's, then the request's `values`. An unknown token
//      fails the target; so does a token that resolves to a *secret* tenant variable, because
//      the substituted config is persisted on the AppDeployment row.
//   2. Preflight through deploy-application-template.ps1 (read-only): substitute, and report an
//      existing app with the same name as a conflict.
//   3. Validate the resolved request as an app upload (T-0323), check a Win32 package exists on
//      the tenant's artifact tier, persist an AppDeployment, audit, and queue it.
// `preview` stops after step 2. Applying to more than one tenant requires
// `confirmTargetCount` to echo the count shown (§8). Results are per target, so a partial
// failure is visible rather than failing the whole call.
import { randomUUID } from "node:crypto";
import { extractVariableTokens } from "../domain/variable-substitution.js";
import { AppError, ErrorCodes } from "../errors.js";
import { RbacErrorCodes, requireTenantInScope, type Caller } from "../rbac/authorize.js";
import type { AppDeploymentRepository } from "../repository/app-deployments.js";
import {
  ApplicationTemplateConflictError,
  ApplicationTemplateValidationError,
  type ApplicationTemplate,
  type ApplicationTemplatePatch,
  type ApplicationTemplateRepository,
} from "../repository/application-templates.js";
import type { RequestContext, Route, RouteResponse } from "../server.js";
import { INTUNE_APPS_READ_PERMISSION, INTUNE_APPS_WRITE_PERMISSION } from "./intune-apps.js";
import {
  REMEDIATION_APPLY_PERMISSION,
  parseAppUploadRequest,
  type AppUploadPackageStore,
  type AppUploadQueue,
} from "./intune-apps-queue.js";

export const APP_TEMPLATES_PATH = "/v1/app-templates";
export const APP_TEMPLATE_PATH = "/v1/app-templates/:id";
export const APP_TEMPLATE_DEPLOY_PATH = "/v1/app-templates/:id/deploy";
export const APP_TEMPLATE_NOT_FOUND = "app-template.not_found";
export const APP_TEMPLATE_CONFLICT = "app-template.conflict";
export const MAX_APP_TEMPLATE_TARGETS = 100;

// ---------------------------------------------------------------------------
// Variable resolution
// ---------------------------------------------------------------------------

export interface TemplateVariableRow {
  readonly name: string;
  readonly value: string;
  readonly isSecret: boolean;
}

export interface TemplateVariableScopes {
  readonly global: readonly TemplateVariableRow[];
  readonly tenant: readonly TemplateVariableRow[];
}

export interface ResolvedTemplateValues {
  readonly values: Record<string, string>;
  readonly missing: readonly string[];
  readonly secret: readonly string[];
}

function collectStrings(value: unknown, out: string[]): void {
  if (typeof value === "string") out.push(value);
  else if (Array.isArray(value)) for (const v of value) collectStrings(v, out);
  else if (value !== null && typeof value === "object") for (const v of Object.values(value)) collectStrings(v, out);
}

/** Every `%name%` token used anywhere in a template config. */
export function templateTokens(config: Record<string, unknown>): string[] {
  const strings: string[] = [];
  collectStrings(config, strings);
  return [...new Set(strings.flatMap((s) => extractVariableTokens(s)))].sort();
}

/**
 * Picks a value for each token: template default < global < tenant < request override.
 * A token whose winning value is a secret variable is reported, not returned.
 */
export function resolveTemplateValues(
  template: Pick<ApplicationTemplate, "config" | "variables">,
  scopes: TemplateVariableScopes,
  overrides: Readonly<Record<string, string>> = {},
): ResolvedTemplateValues {
  const values: Record<string, string> = {};
  const missing: string[] = [];
  const secret: string[] = [];
  for (const token of templateTokens(template.config)) {
    if (Object.prototype.hasOwnProperty.call(overrides, token)) {
      values[token] = overrides[token]!;
      continue;
    }
    const tenant = scopes.tenant.find((v) => v.name === token);
    const global = scopes.global.find((v) => v.name === token);
    const winner = tenant ?? global;
    if (winner) {
      if (winner.isSecret) secret.push(token);
      else values[token] = winner.value;
      continue;
    }
    const declared = template.variables.find((v) => v.name === token);
    if (declared?.defaultValue !== undefined) values[token] = declared.defaultValue;
    else missing.push(token);
  }
  return { values, missing, secret };
}

// ---------------------------------------------------------------------------
// Ports
// ---------------------------------------------------------------------------

/** What deploy-application-template.ps1 returns for one tenant. */
export type TemplatePreflightResult =
  | {
      readonly tenantId: string;
      readonly request: Record<string, unknown>;
      readonly conflict: boolean;
      readonly existingAppId: string | null;
      readonly issues: readonly string[];
    }
  | { readonly error: string; readonly message: string; readonly statusCode?: number };

export interface TemplatePreflightProvider {
  preflight(tenantId: string, config: Record<string, unknown>, values: Record<string, string>): Promise<TemplatePreflightResult>;
}

export interface AppTemplateCaller extends Caller {
  readonly userId?: string;
  readonly permissions?: readonly string[];
}

export type AppTemplateAuthorizer = (caller: AppTemplateCaller, permission: string) => boolean;

export interface ApplicationTemplateRoutesOptions {
  readonly templates: ApplicationTemplateRepository;
  readonly deployments: AppDeploymentRepository;
  readonly packages: AppUploadPackageStore;
  readonly queue: AppUploadQueue;
  readonly preflight: TemplatePreflightProvider;
  /** Global and tenant variables for a tenant, secret flag included. */
  readonly variables: (tenantId: string) => Promise<TemplateVariableScopes>;
  readonly resolveCaller: (ctx: RequestContext) => AppTemplateCaller | undefined;
  readonly authorize?: AppTemplateAuthorizer;
  readonly recordAudit?: (event: Record<string, unknown>) => Promise<void>;
  readonly now?: () => Date;
  readonly newId?: () => string;
}

export interface TemplateTargetResult {
  readonly tenantId: string;
  readonly state: "planned" | "queued" | "failed";
  readonly request?: Record<string, unknown>;
  readonly issues?: readonly string[];
  readonly deploymentId?: string;
  readonly jobId?: string;
  readonly error?: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function invalid(message: string, field: string, reason = "invalid"): AppError {
  return new AppError(ErrorCodes.validationFailed, message, 400, [{ field, reason }]);
}

function defaultAuthorize(caller: AppTemplateCaller, permission: string): boolean {
  const granted = caller.permissions ?? [];
  return granted.includes(permission) || granted.includes("*");
}

function asBody(value: unknown): Record<string, unknown> {
  if (value === undefined || value === null) return {};
  if (typeof value !== "object" || Array.isArray(value)) throw invalid("Request body must be a JSON object", "body");
  return value as Record<string, unknown>;
}

function mapRepositoryError(error: unknown): never {
  if (error instanceof ApplicationTemplateValidationError) throw invalid(error.message, error.field);
  if (error instanceof ApplicationTemplateConflictError) throw new AppError(APP_TEMPLATE_CONFLICT, error.message, 409);
  throw error;
}

function parseTargets(body: Record<string, unknown>): string[] {
  const raw = body["targets"];
  if (!Array.isArray(raw)) throw invalid("targets must be an array of tenant ids", "targets", "required");
  const targets = [...new Set(raw.map((t) => String(t).trim()).filter(Boolean))];
  if (targets.length === 0) throw invalid("at least one target tenant is required", "targets", "required");
  if (targets.length > MAX_APP_TEMPLATE_TARGETS) {
    throw invalid(`at most ${MAX_APP_TEMPLATE_TARGETS} target tenants per deploy`, "targets", "too-many");
  }
  return targets;
}

function parseOverrides(body: Record<string, unknown>): Record<string, string> {
  const raw = body["values"];
  if (raw === undefined) return {};
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) throw invalid("values must be an object", "values");
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (typeof value !== "string") throw invalid(`values.${key} must be a string`, "values");
    out[key] = value;
  }
  return out;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

export function createApplicationTemplateRoutes(options: ApplicationTemplateRoutesOptions): Route[] {
  const now = () => (options.now?.() ?? new Date()).toISOString();
  const newId = options.newId ?? randomUUID;
  const authorize = options.authorize ?? defaultAuthorize;

  const requireCaller = (ctx: RequestContext): AppTemplateCaller => {
    const caller = options.resolveCaller(ctx);
    if (caller === undefined) throw new AppError("request.unauthenticated", "authentication required", 401);
    return caller;
  };
  const requirePermission = (caller: AppTemplateCaller, ...any: string[]) => {
    if (!any.some((p) => authorize(caller, p))) {
      throw new AppError(RbacErrorCodes.forbidden, `forbidden: requires ${any.join(" or ")}`, 403);
    }
  };
  const canRead = (caller: AppTemplateCaller) =>
    requirePermission(caller, INTUNE_APPS_READ_PERMISSION, INTUNE_APPS_WRITE_PERMISSION);
  const requireTemplate = async (ctx: RequestContext): Promise<ApplicationTemplate> => {
    const id = ctx.params["id"]?.trim();
    if (!id) throw invalid("template id is required", "id", "required");
    const template = await options.templates.get(id);
    if (!template) throw new AppError(APP_TEMPLATE_NOT_FOUND, `application template '${id}' not found`, 404);
    return template;
  };
  const audit = async (event: Record<string, unknown>) => {
    await options.recordAudit?.({ id: newId(), timestamp: now(), ...event });
  };

  async function deployTarget(
    template: ApplicationTemplate,
    tenantId: string,
    overrides: Record<string, string>,
    preview: boolean,
    actor: string,
    correlationId: string,
  ): Promise<TemplateTargetResult> {
    const fail = (error: string, extra: Partial<TemplateTargetResult> = {}): TemplateTargetResult => ({
      tenantId,
      state: "failed",
      error,
      ...extra,
    });
    let resolved: ResolvedTemplateValues;
    try {
      resolved = resolveTemplateValues(template, await options.variables(tenantId), overrides);
    } catch (error) {
      return fail(`could not read tenant variables: ${errorText(error)}`);
    }
    if (resolved.secret.length > 0) {
      return fail(
        `secret variables cannot be used in an app template (the result is stored with the deployment): ${resolved.secret.map((t) => `%${t}%`).join(", ")}`,
      );
    }
    if (resolved.missing.length > 0) {
      return fail(`unknown tenant variable(s): ${resolved.missing.map((t) => `%${t}%`).join(", ")}`);
    }

    let plan: TemplatePreflightResult;
    try {
      plan = await options.preflight.preflight(tenantId, template.config, resolved.values);
    } catch (error) {
      return fail(errorText(error));
    }
    if ("error" in plan) return fail(plan.message);
    if (plan.conflict) {
      return fail(`an app named '${String(plan.request["displayName"] ?? "")}' already exists in the tenant (${plan.existingAppId})`, {
        request: plan.request,
        issues: plan.issues,
      });
    }
    if (preview) {
      return { tenantId, state: plan.issues.length === 0 ? "planned" : "failed", request: plan.request, issues: plan.issues };
    }
    if (plan.issues.length > 0) return fail(plan.issues.join("; "), { request: plan.request, issues: plan.issues });

    let request: ReturnType<typeof parseAppUploadRequest>;
    try {
      request = parseAppUploadRequest({ ...plan.request, appType: template.appType });
    } catch (error) {
      return fail(errorText(error), { request: plan.request });
    }
    if (request.appType === "win32" && !(await options.packages.getPackage(tenantId, request.packageId))) {
      return fail(`app package '${request.packageId}' is not on this tenant's artifact tier`, { request: plan.request });
    }

    const deploymentId = newId();
    try {
      await options.deployments.createDeployment({
        id: deploymentId,
        tenantId,
        appType: request.appType,
        payload: { ...request, templateId: template.id },
        createdBy: actor,
        createdAt: now(),
      });
    } catch (error) {
      return fail(errorText(error), { request: plan.request });
    }
    await audit({
      tenantId,
      action: "intune.app.template.deploy",
      targetId: deploymentId,
      targetName: request.displayName,
      templateId: template.id,
      actor,
      before: null,
      after: { ...request },
      result: "queued",
    });
    const jobId = await options.queue.enqueue({ jobId: newId(), tenantId, deploymentId, correlationId });
    return { tenantId, state: "queued", deploymentId, jobId, request: { ...request } };
  }

  return [
    {
      method: "GET",
      path: APP_TEMPLATES_PATH,
      handler: async (ctx): Promise<RouteResponse> => {
        canRead(requireCaller(ctx));
        const items = await options.templates.list();
        return { status: 200, body: { totalCount: items.length, items } };
      },
    },
    {
      method: "POST",
      path: APP_TEMPLATES_PATH,
      handler: async (ctx): Promise<RouteResponse> => {
        const caller = requireCaller(ctx);
        requirePermission(caller, INTUNE_APPS_WRITE_PERMISSION);
        const body = asBody(ctx.body);
        const created = await options.templates
          .create({
            id: newId(),
            name: body["name"] as string,
            appType: body["appType"] as string,
            config: body["config"] as Record<string, unknown>,
            variables: body["variables"] as ApplicationTemplate["variables"],
            createdBy: caller.userId ?? "unknown",
            createdAt: now(),
          })
          .catch(mapRepositoryError);
        await audit({ tenantId: null, action: "intune.app.template.create", targetId: created.id, targetName: created.name, actor: caller.userId ?? "unknown", before: null, after: created });
        return { status: 201, body: created };
      },
    },
    {
      method: "GET",
      path: APP_TEMPLATE_PATH,
      handler: async (ctx): Promise<RouteResponse> => {
        canRead(requireCaller(ctx));
        const template = await requireTemplate(ctx);
        return { status: 200, body: { ...template, tokens: templateTokens(template.config) } };
      },
    },
    {
      method: "PATCH",
      path: APP_TEMPLATE_PATH,
      handler: async (ctx): Promise<RouteResponse> => {
        const caller = requireCaller(ctx);
        requirePermission(caller, INTUNE_APPS_WRITE_PERMISSION);
        const before = await requireTemplate(ctx);
        const body = asBody(ctx.body);
        const patch: { -readonly [K in keyof ApplicationTemplatePatch]: ApplicationTemplatePatch[K] } = {};
        for (const key of ["name", "appType", "config", "variables"] as const) {
          if (body[key] !== undefined) (patch as Record<string, unknown>)[key] = body[key];
        }
        const after = await options.templates.update(before.id, patch, now()).catch(mapRepositoryError);
        if (!after) throw new AppError(APP_TEMPLATE_NOT_FOUND, `application template '${before.id}' not found`, 404);
        await audit({ tenantId: null, action: "intune.app.template.update", targetId: after.id, targetName: after.name, actor: caller.userId ?? "unknown", before, after });
        return { status: 200, body: after };
      },
    },
    {
      method: "DELETE",
      path: APP_TEMPLATE_PATH,
      handler: async (ctx): Promise<RouteResponse> => {
        const caller = requireCaller(ctx);
        requirePermission(caller, INTUNE_APPS_WRITE_PERMISSION);
        const before = await requireTemplate(ctx);
        await options.templates.delete(before.id);
        await audit({ tenantId: null, action: "intune.app.template.delete", targetId: before.id, targetName: before.name, actor: caller.userId ?? "unknown", before, after: null });
        return { status: 204 };
      },
    },
    {
      method: "POST",
      path: APP_TEMPLATE_DEPLOY_PATH,
      handler: async (ctx): Promise<RouteResponse> => {
        const caller = requireCaller(ctx);
        requirePermission(caller, INTUNE_APPS_WRITE_PERMISSION, REMEDIATION_APPLY_PERMISSION);
        const template = await requireTemplate(ctx);
        const body = asBody(ctx.body);
        const targets = parseTargets(body);
        for (const tenantId of targets) requireTenantInScope(caller, tenantId);
        const overrides = parseOverrides(body);
        const preview = body["preview"] === true || ctx.query.get("preview") === "true";
        if (!preview && targets.length > 1 && body["confirmTargetCount"] !== targets.length) {
          throw invalid(
            `deploying to ${targets.length} tenants requires confirmTargetCount: ${targets.length}`,
            "confirmTargetCount",
            "required",
          );
        }

        const actor = caller.userId ?? "unknown";
        const results: TemplateTargetResult[] = [];
        for (const tenantId of targets) {
          results.push(await deployTarget(template, tenantId, overrides, preview, actor, ctx.correlationId));
        }
        const count = (state: TemplateTargetResult["state"]) => results.filter((r) => r.state === state).length;
        return {
          status: 200,
          body: {
            templateId: template.id,
            preview,
            targetCount: targets.length,
            summary: preview
              ? { planned: count("planned"), failed: count("failed") }
              : { queued: count("queued"), failed: count("failed") },
            results,
          },
        };
      },
    },
  ];
}
