// Alert queue/history API (EPIC-029 SPEC.md §2 US-3/US-6, §3.3, §3.5, §4.4, §6; T-0567).
//
//   GET  /v1/alert-events                -> fired-event queue/history (§3.5), cursor-paginated,
//                                           tenant-scoped, filterable by state/source/severity
//   POST /v1/alert-rules/:ruleId/snooze  -> snooze a rule's open events (§3.3, §4.4)
//
// §3.3: snoozed items move to the Snoozed tab and auto-return; the return is
// resolved by the scheduler-aware seam in domain/alerts/snooze.ts (SPEC §4.1),
// which flips due snoozed events back to open on tick. §4.4: snooze is audited.
// Reads require `CIPP.Alert.Read` and snooze requires `CIPP.Alert.ReadWrite`; full RBAC is
// EPIC-038, so this uses the EPIC-001 T-0013 authorizer seam and denies without
// one (the same convention as alert-rules.ts). Alerting never writes to a
// tenant (SPEC §8): this route only persists event state.

import {
  ALERT_EVENT_SEVERITIES,
  ALERT_EVENT_STATES,
  type AlertEvent,
  type AlertEventSeverity,
  type AlertEventState,
} from "../domain/alerts/snooze.js";
import { AppError, ErrorCodes } from "../errors.js";
import { parsePagination } from "../pagination.js";
import { requirePermission, type Caller } from "../rbac/authorize.js";
import type { Permission } from "../rbac/roles.js";
import type { RequestContext, Route, RouteResponse } from "../server.js";

export const ALERT_EVENTS_PATH = "/v1/alert-events";
export const ALERT_RULE_SNOOZE_PATH = "/v1/alert-rules/:ruleId/snooze";

export const ALERT_EVENTS_READ_PERMISSION = "CIPP.Alert.Read";
export const ALERT_EVENTS_WRITE_PERMISSION = "CIPP.Alert.ReadWrite";
export const ALERT_EVENTS_UNAUTHENTICATED = "request.unauthenticated";

export interface AlertEventFilter {
  readonly tenantId?: string;
  readonly state?: AlertEventState;
  readonly source?: string;
  readonly severity?: AlertEventSeverity;
  readonly cursor: string | null;
  readonly limit: number;
}

export interface AlertEventPage {
  readonly totalCount: number;
  readonly items: readonly AlertEvent[];
  readonly nextCursor: string | null;
}

// Persistence seam over fired events: list applies the §3.5 filters and cursor
// pagination, snooze moves a rule's open events to snoozed, and
// returnDueSnoozedEvents is the scheduler entry point that auto-returns due
// snoozes (domain/alerts/snooze.ts owns the transition).
export interface AlertEventStore {
  listEvents(filter: AlertEventFilter): Promise<AlertEventPage>;
  snoozeRuleEvents(ruleId: string, snoozeUntil: string): Promise<readonly AlertEvent[]>;
  returnDueSnoozedEvents(now: string): Promise<readonly AlertEvent[]>;
}

export interface AlertEventsAuditPort {
  record(event: Record<string, unknown>): Promise<void> | void;
}

export interface AlertEventsOptions {
  readonly store: AlertEventStore;
  readonly resolveCaller: (ctx: RequestContext) => Caller | undefined;
  readonly authorize?: (caller: Caller, permission: string) => void | Promise<void>;
  readonly audit?: AlertEventsAuditPort;
  /** Test seam for deterministic timestamps; defaults to the current instant. */
  readonly now?: () => string;
}

function unauthenticatedError(): AppError {
  return new AppError(ALERT_EVENTS_UNAUTHENTICATED, "authentication required", 401);
}

