// Purview sensitivity-label and SIT read + gated change API (EPIC-030 SPEC.md
// §2 US-3/US-4, §3.3, §3.4, §4.3, §5, §6, §7, §8, §11.2; T-0587).
//
// Reads are served live from Purview through the injected provider, which is
// backed by the worker queue (get-purview-labels.ps1 over the T-0582 Purview
// session seam); this module holds no Purview SDK call and issues no tenant write
// on reads.
//
// Changes apply only through the EPIC-006 gated path (T-0108): the route
// validates `purview.write` + tenant scope, builds a before/after plan, enqueues
// a `remediation` job carrying the change, and records the append-only
// CompliancePolicyChange row (T-0581) plus an audit event. Any change that
// alters a label's encryption settings is refused until a second reviewer
// distinct from the requester approves (`assertLabelEncryptionReview`); the
// approval is recorded on the change row and in the audit event. Label creation
// and publishing-policy assignment are separate operations: creating a label
// rejects publishing-policy fields, and `POST .../labels/:labelId/publish`
// assigns the policy.
import { randomUUID } from "node:crypto";
import type { JobEnvelope } from "@m365-assess/contracts";
import { AppError, ErrorCodes } from "../errors.js";
import { parsePagination } from "../pagination.js";
import { requireTenantInScope, type Caller } from "../rbac/authorize.js";
import type { RequestContext, Route, RouteResponse } from "../server.js";
import type {
  CompliancePolicyChange,
  PurviewComplianceRepository,
} from "../repository/purview-compliance.js";
import {
  assertLabelEncryptionReview,
  LABEL_ENCRYPTION_REVIEW_NOT_DISTINCT,
  LABEL_ENCRYPTION_REVIEW_REQUIRED,
  type LabelEncryptionApproval,
  type LabelEncryptionReview,
  type LabelEncryptionSettings,
} from "../domain/compliance/label-encryption-review.js";

export const PURVIEW_LABELS_PATH = "/v1/tenants/:tenantId/purview/labels";
export const PURVIEW_LABEL_ITEM_PATH = "/v1/tenants/:tenantId/purview/labels/:labelId";
export const PURVIEW_LABEL_PUBLISH_PATH = "/v1/tenants/:tenantId/purview/labels/:labelId/publish";
export const PURVIEW_SITS_PATH = "/v1/tenants/:tenantId/purview/sits";
export const PURVIEW_SIT_ITEM_PATH = "/v1/tenants/:tenantId/purview/sits/:sitId";

export const PURVIEW_READ_PERMISSION = "purview.read";
export const PURVIEW_WRITE_PERMISSION = "purview.write";
export const REMEDIATION_APPLY_PERMISSION = "Remediation.Apply";

export const PURVIEW_LABELS_UNAUTHENTICATED = "request.unauthenticated";
export const PURVIEW_LABEL_NOT_FOUND = "label.not_found";
export const PURVIEW_SIT_NOT_FOUND = "sit.not_found";
export const PURVIEW_SIT_BUILTIN_READONLY = "sit.builtin_readonly";
export const PURVIEW_LABEL_PUBLISH_SEPARATE = "label.publish_separate_operation";

export { LABEL_ENCRYPTION_REVIEW_NOT_DISTINCT, LABEL_ENCRYPTION_REVIEW_REQUIRED };

export type PurviewLabelChangeAction = "create" | "edit" | "delete" | "publish";
export type PurviewSitChangeAction = "create" | "edit" | "delete";

export interface SensitivityLabel {
  readonly id: string;
  readonly name: string;
  readonly scope: readonly string[];
  readonly priority: number | null;
  readonly encryption: LabelEncryptionSettings | null;
  readonly marking: readonly string[];
  readonly state: string;
  readonly published?: boolean;
  readonly publishingPolicies?: readonly string[];
}

export interface SensitiveInfoType {
  readonly id: string;
  readonly name: string;
  readonly type: string;
  readonly patternConfidence: string | null;
  readonly basedOn: string | null;
}

export interface PurviewLabelPage {
  readonly tenantId: string;
  readonly kind?: string;
  readonly items: readonly SensitivityLabel[];
  readonly nextCursor: string | null;
  readonly totalCount: number;
}

export interface PurviewSitPage {
  readonly tenantId: string;
  readonly kind?: string;
  readonly items: readonly SensitiveInfoType[];
  readonly nextCursor: string | null;
  readonly totalCount: number;
}

export interface PurviewLabelFilter {
  readonly search?: string;
  readonly state?: string;
  readonly limit?: number;
  readonly cursor?: string;
}

export interface PurviewSitFilter {
  readonly search?: string;
  readonly type?: string;
  readonly limit?: number;
  readonly cursor?: string;
}

export interface PurviewLabelProvider {
  listLabels(tenantId: string, filter?: PurviewLabelFilter): Promise<PurviewLabelPage>;
  getLabel(tenantId: string, labelId: string): Promise<SensitivityLabel | undefined>;
  listSits(tenantId: string, filter?: PurviewSitFilter): Promise<PurviewSitPage>;
  getSit(tenantId: string, sitId: string): Promise<SensitiveInfoType | undefined>;
}

export interface PurviewLabelsCaller extends Caller {
  readonly userId?: string;
}

export type PurviewLabelsAuthorizer = (
  caller: PurviewLabelsCaller,
  permission: string,
) => void | Promise<void>;

export interface PurviewLabelsRouteOptions {
  readonly provider: PurviewLabelProvider;
  readonly queue: {
    enqueue(envelope: JobEnvelope): Promise<string>;
  };
  readonly repository: PurviewComplianceRepository;
  readonly resolveCaller: (ctx: RequestContext) => PurviewLabelsCaller | undefined;
  readonly authorize?: PurviewLabelsAuthorizer;
  readonly recordAudit?: (event: Record<string, unknown>) => Promise<void>;
  readonly idGenerator?: () => string;
  readonly now?: () => string;
}

