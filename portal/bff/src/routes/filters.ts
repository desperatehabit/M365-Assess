// Filter policy read + write (EPIC-022 SPEC.md §2 US-1, §3.1, §4.1, §5, §6, §7, §8; T-0421, T-0422).
// Exposes GET /v1/tenants/:tenantId/filters/:filterType serving the §3.1
// table — name, priority, state, key settings summary, last modified — for
// spam, anti-phish, malware, and connection filter policies. Policies are
// read live from EXO and never persisted: the injected provider is backed by
// the worker queue (T-0010) running the Get-Filters child job, so this module
// holds no M365 SDK call and issues no tenant write on reads. Reads require
// `Exchange.SpamFilter.Read` (SPEC §7) intersected with the caller tenant scope.
//
// Writes (create/edit/enable/disable/delete) apply only through the EPIC-006
// gated path (T-0107): the route validates `Exchange.SpamFilter.ReadWrite` + tenant scope, builds
// a before/after plan via the policy guard, and enqueues a `remediation` job
// carrying the change. A disabling or weakening change is flagged
// security-impacting before apply and requires explicit confirmation. The
// plan preview (`preview: true`) shows the resulting policy before apply with
// no tenant write. Every applied write captures before/after and records an
// AuditEvent. No direct EXO write bypasses EPIC-006.
import { randomUUID } from "node:crypto";
import type { JobEnvelope } from "@m365-assess/contracts";
import { AppError, ErrorCodes } from "../errors.js";
import { requireTenantInScope, type Caller } from "../rbac/authorize.js";
import type { RequestContext, Route, RouteResponse } from "../server.js";
import {
  assessFilterPolicyChange,
  FILTER_SECURITY_IMPACTING_WARNING,
  FILTER_TYPES,
  type FilterPolicyAction,
  type FilterPolicyState,
  type FilterType,
} from "../domain/filters/policy-guard.js";

export { FILTER_TYPES, type FilterType } from "../domain/filters/policy-guard.js";

export const FILTERS_PATH = "/v1/tenants/:tenantId/filters/:filterType";
export const FILTERS_ITEM_PATH = "/v1/tenants/:tenantId/filters/:filterType/:policyName";
export const FILTERS_READ_PERMISSION = "Exchange.SpamFilter.Read";
export const FILTERS_WRITE_PERMISSION = "Exchange.SpamFilter.ReadWrite";
export const REMEDIATION_APPLY_PERMISSION = "Remediation.Apply";
export const FILTERS_UNAUTHENTICATED = "request.unauthenticated";
export const FILTER_INVALID_TYPE = "filters.invalid_type";
export const FILTERS_NOT_FOUND = "filters.not_found";
export const FILTERS_CONFIRM_REQUIRED = "filters.confirm_required";

export interface FilterItem {
  readonly name: string;
  readonly priority: number | null;
  readonly state: string;
  readonly summary: string;
  readonly lastModified: string | null;
}

export interface FiltersPage {
  readonly tenantId: string;
  readonly filterType: FilterType;
  readonly items: readonly FilterItem[];
  readonly totalCount: number;
  readonly retrievedAt: string;
}

export interface FilterPolicy {
  readonly name: string;
  readonly enabled: boolean;
  readonly settings: Record<string, unknown>;
}

export interface FilterChangePlan {
  readonly action: FilterPolicyAction;
  readonly filterType: FilterType;
  readonly policyName: string;
  readonly before: FilterPolicyState | null;
  readonly after: FilterPolicyState | null;
  readonly diff: readonly string[];
  readonly valid: boolean;
  readonly dryRun: boolean;
  readonly requiresConfirmation: boolean;
  readonly securityImpacting: boolean;
  readonly warning?: string;
}

export interface FilterChangeResult {
  readonly success: boolean;
  readonly plan: FilterChangePlan;
  readonly jobId: string;
  readonly auditEventId?: string;
}

