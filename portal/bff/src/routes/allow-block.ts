// Tenant allow/block list read + gated change API (EPIC-022 SPEC.md §2 US-5,
// §3.4, §4.3, §5, §6, §7, §8; T-0427).
//
// GET /v1/tenants/:tenantId/allow-block returns the §3.4 table — type
// (sender/domain/URL/file), value, action (allow/block), expires, notes —
// read live from EXO and never persisted: the injected provider is backed by
// the worker queue (T-0010), so this module holds no M365 SDK call and issues
// no tenant write on reads. Reads require `Exchange.SpamFilter.Read` (SPEC §7) intersected
// with the caller tenant scope.
//
// Writes (add/edit/remove) apply only through the EPIC-006 gated path
// (T-0107): the route validates `Exchange.SpamFilter.ReadWrite` + tenant scope, builds a
// before/after plan with the affected entry shown before apply, and enqueues a
// `remediation` job carrying the change. Adding an allow entry or removing a
// block entry is flagged security-impacting before apply and requires explicit
// confirmation. The plan preview (`preview: true`) shows the affected entry
// before apply with no tenant write. Every applied write captures before/after
// and records an AuditEvent. Bulk import validates each row and routes every
// valid row through the same gate, reporting per-row results. No entry is
// mirrored locally; no direct EXO write bypasses EPIC-006.
import { randomUUID } from "node:crypto";
import type { JobEnvelope } from "@m365-assess/contracts";
import { AppError, ErrorCodes } from "../errors.js";
import { requireTenantInScope, type Caller } from "../rbac/authorize.js";
import type { RequestContext, Route, RouteResponse } from "../server.js";

export const ALLOW_BLOCK_PATH = "/v1/tenants/:tenantId/allow-block";
export const ALLOW_BLOCK_IMPORT_PATH = "/v1/tenants/:tenantId/allow-block/import";

export const ALLOW_BLOCK_READ_PERMISSION = "Exchange.SpamFilter.Read";
export const ALLOW_BLOCK_WRITE_PERMISSION = "Exchange.SpamFilter.ReadWrite";
export const REMEDIATION_APPLY_PERMISSION = "Remediation.Apply";
export const ALLOW_BLOCK_UNAUTHENTICATED = "request.unauthenticated";
export const ALLOW_BLOCK_INVALID_TYPE = "allow_block.invalid_type";
export const ALLOW_BLOCK_INVALID_ACTION = "allow_block.invalid_action";
export const ALLOW_BLOCK_NOT_FOUND = "allow_block.not_found";
export const ALLOW_BLOCK_CONFIRM_REQUIRED = "allow_block.confirm_required";

export const ALLOW_BLOCK_TYPES = ["sender", "domain", "url", "file"] as const;
export type AllowBlockType = (typeof ALLOW_BLOCK_TYPES)[number];

export const ALLOW_BLOCK_ACTIONS = ["allow", "block"] as const;
export type AllowBlockAction = (typeof ALLOW_BLOCK_ACTIONS)[number];

export const ALLOW_BLOCK_CHANGE_ACTIONS = ["create", "edit", "delete"] as const;
export type AllowBlockChangeAction = (typeof ALLOW_BLOCK_CHANGE_ACTIONS)[number];

export interface AllowBlockEntry {
  readonly type: AllowBlockType;
  readonly value: string;
  readonly action: AllowBlockAction;
  readonly expiresOn: string | null;
  readonly notes: string;
}

export interface AllowBlockPage {
  readonly tenantId: string;
  readonly items: readonly AllowBlockEntry[];
  readonly totalCount: number;
  readonly retrievedAt: string;
}

export interface AllowBlockAssessment {
  readonly valid: boolean;
  readonly securityImpacting: boolean;
  readonly requiresConfirmation: boolean;
  readonly warning?: string;
  readonly reasons: readonly string[];
}

export const ALLOW_BLOCK_SECURITY_IMPACTING_WARNING =
  "Allowing a sender, domain, URL, or file bypasses spam and phishing protection. " +
  "Prefer an expiry, review the plan preview before applying, and note this change is audited with before/after.";

export interface AllowBlockAffectedEntry {
  readonly type: AllowBlockType;
  readonly value: string;
  readonly action: AllowBlockAction;
  readonly state: "created" | "updated" | "removed";
}

