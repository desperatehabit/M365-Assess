// Alert list and triage API (EPIC-028 SPEC.md §2 US-4, §3.3, §4.1, §6, §7, §8,
// §11 item 1; T-0548). Exposes GET /v1/tenants/:tenantId/alerts with the §3.3
// columns (Title, Service source, Severity, Status, Entity, Created) and POST
// /v1/tenants/:tenantId/alerts/:alertId/:action for the triage actions status,
// assign, comment, and create-incident.
//
// Alerts are read live from Graph by the worker and normalized onto the T-0542
// model; this route performs no Graph call directly. status/assign/comment
// write back where alerts_v2 supports it and create-incident is offered only
// for the sources that support promotion (Defender/MDO) — an unsupported write
// is refused with alerts.unsupported_action before any state change. Writes
// route through the EPIC-006 gated executor seam: every applied change records
// an AlertStateChange (from/to/by/at/reason) and an audit event, and resolving
// an alert or creating an incident requires explicit confirmation. The list
// route requires RBAC `Security.Incident.Read`; the action route requires
// `Security.Incident.ReadWrite` plus `Remediation.Apply`; both require the tenant in
// caller scope.
import { randomUUID } from "node:crypto";
import { AppError, ErrorCodes } from "../errors.js";
import { parsePagination } from "../pagination.js";
import { requireTenantInScope, type Caller } from "../rbac/authorize.js";
import type { AlertStateChange, AlertStateChangeInput } from "@m365-assess/db";
import type { RequestContext, Route, RouteResponse } from "../server.js";

export const ALERTS_PATH = "/v1/tenants/:tenantId/alerts";
export const ALERT_ACTIONS_PATH = "/v1/tenants/:tenantId/alerts/:alertId/:action";

export const ALERTS_READ_PERMISSION = "Security.Incident.Read";
export const ALERT_ACTIONS_TRIAGE_PERMISSION = "Security.Incident.ReadWrite";
export const ALERT_ACTIONS_APPLY_PERMISSION = "Remediation.Apply";

export const ALERTS_UNAUTHENTICATED = "request.unauthenticated";
export const ALERTS_UNKNOWN_ACTION = "alerts.unknown_action";
export const ALERTS_CONFIRM_REQUIRED = "alerts.confirm_required";
export const ALERTS_UNSUPPORTED_ACTION = "alerts.unsupported_action";
export const ALERTS_UNAVAILABLE = "alerts.unavailable";

export const ALERT_SOURCES = ["defender", "mdo", "graph"] as const;
export type AlertSource = (typeof ALERT_SOURCES)[number];

export const ALERT_SEVERITIES = [
  "unknown",
  "informational",
  "low",
  "medium",
  "high",
] as const;
export type AlertSeverity = (typeof ALERT_SEVERITIES)[number];

export const ALERT_STATUSES = ["unknown", "new", "inProgress", "resolved"] as const;
export type AlertStatus = (typeof ALERT_STATUSES)[number];

export const ALERT_ENTITY_KINDS = [
  "user",
  "device",
  "mailbox",
  "ip",
  "file",
  "url",
  "process",
  "unknown",
] as const;
export type AlertEntityKind = (typeof ALERT_ENTITY_KINDS)[number];

export interface AlertEntity {
  readonly kind: AlertEntityKind;
  readonly id?: string;
  readonly displayName?: string;
}

/** The T-0542 normalized alert, as returned by the list worker. */
export interface ProviderAlert {
  readonly schemaVersion: string;
  readonly id: string;
  readonly source: AlertSource;
  readonly title: string;
  readonly severity: AlertSeverity;
  readonly status: AlertStatus;
  readonly entity: AlertEntity | null;
  readonly created: string;
  readonly incidentId: string | null;
  readonly passthrough: Record<string, unknown>;
}

export const ALERT_ACTIONS = ["status", "assign", "comment", "create-incident"] as const;
export type AlertActionType = (typeof ALERT_ACTIONS)[number];