export interface CreateFilterInput {
  readonly name: string;
  readonly enabled?: boolean;
  readonly settings?: Record<string, unknown>;
  readonly preview?: boolean;
  readonly confirm?: boolean;
}

export interface EditFilterInput {
  readonly name?: string;
  readonly enabled?: boolean;
  readonly settings?: Record<string, unknown>;
  readonly preview?: boolean;
  readonly confirm?: boolean;
}

// Queue-backed seam for the filter reads: the production wiring enqueues a
// get-filters worker job for (tenantId, filterType) and serves the worker
// result. Depending on the seam keeps EXO and process code out of the BFF.
export interface FiltersProvider {
  getFilters(tenantId: string, filterType: FilterType): Promise<FiltersPage>;
  getFilterPolicy(
    tenantId: string,
    filterType: FilterType,
    policyName: string,
  ): Promise<FilterPolicy | undefined>;
}

export interface FiltersCaller extends Caller {
  readonly userId?: string;
}

export type FiltersAuthorizer = (
  caller: FiltersCaller,
  permission: string,
) => void | Promise<void>;

export interface FiltersRouteOptions {
  readonly provider: FiltersProvider;
  readonly queue?: {
    enqueue(envelope: JobEnvelope): Promise<string>;
  };
  readonly resolveCaller: (ctx: RequestContext) => FiltersCaller | undefined;
  readonly authorize?: FiltersAuthorizer;
  readonly recordAudit?: (event: Record<string, unknown>) => Promise<void>;
  readonly idGenerator?: () => string;
  readonly now?: () => string;
}

function unauthenticatedError(): AppError {
  return new AppError(FILTERS_UNAUTHENTICATED, "authentication required", 401);
}

function validationError(message: string, field: string): AppError {
  return new AppError(ErrorCodes.validationFailed, message, 400, [
    { field, reason: "invalid" },
  ]);
}

function requireCaller(
  resolveCaller: (ctx: RequestContext) => FiltersCaller | undefined,
  ctx: RequestContext,
): FiltersCaller {
  const caller = resolveCaller(ctx);
  if (caller === undefined) {
    throw unauthenticatedError();
  }
  return caller;
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

function requirePolicyParam(ctx: RequestContext): string {
  const value = ctx.params["policyName"];
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new AppError(ErrorCodes.validationFailed, "policyName is required", 400, [
      { field: "policyName", reason: "required" },
    ]);
  }
  return value.trim();
}

async function requireFiltersRead(
  options: FiltersRouteOptions,
  caller: FiltersCaller,
): Promise<void> {
  if (options.authorize) {
    await options.authorize(caller, FILTERS_READ_PERMISSION);
    return;
  }
  const permissions = caller.permissions ?? [];
  if (!permissions.includes(FILTERS_READ_PERMISSION) && !permissions.includes("*")) {
    throw new AppError(ErrorCodes.forbidden, "forbidden: missing Exchange.SpamFilter.Read", 403);
  }
}

async function requireFiltersWrite(
  options: FiltersRouteOptions,
  caller: FiltersCaller,
): Promise<void> {
  if (options.authorize) {
    await options.authorize(caller, FILTERS_WRITE_PERMISSION);
    return;
  }
  const permissions = caller.permissions ?? [];
  const hasWrite =
    permissions.includes(FILTERS_WRITE_PERMISSION) ||
    permissions.includes(REMEDIATION_APPLY_PERMISSION) ||
    permissions.includes("*");
  if (!hasWrite) {
    throw new AppError(ErrorCodes.forbidden, "forbidden: missing Exchange.SpamFilter.ReadWrite", 403);
  }
}

export function parseFilterType(value: unknown): FilterType {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new AppError(FILTER_INVALID_TYPE, "filterType is required", 400, [
      { field: "filterType", reason: "required" },
    ]);
  }
  const normalized = value.trim().toLowerCase().replace(/-/g, "");
  if (!(FILTER_TYPES as readonly string[]).includes(normalized)) {
    throw validationError(
      `filterType must be one of: spam, antiphish, malware, connection`,
      "filterType",
    );
  }
  return normalized as FilterType;
}