export interface AllowBlockPlan {
  readonly action: AllowBlockChangeAction;
  readonly type: AllowBlockType;
  readonly value: string;
  readonly entryAction: AllowBlockAction;
  readonly before: AllowBlockEntry | null;
  readonly after: AllowBlockEntry | null;
  readonly diff: readonly string[];
  readonly valid: boolean;
  readonly dryRun: boolean;
  readonly requiresConfirmation: boolean;
  readonly securityImpacting: boolean;
  readonly affectedEntries: readonly AllowBlockAffectedEntry[];
  readonly warning?: string;
}

export interface AllowBlockAuditEvent {
  readonly id: string;
  readonly tenantId: string;
  readonly action: string;
  readonly targetId: string;
  readonly targetName: string;
  readonly timestamp: string;
  readonly before: AllowBlockEntry | null;
  readonly after: AllowBlockEntry | null;
}

export interface AllowBlockChangeResult {
  readonly success: boolean;
  readonly plan: AllowBlockPlan;
  readonly jobId: string;
  readonly auditEventId?: string;
}

export interface AllowBlockImportRowInput {
  readonly type?: unknown;
  readonly value?: unknown;
  readonly action?: unknown;
  readonly expiresOn?: unknown;
  readonly notes?: unknown;
}

export interface AllowBlockImportRowResult {
  readonly row: number;
  readonly type: string;
  readonly value: string;
  readonly action: string;
  readonly status: "queued" | "invalid" | "ready";
  readonly reason: string | null;
  readonly jobId: string | null;
}

export interface AllowBlockImportSummary {
  readonly total: number;
  readonly queued: number;
  readonly invalid: number;
  readonly ready: number;
}

export interface AllowBlockImportReport {
  readonly tenantId: string;
  readonly preview: boolean;
  readonly rows: readonly AllowBlockImportRowResult[];
  readonly summary: AllowBlockImportSummary;
}

// Queue-backed seam for the allow/block reads: the production wiring enqueues a
// get-allow-block worker job for the tenant and serves the worker result.
// Depending on the seam keeps EXO and process code out of the BFF.
export interface AllowBlockProvider {
  listEntries(tenantId: string): Promise<AllowBlockPage>;
  getEntry(
    tenantId: string,
    type: AllowBlockType,
    value: string,
    action: AllowBlockAction,
  ): Promise<AllowBlockEntry | undefined>;
}

export interface AllowBlockCaller extends Caller {
  readonly userId?: string;
}

export type AllowBlockAuthorizer = (
  caller: AllowBlockCaller,
  permission: string,
) => void | Promise<void>;

export interface AllowBlockRouteOptions {
  readonly provider: AllowBlockProvider;
  readonly queue?: {
    enqueue(envelope: JobEnvelope): Promise<string>;
  };
  readonly resolveCaller: (ctx: RequestContext) => AllowBlockCaller | undefined;
  readonly authorize?: AllowBlockAuthorizer;
  readonly recordAudit?: (event: Record<string, unknown>) => Promise<void>;
  readonly idGenerator?: () => string;
  readonly now?: () => string;
}

function unauthenticatedError(): AppError {
  return new AppError(ALLOW_BLOCK_UNAUTHENTICATED, "authentication required", 401);
}

function validationError(message: string, field: string): AppError {
  return new AppError(ErrorCodes.validationFailed, message, 400, [
    { field, reason: "invalid" },
  ]);
}

