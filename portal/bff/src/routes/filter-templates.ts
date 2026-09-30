// Filter template CRUD and deploy (EPIC-022 SPEC.md §2 US-2, §3.2, §4.1, §5, §6,
// §7, §8; T-0423). Exposes the §6 template surface:
//   GET/POST     /v1/filter-templates
//   GET/PATCH/DELETE /v1/filter-templates/:templateId
//   POST         /v1/filter-templates/:templateId/clone
//   POST         /v1/filter-templates/:templateId/deploy
// Templates persist only locally (SPEC §5); reads require `spam.read` and
// writes require `spam.write` (SPEC §7). Deploy resolves the template's
// %name% variables (domains, IPs, action overrides) and applies the resolved
// policy through the EPIC-006 gate (T-0107): a missing required variable is a
// validation error, never a partial apply, and every applied deploy enqueues a
// remediation job with before/after and an AuditEvent. No direct EXO write
// bypasses EPIC-006.
import { randomUUID } from "node:crypto";
import type { JobEnvelope } from "@m365-assess/contracts";
import {
  resolveFilterTemplatePolicy,
  resolvedPolicyState,
} from "../domain/filters/template-deploy.js";
import {
  assessFilterPolicyChange,
  type FilterPolicyAction,
  type FilterPolicyState,
  type FilterType,
} from "../domain/filters/policy-guard.js";
import { AppError, ErrorCodes } from "../errors.js";
import { requireTenantInScope, type Caller } from "../rbac/authorize.js";
import type { RequestContext, Route, RouteResponse } from "../server.js";
import { parseFilterType } from "./filters.js";
import type { FiltersProvider } from "./filters.js";

export { FILTER_TYPES, type FilterType } from "../domain/filters/policy-guard.js";

export const FILTER_TEMPLATES_PATH = "/v1/filter-templates";
export const FILTER_TEMPLATE_ITEM_PATH = "/v1/filter-templates/:templateId";
export const FILTER_TEMPLATE_CLONE_PATH = "/v1/filter-templates/:templateId/clone";
export const FILTER_TEMPLATE_DEPLOY_PATH = "/v1/filter-templates/:templateId/deploy";

export const FILTER_TEMPLATES_READ_PERMISSION = "spam.read";
export const FILTER_TEMPLATES_WRITE_PERMISSION = "spam.write";
export const REMEDIATION_APPLY_PERMISSION = "Remediation.Apply";
export const FILTER_TEMPLATES_UNAUTHENTICATED = "request.unauthenticated";
export const FILTER_TEMPLATE_NOT_FOUND = "filter_template.not_found";

export interface StoredFilterTemplate {
  id: string;
  name: string;
  filterType: string;
  policyJson: unknown;
  variables: string[];
  source: string;
  createdBy: string | null;
  updatedBy: string | null;
  createdAt: string;
  updatedAt: string;
  deletedAt: string | null;
}

export interface CreateFilterTemplateInput {
  id?: string;
  name: string;
  filterType: string;
  policyJson: unknown;
  variables?: string[];
  source?: string;
  createdBy?: string | null;
  actorUserId?: string | null;
  correlationId?: string | null;
}

export interface UpdateFilterTemplateInput {
  name?: string;
  filterType?: string;
  policyJson?: unknown;
  variables?: string[];
  actorUserId?: string | null;
  correlationId?: string | null;
}

export interface CloneFilterTemplateInput {
  id?: string;
  name: string;
  createdBy?: string | null;
  actorUserId?: string | null;
  correlationId?: string | null;
}

export interface TemplateListOptions {
  includeDeleted?: boolean;
}

export interface TemplateReadOptions {
  includeDeleted?: boolean;
}

export interface FilterTemplateStore {
  createTemplate(input: CreateFilterTemplateInput): Promise<StoredFilterTemplate>;
  getTemplate(
    id: string,
    options?: TemplateReadOptions,
  ): Promise<StoredFilterTemplate | undefined>;
  listTemplates(options?: TemplateListOptions): Promise<StoredFilterTemplate[]>;
  updateTemplate(
    id: string,
    input: UpdateFilterTemplateInput,
  ): Promise<StoredFilterTemplate | undefined>;
  softDeleteTemplate(
    id: string,
    options?: { actorUserId?: string | null; correlationId?: string | null },
  ): Promise<boolean>;
  cloneTemplate(
    sourceId: string,
    input: CloneFilterTemplateInput,
  ): Promise<StoredFilterTemplate | undefined>;
}

