// Message trace query within the EXO trace window (EPIC-024 SPEC.md §2 US-1,
// §3.1, §4.1, §6, §9; T-0462). Exposes POST
// /v1/tenants/:tenantId/mail/message-trace — a read-only trace filtered by
// sender, recipient, subject, date range, and status, shaped into the §3.1
// results table (Timestamp · Sender · Recipient · Subject · Status · Event)
// with cursor paging. The date range is validated against the EXO trace
// window by the get-message-trace worker; a range beyond the window surfaces
// here as a structured error naming the limit and pointing at historical
// search (§9). Trace reads are sensitive because they expose message
// metadata: every query requires `Exchange.MailTools.Read` or `Exchange.MailSearch.Execute`
// (§7) intersected with the caller tenant scope, and every executed query is
// reported through the optional recordAudit seam (§8). Message data stays
// live in EXO (§5); the injected provider is backed by the worker queue
// running the get-message-trace child job, so this module holds no M365 SDK
// call and issues no tenant write.
import { AppError, ErrorCodes } from "../errors.js";
import { parsePagination } from "../pagination.js";
import { requireTenantInScope, type Caller } from "../rbac/authorize.js";
import type { RequestContext, Route, RouteResponse } from "../server.js";

export const MESSAGE_TRACE_PATH = "/v1/tenants/:tenantId/mail/message-trace";
export const MESSAGE_TRACE_READ_PERMISSION = "Exchange.MailTools.Read";
export const MESSAGE_TRACE_SEARCH_PERMISSION = "Exchange.MailSearch.Execute";
export const MESSAGE_TRACE_UNAUTHENTICATED = "request.unauthenticated";
export const MESSAGE_TRACE_WINDOW_EXCEEDED = "message-trace.window_exceeded";

export interface MessageTraceInput {
  readonly sender?: string;
  readonly recipient?: string;
  readonly subject?: string;
  readonly status?: string;
  readonly startDate?: string;
  readonly endDate?: string;
}

export interface MessageTraceFilter extends MessageTraceInput {
  readonly cursor: string | null;
  readonly limit: number;
}

export interface MessageTraceRow {
  readonly timestamp: string;
  readonly sender: string;
  readonly recipient: string;
  readonly subject: string;
  readonly status: string;
  readonly event: string;
}

export interface MessageTracePage {
  readonly tenantId: string;
  readonly items: readonly MessageTraceRow[];
  readonly nextCursor: string | null;
  readonly totalCount: number;
  readonly retrievedAt: string;
}

export interface MessageTraceAuditEvent {
  readonly id?: string;
  readonly tenantId: string;
  readonly action: "mail.message_trace.query";
  readonly timestamp?: string;
  readonly sender?: string;
  readonly recipient?: string;
  readonly subject?: string;
  readonly status?: string;
  readonly startDate?: string;
  readonly endDate?: string;
  readonly resultCount: number;
}

// Queue-backed seam for the trace query: the production wiring enqueues a
// get-message-trace worker job for (tenantId, filter) and serves the worker
// result. Depending on the seam keeps EXO and process code out of the BFF.
export interface MessageTraceProvider {
  traceMessages(tenantId: string, filter: MessageTraceFilter): Promise<MessageTracePage>;
}

export interface MessageTraceCaller extends Caller {
  readonly userId?: string;
}

export type MessageTraceAuthorizer = (
  caller: MessageTraceCaller,
  permission: string,
) => void | Promise<void>;

export interface MessageTraceRouteOptions {
  readonly provider: MessageTraceProvider;
  readonly resolveCaller: (ctx: RequestContext) => MessageTraceCaller | undefined;
  readonly authorize?: MessageTraceAuthorizer;
  readonly recordAudit?: (event: MessageTraceAuditEvent) => void | Promise<void>;
  readonly idGenerator?: () => string;
  readonly now?: () => string;
}

function unauthenticatedError(): AppError {
  return new AppError(MESSAGE_TRACE_UNAUTHENTICATED, "authentication required", 401);
}

function validationError(message: string, field: string): AppError {
  return new AppError(ErrorCodes.validationFailed, message, 400, [
    { field, reason: "invalid" },
  ]);
}

// The worker reports the window breach as a PowerShell error string; the code
// prefix is stripped so the API message stays client-safe while still naming
// the limit the worker enforced.
export function messageTraceWindowExceededError(detail: string): AppError {
  const message = detail.replace(/^message-trace\.window_exceeded:\s*/i, "");
  return new AppError(
    MESSAGE_TRACE_WINDOW_EXCEEDED,
    message.length > 0
      ? message
      : "the requested date range is beyond the EXO message trace window; use historical search for older messages",
    400,
    [{ field: "dateRange", reason: "window_exceeded" }],
  );
}

