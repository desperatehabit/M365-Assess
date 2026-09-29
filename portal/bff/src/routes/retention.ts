// Retention policies, tags, and assignment (EPIC-020 SPEC.md §2 US-7, §3.6,
// §4.4, §5, §6; T-0387). GET policy/tag reads are served live from EXO
// through the injected provider, which is backed by the worker queue (T-0010);
// this module holds no M365 SDK call and issues no tenant write on reads.
// Tag create/edit and per-mailbox plus bulk assignment run form → plan
// preview → apply through the EPIC-006 gated executor: `preview` (or
// ?preview=true) returns the worker plan listing the affected mailboxes with
// no tenant write, otherwise the worker applies with before/after capture and
// returns one AuditEvent per mailbox write, recorded by the app audit sink.
// Assignment rows persist through @m365-assess/db retention-repository.
import { AppError, ErrorCodes } from "../errors.js";
import { requireTenantInScope, type Caller } from "../rbac/authorize.js";
import type { RequestContext, Route, RouteResponse } from "../server.js";

export const RETENTION_POLICIES_PATH = "/v1/tenants/:tenantId/retention/policies";
export const RETENTION_TAGS_PATH = "/v1/tenants/:tenantId/retention/tags";
export const RETENTION_TAG_ITEM_PATH = "/v1/tenants/:tenantId/retention/tags/:tagId";
export const RETENTION_ASSIGN_PATH = "/v1/tenants/:tenantId/retention/assign";
export const RETENTION_ASSIGN_BULK_PATH = "/v1/tenants/:tenantId/retention/assign/bulk";

export const RETENTION_READ_PERMISSION = "mailboxes.read";
export const RETENTION_WRITE_PERMISSION = "mailboxes.write";
export const REMEDIATION_APPLY_PERMISSION = "Remediation.Apply";
export const RETENTION_UNAUTHENTICATED = "request.unauthenticated";
export const RETENTION_NOT_FOUND = "retention.not_found";

export const MAX_RETENTION_BULK_MAILBOXES = 200;
export const RETENTION_TAG_TYPES = ["delete", "keep", "archive", "personal"] as const;
export type RetentionTagType = (typeof RETENTION_TAG_TYPES)[number];

export interface RetentionPolicy {
  readonly id: string;
  readonly name: string;
  readonly enabled: boolean;
  readonly tags?: readonly string[];
  readonly retrievedAt?: string;
}

export interface RetentionTag {
  readonly id: string;
  readonly name: string;
  readonly type: string;
  readonly retentionDays: number | null;
  readonly retentionAction: string | null;
  readonly enabled: boolean;
  readonly retrievedAt?: string;
}

export interface RetentionTagPlan {
  readonly action: "create" | "edit";
  readonly tagId?: string;
  readonly targetName: string;
  readonly before?: Record<string, unknown> | null;
  readonly after?: Record<string, unknown> | null;
  readonly diff: readonly string[];
  readonly valid: boolean;
  readonly dryRun: boolean;
  readonly requiresConfirmation: boolean;
}

export interface RetentionTagAuditEvent {
  readonly id: string;
  readonly tenantId: string;
  readonly action: string;
  readonly targetId: string;
  readonly targetName: string;
  readonly timestamp: string;
  readonly before?: Record<string, unknown> | null;
  readonly after?: Record<string, unknown> | null;
}

export interface RetentionTagResult {
  readonly success: boolean;
  readonly plan: RetentionTagPlan;
  readonly result?: Record<string, unknown>;
  readonly auditEvent?: RetentionTagAuditEvent;
}

export interface CreateRetentionTagInput {
  readonly name: string;
  readonly type?: RetentionTagType;
  readonly retentionDays?: number;
  readonly retentionAction?: string;
  readonly preview?: boolean;
}

export interface EditRetentionTagInput {
  readonly name?: string;
  readonly retentionDays?: number;
  readonly retentionAction?: string;
  readonly enabled?: boolean;
  readonly preview?: boolean;
}