export interface CreateLabelInput {
  readonly name: string;
  readonly scope?: readonly string[];
  readonly priority?: number;
  readonly encryption?: LabelEncryptionSettings;
  readonly marking?: readonly string[];
  readonly enabled?: boolean;
  readonly encryptionApproval?: LabelEncryptionApproval;
  readonly confirm?: boolean;
}

export interface EditLabelInput {
  readonly name?: string;
  readonly scope?: readonly string[];
  readonly priority?: number;
  readonly encryption?: LabelEncryptionSettings;
  readonly marking?: readonly string[];
  readonly enabled?: boolean;
  readonly encryptionApproval?: LabelEncryptionApproval;
  readonly confirm?: boolean;
}

export interface PublishLabelInput {
  readonly publishingPolicyId?: string;
  readonly publishingPolicyName?: string;
  readonly confirm?: boolean;
}

export interface CreateSitInput {
  readonly name: string;
  readonly patternConfidence?: string;
  readonly basedOn?: string;
  readonly confirm?: boolean;
}

export interface EditSitInput {
  readonly name?: string;
  readonly patternConfidence?: string;
  readonly basedOn?: string;
  readonly confirm?: boolean;
}

export interface PurviewLabelChangePlan {
  readonly action: PurviewLabelChangeAction;
  readonly labelId: string;
  readonly labelName: string;
  readonly before: Record<string, unknown> | null;
  readonly after: Record<string, unknown> | null;
  readonly diff: readonly string[];
  readonly valid: boolean;
  readonly dryRun: boolean;
  readonly requiresConfirmation: boolean;
  readonly encryptionChanged: boolean;
  readonly requiresSecondReview: boolean;
  readonly encryptionApproval: LabelEncryptionApproval | null;
}

export interface PurviewLabelChangeResult {
  readonly success: boolean;
  readonly plan: PurviewLabelChangePlan;
  readonly jobId: string;
  readonly changeId: string;
  readonly auditEventId?: string;
}

export interface PurviewSitChangePlan {
  readonly action: PurviewSitChangeAction;
  readonly sitId: string;
  readonly sitName: string;
  readonly before: Record<string, unknown> | null;
  readonly after: Record<string, unknown> | null;
  readonly diff: readonly string[];
  readonly valid: boolean;
  readonly dryRun: boolean;
  readonly requiresConfirmation: boolean;
}

export interface PurviewSitChangeResult {
  readonly success: boolean;
  readonly plan: PurviewSitChangePlan;
  readonly jobId: string;
  readonly changeId: string;
  readonly auditEventId?: string;
}

function unauthenticatedError(): AppError {
  return new AppError(PURVIEW_LABELS_UNAUTHENTICATED, "authentication required", 401);
}

function validationError(message: string, field: string, reason = "invalid"): AppError {
  return new AppError(ErrorCodes.validationFailed, message, 400, [{ field, reason }]);
}

function requireCaller(
  resolveCaller: (ctx: RequestContext) => PurviewLabelsCaller | undefined,
  ctx: RequestContext,
): PurviewLabelsCaller {
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

async function requirePurviewRead(
  options: PurviewLabelsRouteOptions,
  caller: PurviewLabelsCaller,
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
  options: PurviewLabelsRouteOptions,
  caller: PurviewLabelsCaller,
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

function optionalInteger(value: unknown, field: string): number | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "number" || !Number.isInteger(value)) {
    throw validationError(`Field '${field}' must be an integer`, field);
  }
  return value;
}

function parseEncryption(value: unknown, field: string): LabelEncryptionSettings | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "object" || Array.isArray(value)) {
    throw validationError(`Field '${field}' must be an object`, field);
  }
  const record = value as Record<string, unknown>;
  return {
    ...(record["enabled"] !== undefined
      ? { enabled: optionalBoolean(record["enabled"], `${field}.enabled`) }
      : {}),
    ...(record["protectionType"] !== undefined
      ? { protectionType: optionalString(record["protectionType"], `${field}.protectionType`) ?? null }
      : {}),
    ...(record["templateId"] !== undefined
      ? { templateId: optionalString(record["templateId"], `${field}.templateId`) ?? null }
      : {}),
    ...(record["rights"] !== undefined
      ? { rights: optionalStringArray(record["rights"], `${field}.rights`) }
      : {}),
    ...(record["contentExpiration"] !== undefined
      ? {
          contentExpiration:
            optionalString(record["contentExpiration"], `${field}.contentExpiration`) ?? null,
        }
      : {}),
    ...(record["offlineAccess"] !== undefined
      ? { offlineAccess: optionalBoolean(record["offlineAccess"], `${field}.offlineAccess`) }
      : {}),
  };
}

function parseApproval(value: unknown, fallbackAt: string): LabelEncryptionApproval | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "object" || Array.isArray(value)) {
    throw validationError("Field 'encryptionApproval' must be an object", "encryptionApproval");
  }
  const record = value as Record<string, unknown>;
  const reviewerId = optionalString(record["reviewerId"], "encryptionApproval.reviewerId");
  if (!reviewerId) {
    throw validationError(
      "encryptionApproval.reviewerId is required",
      "encryptionApproval.reviewerId",
      "required",
    );
  }
  const reason = optionalString(record["reason"], "encryptionApproval.reason");
  return {
    reviewerId,
    approvedAt: optionalString(record["approvedAt"], "encryptionApproval.approvedAt") ?? fallbackAt,
    ...(reason !== undefined ? { reason } : {}),
  };
}

