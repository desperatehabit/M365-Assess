// Quarantine notification and permission policy read + gated change API
// (EPIC-022 SPEC.md §2 US-6, §3.5, §4.4, §5, §6, §7, §8; T-0428).
// GET /v1/tenants/:tenantId/quarantine-policies returns the §3.5 table —
// name, policy type (notification/permission), key settings (end-user spam
// notifications, quarantine retention, access model), last modified — for
// both quarantine policy types. Policies are read live from EXO and never
// persisted: the injected provider is backed by the worker queue (T-0010),
// so this module holds no M365 SDK call and issues no tenant write on reads.
// Reads require `Exchange.Quarantine.Read` (SPEC §7) intersected with the caller
// tenant scope.
//
// Writes (create/edit/delete) apply only through the EPIC-006 gated path
// (T-0107): the route validates `Exchange.Quarantine.ReadWrite` + tenant scope, builds a
// before/after plan with the affected entries shown before apply, and
// enqueues a `remediation` job carrying the change. A deleting change is
// flagged security-impacting before apply and requires explicit
// confirmation. The plan preview (`preview: true`) shows the affected
// entries before apply with no tenant write. Every applied write captures
// before/after and records an AuditEvent. No direct EXO write bypasses
// EPIC-006.
import { randomUUID } from "node:crypto";
import type { JobEnvelope } from "@m365-assess/contracts";
import { AppError, ErrorCodes } from "../errors.js";
import { requireTenantInScope, type Caller } from "../rbac/authorize.js";
import type { RequestContext, Route, RouteResponse } from "../server.js";

export const QUARANTINE_POLICIES_PATH = "/v1/tenants/:tenantId/quarantine-policies";
export const QUARANTINE_POLICIES_ITEM_PATH =
  "/v1/tenants/:tenantId/quarantine-policies/:policyName";

export const QUARANTINE_POLICIES_READ_PERMISSION = "Exchange.Quarantine.Read";
export const QUARANTINE_POLICIES_WRITE_PERMISSION = "Exchange.Quarantine.ReadWrite";
export const REMEDIATION_APPLY_PERMISSION = "Remediation.Apply";
export const QUARANTINE_POLICIES_UNAUTHENTICATED = "request.unauthenticated";
export const QUARANTINE_POLICIES_NOT_FOUND = "quarantine_policies.not_found";
export const QUARANTINE_POLICIES_CONFIRM_REQUIRED = "quarantine_policies.confirm_required";

export const QUARANTINE_POLICY_TYPES = ["notification", "permission"] as const;
export type QuarantinePolicyType = (typeof QUARANTINE_POLICY_TYPES)[number];

export const QUARANTINE_POLICY_ACTIONS = ["create", "edit", "delete"] as const;
export type QuarantinePolicyAction = (typeof QUARANTINE_POLICY_ACTIONS)[number];

export interface QuarantinePolicy {
  readonly name: string;
  readonly policyType: QuarantinePolicyType | string;
  readonly esnEnabled: boolean;
  readonly quarantineRetentionPeriod: number;
  readonly addressForMessages: string;
  readonly lastModified: string | null;
}

export interface QuarantinePoliciesPage {
  readonly tenantId: string;
  readonly items: readonly QuarantinePolicy[];
  readonly totalCount: number;
  readonly retrievedAt: string;
}

export interface QuarantinePolicyState {
  readonly name: string;
  readonly policyType: QuarantinePolicyType;
  readonly settings: Record<string, unknown>;
}

export interface QuarantinePolicyProposal {
  readonly action: QuarantinePolicyAction;
  readonly policyType: QuarantinePolicyType;
  readonly before?: QuarantinePolicyState | null;
  readonly after?: QuarantinePolicyState | null;
}

export interface QuarantinePolicyAssessment {
  readonly valid: boolean;
  readonly securityImpacting: boolean;
  readonly requiresConfirmation: boolean;
  readonly warning?: string;
  readonly reasons: readonly string[];
}

export const QUARANTINE_SECURITY_IMPACTING_WARNING =
  "Deleting or weakening a quarantine policy reduces protection against spam and phishing. " +
  "Review the plan preview before applying. This change is audited with before/after.";

const DESTRUCTIVE_ACTIONS: ReadonlySet<QuarantinePolicyAction> = new Set(["delete"]);

