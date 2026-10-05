// Message viewer detail read (EPIC-024 SPEC.md §2 US-3, §3.3, §4.1, §6, §9, §11.2; T-0464).
// Exposes GET /v1/tenants/:tenantId/mail/messages/:messageId: the full delivery
// timeline (events, connectors, filters hit) and headers, read-only. Metadata
// and headers ship to every permitted caller; the message body is behind the
// higher Exchange.MailContent.Reveal permission (§11.2) — without it the provider runs
// ungated-off (includeBody false) and the response reports the body as gated
// rather than 403ing the whole read. Reads require `Exchange.MailTools.Read`
// intersected with the caller tenant scope, and every successful read is
// reported through the optional recordAudit seam (§9: audit every read) since
// the viewer exposes message metadata. Message data stays live in EXO (§5);
// the injected provider is backed by the worker queue running the
// get-message-detail child job, so this module holds no M365 SDK call and
// issues no tenant write.
import { AppError, ErrorCodes } from "../errors.js";
import { requireTenantInScope, type Caller } from "../rbac/authorize.js";
import type { RequestContext, Route, RouteResponse } from "../server.js";

export const MESSAGE_DETAIL_PATH = "/v1/tenants/:tenantId/mail/messages/:messageId";
export const MESSAGES_READ_PERMISSION = "Exchange.MailTools.Read";
export const MESSAGES_CONTENT_PERMISSION = "Exchange.MailContent.Reveal";
export const MESSAGES_UNAUTHENTICATED = "request.unauthenticated";
export const MESSAGE_NOT_FOUND = "messages.not_found";

export interface MessageDeliveryEvent {
  readonly timestamp: string;
  readonly event: string;
  readonly detail: string;
}

export interface MessageHeader {
  readonly name: string;
  readonly value: string;
}

export interface MessageDetail {
  readonly tenantId: string;
  readonly messageId: string;
  readonly subject: string;
  readonly sender: string;
  readonly recipients: readonly string[];
  readonly receivedAt: string;
  readonly status: string;
  readonly size: string;
  readonly deliveryEvents: readonly MessageDeliveryEvent[];
  readonly connectors: readonly string[];
  readonly filtersHit: readonly string[];
  readonly headers: readonly MessageHeader[];
  readonly body: string | null;
  readonly bodyGated: boolean;
  readonly bodyGateReason: string;
  readonly retrievedAt: string;
}

export interface MessageReadAuditEvent {
  readonly id?: string;
  readonly tenantId: string;
  readonly action: "mail.message.read";
  readonly targetId: string;
  readonly timestamp?: string;
  readonly includeBody: boolean;
  readonly bodyGated: boolean;
}

// Queue-backed seam for the message read: the production wiring enqueues a
// get-message-detail worker job for (tenantId, messageId, includeBody) and
// serves the worker result. Depending on the seam keeps EXO and process code
// out of the BFF.
export interface MessagesProvider {
  getMessage(
    tenantId: string,
    messageId: string,
    includeBody: boolean,
  ): Promise<MessageDetail | null>;
}

export interface MessagesCaller extends Caller {
  readonly userId?: string;
}

export type MessagesAuthorizer = (
  caller: MessagesCaller,
  permission: string,
) => void | Promise<void>;

export interface MessagesRouteOptions {
  readonly provider: MessagesProvider;
  readonly resolveCaller: (ctx: RequestContext) => MessagesCaller | undefined;
  readonly authorize?: MessagesAuthorizer;
  readonly recordAudit?: (event: MessageReadAuditEvent) => void | Promise<void>;
  readonly idGenerator?: () => string;
  readonly now?: () => string;
}

function unauthenticatedError(): AppError {
  return new AppError(MESSAGES_UNAUTHENTICATED, "authentication required", 401);
}