function requireCaller(
  resolveCaller: (ctx: RequestContext) => AllowBlockCaller | undefined,
  ctx: RequestContext,
): AllowBlockCaller {
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

async function requireAllowBlockRead(
  options: AllowBlockRouteOptions,
  caller: AllowBlockCaller,
): Promise<void> {
  if (options.authorize) {
    await options.authorize(caller, ALLOW_BLOCK_READ_PERMISSION);
    return;
  }
  const permissions = caller.permissions ?? [];
  if (!permissions.includes(ALLOW_BLOCK_READ_PERMISSION) && !permissions.includes("*")) {
    throw new AppError(ErrorCodes.forbidden, "forbidden: missing Exchange.SpamFilter.Read", 403);
  }
}

async function requireAllowBlockWrite(
  options: AllowBlockRouteOptions,
  caller: AllowBlockCaller,
): Promise<void> {
  if (options.authorize) {
    await options.authorize(caller, ALLOW_BLOCK_WRITE_PERMISSION);
    return;
  }
  const permissions = caller.permissions ?? [];
  const hasWrite =
    permissions.includes(ALLOW_BLOCK_WRITE_PERMISSION) ||
    permissions.includes(REMEDIATION_APPLY_PERMISSION) ||
    permissions.includes("*");
  if (!hasWrite) {
    throw new AppError(ErrorCodes.forbidden, "forbidden: missing Exchange.SpamFilter.ReadWrite", 403);
  }
}

export function parseAllowBlockType(value: unknown): AllowBlockType {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new AppError(ALLOW_BLOCK_INVALID_TYPE, "type is required", 400, [
      { field: "type", reason: "required" },
    ]);
  }
  const normalized = value.trim().toLowerCase().replace(/[\s_-]/g, "");
  const aliases: Record<string, AllowBlockType> = {
    sender: "sender",
    senders: "sender",
    address: "sender",
    email: "sender",
    domain: "domain",
    domains: "domain",
    url: "url",
    urls: "url",
    file: "file",
    filehash: "file",
    hash: "file",
  };
  const resolved = aliases[normalized];
  if (!resolved) {
    throw validationError(`type must be one of: ${ALLOW_BLOCK_TYPES.join(", ")}`, "type");
  }
  return resolved;
}

export function parseAllowBlockAction(value: unknown): AllowBlockAction {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new AppError(ALLOW_BLOCK_INVALID_ACTION, "action is required", 400, [
      { field: "action", reason: "required" },
    ]);
  }
  const normalized = value.trim().toLowerCase();
  if (!(ALLOW_BLOCK_ACTIONS as readonly string[]).includes(normalized)) {
    throw validationError(`action must be one of: ${ALLOW_BLOCK_ACTIONS.join(", ")}`, "action");
  }
  return normalized as AllowBlockAction;
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
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string") {
    throw validationError(`Field '${field}' must be a string`, field);
  }
  return value;
}

function requireEntryValue(type: AllowBlockType, value: unknown): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw validationError("value is required", "value");
  }
  const trimmed = value.trim();
  if (/\s/.test(trimmed)) {
    throw validationError("value must not contain whitespace", "value");
  }
  if (type === "url" && !/^https?:\/\//i.test(trimmed)) {
    throw validationError("url entries must start with http:// or https://", "value");
  }
  return trimmed;
}

function parseExpiresOn(value: unknown, field: string): string | null {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "string") {
    throw validationError(`Field '${field}' must be an ISO date string`, field);
  }
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    throw validationError(`Field '${field}' must be a valid ISO date`, field);
  }
  return parsed.toISOString();
}

function entryKey(entry: { type: AllowBlockType; value: string; action: AllowBlockAction }): string {
  return `${entry.type}:${entry.value}:${entry.action}`;
}

function requireConfirmation(
  assessment: { securityImpacting: boolean; requiresConfirmation: boolean },
  body: Record<string, unknown>,
): void {
  if (!assessment.securityImpacting) return;
  const confirm = optionalBoolean(body["confirm"], "confirm") ?? false;
  if (!confirm) {
    throw new AppError(
      ALLOW_BLOCK_CONFIRM_REQUIRED,
      "allowing an entry or removing a block is security-impacting and requires confirmation",
      400,
      [{ field: "confirm", reason: "required" }],
    );
  }
}

