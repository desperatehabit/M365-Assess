// Graph webhook notification receiver (EPIC-032 SPEC.md §3.5, §4.3, §6, §11.2;
// T-0625).
//
// Unauthenticated endpoint that receives Graph change notifications for the
// tenant's webhook subscriptions. Graph cannot carry portal credentials, so the
// clientState issued at subscribe time is the authentication: every notification
// value must carry the clientState its subscription was created with, or the
// whole request is rejected with 401. Valid notifications are matched to their
// resource, recorded by reference, and dispatched to the alert/cache seam
// (EPIC-029). Content-bundle processing is deferred (SPEC §11.2): an encrypted
// content payload is acknowledged and stored by reference only — this route
// never reads, decrypts, or downloads notification content. The route also
// answers Graph's subscription-validation handshake (validationToken), which the
// create action needs to succeed.
import { AppError, ErrorCodes } from "../errors.js";
import type { RequestContext, Route, RouteResponse } from "../server.js";

export const WEBHOOK_NOTIFY_PATH = "/v1/webhooks/notify";

export const WEBHOOK_NOTIFY_UNAUTHENTICATED = "request.unauthenticated";
export const WEBHOOK_NOTIFY_INVALID_CLIENT_STATE = "webhooks.notify_invalid_client_state";
export const WEBHOOK_NOTIFY_BAD_REQUEST = "request.validation_failed";

export type WebhookSubscriptionState = "active" | "expiring" | "expired";

export interface WebhookNotifySubscriptionRecord {
  readonly tenantId: string;
  readonly clientState: string;
  readonly resource?: string;
  readonly state?: WebhookSubscriptionState;
}

export interface WebhookNotificationReference {
  readonly subscriptionId: string;
  readonly tenantId: string;
  readonly resource: string;
  readonly changeType: string;
  readonly receivedAt: string;
}

export interface WebhookDispatchedNotification {
  readonly subscriptionId: string;
  readonly tenantId: string;
  readonly resource: string;
  readonly changeType: string;
  readonly clientState: string;
  readonly receivedAt: string;
}

// Seam over the subscription store: the production wiring resolves the tenant
// and clientState by subscription id; tests inject a fake.
export interface WebhookNotifyStore {
  getSubscription(subscriptionId: string): Promise<WebhookNotifySubscriptionRecord | undefined>;
  recordNotification(reference: WebhookNotificationReference): Promise<void>;
}

// Seam for the §4.3 dispatch step: matches the resource to rules and fans out
// to alerts (EPIC-029) and caches. Depending on the seam keeps Graph code and
// alerting out of the BFF.
export interface WebhookNotifyDispatcher {
  dispatch(notification: WebhookDispatchedNotification): Promise<void>;
}

export interface WebhookNotifyRouteOptions {
  readonly store: WebhookNotifyStore;
  readonly dispatch: WebhookNotifyDispatcher;
  readonly readBody?: (ctx: RequestContext) => unknown;
  readonly now?: () => string;
}

function validationError(message: string, field: string): AppError {
  return new AppError(ErrorCodes.validationFailed, message, 400, [
    { field, reason: "invalid" },
  ]);
}

function invalidClientStateError(): AppError {
  return new AppError(
    WEBHOOK_NOTIFY_INVALID_CLIENT_STATE,
    "notification clientState does not match the subscription",
    401,
  );
}

function readJsonBody(
  ctx: RequestContext,
  readBody: ((ctx: RequestContext) => unknown) | undefined,
): Record<string, unknown> {
  const body = readBody ? readBody(ctx) : ctx.body;
  if (body === undefined || body === null) {
    return {};
  }
  if (typeof body === "string") {
    try {
      const parsed = JSON.parse(body);
      if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
        throw validationError("request body must be a JSON object", "body");
      }
      return parsed as Record<string, unknown>;
    } catch (error) {
      if (error instanceof AppError) {
        throw error;
      }
      throw validationError("request body is not valid JSON", "body");
    }
  }
  if (typeof body !== "object" || Array.isArray(body)) {
    throw validationError("request body must be a JSON object", "body");
  }
  return body as Record<string, unknown>;
}

function notificationValues(body: Record<string, unknown>): Record<string, unknown>[] {
  const value = body["value"];
  if (!Array.isArray(value)) {
    throw validationError("notification body must carry a value array", "value");
  }
  for (const entry of value) {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
      throw validationError("every notification value must be a JSON object", "value");
    }
  }
  return value as Record<string, unknown>[];
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw validationError(`${field} is required on every notification`, field);
  }
  return value;
}

function echoValidationToken(ctx: RequestContext): RouteResponse | null {
  const token = ctx.query.get("validationToken");
  if (token === null || token.length === 0) {
    return null;
  }
  return {
    status: 200,
    contentType: "text/plain; charset=utf-8",
    raw: token,
  };
}

export async function handleWebhookNotify(
  options: WebhookNotifyRouteOptions,
  ctx: RequestContext,
): Promise<RouteResponse> {
  const handshake = echoValidationToken(ctx);
  if (handshake !== null) {
    return handshake;
  }

  const now = options.now ?? (() => new Date().toISOString());
  const body = readJsonBody(ctx, options.readBody);
  const values = notificationValues(body);
  const receivedAt = now();

  const references: WebhookNotificationReference[] = [];
  for (const value of values) {
    const subscriptionId = requireString(value["subscriptionId"], "subscriptionId");
    const clientState = requireString(value["clientState"], "clientState");
    const resource = requireString(value["resource"], "resource");
    const changeType = requireString(value["changeType"], "changeType");

    const record = await options.store.getSubscription(subscriptionId);
    if (record === undefined || record.clientState !== clientState) {
      throw invalidClientStateError();
    }

    const reference: WebhookNotificationReference = {
      subscriptionId,
      tenantId: record.tenantId,
      resource,
      changeType,
      receivedAt,
    };
    await options.store.recordNotification(reference);
    await options.dispatch.dispatch({
      subscriptionId,
      tenantId: record.tenantId,
      resource,
      changeType,
      clientState,
      receivedAt,
    });
    references.push(reference);
  }

  return {
    status: 200,
    headers: { "content-type": "application/json" },
    body: { received: references.length, references },
  };
}

export function createWebhookNotifyRoute(options: WebhookNotifyRouteOptions): Route[] {
  return [
    {
      method: "POST",
      path: WEBHOOK_NOTIFY_PATH,
      handler: (ctx: RequestContext): Promise<RouteResponse> => handleWebhookNotify(options, ctx),
    },
  ];
}

// Route modules own their OpenAPI path items (portal.v1.yaml `paths` is empty
// by design); a wiring ticket merges this fragment into the served document.
// The receiver is unauthenticated — clientState is the credential (SPEC §4.3) —
// so the fragment records no portal permission.
export const WEBHOOK_NOTIFY_OPENAPI = {
  paths: {
    "/webhooks/notify": {
      post: {
        operationId: "receiveWebhookNotification",
        summary: "Receive Graph change notifications; clientState is the authentication",
        security: [],
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["value"],
                properties: {
                  value: {
                    type: "array",
                    items: {
                      type: "object",
                      required: ["subscriptionId", "clientState", "resource", "changeType"],
                      properties: {
                        subscriptionId: { type: "string" },
                        clientState: { type: "string" },
                        resource: { type: "string" },
                        changeType: { type: "string" },
                      },
                    },
                  },
                },
              },
            },
          },
        },
        responses: {
          "200": { description: "The notifications were accepted and dispatched." },
          "400": { description: "The body is not a valid notification batch." },
          "401": { description: "A notification carried an invalid clientState." },
        },
      },
    },
  },
} as const;