export async function getFilters(
  provider: FiltersProvider,
  tenantId: string,
  filterType: FilterType,
): Promise<{ status: number; body: FiltersPage }> {
  if (tenantId.trim().length === 0) {
    throw new AppError(ErrorCodes.validationFailed, "tenantId is required", 400, [
      { field: "tenantId", reason: "required" },
    ]);
  }
  const page = await provider.getFilters(tenantId, filterType);
  return {
    status: 200,
    body: {
      tenantId,
      filterType,
      items: [...page.items],
      totalCount: page.totalCount,
      retrievedAt: page.retrievedAt,
    },
  };
}

function readBodyRecord(ctx: RequestContext): Record<string, unknown> {
  const body = (ctx.body ?? {}) as Record<string, unknown>;
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    throw validationError("Request body must be a JSON object", "body");
  }
  return body;
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

function optionalString(value: unknown, field: string): string | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value !== "string") {
    throw validationError(`Field '${field}' must be a string`, field);
  }
  return value;
}

function optionalSettings(value: unknown, field: string): Record<string, unknown> | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "object" || Array.isArray(value)) {
    throw validationError(`Field '${field}' must be a JSON object`, field);
  }
  return value as Record<string, unknown>;
}

function requireConfirmation(assessment: { securityImpacting: boolean; requiresConfirmation: boolean }, body: Record<string, unknown>): void {
  if (!assessment.securityImpacting) return;
  const confirm = optionalBoolean(body["confirm"], "confirm") ?? false;
  if (!confirm) {
    throw new AppError(
      FILTERS_CONFIRM_REQUIRED,
      "disabling or weakening a filter is security-impacting and requires confirmation",
      400,
      [{ field: "confirm", reason: "required" }],
    );
  }
}

