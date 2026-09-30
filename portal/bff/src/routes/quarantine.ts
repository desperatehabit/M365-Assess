// Quarantine list, preview, release, and delete (EPIC-022 SPEC.md §2 US-3,
// §3.3, §4.2, §5, §6, §8; T-0424). Exposes GET
// /v1/tenants/:tenantId/quarantine with the §3.3 columns (Received, Subject,
// Sender, Recipient, Reason, Policy, Expires, State) and the §3.3 filters
// (reason, direction, date, recipient, state) across the Email, Files, and
// Teams tabs; GET /v1/tenants/:tenantId/quarantine/:messageId for the §3.3
// Preview row action; and POST
// /v1/tenants/:tenantId/quarantine/:messageId/:action for release,
// release-to-all, delete, and block-sender.
//
// Quarantine messages are read live from EXO/Graph and never mirrored: the
// injected provider is backed by the worker queue (T-0010), so this module
// holds no M365 SDK call and issues no tenant write on reads. Reads require
// `quarantine.read` (SPEC §7) intersected with the caller tenant scope.
//
// Release and delete are security actions (SPEC §4.2, §8, §9): the route
// validates `quarantine.act` plus `Remediation.Apply`, requires explicit
// `confirm: true`, builds a preview plan showing the affected message before
// apply (`preview: true` writes nothing), and enqueues a `remediation` job
// through the EPIC-006 gated path (T-0107). Every apply writes one
// QuarantineAction (T-0424, persisted via @m365-assess/db
// quarantine-repository by the wiring) plus one AuditEvent recorded by the
// app audit sink, so the release is audited with actor, message, and
// recipient. No direct EXO write bypasses EPIC-006.
import { randomUUID } from "node:crypto";
import type { JobEnvelope } from "@m365-assess/contracts";
import { AppError, ErrorCodes } from "../errors.js";
import { parsePagination } from "../pagination.js";
import { requireTenantInScope, type Caller } from "../rbac/authorize.js";
import type { RequestContext, Route, RouteResponse } from "../server.js";

export const QUARANTINE_PATH = "/v1/tenants/:tenantId/quarantine";
export const QUARANTINE_ITEM_PATH = "/v1/tenants/:tenantId/quarantine/:messageId";
export const QUARANTINE_ACTION_PATH = "/v1/tenants/:tenantId/quarantine/:messageId/:action";

export const QUARANTINE_READ_PERMISSION = "quarantine.read";
export const QUARANTINE_ACT_PERMISSION = "quarantine.act";
export const REMEDIATION_APPLY_PERMISSION = "Remediation.Apply";

export const QUARANTINE_UNAUTHENTICATED = "request.unauthenticated";
export const QUARANTINE_NOT_FOUND = "quarantine.not_found";
export const QUARANTINE_CONFIRM_REQUIRED = "quarantine.confirm_required";
export const QUARANTINE_INVALID_TAB = "quarantine.invalid_tab";
export const QUARANTINE_INVALID_ACTION = "quarantine.invalid_action";

export const QUARANTINE_TABS = ["email", "files", "teams"] as const;
export type QuarantineTab = (typeof QUARANTINE_TABS)[number];

export const QUARANTINE_ACTIONS = ["release", "releaseAll", "delete", "block"] as const;
export type QuarantineAction = (typeof QUARANTINE_ACTIONS)[number];

// Release (to recipient or all) and delete release or destroy quarantined mail
// and therefore require explicit confirmation (SPEC §4.2, §8, §9).
export const QUARANTINE_ACTION_CONFIRMATION: readonly QuarantineAction[] = [
  "release",
  "releaseAll",
  "delete",
];

export const QUARANTINE_SECURITY_IMPACTING_WARNING =
  "Releasing quarantined mail can deliver malicious content to a mailbox. " +
  "Preview the message first; this release is audited with actor, message, and recipient.";

export interface QuarantineMessage {
  readonly messageId: string;
  readonly tab: QuarantineTab;
  readonly received: string;
  readonly subject: string;
  readonly sender: string;
  readonly recipient: string;
  readonly reason: string;
  readonly policy: string;
  readonly expires: string | null;
  readonly state: string;
  readonly direction: string;
}

export interface QuarantineMessagePreview {
  readonly source: "exo" | "graph";
  readonly available: boolean;
  readonly body?: string | null;
}

export interface QuarantineMessageDetail extends QuarantineMessage {
  readonly preview: QuarantineMessagePreview;
}

