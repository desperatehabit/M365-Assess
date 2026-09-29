// Purview retention policy read + change API (EPIC-030 SPEC.md §2 US-2, §3.2,
// §4.1, §5, §6, §7, §8; T-0584).
//
// Reads are served live from Purview through the injected provider, which is
// backed by the worker queue (get-purview-retention.ps1 over the T-0582 Purview
// session seam); this module holds no Purview SDK call and issues no tenant write
// on reads.
//
// Changes (create/edit/enable/disable/delete) apply only through the EPIC-006
// gated path (T-0108): the route validates `purview.write` + tenant scope, builds
// a before/after plan, enqueues a `remediation` job carrying the change, and
// records the append-only CompliancePolicyChange row (T-0581) plus an audit
// event. Disable and delete are flagged compliance-impacting and require
// explicit confirmation. No direct Purview write bypasses EPIC-006.
import { randomUUID } from "node:crypto";
import type { JobEnvelope } from "@m365-assess/contracts";
import { AppError, ErrorCodes } from "../errors.js";
import { paginate, parsePagination } from "../pagination.js";
import {
  requireTenantInScope,
  type Caller,
} from "../rbac/authorize.js";
import type { RequestContext, Route, RouteResponse } from "../server.js";
import type {
  CompliancePolicyChange,
  PurviewComplianceRepository,
} from "../repository/purview-compliance.js";

export const PURVIEW_RETENTION_PATH = "/v1/tenants/:tenantId/purview/retention";
export const PURVIEW_RETENTION_ITEM_PATH = "/v1/tenants/:tenantId/purview/retention/:policyId";

export const PURVIEW_READ_PERMISSION = "purview.read";
export const PURVIEW_WRITE_PERMISSION = "purview.write";
export const REMEDIATION_APPLY_PERMISSION = "Remediation.Apply";

export const PURVIEW_RETENTION_UNAUTHENTICATED = "request.unauthenticated";
export const PURVIEW_RETENTION_NOT_FOUND = "retention.not_found";
export const PURVIEW_RETENTION_CONFIRM_REQUIRED = "retention.confirm_required";

export type PurviewRetentionChangeAction = "create" | "edit" | "enable" | "disable" | "delete";

const COMPLIANCE_IMPACTING_ACTIONS: ReadonlySet<PurviewRetentionChangeAction> = new Set([
  "disable",
  "delete",
]);

export interface PurviewRetentionPolicy {
  readonly id: string;
  readonly name: string;
  readonly state: string;
  readonly locations: readonly string[];
  readonly retentionPeriod: string | null;
  readonly disposition: string | null;
  readonly retrievedAt?: string;
}

export interface PurviewRetentionPage {
  readonly tenantId: string;
  readonly items: readonly PurviewRetentionPolicy[];
  readonly nextCursor: string | null;
  readonly totalCount: number;
}

export interface PurviewRetentionFilter {
  readonly search?: string;
  readonly state?: string;
  readonly limit?: number;
  readonly cursor?: string;
}

export interface PurviewRetentionProvider {
  listPolicies(tenantId: string, filter?: PurviewRetentionFilter): Promise<PurviewRetentionPage>;
  getPolicy(tenantId: string, policyId: string): Promise<PurviewRetentionPolicy | undefined>;
}

export interface PurviewRetentionCaller extends Caller {
  readonly userId?: string;
}

export type PurviewRetentionAuthorizer = (
  caller: PurviewRetentionCaller,
  permission: string,
) => void | Promise<void>;

export interface PurviewRetentionRouteOptions {
  readonly provider: PurviewRetentionProvider;
  readonly queue: {
    enqueue(envelope: JobEnvelope): Promise<string>;
  };
  readonly repository: PurviewComplianceRepository;
  readonly resolveCaller: (ctx: RequestContext) => PurviewRetentionCaller | undefined;
  readonly authorize?: PurviewRetentionAuthorizer;
  readonly recordAudit?: (event: Record<string, unknown>) => Promise<void>;
  readonly idGenerator?: () => string;
  readonly now?: () => string;
}

export interface CreatePurviewRetentionInput {
  readonly name: string;
  readonly enabled?: boolean;
  readonly locations?: readonly string[];
  readonly retentionPeriod?: string;
  readonly disposition?: string;
  readonly confirm?: boolean;
}

export interface EditPurviewRetentionInput {
  readonly name?: string;
  readonly enabled?: boolean;
  readonly locations?: readonly string[];
  readonly retentionPeriod?: string;
  readonly disposition?: string;
  readonly confirm?: boolean;
}