/** The actions whose field Graph alerts_v2 supports writing back. */
export const ALERT_WRITE_BACK_ACTIONS = ["status", "assign", "comment"] as const;

/** The alert sources that support promoting an alert to an incident. */
export const ALERT_CREATE_INCIDENT_SOURCES = ["defender", "mdo"] as const;

/** The alerts_v2 status values a status action can write back. */
export const ALERT_ACTION_STATUSES = ["new", "inProgress", "resolved"] as const;

/** Reports whether an action is offered for an alert's source. */
export function supportsAlertAction(source: AlertSource, action: AlertActionType): boolean {
  if (action !== "create-incident") {
    return true;
  }
  return (ALERT_CREATE_INCIDENT_SOURCES as readonly string[]).includes(source);
}

/** The row actions the UI offers for an alert; create-incident only where supported. */
export function availableAlertActions(source: AlertSource): readonly AlertActionType[] {
  return ALERT_ACTIONS.filter((action) => supportsAlertAction(source, action));
}

/** A normalized alert decorated with the actions the caller may invoke. */
export interface AlertItem extends ProviderAlert {
  readonly availableActions: readonly AlertActionType[];
}

export interface AlertsFilter {
  readonly source?: AlertSource;
  readonly severity?: AlertSeverity;
  readonly status?: AlertStatus;
  readonly cursor: string | null;
  readonly limit: number;
}

export interface ProviderAlertsPage {
  readonly tenantId: string;
  readonly totalCount: number;
  readonly items: readonly ProviderAlert[];
  readonly nextCursor: string | null;
}

export interface AlertsPage {
  readonly tenantId: string;
  readonly totalCount: number;
  readonly items: readonly AlertItem[];
  readonly nextCursor: string | null;
}

export interface AlertsProvider {
  listAlerts(tenantId: string, filter: AlertsFilter): Promise<ProviderAlertsPage>;
}

export interface AlertsCaller extends Caller {
  readonly userId?: string;
}

export type AlertsAuthorizer = (
  caller: AlertsCaller,
  permission: string,
) => void | Promise<void>;

export interface AlertsRouteOptions {
  readonly provider: AlertsProvider;
  readonly resolveCaller: (ctx: RequestContext) => AlertsCaller | undefined;
  readonly authorize?: AlertsAuthorizer;
}

export interface AlertActionState {
  readonly status: string;
  readonly assignedTo: string;
  readonly source: string;
}

export interface AlertActionNote {
  readonly body: string;
  readonly author: string;
}

export type AlertActionRowStatus = "applied" | "planned" | "failed";

export interface AlertActionRowResult {
  readonly alertId: string;
  readonly action: AlertActionType;
  readonly status: AlertActionRowStatus;
  readonly writeBack: boolean;
  readonly from: string;
  readonly to: string;
  readonly before: AlertActionState | null;
  readonly after: AlertActionState | null;
  readonly note: AlertActionNote | null;
  readonly incidentId: string | null;
  readonly error: string | null;
}

export interface AlertActionSummary {
  readonly total: number;
  readonly applied: number;
  readonly planned: number;
  readonly failed: number;
}

export interface AlertActionResponse {
  readonly tenantId: string;
  readonly action: AlertActionType;
  readonly rows: readonly AlertActionRowResult[];
  readonly summary: AlertActionSummary;
}

export interface ProviderAlertActionResult {
  readonly status: "applied" | "failed" | "unsupported";
  readonly writeBack: boolean;
  readonly from: string;
  readonly to: string;
  readonly before: AlertActionState | null;
  readonly after: AlertActionState | null;
  readonly note: AlertActionNote | null;
  readonly incidentId?: string | null;
  readonly error?: string | null;
}