export interface QuarantinePolicyPlan {
  readonly action: QuarantinePolicyAction;
  readonly policyType: QuarantinePolicyType;
  readonly policyName: string;
  readonly before: QuarantinePolicyState | null;
  readonly after: QuarantinePolicyState | null;
  readonly diff: readonly string[];
  readonly valid: boolean;
  readonly dryRun: boolean;
  readonly requiresConfirmation: boolean;
  readonly securityImpacting: boolean;
  readonly affectedEntries: readonly QuarantinePolicyAffectedEntry[];
  readonly warning?: string;
}

export interface QuarantinePolicyAffectedEntry {
  readonly name: string;
  readonly policyType: QuarantinePolicyType;
  readonly state: string;
}

export interface QuarantinePolicyAuditEvent {
  readonly id: string;
  readonly tenantId: string;
  readonly action: string;
  readonly targetId: string;
  readonly targetName: string;
  readonly timestamp: string;
  readonly before: QuarantinePolicyState | null;
  readonly after: QuarantinePolicyState | null;
}

export interface QuarantinePolicyChangeResult {
  readonly success: boolean;
  readonly plan: QuarantinePolicyPlan;
  readonly jobId: string;
  readonly auditEventId?: string;
}

export interface CreateQuarantinePolicyInput {
  readonly name: string;
  readonly policyType: QuarantinePolicyType;
  readonly settings?: Record<string, unknown>;
  readonly preview?: boolean;
  readonly confirm?: boolean;
}

export interface EditQuarantinePolicyInput {
  readonly policyType?: QuarantinePolicyType;
  readonly settings?: Record<string, unknown>;
  readonly preview?: boolean;
  readonly confirm?: boolean;
}

// Queue-backed seam for the quarantine policy reads: the production wiring
// enqueues a get-quarantine-policies worker job for the tenant and serves
// the worker result. Depending on the seam keeps EXO and process code out
// of the BFF.
export interface QuarantinePoliciesProvider {
  listPolicies(tenantId: string): Promise<QuarantinePoliciesPage>;
  getPolicy(
    tenantId: string,
    policyType: QuarantinePolicyType,
    policyName: string,
  ): Promise<QuarantinePolicyState | undefined>;
}

export interface QuarantinePoliciesCaller extends Caller {
  readonly userId?: string;
}

export type QuarantinePoliciesAuthorizer = (
  caller: QuarantinePoliciesCaller,
  permission: string,
) => void | Promise<void>;

export interface QuarantinePoliciesRouteOptions {
  readonly provider: QuarantinePoliciesProvider;
  readonly queue?: {
    enqueue(envelope: JobEnvelope): Promise<string>;
  };
  readonly resolveCaller: (ctx: RequestContext) => QuarantinePoliciesCaller | undefined;
  readonly authorize?: QuarantinePoliciesAuthorizer;
  readonly recordAudit?: (event: Record<string, unknown>) => Promise<void>;
  readonly idGenerator?: () => string;
  readonly now?: () => string;
}

function unauthenticatedError(): AppError {
  return new AppError(QUARANTINE_POLICIES_UNAUTHENTICATED, "authentication required", 401);
}

function validationError(message: string, field: string): AppError {
  return new AppError(ErrorCodes.validationFailed, message, 400, [
    { field, reason: "invalid" },
  ]);
}

function requireCaller(
  resolveCaller: (ctx: RequestContext) => QuarantinePoliciesCaller | undefined,
  ctx: RequestContext,
): QuarantinePoliciesCaller {
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

function requirePolicyNameParam(ctx: RequestContext): string {
  const value = ctx.params["policyName"];
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new AppError(ErrorCodes.validationFailed, "policyName is required", 400, [
      { field: "policyName", reason: "required" },
    ]);
  }
  return value.trim();
}

async function requireQuarantinePoliciesRead(
  options: QuarantinePoliciesRouteOptions,
  caller: QuarantinePoliciesCaller,
): Promise<void> {
  if (options.authorize) {
    await options.authorize(caller, QUARANTINE_POLICIES_READ_PERMISSION);
    return;
  }
  const permissions = caller.permissions ?? [];
  if (!permissions.includes(QUARANTINE_POLICIES_READ_PERMISSION) && !permissions.includes("*")) {
    throw new AppError(ErrorCodes.forbidden, "forbidden: missing Exchange.Quarantine.Read", 403);
  }
}

