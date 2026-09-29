// Graph webhook subscription lifecycle API (EPIC-032 SPEC.md §3.5, §4.3, §5, §6,
// §7, §8; T-0625).
//
// Exposes the §6 subscription surface: GET/POST /v1/tenants/:tenantId/webhooks,
// DELETE /v1/tenants/:tenantId/webhooks/:subscriptionId, and the §3.5 row actions
// Renew, Recreate, Test (POST .../renew, .../recreate, .../test). Subscription
// management writes to Graph through the manage-webhooks.ps1 worker (SPEC §8) and
// requires the CIPP.Admin.* scope (SPEC §7). Mutations return the worker's auditEvent
// so the response-audit wrapper records it; a failed renewal returns the alertEvent
// (EPIC-029) alongside success=false instead of throwing, so the alert survives.
import { AppError, ErrorCodes } from "../errors.js";
import { requireTenantInScope, type Caller } from "../rbac/authorize.js";
import type { RequestContext, Route, RouteResponse } from "../server.js";

export const WEBHOOKS_PATH = "/v1/tenants/:tenantId/webhooks";
export const WEBHOOKS_ITEM_PATH = "/v1/tenants/:tenantId/webhooks/:subscriptionId";
export const WEBHOOKS_RENEW_PATH = "/v1/tenants/:tenantId/webhooks/:subscriptionId/renew";
export const WEBHOOKS_RECREATE_PATH = "/v1/tenants/:tenantId/webhooks/:subscriptionId/recreate";
export const WEBHOOKS_TEST_PATH = "/v1/tenants/:tenantId/webhooks/:subscriptionId/test";

export const WEBHOOKS_ADMIN_SCOPE = "CIPP.Admin.*";

export const WEBHOOKS_UNAUTHENTICATED = "request.unauthenticated";
export const WEBHOOKS_FORBIDDEN = "auth.forbidden";
export const WEBHOOKS_NOT_CONFIGURED = "webhooks.not_configured";
export const WEBHOOKS_BAD_REQUEST = "request.validation_failed";

export const WEBHOOK_RESOURCES = ["users", "groups", "policies"] as const;

export type WebhookResource = (typeof WEBHOOK_RESOURCES)[number];

export type WebhookSubscriptionState = "active" | "expiring" | "expired";

export interface WebhookSubscription {
  readonly id: string;
  readonly tenantId: string;
  readonly resource: string;
  readonly notificationUrl?: string;
  readonly clientState?: string;
  readonly expirationDateTime: string;
  readonly state: WebhookSubscriptionState;
}

export interface WebhookAuditEvent {
  readonly id: string;
  readonly tenantId: string;
  readonly action: string;
  readonly targetId: string;
  readonly targetName: string;
  readonly timestamp: string;
  readonly before?: Record<string, unknown>;
  readonly after?: Record<string, unknown>;
  readonly note?: string;
}

export interface WebhookAlertEvent {
  readonly kind: string;
  readonly severity: string;
  readonly tenantId: string;
  readonly subscriptionId: string;
  readonly resource: string;
  readonly reason: string;
  readonly timestamp: string;
}

export interface WebhookListResult {
  readonly success: boolean;
  readonly tenantId: string;
  readonly subscriptions: readonly WebhookSubscription[];
}

export interface WebhookMutationResult {
  readonly success: boolean;
  readonly subscription?: WebhookSubscription;
  readonly error?: string;
  readonly alertEvent?: WebhookAlertEvent;
  readonly auditEvent?: WebhookAuditEvent;
}

export interface WebhookDeleteResult {
  readonly success: boolean;
  readonly deleted: string;
  readonly auditEvent?: WebhookAuditEvent;
}

export interface WebhookTestResult {
  readonly success: boolean;
  readonly subscription: WebhookSubscription;
  readonly healthy: boolean;
}