export interface FilterTemplateDeployPlan {
  readonly action: FilterPolicyAction;
  readonly filterType: FilterType;
  readonly policyName: string;
  readonly before: FilterPolicyState | null;
  readonly after: FilterPolicyState | null;
  readonly diff: readonly string[];
  readonly valid: boolean;
  readonly dryRun: boolean;
  readonly securityImpacting: boolean;
  readonly requiresConfirmation: boolean;
  readonly warning?: string;
}

export interface FilterTemplateDeployResult {
  readonly success: boolean;
  readonly plan: FilterTemplateDeployPlan;
  readonly jobId: string;
  readonly auditEventId?: string;
}

export interface FilterTemplatesCaller extends Caller {
  readonly userId?: string;
}

export type FilterTemplatesAuthorizer = (
  caller: FilterTemplatesCaller,
  permission: string,
) => void | Promise<void>;

export interface FilterTemplatesRouteOptions {
  readonly store: FilterTemplateStore;
  readonly provider?: FiltersProvider;
  readonly queue?: {
    enqueue(envelope: JobEnvelope): Promise<string>;
  };
  readonly resolveCaller: (ctx: RequestContext) => FilterTemplatesCaller | undefined;
  readonly authorize?: FilterTemplatesAuthorizer;
  readonly recordAudit?: (event: Record<string, unknown>) => Promise<void>;
  readonly idGenerator?: () => string;
  readonly now?: () => string;
}

function unauthenticatedError(): AppError {
  return new AppError(FILTER_TEMPLATES_UNAUTHENTICATED, "authentication required", 401);
}

function validationError(message: string, field: string): AppError {
  return new AppError(ErrorCodes.validationFailed, message, 400, [
    { field, reason: "invalid" },
  ]);
}

function notFoundError(id: string | undefined): AppError {
  return new AppError(
    FILTER_TEMPLATE_NOT_FOUND,
    id === undefined ? "Filter template not found" : `Filter template ${id} not found`,
    404,
  );
}

function requireCaller(
  resolveCaller: (ctx: RequestContext) => FilterTemplatesCaller | undefined,
  ctx: RequestContext,
): FilterTemplatesCaller {
  const caller = resolveCaller(ctx);
  if (caller === undefined) {
    throw unauthenticatedError();
  }
  return caller;
}

function requireParam(ctx: RequestContext, name: string): string {
  const value = ctx.params[name];
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new AppError(ErrorCodes.validationFailed, `Missing path parameter '${name}'`, 400, [
      { field: name, reason: "required" },
    ]);
  }
  return value.trim();
}

async function requireRead(
  options: FilterTemplatesRouteOptions,
  caller: FilterTemplatesCaller,
): Promise<void> {
  if (options.authorize) {
    await options.authorize(caller, FILTER_TEMPLATES_READ_PERMISSION);
    return;
  }
  const permissions = caller.permissions ?? [];
  if (!permissions.includes(FILTER_TEMPLATES_READ_PERMISSION) && !permissions.includes("*")) {
    throw new AppError(ErrorCodes.forbidden, "forbidden: missing spam.read", 403);
  }
}

async function requireWrite(
  options: FilterTemplatesRouteOptions,
  caller: FilterTemplatesCaller,
): Promise<void> {
  if (options.authorize) {
    await options.authorize(caller, FILTER_TEMPLATES_WRITE_PERMISSION);
    return;
  }
  const permissions = caller.permissions ?? [];
  const hasWrite =
    permissions.includes(FILTER_TEMPLATES_WRITE_PERMISSION) ||
    permissions.includes(REMEDIATION_APPLY_PERMISSION) ||
    permissions.includes("*");
  if (!hasWrite) {
    throw new AppError(ErrorCodes.forbidden, "forbidden: missing spam.write", 403);
  }
}

function readBodyRecord(ctx: RequestContext): Record<string, unknown> {
  const body = (ctx.body ?? {}) as Record<string, unknown>;
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    throw validationError("Request body must be a JSON object", "body");
  }
  return body;
}