export interface RetentionAssignPlan {
  readonly action: "assign";
  readonly tagId: string;
  readonly affectedMailboxes: readonly string[];
  readonly before?: Record<string, unknown> | null;
  readonly after?: Record<string, unknown> | null;
  readonly diff: readonly string[];
  readonly valid: boolean;
  readonly dryRun: boolean;
  readonly requiresConfirmation: boolean;
}

export interface RetentionMailboxOperation {
  readonly id: string;
  readonly tenantId: string;
  readonly mailboxId: string;
  readonly operation: string;
  readonly before?: Record<string, unknown> | null;
  readonly after?: Record<string, unknown> | null;
  readonly state: string;
}

export interface RetentionAssignResult {
  readonly success: boolean;
  readonly noop?: boolean;
  readonly plan: RetentionAssignPlan;
  readonly result?: Record<string, unknown>;
  readonly mailboxOperation?: RetentionMailboxOperation;
  readonly auditEvent?: RetentionTagAuditEvent;
}

export interface RetentionAssignBulkPlan {
  readonly action: "assignBulk";
  readonly tagId: string;
  readonly affectedMailboxes: readonly string[];
  readonly diff: readonly string[];
  readonly valid: boolean;
  readonly dryRun: boolean;
  readonly requiresConfirmation: boolean;
}

export interface RetentionAssignBulkRowResult {
  readonly mailboxId: string;
  readonly status: "assigned" | "skipped" | "failed";
  readonly reason?: string;
  readonly before?: Record<string, unknown> | null;
  readonly after?: Record<string, unknown> | null;
}

export interface RetentionAssignBulkResult {
  readonly success: boolean;
  readonly plan: RetentionAssignBulkPlan;
  readonly results: readonly RetentionAssignBulkRowResult[];
  readonly mailboxOperations?: readonly RetentionMailboxOperation[];
  readonly auditEvents?: readonly RetentionTagAuditEvent[];
}

export interface AssignRetentionTagInput {
  readonly mailboxId: string;
  readonly tagId: string;
  readonly policyId?: string;
  readonly preview?: boolean;
  readonly confirm?: boolean;
}

export interface AssignRetentionTagBulkInput {
  readonly mailboxIds: readonly string[];
  readonly tagId: string;
  readonly policyId?: string;
  readonly preview?: boolean;
  readonly confirm?: boolean;
}

export interface RetentionProvider {
  listPolicies(tenantId: string): Promise<RetentionPolicy[]>;
  listTags(tenantId: string): Promise<RetentionTag[]>;
  createTag(
    tenantId: string,
    input: CreateRetentionTagInput,
    preview: boolean,
  ): Promise<RetentionTagResult | RetentionTagPlan>;
  editTag(
    tenantId: string,
    tagId: string,
    input: EditRetentionTagInput,
    preview: boolean,
  ): Promise<RetentionTagResult | RetentionTagPlan>;
  assignTag(
    tenantId: string,
    input: AssignRetentionTagInput,
    preview: boolean,
  ): Promise<RetentionAssignResult | RetentionAssignPlan>;
  assignTagBulk(
    tenantId: string,
    input: AssignRetentionTagBulkInput,
    preview: boolean,
  ): Promise<RetentionAssignBulkResult | RetentionAssignBulkPlan>;
}

export interface RetentionCaller extends Caller {
  readonly userId?: string;
}

export type RetentionAuthorizer = (
  caller: RetentionCaller,
  permission: string,
) => void | Promise<void>;

export interface RetentionRouteOptions {
  readonly provider: RetentionProvider;
  readonly resolveCaller: (ctx: RequestContext) => RetentionCaller | undefined;
  readonly authorize?: RetentionAuthorizer;
  readonly recordAudit?: (event: Record<string, unknown>) => Promise<void>;
}

function unauthenticatedError(): AppError {
  return new AppError(RETENTION_UNAUTHENTICATED, "authentication required", 401);
}