async function requireQuarantinePoliciesWrite(
  options: QuarantinePoliciesRouteOptions,
  caller: QuarantinePoliciesCaller,
): Promise<void> {
  if (options.authorize) {
    await options.authorize(caller, QUARANTINE_POLICIES_WRITE_PERMISSION);
    return;
  }
  const permissions = caller.permissions ?? [];
  const hasWrite =
    permissions.includes(QUARANTINE_POLICIES_WRITE_PERMISSION) ||
    permissions.includes(REMEDIATION_APPLY_PERMISSION) ||
    permissions.includes("*");
  if (!hasWrite) {
    throw new AppError(
      ErrorCodes.forbidden,
      `forbidden: write requires ${QUARANTINE_POLICIES_WRITE_PERMISSION} or ${REMEDIATION_APPLY_PERMISSION}`,
      403,
    );
  }
}

export function parseQuarantinePolicyType(value: unknown): QuarantinePolicyType {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new AppError(ErrorCodes.validationFailed, "policyType is required", 400, [
      { field: "policyType", reason: "required" },
    ]);
  }
  const normalized = value.trim().toLowerCase().replace(/-/g, "");
  if (!(QUARANTINE_POLICY_TYPES as readonly string[]).includes(normalized)) {
    throw validationError(
      `policyType must be one of: ${QUARANTINE_POLICY_TYPES.join(", ")}`,
      "policyType",
    );
  }
  return normalized as QuarantinePolicyType;
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

function requireConfirmation(
  assessment: { securityImpacting: boolean; requiresConfirmation: boolean },
  body: Record<string, unknown>,
): void {
  if (!assessment.securityImpacting) return;
  const confirm = optionalBoolean(body["confirm"], "confirm") ?? false;
  if (!confirm) {
    throw new AppError(
      QUARANTINE_POLICIES_CONFIRM_REQUIRED,
      "deleting or weakening a quarantine policy is security-impacting and requires confirmation",
      400,
      [{ field: "confirm", reason: "required" }],
    );
  }
}

function settingBoolean(settings: Record<string, unknown>, key: string): boolean | undefined {
  const value = settings[key];
  return typeof value === "boolean" ? value : undefined;
}