function optionalBodyRecord(ctx: RequestContext): Record<string, unknown> | undefined {
  const body = ctx.body;
  if (body === undefined || body === null || body === "") return undefined;
  return readBodyRecord(ctx);
}

function requireString(record: Record<string, unknown>, field: string): string {
  const value = record[field];
  if (typeof value !== "string" || value.trim().length === 0) {
    throw validationError(`Missing required string field '${field}'`, field);
  }
  return value.trim();
}

function requirePolicyJson(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw validationError("Field 'policyJson' must be a JSON object", "policyJson");
  }
  return value as Record<string, unknown>;
}

function readTemplateVariables(value: unknown): string[] | undefined {
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw validationError("Field 'variables' must be an array of variable names", "variables");
  }
  return value as string[];
}

function readDeployVariables(value: unknown): Record<string, string> {
  if (value === undefined || value === null) return {};
  if (typeof value !== "object" || Array.isArray(value)) {
    throw validationError("Field 'variables' must be a JSON object of names to values", "variables");
  }
  const variables: Record<string, string> = {};
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    if (typeof item !== "string") {
      throw validationError(`Field 'variables.${key}' must be a string`, `variables.${key}`);
    }
    variables[key] = item;
  }
  return variables;
}

function readPreviewFlag(ctx: RequestContext, body: Record<string, unknown>): boolean {
  return Boolean(body["preview"] ?? (ctx.query.get("preview") === "true"));
}

function optionalBoolean(value: unknown, field: string): boolean | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "boolean") {
    throw validationError(`Field '${field}' must be a boolean`, field);
  }
  return value;
}

function requireConfirmation(
  assessment: { securityImpacting: boolean; requiresConfirmation: boolean },
  body: Record<string, unknown>,
): void {
  if (!assessment.securityImpacting) return;
  const confirm = optionalBoolean(body["confirm"], "confirm") ?? false;
  if (!confirm) {
    throw new AppError(
      "filters.confirm_required",
      "disabling or weakening a filter is security-impacting and requires confirmation",
      400,
      [{ field: "confirm", reason: "required" }],
    );
  }
}

function buildDeployPlan(
  action: FilterPolicyAction,
  filterType: FilterType,
  policyName: string,
  before: FilterPolicyState | null,
  after: FilterPolicyState | null,
  assessment: { securityImpacting: boolean; requiresConfirmation: boolean; warning?: string; reasons: readonly string[] },
  dryRun: boolean,
): FilterTemplateDeployPlan {
  const diff: string[] = [];
  if (action === "create") {
    diff.push(`Create ${filterType} filter '${after?.name ?? policyName}'`);
  } else if (before && after) {
    if (before.name !== after.name) {
      diff.push(`Rename ${filterType} filter from '${before.name}' to '${after.name}'`);
    }
    if (before.enabled !== after.enabled) {
      diff.push(`Change ${filterType} filter state from '${before.enabled}' to '${after.enabled}'`);
    }
    if (JSON.stringify(before.settings) !== JSON.stringify(after.settings)) {
      diff.push(`Update ${filterType} filter settings`);
    }
  }
  for (const reason of assessment.reasons) {
    diff.push(reason);
  }
  return {
    action,
    filterType,
    policyName,
    before,
    after,
    diff,
    valid: true,
    dryRun,
    requiresConfirmation: assessment.requiresConfirmation,
    securityImpacting: assessment.securityImpacting,
    ...(assessment.warning !== undefined ? { warning: assessment.warning } : {}),
  };
}

function buildRemediationEnvelope(
  ctx: RequestContext,
  tenantId: string,
  jobId: string,
  requestId: string,
  createdAt: string,
  extraPayload: Record<string, unknown>,
): JobEnvelope {
  return {
    schemaVersion: "v1",
    jobId,
    jobType: "remediation",
    tenantId,
    runId: "",
    requestId,
    correlationId: ctx.correlationId,
    createdAt,
    payload: {
      contextRef: `remediation/${tenantId}/${jobId}/job.json`,
      outputRef: `remediation/${tenantId}/${jobId}`,
      credentialRef: `tenants/${tenantId}/credential`,
      sectionRefs: [],
      artifactRefs: [],
      operation: "apply",
      ...extraPayload,
    },
  };
}

