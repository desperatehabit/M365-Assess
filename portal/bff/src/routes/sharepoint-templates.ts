// SharePoint site templates CRUD and deploy API (EPIC-025 SPEC.md §3, §5; T-0896).
//
//   GET    /v1/sharepoint/templates             list        (SharePoint.Site.Read)
//   POST   /v1/sharepoint/templates             create      (SharePoint.Site.ReadWrite)
//   GET    /v1/sharepoint/templates/:id         get         (SharePoint.Site.Read)
//   PATCH  /v1/sharepoint/templates/:id         update      (SharePoint.Site.ReadWrite)
//   DELETE /v1/sharepoint/templates/:id         soft-delete (SharePoint.Site.ReadWrite)
//   POST   /v1/sharepoint/templates/:id/deploy  deploy      (SharePoint.Site.ReadWrite + Remediation.Apply on apply)
//
// Templates persist locally in SQLite (migration 0033); deploy resolves template
// settings + variables per target tenant and delegates to `sitesCreate.createSite`.
import { randomUUID } from "node:crypto";
import { AppError, ErrorCodes, type ErrorDetail } from "../errors.js";
import { paginate, parsePagination } from "../pagination.js";
import { requireTenantInScope, type Caller } from "../rbac/authorize.js";
import type { RequestContext, Route, RouteResponse } from "../server.js";
import {
  REMEDIATION_APPLY_PERMISSION,
  SHAREPOINT_SHARING_OPTIONS,
  SHAREPOINT_SITE_TYPES,
  validateSharePointSiteInput,
  type CreateSharePointSiteInput,
  type SharePointSharing,
  type SharePointSitePlan,
  type SharePointSiteResult,
  type SharePointSiteType,
  type SharePointSitesCreateProvider,
} from "./sharepoint-sites-create.js";

export const SHAREPOINT_TEMPLATES_PATH = "/v1/sharepoint/templates";
export const SHAREPOINT_TEMPLATE_PATH = "/v1/sharepoint/templates/:id";
export const SHAREPOINT_TEMPLATE_DEPLOY_PATH = "/v1/sharepoint/templates/:id/deploy";

export const SHAREPOINT_READ_PERMISSION = "SharePoint.Site.Read";
export const SHAREPOINT_WRITE_PERMISSION = "SharePoint.Site.ReadWrite";

export const SHAREPOINT_TEMPLATE_UNAUTHENTICATED = "request.unauthenticated";
export const SHAREPOINT_TEMPLATE_NOT_FOUND = "sharepoint_template.not_found";
export const SHAREPOINT_TEMPLATE_INVALID = "sharepoint_template.invalid";
export const SHAREPOINT_TEMPLATE_DEPLOY_UNAVAILABLE = "sharepoint.deploy_unavailable";

export interface SharePointTemplateRecord {
  id: string;
  name: string;
  siteType: SharePointSiteType;
  settings: Record<string, unknown>;
  variables: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
  deletedAt: string | null;
}

export type SharePointTemplateCreateInput = Omit<
  SharePointTemplateRecord,
  "createdAt" | "updatedAt" | "deletedAt" | "settings" | "variables"
> &
  Partial<
    Pick<
      SharePointTemplateRecord,
      "settings" | "variables" | "createdAt" | "updatedAt" | "deletedAt"
    >
  >;

export type SharePointTemplateUpdateInput = Partial<
  Pick<SharePointTemplateRecord, "name" | "siteType" | "settings" | "variables">
>;

export interface SharePointTemplateListOptions {
  includeDeleted?: boolean;
}

// Structural match for SqliteRepository SharePointTemplate methods (migration 0033)
// so app.ts can pass `store: repo` directly without an adapter shim.
export interface SharePointTemplatesStore {
  createSharePointTemplate(input: SharePointTemplateCreateInput): Promise<SharePointTemplateRecord>;
  getSharePointTemplate(
    templateId: string,
    options?: SharePointTemplateListOptions,
  ): Promise<SharePointTemplateRecord | undefined>;
  listSharePointTemplates(
    options?: SharePointTemplateListOptions,
  ): Promise<SharePointTemplateRecord[]>;
  updateSharePointTemplate(
    templateId: string,
    update: SharePointTemplateUpdateInput,
  ): Promise<SharePointTemplateRecord | undefined>;
  softDeleteSharePointTemplate(
    templateId: string,
    options?: { now?: string },
  ): Promise<boolean>;
}