function validationError(message: string, field: string): AppError {
  return new AppError(ErrorCodes.validationFailed, message, 400, [
    { field, reason: "invalid" },
  ]);
}

function requireCaller(
  resolveCaller: (ctx: RequestContext) => RetentionCaller | undefined,
  ctx: RequestContext,
): RetentionCaller {
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

function requireTagParam(ctx: RequestContext): string {
  const value = ctx.params["tagId"];
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new AppError(ErrorCodes.validationFailed, "tagId is required", 400, [
      { field: "tagId", reason: "required" },
    ]);
  }
  return value.trim();
}

async function requireRetentionRead(
  options: RetentionRouteOptions,
  caller: RetentionCaller,
): Promise<void> {
  if (options.authorize) {
    await options.authorize(caller, RETENTION_READ_PERMISSION);
    return;
  }
  const permissions = caller.permissions ?? [];
  if (!permissions.includes(RETENTION_READ_PERMISSION) && !permissions.includes("*")) {
    throw new AppError(ErrorCodes.forbidden, "forbidden: missing mailboxes.read", 403);
  }
}

async function requireRetentionWrite(
  options: RetentionRouteOptions,
  caller: RetentionCaller,
): Promise<void> {
  if (options.authorize) {
    await options.authorize(caller, RETENTION_WRITE_PERMISSION);
    return;
  }
  const permissions = caller.permissions ?? [];
  const hasWrite =
    permissions.includes(RETENTION_WRITE_PERMISSION) ||
    permissions.includes(REMEDIATION_APPLY_PERMISSION) ||
    permissions.includes("*");
  if (!hasWrite) {
    throw new AppError(ErrorCodes.forbidden, "forbidden: missing mailboxes.write", 403);
  }
}

function readPreviewFlag(ctx: RequestContext, body: Record<string, unknown>): boolean {
  return Boolean(body["preview"] ?? (ctx.query.get("preview") === "true"));
}

export function validateRetentionTagName(name: string): boolean {
  return name.trim().length > 0 && name.trim().length <= 256;
}

export function validateRetentionDays(days: unknown): boolean {
  return typeof days === "number" && Number.isInteger(days) && days >= 1 && days <= 36500;
}

function parseRetentionDays(value: unknown, field: string): number | undefined {
  if (value === undefined) return undefined;
  if (!validateRetentionDays(value)) {
    throw validationError("retentionDays must be an integer between 1 and 36500", field);
  }
  return value as number;
}

function parseAssignSingleBody(
  ctx: RequestContext,
): { input: AssignRetentionTagInput; isPreview: boolean } {
  const body = (ctx.body ?? {}) as Record<string, unknown>;
  const mailboxId =
    typeof body["mailboxId"] === "string" ? body["mailboxId"].trim() : "";
  if (!mailboxId) {
    throw validationError("mailboxId is required", "mailboxId");
  }
  const tagId = typeof body["tagId"] === "string" ? body["tagId"].trim() : "";
  if (!tagId) {
    throw validationError("tagId is required", "tagId");
  }
  const policyId =
    typeof body["policyId"] === "string" && body["policyId"].trim().length > 0
      ? body["policyId"].trim()
      : undefined;
  const isPreview = readPreviewFlag(ctx, body);
  const confirm = Boolean(body["confirm"] ?? true);
  if (!isPreview && !confirm) {
    throw validationError("confirm must be true to assign a retention tag", "confirm");
  }
  return { input: { mailboxId, tagId, policyId, preview: isPreview, confirm: true }, isPreview };
}

