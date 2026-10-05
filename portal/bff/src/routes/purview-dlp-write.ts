// Purview DLP policy change API (EPIC-030 SPEC.md §2 US-1, §3.1, §4.1, §5, §6,
// §7, §8; T-0583).
//
// Create/edit/enable/disable/delete apply only through the EPIC-006 gated path
// (T-0108): the route validates `Purview.Compliance.ReadWrite` (or `Remediation.Apply`) + tenant
// scope, requires an Idempotency-Key, classifies the change with the DLP guard
// (disable/delete are compliance-impacting and need explicit confirmation),
// builds a before/after plan preview, enqueues a `remediation` apply job, and
// records the append-only CompliancePolicyChange row (T-0581) plus an audit
// event. Reads stay in the T-0582 module; this module issues no Purview write of
// its own — the worker performs the tenant write behind the EPIC-006 gates.
import { randomUUID } from "node:crypto";
import type { JobEnvelope } from "@m365-assess/contracts";
import { AppError, ErrorCodes } from "../errors.js";
import { requireTenantInScope, type Caller } from "../rbac/authorize.js";
import type { RequestContext, Route, RouteResponse } from "../server.js";
import type {
  CompliancePolicyChange,
  PurviewComplianceRepository,
} from "../repository/purview-compliance.js";
import {
  parseRemediationIdempotencyKey,
  RemediationApplyInputError,
} from "../domain/remediation/apply.js";
import {
  assertDlpPolicyChange,
  DLP_COMPLIANCE_IMPACTING_CODE,
  type DlpPolicyAction,
  type DlpPolicyAssessment,
  type DlpPolicyState,
} from "../domain/compliance/dlp-guard.js";
import {
  PURVIEW_DLP_ITEM_PATH,
  PURVIEW_DLP_PATH,
  type PurviewDlpPolicy,
} from "./purview-dlp.js";

export { PURVIEW_DLP_ITEM_PATH, PURVIEW_DLP_PATH, DLP_COMPLIANCE_IMPACTING_CODE };

export const PURVIEW_WRITE_PERMISSION = "Purview.Compliance.ReadWrite";
export const REMEDIATION_APPLY_PERMISSION = "Remediation.Apply";

export const PURVIEW_DLP_WRITE_UNAUTHENTICATED = "request.unauthenticated";
export const PURVIEW_DLP_WRITE_NOT_FOUND = "dlp.not_found";

export interface PurviewDlpWriteProvider {
  getPolicy(tenantId: string, policyId: string): Promise<PurviewDlpPolicy | undefined>;
}

export interface PurviewDlpWriteCaller extends Caller {
  readonly userId?: string;
}

export type PurviewDlpWriteAuthorizer = (
  caller: PurviewDlpWriteCaller,
  permission: string,
) => void | Promise<void>;

export interface CreateDlpPolicyInput {
  readonly name: string;
  readonly enabled?: boolean;
  readonly locations?: readonly string[];
  readonly confirm?: boolean;
}

export interface EditDlpPolicyInput {
  readonly name?: string;
  readonly enabled?: boolean;
  readonly locations?: readonly string[];
  readonly confirm?: boolean;
}

export interface PurviewDlpChangePlan {
  readonly action: DlpPolicyAction;
  readonly policyId: string;
  readonly policyName: string;
  readonly before: Record<string, unknown> | null;
  readonly after: Record<string, unknown> | null;
  readonly diff: readonly string[];
  readonly valid: boolean;
  readonly dryRun: boolean;
  readonly requiresConfirmation: boolean;
  readonly complianceImpacting: boolean;
  readonly warning?: string;
  readonly reasons: readonly string[];
}

export interface PurviewDlpChangeResult {
  readonly success: boolean;
  readonly plan: PurviewDlpChangePlan;
  readonly jobId: string;
  readonly changeId: string;
  readonly auditEventId?: string;
}

// Idempotency replay: a repeated key returns the original queued result instead
// of enqueuing a second apply or recording a second change row (T-0108).
export interface PurviewDlpWriteIdempotencyStore {
  find(tenantId: string, key: string): Promise<PurviewDlpChangeResult | undefined>;
  save(tenantId: string, key: string, result: PurviewDlpChangeResult): Promise<void>;
}

