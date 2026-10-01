// Bulk quarantine release/delete routes (EPIC-022 SPEC.md §3.3, §4.2, §6, §8,
// §9; resolved §11.2; T-0425). Exposes POST
// /v1/tenants/:tenantId/quarantine/bulk for a capped, explicitly confirmed
// batch across the Email, Files, and Teams tabs.
//
// The cap and the confirmation count model live in
// ../domain/quarantine/bulk.ts; this module is the thin BFF seam. It validates
// the selection all-or-nothing (a batch over the cap is rejected before any
// release or delete), resolves every selected message within the caller's
// tenant scope, renders the confirmation count on preview, requires confirm:
// true to apply, and enqueues one EPIC-006 gated `remediation` job (T-0107).
// Each item is recorded with a pending QuarantineAction (T-0424) and an
// AuditEvent carrying actor, message, and recipient; the PowerShell worker
// applies each item and reports a per-message failure without aborting the
// rest. No direct EXO write bypasses EPIC-006.
import { randomUUID } from "node:crypto";
import type { JobEnvelope } from "@m365-assess/contracts";
import { AppError, ErrorCodes } from "../errors.js";
import { requireTenantInScope } from "../rbac/authorize.js";
import type { RequestContext, Route, RouteResponse } from "../server.js";
import {
  QUARANTINE_ACT_PERMISSION,
  REMEDIATION_APPLY_PERMISSION,
  quarantineNotFoundError,
  type QuarantineActionRecordInput,
  type QuarantineAuditEvent,
  type QuarantineAuthorizer,
  type QuarantineCaller,
  type QuarantineMessageDetail,
  type QuarantineProvider,
} from "./quarantine.js";
import {
  QUARANTINE_BULK_ACTIONS,
  QuarantineBulkInputError,
  buildQuarantineBulkConfirmation,
  parseQuarantineBulkAction,
  requireQuarantineBulkConfirmation,
  validateQuarantineBulkSelection,
  type QuarantineBulkAction,
  type QuarantineBulkConfirmation,
} from "../domain/quarantine/bulk.js";

export const QUARANTINE_BULK_PATH = "/v1/tenants/:tenantId/quarantine/bulk";

export const QUARANTINE_BULK_UNAUTHENTICATED = "request.unauthenticated";

export interface QuarantineBulkItemPlan {
  readonly messageId: string;
  readonly recipient: string | null;
  readonly sender: string;
  readonly tab: string;
}

export interface QuarantineBulkPlan {
  readonly action: QuarantineBulkAction;
  readonly messageIds: readonly string[];
  readonly count: number;
  readonly cap: number;
  readonly items: readonly QuarantineBulkItemPlan[];
  readonly dryRun: boolean;
  readonly requiresConfirmation: boolean;
  readonly securityImpacting: boolean;
  readonly warning: string;
  readonly confirmation: QuarantineBulkConfirmation;
}

export interface QuarantineBulkItemResult {
  readonly messageId: string;
  readonly recipient: string | null;
  readonly quarantineActionId?: string;
  readonly auditEventId?: string;
}

export interface QuarantineBulkResult {
  readonly success: boolean;
  readonly action: QuarantineBulkAction;
  readonly count: number;
  readonly cap: number;
  readonly jobId: string;
  readonly items: readonly QuarantineBulkItemResult[];
}

export interface QuarantineBulkRouteOptions {
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
  /** Configured per-action cap; defaults to the domain default. */
  readonly cap?: number;
}

function unauthenticatedError(): AppError {
  return new AppError(QUARANTINE_BULK_UNAUTHENTICATED, "authentication required", 401);
}

function validationError(message: string, field: string): AppError {
  return new AppError(ErrorCodes.validationFailed, message, 400, [{ field, reason: "invalid" }]);
}

function toAppError(error: QuarantineBulkInputError): AppError {
  return new AppError(error.code, error.message, 400, [{ field: error.field, reason: "invalid" }]);
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
    throw validationError("tenantId is required", "tenantId");
  }
  return value.trim();
}

async function requireQuarantineAct(
  options: QuarantineBulkRouteOptions,
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

function requireQueue(options: QuarantineBulkRouteOptions): {
  enqueue(envelope: JobEnvelope): Promise<string>;
} {
  if (!options.queue) {
    throw new AppError(
      ErrorCodes.internalError,
      "quarantine bulk writes require a worker queue",
      500,
    );
  }
  return options.queue;
}

function recipientFor(action: QuarantineBulkAction, message: QuarantineMessageDetail): string | null {
  return action === "releaseAll" ? null : message.recipient;
}

function buildBulkPlan(
  action: QuarantineBulkAction,
  messages: readonly QuarantineMessageDetail[],
  messageIds: readonly string[],
  cap: number,
  dryRun: boolean,
): QuarantineBulkPlan {
  const items = messages.map((message) => ({
    messageId: message.messageId,
    recipient: recipientFor(action, message),
    sender: message.sender,
    tab: message.tab,
  }));
  const selection = { action, messageIds, count: messages.length, cap };
  const confirmation = buildQuarantineBulkConfirmation(selection);
  return {
    action,
    messageIds,
    count: messages.length,
    cap,
    items,
    dryRun,
    requiresConfirmation: confirmation.requiresConfirmation,
    securityImpacting: confirmation.requiresConfirmation,
    warning: confirmation.warning,
    confirmation,
  };
}

function buildRemediationEnvelope(
  ctx: RequestContext,
  tenantId: string,
  jobId: string,
  requestId: string,
  createdAt: string,
  payload: Record<string, unknown>,
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
      ...payload,
    },
  };
}