// Queue-backed seam for the triage path: the production wiring enqueues one
// Invoke-AlertAction worker job per targeted alert through the EPIC-006 gated
// executor and serves the outcome. Depending on the seam keeps Graph and
// process code out of the BFF.
export interface AlertActionProvider {
  executeAction(
    tenantId: string,
    alertId: string,
    action: AlertActionType,
    options: { value: string; comment: string; reason: string; dryRun: boolean },
  ): Promise<ProviderAlertActionResult>;
}

export interface AlertActionAuditEvent {
  readonly tenantId: string;
  readonly action: "alerts.action";
  readonly targetId: string;
  readonly alertAction: AlertActionType;
  readonly result: "success" | "failure";
  readonly from: string;
  readonly to: string;
  readonly error: string | null;
  readonly actorUserId: string | null;
  readonly correlationId: string;
  readonly createdAt: string;
}

// Persistence seam over the T-0541 incident-triage repository: alert state
// changes are append-only and tenant-scoped.
export interface AlertTriageStore {
  createAlertStateChange(input: AlertStateChangeInput): Promise<AlertStateChange>;
}

export interface AlertsActionsCaller extends Caller {
  readonly userId?: string;
}

export type AlertsActionsAuthorizer = (
  caller: AlertsActionsCaller,
  permission: string,
) => void | Promise<void>;

export interface AlertsActionsRequestContext extends RequestContext {
  readonly body?: unknown;
}

export interface AlertsActionsRouteOptions {
  readonly execute?: AlertActionProvider;
  readonly store: AlertTriageStore;
  readonly resolveCaller: (ctx: RequestContext) => AlertsActionsCaller | undefined;
  readonly authorize?: AlertsActionsAuthorizer;
  readonly readBody?: (ctx: AlertsActionsRequestContext) => unknown;
  readonly recordAudit?: (event: AlertActionAuditEvent) => Promise<void>;
  readonly now?: () => string;
}

function unauthenticatedError(): AppError {
  return new AppError(ALERTS_UNAUTHENTICATED, "authentication required", 401);
}

function validationError(message: string, field: string): AppError {
  return new AppError(ErrorCodes.validationFailed, message, 400, [
    { field, reason: "invalid" },
  ]);
}

function requireCaller<T extends Caller>(
  resolveCaller: (ctx: RequestContext) => T | undefined,
  ctx: RequestContext,
): T {
  const caller = resolveCaller(ctx);
  if (caller === undefined) {
    throw unauthenticatedError();
  }
  return caller;
}