export interface PurviewRetentionChangePlan {
  readonly action: PurviewRetentionChangeAction;
  readonly policyId: string;
  readonly policyName: string;
  readonly before: Record<string, unknown> | null;
  readonly after: Record<string, unknown> | null;
  readonly diff: readonly string[];
  readonly valid: boolean;
  readonly dryRun: boolean;
  readonly requiresConfirmation: boolean;
  readonly complianceImpacting: boolean;
}

export interface PurviewRetentionChangeResult {
  readonly success: boolean;
  readonly plan: PurviewRetentionChangePlan;
  readonly jobId: string;
  readonly changeId: string;
  readonly auditEventId?: string;
}

function unauthenticatedError(): AppError {
  return new AppError(PURVIEW_RETENTION_UNAUTHENTICATED, "authentication required", 401);
}

function validationError(message: string, field: string): AppError {
  return new AppError(ErrorCodes.validationFailed, message, 400, [
    { field, reason: "invalid" },
  ]);
}

function requireCaller(
  resolveCaller: (ctx: RequestContext) => PurviewRetentionCaller | undefined,
  ctx: RequestContext,
): PurviewRetentionCaller {
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
  const value = ctx.params["policyId"];
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new AppError(ErrorCodes.validationFailed, "policyId is required", 400, [
      { field: "policyId", reason: "required" },
    ]);
  }
  return value.trim();
}

async function requirePurviewRead(
  options: PurviewRetentionRouteOptions,
  caller: PurviewRetentionCaller,
): Promise<void> {
  if (options.authorize) {
    await options.authorize(caller, PURVIEW_READ_PERMISSION);
    return;
  }
  const permissions = caller.permissions ?? [];
  if (!permissions.includes(PURVIEW_READ_PERMISSION) && !permissions.includes("*")) {
    throw new AppError(ErrorCodes.forbidden, "forbidden: missing purview.read", 403);
  }
}

async function requirePurviewWrite(
  options: PurviewRetentionRouteOptions,
  caller: PurviewRetentionCaller,
): Promise<void> {
  if (options.authorize) {
    await options.authorize(caller, PURVIEW_WRITE_PERMISSION);
    return;
  }
  const permissions = caller.permissions ?? [];
  const hasWrite =
    permissions.includes(PURVIEW_WRITE_PERMISSION) ||
    permissions.includes(REMEDIATION_APPLY_PERMISSION) ||
    permissions.includes("*");
  if (!hasWrite) {
    throw new AppError(ErrorCodes.forbidden, "forbidden: missing purview.write", 403);
  }
}

function readBodyRecord(ctx: RequestContext): Record<string, unknown> {
  const body = (ctx.body ?? {}) as Record<string, unknown>;
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    throw validationError("Request body must be a JSON object", "body");
  }
  return body;
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

function optionalStringArray(value: unknown, field: string): readonly string[] | undefined {
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw validationError(`Field '${field}' must be an array of strings`, field);
  }
  return value as readonly string[];
}

function requireConfirmation(
  action: PurviewRetentionChangeAction,
  body: Record<string, unknown>,
): void {
  if (!COMPLIANCE_IMPACTING_ACTIONS.has(action)) return;
  const confirm = optionalBoolean(body["confirm"], "confirm") ?? false;
  if (!confirm) {
    throw new AppError(
      PURVIEW_RETENTION_CONFIRM_REQUIRED,
      `disabling or deleting a retention policy is compliance-impacting and requires confirmation`,
      400,
      [{ field: "confirm", reason: "required" }],
    );
  }
}