function requireCaller(
  resolveCaller: (ctx: RequestContext) => MessagesCaller | undefined,
  ctx: RequestContext,
): MessagesCaller {
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

async function requireMessagesRead(
  options: MessagesRouteOptions,
  caller: MessagesCaller,
): Promise<void> {
  if (options.authorize) {
    await options.authorize(caller, MESSAGES_READ_PERMISSION);
    return;
  }
  const permissions = caller.permissions ?? [];
  if (!permissions.includes(MESSAGES_READ_PERMISSION) && !permissions.includes("*")) {
    throw new AppError(ErrorCodes.forbidden, "forbidden: missing Exchange.MailTools.Read", 403);
  }
}

export function hasMessageContentAccess(caller: MessagesCaller): boolean {
  const permissions = caller.permissions ?? [];
  return (
    permissions.includes(MESSAGES_CONTENT_PERMISSION) || permissions.includes("*")
  );
}

export async function getMessageDetail(
  provider: MessagesProvider,
  tenantId: string,
  messageId: string,
  includeBody: boolean,
): Promise<{ status: number; body: MessageDetail }> {
  if (tenantId.trim().length === 0) {
    throw new AppError(ErrorCodes.validationFailed, "tenantId is required", 400, [
      { field: "tenantId", reason: "required" },
    ]);
  }
  if (messageId.trim().length === 0) {
    throw new AppError(ErrorCodes.validationFailed, "messageId is required", 400, [
      { field: "messageId", reason: "required" },
    ]);
  }
  const detail = await provider.getMessage(tenantId, messageId, includeBody);
  if (detail === null || detail === undefined) {
    throw new AppError(MESSAGE_NOT_FOUND, `message '${messageId}' was not found`, 404, [
      { field: "messageId", reason: "not_found" },
    ]);
  }
  return { status: 200, body: detail };
}

export function createMessageRoutes(options: MessagesRouteOptions): Route[] {
  const detailHandler = async (ctx: RequestContext): Promise<RouteResponse> => {
    const caller = requireCaller(options.resolveCaller, ctx);
    const tenantId = requireTenantParam(ctx);
    const messageId = requireMessageParam(ctx);

    requireTenantInScope(caller, tenantId);
    await requireMessagesRead(options, caller);

    const includeBody = hasMessageContentAccess(caller);
    const result = await getMessageDetail(options.provider, tenantId, messageId, includeBody);

    if (options.recordAudit) {
      const generateId = options.idGenerator ?? (() => `${Date.now()}-${Math.random().toString(36).slice(2)}`);
      const now = options.now ?? (() => new Date().toISOString());
      await options.recordAudit({
        id: generateId(),
        tenantId,
        action: "mail.message.read",
        targetId: messageId,
        timestamp: now(),
        includeBody,
        bodyGated: result.body.bodyGated,
      });
    }

    return {
      status: result.status,
      headers: { "content-type": "application/json" },
      body: result.body,
    };
  };

  return [{ method: "GET", path: MESSAGE_DETAIL_PATH, handler: detailHandler }];
}

// Route modules own their OpenAPI path items (portal.v1.yaml `paths` is empty
// by design); a wiring ticket merges this fragment into the served document.
export const MESSAGES_OPENAPI = {
  paths: {
    "/tenants/{tenantId}/mail/messages/{messageId}": {
      get: {
        operationId: "getMessageDetail",
        summary:
          "Message viewer: delivery timeline (events, connectors, filters hit) and headers; the body ships only for callers holding Exchange.MailContent.Reveal and is otherwise reported as gated",
        permission: MESSAGES_READ_PERMISSION,
        security: [{ bearerAuth: [] }],
        parameters: [
          { name: "tenantId", in: "path", required: true, schema: { type: "string" } },
          { name: "messageId", in: "path", required: true, schema: { type: "string" } },
        ],
        responses: {
          "200": {
            description:
              "The message detail with delivery events, connectors, filters hit, headers, and the gated-or-present body.",
          },
          "401": { description: "Authentication required." },
          "403": {
            description: "The caller lacks Exchange.MailTools.Read or the tenant is out of scope.",
          },
          "404": { description: "The message was not found." },
        },
      },
    },
  },
} as const;