// Seam over the manage-webhooks.ps1 worker: the production wiring runs the
// entrypoint with the tenant's credential block; tests inject a fake.
export interface WebhooksProvider {
  list(tenantId: string): Promise<WebhookListResult>;
  create(tenantId: string, input: { resource: string; notificationUrl: string }): Promise<WebhookMutationResult>;
  renew(tenantId: string, subscriptionId: string): Promise<WebhookMutationResult>;
  recreate(tenantId: string, subscriptionId: string): Promise<WebhookMutationResult>;
  remove(tenantId: string, subscriptionId: string): Promise<WebhookDeleteResult>;
  test(tenantId: string, subscriptionId: string): Promise<WebhookTestResult>;
}

export interface WebhooksCaller extends Caller {
  readonly userId?: string;
}

export type WebhooksAuthorizer = (
  caller: WebhooksCaller,
  permission: string,
) => void | Promise<void>;

export interface WebhooksRequestContext extends RequestContext {
  readonly body?: unknown;
}

export interface WebhooksRouteOptions {
  readonly provider: WebhooksProvider;
  readonly resolveCaller: (ctx: RequestContext) => WebhooksCaller | undefined;
  readonly authorize?: WebhooksAuthorizer;
  /** Public URL of the notification receiver; create fails with 501 when unset. */
  readonly notificationUrl?: string;
  readonly readBody?: (ctx: WebhooksRequestContext) => unknown;
}

function unauthenticatedError(): AppError {
  return new AppError(WEBHOOKS_UNAUTHENTICATED, "authentication required", 401);
}

function forbiddenError(): AppError {
  return new AppError(WEBHOOKS_FORBIDDEN, `forbidden: requires ${WEBHOOKS_ADMIN_SCOPE}`, 403);
}

function validationError(message: string, field: string): AppError {
  return new AppError(ErrorCodes.validationFailed, message, 400, [
    { field, reason: "invalid" },
  ]);
}

function requireCaller(
  resolveCaller: (ctx: RequestContext) => WebhooksCaller | undefined,
  ctx: RequestContext,
): WebhooksCaller {
  const caller = resolveCaller(ctx);
  if (caller === undefined) {
    throw unauthenticatedError();
  }
  return caller;
}

async function ensureAdmin(options: WebhooksRouteOptions, caller: WebhooksCaller): Promise<void> {
  if (options.authorize) {
    await options.authorize(caller, WEBHOOKS_ADMIN_SCOPE);
    return;
  }
  const granted = caller.permissions ?? [];
  if (!granted.includes(WEBHOOKS_ADMIN_SCOPE) && !granted.includes("*")) {
    throw forbiddenError();
  }
}

function requireTenantParam(ctx: RequestContext): string {
  const value = ctx.params["tenantId"];
  if (typeof value !== "string" || value.trim().length === 0) {
    throw validationError("tenantId is required", "tenantId");
  }
  return value.trim();
}

function requireSubscriptionParam(ctx: RequestContext): string {
  const value = ctx.params["subscriptionId"];
  if (typeof value !== "string" || value.trim().length === 0) {
    throw validationError("subscriptionId is required", "subscriptionId");
  }
  return value.trim();
}

function readJsonBody(
  ctx: RequestContext,
  readBody: ((ctx: WebhooksRequestContext) => unknown) | undefined,
): Record<string, unknown> {
  let body = readBody ? readBody(ctx as WebhooksRequestContext) : (ctx as WebhooksRequestContext).body;
  if (body === undefined) {
    return {};
  }
  if (typeof body === "string") {
    try {
      body = JSON.parse(body);
    } catch {
      throw validationError("request body is not valid JSON", "body");
    }
  }
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    throw validationError("request body must be a JSON object", "body");
  }
  return body as Record<string, unknown>;
}

function parseResource(body: Record<string, unknown>): string {
  const resource = body["resource"];
  if (typeof resource !== "string" || resource.trim().length === 0) {
    throw validationError("resource is required", "resource");
  }
  if (!(WEBHOOK_RESOURCES as readonly string[]).includes(resource)) {
    throw validationError(
      `resource must be one of: ${WEBHOOK_RESOURCES.join(", ")}`,
      "resource",
    );
  }
  return resource;
}