function rejectPublishingFieldsOnCreate(body: Record<string, unknown>): void {
  for (const field of ["publishingPolicyId", "publishingPolicyName", "publish"] as const) {
    if (body[field] !== undefined) {
      throw new AppError(
        PURVIEW_LABEL_PUBLISH_SEPARATE,
        "assigning a publishing policy is a separate operation; create the label first and call POST .../labels/{labelId}/publish",
        400,
        [{ field, reason: "separate_operation" }],
      );
    }
  }
}

function requireConfirmation(
  action: PurviewLabelChangeAction | PurviewSitChangeAction,
  body: Record<string, unknown>,
): void {
  if (action !== "delete") return;
  const confirm = optionalBoolean(body["confirm"], "confirm") ?? false;
  if (!confirm) {
    throw validationError(
      "deleting is compliance-impacting and requires confirmation",
      "confirm",
      "required",
    );
  }
}

function labelState(label: SensitivityLabel): Record<string, unknown> {
  return {
    name: label.name,
    scope: [...label.scope],
    priority: label.priority,
    encryption: label.encryption ?? null,
    marking: [...label.marking],
    state: label.state,
    publishingPolicies: [...(label.publishingPolicies ?? [])],
  };
}

function sitState(sit: SensitiveInfoType): Record<string, unknown> {
  return {
    name: sit.name,
    type: sit.type,
    patternConfidence: sit.patternConfidence,
    basedOn: sit.basedOn,
  };
}

function withApproval(
  before: Record<string, unknown> | null,
  after: Record<string, unknown> | null,
  approval: LabelEncryptionApproval | null,
): { before: Record<string, unknown> | null; after: Record<string, unknown> | null } {
  if (approval === null) return { before, after };
  if (after !== null) return { before, after: { ...after, encryptionApproval: approval } };
  if (before !== null) return { before: { ...before, encryptionApproval: approval }, after };
  return { before, after: { encryptionApproval: approval } };
}

function buildLabelChangePlan(
  action: PurviewLabelChangeAction,
  labelId: string,
  labelName: string,
  before: Record<string, unknown> | null,
  after: Record<string, unknown> | null,
  review: LabelEncryptionReview,
): PurviewLabelChangePlan {
  const diff: string[] = [];
  const name = String(before?.["name"] ?? after?.["name"] ?? labelName);
  if (action === "create") {
    diff.push(`Create sensitivity label '${name}'`);
  } else if (action === "delete") {
    diff.push(`Delete sensitivity label '${name}'`);
  } else if (action === "publish") {
    diff.push(`Assign a publishing policy to sensitivity label '${name}'`);
  } else {
    if (before?.["name"] !== after?.["name"]) {
      diff.push(`Rename sensitivity label from '${before?.["name"] ?? ""}' to '${after?.["name"] ?? ""}'`);
    }
    if (JSON.stringify(before?.["encryption"] ?? null) !== JSON.stringify(after?.["encryption"] ?? null)) {
      diff.push(`Change encryption settings for sensitivity label '${name}'`);
    }
    if (JSON.stringify(before?.["scope"] ?? []) !== JSON.stringify(after?.["scope"] ?? [])) {
      diff.push(`Change the scope of sensitivity label '${name}'`);
    }
    if (before?.["priority"] !== after?.["priority"]) {
      diff.push(`Change the priority of sensitivity label '${name}'`);
    }
    if (JSON.stringify(before?.["marking"] ?? []) !== JSON.stringify(after?.["marking"] ?? [])) {
      diff.push(`Change the marking of sensitivity label '${name}'`);
    }
    if (before?.["state"] !== after?.["state"]) {
      diff.push(`Change the state of sensitivity label '${name}'`);
    }
  }

  return {
    action,
    labelId,
    labelName: name,
    before,
    after,
    diff,
    valid: true,
    dryRun: false,
    requiresConfirmation: action === "delete",
    encryptionChanged: review.encryptionChanged,
    requiresSecondReview: review.requiresSecondReview,
    encryptionApproval: review.approval,
  };
}

