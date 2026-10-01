// Notification channel configuration API (EPIC-029 SPEC.md §2 US-5, §3.4, §6,
// §7, §9; T-0566).
//
//   GET  /v1/notifications        -> configured channels with enabled state
//   PUT  /v1/notifications        -> update one channel's target/enabled (audited)
//   POST /v1/notifications/test   -> test-send a channel through its T-0565 adapter
//
// Reads require `alerts.read`; writes and test-send require `alerts.write`, via
// the same EPIC-001 authorizer seam as alert-rules.ts (alerts.* is not in the
// roles.ts union yet, EPIC-038). PSA and Slack are exposed in the schema but have
// no adapter yet (PSA is deferred to EPIC-041, SPEC §11.3), so a test-send for
// them fails with a structured 501 instead of silently succeeding. A channel
// target is secret-bearing (recipient address, webhook URL): credentials stay
// referenced in the EPIC-002 store (SPEC §9) — this route never accepts or
// returns one — and audit events record that a target changed, never its value.
// A test-send runs the real adapter without its meta-alert port and records no
// AlertEvent (SPEC §4.3 meta-alerts are for real deliveries only).
import { randomUUID } from "node:crypto";
import {
  isAlertChannel,
  type AlertChannel,
} from "../domain/alerts/builtin-catalog.js";
import type {
  DeliveryAttempt,
  DeliveryChannel,
  DeliveryChannelConfig,
  DeliveryEvent,
  DeliveryOutcome,
} from "../domain/alerts/delivery/email.js";
import { AppError, ErrorCodes } from "../errors.js";
import { requirePermission, type Caller } from "../rbac/authorize.js";
import type { Permission } from "../rbac/roles.js";
import type { RequestContext, Route, RouteResponse } from "../server.js";

export const NOTIFICATIONS_PATH = "/v1/notifications";
export const NOTIFICATIONS_TEST_PATH = "/v1/notifications/test";

export const NOTIFICATIONS_READ_PERMISSION = "alerts.read";
export const NOTIFICATIONS_WRITE_PERMISSION = "alerts.write";

export const NOTIFICATIONS_UNAUTHENTICATED = "request.unauthenticated";
export const NOTIFICATION_CHANNEL_NOT_FOUND = "notification.channel_not_found";
export const NOTIFICATION_CHANNEL_NOT_SUPPORTED = "notification.channel_not_supported";

// §5 NotificationConfig row, mirrored from contracts/alerting.ts (the bff
// tsconfig rootDir cannot reach the contracts source; the same convention as
// domain/alerts/builtin-catalog.ts).
export interface NotificationConfig {
  readonly id: string;
  readonly channel: AlertChannel;
  readonly target: string;
  readonly enabled: boolean;
}

export interface NotificationConfigPatch {
  readonly target?: string;
  readonly enabled?: boolean;
}

export interface NotificationConfigStore {
  listChannels(): Promise<readonly NotificationConfig[]>;
  getChannel(id: string): Promise<NotificationConfig | undefined>;
  updateChannel(id: string, patch: NotificationConfigPatch): Promise<NotificationConfig | undefined>;
}

export interface NotificationsAuditPort {
  record(event: Record<string, unknown>): Promise<void> | void;
}

// The T-0565 adapter seam (domain/alerts/delivery/{email,webhook}.ts): the
// wiring ticket hands over the real deliveries; tests inject fakes.
export interface NotificationDelivery {
  readonly channel: DeliveryChannel;
  deliver(event: DeliveryEvent, config: DeliveryChannelConfig): Promise<NotificationDeliveryResult>;
}

export interface NotificationDeliveryResult {
  readonly channel: DeliveryChannel;
  readonly outcome: DeliveryOutcome;
  readonly attempts: readonly DeliveryAttempt[];
  readonly metaAlertRaised: boolean;
  readonly error?: string;
}

export interface NotificationsRoutesOptions {
  readonly store: NotificationConfigStore;
  readonly resolveCaller: (ctx: RequestContext) => Caller | undefined;
  readonly authorize?: (caller: Caller, permission: string) => void | Promise<void>;
  readonly audit?: NotificationsAuditPort;
  readonly deliveries?: Readonly<Partial<Record<DeliveryChannel, NotificationDelivery>>>;
  readonly now?: () => string;
  /** Test seam for deterministic event ids; defaults to a random UUID. */
  readonly generateEventId?: () => string;
}