function buildChangePlan(
  action: PurviewRetentionChangeAction,
  policyId: string,
  policyName: string,
  before: Record<string, unknown> | null,
  after: Record<string, unknown> | null,
): PurviewRetentionChangePlan {
  const diff: string[] = [];
  if (action === "create") {
    diff.push(`Create retention policy '${after?.["name"] ?? policyName}'`);
  } else if (action === "delete") {
    diff.push(`Delete retention policy '${before?.["name"] ?? policyName}'`);
  } else if (action === "disable") {
    diff.push(`Disable retention policy '${before?.["name"] ?? policyName}'`);
  } else if (action === "enable") {
    diff.push(`Enable retention policy '${before?.["name"] ?? policyName}'`);
  } else {
    const beforeName = before?.["name"];
    const afterName = after?.["name"];
    if (beforeName !== afterName) {
      diff.push(`Rename retention policy from '${beforeName ?? ""}' to '${afterName ?? ""}'`);
    }
    const beforePeriod = before?.["retentionPeriod"];
    const afterPeriod = after?.["retentionPeriod"];
    if (beforePeriod !== afterPeriod) {
      diff.push(`Change retention period from '${beforePeriod ?? ""}' to '${afterPeriod ?? ""}'`);
    }
    const beforeDisposition = before?.["disposition"];
    const afterDisposition = after?.["disposition"];
    if (beforeDisposition !== afterDisposition) {
      diff.push(`Change disposition from '${beforeDisposition ?? ""}' to '${afterDisposition ?? ""}'`);
    }
  }

  return {
    action,
    policyId,
    policyName,
    before,
    after,
    diff,
    valid: true,
    dryRun: false,
    requiresConfirmation: COMPLIANCE_IMPACTING_ACTIONS.has(action),
    complianceImpacting: COMPLIANCE_IMPACTING_ACTIONS.has(action),
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

function auditActionFor(action: PurviewRetentionChangeAction): string {
  switch (action) {
    case "create":
      return "retention.policy.create";
    case "edit":
      return "retention.policy.edit";
    case "enable":
      return "retention.policy.enable";
    case "disable":
      return "retention.policy.disable";
    case "delete":
      return "retention.policy.delete";
  }
}

function actorOf(caller: PurviewRetentionCaller): string {
  return caller.userId ?? "unknown";
}

export function createPurviewRetentionRoutes(options: PurviewRetentionRouteOptions): Route[] {
  const idGenerator = options.idGenerator ?? (() => randomUUID());
  const now = options.now ?? (() => new Date().toISOString());

  async function handleGetList(ctx: RequestContext): Promise<RouteResponse> {
    const caller = requireCaller(options.resolveCaller, ctx);
    const tenantId = requireTenantParam(ctx);
    requireTenantInScope(caller, tenantId);
    await requirePurviewRead(options, caller);

    const query = ctx.query;
    const filter: PurviewRetentionFilter = {
      ...(query.get("search") ? { search: query.get("search")! } : {}),
      ...(query.get("state") ? { state: query.get("state")! } : {}),
      limit: parsePagination(query).limit,
      ...(query.get("cursor") ? { cursor: query.get("cursor")! } : {}),
    };
    const page = await options.provider.listPolicies(tenantId, filter);
    const pag = parsePagination(query);
    const result = paginate(page.items, pag);

    return {
      status: 200,
      headers: { "content-type": "application/json" },
      body: {
        tenantId,
        items: result.items,
        nextCursor: result.nextCursor,
        totalCount: page.totalCount,
      },
    };
  }

  async function handleCreate(ctx: RequestContext): Promise<RouteResponse> {
    const caller = requireCaller(options.resolveCaller, ctx);
    const tenantId = requireTenantParam(ctx);
    requireTenantInScope(caller, tenantId);
    await requirePurviewWrite(options, caller);

    const body = readBodyRecord(ctx);
    const name = optionalString(body["name"], "name");
    if (!name || name.trim().length === 0) {
      throw validationError("name is required", "name");
    }
    requireConfirmation("create", body);

    const after: Record<string, unknown> = {
      name: name.trim(),
      ...(body["enabled"] !== undefined ? { enabled: optionalBoolean(body["enabled"], "enabled") } : {}),
      ...(body["locations"] !== undefined ? { locations: optionalStringArray(body["locations"], "locations") } : {}),
      ...(body["retentionPeriod"] !== undefined ? { retentionPeriod: optionalString(body["retentionPeriod"], "retentionPeriod") } : {}),
      ...(body["disposition"] !== undefined ? { disposition: optionalString(body["disposition"], "disposition") } : {}),
    };

    const plan = buildChangePlan("create", "", name.trim(), null, after);
    const jobId = idGenerator();
    const requestId = idGenerator();
    const changeId = idGenerator();
    const createdAt = now();
    const actor = actorOf(caller);

    await options.queue.enqueue(
      buildRemediationEnvelope(ctx, tenantId, jobId, requestId, createdAt, {
        area: "retention",
        action: "create",
        policyName: name.trim(),
        changeId,
        actor,
      }),
    );

    const change = await options.repository.recordPolicyChange({
      id: changeId,
      tenantId,
      area: "retention",
      policyId: "",
      at: createdAt,
      by: actor,
      before: null,
      after,
    });

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

    const result: PurviewRetentionChangeResult = {
      success: true,
      plan,
      jobId,
      changeId: change.id,
    };
    return {
      status: 202,
      headers: { "content-type": "application/json" },
      body: result,
    };
  }

  async function handlePatch(ctx: RequestContext): Promise<RouteResponse> {
    const caller = requireCaller(options.resolveCaller, ctx);
    const tenantId = requireTenantParam(ctx);
    const policyId = requirePolicyParam(ctx);
    requireTenantInScope(caller, tenantId);
    await requirePurviewWrite(options, caller);

    const body = readBodyRecord(ctx);
    const enabled = optionalBoolean(body["enabled"], "enabled");
    const name = optionalString(body["name"], "name");
    const locations = optionalStringArray(body["locations"], "locations");
    const retentionPeriod = optionalString(body["retentionPeriod"], "retentionPeriod");
    const disposition = optionalString(body["disposition"], "disposition");

    if (enabled === undefined && name === undefined && locations === undefined && retentionPeriod === undefined && disposition === undefined) {
      throw validationError(
        "at least one of name, enabled, locations, retentionPeriod, or disposition is required",
        "body",
      );
    }

    const existing = await options.provider.getPolicy(tenantId, policyId);
    if (!existing) {
      throw new AppError(PURVIEW_RETENTION_NOT_FOUND, `retention policy ${policyId} not found`, 404);
    }

    const action: PurviewRetentionChangeAction = enabled === false ? "disable" : enabled === true ? "enable" : "edit";
    requireConfirmation(action, body);

    const before: Record<string, unknown> = {
      name: existing.name,
      enabled: existing.state === "enabled",
      locations: [...existing.locations],
      retentionPeriod: existing.retentionPeriod,
      disposition: existing.disposition,
    };
    const after: Record<string, unknown> = {
      ...before,
      ...(name !== undefined ? { name: name.trim() } : {}),
      ...(enabled !== undefined ? { enabled } : {}),
      ...(locations !== undefined ? { locations: [...locations] } : {}),
      ...(retentionPeriod !== undefined ? { retentionPeriod } : {}),
      ...(disposition !== undefined ? { disposition } : {}),
    };

    const plan = buildChangePlan(action, policyId, existing.name, before, after);
    const jobId = idGenerator();
    const requestId = idGenerator();
    const changeId = idGenerator();
    const createdAt = now();
    const actor = actorOf(caller);

    await options.queue.enqueue(
      buildRemediationEnvelope(ctx, tenantId, jobId, requestId, createdAt, {
        area: "retention",
        action,
        policyId,
        policyName: existing.name,
        changeId,
        actor,
      }),
    );

    const change = await options.repository.recordPolicyChange({
      id: changeId,
      tenantId,
      area: "retention",
      policyId,
      at: createdAt,
      by: actor,
      before,
      after,
    });

    if (options.recordAudit) {
      await options.recordAudit({
        action: auditActionFor(action),
        tenantId,
        actorUserId: actor,
        targetId: policyId,
        correlationId: ctx.correlationId,
        timestamp: createdAt,
        before,
        after,
      });
    }

    const result: PurviewRetentionChangeResult = {
      success: true,
      plan,
      jobId,
      changeId: change.id,
    };
    return {
      status: 202,
      headers: { "content-type": "application/json" },
      body: result,
    };
  }

  async function handleDelete(ctx: RequestContext): Promise<RouteResponse> {
    const caller = requireCaller(options.resolveCaller, ctx);
    const tenantId = requireTenantParam(ctx);
    const policyId = requirePolicyParam(ctx);
    requireTenantInScope(caller, tenantId);
    await requirePurviewWrite(options, caller);

    const body = readBodyRecord(ctx);
    requireConfirmation("delete", body);

    const existing = await options.provider.getPolicy(tenantId, policyId);
    if (!existing) {
      throw new AppError(PURVIEW_RETENTION_NOT_FOUND, `retention policy ${policyId} not found`, 404);
    }

    const before: Record<string, unknown> = {
      name: existing.name,
      enabled: existing.state === "enabled",
      locations: [...existing.locations],
      retentionPeriod: existing.retentionPeriod,
      disposition: existing.disposition,
    };

    const plan = buildChangePlan("delete", policyId, existing.name, before, null);
    const jobId = idGenerator();
    const requestId = idGenerator();
    const changeId = idGenerator();
    const createdAt = now();
    const actor = actorOf(caller);

    await options.queue.enqueue(
      buildRemediationEnvelope(ctx, tenantId, jobId, requestId, createdAt, {
        area: "retention",
        action: "delete",
        policyId,
        policyName: existing.name,
        changeId,
        actor,
      }),
    );

    const change = await options.repository.recordPolicyChange({
      id: changeId,
      tenantId,
      area: "retention",
      policyId,
      at: createdAt,
      by: actor,
      before,
      after: null,
    });

    if (options.recordAudit) {
      await options.recordAudit({
        action: auditActionFor("delete"),
        tenantId,
        actorUserId: actor,
        targetId: policyId,
        correlationId: ctx.correlationId,
        timestamp: createdAt,
        before,
        after: null,
      });
    }

    const result: PurviewRetentionChangeResult = {
      success: true,
      plan,
      jobId,
      changeId: change.id,
    };
    return {
      status: 202,
      headers: { "content-type": "application/json" },
      body: result,
    };
  }

  return [
    { method: "GET", path: PURVIEW_RETENTION_PATH, handler: handleGetList },
    { method: "POST", path: PURVIEW_RETENTION_PATH, handler: handleCreate },
    { method: "PATCH", path: PURVIEW_RETENTION_ITEM_PATH, handler: handlePatch },
    { method: "DELETE", path: PURVIEW_RETENTION_ITEM_PATH, handler: handleDelete },
  ];
}

export const PURVIEW_RETENTION_OPENAPI = {
  paths: {
    "/tenants/{tenantId}/purview/retention": {
      get: {
        operationId: "listPurviewRetentionPolicies",
        summary: "List Purview retention policies live from Purview",
        permission: PURVIEW_READ_PERMISSION,
        security: [{ bearerAuth: [] }],
        parameters: [
          { name: "tenantId", in: "path", required: true, schema: { type: "string" } },
          { name: "search", in: "query", required: false, schema: { type: "string" } },
          { name: "state", in: "query", required: false, schema: { type: "string" } },
          { name: "limit", in: "query", required: false, schema: { type: "integer" } },
          { name: "cursor", in: "query", required: false, schema: { type: "string" } },
        ],
        responses: {
          "200": { description: "The live retention policies." },
          "401": { description: "Authentication required." },
          "403": { description: "The caller lacks purview.read or the tenant is out of scope." },
        },
      },
      post: {
        operationId: "createPurviewRetentionPolicy",
        summary: "Create a retention policy (applies through the EPIC-006 gated path)",
        permission: PURVIEW_WRITE_PERMISSION,
        security: [{ bearerAuth: [] }],
        parameters: [
          { name: "tenantId", in: "path", required: true, schema: { type: "string" } },
        ],
        responses: {
          "202": { description: "The create was queued through the EPIC-006 gated path." },
          "400": { description: "name or confirm failed validation." },
          "401": { description: "Authentication required." },
          "403": { description: "The caller lacks purview.write or the tenant is out of scope." },
        },
      },
    },
    "/tenants/{tenantId}/purview/retention/{policyId}": {
      patch: {
        operationId: "editPurviewRetentionPolicy",
        summary: "Edit, enable, or disable a retention policy (applies through the EPIC-006 gated path)",
        permission: PURVIEW_WRITE_PERMISSION,
        security: [{ bearerAuth: [] }],
        parameters: [
          { name: "tenantId", in: "path", required: true, schema: { type: "string" } },
          { name: "policyId", in: "path", required: true, schema: { type: "string" } },
        ],
        responses: {
          "202": { description: "The change was queued through the EPIC-006 gated path." },
          "400": { description: "No editable field was supplied, or confirm is required for disable." },
          "401": { description: "Authentication required." },
          "403": { description: "The caller lacks purview.write or the tenant is out of scope." },
          "404": { description: "Retention policy not found." },
        },
      },
      delete: {
        operationId: "deletePurviewRetentionPolicy",
        summary: "Delete a retention policy (compliance-impacting; requires confirmation)",
        permission: PURVIEW_WRITE_PERMISSION,
        security: [{ bearerAuth: [] }],
        parameters: [
          { name: "tenantId", in: "path", required: true, schema: { type: "string" } },
          { name: "policyId", in: "path", required: true, schema: { type: "string" } },
        ],
        responses: {
          "202": { description: "The delete was queued through the EPIC-006 gated path." },
          "400": { description: "confirm is required to delete a retention policy." },
          "401": { description: "Authentication required." },
          "403": { description: "The caller lacks purview.write or the tenant is out of scope." },
          "404": { description: "Retention policy not found." },
        },
      },
    },
  },
} as const;