function buildSitChangePlan(
  action: PurviewSitChangeAction,
  sitId: string,
  sitName: string,
  before: Record<string, unknown> | null,
  after: Record<string, unknown> | null,
): PurviewSitChangePlan {
  const diff: string[] = [];
  const name = String(before?.["name"] ?? after?.["name"] ?? sitName);
  if (action === "create") {
    diff.push(`Create sensitive information type '${name}'`);
  } else if (action === "delete") {
    diff.push(`Delete sensitive information type '${name}'`);
  } else {
    if (before?.["name"] !== after?.["name"]) {
      diff.push(`Rename sensitive information type from '${before?.["name"] ?? ""}' to '${after?.["name"] ?? ""}'`);
    }
    if (before?.["patternConfidence"] !== after?.["patternConfidence"]) {
      diff.push(`Change the pattern confidence of sensitive information type '${name}'`);
    }
    if (before?.["basedOn"] !== after?.["basedOn"]) {
      diff.push(`Change the base type of sensitive information type '${name}'`);
    }
  }

  return {
    action,
    sitId,
    sitName: name,
    before,
    after,
    diff,
    valid: true,
    dryRun: false,
    requiresConfirmation: action === "delete",
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

function auditActionFor(area: "label" | "sit", action: string): string {
  return `${area}.policy.${action}`;
}

function actorOf(caller: PurviewLabelsCaller): string {
  return caller.userId ?? "unknown";
}

async function recordChange(
  options: PurviewLabelsRouteOptions,
  ctx: RequestContext,
  input: {
    tenantId: string;
    area: "label" | "sit";
    policyId: string;
    actor: string;
    createdAt: string;
    before: Record<string, unknown> | null;
    after: Record<string, unknown> | null;
    action: string;
  },
): Promise<CompliancePolicyChange> {
  const change = await options.repository.recordPolicyChange({
    tenantId: input.tenantId,
    area: input.area,
    policyId: input.policyId,
    at: input.createdAt,
    by: input.actor,
    before: input.before,
    after: input.after,
  });
  if (options.recordAudit) {
    await options.recordAudit({
      action: auditActionFor(input.area, input.action),
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

export function createPurviewLabelRoutes(options: PurviewLabelsRouteOptions): Route[] {
  const idGenerator = options.idGenerator ?? (() => randomUUID());
  const now = options.now ?? (() => new Date().toISOString());

  async function handleListLabels(ctx: RequestContext): Promise<RouteResponse> {
    const caller = requireCaller(options.resolveCaller, ctx);
    const tenantId = requireParam(ctx, "tenantId");
    requireTenantInScope(caller, tenantId);
    await requirePurviewRead(options, caller);

    const query = ctx.query;
    const filter: PurviewLabelFilter = {
      ...(query.get("search") ? { search: query.get("search")! } : {}),
      ...(query.get("state") ? { state: query.get("state")! } : {}),
      limit: parsePagination(query).limit,
      ...(query.get("cursor") ? { cursor: query.get("cursor")! } : {}),
    };
    const page = await options.provider.listLabels(tenantId, filter);
    return {
      status: 200,
      headers: { "content-type": "application/json" },
      body: {
        tenantId,
        kind: "labels",
        items: page.items,
        nextCursor: page.nextCursor,
        totalCount: page.totalCount,
      },
    };
  }

  async function handleGetLabel(ctx: RequestContext): Promise<RouteResponse> {
    const caller = requireCaller(options.resolveCaller, ctx);
    const tenantId = requireParam(ctx, "tenantId");
    const labelId = requireParam(ctx, "labelId");
    requireTenantInScope(caller, tenantId);
    await requirePurviewRead(options, caller);

    const label = await options.provider.getLabel(tenantId, labelId);
    if (!label) {
      throw new AppError(PURVIEW_LABEL_NOT_FOUND, `sensitivity label ${labelId} not found`, 404);
    }
    return {
      status: 200,
      headers: { "content-type": "application/json" },
      body: { tenantId, label },
    };
  }

  async function handleCreateLabel(ctx: RequestContext): Promise<RouteResponse> {
    const caller = requireCaller(options.resolveCaller, ctx);
    const tenantId = requireParam(ctx, "tenantId");
    requireTenantInScope(caller, tenantId);
    await requirePurviewWrite(options, caller);

    const body = readBodyRecord(ctx);
    rejectPublishingFieldsOnCreate(body);
    const name = optionalString(body["name"], "name");
    if (!name || name.trim().length === 0) {
      throw validationError("name is required", "name", "required");
    }
    requireConfirmation("create", body);

    const encryption = parseEncryption(body["encryption"], "encryption");
    const createdAt = now();
    const actor = actorOf(caller);
    const approval = parseApproval(body["encryptionApproval"], createdAt);
    const review = assertLabelEncryptionReview({
      action: "create",
      requesterId: actor,
      before: null,
      after: encryption ?? null,
      approval: approval ?? null,
    });

    const after: Record<string, unknown> = {
      name: name.trim(),
      ...(body["scope"] !== undefined ? { scope: [...(optionalStringArray(body["scope"], "scope") ?? [])] } : {}),
      ...(body["priority"] !== undefined ? { priority: optionalInteger(body["priority"], "priority") } : {}),
      encryption: encryption ?? null,
      ...(body["marking"] !== undefined ? { marking: [...(optionalStringArray(body["marking"], "marking") ?? [])] } : {}),
      ...(body["enabled"] !== undefined ? { enabled: optionalBoolean(body["enabled"], "enabled") } : {}),
    };

    const recorded = withApproval(null, after, review.approval);
    const plan = buildLabelChangePlan("create", "", name.trim(), recorded.before, recorded.after, review);
    const jobId = idGenerator();
    const requestId = idGenerator();

    await options.queue.enqueue(
      buildRemediationEnvelope(ctx, tenantId, jobId, requestId, createdAt, {
        area: "label",
        action: "create",
        policyName: name.trim(),
        ...(review.approval !== null ? { encryptionApproval: review.approval } : {}),
        actor,
      }),
    );

    const change = await recordChange(options, ctx, {
      tenantId,
      area: "label",
      policyId: "",
      actor,
      createdAt,
      before: recorded.before,
      after: recorded.after,
      action: "create",
    });

    const result: PurviewLabelChangeResult = {
      success: true,
      plan,
      jobId,
      changeId: change.id,
    };
    return { status: 202, headers: { "content-type": "application/json" }, body: result };
  }

  async function handleEditLabel(ctx: RequestContext): Promise<RouteResponse> {
    const caller = requireCaller(options.resolveCaller, ctx);
    const tenantId = requireParam(ctx, "tenantId");
    const labelId = requireParam(ctx, "labelId");
    requireTenantInScope(caller, tenantId);
    await requirePurviewWrite(options, caller);

    const body = readBodyRecord(ctx);
    const existing = await options.provider.getLabel(tenantId, labelId);
    if (!existing) {
      throw new AppError(PURVIEW_LABEL_NOT_FOUND, `sensitivity label ${labelId} not found`, 404);
    }

    const name = optionalString(body["name"], "name");
    const scope = optionalStringArray(body["scope"], "scope");
    const priority = optionalInteger(body["priority"], "priority");
    const encryption = parseEncryption(body["encryption"], "encryption");
    const marking = optionalStringArray(body["marking"], "marking");
    const enabled = optionalBoolean(body["enabled"], "enabled");
    if (
      name === undefined &&
      scope === undefined &&
      priority === undefined &&
      encryption === undefined &&
      marking === undefined &&
      enabled === undefined
    ) {
      throw validationError(
        "at least one of name, scope, priority, encryption, marking, or enabled is required",
        "body",
      );
    }

    const before = labelState(existing);
    const after: Record<string, unknown> = {
      ...before,
      ...(name !== undefined ? { name: name.trim() } : {}),
      ...(scope !== undefined ? { scope: [...scope] } : {}),
      ...(priority !== undefined ? { priority } : {}),
      ...(encryption !== undefined ? { encryption } : {}),
      ...(marking !== undefined ? { marking: [...marking] } : {}),
      ...(enabled !== undefined ? { state: enabled ? "enabled" : "disabled" } : {}),
    };

    const createdAt = now();
    const actor = actorOf(caller);
    const approval = parseApproval(body["encryptionApproval"], createdAt);
    const review = assertLabelEncryptionReview({
      action: "edit",
      requesterId: actor,
      before: existing.encryption,
      after: (after["encryption"] as LabelEncryptionSettings | null) ?? null,
      approval: approval ?? null,
    });

    const recorded = withApproval(before, after, review.approval);
    const plan = buildLabelChangePlan("edit", labelId, existing.name, recorded.before, recorded.after, review);
    const jobId = idGenerator();
    const requestId = idGenerator();

    await options.queue.enqueue(
      buildRemediationEnvelope(ctx, tenantId, jobId, requestId, createdAt, {
        area: "label",
        action: "edit",
        policyId: labelId,
        policyName: existing.name,
        ...(review.approval !== null ? { encryptionApproval: review.approval } : {}),
        actor,
      }),
    );

    const change = await recordChange(options, ctx, {
      tenantId,
      area: "label",
      policyId: labelId,
      actor,
      createdAt,
      before: recorded.before,
      after: recorded.after,
      action: "edit",
    });

    const result: PurviewLabelChangeResult = {
      success: true,
      plan,
      jobId,
      changeId: change.id,
    };
    return { status: 202, headers: { "content-type": "application/json" }, body: result };
  }

  async function handleDeleteLabel(ctx: RequestContext): Promise<RouteResponse> {
    const caller = requireCaller(options.resolveCaller, ctx);
    const tenantId = requireParam(ctx, "tenantId");
    const labelId = requireParam(ctx, "labelId");
    requireTenantInScope(caller, tenantId);
    await requirePurviewWrite(options, caller);

    const body = readBodyRecord(ctx);
    requireConfirmation("delete", body);

    const existing = await options.provider.getLabel(tenantId, labelId);
    if (!existing) {
      throw new AppError(PURVIEW_LABEL_NOT_FOUND, `sensitivity label ${labelId} not found`, 404);
    }

    const createdAt = now();
    const actor = actorOf(caller);
    const approval = parseApproval(body["encryptionApproval"], createdAt);
    const review = assertLabelEncryptionReview({
      action: "delete",
      requesterId: actor,
      before: existing.encryption,
      after: null,
      approval: approval ?? null,
    });

    const recorded = withApproval(labelState(existing), null, review.approval);
    const plan = buildLabelChangePlan("delete", labelId, existing.name, recorded.before, recorded.after, review);
    const jobId = idGenerator();
    const requestId = idGenerator();

    await options.queue.enqueue(
      buildRemediationEnvelope(ctx, tenantId, jobId, requestId, createdAt, {
        area: "label",
        action: "delete",
        policyId: labelId,
        policyName: existing.name,
        ...(review.approval !== null ? { encryptionApproval: review.approval } : {}),
        actor,
      }),
    );

    const change = await recordChange(options, ctx, {
      tenantId,
      area: "label",
      policyId: labelId,
      actor,
      createdAt,
      before: recorded.before,
      after: recorded.after,
      action: "delete",
    });

    const result: PurviewLabelChangeResult = {
      success: true,
      plan,
      jobId,
      changeId: change.id,
    };
    return { status: 202, headers: { "content-type": "application/json" }, body: result };
  }

  async function handlePublishLabel(ctx: RequestContext): Promise<RouteResponse> {
    const caller = requireCaller(options.resolveCaller, ctx);
    const tenantId = requireParam(ctx, "tenantId");
    const labelId = requireParam(ctx, "labelId");
    requireTenantInScope(caller, tenantId);
    await requirePurviewWrite(options, caller);

    const body = readBodyRecord(ctx);
    const policyId = optionalString(body["publishingPolicyId"], "publishingPolicyId");
    const policyName = optionalString(body["publishingPolicyName"], "publishingPolicyName");
    if (!policyId && !policyName) {
      throw validationError(
        "publishingPolicyId or publishingPolicyName is required",
        "publishingPolicyId",
        "required",
      );
    }
    requireConfirmation("publish", body);

    const existing = await options.provider.getLabel(tenantId, labelId);
    if (!existing) {
      throw new AppError(PURVIEW_LABEL_NOT_FOUND, `sensitivity label ${labelId} not found`, 404);
    }

    const currentPolicies = existing.publishingPolicies ?? [];
    const policy = policyName ?? policyId!;
    const nextPolicies = currentPolicies.includes(policy)
      ? [...currentPolicies]
      : [...currentPolicies, policy];
    const before: Record<string, unknown> = { publishingPolicies: [...currentPolicies] };
    const after: Record<string, unknown> = { publishingPolicies: nextPolicies };

    const review = assertLabelEncryptionReview({
      action: "publish",
      requesterId: actorOf(caller),
      before: existing.encryption,
      after: existing.encryption,
      approval: null,
    });
    const plan = buildLabelChangePlan("publish", labelId, existing.name, before, after, review);
    const createdAt = now();
    const actor = actorOf(caller);
    const jobId = idGenerator();
    const requestId = idGenerator();

    await options.queue.enqueue(
      buildRemediationEnvelope(ctx, tenantId, jobId, requestId, createdAt, {
        area: "label",
        action: "publish",
        policyId: labelId,
        policyName: existing.name,
        publishingPolicyId: policyId ?? "",
        publishingPolicyName: policyName ?? "",
        actor,
      }),
    );

    const change = await recordChange(options, ctx, {
      tenantId,
      area: "label",
      policyId: labelId,
      actor,
      createdAt,
      before,
      after,
      action: "publish",
    });

    const result: PurviewLabelChangeResult = {
      success: true,
      plan,
      jobId,
      changeId: change.id,
    };
    return { status: 202, headers: { "content-type": "application/json" }, body: result };
  }

  async function handleListSits(ctx: RequestContext): Promise<RouteResponse> {
    const caller = requireCaller(options.resolveCaller, ctx);
    const tenantId = requireParam(ctx, "tenantId");
    requireTenantInScope(caller, tenantId);
    await requirePurviewRead(options, caller);

    const query = ctx.query;
    const filter: PurviewSitFilter = {
      ...(query.get("search") ? { search: query.get("search")! } : {}),
      ...(query.get("type") ? { type: query.get("type")! } : {}),
      limit: parsePagination(query).limit,
      ...(query.get("cursor") ? { cursor: query.get("cursor")! } : {}),
    };
    const page = await options.provider.listSits(tenantId, filter);
    return {
      status: 200,
      headers: { "content-type": "application/json" },
      body: {
        tenantId,
        kind: "sits",
        items: page.items,
        nextCursor: page.nextCursor,
        totalCount: page.totalCount,
      },
    };
  }

  async function handleGetSit(ctx: RequestContext): Promise<RouteResponse> {
    const caller = requireCaller(options.resolveCaller, ctx);
    const tenantId = requireParam(ctx, "tenantId");
    const sitId = requireParam(ctx, "sitId");
    requireTenantInScope(caller, tenantId);
    await requirePurviewRead(options, caller);

    const sit = await options.provider.getSit(tenantId, sitId);
    if (!sit) {
      throw new AppError(PURVIEW_SIT_NOT_FOUND, `sensitive information type ${sitId} not found`, 404);
    }
    return {
      status: 200,
      headers: { "content-type": "application/json" },
      body: { tenantId, sit },
    };
  }

  async function handleCreateSit(ctx: RequestContext): Promise<RouteResponse> {
    const caller = requireCaller(options.resolveCaller, ctx);
    const tenantId = requireParam(ctx, "tenantId");
    requireTenantInScope(caller, tenantId);
    await requirePurviewWrite(options, caller);

    const body = readBodyRecord(ctx);
    const name = optionalString(body["name"], "name");
    if (!name || name.trim().length === 0) {
      throw validationError("name is required", "name", "required");
    }
    requireConfirmation("create", body);

    const after: Record<string, unknown> = {
      name: name.trim(),
      type: "custom",
      ...(body["patternConfidence"] !== undefined
        ? { patternConfidence: optionalString(body["patternConfidence"], "patternConfidence") ?? null }
        : {}),
      ...(body["basedOn"] !== undefined
        ? { basedOn: optionalString(body["basedOn"], "basedOn") ?? null }
        : {}),
    };

    const plan = buildSitChangePlan("create", "", name.trim(), null, after);
    const createdAt = now();
    const actor = actorOf(caller);
    const jobId = idGenerator();
    const requestId = idGenerator();

    await options.queue.enqueue(
      buildRemediationEnvelope(ctx, tenantId, jobId, requestId, createdAt, {
        area: "sit",
        action: "create",
        policyName: name.trim(),
        actor,
      }),
    );

    const change = await recordChange(options, ctx, {
      tenantId,
      area: "sit",
      policyId: "",
      actor,
      createdAt,
      before: null,
      after,
      action: "create",
    });

    const result: PurviewSitChangeResult = { success: true, plan, jobId, changeId: change.id };
    return { status: 202, headers: { "content-type": "application/json" }, body: result };
  }

  async function handleEditSit(ctx: RequestContext): Promise<RouteResponse> {
    const caller = requireCaller(options.resolveCaller, ctx);
    const tenantId = requireParam(ctx, "tenantId");
    const sitId = requireParam(ctx, "sitId");
    requireTenantInScope(caller, tenantId);
    await requirePurviewWrite(options, caller);

    const body = readBodyRecord(ctx);
    const existing = await options.provider.getSit(tenantId, sitId);
    if (!existing) {
      throw new AppError(PURVIEW_SIT_NOT_FOUND, `sensitive information type ${sitId} not found`, 404);
    }
    if (existing.type !== "custom") {
      throw new AppError(
        PURVIEW_SIT_BUILTIN_READONLY,
        "built-in sensitive information types cannot be edited; clone to a custom type first",
        409,
      );
    }

    const name = optionalString(body["name"], "name");
    const patternConfidence = optionalString(body["patternConfidence"], "patternConfidence");
    const basedOn = optionalString(body["basedOn"], "basedOn");
    if (name === undefined && patternConfidence === undefined && basedOn === undefined) {
      throw validationError(
        "at least one of name, patternConfidence, or basedOn is required",
        "body",
      );
    }

    const before = sitState(existing);
    const after: Record<string, unknown> = {
      ...before,
      ...(name !== undefined ? { name: name.trim() } : {}),
      ...(patternConfidence !== undefined ? { patternConfidence } : {}),
      ...(basedOn !== undefined ? { basedOn } : {}),
    };

    const plan = buildSitChangePlan("edit", sitId, existing.name, before, after);
    const createdAt = now();
    const actor = actorOf(caller);
    const jobId = idGenerator();
    const requestId = idGenerator();

    await options.queue.enqueue(
      buildRemediationEnvelope(ctx, tenantId, jobId, requestId, createdAt, {
        area: "sit",
        action: "edit",
        policyId: sitId,
        policyName: existing.name,
        actor,
      }),
    );

    const change = await recordChange(options, ctx, {
      tenantId,
      area: "sit",
      policyId: sitId,
      actor,
      createdAt,
      before,
      after,
      action: "edit",
    });

    const result: PurviewSitChangeResult = { success: true, plan, jobId, changeId: change.id };
    return { status: 202, headers: { "content-type": "application/json" }, body: result };
  }

  async function handleDeleteSit(ctx: RequestContext): Promise<RouteResponse> {
    const caller = requireCaller(options.resolveCaller, ctx);
    const tenantId = requireParam(ctx, "tenantId");
    const sitId = requireParam(ctx, "sitId");
    requireTenantInScope(caller, tenantId);
    await requirePurviewWrite(options, caller);

    const body = readBodyRecord(ctx);
    requireConfirmation("delete", body);

    const existing = await options.provider.getSit(tenantId, sitId);
    if (!existing) {
      throw new AppError(PURVIEW_SIT_NOT_FOUND, `sensitive information type ${sitId} not found`, 404);
    }
    if (existing.type !== "custom") {
      throw new AppError(
        PURVIEW_SIT_BUILTIN_READONLY,
        "built-in sensitive information types cannot be deleted",
        409,
      );
    }

    const before = sitState(existing);
    const plan = buildSitChangePlan("delete", sitId, existing.name, before, null);
    const createdAt = now();
    const actor = actorOf(caller);
    const jobId = idGenerator();
    const requestId = idGenerator();

    await options.queue.enqueue(
      buildRemediationEnvelope(ctx, tenantId, jobId, requestId, createdAt, {
        area: "sit",
        action: "delete",
        policyId: sitId,
        policyName: existing.name,
        actor,
      }),
    );

    const change = await recordChange(options, ctx, {
      tenantId,
      area: "sit",
      policyId: sitId,
      actor,
      createdAt,
      before,
      after: null,
      action: "delete",
    });

    const result: PurviewSitChangeResult = { success: true, plan, jobId, changeId: change.id };
    return { status: 202, headers: { "content-type": "application/json" }, body: result };
  }

  return [
    { method: "GET", path: PURVIEW_LABELS_PATH, handler: handleListLabels },
    { method: "POST", path: PURVIEW_LABELS_PATH, handler: handleCreateLabel },
    { method: "GET", path: PURVIEW_LABEL_ITEM_PATH, handler: handleGetLabel },
    { method: "PATCH", path: PURVIEW_LABEL_ITEM_PATH, handler: handleEditLabel },
    { method: "DELETE", path: PURVIEW_LABEL_ITEM_PATH, handler: handleDeleteLabel },
    { method: "POST", path: PURVIEW_LABEL_PUBLISH_PATH, handler: handlePublishLabel },
    { method: "GET", path: PURVIEW_SITS_PATH, handler: handleListSits },
    { method: "POST", path: PURVIEW_SITS_PATH, handler: handleCreateSit },
    { method: "GET", path: PURVIEW_SIT_ITEM_PATH, handler: handleGetSit },
    { method: "PATCH", path: PURVIEW_SIT_ITEM_PATH, handler: handleEditSit },
    { method: "DELETE", path: PURVIEW_SIT_ITEM_PATH, handler: handleDeleteSit },
  ];
}

export const PURVIEW_LABELS_OPENAPI = {
  paths: {
    "/tenants/{tenantId}/purview/labels": {
      get: {
        operationId: "listPurviewSensitivityLabels",
        summary: "List sensitivity labels live from Purview (name, scope, priority, encryption, marking, state)",
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
          "200": { description: "The live sensitivity labels." },
          "401": { description: "Authentication required." },
          "403": { description: "The caller lacks purview.read or the tenant is out of scope." },
        },
      },
      post: {
        operationId: "createPurviewSensitivityLabel",
        summary: "Create a sensitivity label (applies through the EPIC-006 gated path; publishing is separate)",
        permission: PURVIEW_WRITE_PERMISSION,
        security: [{ bearerAuth: [] }],
        parameters: [{ name: "tenantId", in: "path", required: true, schema: { type: "string" } }],
        responses: {
          "202": { description: "The create was queued through the EPIC-006 gated path." },
          "400": { description: "name failed validation, or publishing-policy fields were supplied." },
          "401": { description: "Authentication required." },
          "403": { description: "The caller lacks purview.write or the tenant is out of scope." },
          "409": { description: "An encryption change needs a distinct second reviewer's approval." },
        },
      },
    },
    "/tenants/{tenantId}/purview/labels/{labelId}": {
      get: {
        operationId: "getPurviewSensitivityLabel",
        summary: "Get one sensitivity label live from Purview",
        permission: PURVIEW_READ_PERMISSION,
        security: [{ bearerAuth: [] }],
        parameters: [
          { name: "tenantId", in: "path", required: true, schema: { type: "string" } },
          { name: "labelId", in: "path", required: true, schema: { type: "string" } },
        ],
        responses: {
          "200": { description: "The live sensitivity label." },
          "401": { description: "Authentication required." },
          "403": { description: "The caller lacks purview.read or the tenant is out of scope." },
          "404": { description: "Sensitivity label not found." },
        },
      },
      patch: {
        operationId: "editPurviewSensitivityLabel",
        summary: "Edit a sensitivity label (encryption changes require a distinct second reviewer)",
        permission: PURVIEW_WRITE_PERMISSION,
        security: [{ bearerAuth: [] }],
        parameters: [
          { name: "tenantId", in: "path", required: true, schema: { type: "string" } },
          { name: "labelId", in: "path", required: true, schema: { type: "string" } },
        ],
        responses: {
          "202": { description: "The edit was queued through the EPIC-006 gated path." },
          "400": { description: "No editable field was supplied." },
          "401": { description: "Authentication required." },
          "403": { description: "The caller lacks purview.write or the tenant is out of scope." },
          "404": { description: "Sensitivity label not found." },
          "409": { description: "An encryption change needs a distinct second reviewer's approval." },
        },
      },
      delete: {
        operationId: "deletePurviewSensitivityLabel",
        summary: "Delete a sensitivity label (compliance-impacting; requires confirmation; encryption changes need review)",
        permission: PURVIEW_WRITE_PERMISSION,
        security: [{ bearerAuth: [] }],
        parameters: [
          { name: "tenantId", in: "path", required: true, schema: { type: "string" } },
          { name: "labelId", in: "path", required: true, schema: { type: "string" } },
        ],
        responses: {
          "202": { description: "The delete was queued through the EPIC-006 gated path." },
          "400": { description: "confirm is required to delete a sensitivity label." },
          "401": { description: "Authentication required." },
          "403": { description: "The caller lacks purview.write or the tenant is out of scope." },
          "404": { description: "Sensitivity label not found." },
          "409": { description: "Deleting an encrypted label needs a distinct second reviewer's approval." },
        },
      },
    },
    "/tenants/{tenantId}/purview/labels/{labelId}/publish": {
      post: {
        operationId: "publishPurviewSensitivityLabel",
        summary: "Assign a publishing policy to a sensitivity label (separate from creation)",
        permission: PURVIEW_WRITE_PERMISSION,
        security: [{ bearerAuth: [] }],
        parameters: [
          { name: "tenantId", in: "path", required: true, schema: { type: "string" } },
          { name: "labelId", in: "path", required: true, schema: { type: "string" } },
        ],
        responses: {
          "202": { description: "The publishing-policy assignment was queued through the EPIC-006 gated path." },
          "400": { description: "A publishing policy was not supplied." },
          "401": { description: "Authentication required." },
          "403": { description: "The caller lacks purview.write or the tenant is out of scope." },
          "404": { description: "Sensitivity label not found." },
        },
      },
    },
    "/tenants/{tenantId}/purview/sits": {
      get: {
        operationId: "listPurviewSensitiveInfoTypes",
        summary: "List sensitive information types live from Purview (name, type, pattern confidence, based on)",
        permission: PURVIEW_READ_PERMISSION,
        security: [{ bearerAuth: [] }],
        parameters: [
          { name: "tenantId", in: "path", required: true, schema: { type: "string" } },
          { name: "search", in: "query", required: false, schema: { type: "string" } },
          { name: "type", in: "query", required: false, schema: { type: "string", enum: ["builtin", "custom"] } },
          { name: "limit", in: "query", required: false, schema: { type: "integer" } },
          { name: "cursor", in: "query", required: false, schema: { type: "string" } },
        ],
        responses: {
          "200": { description: "The live sensitive information types." },
          "401": { description: "Authentication required." },
          "403": { description: "The caller lacks purview.read or the tenant is out of scope." },
        },
      },
      post: {
        operationId: "createPurviewSensitiveInfoType",
        summary: "Create a custom sensitive information type (applies through the EPIC-006 gated path)",
        permission: PURVIEW_WRITE_PERMISSION,
        security: [{ bearerAuth: [] }],
        parameters: [{ name: "tenantId", in: "path", required: true, schema: { type: "string" } }],
        responses: {
          "202": { description: "The create was queued through the EPIC-006 gated path." },
          "400": { description: "name failed validation." },
          "401": { description: "Authentication required." },
          "403": { description: "The caller lacks purview.write or the tenant is out of scope." },
        },
      },
    },
    "/tenants/{tenantId}/purview/sits/{sitId}": {
      get: {
        operationId: "getPurviewSensitiveInfoType",
        summary: "Get one sensitive information type live from Purview",
        permission: PURVIEW_READ_PERMISSION,
        security: [{ bearerAuth: [] }],
        parameters: [
          { name: "tenantId", in: "path", required: true, schema: { type: "string" } },
          { name: "sitId", in: "path", required: true, schema: { type: "string" } },
        ],
        responses: {
          "200": { description: "The live sensitive information type." },
          "401": { description: "Authentication required." },
          "403": { description: "The caller lacks purview.read or the tenant is out of scope." },
          "404": { description: "Sensitive information type not found." },
        },
      },
      patch: {
        operationId: "editPurviewSensitiveInfoType",
        summary: "Edit a custom sensitive information type (applies through the EPIC-006 gated path)",
        permission: PURVIEW_WRITE_PERMISSION,
        security: [{ bearerAuth: [] }],
        parameters: [
          { name: "tenantId", in: "path", required: true, schema: { type: "string" } },
          { name: "sitId", in: "path", required: true, schema: { type: "string" } },
        ],
        responses: {
          "202": { description: "The edit was queued through the EPIC-006 gated path." },
          "400": { description: "No editable field was supplied." },
          "401": { description: "Authentication required." },
          "403": { description: "The caller lacks purview.write or the tenant is out of scope." },
          "404": { description: "Sensitive information type not found." },
          "409": { description: "Built-in sensitive information types cannot be edited." },
        },
      },
      delete: {
        operationId: "deletePurviewSensitiveInfoType",
        summary: "Delete a custom sensitive information type (requires confirmation)",
        permission: PURVIEW_WRITE_PERMISSION,
        security: [{ bearerAuth: [] }],
        parameters: [
          { name: "tenantId", in: "path", required: true, schema: { type: "string" } },
          { name: "sitId", in: "path", required: true, schema: { type: "string" } },
        ],
        responses: {
          "202": { description: "The delete was queued through the EPIC-006 gated path." },
          "400": { description: "confirm is required to delete a sensitive information type." },
          "401": { description: "Authentication required." },
          "403": { description: "The caller lacks purview.write or the tenant is out of scope." },
          "404": { description: "Sensitive information type not found." },
          "409": { description: "Built-in sensitive information types cannot be deleted." },
        },
      },
    },
  },
} as const;