// §9: a target is secret-bearing, so audit events record that it changed, never
// its value (the same redaction contract the delivery adapters enforce).
const REDACTED = "***";

// Reserved-domain placeholders (RFC 2606 .invalid) so a test-send exercises the
// real adapter without a configured target; never a real recipient or URL.
const DEFAULT_TEST_TARGETS: Readonly<Record<DeliveryChannel, string>> = Object.freeze({
  email: "portal-test@example.invalid",
  webhook: "https://portal-test.example.invalid/notifications",
});

function unauthenticatedError(): AppError {
  return new AppError(NOTIFICATIONS_UNAUTHENTICATED, "authentication required", 401);
}

function validationError(message: string, field: string, reason = "invalid"): AppError {
  return new AppError(ErrorCodes.validationFailed, message, 400, [{ field, reason }]);
}

function notFoundError(id: string): AppError {
  return new AppError(NOTIFICATION_CHANNEL_NOT_FOUND, `Notification channel ${id} not found`, 404);
}

function notSupportedError(channel: AlertChannel): AppError {
  const reason =
    channel === "psa"
      ? "PSA ticket creation is deferred to EPIC-041 (SPEC §11.3)"
      : channel === "slack"
        ? "Slack delivery is future work (SPEC §11.2)"
        : "no delivery adapter is wired for this channel";
  return new AppError(
    NOTIFICATION_CHANNEL_NOT_SUPPORTED,
    `${channel} delivery is not yet supported: ${reason}`,
    501,
  );
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function requireCaller(options: NotificationsRoutesOptions, ctx: RequestContext): Caller {
  const caller = options.resolveCaller(ctx);
  if (!caller) {
    throw unauthenticatedError();
  }
  return caller;
}

async function ensureAuthorized(
  options: NotificationsRoutesOptions,
  caller: Caller,
  permission: string,
): Promise<void> {
  if (options.authorize) {
    await options.authorize(caller, permission);
    return;
  }
  // alerts.* is not in the roles.ts union yet (EPIC-038); deny without a seam.
  requirePermission(caller, permission as Permission);
}

function requireText(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw validationError(`${field} must be a non-empty string`, field);
  }
  return value.trim();
}

function parsePatchInput(body: Record<string, unknown>): NotificationConfigPatch {
  const patch: { target?: string; enabled?: boolean } = {};
  if (body["target"] !== undefined) {
    patch.target = requireText(body["target"], "target");
  }
  if (body["enabled"] !== undefined) {
    if (typeof body["enabled"] !== "boolean") {
      throw validationError("enabled must be a boolean", "enabled");
    }
    patch.enabled = body["enabled"];
  }
  if (patch.target === undefined && patch.enabled === undefined) {
    throw validationError("target or enabled is required", "body", "required");
  }
  return patch;
}

function requireTestChannel(value: unknown): AlertChannel {
  if (!isAlertChannel(value)) {
    throw validationError("channel must be a known notification channel", "channel");
  }
  return value;
}