function settingNumber(settings: Record<string, unknown>, key: string): number | undefined {
  const value = settings[key];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function assessQuarantinePolicyChange(proposal: QuarantinePolicyProposal): QuarantinePolicyAssessment {
  const errors: string[] = [];
  if (!(QUARANTINE_POLICY_TYPES as readonly string[]).includes(proposal.policyType)) {
    errors.push(`policyType must be one of: ${QUARANTINE_POLICY_TYPES.join(", ")}`);
  }
  if (proposal.action === "create") {
    const after = proposal.after;
    if (!after || typeof after.name !== "string" || after.name.trim().length === 0) {
      errors.push("after.name is required for create");
    }
  } else if (proposal.action === "edit" || proposal.action === "delete") {
    if (!proposal.before || typeof proposal.before.name !== "string" || proposal.before.name.trim().length === 0) {
      errors.push("before state is required for edit/delete");
    }
    if (proposal.action === "edit" && (!proposal.after || typeof proposal.after.name !== "string" || proposal.after.name.trim().length === 0)) {
      errors.push("after state is required for edit");
    }
  } else {
    errors.push(`unknown action: ${String(proposal.action)}`);
  }
  if (errors.length > 0) {
    return {
      valid: false,
      securityImpacting: false,
      requiresConfirmation: false,
      reasons: errors,
    };
  }

  const reasons: string[] = [];
  const { action, before, after } = proposal;

  if (action === "delete") {
    reasons.push(`quarantine policy '${before?.name}' is deleted, removing a protection layer`);
  } else if (action === "edit" && before && after) {
    const beforeEsn = settingBoolean(before.settings, "esnEnabled");
    const afterEsn = settingBoolean(after.settings, "esnEnabled");
    if (beforeEsn === true && afterEsn === false) {
      reasons.push("quarantine policy end-user spam notifications are disabled");
    }
    const beforeRetention = settingNumber(before.settings, "quarantineRetentionPeriod");
    const afterRetention = settingNumber(after.settings, "quarantineRetentionPeriod");
    if (beforeRetention !== undefined && afterRetention !== undefined && afterRetention < beforeRetention) {
      reasons.push(
        `quarantine retention period lowers from ${beforeRetention} to ${afterRetention} days, releasing quarantined mail sooner`,
      );
    }
  }

  const securityImpacting = DESTRUCTIVE_ACTIONS.has(action) || reasons.length > 0;
  return {
    valid: true,
    securityImpacting,
    requiresConfirmation: securityImpacting,
    ...(securityImpacting ? { warning: QUARANTINE_SECURITY_IMPACTING_WARNING } : {}),
    reasons,
  };
}

function buildChangePlan(
  action: QuarantinePolicyAction,
  policyType: QuarantinePolicyType,
  policyName: string,
  before: QuarantinePolicyState | null,
  after: QuarantinePolicyState | null,
  assessment: { securityImpacting: boolean; requiresConfirmation: boolean; warning?: string; reasons: readonly string[] },
  dryRun: boolean,
): QuarantinePolicyPlan {
  const diff: string[] = [];
  if (action === "create") {
    diff.push(`Create ${policyType} quarantine policy '${after?.name ?? policyName}'`);
  } else if (action === "delete") {
    diff.push(`Delete ${policyType} quarantine policy '${before?.name ?? policyName}'`);
  } else if (action === "edit") {
    if (before && after) {
      const beforeJson = JSON.stringify(before.settings);
      const afterJson = JSON.stringify(after.settings);
      if (beforeJson !== afterJson) {
        diff.push(`Update ${policyType} quarantine policy settings for '${after.name}'`);
      }
    }
  }
  for (const reason of assessment.reasons) {
    diff.push(reason);
  }

  const affectedEntries: QuarantinePolicyAffectedEntry[] = [];
  if (action === "create" && after) {
    affectedEntries.push({ name: after.name, policyType, state: "created" });
  } else if (action === "edit" && after) {
    affectedEntries.push({ name: after.name, policyType, state: "updated" });
  } else if (action === "delete" && before) {
    affectedEntries.push({ name: before.name, policyType, state: "deleted" });
  }

  return {
    action,
    policyType,
    policyName,
    before,
    after,
    diff,
    valid: true,
    dryRun,
    requiresConfirmation: assessment.requiresConfirmation,
    securityImpacting: assessment.securityImpacting,
    affectedEntries,
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

function auditActionFor(action: QuarantinePolicyAction): string {
  switch (action) {
    case "create":
      return "quarantine.policy.create";
    case "edit":
      return "quarantine.policy.edit";
    case "delete":
      return "quarantine.policy.delete";
  }
}

function actorOf(caller: QuarantinePoliciesCaller): string {
  return caller.userId ?? "unknown";
}

function requireQueue(options: QuarantinePoliciesRouteOptions): { enqueue(envelope: JobEnvelope): Promise<string> } {
  if (!options.queue) {
    throw new AppError(ErrorCodes.internalError, "quarantine policy writes require a worker queue", 500);
  }
  return options.queue;
}

export function createQuarantinePoliciesRoutes(options: QuarantinePoliciesRouteOptions): Route[] {
  const idGenerator = options.idGenerator ?? (() => randomUUID());
  const now = options.now ?? (() => new Date().toISOString());

  const listHandler = async (ctx: RequestContext): Promise<RouteResponse> => {
    const caller = requireCaller(options.resolveCaller, ctx);
    const tenantId = requireTenantParam(ctx);
    requireTenantInScope(caller, tenantId);
    await requireQuarantinePoliciesRead(options, caller);
    const page = await options.provider.listPolicies(tenantId);
    return {
      status: 200,
      headers: { "content-type": "application/json" },
      body: {
        tenantId,
        items: [...page.items],
        totalCount: page.totalCount,
        retrievedAt: page.retrievedAt,
      },
    };
  };

  const createHandler = async (ctx: RequestContext): Promise<RouteResponse> => {
    const caller = requireCaller(options.resolveCaller, ctx);
    const tenantId = requireTenantParam(ctx);
    requireTenantInScope(caller, tenantId);
    await requireQuarantinePoliciesWrite(options, caller);
    const queue = requireQueue(options);

    const body = readBodyRecord(ctx);
    const name = optionalString(body["name"], "name");
    if (!name || name.trim().length === 0) {
      throw validationError("name is required", "name");
    }
    const policyType = parseQuarantinePolicyType(body["policyType"]);
    const settings = optionalSettings(body["settings"], "settings") ?? {};

    const after: QuarantinePolicyState = { name: name.trim(), policyType, settings };
    const assessment = assessQuarantinePolicyChange({ action: "create", policyType, after });
    if (!assessment.valid) {
      throw validationError(assessment.reasons.join("; "), "body");
    }

    const isPreview = readPreviewFlag(ctx, body);
    const plan = buildChangePlan("create", policyType, name.trim(), null, after, assessment, isPreview);
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
        area: "quarantine-policies",
        action: "create",
        policyType,
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

    const result: QuarantinePolicyChangeResult = { success: true, plan, jobId, auditEventId };
    return { status: 202, headers: { "content-type": "application/json" }, body: result };
  };

  const patchHandler = async (ctx: RequestContext): Promise<RouteResponse> => {
    const caller = requireCaller(options.resolveCaller, ctx);
    const tenantId = requireTenantParam(ctx);
    const policyName = requirePolicyNameParam(ctx);
    requireTenantInScope(caller, tenantId);
    await requireQuarantinePoliciesWrite(options, caller);
    const queue = requireQueue(options);

    const body = readBodyRecord(ctx);
    const policyType = parseQuarantinePolicyType(body["policyType"]);
    const settings = optionalSettings(body["settings"], "settings");

    if (settings === undefined) {
      throw validationError("settings is required", "settings");
    }

    const existing = await options.provider.getPolicy(tenantId, policyType, policyName);
    if (!existing) {
      throw new AppError(QUARANTINE_POLICIES_NOT_FOUND, `quarantine policy ${policyName} not found`, 404);
    }

    const after: QuarantinePolicyState = {
      name: existing.name,
      policyType,
      settings: settings as Record<string, unknown>,
    };
    const before: QuarantinePolicyState = {
      name: existing.name,
      policyType: existing.policyType as QuarantinePolicyType,
      settings: existing.settings,
    };

    const assessment = assessQuarantinePolicyChange({ action: "edit", policyType, before, after });
    if (!assessment.valid) {
      throw validationError(assessment.reasons.join("; "), "body");
    }

    const isPreview = readPreviewFlag(ctx, body);
    const plan = buildChangePlan("edit", policyType, existing.name, before, after, assessment, isPreview);
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
        area: "quarantine-policies",
        action: "edit",
        policyType,
        policyName: existing.name,
        settings: after.settings,
        actor,
      }),
    );

    if (options.recordAudit) {
      await options.recordAudit({
        action: auditActionFor("edit"),
        tenantId,
        actorUserId: actor,
        targetId: existing.name,
        correlationId: ctx.correlationId,
        timestamp: createdAt,
        before,
        after,
      });
    }

    const result: QuarantinePolicyChangeResult = { success: true, plan, jobId, auditEventId };
    return { status: 202, headers: { "content-type": "application/json" }, body: result };
  };

  const deleteHandler = async (ctx: RequestContext): Promise<RouteResponse> => {
    const caller = requireCaller(options.resolveCaller, ctx);
    const tenantId = requireTenantParam(ctx);
    const policyName = requirePolicyNameParam(ctx);
    requireTenantInScope(caller, tenantId);
    await requireQuarantinePoliciesWrite(options, caller);
    const queue = requireQueue(options);

    const body = readBodyRecord(ctx);
    const policyType = parseQuarantinePolicyType(body["policyType"]);

    const existing = await options.provider.getPolicy(tenantId, policyType, policyName);
    if (!existing) {
      throw new AppError(QUARANTINE_POLICIES_NOT_FOUND, `quarantine policy ${policyName} not found`, 404);
    }

    const before: QuarantinePolicyState = {
      name: existing.name,
      policyType: existing.policyType as QuarantinePolicyType,
      settings: existing.settings,
    };
    const assessment = assessQuarantinePolicyChange({ action: "delete", policyType, before });

    const isPreview = readPreviewFlag(ctx, body);
    const plan = buildChangePlan("delete", policyType, existing.name, before, null, assessment, isPreview);
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
        area: "quarantine-policies",
        action: "delete",
        policyType,
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

    const result: QuarantinePolicyChangeResult = { success: true, plan, jobId, auditEventId };
    return { status: 202, headers: { "content-type": "application/json" }, body: result };
  };

  return [
    { method: "GET", path: QUARANTINE_POLICIES_PATH, handler: listHandler },
    { method: "POST", path: QUARANTINE_POLICIES_PATH, handler: createHandler },
    { method: "PATCH", path: QUARANTINE_POLICIES_ITEM_PATH, handler: patchHandler },
    { method: "DELETE", path: QUARANTINE_POLICIES_ITEM_PATH, handler: deleteHandler },
  ];
}