function parseAssignBulkBody(
  ctx: RequestContext,
): { input: AssignRetentionTagBulkInput; isPreview: boolean } {
  const body = (ctx.body ?? {}) as Record<string, unknown>;
  const tagId = typeof body["tagId"] === "string" ? body["tagId"].trim() : "";
  if (!tagId) {
    throw validationError("tagId is required", "tagId");
  }
  const rawIds = body["mailboxIds"] ?? body["mailboxId"];
  if (!Array.isArray(rawIds) || rawIds.length === 0) {
    throw validationError("mailboxIds must be a non-empty array of mailbox identifiers", "mailboxIds");
  }
  const mailboxIds = rawIds.map((id) => String(id).trim()).filter((id) => id.length > 0);
  if (mailboxIds.length === 0) {
    throw validationError("mailboxIds must be a non-empty array of mailbox identifiers", "mailboxIds");
  }
  if (mailboxIds.length > MAX_RETENTION_BULK_MAILBOXES) {
    throw validationError(
      `at most ${MAX_RETENTION_BULK_MAILBOXES} mailboxes per bulk assignment`,
      "mailboxIds",
    );
  }
  const policyId =
    typeof body["policyId"] === "string" && body["policyId"].trim().length > 0
      ? body["policyId"].trim()
      : undefined;
  const isPreview = readPreviewFlag(ctx, body);
  const confirm = Boolean(body["confirm"] ?? true);
  if (!isPreview && !confirm) {
    throw validationError("confirm must be true to assign a retention tag", "confirm");
  }
  return { input: { mailboxIds, tagId, policyId, preview: isPreview, confirm: true }, isPreview };
}

async function recordAssignAudits(
  options: RetentionRouteOptions,
  result: RetentionAssignResult | RetentionAssignBulkResult,
): Promise<void> {
  if (!options.recordAudit) return;
  const events: readonly Record<string, unknown>[] =
    "auditEvents" in result && result.auditEvents !== undefined
      ? result.auditEvents.map((event) => ({ ...event }))
      : "auditEvent" in result && result.auditEvent !== undefined
        ? [{ ...result.auditEvent }]
        : [];
  for (const event of events) {
    await options.recordAudit(event);
  }
}