function validationError(message: string, field: string): AppError {
  return new AppError(ErrorCodes.validationFailed, message, 400, [
    { field, reason: "invalid" },
  ]);
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function requireCaller(options: AlertEventsOptions, ctx: RequestContext): Caller {
  const caller = options.resolveCaller(ctx);
  if (!caller) {
    throw unauthenticatedError();
  }
  return caller;
}

async function ensureAuthorized(
  options: AlertEventsOptions,
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

function requireRuleIdParam(ctx: RequestContext): string {
  const value = ctx.params["ruleId"];
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new AppError(ErrorCodes.validationFailed, "ruleId is required", 400, [
      { field: "ruleId", reason: "required" },
    ]);
  }
  return value.trim();
}

function optionalText(query: URLSearchParams, name: string): string | undefined {
  const value = query.get(name);
  if (value === null || value.length === 0) {
    return undefined;
  }
  return value;
}

function parseEnumParam<T extends string>(
  query: URLSearchParams,
  name: string,
  allowed: readonly T[],
): T | undefined {
  const value = optionalText(query, name);
  if (value === undefined) {
    return undefined;
  }
  const match = allowed.find((entry) => entry.toLowerCase() === value.toLowerCase());
  if (match === undefined) {
    throw validationError(`${name} must be one of: ${allowed.join(", ")}`, name);
  }
  return match;
}

export function parseAlertEventFilter(query: URLSearchParams): AlertEventFilter {
  const pagination = parsePagination(query);
  return {
    tenantId: optionalText(query, "tenantId"),
    state: parseEnumParam(query, "state", ALERT_EVENT_STATES),
    source: optionalText(query, "source"),
    severity: parseEnumParam(query, "severity", ALERT_EVENT_SEVERITIES),
    cursor: pagination.cursor,
    limit: pagination.limit,
  };
}

/** §3.3: a snooze is a duration in minutes or an explicit return instant. */
export function parseSnoozeInput(body: Record<string, unknown>, now: string): string {
  const hasUntil = body["until"] !== undefined;
  const hasDuration = body["durationMinutes"] !== undefined;
  if (hasUntil && hasDuration) {
    throw validationError("specify only one of durationMinutes or until", "durationMinutes");
  }
  if (hasUntil) {
    const until = body["until"];
    if (typeof until !== "string" || Number.isNaN(Date.parse(until))) {
      throw validationError("until must be an ISO 8601 timestamp", "until");
    }
    return until;
  }
  if (hasDuration) {
    const duration = body["durationMinutes"];
    if (typeof duration !== "number" || !Number.isFinite(duration) || duration <= 0) {
      throw validationError("durationMinutes must be a positive number", "durationMinutes");
    }
    return new Date(Date.parse(now) + duration * 60_000).toISOString();
  }
  throw validationError("durationMinutes or until is required", "durationMinutes");
}

export function createAlertEventRoutes(options: AlertEventsOptions): Route[] {
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
    await ensureAuthorized(options, caller, ALERT_EVENTS_READ_PERMISSION);
    const filter = parseAlertEventFilter(ctx.query);
    const page = await options.store.listEvents(filter);
    return {
      status: 200,
      headers: { "content-type": "application/json" },
      body: { items: page.items, totalCount: page.totalCount, nextCursor: page.nextCursor },
    };
  }

  async function handleSnooze(ctx: RequestContext): Promise<RouteResponse> {
    const caller = requireCaller(options, ctx);
    await ensureAuthorized(options, caller, ALERT_EVENTS_WRITE_PERMISSION);
    const ruleId = requireRuleIdParam(ctx);
    const now = options.now?.() ?? new Date().toISOString();
    const snoozeUntil = parseSnoozeInput(asRecord(ctx.body), now);
    const snoozed = await options.store.snoozeRuleEvents(ruleId, snoozeUntil);
    await recordAudit(ctx, {
      action: "alert-rule.snooze",
      ruleId,
      snoozeUntil,
      eventIds: snoozed.map((event) => event.id),
    });
    return {
      status: 200,
      headers: { "content-type": "application/json" },
      body: { ruleId, snoozeUntil, events: snoozed },
    };
  }

  return [
    { method: "GET", path: ALERT_EVENTS_PATH, handler: handleList },
    { method: "POST", path: ALERT_RULE_SNOOZE_PATH, handler: handleSnooze },
  ];
}

// Route modules own their OpenAPI path items (portal.v1.yaml `paths` is empty
// by design); a wiring ticket merges this fragment into the served document.
export const ALERT_EVENTS_OPENAPI = {
  paths: {
    "/alert-events": {
      get: {
        tags: ["Alerting"],
        operationId: "listAlertEvents",
        summary:
          "List the fired-alert queue/history (§3.5) with state, source, tenant, and time; cursor-paginated and filterable",
        permission: ALERT_EVENTS_READ_PERMISSION,
        security: [{ bearerAuth: [] }],
        parameters: [
          { name: "tenantId", in: "query", required: false, schema: { type: "string" } },
          {
            name: "state",
            in: "query",
            required: false,
            schema: { type: "string", enum: [...ALERT_EVENT_STATES] },
          },
          { name: "source", in: "query", required: false, schema: { type: "string" } },
          {
            name: "severity",
            in: "query",
            required: false,
            schema: { type: "string", enum: [...ALERT_EVENT_SEVERITIES] },
          },
          { name: "cursor", in: "query", required: false, schema: { type: "string" } },
          { name: "limit", in: "query", required: false, schema: { type: "integer" } },
        ],
        responses: {
          "200": {
            description:
              "The filtered event page; snoozed events carry snoozeUntil and are reached with state=snoozed.",
          },
          "400": { description: "A query parameter is invalid." },
          "401": { description: "Authentication is required." },
          "403": { description: "The caller lacks CIPP.Alert.Read." },
        },
      },
    },
    "/alert-rules/{ruleId}/snooze": {
      post: {
        tags: ["Alerting"],
        operationId: "snoozeAlertRule",
        summary:
          "Snooze a rule's open events for a duration or until a time (§3.3); they auto-return to open once elapsed",
        permission: ALERT_EVENTS_WRITE_PERMISSION,
        security: [{ bearerAuth: [] }],
        parameters: [{ name: "ruleId", in: "path", required: true, schema: { type: "string" } }],
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: {
                  durationMinutes: {
                    type: "number",
                    description: "Snooze length in minutes; mutually exclusive with until.",
                  },
                  until: {
                    type: "string",
                    description: "Explicit ISO 8601 return instant; mutually exclusive with durationMinutes.",
                  },
                },
              },
            },
          },
        },
        responses: {
          "200": {
            description: "The rule's events moved to snoozed, with the return instant.",
          },
          "400": { description: "The snooze body is invalid." },
          "401": { description: "Authentication is required." },
          "403": { description: "The caller lacks CIPP.Alert.ReadWrite." },
        },
      },
    },
  },
} as const;