export function createMemoryPurviewDlpWriteIdempotencyStore(): PurviewDlpWriteIdempotencyStore {
  const results = new Map<string, PurviewDlpChangeResult>();
  return {
    async find(tenantId: string, key: string): Promise<PurviewDlpChangeResult | undefined> {
      return results.get(`${tenantId}\n${key}`);
    },
    async save(tenantId: string, key: string, result: PurviewDlpChangeResult): Promise<void> {
      results.set(`${tenantId}\n${key}`, result);
    },
  };
}

export interface PurviewDlpWriteRouteOptions {
  readonly provider: PurviewDlpWriteProvider;
  readonly queue: {
    enqueue(envelope: JobEnvelope): Promise<string>;
  };
  readonly repository: PurviewComplianceRepository;
  readonly resolveCaller: (ctx: RequestContext) => PurviewDlpWriteCaller | undefined;
  readonly authorize?: PurviewDlpWriteAuthorizer;
  readonly recordAudit?: (event: Record<string, unknown>) => Promise<void>;
  readonly idempotency?: PurviewDlpWriteIdempotencyStore;
  readonly idGenerator?: () => string;
  readonly now?: () => string;
}

function unauthenticatedError(): AppError {
  return new AppError(PURVIEW_DLP_WRITE_UNAUTHENTICATED, "authentication required", 401);
}

function validationError(message: string, field: string, reason = "invalid"): AppError {
  return new AppError(ErrorCodes.validationFailed, message, 400, [{ field, reason }]);
}

function requireCaller(
  resolveCaller: (ctx: RequestContext) => PurviewDlpWriteCaller | undefined,
  ctx: RequestContext,
): PurviewDlpWriteCaller {
  const caller = resolveCaller(ctx);
  if (caller === undefined) {
    throw unauthenticatedError();
  }
  return caller;
}

function requireParam(ctx: RequestContext, name: string): string {
  const value = ctx.params[name];
  if (typeof value !== "string" || value.trim().length === 0) {
    throw validationError(`${name} is required`, name, "required");
  }
  return value.trim();
}

async function requirePurviewWrite(
  options: PurviewDlpWriteRouteOptions,
  caller: PurviewDlpWriteCaller,
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
    throw new AppError(ErrorCodes.forbidden, "forbidden: missing Purview.Compliance.ReadWrite", 403);
  }
}