function auditActionFor(action: FilterPolicyAction): string {
  switch (action) {
    case "create":
      return "filters.policy.create";
    case "edit":
      return "filters.policy.edit";
    case "enable":
      return "filters.policy.enable";
    case "disable":
      return "filters.policy.disable";
    case "delete":
      return "filters.policy.delete";
  }
}

function requireQueue(
  options: FilterTemplatesRouteOptions,
): { enqueue(envelope: JobEnvelope): Promise<string> } {
  if (!options.queue) {
    throw new AppError(ErrorCodes.internalError, "filter template deploys require a worker queue", 500);
  }
  return options.queue;
}

function toResponse(template: StoredFilterTemplate): Record<string, unknown> {
  return {
    id: template.id,
    name: template.name,
    filterType: template.filterType,
    policyJson: template.policyJson,
    variables: template.variables,
    source: template.source,
    createdBy: template.createdBy,
    updatedBy: template.updatedBy,
    createdAt: template.createdAt,
    updatedAt: template.updatedAt,
  };
}

function requireTemplate(
  template: StoredFilterTemplate | undefined,
): StoredFilterTemplate {
  if (!template || template.deletedAt !== null) {
    throw notFoundError(template?.id);
  }
  return template;
}

export function createFilterTemplateRoutes(options: FilterTemplatesRouteOptions): Route[] {
  const idGenerator = options.idGenerator ?? (() => randomUUID());
  const now = options.now ?? (() => new Date().toISOString());

  const list: Route["handler"] = async (ctx) => {
    const caller = requireCaller(options.resolveCaller, ctx);
    await requireRead(options, caller);
    const templates = await options.store.listTemplates();
    return {
      status: 200,
      headers: { "content-type": "application/json" },
      body: { items: templates.map(toResponse), totalCount: templates.length },
    };
  };

  const create: Route["handler"] = async (ctx) => {
    const caller = requireCaller(options.resolveCaller, ctx);
    await requireWrite(options, caller);
    const body = readBodyRecord(ctx);
    const name = requireString(body, "name");
    const filterType = parseFilterType(body["filterType"]);
    const policyJson = requirePolicyJson(body["policyJson"]);
    const variables = readTemplateVariables(body["variables"]) ?? [];
    const created = await options.store.createTemplate({
      id: randomUUID(),
      name,
      filterType,
      policyJson,
      variables,
      source: "local",
      createdBy: caller.userId ?? null,
      actorUserId: caller.userId ?? null,
      correlationId: ctx.correlationId,
    });
    return { status: 201, headers: { "content-type": "application/json" }, body: toResponse(created) };
  };

  const get: Route["handler"] = async (ctx) => {
    const caller = requireCaller(options.resolveCaller, ctx);
    await requireRead(options, caller);
    const template = requireTemplate(
      await options.store.getTemplate(requireParam(ctx, "templateId")),
    );
    return { status: 200, headers: { "content-type": "application/json" }, body: toResponse(template) };
  };

  const update: Route["handler"] = async (ctx) => {
    const caller = requireCaller(options.resolveCaller, ctx);
    await requireWrite(options, caller);
    const id = requireParam(ctx, "templateId");
    requireTemplate(await options.store.getTemplate(id));
    const body = readBodyRecord(ctx);
    const name = body["name"] === undefined ? undefined : requireString(body, "name");
    const filterType =
      body["filterType"] === undefined ? undefined : parseFilterType(body["filterType"]);
    const policyJson =
      body["policyJson"] === undefined ? undefined : requirePolicyJson(body["policyJson"]);
    const variables = readTemplateVariables(body["variables"]);
    if (name === undefined && filterType === undefined && policyJson === undefined && variables === undefined) {
      throw validationError("at least one of name, filterType, policyJson, or variables is required", "body");
    }
    const updated = await options.store.updateTemplate(id, {
      name,
      filterType,
      policyJson,
      variables,
      actorUserId: caller.userId ?? null,
      correlationId: ctx.correlationId,
    });
    return {
      status: 200,
      headers: { "content-type": "application/json" },
      body: toResponse(requireTemplate(updated)),
    };
  };

  const remove: Route["handler"] = async (ctx) => {
    const caller = requireCaller(options.resolveCaller, ctx);
    await requireWrite(options, caller);
    const id = requireParam(ctx, "templateId");
    requireTemplate(await options.store.getTemplate(id));
    const deleted = await options.store.softDeleteTemplate(id, {
      actorUserId: caller.userId ?? null,
      correlationId: ctx.correlationId,
    });
    if (!deleted) throw notFoundError(id);
    return { status: 204 };
  };

  const clone: Route["handler"] = async (ctx) => {
    const caller = requireCaller(options.resolveCaller, ctx);
    await requireWrite(options, caller);
    const sourceId = requireParam(ctx, "templateId");
    const source = requireTemplate(await options.store.getTemplate(sourceId));
    const body = optionalBodyRecord(ctx);
    const name =
      body === undefined || body["name"] === undefined
        ? `${source.name} (copy)`
        : requireString(body, "name");
    const cloned = await options.store.cloneTemplate(sourceId, {
      id: randomUUID(),
      name,
      createdBy: caller.userId ?? null,
      actorUserId: caller.userId ?? null,
      correlationId: ctx.correlationId,
    });
    return {
      status: 201,
      headers: { "content-type": "application/json" },
      body: toResponse(requireTemplate(cloned)),
    };
  };

  const deploy: Route["handler"] = async (ctx) => {
    const caller = requireCaller(options.resolveCaller, ctx);
    const templateId = requireParam(ctx, "templateId");
    const template = requireTemplate(await options.store.getTemplate(templateId));
    await requireWrite(options, caller);

    const body = readBodyRecord(ctx);
    const tenantId = requireString(body, "tenantId");
    requireTenantInScope(caller, tenantId);
    const supplied = readDeployVariables(body["variables"]);
    const isPreview = readPreviewFlag(ctx, body);
    const filterType = parseFilterType(template.filterType);

    const resolved = resolveFilterTemplatePolicy({
      policyJson: template.policyJson,
      requiredVariables: template.variables,
      variables: supplied,
    });
    const after = resolvedPolicyState(resolved);

    let before: FilterPolicyState | null = null;
    if (options.provider) {
      const existing = await options.provider.getFilterPolicy(tenantId, filterType, resolved.name);
      if (existing) {
        before = { name: existing.name, enabled: existing.enabled, settings: existing.settings };
      }
    }
    const action: FilterPolicyAction = before === null ? "create" : "edit";
    const assessment = assessFilterPolicyChange({ action, filterType, before, after });
    if (!assessment.valid) {
      throw validationError(assessment.reasons.join("; "), "body");
    }

    const plan = buildDeployPlan(action, filterType, resolved.name, before, after, assessment, isPreview);
    if (isPreview) {
      return { status: 200, headers: { "content-type": "application/json" }, body: plan };
    }

    requireConfirmation(assessment, body);

    const queue = requireQueue(options);
    const jobId = idGenerator();
    const requestId = idGenerator();
    const auditEventId = idGenerator();
    const createdAt = now();
    const actor = caller.userId ?? "unknown";

    await queue.enqueue(
      buildRemediationEnvelope(ctx, tenantId, jobId, requestId, createdAt, {
        area: "filters",
        action,
        filterType,
        policyName: resolved.name,
        settings: resolved.settings,
        actor,
      }),
    );

    if (options.recordAudit) {
      await options.recordAudit({
        action: auditActionFor(action),
        tenantId,
        actorUserId: actor,
        targetId: resolved.name,
        correlationId: ctx.correlationId,
        timestamp: createdAt,
        before,
        after,
      });
    }

    const result: FilterTemplateDeployResult = {
      success: true,
      plan: { ...plan, dryRun: false },
      jobId,
      auditEventId,
    };
    return { status: 202, headers: { "content-type": "application/json" }, body: result };
  };

  return [
    { method: "GET", path: FILTER_TEMPLATES_PATH, handler: list },
    { method: "POST", path: FILTER_TEMPLATES_PATH, handler: create },
    { method: "GET", path: FILTER_TEMPLATE_ITEM_PATH, handler: get },
    { method: "PATCH", path: FILTER_TEMPLATE_ITEM_PATH, handler: update },
    { method: "DELETE", path: FILTER_TEMPLATE_ITEM_PATH, handler: remove },
    { method: "POST", path: FILTER_TEMPLATE_CLONE_PATH, handler: clone },
    { method: "POST", path: FILTER_TEMPLATE_DEPLOY_PATH, handler: deploy },
  ];
}