function requireParam(ctx: RequestContext, name: string): string {
  const value = ctx.params[name];
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new AppError(ErrorCodes.validationFailed, `${name} is required`, 400, [
      { field: name, reason: "required" },
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

export function parseAlertsFilter(query: URLSearchParams): AlertsFilter {
  const pagination = parsePagination(query);
  return {
    source: parseEnumParam(query, "source", ALERT_SOURCES),
    severity: parseEnumParam(query, "severity", ALERT_SEVERITIES),
    status: parseEnumParam(query, "status", ALERT_STATUSES),
    cursor: pagination.cursor,
    limit: pagination.limit,
  };
}

async function ensureRead(options: AlertsRouteOptions, caller: AlertsCaller): Promise<void> {
  if (options.authorize) {
    await options.authorize(caller, ALERTS_READ_PERMISSION);
    return;
  }
  const permissions = caller.permissions ?? [];
  if (!permissions.includes(ALERTS_READ_PERMISSION) && !permissions.includes("*")) {
    throw new AppError(ErrorCodes.forbidden, "forbidden: missing Security.Incident.Read", 403);
  }
}

export function createAlertsRoutes(options: AlertsRouteOptions): Route[] {
  async function handleList(ctx: RequestContext): Promise<RouteResponse> {
    const caller = requireCaller(options.resolveCaller, ctx);
    const tenantId = requireParam(ctx, "tenantId");

    requireTenantInScope(caller, tenantId);
    await ensureRead(options, caller);

    const filter = parseAlertsFilter(ctx.query);
    const page = await options.provider.listAlerts(tenantId, filter);
    const body: AlertsPage = {
      tenantId: page.tenantId,
      totalCount: page.totalCount,
      items: page.items.map((alert) => ({
        ...alert,
        availableActions: availableAlertActions(alert.source),
      })),
      nextCursor: page.nextCursor,
    };

    return {
      status: 200,
      headers: { "content-type": "application/json" },
      body,
    };
  }

  return [{ method: "GET", path: ALERTS_PATH, handler: handleList }];
}

function readJsonBody(
  ctx: RequestContext,
  readBody: ((ctx: AlertsActionsRequestContext) => unknown) | undefined,
): Record<string, unknown> {
  let body = readBody
    ? readBody(ctx as AlertsActionsRequestContext)
    : (ctx as AlertsActionsRequestContext).body;
  if (typeof body === "string") {
    try {
      body = JSON.parse(body);
    } catch {
      throw new AppError(ErrorCodes.validationFailed, "request body is not valid JSON", 400, [
        { field: "body", reason: "invalid_json" },
      ]);
    }
  }
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    throw new AppError(ErrorCodes.validationFailed, "request body must be a JSON object", 400, [
      { field: "body", reason: "invalid" },
    ]);
  }
  return body as Record<string, unknown>;
}

function optionalBoolean(body: Record<string, unknown>, name: string): boolean | undefined {
  const value = body[name];
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "boolean") {
    throw validationError(`${name} must be a boolean`, name);
  }
  return value;
}

function optionalTextValue(body: Record<string, unknown>, name: string): string {
  const value = body[name];
  if (value === undefined) {
    return "";
  }
  if (typeof value !== "string") {
    throw validationError(`${name} must be a string`, name);
  }
  return value;
}

export function parseAlertAction(value: unknown): AlertActionType {
  if (typeof value !== "string" || !(ALERT_ACTIONS as readonly string[]).includes(value)) {
    throw new AppError(
      ALERTS_UNKNOWN_ACTION,
      `unknown alert action '${typeof value === "string" ? value : typeof value}'; expected one of: ${ALERT_ACTIONS.join(", ")}`,
      400,
      [{ field: "action", reason: "unknown" }],
    );
  }
  return value as AlertActionType;
}

function parseAlertIds(body: Record<string, unknown>): string[] {
  const value = body["alertIds"];
  if (value === undefined) {
    return [];
  }
  if (
    !Array.isArray(value) ||
    value.some((entry) => typeof entry !== "string" || entry.trim().length === 0)
  ) {
    throw validationError("alertIds must be an array of non-empty strings", "alertIds");
  }
  return (value as string[]).map((entry) => entry.trim());
}

function isResolvedValue(value: string): boolean {
  return value.trim().toLowerCase() === "resolved";
}

async function ensureTriagePermissions(
  options: AlertsActionsRouteOptions,
  caller: AlertsActionsCaller,
): Promise<void> {
  if (options.authorize) {
    await options.authorize(caller, ALERT_ACTIONS_TRIAGE_PERMISSION);
    await options.authorize(caller, ALERT_ACTIONS_APPLY_PERMISSION);
    return;
  }
  const permissions = caller.permissions ?? [];
  for (const permission of [ALERT_ACTIONS_TRIAGE_PERMISSION, ALERT_ACTIONS_APPLY_PERMISSION]) {
    if (!permissions.includes(permission) && !permissions.includes("*")) {
      throw new AppError(ErrorCodes.forbidden, `forbidden: missing ${permission}`, 403);
    }
  }
}

function plannedRow(
  alertId: string,
  action: AlertActionType,
  outcome: ProviderAlertActionResult | null,
): AlertActionRowResult {
  return {
    alertId,
    action,
    status: "planned",
    writeBack: (ALERT_WRITE_BACK_ACTIONS as readonly string[]).includes(action),
    from: outcome?.from ?? "",
    to: outcome?.to ?? "",
    before: outcome?.before ?? null,
    after: null,
    note: outcome?.note ?? null,
    incidentId: null,
    error: null,
  };
}

function rowFromOutcome(
  alertId: string,
  action: AlertActionType,
  outcome: ProviderAlertActionResult,
): AlertActionRowResult {
  if (outcome.status === "failed") {
    return {
      alertId,
      action,
      status: "failed",
      writeBack: false,
      from: outcome.from ?? "",
      to: outcome.to ?? "",
      before: outcome.before ?? null,
      after: null,
      note: outcome.note ?? null,
      incidentId: null,
      error: outcome.error ?? "action failed without a provider result",
    };
  }
  return {
    alertId,
    action,
    status: "applied",
    writeBack: outcome.writeBack,
    from: outcome.from ?? "",
    to: outcome.to ?? "",
    before: outcome.before ?? null,
    after: outcome.after ?? null,
    note: outcome.note ?? null,
    incidentId: outcome.incidentId ?? null,
    error: null,
  };
}

function summarize(rows: readonly AlertActionRowResult[]): AlertActionSummary {
  return {
    total: rows.length,
    applied: rows.filter((row) => row.status === "applied").length,
    planned: rows.filter((row) => row.status === "planned").length,
    failed: rows.filter((row) => row.status === "failed").length,
  };
}

export async function postAlertAction(
  options: AlertsActionsRouteOptions,
  ctx: RequestContext,
  tenantId: string,
  caller: AlertsActionsCaller,
  alertId: string,
  actionRaw: string,
): Promise<{ status: number; body: AlertActionResponse }> {
  const action = parseAlertAction(actionRaw);
  if (alertId.trim().length === 0) {
    throw new AppError(ErrorCodes.validationFailed, "alertId is required", 400, [
      { field: "alertId", reason: "required" },
    ]);
  }
  const body = readJsonBody(ctx, options.readBody);
  const dryRun = optionalBoolean(body, "dryRun") === true;
  const confirmed = optionalBoolean(body, "confirm") === true;
  const value = optionalTextValue(body, "value");
  const comment = optionalTextValue(body, "comment");
  const reason = optionalTextValue(body, "reason");
  const extraIds = parseAlertIds(body);

  if (action === "status") {
    if (value.trim().length === 0) {
      throw validationError(
        `value is required for status and must be one of: ${ALERT_ACTION_STATUSES.join(", ")}`,
        "value",
      );
    }
    const status = value.trim().toLowerCase();
    const known = (ALERT_ACTION_STATUSES as readonly string[]).map((entry) => entry.toLowerCase());
    if (!known.includes(status)) {
      throw validationError(`value must be one of: ${ALERT_ACTION_STATUSES.join(", ")}`, "value");
    }
    if (reason.trim().length === 0) {
      throw validationError("reason is required for a status change", "reason");
    }
  }
  if (action === "assign") {
    if (value.trim().length === 0) {
      throw validationError("value (assignee) is required for assign", "value");
    }
    if (reason.trim().length === 0) {
      throw validationError("reason is required for an assignment change", "reason");
    }
  }
  if (action === "comment" && comment.trim().length === 0) {
    throw validationError("comment is required", "comment");
  }
  if (action === "create-incident") {
    if (value.trim().length === 0) {
      throw validationError("value (incident title) is required for create-incident", "value");
    }
    if (reason.trim().length === 0) {
      throw validationError("reason is required for create-incident", "reason");
    }
  }

  const targets = [...new Set([alertId, ...extraIds])];
  const bulk = targets.length > 1;
  if (!dryRun && bulk && !confirmed) {
    throw new AppError(
      ALERTS_CONFIRM_REQUIRED,
      `bulk ${action} across ${targets.length} alerts requires { "confirm": true }`,
      400,
      [{ field: "confirm", reason: "required" }],
    );
  }
  if (!dryRun && action === "status" && isResolvedValue(value) && !confirmed) {
    throw new AppError(
      ALERTS_CONFIRM_REQUIRED,
      'resolving an alert requires { "confirm": true }; a triage change can never silently auto-resolve',
      400,
      [{ field: "confirm", reason: "required" }],
    );
  }
  if (!dryRun && action === "create-incident" && !confirmed) {
    throw new AppError(
      ALERTS_CONFIRM_REQUIRED,
      'creating an incident requires { "confirm": true }',
      400,
      [{ field: "confirm", reason: "required" }],
    );
  }

  if (dryRun) {
    const rows = targets.map((target) => plannedRow(target, action, null));
    return {
      status: 200,
      body: { tenantId, action, rows, summary: summarize(rows) },
    };
  }
  if (options.execute === undefined) {
    throw new AppError(ALERTS_UNAVAILABLE, "alert actions are not wired for this tenant", 501);
  }

  const at = options.now ?? (() => new Date().toISOString());
  const now = at();
  const rows: AlertActionRowResult[] = [];
  for (const target of targets) {
    let outcome: ProviderAlertActionResult;
    try {
      outcome = await options.execute.executeAction(tenantId, target, action, {
        value,
        comment,
        reason,
        dryRun: false,
      });
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "action failed without a provider result";
      const failed = rowFromOutcome(target, action, {
        status: "failed",
        writeBack: false,
        from: "",
        to: "",
        before: null,
        after: null,
        note: null,
        error: message,
      });
      await writeAlertAudit(options, ctx, caller, tenantId, action, failed, now);
      rows.push(failed);
      continue;
    }
    if (outcome.status === "unsupported") {
      throw new AppError(
        ALERTS_UNSUPPORTED_ACTION,
        outcome.error ??
          `action '${action}' is not supported for alert '${target}'`,
        400,
        [{ field: "action", reason: "unsupported" }],
      );
    }
    const row = rowFromOutcome(target, action, outcome);
    if (row.status === "applied") {
      await options.store.createAlertStateChange({
        id: randomUUID(),
        tenantId,
        alertId: target,
        incidentId: row.incidentId,
        from: row.from,
        to: row.to,
        by: caller.userId ?? null,
        at: now,
        // T-0541 has no alert-note entity, so a comment's body is the reason
        // on the AlertStateChange rather than a dropped portal note.
        reason: action === "comment" ? row.note?.body ?? null : reason.trim(),
      });
    }
    await writeAlertAudit(options, ctx, caller, tenantId, action, row, now);
    rows.push(row);
  }

  return {
    status: 200,
    body: { tenantId, action, rows, summary: summarize(rows) },
  };
}

async function writeAlertAudit(
  options: AlertsActionsRouteOptions,
  ctx: RequestContext,
  caller: AlertsActionsCaller,
  tenantId: string,
  action: AlertActionType,
  row: AlertActionRowResult,
  now: string,
): Promise<void> {
  if (!options.recordAudit) {
    return;
  }
  await options.recordAudit({
    tenantId,
    action: "alerts.action",
    targetId: row.alertId,
    alertAction: action,
    result: row.status === "applied" ? "success" : "failure",
    from: row.from,
    to: row.to,
    error: row.error,
    actorUserId: caller.userId ?? null,
    correlationId: ctx.correlationId,
    createdAt: now,
  });
}

export function createAlertActionsRoute(options: AlertsActionsRouteOptions): Route[] {
  const handler = async (ctx: RequestContext): Promise<RouteResponse> => {
    const caller = requireCaller(options.resolveCaller, ctx);
    const tenantId = requireParam(ctx, "tenantId");
    const alertId = requireParam(ctx, "alertId");
    const action = requireParam(ctx, "action");

    requireTenantInScope(caller, tenantId);
    await ensureTriagePermissions(options, caller);

    const result = await postAlertAction(options, ctx, tenantId, caller, alertId, action);
    return { status: result.status, body: result.body };
  };
  return [{ method: "POST", path: ALERT_ACTIONS_PATH, handler }];
}

// Route modules own their OpenAPI path items (portal.v1.yaml `paths` is empty
// by design); a wiring ticket merges this fragment into the served document.
export const ALERTS_OPENAPI = {
  paths: {
    "/tenants/{tenantId}/alerts": {
      get: {
        operationId: "listAlerts",
        summary:
          "List normalized alerts with §3.3 columns (Title, Service source, Severity, Status, Entity, Created), filters, and cursor pagination",
        permission: ALERTS_READ_PERMISSION,
        security: [{ bearerAuth: [] }],
        parameters: [
          { name: "tenantId", in: "path", required: true, schema: { type: "string" } },
          {
            name: "source",
            in: "query",
            required: false,
            schema: { type: "string", enum: [...ALERT_SOURCES] },
          },
          {
            name: "severity",
            in: "query",
            required: false,
            schema: { type: "string", enum: [...ALERT_SEVERITIES] },
          },
          {
            name: "status",
            in: "query",
            required: false,
            schema: { type: "string", enum: [...ALERT_STATUSES] },
          },
          { name: "cursor", in: "query", required: false, schema: { type: "string" } },
          { name: "limit", in: "query", required: false, schema: { type: "integer" } },
        ],
        responses: {
          "200": {
            description:
              "The tenant's filtered alert page; each item carries availableActions so create-incident appears only where the source supports it.",
          },
          "400": { description: "A path or query parameter is invalid." },
          "401": { description: "Authentication is required." },
          "403": { description: "The caller lacks the Security.Incident.Read permission." },
        },
      },
    },
    "/tenants/{tenantId}/alerts/{alertId}/{action}": {
      post: {
        operationId: "applyAlertAction",
        summary:
          "Set status, assign, comment, or create an incident from an alert; status/assign/comment write back to alerts_v2, create-incident is source-gated and requires confirmation",
        permission: ALERT_ACTIONS_TRIAGE_PERMISSION,
        security: [{ bearerAuth: [] }],
        parameters: [
          { name: "tenantId", in: "path", required: true, schema: { type: "string" } },
          { name: "alertId", in: "path", required: true, schema: { type: "string" } },
          {
            name: "action",
            in: "path",
            required: true,
            schema: { type: "string", enum: [...ALERT_ACTIONS] },
          },
        ],
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: {
                  value: {
                    type: "string",
                    description:
                      "New status, assignee, or incident title. Required for status, assign, and create-incident.",
                  },
                  comment: { type: "string", description: "Comment body. Required for comment." },
                  reason: {
                    type: "string",
                    description: "Triage reason recorded on the state change and audit event.",
                  },
                  confirm: {
                    type: "boolean",
                    description:
                      "Explicit confirmation. Required for bulk changes, for any status change to resolved, and for create-incident.",
                  },
                  dryRun: { type: "boolean", description: "Plan the change with no tenant write." },
                  alertIds: {
                    type: "array",
                    items: { type: "string" },
                    description:
                      "Additional target alert ids. More than one target makes the call bulk and requires confirm.",
                  },
                },
              },
            },
          },
        },
        responses: {
          "200": {
            description:
              "The per-alert action rows with before/after, from/to, and the created incident id (create-incident only).",
          },
          "400": {
            description:
              "Unknown action, invalid value, unsupported write for the alert's source, or missing confirmation/reason.",
          },
          "401": { description: "Authentication is required." },
          "403": {
            description:
              "The caller lacks Security.Incident.ReadWrite or Remediation.Apply, or the tenant is out of scope.",
          },
          "501": { description: "Alert actions are not wired for this tenant." },
        },
      },
    },
  },
} as const;
