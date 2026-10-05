// Incident triage actions API (EPIC-028 SPEC.md §2 US-3, §4.1, §6, §7, §8, §9,
// §11 item 1; T-0546). Exposes POST
// /v1/tenants/:tenantId/incidents/:incidentId/:action for the triage actions
// assign, status, classify, and comment. Status and classification write back
// to Graph where the API supports them (SPEC §11 item 1); assignee and
// comments are portal-only and persist as state changes and notes (T-0541).
// Writes route through the EPIC-006 gated executor seam: every applied change
// records an AlertStateChange (from/to/by/at/reason) and an audit event, bulk
// changes require explicit confirmation, and a status change to resolved can
// never silently auto-resolve. Requires RBAC `Security.Incident.ReadWrite` plus
// `Remediation.Apply` and tenant in caller scope.
import { randomUUID } from "node:crypto";
import { AppError, ErrorCodes } from "../errors.js";
import { requireTenantInScope, type Caller } from "../rbac/authorize.js";
import type {
  AlertStateChange,
  AlertStateChangeInput,
  IncidentNote,
  IncidentNoteInput,
} from "@m365-assess/db";
import type { RequestContext, Route, RouteResponse } from "../server.js";

export const INCIDENT_ACTIONS_PATH = "/v1/tenants/:tenantId/incidents/:incidentId/:action";
export const INCIDENT_ACTIONS_TRIAGE_PERMISSION = "Security.Incident.ReadWrite";
export const INCIDENT_ACTIONS_APPLY_PERMISSION = "Remediation.Apply";

export const INCIDENT_ACTIONS_UNKNOWN = "incidents.unknown_action";
export const INCIDENT_ACTIONS_CONFIRM_REQUIRED = "incidents.confirm_required";
export const INCIDENT_ACTIONS_UNAVAILABLE = "incidents.unavailable";

export const INCIDENT_ACTIONS = ["assign", "status", "classify", "comment"] as const;
export type IncidentActionType = (typeof INCIDENT_ACTIONS)[number];

/** The Graph incident status values a status action can write back. */
export const INCIDENT_STATUSES = ["active", "redirected", "resolved"] as const;
/** The Graph incident classification values a classify action can write back. */
export const INCIDENT_CLASSIFICATIONS = [
  "truePositive",
  "falsePositive",
  "informationalExpectedActivity",
  "benignPositive",
] as const;

export interface IncidentActionState {
  readonly status: string;
  readonly classification: string;
  readonly assignedTo: string;
}

export interface IncidentActionNote {
  readonly body: string;
  readonly author: string;
}

export type IncidentActionRowStatus = "applied" | "planned" | "failed";

export interface IncidentActionRowResult {
  readonly incidentId: string;
  readonly action: IncidentActionType;
  readonly status: IncidentActionRowStatus;
  readonly writeBack: boolean;
  readonly from: string;
  readonly to: string;
  readonly before: IncidentActionState | null;
  readonly after: IncidentActionState | null;
  readonly note: IncidentActionNote | null;
  readonly error: string | null;
}

export interface IncidentActionSummary {
  readonly total: number;
  readonly applied: number;
  readonly planned: number;
  readonly failed: number;
}

export interface IncidentActionResponse {
  readonly tenantId: string;
  readonly action: IncidentActionType;
  readonly rows: readonly IncidentActionRowResult[];
  readonly summary: IncidentActionSummary;
}

export interface ProviderIncidentActionResult {
  readonly status: "applied" | "failed";
  readonly writeBack: boolean;
  readonly from: string;
  readonly to: string;
  readonly before: IncidentActionState | null;
  readonly after: IncidentActionState | null;
  readonly note: IncidentActionNote | null;
  readonly error?: string | null;
}

// Queue-backed seam for the triage path: the production wiring enqueues one
// Invoke-IncidentAction worker job per targeted incident through the EPIC-006
// gated executor and serves the outcome. Depending on the seam keeps Graph
// and process code out of the BFF.
export interface IncidentActionProvider {
  executeAction(
    tenantId: string,
    incidentId: string,
    action: IncidentActionType,
    options: { value: string; comment: string; reason: string; dryRun: boolean },
  ): Promise<ProviderIncidentActionResult>;
}

export interface IncidentActionAuditEvent {
  readonly tenantId: string;
  readonly action: "incidents.action";
  readonly targetId: string;
  readonly incidentAction: IncidentActionType;
  readonly result: "success" | "failure";
  readonly from: string;
  readonly to: string;
  readonly error: string | null;
  readonly actorUserId: string | null;
  readonly correlationId: string;
  readonly createdAt: string;
}