export function createWebhooksRoutes(options: WebhooksRouteOptions): Route[] {
  const listHandler = async (ctx: RequestContext): Promise<RouteResponse> => {
    const caller = requireCaller(options.resolveCaller, ctx);
    const tenantId = requireTenantParam(ctx);
    requireTenantInScope(caller, tenantId);
    await ensureAdmin(options, caller);

    const result = await options.provider.list(tenantId);
    return {
      status: 200,
      headers: { "content-type": "application/json" },
      body: result,
    };
  };

  const createHandler = async (ctx: RequestContext): Promise<RouteResponse> => {
    const caller = requireCaller(options.resolveCaller, ctx);
    const tenantId = requireTenantParam(ctx);
    requireTenantInScope(caller, tenantId);
    await ensureAdmin(options, caller);

    if (options.notificationUrl === undefined || options.notificationUrl.length === 0) {
      throw new AppError(
        WEBHOOKS_NOT_CONFIGURED,
        "webhook notification URL is not configured; set one before creating subscriptions",
        501,
      );
    }
    const body = readJsonBody(ctx, options.readBody);
    const resource = parseResource(body);

    const result = await options.provider.create(tenantId, {
      resource,
      notificationUrl: options.notificationUrl,
    });
    return {
      status: 200,
      headers: { "content-type": "application/json" },
      body: result,
    };
  };

  const deleteHandler = async (ctx: RequestContext): Promise<RouteResponse> => {
    const caller = requireCaller(options.resolveCaller, ctx);
    const tenantId = requireTenantParam(ctx);
    const subscriptionId = requireSubscriptionParam(ctx);
    requireTenantInScope(caller, tenantId);
    await ensureAdmin(options, caller);

    const result = await options.provider.remove(tenantId, subscriptionId);
    return {
      status: 200,
      headers: { "content-type": "application/json" },
      body: result,
    };
  };

  const renewHandler = async (ctx: RequestContext): Promise<RouteResponse> => {
    const caller = requireCaller(options.resolveCaller, ctx);
    const tenantId = requireTenantParam(ctx);
    const subscriptionId = requireSubscriptionParam(ctx);
    requireTenantInScope(caller, tenantId);
    await ensureAdmin(options, caller);

    const result = await options.provider.renew(tenantId, subscriptionId);
    return {
      status: 200,
      headers: { "content-type": "application/json" },
      body: result,
    };
  };

  const recreateHandler = async (ctx: RequestContext): Promise<RouteResponse> => {
    const caller = requireCaller(options.resolveCaller, ctx);
    const tenantId = requireTenantParam(ctx);
    const subscriptionId = requireSubscriptionParam(ctx);
    requireTenantInScope(caller, tenantId);
    await ensureAdmin(options, caller);

    const result = await options.provider.recreate(tenantId, subscriptionId);
    return {
      status: 200,
      headers: { "content-type": "application/json" },
      body: result,
    };
  };

  const testHandler = async (ctx: RequestContext): Promise<RouteResponse> => {
    const caller = requireCaller(options.resolveCaller, ctx);
    const tenantId = requireTenantParam(ctx);
    const subscriptionId = requireSubscriptionParam(ctx);
    requireTenantInScope(caller, tenantId);
    await ensureAdmin(options, caller);

    const result = await options.provider.test(tenantId, subscriptionId);
    return {
      status: 200,
      headers: { "content-type": "application/json" },
      body: result,
    };
  };

  return [
    { method: "GET", path: WEBHOOKS_PATH, handler: listHandler },
    { method: "POST", path: WEBHOOKS_PATH, handler: createHandler },
    { method: "DELETE", path: WEBHOOKS_ITEM_PATH, handler: deleteHandler },
    { method: "POST", path: WEBHOOKS_RENEW_PATH, handler: renewHandler },
    { method: "POST", path: WEBHOOKS_RECREATE_PATH, handler: recreateHandler },
    { method: "POST", path: WEBHOOKS_TEST_PATH, handler: testHandler },
  ];
}