export interface QuarantineFilter {
  readonly tab: QuarantineTab;
  readonly reason?: string;
  readonly direction?: string;
  readonly recipient?: string;
  readonly state?: string;
  readonly dateFrom?: string;
  readonly dateTo?: string;
  readonly cursor: string | null;
  readonly limit: number;
}

export interface QuarantinePage {
  readonly tenantId: string;
  readonly tab: QuarantineTab;
  readonly items: readonly QuarantineMessage[];
  readonly totalCount: number;
  readonly nextCursor: string | null;
  readonly retrievedAt: string;
}

export interface QuarantineActionPlan {
  readonly action: QuarantineAction;
  readonly messageId: string;
  readonly tab: QuarantineTab;
  readonly recipient: string | null;
  readonly sender: string;
  readonly diff: readonly string[];
  readonly valid: boolean;
  readonly dryRun: boolean;
  readonly requiresConfirmation: boolean;
  readonly securityImpacting: boolean;
  readonly warning?: string;
}

export type QuarantineActionOutcome = "pending" | "success" | "failure";

// Structural match for @m365-assess/db QuarantineActionInput.createQuarantineAction,
// so the wiring can pass the repository without the BFF importing process code.
export interface QuarantineActionRecordInput {
  readonly id: string;
  readonly tenantId: string;
  readonly messageId: string;
  readonly action: string;
  readonly recipient?: string | null;
  readonly by?: string | null;
  readonly at?: string;
  readonly result?: QuarantineActionOutcome;
}

export interface QuarantineAuditEvent {
  readonly id: string;
  readonly tenantId: string;
  readonly action: string;
  readonly messageId: string;
  readonly recipient: string | null;
  readonly actorUserId: string;
  readonly correlationId: string;
  readonly timestamp: string;
  readonly result: string;
}

export interface QuarantineActionResult {
  readonly success: boolean;
  readonly plan: QuarantineActionPlan;
  readonly jobId: string;
  readonly quarantineActionId?: string;
  readonly auditEventId?: string;
}

// Queue-backed seam for the quarantine reads: the production wiring enqueues a
// get-quarantine worker job for (tenantId, filter) or (tenantId, messageId)
// and serves the worker result. Depending on the seam keeps EXO and process
// code out of the BFF.
export interface QuarantineProvider {
  listMessages(tenantId: string, filter: QuarantineFilter): Promise<QuarantinePage>;
  getMessage(tenantId: string, messageId: string): Promise<QuarantineMessageDetail | undefined>;
}

export interface QuarantineCaller extends Caller {
  readonly userId?: string;
}

export type QuarantineAuthorizer = (
  caller: QuarantineCaller,
  permission: string,
) => void | Promise<void>;

export interface QuarantineRouteOptions {
  readonly provider: QuarantineProvider;
  readonly queue?: {
    enqueue(envelope: JobEnvelope): Promise<string>;
  };
  readonly recordAction?: (input: QuarantineActionRecordInput) => void | Promise<void>;
  readonly resolveCaller: (ctx: RequestContext) => QuarantineCaller | undefined;
  readonly authorize?: QuarantineAuthorizer;
  readonly recordAudit?: (event: QuarantineAuditEvent) => void | Promise<void>;
  readonly idGenerator?: () => string;
  readonly now?: () => string;
}

function unauthenticatedError(): AppError {
  return new AppError(QUARANTINE_UNAUTHENTICATED, "authentication required", 401);
}

function validationError(message: string, field: string): AppError {
  return new AppError(ErrorCodes.validationFailed, message, 400, [
    { field, reason: "invalid" },
  ]);
}

export function quarantineNotFoundError(messageId: string): AppError {
  return new AppError(QUARANTINE_NOT_FOUND, `quarantine message '${messageId}' was not found`, 404, [
    { field: "messageId", reason: "not_found" },
  ]);
}

function requireCaller(
  resolveCaller: (ctx: RequestContext) => QuarantineCaller | undefined,
  ctx: RequestContext,
): QuarantineCaller {
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

function requireMessageParam(ctx: RequestContext): string {
  const value = ctx.params["messageId"];
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new AppError(ErrorCodes.validationFailed, "messageId is required", 400, [
      { field: "messageId", reason: "required" },
    ]);
  }
  return value.trim();
}

async function requireQuarantineRead(
  options: QuarantineRouteOptions,
  caller: QuarantineCaller,
): Promise<void> {
  if (options.authorize) {
    await options.authorize(caller, QUARANTINE_READ_PERMISSION);
    return;
  }
  const permissions = caller.permissions ?? [];
  if (!permissions.includes(QUARANTINE_READ_PERMISSION) && !permissions.includes("*")) {
    throw new AppError(ErrorCodes.forbidden, "forbidden: missing quarantine.read", 403);
  }
}