function assessAllowBlockChange(proposal: {
  action: AllowBlockChangeAction;
  type: AllowBlockType;
  before?: AllowBlockEntry | null;
  after?: AllowBlockEntry | null;
}): AllowBlockAssessment {
  const errors: string[] = [];
  if (!(ALLOW_BLOCK_TYPES as readonly string[]).includes(proposal.type)) {
    errors.push(`type must be one of: ${ALLOW_BLOCK_TYPES.join(", ")}`);
  }
  if (proposal.action === "create") {
    if (!proposal.after || proposal.after.value.trim().length === 0) {
      errors.push("after entry is required for create");
    }
  } else if (proposal.action === "edit" || proposal.action === "delete") {
    if (!proposal.before || proposal.before.value.trim().length === 0) {
      errors.push("before entry is required for edit/delete");
    }
    if (proposal.action === "edit" && (!proposal.after || proposal.after.value.trim().length === 0)) {
      errors.push("after entry is required for edit");
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
  if (action === "create" && after?.action === "allow") {
    reasons.push(`allow entry '${after.value}' bypasses spam and phishing protection`);
  } else if (action === "delete" && before?.action === "block") {
    reasons.push(`removing block entry '${before.value}' removes a protection layer`);
  } else if (action === "edit" && before && after) {
    if (before.action === "block" && after.action === "allow") {
      reasons.push(`changing block entry '${before.value}' to allow bypasses protection`);
    }
    if (after.action === "allow" && before.expiresOn !== null && after.expiresOn === null) {
      reasons.push(`removing the expiry from allow entry '${after.value}' makes it permanent`);
    }
  }

  const securityImpacting = reasons.length > 0;
  return {
    valid: true,
    securityImpacting,
    requiresConfirmation: securityImpacting,
    ...(securityImpacting ? { warning: ALLOW_BLOCK_SECURITY_IMPACTING_WARNING } : {}),
    reasons,
  };
}

function buildChangePlan(
  action: AllowBlockChangeAction,
  type: AllowBlockType,
  entryAction: AllowBlockAction,
  value: string,
  before: AllowBlockEntry | null,
  after: AllowBlockEntry | null,
  assessment: { securityImpacting: boolean; requiresConfirmation: boolean; warning?: string; reasons: readonly string[] },
  dryRun: boolean,
): AllowBlockPlan {
  const diff: string[] = [];
  if (action === "create") {
    diff.push(`Add ${entryAction} ${type} entry '${value}'`);
  } else if (action === "delete") {
    diff.push(`Remove ${entryAction} ${type} entry '${value}'`);
  } else if (before && after) {
    const beforeJson = JSON.stringify({ expiresOn: before.expiresOn, notes: before.notes });
    const afterJson = JSON.stringify({ expiresOn: after.expiresOn, notes: after.notes });
    if (beforeJson !== afterJson) {
      diff.push(`Update ${entryAction} ${type} entry '${value}'`);
    }
  }
  for (const reason of assessment.reasons) {
    diff.push(reason);
  }

  const affectedEntries: AllowBlockAffectedEntry[] = [];
  if (action === "create" && after) {
    affectedEntries.push({ type, value: after.value, action: after.action, state: "created" });
  } else if (action === "edit" && after) {
    affectedEntries.push({ type, value: after.value, action: after.action, state: "updated" });
  } else if (action === "delete" && before) {
    affectedEntries.push({ type, value: before.value, action: before.action, state: "removed" });
  }

  return {
    action,
    type,
    value,
    entryAction,
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

function auditActionFor(action: AllowBlockChangeAction): string {
  switch (action) {
    case "create":
      return "allow-block.entry.create";
    case "edit":
      return "allow-block.entry.edit";
    case "delete":
      return "allow-block.entry.delete";
  }
}

function actorOf(caller: AllowBlockCaller): string {
  return caller.userId ?? "unknown";
}

function requireQueue(options: AllowBlockRouteOptions): { enqueue(envelope: JobEnvelope): Promise<string> } {
  if (!options.queue) {
    throw new AppError(ErrorCodes.internalError, "allow/block writes require a worker queue", 500);
  }
  return options.queue;
}

function importRowsFromBody(body: Record<string, unknown>): readonly AllowBlockImportRowInput[] {
  const rows = body["rows"];
  if (!Array.isArray(rows) || rows.length === 0) {
    throw validationError("rows must be a non-empty array", "rows");
  }
  return rows.map((entry, index) => {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
      throw validationError(`rows[${index}] must be an object`, "rows");
    }
    return entry as AllowBlockImportRowInput;
  });
}

export function createAllowBlockRoutes(options: AllowBlockRouteOptions): Route[] {
  const idGenerator = options.idGenerator ?? (() => randomUUID());
  const now = options.now ?? (() => new Date().toISOString());

  const listHandler = async (ctx: RequestContext): Promise<RouteResponse> => {
    const caller = requireCaller(options.resolveCaller, ctx);
    const tenantId = requireTenantParam(ctx);
    requireTenantInScope(caller, tenantId);
    await requireAllowBlockRead(options, caller);

    const page = await options.provider.listEntries(tenantId);
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
    await requireAllowBlockWrite(options, caller);
    const queue = requireQueue(options);

    const body = readBodyRecord(ctx);
    const type = parseAllowBlockType(body["type"]);
    const value = requireEntryValue(type, body["value"]);
    const entryAction = parseAllowBlockAction(body["action"]);
    const expiresOn = parseExpiresOn(body["expiresOn"], "expiresOn");
    const notes = optionalString(body["notes"], "notes") ?? "";

    const after: AllowBlockEntry = { type, value, action: entryAction, expiresOn, notes };
    const assessment = assessAllowBlockChange({ action: "create", type, after });
    if (!assessment.valid) {
      throw validationError(assessment.reasons.join("; "), "body");
    }

    const isPreview = readPreviewFlag(ctx, body);
    const plan = buildChangePlan("create", type, entryAction, value, null, after, assessment, isPreview);
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
        area: "allow-block",
        action: "create",
        type,
        value,
        entryAction,
        expiresOn,
        notes,
        actor,
      }),
    );

    if (options.recordAudit) {
      await options.recordAudit({
        action: auditActionFor("create"),
        tenantId,
        actorUserId: actor,
        targetId: entryKey(after),
        correlationId: ctx.correlationId,
        timestamp: createdAt,
        before: null,
        after,
      });
    }

    const result: AllowBlockChangeResult = { success: true, plan, jobId, auditEventId };
    return { status: 202, headers: { "content-type": "application/json" }, body: result };
  };

  const patchHandler = async (ctx: RequestContext): Promise<RouteResponse> => {
    const caller = requireCaller(options.resolveCaller, ctx);
    const tenantId = requireTenantParam(ctx);
    requireTenantInScope(caller, tenantId);
    await requireAllowBlockWrite(options, caller);
    const queue = requireQueue(options);

    const body = readBodyRecord(ctx);
    const type = parseAllowBlockType(body["type"]);
    const value = requireEntryValue(type, body["value"]);
    const entryAction = parseAllowBlockAction(body["action"]);

    if (!("expiresOn" in body) && !("notes" in body)) {
      throw validationError("at least one of expiresOn or notes is required", "body");
    }

    const existing = await options.provider.getEntry(tenantId, type, value, entryAction);
    if (!existing) {
      throw new AppError(ALLOW_BLOCK_NOT_FOUND, `allow/block entry ${value} not found`, 404);
    }

    const after: AllowBlockEntry = {
      type: existing.type,
      value: existing.value,
      action: existing.action,
      expiresOn: "expiresOn" in body ? parseExpiresOn(body["expiresOn"], "expiresOn") : existing.expiresOn,
      notes: "notes" in body ? optionalString(body["notes"], "notes") ?? "" : existing.notes,
    };

    const assessment = assessAllowBlockChange({ action: "edit", type, before: existing, after });
    if (!assessment.valid) {
      throw validationError(assessment.reasons.join("; "), "body");
    }

    const isPreview = readPreviewFlag(ctx, body);
    const plan = buildChangePlan("edit", type, entryAction, existing.value, existing, after, assessment, isPreview);
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
        area: "allow-block",
        action: "edit",
        type,
        value: existing.value,
        entryAction,
        expiresOn: after.expiresOn,
        notes: after.notes,
        actor,
      }),
    );

    if (options.recordAudit) {
      await options.recordAudit({
        action: auditActionFor("edit"),
        tenantId,
        actorUserId: actor,
        targetId: entryKey(existing),
        correlationId: ctx.correlationId,
        timestamp: createdAt,
        before: existing,
        after,
      });
    }

    const result: AllowBlockChangeResult = { success: true, plan, jobId, auditEventId };
    return { status: 202, headers: { "content-type": "application/json" }, body: result };
  };

  const deleteHandler = async (ctx: RequestContext): Promise<RouteResponse> => {
    const caller = requireCaller(options.resolveCaller, ctx);
    const tenantId = requireTenantParam(ctx);
    requireTenantInScope(caller, tenantId);
    await requireAllowBlockWrite(options, caller);
    const queue = requireQueue(options);

    const body = readBodyRecord(ctx);
    const type = parseAllowBlockType(body["type"]);
    const value = requireEntryValue(type, body["value"]);
    const entryAction = parseAllowBlockAction(body["action"]);

    const existing = await options.provider.getEntry(tenantId, type, value, entryAction);
    if (!existing) {
      throw new AppError(ALLOW_BLOCK_NOT_FOUND, `allow/block entry ${value} not found`, 404);
    }

    const assessment = assessAllowBlockChange({ action: "delete", type, before: existing });
    const isPreview = readPreviewFlag(ctx, body);
    const plan = buildChangePlan("delete", type, entryAction, existing.value, existing, null, assessment, isPreview);
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
        area: "allow-block",
        action: "delete",
        type,
        value: existing.value,
        entryAction,
        actor,
      }),
    );

    if (options.recordAudit) {
      await options.recordAudit({
        action: auditActionFor("delete"),
        tenantId,
        actorUserId: actor,
        targetId: entryKey(existing),
        correlationId: ctx.correlationId,
        timestamp: createdAt,
        before: existing,
        after: null,
      });
    }

    const result: AllowBlockChangeResult = { success: true, plan, jobId, auditEventId };
    return { status: 202, headers: { "content-type": "application/json" }, body: result };
  };

  const importHandler = async (ctx: RequestContext): Promise<RouteResponse> => {
    const caller = requireCaller(options.resolveCaller, ctx);
    const tenantId = requireTenantParam(ctx);
    requireTenantInScope(caller, tenantId);
    await requireAllowBlockWrite(options, caller);
    const queue = requireQueue(options);

    const body = readBodyRecord(ctx);
    const rows = importRowsFromBody(body);
    const isPreview = readPreviewFlag(ctx, body);
    const actor = actorOf(caller);

    const results: AllowBlockImportRowResult[] = [];
    let queued = 0;
    let invalid = 0;
    let ready = 0;

    for (const [index, row] of rows.entries()) {
      const rowNumber = index + 1;
      let type: AllowBlockType;
      let value: string;
      let entryAction: AllowBlockAction;
      let expiresOn: string | null;
      let notes: string;
      try {
        type = parseAllowBlockType(row.type);
        value = requireEntryValue(type, row.value);
        entryAction = parseAllowBlockAction(row.action);
        expiresOn = parseExpiresOn(row.expiresOn, "expiresOn");
        notes = optionalString(row.notes, "notes") ?? "";
      } catch (error) {
        invalid += 1;
        results.push({
          row: rowNumber,
          type: typeof row.type === "string" ? row.type : "",
          value: typeof row.value === "string" ? row.value : "",
          action: typeof row.action === "string" ? row.action : "",
          status: "invalid",
          reason: error instanceof AppError ? error.message : "invalid row",
          jobId: null,
        });
        continue;
      }

      if (isPreview) {
        ready += 1;
        results.push({
          row: rowNumber,
          type,
          value,
          action: entryAction,
          status: "ready",
          reason: null,
          jobId: null,
        });
        continue;
      }

      const entry: AllowBlockEntry = { type, value, action: entryAction, expiresOn, notes };
      const jobId = idGenerator();
      const requestId = idGenerator();
      const createdAt = now();
      await queue.enqueue(
        buildRemediationEnvelope(ctx, tenantId, jobId, requestId, createdAt, {
          area: "allow-block",
          action: "create",
          type,
          value,
          entryAction,
          expiresOn,
          notes,
          actor,
        }),
      );
      if (options.recordAudit) {
        await options.recordAudit({
          action: auditActionFor("create"),
          tenantId,
          actorUserId: actor,
          targetId: entryKey(entry),
          correlationId: ctx.correlationId,
          timestamp: createdAt,
          before: null,
          after: entry,
        });
      }
      queued += 1;
      results.push({
        row: rowNumber,
        type,
        value,
        action: entryAction,
        status: "queued",
        reason: null,
        jobId,
      });
    }

    const report: AllowBlockImportReport = {
      tenantId,
      preview: isPreview,
      rows: results,
      summary: { total: results.length, queued, invalid, ready },
    };
    return { status: 200, headers: { "content-type": "application/json" }, body: report };
  };

  return [
    { method: "GET", path: ALLOW_BLOCK_PATH, handler: listHandler },
    { method: "POST", path: ALLOW_BLOCK_PATH, handler: createHandler },
    { method: "PATCH", path: ALLOW_BLOCK_PATH, handler: patchHandler },
    { method: "DELETE", path: ALLOW_BLOCK_PATH, handler: deleteHandler },
    { method: "POST", path: ALLOW_BLOCK_IMPORT_PATH, handler: importHandler },
  ];
}