// Route modules own their OpenAPI path items (portal.v1.yaml `paths` is empty
// by design); a wiring ticket merges this fragment into the served document.
export const WEBHOOKS_OPENAPI = {
  paths: {
    "/tenants/{tenantId}/webhooks": {
      get: {
        operationId: "listWebhookSubscriptions",
        summary: "List the tenant's Graph webhook subscriptions with computed state",
        permission: WEBHOOKS_ADMIN_SCOPE,
        security: [{ bearerAuth: [] }],
        parameters: [
          { name: "tenantId", in: "path", required: true, schema: { type: "string" } },
        ],
        responses: {
          "200": { description: "The tenant's subscriptions with active/expiring/expired state." },
          "401": { description: "Authentication required." },
          "403": { description: "The caller lacks the CIPP.Admin.* scope." },
        },
      },
      post: {
        operationId: "createWebhookSubscription",
        summary: "Subscribe to Graph change notifications for a required resource",
        permission: WEBHOOKS_ADMIN_SCOPE,
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
                required: ["resource"],
                properties: {
                  resource: { type: "string", enum: [...WEBHOOK_RESOURCES] },
                },
              },
            },
          },
        },
        responses: {
          "200": { description: "The created subscription and its audit event." },
          "400": { description: "The body is invalid or names an unsupported resource." },
          "401": { description: "Authentication required." },
          "403": { description: "The caller lacks the CIPP.Admin.* scope." },
          "501": { description: "The webhook notification URL is not configured." },
        },
      },
    },
    "/tenants/{tenantId}/webhooks/{subscriptionId}": {
      delete: {
        operationId: "deleteWebhookSubscription",
        summary: "Delete a Graph webhook subscription",
        permission: WEBHOOKS_ADMIN_SCOPE,
        security: [{ bearerAuth: [] }],
        parameters: [
          { name: "tenantId", in: "path", required: true, schema: { type: "string" } },
          { name: "subscriptionId", in: "path", required: true, schema: { type: "string" } },
        ],
        responses: {
          "200": { description: "The deleted subscription id and its audit event." },
          "401": { description: "Authentication required." },
          "403": { description: "The caller lacks the CIPP.Admin.* scope." },
        },
      },
    },
    "/tenants/{tenantId}/webhooks/{subscriptionId}/renew": {
      post: {
        operationId: "renewWebhookSubscription",
        summary: "Renew a subscription's expiration before it expires",
        permission: WEBHOOKS_ADMIN_SCOPE,
        security: [{ bearerAuth: [] }],
        parameters: [
          { name: "tenantId", in: "path", required: true, schema: { type: "string" } },
          { name: "subscriptionId", in: "path", required: true, schema: { type: "string" } },
        ],
        responses: {
          "200": { description: "The renewed subscription, or success=false with the renewal-failure alert." },
          "401": { description: "Authentication required." },
          "403": { description: "The caller lacks the CIPP.Admin.* scope." },
        },
      },
    },
    "/tenants/{tenantId}/webhooks/{subscriptionId}/recreate": {
      post: {
        operationId: "recreateWebhookSubscription",
        summary: "Replace a subscription with a fresh one for the same resource",
        permission: WEBHOOKS_ADMIN_SCOPE,
        security: [{ bearerAuth: [] }],
        parameters: [
          { name: "tenantId", in: "path", required: true, schema: { type: "string" } },
          { name: "subscriptionId", in: "path", required: true, schema: { type: "string" } },
        ],
        responses: {
          "200": { description: "The recreated subscription and its audit event." },
          "401": { description: "Authentication required." },
          "403": { description: "The caller lacks the CIPP.Admin.* scope." },
        },
      },
    },
    "/tenants/{tenantId}/webhooks/{subscriptionId}/test": {
      post: {
        operationId: "testWebhookSubscription",
        summary: "Check a subscription exists and is not expired",
        permission: WEBHOOKS_ADMIN_SCOPE,
        security: [{ bearerAuth: [] }],
        parameters: [
          { name: "tenantId", in: "path", required: true, schema: { type: "string" } },
          { name: "subscriptionId", in: "path", required: true, schema: { type: "string" } },
        ],
        responses: {
          "200": { description: "The subscription with a healthy flag." },
          "401": { description: "Authentication required." },
          "403": { description: "The caller lacks the CIPP.Admin.* scope." },
        },
      },
    },
  },
} as const;