// Route modules own their OpenAPI path items (portal.v1.yaml `paths` is empty
// by design); a wiring ticket merges this fragment into the served document.
export const QUARANTINE_POLICIES_OPENAPI = {
  paths: {
    "/tenants/{tenantId}/quarantine-policies": {
      get: {
        operationId: "listQuarantinePolicies",
        summary:
          "List quarantine notification and permission policies live from EXO (name, type, end-user spam notifications, retention, access model, last modified)",
        permission: QUARANTINE_POLICIES_READ_PERMISSION,
        security: [{ bearerAuth: [] }],
        parameters: [
          { name: "tenantId", in: "path", required: true, schema: { type: "string" } },
        ],
        responses: {
          "200": { description: "Quarantine policies with the §3.5 columns, read live from EXO." },
          "401": { description: "Authentication required." },
          "403": { description: "The caller lacks Exchange.Quarantine.Read or the tenant is out of scope." },
        },
      },
      post: {
        operationId: "createQuarantinePolicy",
        summary:
          "Create a quarantine notification or permission policy (plan preview with preview:true; applies through the EPIC-006 gated path)",
        permission: QUARANTINE_POLICIES_WRITE_PERMISSION,
        security: [{ bearerAuth: [] }],
        parameters: [
          { name: "tenantId", in: "path", required: true, schema: { type: "string" } },
        ],
        responses: {
          "200": { description: "Plan preview of the policy create with affected entries." },
          "202": { description: "The create was queued through the EPIC-006 gated path." },
          "400": { description: "name, policyType, or settings failed validation." },
          "401": { description: "Authentication required." },
          "403": { description: "The caller lacks Exchange.Quarantine.ReadWrite or the tenant is out of scope." },
        },
      },
    },
    "/tenants/{tenantId}/quarantine-policies/{policyName}": {
      patch: {
        operationId: "editQuarantinePolicy",
        summary:
          "Edit a quarantine notification or permission policy (plan preview with preview:true shows affected entries; weakening changes require confirmation)",
        permission: QUARANTINE_POLICIES_WRITE_PERMISSION,
        security: [{ bearerAuth: [] }],
        parameters: [
          { name: "tenantId", in: "path", required: true, schema: { type: "string" } },
          { name: "policyName", in: "path", required: true, schema: { type: "string" } },
        ],
        responses: {
          "200": { description: "Edit plan preview or the applied change with before/after and audit event." },
          "400": { description: "policyType or settings failed validation, or confirm is required for a security-impacting change." },
          "401": { description: "Authentication required." },
          "403": { description: "The caller lacks Exchange.Quarantine.ReadWrite or the tenant is out of scope." },
          "404": { description: "Quarantine policy not found." },
        },
      },
      delete: {
        operationId: "deleteQuarantinePolicy",
        summary:
          "Delete a quarantine policy (security-impacting; requires confirmation)",
        permission: QUARANTINE_POLICIES_WRITE_PERMISSION,
        security: [{ bearerAuth: [] }],
        parameters: [
          { name: "tenantId", in: "path", required: true, schema: { type: "string" } },
          { name: "policyName", in: "path", required: true, schema: { type: "string" } },
        ],
        responses: {
          "200": { description: "Delete plan preview with affected entries." },
          "202": { description: "The delete was queued through the EPIC-006 gated path." },
          "400": { description: "confirm is required to delete a quarantine policy." },
          "401": { description: "Authentication required." },
          "403": { description: "The caller lacks Exchange.Quarantine.ReadWrite or the tenant is out of scope." },
          "404": { description: "Quarantine policy not found." },
        },
      },
    },
  },
} as const;