// Route modules own their OpenAPI path items (portal.v1.yaml `paths` is empty
// by design); a wiring ticket merges this fragment into the served document.
export const FILTER_TEMPLATES_OPENAPI = {
  paths: {
    "/filter-templates": {
      get: {
        operationId: "listFilterTemplates",
        summary: "List filter templates (spam/anti-phish/malware/connection)",
        permission: FILTER_TEMPLATES_READ_PERMISSION,
        security: [{ bearerAuth: [] }],
        responses: {
          "200": { description: "Filter templates with name, filterType, variables, and source." },
          "401": { description: "Authentication required." },
          "403": { description: "The caller lacks spam.read." },
        },
      },
      post: {
        operationId: "createFilterTemplate",
        summary: "Create a filter template; it persists with a local source",
        permission: FILTER_TEMPLATES_WRITE_PERMISSION,
        security: [{ bearerAuth: [] }],
        responses: {
          "201": { description: "The created filter template." },
          "400": { description: "name, filterType, or policyJson failed validation." },
          "401": { description: "Authentication required." },
          "403": { description: "The caller lacks spam.write." },
        },
      },
    },
    "/filter-templates/{templateId}": {
      get: {
        operationId: "getFilterTemplate",
        summary: "Filter template detail",
        permission: FILTER_TEMPLATES_READ_PERMISSION,
        security: [{ bearerAuth: [] }],
        parameters: [{ name: "templateId", in: "path", required: true, schema: { type: "string" } }],
        responses: {
          "200": { description: "The filter template." },
          "401": { description: "Authentication required." },
          "403": { description: "The caller lacks spam.read." },
          "404": { description: "Filter template not found." },
        },
      },
      patch: {
        operationId: "updateFilterTemplate",
        summary: "Update a filter template's name, filterType, policyJson, or variables",
        permission: FILTER_TEMPLATES_WRITE_PERMISSION,
        security: [{ bearerAuth: [] }],
        parameters: [{ name: "templateId", in: "path", required: true, schema: { type: "string" } }],
        responses: {
          "200": { description: "The updated filter template." },
          "400": { description: "No editable field was supplied, or a field failed validation." },
          "401": { description: "Authentication required." },
          "403": { description: "The caller lacks spam.write." },
          "404": { description: "Filter template not found." },
        },
      },
      delete: {
        operationId: "deleteFilterTemplate",
        summary: "Soft-delete a filter template",
        permission: FILTER_TEMPLATES_WRITE_PERMISSION,
        security: [{ bearerAuth: [] }],
        parameters: [{ name: "templateId", in: "path", required: true, schema: { type: "string" } }],
        responses: {
          "204": { description: "Removed; no body." },
          "401": { description: "Authentication required." },
          "403": { description: "The caller lacks spam.write." },
          "404": { description: "Filter template not found." },
        },
      },
    },
    "/filter-templates/{templateId}/clone": {
      post: {
        operationId: "cloneFilterTemplate",
        summary: "Clone a filter template with a fresh id and a local source",
        permission: FILTER_TEMPLATES_WRITE_PERMISSION,
        security: [{ bearerAuth: [] }],
        parameters: [{ name: "templateId", in: "path", required: true, schema: { type: "string" } }],
        responses: {
          "201": { description: "The cloned filter template." },
          "401": { description: "Authentication required." },
          "403": { description: "The caller lacks spam.write." },
          "404": { description: "Filter template not found." },
        },
      },
    },
    "/filter-templates/{templateId}/deploy": {
      post: {
        operationId: "deployFilterTemplate",
        summary:
          "Deploy a filter template: resolves %name% variables (domains, IPs, action overrides) and applies the policy through the EPIC-006 gate with before/after and an AuditEvent",
        permission: FILTER_TEMPLATES_WRITE_PERMISSION,
        security: [{ bearerAuth: [] }],
        parameters: [{ name: "templateId", in: "path", required: true, schema: { type: "string" } }],
        responses: {
          "200": { description: "Plan preview of the deploy (preview: true)." },
          "202": { description: "The deploy was queued through the EPIC-006 gated path." },
          "400": { description: "A required variable is missing, or the change is security-impacting without confirm." },
          "401": { description: "Authentication required." },
          "403": { description: "The caller lacks spam.write or the tenant is out of scope." },
          "404": { description: "Filter template not found." },
        },
      },
    },
  },
} as const;