function parseIdempotencyKey(ctx: RequestContext): string {
  try {
    return parseRemediationIdempotencyKey(ctx.headers["idempotency-key"]);
  } catch (error) {
    if (error instanceof RemediationApplyInputError) {
      throw new AppError(error.code, error.message, 400, [
        { field: "Idempotency-Key", reason: "invalid" },
      ]);
    }
    throw error;
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

function confirmFlag(body: Record<string, unknown>): boolean {
  return optionalBoolean(body["confirm"], "confirm") ?? false;
}

function stateOf(policy: PurviewDlpPolicy): DlpPolicyState {
  return {
    name: policy.name,
    enabled: policy.state === "enabled",
    locations: [...policy.locations],
  };
}

function stateRecord(state: DlpPolicyState): Record<string, unknown> {
  return { name: state.name, enabled: state.enabled, locations: [...state.locations] };
}

function buildChangePlan(
  action: DlpPolicyAction,
  policyId: string,
  policyName: string,
  before: Record<string, unknown> | null,
  after: Record<string, unknown> | null,
  assessment: DlpPolicyAssessment,
): PurviewDlpChangePlan {
  const diff: string[] = [];
  const name = String(before?.["name"] ?? after?.["name"] ?? policyName);
  if (action === "create") {
    diff.push(`Create DLP policy '${name}'`);
  } else if (action === "delete") {
    diff.push(`Delete DLP policy '${name}'`);
  } else if (action === "disable") {
    diff.push(`Disable DLP policy '${name}'`);
  } else if (action === "enable") {
    diff.push(`Enable DLP policy '${name}'`);
  } else {
    if (before?.["name"] !== after?.["name"]) {
      diff.push(`Rename DLP policy from '${before?.["name"] ?? ""}' to '${after?.["name"] ?? ""}'`);
    }
    if (JSON.stringify(before?.["locations"] ?? []) !== JSON.stringify(after?.["locations"] ?? [])) {
      diff.push(`Change the locations of DLP policy '${name}'`);
    }
    if (before?.["enabled"] !== after?.["enabled"]) {
      diff.push(`Change the state of DLP policy '${name}'`);
    }
  }

  return {
    action,
    policyId,
    policyName: name,
    before,
    after,
    diff,
    valid: assessment.valid,
    dryRun: false,
    requiresConfirmation: assessment.requiresConfirmation,
    complianceImpacting: assessment.complianceImpacting,
    ...(assessment.warning !== undefined ? { warning: assessment.warning } : {}),
    reasons: assessment.reasons,
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
  const payload = {
    contextRef: `remediation/${tenantId}/${jobId}/job.json`,
    outputRef: `remediation/${tenantId}/${jobId}`,
    credentialRef: `tenants/${tenantId}/credential`,
    sectionRefs: [],
    artifactRefs: [],
    operation: "apply",
    ...extraPayload,
  } as JobEnvelope["payload"];

  return {
    schemaVersion: "v1",
    jobId,
    jobType: "remediation",
    tenantId,
    runId: "",
    requestId,
    correlationId: ctx.correlationId,
    createdAt,
    payload,
  };
}

function auditActionFor(action: DlpPolicyAction): string {
  return `dlp.policy.${action}`;
}

function actorOf(caller: PurviewDlpWriteCaller): string {
  return caller.userId ?? "unknown";
}

async function recordChange(
  options: PurviewDlpWriteRouteOptions,
  ctx: RequestContext,
  input: {
    tenantId: string;
    policyId: string;
    actor: string;
    createdAt: string;
    action: DlpPolicyAction;
    before: Record<string, unknown> | null;
    after: Record<string, unknown> | null;
  },
): Promise<CompliancePolicyChange> {
  const change = await options.repository.recordPolicyChange({
    tenantId: input.tenantId,
    area: "dlp",
    policyId: input.policyId,
    at: input.createdAt,
    by: input.actor,
    before: input.before,
    after: input.after,
  });
  if (options.recordAudit) {
    await options.recordAudit({
      action: auditActionFor(input.action),
      tenantId: input.tenantId,
      actorUserId: input.actor,
      targetId: input.policyId,
      correlationId: ctx.correlationId,
      timestamp: input.createdAt,
      before: input.before,
      after: input.after,
    });
  }
  return change;
}

export function createPurviewDlpWriteRoutes(options: PurviewDlpWriteRouteOptions): Route[] {
  const idGenerator = options.idGenerator ?? (() => randomUUID());
  const now = options.now ?? (() => new Date().toISOString());
  const idempotency = options.idempotency ?? createMemoryPurviewDlpWriteIdempotencyStore();

  async function applyChange(
    ctx: RequestContext,
    input: {
      action: DlpPolicyAction;
      tenantId: string;
      policyId: string;
      policyName: string;
      before: DlpPolicyState | null;
      after: DlpPolicyState | null;
      assessment: DlpPolicyAssessment;
      idempotencyKey: string;
    },
  ): Promise<RouteResponse> {
    const actor = actorOf(requireCaller(options.resolveCaller, ctx));
    const jobId = idGenerator();
    const requestId = idGenerator();
    const changeId = idGenerator();
    const createdAt = now();

    const beforeRecord = input.before === null ? null : stateRecord(input.before);
    const afterRecord = input.after === null ? null : stateRecord(input.after);

    await options.queue.enqueue(
      buildRemediationEnvelope(ctx, input.tenantId, jobId, requestId, createdAt, {
        area: "dlp",
        action: input.action,
        ...(input.policyId.length > 0 ? { policyId: input.policyId } : {}),
        policyName: input.policyName,
        changeId,
        idempotencyKey: input.idempotencyKey,
        actor,
      }),
    );

    const change = await recordChange(options, ctx, {
      tenantId: input.tenantId,
      policyId: input.policyId,
      actor,
      createdAt,
      action: input.action,
      before: beforeRecord,
      after: afterRecord,
    });

    const plan = buildChangePlan(
      input.action,
      input.policyId,
      input.policyName,
      beforeRecord,
      afterRecord,
      input.assessment,
    );
    const result: PurviewDlpChangeResult = {
      success: true,
      plan,
      jobId,
      changeId: change.id,
    };
    return { status: 202, headers: { "content-type": "application/json" }, body: result };
  }

  async function handleCreate(ctx: RequestContext): Promise<RouteResponse> {
    const caller = requireCaller(options.resolveCaller, ctx);
    const tenantId = requireParam(ctx, "tenantId");
    requireTenantInScope(caller, tenantId);
    await requirePurviewWrite(options, caller);

    const idempotencyKey = parseIdempotencyKey(ctx);
    const prior = await idempotency.find(tenantId, idempotencyKey);
    if (prior) {
      return {
        status: 200,
        headers: { "content-type": "application/json" },
        body: { ...prior, replayed: true },
      };
    }

    const body = readBodyRecord(ctx);
    const name = optionalString(body["name"], "name");
    if (!name || name.trim().length === 0) {
      throw validationError("name is required", "name", "required");
    }
    const enabled = optionalBoolean(body["enabled"], "enabled") ?? true;
    const locations = [...(optionalStringArray(body["locations"], "locations") ?? [])];
    const after: DlpPolicyState = { name: name.trim(), enabled, locations };

    const assessment = assertDlpPolicyChange({
      action: "create",
      before: null,
      after,
      confirm: confirmFlag(body),
    });

    const response = await applyChange(ctx, {
      action: "create",
      tenantId,
      policyId: "",
      policyName: after.name,
      before: null,
      after,
      assessment,
      idempotencyKey,
    });
    await idempotency.save(tenantId, idempotencyKey, response.body as PurviewDlpChangeResult);
    return response;
  }

  async function handlePatch(ctx: RequestContext): Promise<RouteResponse> {
    const caller = requireCaller(options.resolveCaller, ctx);
    const tenantId = requireParam(ctx, "tenantId");
    const policyId = requireParam(ctx, "policyId");
    requireTenantInScope(caller, tenantId);
    await requirePurviewWrite(options, caller);

    const idempotencyKey = parseIdempotencyKey(ctx);
    const prior = await idempotency.find(tenantId, idempotencyKey);
    if (prior) {
      return {
        status: 200,
        headers: { "content-type": "application/json" },
        body: { ...prior, replayed: true },
      };
    }

    const body = readBodyRecord(ctx);
    const name = optionalString(body["name"], "name");
    const enabled = optionalBoolean(body["enabled"], "enabled");
    const locations = optionalStringArray(body["locations"], "locations");
    if (name === undefined && enabled === undefined && locations === undefined) {
      throw validationError(
        "at least one of name, enabled, or locations is required",
        "body",
      );
    }

    const existing = await options.provider.getPolicy(tenantId, policyId);
    if (!existing) {
      throw new AppError(PURVIEW_DLP_WRITE_NOT_FOUND, `DLP policy ${policyId} not found`, 404);
    }

    const action: DlpPolicyAction =
      enabled === false ? "disable" : enabled === true ? "enable" : "edit";
    const before = stateOf(existing);
    const after: DlpPolicyState = {
      name: name !== undefined ? name.trim() : before.name,
      enabled: enabled !== undefined ? enabled : before.enabled,
      locations: locations !== undefined ? [...locations] : before.locations,
    };

    const assessment = assertDlpPolicyChange({
      action,
      before,
      after,
      confirm: confirmFlag(body),
    });

    const response = await applyChange(ctx, {
      action,
      tenantId,
      policyId,
      policyName: existing.name,
      before,
      after,
      assessment,
      idempotencyKey,
    });
    await idempotency.save(tenantId, idempotencyKey, response.body as PurviewDlpChangeResult);
    return response;
  }

  async function handleDelete(ctx: RequestContext): Promise<RouteResponse> {
    const caller = requireCaller(options.resolveCaller, ctx);
    const tenantId = requireParam(ctx, "tenantId");
    const policyId = requireParam(ctx, "policyId");
    requireTenantInScope(caller, tenantId);
    await requirePurviewWrite(options, caller);

    const idempotencyKey = parseIdempotencyKey(ctx);
    const prior = await idempotency.find(tenantId, idempotencyKey);
    if (prior) {
      return {
        status: 200,
        headers: { "content-type": "application/json" },
        body: { ...prior, replayed: true },
      };
    }

    const body = readBodyRecord(ctx);
    const existing = await options.provider.getPolicy(tenantId, policyId);
    if (!existing) {
      throw new AppError(PURVIEW_DLP_WRITE_NOT_FOUND, `DLP policy ${policyId} not found`, 404);
    }

    const before = stateOf(existing);
    const assessment = assertDlpPolicyChange({
      action: "delete",
      before,
      after: null,
      confirm: confirmFlag(body),
    });

    const response = await applyChange(ctx, {
      action: "delete",
      tenantId,
      policyId,
      policyName: existing.name,
      before,
      after: null,
      assessment,
      idempotencyKey,
    });
    await idempotency.save(tenantId, idempotencyKey, response.body as PurviewDlpChangeResult);
    return response;
  }

  return [
    { method: "POST", path: PURVIEW_DLP_PATH, handler: handleCreate },
    { method: "PATCH", path: PURVIEW_DLP_ITEM_PATH, handler: handlePatch },
    { method: "DELETE", path: PURVIEW_DLP_ITEM_PATH, handler: handleDelete },
  ];
}

export const PURVIEW_DLP_WRITE_OPENAPI = {
  paths: {
    "/tenants/{tenantId}/purview/dlp": {
      post: {
        operationId: "createPurviewDlpPolicy",
        summary: "Create a DLP policy (applies through the EPIC-006 gated path)",
        permission: PURVIEW_WRITE_PERMISSION,
        security: [{ bearerAuth: [] }],
        parameters: [
          { name: "tenantId", in: "path", required: true, schema: { type: "string" } },
          {
            name: "Idempotency-Key",
            in: "header",
            required: true,
            schema: { type: "string" },
            description: "Required. A repeated key replays the prior queued change.",
          },
        ],
        responses: {
          "202": { description: "The create was queued through the EPIC-006 gated path." },
          "400": { description: "name failed validation or the Idempotency-Key is missing." },
          "401": { description: "Authentication required." },
          "403": { description: "The caller lacks Purview.Compliance.ReadWrite or the tenant is out of scope." },
        },
      },
    },
    "/tenants/{tenantId}/purview/dlp/{policyId}": {
      patch: {
        operationId: "editPurviewDlpPolicy",
        summary: "Edit, enable, or disable a DLP policy (applies through the EPIC-006 gated path)",
        permission: PURVIEW_WRITE_PERMISSION,
        security: [{ bearerAuth: [] }],
        parameters: [
          { name: "tenantId", in: "path", required: true, schema: { type: "string" } },
          { name: "policyId", in: "path", required: true, schema: { type: "string" } },
          {
            name: "Idempotency-Key",
            in: "header",
            required: true,
            schema: { type: "string" },
          },
        ],
        responses: {
          "202": { description: "The change was queued through the EPIC-006 gated path." },
          "400": {
            description: "No editable field was supplied, or confirm is required to disable a policy.",
          },
          "401": { description: "Authentication required." },
          "403": { description: "The caller lacks Purview.Compliance.ReadWrite or the tenant is out of scope." },
          "404": { description: "DLP policy not found." },
        },
      },
      delete: {
        operationId: "deletePurviewDlpPolicy",
        summary: "Delete a DLP policy (compliance-impacting; requires confirmation)",
        permission: PURVIEW_WRITE_PERMISSION,
        security: [{ bearerAuth: [] }],
        parameters: [
          { name: "tenantId", in: "path", required: true, schema: { type: "string" } },
          { name: "policyId", in: "path", required: true, schema: { type: "string" } },
          {
            name: "Idempotency-Key",
            in: "header",
            required: true,
            schema: { type: "string" },
          },
        ],
        responses: {
          "202": { description: "The delete was queued through the EPIC-006 gated path." },
          "400": { description: "confirm is required to delete a DLP policy." },
          "401": { description: "Authentication required." },
          "403": { description: "The caller lacks Purview.Compliance.ReadWrite or the tenant is out of scope." },
          "404": { description: "DLP policy not found." },
        },
      },
    },
  },
} as const;