export function createRetentionRoutes(options: RetentionRouteOptions): Route[] {
  return [
    {
      method: "GET",
      path: RETENTION_POLICIES_PATH,
      handler: async (ctx: RequestContext): Promise<RouteResponse> => {
        const caller = requireCaller(options.resolveCaller, ctx);
        const tenantId = requireTenantParam(ctx);
        requireTenantInScope(caller, tenantId);
        await requireRetentionRead(options, caller);
        const policies = await options.provider.listPolicies(tenantId);
        return {
          status: 200,
          headers: { "content-type": "application/json" },
          body: { tenantId, policies },
        };
      },
    },
    {
      method: "GET",
      path: RETENTION_TAGS_PATH,
      handler: async (ctx: RequestContext): Promise<RouteResponse> => {
        const caller = requireCaller(options.resolveCaller, ctx);
        const tenantId = requireTenantParam(ctx);
        requireTenantInScope(caller, tenantId);
        await requireRetentionRead(options, caller);
        const tags = await options.provider.listTags(tenantId);
        return {
          status: 200,
          headers: { "content-type": "application/json" },
          body: { tenantId, tags },
        };
      },
    },
    {
      method: "POST",
      path: RETENTION_TAGS_PATH,
      handler: async (ctx: RequestContext): Promise<RouteResponse> => {
        const caller = requireCaller(options.resolveCaller, ctx);
        const tenantId = requireTenantParam(ctx);
        requireTenantInScope(caller, tenantId);
        await requireRetentionWrite(options, caller);

        const body = (ctx.body ?? {}) as Record<string, unknown>;
        const name = typeof body["name"] === "string" ? body["name"].trim() : "";
        if (!validateRetentionTagName(name)) {
          throw validationError("name is required", "name");
        }
        const type =
          typeof body["type"] === "string" && body["type"].trim().length > 0
            ? body["type"].trim()
            : undefined;
        if (
          type !== undefined &&
          !(RETENTION_TAG_TYPES as readonly string[]).includes(type.toLowerCase())
        ) {
          throw validationError(
            `type must be one of: ${RETENTION_TAG_TYPES.join(", ")}`,
            "type",
          );
        }
        const retentionDays = parseRetentionDays(body["retentionDays"], "retentionDays");
        const retentionAction =
          typeof body["retentionAction"] === "string" &&
          body["retentionAction"].trim().length > 0
            ? body["retentionAction"].trim()
            : undefined;

        const isPreview = readPreviewFlag(ctx, body);
        const result = await options.provider.createTag(
          tenantId,
          {
            name,
            type: type as RetentionTagType | undefined,
            retentionDays,
            retentionAction,
            preview: isPreview,
          },
          isPreview,
        );
        return {
          status: isPreview ? 200 : 201,
          headers: { "content-type": "application/json" },
          body: result,
        };
      },
    },
    {
      method: "PATCH",
      path: RETENTION_TAG_ITEM_PATH,
      handler: async (ctx: RequestContext): Promise<RouteResponse> => {
        const caller = requireCaller(options.resolveCaller, ctx);
        const tenantId = requireTenantParam(ctx);
        const tagId = requireTagParam(ctx);
        requireTenantInScope(caller, tenantId);
        await requireRetentionWrite(options, caller);

        const body = (ctx.body ?? {}) as Record<string, unknown>;
        const name =
          typeof body["name"] === "string" && body["name"].trim().length > 0
            ? body["name"].trim()
            : undefined;
        if (name !== undefined && !validateRetentionTagName(name)) {
          throw validationError("name must be a non-empty string", "name");
        }
        const retentionDays = parseRetentionDays(body["retentionDays"], "retentionDays");
        const retentionAction =
          typeof body["retentionAction"] === "string" &&
          body["retentionAction"].trim().length > 0
            ? body["retentionAction"].trim()
            : undefined;
        const enabled = typeof body["enabled"] === "boolean" ? body["enabled"] : undefined;
        if (
          name === undefined &&
          retentionDays === undefined &&
          retentionAction === undefined &&
          enabled === undefined
        ) {
          throw validationError(
            "at least one of name, retentionDays, retentionAction, or enabled is required",
            "body",
          );
        }

        const isPreview = readPreviewFlag(ctx, body);
        const result = await options.provider.editTag(
          tenantId,
          tagId,
          { name, retentionDays, retentionAction, enabled, preview: isPreview },
          isPreview,
        );
        return {
          status: 200,
          headers: { "content-type": "application/json" },
          body: result,
        };
      },
    },
    {
      method: "POST",
      path: RETENTION_ASSIGN_PATH,
      handler: async (ctx: RequestContext): Promise<RouteResponse> => {
        const caller = requireCaller(options.resolveCaller, ctx);
        const tenantId = requireTenantParam(ctx);
        requireTenantInScope(caller, tenantId);
        await requireRetentionWrite(options, caller);

        const { input, isPreview } = parseAssignSingleBody(ctx);
        const result = await options.provider.assignTag(tenantId, input, isPreview);
        if (!isPreview) {
          await recordAssignAudits(options, result as RetentionAssignResult);
        }
        return {
          status: 200,
          headers: { "content-type": "application/json" },
          body: result,
        };
      },
    },
    {
      method: "POST",
      path: RETENTION_ASSIGN_BULK_PATH,
      handler: async (ctx: RequestContext): Promise<RouteResponse> => {
        const caller = requireCaller(options.resolveCaller, ctx);
        const tenantId = requireTenantParam(ctx);
        requireTenantInScope(caller, tenantId);
        await requireRetentionWrite(options, caller);

        const { input, isPreview } = parseAssignBulkBody(ctx);
        const result = await options.provider.assignTagBulk(tenantId, input, isPreview);
        if (!isPreview) {
          await recordAssignAudits(options, result as RetentionAssignBulkResult);
        }
        return {
          status: 200,
          headers: { "content-type": "application/json" },
          body: result,
        };
      },
    },
  ];
}