// Route modules own their OpenAPI path items (portal.v1.yaml `paths` is empty
// by design); a wiring ticket merges this fragment into the served document.
export const ALLOW_BLOCK_OPENAPI = {
  paths: {
    "/tenants/{tenantId}/allow-block": {
      get: {
        operationId: "listAllowBlockEntries",
        summary:
          "List tenant allow/block entries live from EXO (type, value, action, expires, notes)",
        permission: ALLOW_BLOCK_READ_PERMISSION,
        security: [{ bearerAuth: [] }],
        parameters: [
          { name: "tenantId", in: "path", required: true, schema: { type: "string" } },
        ],
        responses: {
          "200": { description: "Allow/block entries with the §3.4 columns, read live from EXO." },
          "401": { description: "Authentication required." },
          "403": { description: "The caller lacks Exchange.SpamFilter.Read or the tenant is out of scope." },
        },
      },
      post: {
        operationId: "addAllowBlockEntry",
        summary:
          "Add a tenant allow/block entry with optional expiry (plan preview with preview:true; applies through the EPIC-006 gated path)",
        permission: ALLOW_BLOCK_WRITE_PERMISSION,
        security: [{ bearerAuth: [] }],
        parameters: [
          { name: "tenantId", in: "path", required: true, schema: { type: "string" } },
        ],
        responses: {
          "200": { description: "Plan preview of the entry add with the affected entry." },
          "202": { description: "The add was queued through the EPIC-006 gated path." },
          "400": { description: "type, value, action, or expiresOn failed validation, or confirm is required." },
          "401": { description: "Authentication required." },
          "403": { description: "The caller lacks Exchange.SpamFilter.ReadWrite or the tenant is out of scope." },
        },
      },
      patch: {
        operationId: "editAllowBlockEntry",
        summary:
          "Edit a tenant allow/block entry's expiry or notes (plan preview with preview:true; weakening changes require confirmation)",
        permission: ALLOW_BLOCK_WRITE_PERMISSION,
        security: [{ bearerAuth: [] }],
        parameters: [
          { name: "tenantId", in: "path", required: true, schema: { type: "string" } },
        ],
        responses: {
          "200": { description: "Edit plan preview or the applied change with before/after and audit event." },
          "400": { description: "No editable field was supplied, or confirm is required." },
          "401": { description: "Authentication required." },
          "403": { description: "The caller lacks Exchange.SpamFilter.ReadWrite or the tenant is out of scope." },
          "404": { description: "Allow/block entry not found." },
        },
      },
      delete: {
        operationId: "removeAllowBlockEntry",
        summary:
          "Remove a tenant allow/block entry (removing a block is security-impacting; requires confirmation)",
        permission: ALLOW_BLOCK_WRITE_PERMISSION,
        security: [{ bearerAuth: [] }],
        parameters: [
          { name: "tenantId", in: "path", required: true, schema: { type: "string" } },
        ],
        responses: {
          "200": { description: "Remove plan preview with the affected entry." },
          "202": { description: "The remove was queued through the EPIC-006 gated path." },
          "400": { description: "confirm is required to remove a block entry." },
          "401": { description: "Authentication required." },
          "403": { description: "The caller lacks Exchange.SpamFilter.ReadWrite or the tenant is out of scope." },
          "404": { description: "Allow/block entry not found." },
        },
      },
    },
    "/tenants/{tenantId}/allow-block/import": {
      post: {
        operationId: "importAllowBlockEntries",
        summary:
          "Bulk-import tenant allow/block entries with per-row results; every valid row routes through the EPIC-006 gate",
        permission: ALLOW_BLOCK_WRITE_PERMISSION,
        security: [{ bearerAuth: [] }],
        parameters: [
          { name: "tenantId", in: "path", required: true, schema: { type: "string" } },
        ],
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: {
                  rows: { type: "array", items: { type: "object" } },
                  preview: { type: "boolean" },
                },
              },
            },
          },
        },
        responses: {
          "200": { description: "Per-row import results (queued, ready, invalid)." },
          "400": { description: "The request shape or a row failed validation." },
          "401": { description: "Authentication required." },
          "403": { description: "The caller lacks Exchange.SpamFilter.ReadWrite or the tenant is out of scope." },
        },
      },
    },
  },
} as const;