async function requireQuarantineAct(
  options: QuarantineRouteOptions,
  caller: QuarantineCaller,
): Promise<void> {
  if (options.authorize) {
    await options.authorize(caller, QUARANTINE_ACT_PERMISSION);
    return;
  }
  const permissions = caller.permissions ?? [];
  const hasWrite =
    permissions.includes(QUARANTINE_ACT_PERMISSION) ||
    permissions.includes(REMEDIATION_APPLY_PERMISSION) ||
    permissions.includes("*");
  if (!hasWrite) {
    throw new AppError(
      ErrorCodes.forbidden,
      `forbidden: write requires ${QUARANTINE_ACT_PERMISSION} or ${REMEDIATION_APPLY_PERMISSION}`,
      403,
    );
  }
}

export function parseQuarantineTab(value: unknown): QuarantineTab {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new AppError(QUARANTINE_INVALID_TAB, "tab is required", 400, [
      { field: "tab", reason: "required" },
    ]);
  }
  const normalized = value.trim().toLowerCase().replace(/[-_]/g, "");
  switch (normalized) {
    case "email":
    case "messages":
      return "email";
    case "files":
      return "files";
    case "teams":
    case "teamsmessages":
      return "teams";
    default:
      throw validationError(`tab must be one of: ${QUARANTINE_TABS.join(", ")}`, "tab");
  }
}

export function parseQuarantineAction(value: unknown): QuarantineAction {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new AppError(QUARANTINE_INVALID_ACTION, "action is required", 400, [
      { field: "action", reason: "required" },
    ]);
  }
  const normalized = value.trim().toLowerCase().replace(/[-_]/g, "");
  switch (normalized) {
    case "release":
      return "release";
    case "releaseall":
    case "releasetoall":
      return "releaseAll";
    case "delete":
      return "delete";
    case "block":
    case "blocksender":
      return "block";
    default:
      throw validationError(
        `action must be one of: ${QUARANTINE_ACTIONS.join(", ")}`,
        "action",
      );
  }
}

function optionalText(query: URLSearchParams, name: string): string | undefined {
  const value = query.get(name);
  if (value === null || value.length === 0) {
    return undefined;
  }
  return value;
}

function optionalDate(query: URLSearchParams, name: string): string | undefined {
  const value = optionalText(query, name);
  if (value === undefined) {
    return undefined;
  }
  if (Number.isNaN(Date.parse(value))) {
    throw validationError(`${name} must be a parseable datetime`, name);
  }
  return value;
}