// Persistence seam over the T-0541 incident-triage repository: state changes
// and portal notes are append-only and tenant-scoped.
export interface IncidentTriageStore {
  createIncidentNote(input: IncidentNoteInput): Promise<IncidentNote>;
  createAlertStateChange(input: AlertStateChangeInput): Promise<AlertStateChange>;
}

export interface IncidentsActionsCaller extends Caller {
  readonly userId?: string;
}

export type IncidentsActionsAuthorizer = (
  caller: IncidentsActionsCaller,
  permission: string,
) => void | Promise<void>;

export interface IncidentsActionsRequestContext extends RequestContext {
  readonly body?: unknown;
}

export interface IncidentsActionsRouteOptions {
  readonly execute?: IncidentActionProvider;
  readonly store: IncidentTriageStore;
  readonly resolveCaller: (ctx: RequestContext) => IncidentsActionsCaller | undefined;
  readonly authorize?: IncidentsActionsAuthorizer;
  readonly readBody?: (ctx: IncidentsActionsRequestContext) => unknown;
  readonly recordAudit?: (event: IncidentActionAuditEvent) => Promise<void>;
  readonly now?: () => string;
}

function unauthenticatedError(): AppError {
  return new AppError("request.unauthenticated", "authentication required", 401);
}

function validationError(message: string, field: string): AppError {
  return new AppError(ErrorCodes.validationFailed, message, 400, [
    { field, reason: "invalid" },
  ]);
}