export interface SharePointTemplateCaller extends Caller {
  readonly userId?: string;
}

export type SharePointTemplateAuthorizer = (
  caller: SharePointTemplateCaller,
  permission: string,
) => void | Promise<void>;

export interface SharePointTemplateAuditEvent {
  readonly tenantId: string | null;
  readonly action: string;
  readonly targetType?: string;
  readonly targetId: string;
  readonly targetName?: string;
  readonly result: "success" | "failure";
  readonly actorUserId?: string | null;
  readonly correlationId?: string;
  readonly timestamp?: string;
  readonly error?: string | null;
}

export interface SharePointTemplateRoutesOptions {
  readonly store: SharePointTemplatesStore;
  readonly sitesCreate?: SharePointSitesCreateProvider;
  readonly resolveCaller: (ctx: RequestContext) => SharePointTemplateCaller | undefined;
  readonly authorize?: SharePointTemplateAuthorizer;
  readonly recordAudit?: (event: SharePointTemplateAuditEvent) => void | Promise<void>;
  readonly now?: () => string;
  readonly newId?: () => string;
}

export interface SharePointDeployTarget {
  readonly tenantId: string;
  readonly variables: Record<string, unknown>;
  readonly name?: string;
  readonly alias?: string;
  readonly owners?: readonly string[];
  readonly sharing?: string;
}

export interface SharePointDeployPlanEntry {
  readonly tenantId: string;
  readonly targetName: string;
  readonly alias: string;
  readonly type: SharePointSiteType;
  readonly owners: readonly string[];
  readonly sharing: SharePointSharing;
  readonly diff: readonly string[];
  readonly valid: boolean;
  readonly dryRun: true;
  readonly error: string | null;
}

export interface SharePointDeployTargetResult {
  readonly tenantId: string;
  readonly status: "created" | "failed";
  readonly targetName: string;
  readonly alias: string;
  readonly siteId: string | null;
  readonly error: string | null;
  readonly auditEvent?: Record<string, unknown>;
}

function unauthenticatedError(): AppError {
  return new AppError(SHAREPOINT_TEMPLATE_UNAUTHENTICATED, "authentication required", 401);
}

function notFoundError(id: string): AppError {
  return new AppError(SHAREPOINT_TEMPLATE_NOT_FOUND, `SharePoint template '${id}' not found`, 404);
}

function invalidTemplateError(details: ErrorDetail[], message = "Invalid SharePoint template"): AppError {
  return new AppError(SHAREPOINT_TEMPLATE_INVALID, message, 400, details);
}

function validationError(message: string, field: string): AppError {
  return new AppError(ErrorCodes.validationFailed, message, 400, [{ field, reason: "invalid" }]);
}

function requireCaller(
  resolveCaller: (ctx: RequestContext) => SharePointTemplateCaller | undefined,
  ctx: RequestContext,
): SharePointTemplateCaller {
  const caller = resolveCaller(ctx);
  if (caller === undefined) {
    throw unauthenticatedError();
  }
  return caller;
}

function requireIdParam(ctx: RequestContext): string {
  const value = ctx.params["id"];
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new AppError(ErrorCodes.validationFailed, "id is required", 400, [
      { field: "id", reason: "required" },
    ]);
  }
  return value.trim();
}

async function authorizePermission(
  options: SharePointTemplateRoutesOptions,
  caller: SharePointTemplateCaller,
  permission: string,
): Promise<void> {
  if (options.authorize) {
    await options.authorize(caller, permission);
    return;
  }
  const permissions = caller.permissions ?? [];
  if (!permissions.includes(permission) && !permissions.includes("*")) {
    throw new AppError(ErrorCodes.forbidden, `forbidden: missing ${permission}`, 403);
  }
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return undefined;
  }
  return value as Record<string, unknown>;
}