export function parseQuarantineFilter(query: URLSearchParams): QuarantineFilter {
  const pagination = parsePagination(query);
  const tab = parseQuarantineTab(query.get("tab") ?? "email");
  const dateFrom = optionalDate(query, "dateFrom");
  const dateTo = optionalDate(query, "dateTo");
  if (dateFrom !== undefined && dateTo !== undefined && Date.parse(dateFrom) > Date.parse(dateTo)) {
    throw validationError("dateFrom must not be after dateTo", "dateFrom");
  }
  return {
    tab,
    reason: optionalText(query, "reason"),
    direction: optionalText(query, "direction"),
    recipient: optionalText(query, "recipient"),
    state: optionalText(query, "state"),
    dateFrom,
    dateTo,
    cursor: pagination.cursor,
    limit: pagination.limit,
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
  return value.trim();
}

function requireActionConfirmation(action: QuarantineAction, body: Record<string, unknown>): void {
  if (!QUARANTINE_ACTION_CONFIRMATION.includes(action)) return;
  const confirm = optionalBoolean(body["confirm"], "confirm") ?? false;
  if (!confirm) {
    throw new AppError(
      QUARANTINE_CONFIRM_REQUIRED,
      `${action} is a security-impacting quarantine action and requires confirmation`,
      400,
      [{ field: "confirm", reason: "required" }],
    );
  }
}

function buildActionPlan(
  action: QuarantineAction,
  message: QuarantineMessageDetail,
  recipient: string | null,
  dryRun: boolean,
): QuarantineActionPlan {
  const diff: string[] = [];
  if (action === "release") {
    diff.push(
      `Release quarantined message '${message.messageId}' to '${recipient ?? message.recipient}'`,
    );
  } else if (action === "releaseAll") {
    diff.push(`Release quarantined message '${message.messageId}' to all recipients`);
  } else if (action === "delete") {
    diff.push(`Delete quarantined message '${message.messageId}'`);
  } else {
    diff.push(`Block sender '${message.sender}' from quarantined message '${message.messageId}'`);
  }

  const requiresConfirmation = QUARANTINE_ACTION_CONFIRMATION.includes(action);
  return {
    action,
    messageId: message.messageId,
    tab: message.tab,
    recipient,
    sender: message.sender,
    diff,
    valid: true,
    dryRun,
    requiresConfirmation,
    securityImpacting: requiresConfirmation,
    ...(requiresConfirmation ? { warning: QUARANTINE_SECURITY_IMPACTING_WARNING } : {}),
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

function auditActionFor(action: QuarantineAction): string {
  return `quarantine.action.${action}`;
}

function actorOf(caller: QuarantineCaller): string {
  return caller.userId ?? "unknown";
}

function requireQueue(options: QuarantineRouteOptions): {
  enqueue(envelope: JobEnvelope): Promise<string>;
} {
  if (!options.queue) {
    throw new AppError(ErrorCodes.internalError, "quarantine writes require a worker queue", 500);
  }
  return options.queue;
}

export function createQuarantineRoutes(options: QuarantineRouteOptions): Route[] {
  const idGenerator = options.idGenerator ?? (() => randomUUID());
  const now = options.now ?? (() => new Date().toISOString());

  const listHandler = async (ctx: RequestContext): Promise<RouteResponse> => {
    const caller = requireCaller(options.resolveCaller, ctx);
    const tenantId = requireTenantParam(ctx);
    requireTenantInScope(caller, tenantId);
    await requireQuarantineRead(options, caller);

    const filter = parseQuarantineFilter(ctx.query);
    const page = await options.provider.listMessages(tenantId, filter);
    return {
      status: 200,
      headers: { "content-type": "application/json" },
      body: {
        tenantId,
        tab: filter.tab,
        items: [...page.items],
        totalCount: page.totalCount,
        nextCursor: page.nextCursor,
        retrievedAt: page.retrievedAt,
      },
    };
  };

  const previewHandler = async (ctx: RequestContext): Promise<RouteResponse> => {
    const caller = requireCaller(options.resolveCaller, ctx);
    const tenantId = requireTenantParam(ctx);
    const messageId = requireMessageParam(ctx);
    requireTenantInScope(caller, tenantId);
    await requireQuarantineRead(options, caller);

    const message = await options.provider.getMessage(tenantId, messageId);
    if (!message) {
      throw quarantineNotFoundError(messageId);
    }
    return {
      status: 200,
      headers: { "content-type": "application/json" },
      body: message,
    };
  };

  const actionHandler = async (ctx: RequestContext): Promise<RouteResponse> => {
    const caller = requireCaller(options.resolveCaller, ctx);
    const tenantId = requireTenantParam(ctx);
    const messageId = requireMessageParam(ctx);
    const action = parseQuarantineAction(ctx.params["action"]);
    requireTenantInScope(caller, tenantId);
    await requireQuarantineAct(options, caller);

    const body = readBodyRecord(ctx);
    const message = await options.provider.getMessage(tenantId, messageId);
    if (!message) {
      throw quarantineNotFoundError(messageId);
    }

    let recipient = optionalString(body["recipient"], "recipient") ?? null;
    if (action === "release" && recipient === null) {
      recipient = message.recipient;
    }
    if (action === "releaseAll") {
      recipient = null;
    }

    const isPreview = readPreviewFlag(ctx, body);
    const plan = buildActionPlan(action, message, recipient, isPreview);
    if (isPreview) {
      return { status: 200, headers: { "content-type": "application/json" }, body: plan };
    }

    requireActionConfirmation(action, body);
    const queue = requireQueue(options);

    const jobId = idGenerator();
    const requestId = idGenerator();
    const quarantineActionId = idGenerator();
    const auditEventId = idGenerator();
    const createdAt = now();
    const actor = actorOf(caller);

    await queue.enqueue(
      buildRemediationEnvelope(ctx, tenantId, jobId, requestId, createdAt, {
        area: "quarantine",
        action,
        messageId,
        recipient,
        sender: message.sender,
        tab: message.tab,
        actor,
      }),
    );

    if (options.recordAction) {
      await options.recordAction({
        id: quarantineActionId,
        tenantId,
        messageId,
        action,
        recipient,
        by: actor,
        at: createdAt,
        result: "pending",
      });
    }

    if (options.recordAudit) {
      await options.recordAudit({
        id: auditEventId,
        tenantId,
        action: auditActionFor(action),
        messageId,
        recipient,
        actorUserId: actor,
        correlationId: ctx.correlationId,
        timestamp: createdAt,
        result: "pending",
      });
    }

    const result: QuarantineActionResult = {
      success: true,
      plan,
      jobId,
      quarantineActionId,
      auditEventId,
    };
    return { status: 202, headers: { "content-type": "application/json" }, body: result };
  };

  return [
    { method: "GET", path: QUARANTINE_PATH, handler: listHandler },
    { method: "GET", path: QUARANTINE_ITEM_PATH, handler: previewHandler },
    { method: "POST", path: QUARANTINE_ACTION_PATH, handler: actionHandler },
  ];
}

// Route modules own their OpenAPI path items (portal.v1.yaml `paths` is empty
// by design); a wiring ticket merges this fragment into the served document.
export const QUARANTINE_OPENAPI = {
  paths: {
    "/tenants/{tenantId}/quarantine": {
      get: {
        operationId: "listQuarantineMessages",
        summary:
          "List quarantined messages live from EXO/Graph across the Email, Files, and Teams tabs with the §3.3 columns and reason/direction/date/recipient/state filters",
        permission: QUARANTINE_READ_PERMISSION,
        security: [{ bearerAuth: [] }],
        parameters: [
          { name: "tenantId", in: "path", required: true, schema: { type: "string" } },
          { name: "tab", in: "query", required: false, schema: { type: "string", enum: [...QUARANTINE_TABS] } },
          { name: "reason", in: "query", required: false, schema: { type: "string" } },
          { name: "direction", in: "query", required: false, schema: { type: "string" } },
          { name: "recipient", in: "query", required: false, schema: { type: "string" } },
          { name: "state", in: "query", required: false, schema: { type: "string" } },
          { name: "dateFrom", in: "query", required: false, schema: { type: "string", format: "date-time" } },
          { name: "dateTo", in: "query", required: false, schema: { type: "string", format: "date-time" } },
        ],
        responses: {
          "200": { description: "The §3.3 quarantine table for the requested tab, read live from EXO/Graph." },
          "400": { description: "tab or a filter value failed validation." },
          "401": { description: "Authentication required." },
          "403": { description: "The caller lacks quarantine.read or the tenant is out of scope." },
        },
      },
    },
    "/tenants/{tenantId}/quarantine/{messageId}": {
      get: {
        operationId: "previewQuarantineMessage",
        summary:
          "Preview a quarantined message; uses the EXO quarantine cmdlet where it supports the preview and falls back to Graph metadata only",
        permission: QUARANTINE_READ_PERMISSION,
        security: [{ bearerAuth: [] }],
        parameters: [
          { name: "tenantId", in: "path", required: true, schema: { type: "string" } },
          { name: "messageId", in: "path", required: true, schema: { type: "string" } },
        ],
        responses: {
          "200": { description: "The message metadata plus a preview whose source is exo or graph." },
          "401": { description: "Authentication required." },
          "403": { description: "The caller lacks quarantine.read or the tenant is out of scope." },
          "404": { description: "The quarantined message was not found." },
        },
      },
    },
    "/tenants/{tenantId}/quarantine/{messageId}/{action}": {
      post: {
        operationId: "actOnQuarantineMessage",
        summary:
          "Release (to recipient or all), delete, or block the sender of a quarantined message (plan preview with preview:true; applies through the EPIC-006 gated path and writes a QuarantineAction plus an AuditEvent)",
        permission: QUARANTINE_ACT_PERMISSION,
        security: [{ bearerAuth: [] }],
        parameters: [
          { name: "tenantId", in: "path", required: true, schema: { type: "string" } },
          { name: "messageId", in: "path", required: true, schema: { type: "string" } },
          { name: "action", in: "path", required: true, schema: { type: "string", enum: [...QUARANTINE_ACTIONS] } },
        ],
        responses: {
          "200": { description: "Plan preview of the action with the affected message; nothing is released, deleted, or blocked." },
          "202": { description: "The action was queued through the EPIC-006 gated path with a QuarantineAction and an AuditEvent." },
          "400": { description: "action failed validation or confirm is required for release/delete." },
          "401": { description: "Authentication required." },
          "403": { description: "The caller lacks quarantine.act or Remediation.Apply, or the tenant is out of scope." },
          "404": { description: "The quarantined message was not found." },
        },
      },
    },
  },
} as const;