function requireCaller(
  resolveCaller: (ctx: RequestContext) => IncidentsActionsCaller | undefined,
  ctx: RequestContext,
): IncidentsActionsCaller {
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

function readJsonBody(
  ctx: RequestContext,
  readBody: ((ctx: IncidentsActionsRequestContext) => unknown) | undefined,
): Record<string, unknown> {
  let body = readBody ? readBody(ctx as IncidentsActionsRequestContext) : (ctx as IncidentsActionsRequestContext).body;
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

function optionalText(body: Record<string, unknown>, name: string): string {
  const value = body[name];
  if (value === undefined) {
    return "";
  }
  if (typeof value !== "string") {
    throw validationError(`${name} must be a string`, name);
  }
  return value;
}

export function parseIncidentAction(value: unknown): IncidentActionType {
  if (typeof value !== "string" || !(INCIDENT_ACTIONS as readonly string[]).includes(value)) {
    throw new AppError(
      INCIDENT_ACTIONS_UNKNOWN,
      `unknown incident action '${typeof value === "string" ? value : typeof value}'; expected one of: ${INCIDENT_ACTIONS.join(", ")}`,
      400,
      [{ field: "action", reason: "unknown" }],
    );
  }
  return value as IncidentActionType;
}

function parseIncidentIds(body: Record<string, unknown>): string[] {
  const value = body["incidentIds"];
  if (value === undefined) {
    return [];
  }
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string" || entry.trim().length === 0)) {
    throw validationError("incidentIds must be an array of non-empty strings", "incidentIds");
  }
  return (value as string[]).map((entry) => entry.trim());
}

function isResolvedValue(value: string): boolean {
  return value.trim().toLowerCase() === "resolved";
}

async function ensureTriagePermissions(
  options: IncidentsActionsRouteOptions,
  caller: IncidentsActionsCaller,
): Promise<void> {
  if (options.authorize) {
    await options.authorize(caller, INCIDENT_ACTIONS_TRIAGE_PERMISSION);
    await options.authorize(caller, INCIDENT_ACTIONS_APPLY_PERMISSION);
    return;
  }
  const permissions = caller.permissions ?? [];
  for (const permission of [INCIDENT_ACTIONS_TRIAGE_PERMISSION, INCIDENT_ACTIONS_APPLY_PERMISSION]) {
    if (!permissions.includes(permission) && !permissions.includes("*")) {
      throw new AppError(ErrorCodes.forbidden, `forbidden: missing ${permission}`, 403);
    }
  }
}

function plannedRow(
  incidentId: string,
  action: IncidentActionType,
  outcome: ProviderIncidentActionResult | null,
): IncidentActionRowResult {
  return {
    incidentId,
    action,
    status: "planned",
    writeBack: action === "status" || action === "classify",
    from: outcome?.from ?? "",
    to: outcome?.to ?? "",
    before: outcome?.before ?? null,
    after: null,
    note: outcome?.note ?? null,
    error: null,
  };
}

function rowFromOutcome(
  incidentId: string,
  action: IncidentActionType,
  outcome: ProviderIncidentActionResult,
): IncidentActionRowResult {
  if (outcome.status === "failed") {
    return {
      incidentId,
      action,
      status: "failed",
      writeBack: false,
      from: outcome.from ?? "",
      to: outcome.to ?? "",
      before: outcome.before ?? null,
      after: null,
      note: outcome.note ?? null,
      error: outcome.error ?? "action failed without a provider result",
    };
  }
  return {
    incidentId,
    action,
    status: "applied",
    writeBack: outcome.writeBack,
    from: outcome.from ?? "",
    to: outcome.to ?? "",
    before: outcome.before ?? null,
    after: outcome.after ?? null,
    note: outcome.note ?? null,
    error: null,
  };
}

function summarize(rows: readonly IncidentActionRowResult[]): IncidentActionSummary {
  return {
    total: rows.length,
    applied: rows.filter((row) => row.status === "applied").length,
    planned: rows.filter((row) => row.status === "planned").length,
    failed: rows.filter((row) => row.status === "failed").length,
  };
}

export async function postIncidentAction(
  options: IncidentsActionsRouteOptions,
  ctx: RequestContext,
  tenantId: string,
  caller: IncidentsActionsCaller,
  incidentId: string,
  actionRaw: string,
): Promise<{ status: number; body: IncidentActionResponse }> {
  const action = parseIncidentAction(actionRaw);
  if (incidentId.trim().length === 0) {
    throw new AppError(ErrorCodes.validationFailed, "incidentId is required", 400, [
      { field: "incidentId", reason: "required" },
    ]);
  }
  const body = readJsonBody(ctx, options.readBody);
  const dryRun = optionalBoolean(body, "dryRun") === true;
  const confirmed = optionalBoolean(body, "confirm") === true;
  const value = optionalText(body, "value");
  const comment = optionalText(body, "comment");
  const reason = optionalText(body, "reason");
  const extraIds = parseIncidentIds(body);

  if (action === "status") {
    if (value.trim().length === 0) {
      throw validationError(
        `value is required for status and must be one of: ${INCIDENT_STATUSES.join(", ")}`,
        "value",
      );
    }
    if (!(INCIDENT_STATUSES as readonly string[]).includes(value.trim().toLowerCase())) {
      throw validationError(
        `value must be one of: ${INCIDENT_STATUSES.join(", ")}`,
        "value",
      );
    }
    if (reason.trim().length === 0) {
      throw validationError("reason is required for a status change", "reason");
    }
  }
  if (action === "classify") {
    if (value.trim().length === 0) {
      throw validationError(
        `value is required for classify and must be one of: ${INCIDENT_CLASSIFICATIONS.join(", ")}`,
        "value",
      );
    }
    const classification = value.trim().toLowerCase();
    const knownClassifications = (INCIDENT_CLASSIFICATIONS as readonly string[]).map((entry) =>
      entry.toLowerCase(),
    );
    if (!knownClassifications.includes(classification)) {
      throw validationError(
        `value must be one of: ${INCIDENT_CLASSIFICATIONS.join(", ")}`,
        "value",
      );
    }
    if (reason.trim().length === 0) {
      throw validationError("reason is required for a classification change", "reason");
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

  const targets = [...new Set([incidentId, ...extraIds])];
  const bulk = targets.length > 1;
  if (!dryRun && bulk && !confirmed) {
    throw new AppError(
      INCIDENT_ACTIONS_CONFIRM_REQUIRED,
      `bulk ${action} across ${targets.length} incidents requires { "confirm": true }`,
      400,
      [{ field: "confirm", reason: "required" }],
    );
  }
  if (!dryRun && action === "status" && isResolvedValue(value) && !confirmed) {
    throw new AppError(
      INCIDENT_ACTIONS_CONFIRM_REQUIRED,
      "resolving an incident requires { \"confirm\": true }; a triage change can never silently auto-resolve",
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
    throw new AppError(INCIDENT_ACTIONS_UNAVAILABLE, "incident actions are not wired for this tenant", 501);
  }

  const at = options.now ?? (() => new Date().toISOString());
  const now = at();
  const rows: IncidentActionRowResult[] = [];
  for (const target of targets) {
    let outcome: ProviderIncidentActionResult;
    try {
      outcome = await options.execute.executeAction(tenantId, target, action, {
        value,
        comment,
        reason,
        dryRun: false,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : "action failed without a provider result";
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
      await writeActionAudit(options, ctx, caller, tenantId, action, failed, now);
      rows.push(failed);
      continue;
    }
    const row = rowFromOutcome(target, action, outcome);
    if (row.status === "applied") {
      await options.store.createAlertStateChange({
        id: randomUUID(),
        tenantId,
        from: row.from,
        to: row.to,
        incidentId: target,
        by: caller.userId ?? null,
        at: now,
        reason: action === "comment" ? null : reason.trim(),
      });
      if (action === "comment" && row.note) {
        await options.store.createIncidentNote({
          id: randomUUID(),
          tenantId,
          incidentId: target,
          body: row.note.body,
          author: row.note.author,
          at: now,
        });
      }
    }
    await writeActionAudit(options, ctx, caller, tenantId, action, row, now);
    rows.push(row);
  }

  return {
    status: 200,
    body: { tenantId, action, rows, summary: summarize(rows) },
  };
}

async function writeActionAudit(
  options: IncidentsActionsRouteOptions,
  ctx: RequestContext,
  caller: IncidentsActionsCaller,
  tenantId: string,
  action: IncidentActionType,
  row: IncidentActionRowResult,
  now: string,
): Promise<void> {
  if (!options.recordAudit) {
    return;
  }
  await options.recordAudit({
    tenantId,
    action: "incidents.action",
    targetId: row.incidentId,
    incidentAction: action,
    result: row.status === "applied" ? "success" : "failure",
    from: row.from,
    to: row.to,
    error: row.error,
    actorUserId: caller.userId ?? null,
    correlationId: ctx.correlationId,
    createdAt: now,
  });
}

export function createIncidentsActionsRoute(options: IncidentsActionsRouteOptions): Route[] {
  const handler = async (ctx: RequestContext): Promise<RouteResponse> => {
    const caller = requireCaller(options.resolveCaller, ctx);
    const tenantId = requireParam(ctx, "tenantId");
    const incidentId = requireParam(ctx, "incidentId");
    const action = requireParam(ctx, "action");

    requireTenantInScope(caller, tenantId);
    await ensureTriagePermissions(options, caller);

    const result = await postIncidentAction(options, ctx, tenantId, caller, incidentId, action);
    return { status: result.status, body: result.body };
  };
  return [{ method: "POST", path: INCIDENT_ACTIONS_PATH, handler }];
}

// Route modules own their OpenAPI path items (portal.v1.yaml `paths` is empty
// by design); a wiring ticket merges this fragment into the served document.
export const INCIDENT_ACTIONS_OPENAPI = {
  paths: {
    "/tenants/{tenantId}/incidents/{incidentId}/{action}": {
      post: {
        operationId: "applyIncidentAction",
        summary:
          "Assign, set status, classify, or comment on a security incident; status/classify write back to Graph, assign/comment persist portal-side; bulk and resolve require confirmation",
        permission: INCIDENT_ACTIONS_TRIAGE_PERMISSION,
        security: [{ bearerAuth: [] }],
        parameters: [
          { name: "tenantId", in: "path", required: true, schema: { type: "string" } },
          { name: "incidentId", in: "path", required: true, schema: { type: "string" } },
          {
            name: "action",
            in: "path",
            required: true,
            schema: { type: "string", enum: [...INCIDENT_ACTIONS] },
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
                      "New status, classification, or assignee. Required for assign, status, and classify.",
                  },
                  comment: { type: "string", description: "Comment body. Required for comment." },
                  reason: {
                    type: "string",
                    description: "Triage reason recorded on the state change and audit event.",
                  },
                  confirm: {
                    type: "boolean",
                    description:
                      "Explicit confirmation. Required for bulk changes and for any status change to resolved.",
                  },
                  dryRun: { type: "boolean", description: "Plan the change with no tenant write." },
                  incidentIds: {
                    type: "array",
                    items: { type: "string" },
                    description:
                      "Additional target incident ids. More than one target makes the call bulk and requires confirm.",
                  },
                },
              },
            },
          },
        },
        responses: {
          "200": {
            description:
              "The per-incident action rows with before/after, from/to, and the persisted note (comment only).",
          },
          "400": { description: "Unknown action, invalid value, or missing confirmation/reason." },
          "401": { description: "Authentication is required." },
          "403": {
            description:
              "The caller lacks Security.Incident.ReadWrite or Remediation.Apply, or the tenant is out of scope.",
          },
          "501": { description: "Incident actions are not wired for this tenant." },
        },
      },
    },
  },
} as const;