export function createNotificationRoutes(options: NotificationsRoutesOptions): Route[] {
  const now = options.now ?? (() => new Date().toISOString());

  async function recordAudit(
    ctx: RequestContext,
    event: Record<string, unknown>,
  ): Promise<void> {
    if (options.audit) {
      await options.audit.record({ correlationId: ctx.correlationId, ...event });
    }
  }

  async function handleList(ctx: RequestContext): Promise<RouteResponse> {
    const caller = requireCaller(options, ctx);
    await ensureAuthorized(options, caller, NOTIFICATIONS_READ_PERMISSION);
    const channels = await options.store.listChannels();
    return {
      status: 200,
      headers: { "content-type": "application/json" },
      body: { channels },
    };
  }

  async function handleUpdate(ctx: RequestContext): Promise<RouteResponse> {
    const caller = requireCaller(options, ctx);
    await ensureAuthorized(options, caller, NOTIFICATIONS_WRITE_PERMISSION);
    const body = asRecord(ctx.body);
    const id = requireText(body["id"], "id");
    const patch = parsePatchInput(body);
    const updated = await options.store.updateChannel(id, patch);
    if (!updated) {
      throw notFoundError(id);
    }
    await recordAudit(ctx, {
      action: "notification-channel.update",
      channelId: id,
      channel: updated.channel,
      fields: Object.keys(patch),
      ...(patch.target !== undefined ? { target: REDACTED } : {}),
    });
    return {
      status: 200,
      headers: { "content-type": "application/json" },
      body: { channel: updated },
    };
  }

  async function handleTest(ctx: RequestContext): Promise<RouteResponse> {
    const caller = requireCaller(options, ctx);
    await ensureAuthorized(options, caller, NOTIFICATIONS_WRITE_PERMISSION);
    const body = asRecord(ctx.body);
    const channel = requireTestChannel(body["channel"]);
    const deliveryChannel = channel === "email" || channel === "webhook" ? channel : undefined;
    const adapter = deliveryChannel ? options.deliveries?.[deliveryChannel] : undefined;
    if (!deliveryChannel || !adapter) {
      throw notSupportedError(channel);
    }
    const target =
      typeof body["target"] === "string" && body["target"].trim().length > 0
        ? body["target"].trim()
        : DEFAULT_TEST_TARGETS[deliveryChannel];
    const result = await adapter.deliver(
      {
        id: options.generateEventId?.() ?? randomUUID(),
        ruleId: "notification-test",
        tenantId: "portal",
        severity: "Info",
        firedAt: now(),
        payload: { test: true, channel },
      },
      { id: "notification-test", channel: deliveryChannel, target, enabled: true },
    );
    return {
      status: 200,
      headers: { "content-type": "application/json" },
      body: {
        channel: result.channel,
        outcome: result.outcome,
        attempts: result.attempts,
        metaAlertRaised: result.metaAlertRaised,
        ...(result.error !== undefined ? { error: result.error } : {}),
      },
    };
  }

  return [
    { method: "GET", path: NOTIFICATIONS_PATH, handler: handleList },
    { method: "PUT", path: NOTIFICATIONS_PATH, handler: handleUpdate },
    { method: "POST", path: NOTIFICATIONS_TEST_PATH, handler: handleTest },
  ];
}

// Route modules own their OpenAPI path items (portal.v1.yaml `paths` is empty
// by design); a wiring ticket merges this fragment into the served document.
export const NOTIFICATIONS_OPENAPI = {
  paths: {
    "/notifications": {
      get: {
        tags: ["Alerting"],
        operationId: "listNotificationChannels",
        summary: "List configured notification channels with their enabled state.",
        permission: NOTIFICATIONS_READ_PERMISSION,
        security: [{ bearerAuth: [] }],
        responses: {
          "200": { description: "The configured channels." },
          "401": { description: "Authentication is required." },
          "403": { description: "The caller lacks alerts.read." },
        },
      },
      put: {
        tags: ["Alerting"],
        operationId: "updateNotificationChannel",
        summary: "Update a channel's target or enabled state (audited).",
        permission: NOTIFICATIONS_WRITE_PERMISSION,
        security: [{ bearerAuth: [] }],
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["id"],
                properties: {
                  id: { type: "string" },
                  target: { type: "string" },
                  enabled: { type: "boolean" },
                },
              },
            },
          },
        },
        responses: {
          "200": { description: "The updated channel." },
          "400": { description: "The update body is invalid." },
          "403": { description: "The caller lacks alerts.write." },
          "404": { description: "No such channel." },
        },
      },
    },
    "/notifications/test": {
      post: {
        tags: ["Alerting"],
        operationId: "testNotificationChannel",
        summary: "Send a test notification through a channel's delivery adapter.",
        permission: NOTIFICATIONS_WRITE_PERMISSION,
        security: [{ bearerAuth: [] }],
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["channel"],
                properties: {
                  channel: { type: "string", enum: ["email", "webhook", "psa", "slack"] },
                  target: { type: "string" },
                },
              },
            },
          },
        },
        responses: {
          "200": { description: "The delivery outcome; no AlertEvent is recorded." },
          "400": { description: "The test body is invalid." },
          "403": { description: "The caller lacks alerts.write." },
          "501": {
            description: "The channel has no delivery adapter yet (PSA is deferred to EPIC-041).",
          },
        },
      },
    },
  },
} as const;