export const RETENTION_OPENAPI = {
  paths: {
    "/tenants/{tenantId}/retention/policies": {
      get: {
        operationId: "listRetentionPolicies",
        summary: "List retention policies live from EXO",
        permission: RETENTION_READ_PERMISSION,
        security: [{ bearerAuth: [] }],
        parameters: [
          { name: "tenantId", in: "path", required: true, schema: { type: "string" } },
        ],
        responses: {
          "200": { description: "The live retention policies." },
          "401": { description: "Authentication required." },
          "403": { description: "The caller lacks mailboxes.read or the tenant is out of scope." },
        },
      },
    },
    "/tenants/{tenantId}/retention/tags": {
      get: {
        operationId: "listRetentionTags",
        summary: "List retention tags live from EXO",
        permission: RETENTION_READ_PERMISSION,
        security: [{ bearerAuth: [] }],
        parameters: [
          { name: "tenantId", in: "path", required: true, schema: { type: "string" } },
        ],
        responses: {
          "200": { description: "The live retention tags." },
          "401": { description: "Authentication required." },
          "403": { description: "The caller lacks mailboxes.read or the tenant is out of scope." },
        },
      },
      post: {
        operationId: "createRetentionTag",
        summary: "Create a retention tag (plan preview with preview:true)",
        permission: RETENTION_WRITE_PERMISSION,
        security: [{ bearerAuth: [] }],
        parameters: [
          { name: "tenantId", in: "path", required: true, schema: { type: "string" } },
        ],
        responses: {
          "200": { description: "Plan preview of the tag create." },
          "201": { description: "The created tag with before/after and audit event." },
          "400": { description: "name, type, or retentionDays failed validation." },
          "401": { description: "Authentication required." },
          "403": { description: "The caller lacks mailboxes.write or the tenant is out of scope." },
        },
      },
    },
    "/tenants/{tenantId}/retention/tags/{tagId}": {
      patch: {
        operationId: "editRetentionTag",
        summary: "Edit a retention tag (plan preview with preview:true)",
        permission: RETENTION_WRITE_PERMISSION,
        security: [{ bearerAuth: [] }],
        parameters: [
          { name: "tenantId", in: "path", required: true, schema: { type: "string" } },
          { name: "tagId", in: "path", required: true, schema: { type: "string" } },
        ],
        responses: {
          "200": { description: "Edit plan preview or the applied tag with before/after and audit event." },
          "400": { description: "No editable field was supplied." },
          "401": { description: "Authentication required." },
          "403": { description: "The caller lacks mailboxes.write or the tenant is out of scope." },
        },
      },
    },
    "/tenants/{tenantId}/retention/assign": {
      post: {
        operationId: "assignRetentionTag",
        summary: "Assign a retention tag to one mailbox (preview lists the affected mailbox)",
        permission: RETENTION_WRITE_PERMISSION,
        security: [{ bearerAuth: [] }],
        parameters: [
          { name: "tenantId", in: "path", required: true, schema: { type: "string" } },
        ],
        responses: {
          "200": { description: "Assignment plan preview or the applied result with before/after and audit event." },
          "400": { description: "mailboxId, tagId, or confirm failed validation." },
          "401": { description: "Authentication required." },
          "403": { description: "The caller lacks mailboxes.write or the tenant is out of scope." },
        },
      },
    },
    "/tenants/{tenantId}/retention/assign/bulk": {
      post: {
        operationId: "assignRetentionTagBulk",
        summary: "Assign a retention tag to many mailboxes (preview lists affected mailboxes)",
        permission: RETENTION_WRITE_PERMISSION,
        security: [{ bearerAuth: [] }],
        parameters: [
          { name: "tenantId", in: "path", required: true, schema: { type: "string" } },
        ],
        responses: {
          "200": { description: "Bulk plan preview or per-mailbox results with audit events." },
          "400": { description: "mailboxIds, tagId, or confirm failed validation." },
          "401": { description: "Authentication required." },
          "403": { description: "The caller lacks mailboxes.write or the tenant is out of scope." },
        },
      },
    },
  },
} as const;