function requireCaller(
  resolveCaller: (ctx: RequestContext) => MessageTraceCaller | undefined,
  ctx: RequestContext,
): MessageTraceCaller {
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

async function requireMessageTraceAccess(
  options: MessageTraceRouteOptions,
  caller: MessageTraceCaller,
): Promise<void> {
  if (options.authorize) {
    await options.authorize(caller, MESSAGE_TRACE_READ_PERMISSION);
    return;
  }
  const permissions = caller.permissions ?? [];
  const hasAccess =
    permissions.includes(MESSAGE_TRACE_READ_PERMISSION) ||
    permissions.includes(MESSAGE_TRACE_SEARCH_PERMISSION) ||
    permissions.includes("*");
  if (!hasAccess) {
    throw new AppError(
      ErrorCodes.forbidden,
      "forbidden: missing Exchange.MailTools.Read or Exchange.MailSearch.Execute",
      403,
    );
  }
}

function readBodyRecord(ctx: RequestContext): Record<string, unknown> {
  return (ctx.body ?? {}) as Record<string, unknown>;
}

export function parseMessageTraceInput(body: Record<string, unknown>): MessageTraceInput {
  const input: {
    sender?: string;
    recipient?: string;
    subject?: string;
    status?: string;
    startDate?: string;
    endDate?: string;
  } = {};

  for (const field of ["sender", "recipient", "subject", "status"] as const) {
    const value = body[field];
    if (value !== undefined) {
      if (typeof value !== "string" || value.trim().length === 0) {
        throw validationError(`${field} must be a non-empty string`, field);
      }
      input[field] = value.trim();
    }
  }

  for (const field of ["startDate", "endDate"] as const) {
    const value = body[field];
    if (value !== undefined) {
      if (typeof value !== "string" || value.trim().length === 0) {
        throw validationError(`${field} must be a non-empty datetime string`, field);
      }
      if (Number.isNaN(Date.parse(value))) {
        throw validationError(`${field} must be a parseable datetime`, field);
      }
      input[field] = value.trim();
    }
  }
  if (input.startDate !== undefined && input.endDate !== undefined) {
    if (Date.parse(input.startDate) > Date.parse(input.endDate)) {
      throw validationError("startDate must not be after endDate", "startDate");
    }
  }

  return input;
}

export function createMessageTraceRoutes(options: MessageTraceRouteOptions): Route[] {
  const traceHandler = async (ctx: RequestContext): Promise<RouteResponse> => {
    const caller = requireCaller(options.resolveCaller, ctx);
    const tenantId = requireTenantParam(ctx);

    requireTenantInScope(caller, tenantId);
    await requireMessageTraceAccess(options, caller);

    const input = parseMessageTraceInput(readBodyRecord(ctx));
    const pagination = parsePagination(ctx.query);
    const filter: MessageTraceFilter = { ...input, cursor: pagination.cursor, limit: pagination.limit };

    let page: MessageTracePage;
    try {
      page = await options.provider.traceMessages(tenantId, filter);
    } catch (error) {
      if (error instanceof AppError) {
        throw error;
      }
      const message = error instanceof Error ? error.message : "";
      if (/window_exceeded|trace window/i.test(message)) {
        throw messageTraceWindowExceededError(message);
      }
      throw error;
    }

    if (options.recordAudit) {
      const generateId =
        options.idGenerator ?? (() => `${Date.now()}-${Math.random().toString(36).slice(2)}`);
      const now = options.now ?? (() => new Date().toISOString());
      await options.recordAudit({
        id: generateId(),
        tenantId,
        action: "mail.message_trace.query",
        timestamp: now(),
        sender: filter.sender,
        recipient: filter.recipient,
        subject: filter.subject,
        status: filter.status,
        startDate: filter.startDate,
        endDate: filter.endDate,
        resultCount: page.items.length,
      });
    }

    return {
      status: 200,
      headers: { "content-type": "application/json" },
      body: page,
    };
  };

  return [{ method: "POST", path: MESSAGE_TRACE_PATH, handler: traceHandler }];
}

// Route modules own their OpenAPI path items (portal.v1.yaml `paths` is empty
// by design); a wiring ticket merges this fragment into the served document.
export const MESSAGE_TRACE_OPENAPI = {
  paths: {
    "/tenants/{tenantId}/mail/message-trace": {
      post: {
        operationId: "traceMessages",
        summary:
          "Trace messages by sender, recipient, subject, date range, and status within the EXO message trace window",
        permission: MESSAGE_TRACE_READ_PERMISSION,
        security: [{ bearerAuth: [] }],
        parameters: [
          { name: "tenantId", in: "path", required: true, schema: { type: "string" } },
          { name: "cursor", in: "query", required: false, schema: { type: "string" } },
          { name: "limit", in: "query", required: false, schema: { type: "integer" } },
        ],
        responses: {
          "200": {
            description:
              "Cursor-paginated message trace rows (Timestamp, Sender, Recipient, Subject, Status, Event).",
          },
          "400": {
            description:
              "The filter is invalid or the date range is beyond the EXO message trace window.",
          },
          "401": { description: "Authentication required." },
          "403": {
            description:
              "The caller lacks Exchange.MailTools.Read or Exchange.MailSearch.Execute, or the tenant is out of scope.",
          },
        },
      },
    },
  },
} as const;