function readJsonBody(ctx: RequestContext): Record<string, unknown> {
  const raw = ctx.body;
  if (raw === undefined) {
    return {};
  }
  if (typeof raw === "string") {
    try {
      const parsed: unknown = JSON.parse(raw);
      const record = asRecord(parsed);
      if (!record) {
        throw validationError("request body must be a JSON object", "body");
      }
      return record;
    } catch (error) {
      if (error instanceof AppError) throw error;
      throw validationError("request body is not valid JSON", "body");
    }
  }
  const record = asRecord(raw);
  if (!record) {
    throw validationError("request body must be a JSON object", "body");
  }
  return record;
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function collectTemplateIssues(
  body: Record<string, unknown>,
  requireFields: { readonly name: boolean; readonly siteType: boolean },
): ErrorDetail[] {
  const issues: ErrorDetail[] = [];
  if (body["name"] !== undefined) {
    if (!nonEmptyString(body["name"])) {
      issues.push({ field: "name", reason: "must be a non-empty string" });
    }
  } else if (requireFields.name) {
    issues.push({ field: "name", reason: "must be a non-empty string" });
  }

  if (body["siteType"] !== undefined) {
    const rawType = typeof body["siteType"] === "string" ? body["siteType"].trim() : "";
    if (!(SHAREPOINT_SITE_TYPES as readonly string[]).includes(rawType)) {
      issues.push({ field: "siteType", reason: "must be team or communication" });
    }
  } else if (requireFields.siteType) {
    issues.push({ field: "siteType", reason: "must be team or communication" });
  }

  if (body["settings"] !== undefined && !asRecord(body["settings"])) {
    issues.push({ field: "settings", reason: "must be a JSON object" });
  }
  if (body["variables"] !== undefined && !asRecord(body["variables"])) {
    issues.push({ field: "variables", reason: "must be a JSON object" });
  }
  return issues;
}

function substituteTemplateText(templateText: string, variables: Record<string, unknown>): string {
  let out = templateText;
  for (const [key, value] of Object.entries(variables)) {
    if (value === undefined || value === null) continue;
    const replacement = typeof value === "string" ? value : String(value);
    out = out.split(`{{${key}}}`).join(replacement).split(`{${key}}`).join(replacement);
  }
  return out;
}

function parseOwnersValue(raw: unknown, variables: Record<string, unknown>): string[] {
  if (Array.isArray(raw)) {
    return raw
      .map((item) => substituteTemplateText(String(item), variables).trim())
      .filter(Boolean);
  }
  if (typeof raw === "string") {
    return substituteTemplateText(raw, variables)
      .split(/[\n,;]+/)
      .map((item) => item.trim())
      .filter(Boolean);
  }
  return [];
}

export function parseSharePointDeployTargets(body: Record<string, unknown>): SharePointDeployTarget[] {
  const sharedVariables = asRecord(body["variables"]) ?? {};
  const sharedOwners =
    body["owners"] !== undefined ? parseOwnersValue(body["owners"], sharedVariables) : undefined;
  const sharedName = nonEmptyString(body["name"]) ? body["name"].trim() : undefined;
  const sharedAlias = nonEmptyString(body["alias"]) ? body["alias"].trim() : undefined;
  const sharedSharing = nonEmptyString(body["sharing"]) ? body["sharing"].trim() : undefined;

  const targets: SharePointDeployTarget[] = [];
  const rawTargets = body["targets"];

  if (Array.isArray(rawTargets)) {
    for (const entry of rawTargets) {
      if (typeof entry === "string") {
        const tenantId = entry.trim();
        if (tenantId) {
          targets.push({
            tenantId,
            variables: { ...sharedVariables },
            ...(sharedName !== undefined ? { name: sharedName } : {}),
            ...(sharedAlias !== undefined ? { alias: sharedAlias } : {}),
            ...(sharedOwners !== undefined ? { owners: sharedOwners } : {}),
            ...(sharedSharing !== undefined ? { sharing: sharedSharing } : {}),
          });
        }
        continue;
      }
      const record = asRecord(entry);
      if (!record) continue;
      const tenantId = typeof record["tenantId"] === "string" ? record["tenantId"].trim() : "";
      if (!tenantId) continue;
      const mergedVars = { ...sharedVariables, ...(asRecord(record["variables"]) ?? {}) };
      const targetOwners =
        record["owners"] !== undefined
          ? parseOwnersValue(record["owners"], mergedVars)
          : sharedOwners;
      targets.push({
        tenantId,
        variables: mergedVars,
        ...(nonEmptyString(record["name"])
          ? { name: record["name"].trim() }
          : sharedName !== undefined
            ? { name: sharedName }
            : {}),
        ...(nonEmptyString(record["alias"])
          ? { alias: record["alias"].trim() }
          : sharedAlias !== undefined
            ? { alias: sharedAlias }
            : {}),
        ...(targetOwners !== undefined ? { owners: targetOwners } : {}),
        ...(nonEmptyString(record["sharing"])
          ? { sharing: record["sharing"].trim() }
          : sharedSharing !== undefined
            ? { sharing: sharedSharing }
            : {}),
      });
    }
    return targets;
  }

  const singleTenant = typeof body["tenantId"] === "string" ? body["tenantId"].trim() : "";
  if (singleTenant) {
    targets.push({
      tenantId: singleTenant,
      variables: { ...sharedVariables },
      ...(sharedName !== undefined ? { name: sharedName } : {}),
      ...(sharedAlias !== undefined ? { alias: sharedAlias } : {}),
      ...(sharedOwners !== undefined ? { owners: sharedOwners } : {}),
      ...(sharedSharing !== undefined ? { sharing: sharedSharing } : {}),
    });
  }
  return targets;
}

export function resolveSiteInputFromTemplate(
  template: SharePointTemplateRecord,
  target: SharePointDeployTarget,
  preview: boolean,
): CreateSharePointSiteInput {
  const vars: Record<string, unknown> = {
    ...(template.variables ?? {}),
    ...target.variables,
  };
  const settings = template.settings ?? {};

  const rawName =
    target.name ??
    (nonEmptyString(vars["name"])
      ? vars["name"]
      : nonEmptyString(vars["siteName"])
        ? vars["siteName"]
        : nonEmptyString(settings["name"])
          ? settings["name"]
          : nonEmptyString(settings["displayName"])
            ? settings["displayName"]
            : template.name);

  const rawAlias =
    target.alias ??
    (nonEmptyString(vars["alias"])
      ? vars["alias"]
      : nonEmptyString(settings["alias"])
        ? settings["alias"]
        : "");

  const resolvedOwners =
    target.owners && target.owners.length > 0
      ? [...target.owners]
      : parseOwnersValue(vars["owners"] ?? settings["owners"], vars);

  const rawSharing =
    target.sharing ??
    (nonEmptyString(vars["sharing"])
      ? vars["sharing"]
      : nonEmptyString(settings["sharing"])
        ? settings["sharing"]
        : "disabled");

  const resolvedSharing = substituteTemplateText(String(rawSharing), vars).trim();
  const sharing = (SHAREPOINT_SHARING_OPTIONS as readonly string[]).includes(resolvedSharing)
    ? (resolvedSharing as SharePointSharing)
    : (resolvedSharing as SharePointSharing);

  return {
    name: substituteTemplateText(String(rawName), vars).trim(),
    alias: substituteTemplateText(String(rawAlias), vars).trim(),
    type: template.siteType,
    owners: resolvedOwners,
    template: template.id,
    sharing,
    preview,
  };
}

function isPlan(value: SharePointSiteResult | SharePointSitePlan): value is SharePointSitePlan {
  return (value as SharePointSitePlan).dryRun === true;
}

export function createSharePointTemplateRoutes(
  options: SharePointTemplateRoutesOptions,
): Route[] {
  const newId = options.newId ?? randomUUID;
  const now = options.now ?? (() => new Date().toISOString());

  async function emitAudit(event: SharePointTemplateAuditEvent): Promise<void> {
    if (!options.recordAudit) return;
    await options.recordAudit({
      ...event,
      timestamp: event.timestamp ?? now(),
    });
  }

  return [
    {
      method: "GET",
      path: SHAREPOINT_TEMPLATES_PATH,
      handler: async (ctx: RequestContext): Promise<RouteResponse> => {
        const caller = requireCaller(options.resolveCaller, ctx);
        await authorizePermission(options, caller, SHAREPOINT_READ_PERMISSION);

        const templates = await options.store.listSharePointTemplates();
        const page = paginate(templates, parsePagination(ctx.query));
        return {
          status: 200,
          headers: { "content-type": "application/json" },
          body: {
            items: page.items,
            nextCursor: page.nextCursor,
            totalCount: templates.length,
          },
        };
      },
    },
    {
      method: "POST",
      path: SHAREPOINT_TEMPLATES_PATH,
      handler: async (ctx: RequestContext): Promise<RouteResponse> => {
        const caller = requireCaller(options.resolveCaller, ctx);
        await authorizePermission(options, caller, SHAREPOINT_WRITE_PERMISSION);

        const body = readJsonBody(ctx);
        const issues = collectTemplateIssues(body, { name: true, siteType: true });
        if (issues.length > 0) {
          throw invalidTemplateError(issues);
        }

        const timestamp = now();
        const created = await options.store.createSharePointTemplate({
          id: nonEmptyString(body["id"]) ? body["id"].trim() : newId(),
          name: (body["name"] as string).trim(),
          siteType: (body["siteType"] as string).trim() as SharePointSiteType,
          settings: asRecord(body["settings"]) ?? {},
          variables: asRecord(body["variables"]) ?? {},
          createdAt: timestamp,
          updatedAt: timestamp,
        });

        await emitAudit({
          tenantId: null,
          action: "sharepoint.template.create",
          targetType: "sharepointTemplate",
          targetId: created.id,
          targetName: created.name,
          result: "success",
          actorUserId: caller.userId ?? null,
          correlationId: ctx.correlationId,
        });

        return {
          status: 201,
          headers: { "content-type": "application/json" },
          body: created,
        };
      },
    },
    {
      method: "GET",
      path: SHAREPOINT_TEMPLATE_PATH,
      handler: async (ctx: RequestContext): Promise<RouteResponse> => {
        const caller = requireCaller(options.resolveCaller, ctx);
        await authorizePermission(options, caller, SHAREPOINT_READ_PERMISSION);

        const id = requireIdParam(ctx);
        const template = await options.store.getSharePointTemplate(id);
        if (!template || template.deletedAt !== null) {
          throw notFoundError(id);
        }
        return {
          status: 200,
          headers: { "content-type": "application/json" },
          body: template,
        };
      },
    },
    {
      method: "PATCH",
      path: SHAREPOINT_TEMPLATE_PATH,
      handler: async (ctx: RequestContext): Promise<RouteResponse> => {
        const caller = requireCaller(options.resolveCaller, ctx);
        await authorizePermission(options, caller, SHAREPOINT_WRITE_PERMISSION);

        const id = requireIdParam(ctx);
        const existing = await options.store.getSharePointTemplate(id);
        if (!existing || existing.deletedAt !== null) {
          throw notFoundError(id);
        }

        const body = readJsonBody(ctx);
        const issues = collectTemplateIssues(body, { name: false, siteType: false });
        if (issues.length > 0) {
          throw invalidTemplateError(issues);
        }

        const update: SharePointTemplateUpdateInput = {};
        if (body["name"] !== undefined) update.name = (body["name"] as string).trim();
        if (body["siteType"] !== undefined) {
          update.siteType = (body["siteType"] as string).trim() as SharePointSiteType;
        }
        if (body["settings"] !== undefined) update.settings = asRecord(body["settings"]) ?? {};
        if (body["variables"] !== undefined) update.variables = asRecord(body["variables"]) ?? {};

        const updated = await options.store.updateSharePointTemplate(id, update);
        if (!updated) {
          throw notFoundError(id);
        }

        await emitAudit({
          tenantId: null,
          action: "sharepoint.template.update",
          targetType: "sharepointTemplate",
          targetId: updated.id,
          targetName: updated.name,
          result: "success",
          actorUserId: caller.userId ?? null,
          correlationId: ctx.correlationId,
        });

        return {
          status: 200,
          headers: { "content-type": "application/json" },
          body: updated,
        };
      },
    },
    {
      method: "DELETE",
      path: SHAREPOINT_TEMPLATE_PATH,
      handler: async (ctx: RequestContext): Promise<RouteResponse> => {
        const caller = requireCaller(options.resolveCaller, ctx);
        await authorizePermission(options, caller, SHAREPOINT_WRITE_PERMISSION);

        const id = requireIdParam(ctx);
        const existing = await options.store.getSharePointTemplate(id);
        if (!existing || existing.deletedAt !== null) {
          throw notFoundError(id);
        }

        const deleted = await options.store.softDeleteSharePointTemplate(id, { now: now() });
        if (!deleted) {
          throw notFoundError(id);
        }

        await emitAudit({
          tenantId: null,
          action: "sharepoint.template.delete",
          targetType: "sharepointTemplate",
          targetId: id,
          targetName: existing.name,
          result: "success",
          actorUserId: caller.userId ?? null,
          correlationId: ctx.correlationId,
        });

        return { status: 204 };
      },
    },
    {
      method: "POST",
      path: SHAREPOINT_TEMPLATE_DEPLOY_PATH,
      handler: async (ctx: RequestContext): Promise<RouteResponse> => {
        const caller = requireCaller(options.resolveCaller, ctx);
        await authorizePermission(options, caller, SHAREPOINT_WRITE_PERMISSION);

        const body = readJsonBody(ctx);
        const previewValue = body["preview"];
        if (previewValue !== undefined && typeof previewValue !== "boolean") {
          throw validationError("preview must be a boolean", "preview");
        }
        const isPreview = previewValue === true || ctx.query.get("preview") === "true";

        if (!isPreview) {
          await authorizePermission(options, caller, REMEDIATION_APPLY_PERMISSION);
        }

        const id = requireIdParam(ctx);
        const template = await options.store.getSharePointTemplate(id);
        if (!template || template.deletedAt !== null) {
          throw notFoundError(id);
        }

        const targets = parseSharePointDeployTargets(body);
        if (targets.length === 0) {
          throw new AppError(
            ErrorCodes.validationFailed,
            "At least one target tenant must be specified in 'targets' or 'tenantId'",
            400,
            [{ field: "targets", reason: "required" }],
          );
        }

        for (const target of targets) {
          requireTenantInScope(caller, target.tenantId);
        }

        if (!options.sitesCreate) {
          throw new AppError(
            SHAREPOINT_TEMPLATE_DEPLOY_UNAVAILABLE,
            "SharePoint site creation provider is not configured",
            503,
          );
        }

        if (isPreview) {
          const plans: SharePointDeployPlanEntry[] = [];
          for (const target of targets) {
            const siteInput = resolveSiteInputFromTemplate(template, target, true);
            const validation = validateSharePointSiteInput(siteInput);
            if (!validation.valid) {
              plans.push({
                tenantId: target.tenantId,
                targetName: siteInput.name || template.name,
                alias: siteInput.alias,
                type: siteInput.type,
                owners: siteInput.owners,
                sharing: siteInput.sharing,
                diff: [],
                valid: false,
                dryRun: true,
                error: validation.error ?? "Invalid resolved site configuration",
              });
              continue;
            }
            const outcome = await options.sitesCreate.createSite(target.tenantId, siteInput, true);
            const plan: SharePointSitePlan = isPlan(outcome) ? outcome : outcome.plan;
            plans.push({
              tenantId: target.tenantId,
              targetName: plan.targetName,
              alias: siteInput.alias,
              type: siteInput.type,
              owners: siteInput.owners,
              sharing: siteInput.sharing,
              diff: plan.diff,
              valid: plan.valid,
              dryRun: true,
              error: null,
            });
          }

          return {
            status: 200,
            headers: { "content-type": "application/json" },
            body: {
              templateId: template.id,
              preview: true,
              plans,
              allValid: plans.every((plan) => plan.valid),
            },
          };
        }

        const results: SharePointDeployTargetResult[] = [];
        const auditEvents: Record<string, unknown>[] = [];

        for (const target of targets) {
          const siteInput = resolveSiteInputFromTemplate(template, target, false);
          const validation = validateSharePointSiteInput(siteInput);
          if (!validation.valid) {
            const errorMsg = validation.error ?? "Invalid resolved site configuration";
            const auditEvent: SharePointTemplateAuditEvent = {
              tenantId: target.tenantId,
              action: "sharepoint.template.deploy",
              targetType: "sharepointSite",
              targetId: template.id,
              targetName: siteInput.name || template.name,
              result: "failure",
              error: errorMsg,
              actorUserId: caller.userId ?? null,
              correlationId: ctx.correlationId,
            };
            await emitAudit(auditEvent);
            auditEvents.push({ ...auditEvent });
            results.push({
              tenantId: target.tenantId,
              status: "failed",
              targetName: siteInput.name || template.name,
              alias: siteInput.alias,
              siteId: null,
              error: errorMsg,
            });
            continue;
          }

          try {
            const outcome = await options.sitesCreate.createSite(target.tenantId, siteInput, false);
            if (isPlan(outcome)) {
              results.push({
                tenantId: target.tenantId,
                status: "failed",
                targetName: siteInput.name,
                alias: siteInput.alias,
                siteId: null,
                error: "Site create returned a plan instead of an applied result",
              });
              continue;
            }
            const createdOk = outcome.success === true;
            const auditEvent: Record<string, unknown> = outcome.auditEvent
              ? { ...outcome.auditEvent }
              : {
                  tenantId: target.tenantId,
                  action: "sharepoint.template.deploy",
                  targetType: "sharepointSite",
                  targetId: outcome.siteId ?? template.id,
                  targetName: siteInput.name,
                  result: createdOk ? "success" : "failure",
                  actorUserId: caller.userId ?? null,
                  correlationId: ctx.correlationId,
                };
            await emitAudit({
              tenantId: target.tenantId,
              action: String(auditEvent["action"] ?? "sharepoint.template.deploy"),
              targetType: "sharepointSite",
              targetId: String(auditEvent["targetId"] ?? outcome.siteId ?? template.id),
              targetName: String(auditEvent["targetName"] ?? siteInput.name),
              result: createdOk ? "success" : "failure",
              actorUserId: caller.userId ?? null,
              correlationId: ctx.correlationId,
              ...(createdOk ? {} : { error: "Site creation failed" }),
            });
            auditEvents.push(auditEvent);
            results.push({
              tenantId: target.tenantId,
              status: createdOk ? "created" : "failed",
              targetName: outcome.plan?.targetName ?? siteInput.name,
              alias: siteInput.alias,
              siteId: outcome.siteId,
              error: createdOk ? null : "Site creation failed",
              auditEvent,
            });
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            const auditEvent: SharePointTemplateAuditEvent = {
              tenantId: target.tenantId,
              action: "sharepoint.template.deploy",
              targetType: "sharepointSite",
              targetId: template.id,
              targetName: siteInput.name,
              result: "failure",
              error: message,
              actorUserId: caller.userId ?? null,
              correlationId: ctx.correlationId,
            };
            await emitAudit(auditEvent);
            auditEvents.push({ ...auditEvent });
            results.push({
              tenantId: target.tenantId,
              status: "failed",
              targetName: siteInput.name,
              alias: siteInput.alias,
              siteId: null,
              error: message,
            });
          }
        }

        const created = results.filter((entry) => entry.status === "created").length;
        const failed = results.length - created;
        const status = failed === 0 ? 200 : created > 0 ? 207 : 422;

        return {
          status,
          headers: { "content-type": "application/json" },
          body: {
            templateId: template.id,
            preview: false,
            results,
            summary: { total: results.length, created, failed },
            auditEvents,
          },
        };
      },
    },
  ];
}

// Route modules own their OpenAPI path items (portal.v1.yaml `paths` is empty
// by design); a wiring ticket merges this fragment into the served document.
export const SHAREPOINT_TEMPLATES_OPENAPI = {
  paths: {
    "/sharepoint/templates": {
      get: {
        operationId: "listSharePointTemplates",
        summary: "List persisted SharePoint site templates",
        permission: SHAREPOINT_READ_PERMISSION,
        security: [{ bearerAuth: [] }],
        parameters: [
          { name: "cursor", in: "query", required: false, schema: { type: "string" } },
          { name: "limit", in: "query", required: false, schema: { type: "integer" } },
        ],
        responses: {
          "200": { description: "Cursor-paginated SharePoint templates." },
          "401": { description: "Authentication required." },
          "403": { description: "The caller lacks SharePoint.Site.Read." },
        },
      },
      post: {
        operationId: "createSharePointTemplate",
        summary: "Create a SharePoint site template",
        permission: SHAREPOINT_WRITE_PERMISSION,
        security: [{ bearerAuth: [] }],
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["name", "siteType"],
                properties: {
                  id: { type: "string" },
                  name: { type: "string" },
                  siteType: { type: "string", enum: [...SHAREPOINT_SITE_TYPES] },
                  settings: { type: "object", additionalProperties: true },
                  variables: { type: "object", additionalProperties: true },
                },
              },
            },
          },
        },
        responses: {
          "201": { description: "The persisted SharePoint template." },
          "400": { description: "The template failed shape validation." },
          "401": { description: "Authentication required." },
          "403": { description: "The caller lacks SharePoint.Site.ReadWrite." },
        },
      },
    },
    "/sharepoint/templates/{id}": {
      get: {
        operationId: "getSharePointTemplate",
        summary: "Read a SharePoint site template",
        permission: SHAREPOINT_READ_PERMISSION,
        security: [{ bearerAuth: [] }],
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
        responses: {
          "200": { description: "The SharePoint template." },
          "401": { description: "Authentication required." },
          "403": { description: "The caller lacks SharePoint.Site.Read." },
          "404": { description: "No live SharePoint template has that id." },
        },
      },
      patch: {
        operationId: "updateSharePointTemplate",
        summary: "Update a SharePoint site template",
        permission: SHAREPOINT_WRITE_PERMISSION,
        security: [{ bearerAuth: [] }],
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: {
                  name: { type: "string" },
                  siteType: { type: "string", enum: [...SHAREPOINT_SITE_TYPES] },
                  settings: { type: "object", additionalProperties: true },
                  variables: { type: "object", additionalProperties: true },
                },
              },
            },
          },
        },
        responses: {
          "200": { description: "The updated SharePoint template." },
          "400": { description: "The update failed shape validation." },
          "401": { description: "Authentication required." },
          "403": { description: "The caller lacks SharePoint.Site.ReadWrite." },
          "404": { description: "No live SharePoint template has that id." },
        },
      },
      delete: {
        operationId: "deleteSharePointTemplate",
        summary: "Soft-delete a SharePoint site template",
        permission: SHAREPOINT_WRITE_PERMISSION,
        security: [{ bearerAuth: [] }],
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
        responses: {
          "204": { description: "The SharePoint template was soft-deleted." },
          "401": { description: "Authentication required." },
          "403": { description: "The caller lacks SharePoint.Site.ReadWrite." },
          "404": { description: "No live SharePoint template has that id." },
        },
      },
    },
    "/sharepoint/templates/{id}/deploy": {
      post: {
        operationId: "deploySharePointTemplate",
        summary:
          "Deploy a SharePoint site template to one or more target tenants (preview with preview:true; apply needs SharePoint.Site.ReadWrite and Remediation.Apply)",
        permission: SHAREPOINT_WRITE_PERMISSION,
        security: [{ bearerAuth: [] }],
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: {
                  targets: {
                    type: "array",
                    items: {
                      oneOf: [
                        { type: "string" },
                        {
                          type: "object",
                          required: ["tenantId"],
                          properties: {
                            tenantId: { type: "string" },
                            name: { type: "string" },
                            alias: { type: "string" },
                            owners: { type: "array", items: { type: "string" } },
                            sharing: { type: "string" },
                            variables: { type: "object", additionalProperties: true },
                          },
                        },
                      ],
                    },
                  },
                  tenantId: { type: "string" },
                  name: { type: "string" },
                  alias: { type: "string" },
                  owners: { type: "array", items: { type: "string" } },
                  sharing: { type: "string" },
                  variables: { type: "object", additionalProperties: true },
                  preview: { type: "boolean" },
                },
              },
            },
          },
        },
        responses: {
          "200": { description: "Preview plans, or all target tenants deployed." },
          "207": { description: "Some target tenants deployed and some failed." },
          "400": { description: "Invalid target specification." },
          "401": { description: "Authentication required." },
          "403": { description: "The caller lacks SharePoint.Site.ReadWrite / Remediation.Apply or target tenant is out of scope." },
          "404": { description: "No live SharePoint template has that id." },
          "422": { description: "All target tenants failed." },
        },
      },
    },
  },
} as const;