function auditActionFor(action: QuarantineBulkAction): string {
  return `quarantine.bulk.${action}`;
}

export function createQuarantineBulkRoutes(options: QuarantineBulkRouteOptions): Route[] {
  const idGenerator = options.idGenerator ?? (() => randomUUID());
  const now = options.now ?? (() => new Date().toISOString());

  const bulkHandler = async (ctx: RequestContext): Promise<RouteResponse> => {
    const caller = requireCaller(options.resolveCaller, ctx);
    const tenantId = requireTenantParam(ctx);
    requireTenantInScope(caller, tenantId);
    await requireQuarantineAct(options, caller);

    const body = readBodyRecord(ctx);
    let action: QuarantineBulkAction;
    let selection;
    try {
      action = parseQuarantineBulkAction(body["action"]);
      selection = validateQuarantineBulkSelection(action, body["messageIds"], options.cap);
    } catch (error) {
      if (error instanceof QuarantineBulkInputError) {
        throw toAppError(error);
      }
      throw error;
    }

    // All-or-nothing selection membership: resolve every message within scope
    // before anything is queued or audited.
    const messages: QuarantineMessageDetail[] = [];
    for (const messageId of selection.messageIds) {
      const message = await options.provider.getMessage(tenantId, messageId);
      if (!message) {
        throw quarantineNotFoundError(messageId);
      }
      messages.push(message);
    }

    const isPreview = readPreviewFlag(ctx, body);
    const plan = buildBulkPlan(action, messages, selection.messageIds, selection.cap, isPreview);
    if (isPreview) {
      return { status: 200, headers: { "content-type": "application/json" }, body: plan };
    }

    try {
      requireQuarantineBulkConfirmation(selection, body["confirm"]);
    } catch (error) {
      if (error instanceof QuarantineBulkInputError) {
        throw toAppError(error);
      }
      throw error;
    }

    const queue = requireQueue(options);
    const jobId = idGenerator();
    const requestId = idGenerator();
    const createdAt = now();
    const actor = caller.userId ?? "unknown";

    const items: QuarantineBulkItemResult[] = [];
    for (const message of messages) {
      const recipient = recipientFor(action, message);
      const quarantineActionId = idGenerator();
      const auditEventId = idGenerator();

      if (options.recordAction) {
        await options.recordAction({
          id: quarantineActionId,
          tenantId,
          messageId: message.messageId,
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
          messageId: message.messageId,
          recipient,
          actorUserId: actor,
          correlationId: ctx.correlationId,
          timestamp: createdAt,
          result: "pending",
        });
      }

      items.push({
        messageId: message.messageId,
        recipient,
        quarantineActionId,
        auditEventId,
      });
    }

    await queue.enqueue(
      buildRemediationEnvelope(ctx, tenantId, jobId, requestId, createdAt, {
        area: "quarantine-bulk",
        action,
        cap: selection.cap,
        confirm: true,
        actor,
        messages: messages.map((message) => ({
          messageId: message.messageId,
          recipient: recipientFor(action, message),
          sender: message.sender,
          subject: message.subject,
          tab: message.tab,
        })),
      }),
    );

    const result: QuarantineBulkResult = {
      success: true,
      action,
      count: messages.length,
      cap: selection.cap,
      jobId,
      items,
    };
    return { status: 202, headers: { "content-type": "application/json" }, body: result };
  };

  return [{ method: "POST", path: QUARANTINE_BULK_PATH, handler: bulkHandler }];
}

// Route modules own their OpenAPI path items (portal.v1.yaml `paths` is empty
// by design); a wiring ticket merges this fragment into the served document.
export const QUARANTINE_BULK_OPENAPI = {
  paths: {
    "/tenants/{tenantId}/quarantine/bulk": {
      post: {
        operationId: "bulkActOnQuarantineMessages",
        summary:
          "Release (to recipient or all) or delete a capped selection of quarantined messages with an explicit confirmation count; applies through the EPIC-006 gated path and writes a QuarantineAction plus an AuditEvent per item",
        permission: QUARANTINE_ACT_PERMISSION,
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
                required: ["action", "messageIds"],
                properties: {
                  action: { type: "string", enum: [...QUARANTINE_BULK_ACTIONS] },
                  messageIds: { type: "array", items: { type: "string" } },
                  confirm: { type: "boolean" },
                  preview: { type: "boolean" },
                },
              },
            },
          },
        },
        responses: {
          "200": {
            description:
              "Confirmation count model and per-item plan; nothing is released or deleted.",
          },
          "202": {
            description:
              "The batch was queued through the EPIC-006 gated path with one QuarantineAction and AuditEvent per item.",
          },
          "400": {
            description:
              "Selection is empty, malformed, over the configured cap, or confirm is required.",
          },
          "401": { description: "Authentication required." },
          "403": {
            description:
              "The caller lacks quarantine.act or Remediation.Apply, or the tenant is out of scope.",
          },
          "404": { description: "A selected quarantined message was not found." },
        },
      },
    },
  },
} as const;