function buildChangePlan(
  action: FilterPolicyAction,
  filterType: FilterType,
  policyName: string,
  before: FilterPolicyState | null,
  after: FilterPolicyState | null,
  assessment: { securityImpacting: boolean; requiresConfirmation: boolean; warning?: string; reasons: readonly string[] },
  dryRun: boolean,
): FilterChangePlan {
  const diff: string[] = [];
  if (action === "create") {
    diff.push(`Create ${filterType} filter '${after?.name ?? policyName}'`);
  } else if (action === "delete") {
    diff.push(`Delete ${filterType} filter '${before?.name ?? policyName}'`);
  } else if (action === "disable") {
    diff.push(`Disable ${filterType} filter '${before?.name ?? policyName}'`);
  } else if (action === "enable") {
    diff.push(`Enable ${filterType} filter '${before?.name ?? policyName}'`);
  } else {
    if (before && after) {
      if (before.name !== after.name) {
        diff.push(`Rename ${filterType} filter from '${before.name}' to '${after.name}'`);
      }
      if (before.enabled !== after.enabled) {
        diff.push(`Change ${filterType} filter state from '${before.enabled}' to '${after.enabled}'`);
      }
      const beforeJson = JSON.stringify(before.settings);
      const afterJson = JSON.stringify(after.settings);
      if (beforeJson !== afterJson) {
        diff.push(`Update ${filterType} filter settings`);
      }
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

function actorOf(caller: FiltersCaller): string {
  return caller.userId ?? "unknown";
}

function requireQueue(options: FiltersRouteOptions): { enqueue(envelope: JobEnvelope): Promise<string> } {
  if (!options.queue) {
    throw new AppError(ErrorCodes.internalError, "filter writes require a worker queue", 500);
  }
  return options.queue;
}

export function createFilterRoutes(options: FiltersRouteOptions): Route[] {
  const idGenerator = options.idGenerator ?? (() => randomUUID());
  const now = options.now ?? (() => new Date().toISOString());

  const listHandler = async (ctx: RequestContext): Promise<RouteResponse> => {
    const caller = requireCaller(options.resolveCaller, ctx);
    const tenantId = requireTenantParam(ctx);
    const filterType = parseFilterType(ctx.params["filterType"]);

    requireTenantInScope(caller, tenantId);

    await requireFiltersRead(options, caller);

    const result = await getFilters(options.provider, tenantId, filterType);

    return {
      status: result.status,
      headers: { "content-type": "application/json" },
      body: result.body,
    };
  };

  const createHandler = async (ctx: RequestContext): Promise<RouteResponse> => {
    const caller = requireCaller(options.resolveCaller, ctx);
    const tenantId = requireTenantParam(ctx);
    const filterType = parseFilterType(ctx.params["filterType"]);
    requireTenantInScope(caller, tenantId);
    await requireFiltersWrite(options, caller);
    const queue = requireQueue(options);

    const body = readBodyRecord(ctx);
    const name = optionalString(body["name"], "name");
    if (!name || name.trim().length === 0) {
      throw validationError("name is required", "name");
    }
    const settings = optionalSettings(body["settings"], "settings") ?? {};
    const enabled = optionalBoolean(body["enabled"], "enabled") ?? true;

    const after: FilterPolicyState = { name: name.trim(), enabled, settings };
    const assessment = assessFilterPolicyChange({ action: "create", filterType, after });
    if (!assessment.valid) {
      throw validationError(assessment.reasons.join("; "), "body");
    }

    const isPreview = readPreviewFlag(ctx, body);
    const plan = buildChangePlan("create", filterType, name.trim(), null, after, assessment, isPreview);
    if (isPreview) {
      return { status: 200, headers: { "content-type": "application/json" }, body: plan };
    }

    requireConfirmation(assessment, body);

    const jobId = idGenerator();
    const requestId = idGenerator();
    const auditEventId = idGenerator();
    const createdAt = now();
    const actor = actorOf(caller);

    await queue.enqueue(
      buildRemediationEnvelope(ctx, tenantId, jobId, requestId, createdAt, {
        area: "filters",
        action: "create",
        filterType,
        policyName: name.trim(),
        settings,
        actor,
      }),
    );

    if (options.recordAudit) {
      await options.recordAudit({
        action: auditActionFor("create"),
        tenantId,
        actorUserId: actor,
        targetId: "",
        correlationId: ctx.correlationId,
        timestamp: createdAt,
        before: null,
        after,
      });
    }

    const result: FilterChangeResult = { success: true, plan, jobId, auditEventId };
    return { status: 202, headers: { "content-type": "application/json" }, body: result };
  };

    const patchHandler = async (ctx: RequestContext): Promise<RouteResponse> => {
    const caller = requireCaller(options.resolveCaller, ctx);
    const tenantId = requireTenantParam(ctx);
    const filterType = parseFilterType(ctx.params["filterType"]);
    const policyName = requirePolicyParam(ctx);
    requireTenantInScope(caller, tenantId);
    await requireFiltersWrite(options, caller);
    const queue = requireQueue(options);

    const body = readBodyRecord(ctx);
    const name = optionalString(body["name"], "name");
    const enabled = optionalBoolean(body["enabled"], "enabled");
    const settings = optionalSettings(body["settings"], "settings");

    if (name === undefined && enabled === undefined && settings === undefined) {
      throw validationError("at least one of name, enabled, or settings is required", "body");
    }

    const existing = await options.provider.getFilterPolicy(tenantId, filterType, policyName);
    if (!existing) {
      throw new AppError(FILTERS_NOT_FOUND, `filter policy ${policyName} not found`, 404);
    }

    const action: FilterPolicyAction = enabled === false ? "disable" : enabled === true ? "enable" : "edit";
    const after: FilterPolicyState = {
      name: name !== undefined ? name.trim() : existing.name,
      enabled: enabled !== undefined ? enabled : existing.enabled,
      settings: settings !== undefined ? settings : existing.settings,
    };
    const before: FilterPolicyState = { name: existing.name, enabled: existing.enabled, settings: existing.settings };

    const assessment = assessFilterPolicyChange({ action, filterType, before, after });
    if (!assessment.valid) {
      throw validationError(assessment.reasons.join("; "), "body");
    }

    const isPreview = readPreviewFlag(ctx, body);
    const plan = buildChangePlan(action, filterType, existing.name, before, after, assessment, isPreview);
    if (isPreview) {
      return { status: 200, headers: { "content-type": "application/json" }, body: plan };
    }

    requireConfirmation(assessment, body);

    const jobId = idGenerator();
    const requestId = idGenerator();
    const auditEventId = idGenerator();
    const createdAt = now();
    const actor = actorOf(caller);

    await queue.enqueue(
      buildRemediationEnvelope(ctx, tenantId, jobId, requestId, createdAt, {
        area: "filters",
        action,
        filterType,
        policyName: existing.name,
        settings: after.settings,
        actor,
      }),
    );

    if (options.recordAudit) {
      await options.recordAudit({
        action: auditActionFor(action),
        tenantId,
        actorUserId: actor,
        targetId: existing.name,
        correlationId: ctx.correlationId,
        timestamp: createdAt,
        before,
        after,
      });
    }

    const result: FilterChangeResult = { success: true, plan, jobId, auditEventId };
    return { status: 202, headers: { "content-type": "application/json" }, body: result };
  };

  const deleteHandler = async (ctx: RequestContext): Promise<RouteResponse> => {
    const caller = requireCaller(options.resolveCaller, ctx);
    const tenantId = requireTenantParam(ctx);
    const filterType = parseFilterType(ctx.params["filterType"]);
    const policyName = requirePolicyParam(ctx);
    requireTenantInScope(caller, tenantId);
    await requireFiltersWrite(options, caller);
    const queue = requireQueue(options);

    const body = readBodyRecord(ctx);

    const existing = await options.provider.getFilterPolicy(tenantId, filterType, policyName);
    if (!existing) {
      throw new AppError(FILTERS_NOT_FOUND, `filter policy ${policyName} not found`, 404);
    }

    const before: FilterPolicyState = { name: existing.name, enabled: existing.enabled, settings: existing.settings };
    const assessment = assessFilterPolicyChange({ action: "delete", filterType, before });

    const isPreview = readPreviewFlag(ctx, body);
    const plan = buildChangePlan("delete", filterType, existing.name, before, null, assessment, isPreview);
    if (isPreview) {
      return { status: 200, headers: { "content-type": "application/json" }, body: plan };
    }

    requireConfirmation(assessment, body);

    const jobId = idGenerator();
    const requestId = idGenerator();
    const auditEventId = idGenerator();
    const createdAt = now();
    const actor = actorOf(caller);

    await queue.enqueue(
      buildRemediationEnvelope(ctx, tenantId, jobId, requestId, createdAt, {
        area: "filters",
        action: "delete",
        filterType,
        policyName: existing.name,
        actor,
      }),
    );

    if (options.recordAudit) {
      await options.recordAudit({
        action: auditActionFor("delete"),
        tenantId,
        actorUserId: actor,
        targetId: existing.name,
        correlationId: ctx.correlationId,
        timestamp: createdAt,
        before,
        after: null,
      });
    }

    const result: FilterChangeResult = { success: true, plan, jobId, auditEventId };
    return { status: 202, headers: { "content-type": "application/json" }, body: result };
  };

  return [
    { method: "GET", path: FILTERS_PATH, handler: listHandler },
    { method: "POST", path: FILTERS_PATH, handler: createHandler },
    { method: "PATCH", path: FILTERS_ITEM_PATH, handler: patchHandler },
    { method: "DELETE", path: FILTERS_ITEM_PATH, handler: deleteHandler },
  ];
}

// Route modules own their OpenAPI path items (portal.v1.yaml `paths` is empty
// by design); a wiring ticket merges this fragment into the served document.
export const FILTERS_OPENAPI = {
  paths: {
    "/tenants/{tenantId}/filters/{filterType}": {
      get: {
        operationId: "getFilters",
        summary: "Filter policies (spam/antiphish/malware/connection) with name, priority, state, key settings summary, last modified",
        permission: FILTERS_READ_PERMISSION,
        security: [{ bearerAuth: [] }],
        parameters: [
          { name: "tenantId", in: "path", required: true, schema: { type: "string" } },
          {
            name: "filterType",
            in: "path",
            required: true,
            schema: { type: "string", enum: ["spam", "antiphish", "malware", "connection"] },
          },
        ],
        responses: {
          "200": { description: "Filter policies with the §3.1 columns, read live from EXO." },
          "400": { description: "An unknown filter type was supplied." },
          "401": { description: "Authentication required." },
          "403": { description: "The caller lacks Exchange.SpamFilter.Read or the tenant is out of scope." },
        },
      },
      post: {
        operationId: "createFilter",
        summary: "Create a filter policy (plan preview with preview:true; applies through the EPIC-006 gated path)",
        permission: FILTERS_WRITE_PERMISSION,
        security: [{ bearerAuth: [] }],
        parameters: [
          { name: "tenantId", in: "path", required: true, schema: { type: "string" } },
          {
            name: "filterType",
            in: "path",
            required: true,
            schema: { type: "string", enum: ["spam", "antiphish", "malware", "connection"] },
          },
        ],
        responses: {
          "200": { description: "Plan preview of the filter create." },
          "202": { description: "The create was queued through the EPIC-006 gated path." },
          "400": { description: "name or settings failed validation." },
          "401": { description: "Authentication required." },
          "403": { description: "The caller lacks Exchange.SpamFilter.ReadWrite or the tenant is out of scope." },
        },
      },
    },
    "/tenants/{tenantId}/filters/{filterType}/{policyName}": {
      patch: {
        operationId: "editFilter",
        summary: "Edit, enable, or disable a filter policy (plan preview with preview:true; security-impacting changes require confirmation)",
        permission: FILTERS_WRITE_PERMISSION,
        security: [{ bearerAuth: [] }],
        parameters: [
          { name: "tenantId", in: "path", required: true, schema: { type: "string" } },
          {
            name: "filterType",
            in: "path",
            required: true,
            schema: { type: "string", enum: ["spam", "antiphish", "malware", "connection"] },
          },
          { name: "policyName", in: "path", required: true, schema: { type: "string" } },
        ],
        responses: {
          "200": { description: "Edit plan preview or the applied change with before/after and audit event." },
          "400": { description: "No editable field was supplied, or confirm is required for a security-impacting change." },
          "401": { description: "Authentication required." },
          "403": { description: "The caller lacks Exchange.SpamFilter.ReadWrite or the tenant is out of scope." },
          "404": { description: "Filter policy not found." },
        },
      },
      delete: {
        operationId: "deleteFilter",
        summary: "Delete a filter policy (security-impacting; requires confirmation)",
        permission: FILTERS_WRITE_PERMISSION,
        security: [{ bearerAuth: [] }],
        parameters: [
          { name: "tenantId", in: "path", required: true, schema: { type: "string" } },
          {
            name: "filterType",
            in: "path",
            required: true,
            schema: { type: "string", enum: ["spam", "antiphish", "malware", "connection"] },
          },
          { name: "policyName", in: "path", required: true, schema: { type: "string" } },
        ],
        responses: {
          "200": { description: "Delete plan preview." },
          "202": { description: "The delete was queued through the EPIC-006 gated path." },
          "400": { description: "confirm is required to delete a filter policy." },
          "401": { description: "Authentication required." },
          "403": { description: "The caller lacks Exchange.SpamFilter.ReadWrite or the tenant is out of scope." },
          "404": { description: "Filter policy not found." },
        },
      },
    },
  },
} as const;
