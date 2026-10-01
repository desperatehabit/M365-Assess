// Alert rule CRUD API (EPIC-029 SPEC.md §2 US-1, §3.1, §6, §7; T-0562).
//
//   GET    /v1/alert-rules               -> built-in and custom rules (§3.1 columns)
//   POST   /v1/alert-rules               -> create a custom rule
//   PATCH  /v1/alert-rules/{ruleId}      -> edit a rule (name/source/severity/scope/channels)
//   DELETE /v1/alert-rules/{ruleId}      -> delete a rule
//   POST   /v1/alert-rules/{ruleId}/toggle -> enable/disable a rule (audited)
//
// Built-ins come from the curated catalog (domain/alerts/builtin-catalog.ts) and are
// seeded as disabled rules the operator can enable. Reads require `alerts.read` and
// every mutation requires `alerts.write`; full RBAC is EPIC-038, so this uses the
// EPIC-001 T-0013 authorizer seam and denies without one. Alerting never writes to a
// tenant (SPEC §8): this route only persists rule configuration. `Test` is T-0564.

import { randomUUID } from "node:crypto";
import {
  isAlertChannel,
  isAlertScope,
  isAlertSeverity,
  toAlertRuleView,
  type AlertChannel,
  type AlertRule,
  type AlertRuleView,
  type AlertScope,
  type AlertSeverity,
} from "../domain/alerts/builtin-catalog.js";
import { AppError, ErrorCodes } from "../errors.js";
import { requirePermission, type Caller } from "../rbac/authorize.js";
import type { Permission } from "../rbac/roles.js";
import type { RequestContext, Route, RouteResponse } from "../server.js";

export const ALERT_RULES_PATH = "/v1/alert-rules";
export const ALERT_RULE_PATH = "/v1/alert-rules/:ruleId";
export const ALERT_RULE_TOGGLE_PATH = "/v1/alert-rules/:ruleId/toggle";

export const ALERT_RULES_READ_PERMISSION = "alerts.read";
export const ALERT_RULES_WRITE_PERMISSION = "alerts.write";
export const ALERT_RULES_UNAUTHENTICATED = "request.unauthenticated";
export const ALERT_RULE_NOT_FOUND = "alert.rule_not_found";

export interface AlertRuleInput {
  readonly name: string;
  readonly source: string;
  readonly severity: AlertSeverity;
  readonly scope: AlertScope;
  readonly channels: readonly AlertChannel[];
  readonly enabled?: boolean;
  readonly scriptMode?: boolean;
  readonly scheduleId?: string | null;
}

export interface AlertRuleCreate extends AlertRuleInput {
  readonly id: string;
}

export interface AlertRulePatch {
  readonly name?: string;
  readonly source?: string;
  readonly severity?: AlertSeverity;
  readonly scope?: AlertScope;
  readonly channels?: readonly AlertChannel[];
  readonly enabled?: boolean;
  readonly scriptMode?: boolean;
  readonly scheduleId?: string | null;
}

export interface AlertRulesStore {
  listRules(): Promise<readonly AlertRule[]>;
  getRule(ruleId: string): Promise<AlertRule | undefined>;
  createRule(input: AlertRuleCreate): Promise<AlertRule>;
  updateRule(ruleId: string, patch: AlertRulePatch): Promise<AlertRule | undefined>;
  deleteRule(ruleId: string): Promise<boolean>;
  setRuleEnabled(ruleId: string, enabled: boolean): Promise<AlertRule | undefined>;
}

export interface AlertRulesAuditPort {
  record(event: Record<string, unknown>): Promise<void> | void;
}

export interface AlertRulesOptions {
  readonly store: AlertRulesStore;
  readonly resolveCaller: (ctx: RequestContext) => Caller | undefined;
  readonly authorize?: (caller: Caller, permission: string) => void | Promise<void>;
  readonly audit?: AlertRulesAuditPort;
  /** Test seam for deterministic ids; defaults to a random UUID. */
  readonly generateId?: () => string;
}

function unauthenticatedError(): AppError {
  return new AppError(ALERT_RULES_UNAUTHENTICATED, "authentication required", 401);
}

function validationError(message: string, field: string): AppError {
  return new AppError(ErrorCodes.validationFailed, message, 400, [
    { field, reason: "invalid" },
  ]);
}

function notFoundError(ruleId: string): AppError {
  return new AppError(ALERT_RULE_NOT_FOUND, `Alert rule ${ruleId} not found`, 404);
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function requireCaller(options: AlertRulesOptions, ctx: RequestContext): Caller {
  const caller = options.resolveCaller(ctx);
  if (!caller) {
    throw unauthenticatedError();
  }
  return caller;
}

async function ensureAuthorized(
  options: AlertRulesOptions,
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

function requireText(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw validationError(`${field} must be a non-empty string`, field);
  }
  return value.trim();
}

function parseChannels(value: unknown): AlertChannel[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw validationError("channels must be a non-empty array", "channels");
  }
  const channels: AlertChannel[] = [];
  for (const entry of value) {
    if (!isAlertChannel(entry)) {
      throw validationError(
        `channels contains unknown channel ${JSON.stringify(entry)}`,
        "channels",
      );
    }
    if (!channels.includes(entry)) {
      channels.push(entry);
    }
  }
  return channels;
}

function parseCreateInput(body: Record<string, unknown>): AlertRuleInput {
  if (!isAlertSeverity(body["severity"])) {
    throw validationError("severity must be a known severity", "severity");
  }
  if (!isAlertScope(body["scope"])) {
    throw validationError("scope must be tenant or group", "scope");
  }
  return {
    name: requireText(body["name"], "name"),
    source: requireText(body["source"], "source"),
    severity: body["severity"],
    scope: body["scope"],
    channels: parseChannels(body["channels"]),
    ...(typeof body["enabled"] === "boolean" ? { enabled: body["enabled"] } : {}),
    ...(typeof body["scriptMode"] === "boolean" ? { scriptMode: body["scriptMode"] } : {}),
    ...(body["scheduleId"] === null || typeof body["scheduleId"] === "string"
      ? { scheduleId: body["scheduleId"] as string | null }
      : {}),
  };
}

function parsePatchInput(body: Record<string, unknown>): AlertRulePatch {
  const patch: {
    name?: string;
    source?: string;
    severity?: AlertSeverity;
    scope?: AlertScope;
    channels?: readonly AlertChannel[];
    enabled?: boolean;
    scriptMode?: boolean;
    scheduleId?: string | null;
  } = {};
  if (body["name"] !== undefined) patch.name = requireText(body["name"], "name");
  if (body["source"] !== undefined) patch.source = requireText(body["source"], "source");
  if (body["severity"] !== undefined) {
    if (!isAlertSeverity(body["severity"])) {
      throw validationError("severity must be a known severity", "severity");
    }
    patch.severity = body["severity"];
  }
  if (body["scope"] !== undefined) {
    if (!isAlertScope(body["scope"])) {
      throw validationError("scope must be tenant or group", "scope");
    }
    patch.scope = body["scope"];
  }
  if (body["channels"] !== undefined) patch.channels = parseChannels(body["channels"]);
  if (body["enabled"] !== undefined) {
    if (typeof body["enabled"] !== "boolean") {
      throw validationError("enabled must be a boolean", "enabled");
    }
    patch.enabled = body["enabled"];
  }
  if (body["scriptMode"] !== undefined) {
    if (typeof body["scriptMode"] !== "boolean") {
      throw validationError("scriptMode must be a boolean", "scriptMode");
    }
    patch.scriptMode = body["scriptMode"];
  }
  if (body["scheduleId"] !== undefined) {
    if (body["scheduleId"] !== null && typeof body["scheduleId"] !== "string") {
      throw validationError("scheduleId must be a string or null", "scheduleId");
    }
    patch.scheduleId = body["scheduleId"] as string | null;
  }
  return patch;
}

export function createAlertRulesRoutes(options: AlertRulesOptions): Route[] {
  const generateId = options.generateId ?? (() => randomUUID());

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
    await ensureAuthorized(options, caller, ALERT_RULES_READ_PERMISSION);
    const rules: AlertRuleView[] = (await options.store.listRules()).map(toAlertRuleView);
    return {
      status: 200,
      headers: { "content-type": "application/json" },
      body: { rules },
    };
  }

  async function handleCreate(ctx: RequestContext): Promise<RouteResponse> {
    const caller = requireCaller(options, ctx);
    await ensureAuthorized(options, caller, ALERT_RULES_WRITE_PERMISSION);
    const input = parseCreateInput(asRecord(ctx.body));
    const created = await options.store.createRule({ ...input, id: generateId() });
    await recordAudit(ctx, {
      action: "alert-rule.create",
      ruleId: created.id,
      name: created.name,
      builtIn: created.builtIn,
    });
    return {
      status: 201,
      headers: { "content-type": "application/json" },
      body: { rule: toAlertRuleView(created) },
    };
  }

  async function handlePatch(ctx: RequestContext): Promise<RouteResponse> {
    const caller = requireCaller(options, ctx);
    await ensureAuthorized(options, caller, ALERT_RULES_WRITE_PERMISSION);
    const ruleId = requireRuleIdParam(ctx);
    const patch = parsePatchInput(asRecord(ctx.body));
    const updated = await options.store.updateRule(ruleId, patch);
    if (!updated) {
      throw notFoundError(ruleId);
    }
    await recordAudit(ctx, {
      action: "alert-rule.update",
      ruleId,
      fields: Object.keys(patch),
    });
    return {
      status: 200,
      headers: { "content-type": "application/json" },
      body: { rule: toAlertRuleView(updated) },
    };
  }

  async function handleDelete(ctx: RequestContext): Promise<RouteResponse> {
    const caller = requireCaller(options, ctx);
    await ensureAuthorized(options, caller, ALERT_RULES_WRITE_PERMISSION);
    const ruleId = requireRuleIdParam(ctx);
    const deleted = await options.store.deleteRule(ruleId);
    if (!deleted) {
      throw notFoundError(ruleId);
    }
    await recordAudit(ctx, { action: "alert-rule.delete", ruleId });
    return {
      status: 200,
      headers: { "content-type": "application/json" },
      body: { id: ruleId, deleted: true },
    };
  }

  async function handleToggle(ctx: RequestContext): Promise<RouteResponse> {
    const caller = requireCaller(options, ctx);
    await ensureAuthorized(options, caller, ALERT_RULES_WRITE_PERMISSION);
    const ruleId = requireRuleIdParam(ctx);
    const existing = await options.store.getRule(ruleId);
    if (!existing) {
      throw notFoundError(ruleId);
    }
    const body = asRecord(ctx.body);
    if (body["enabled"] !== undefined && typeof body["enabled"] !== "boolean") {
      throw validationError("enabled must be a boolean", "enabled");
    }
    const enabled = typeof body["enabled"] === "boolean" ? body["enabled"] : !existing.enabled;
    const updated = await options.store.setRuleEnabled(ruleId, enabled);
    if (!updated) {
      throw notFoundError(ruleId);
    }
    await recordAudit(ctx, { action: "alert-rule.toggle", ruleId, enabled });
    return {
      status: 200,
      headers: { "content-type": "application/json" },
      body: { rule: toAlertRuleView(updated) },
    };
  }

  return [
    { method: "GET", path: ALERT_RULES_PATH, handler: handleList },
    { method: "POST", path: ALERT_RULES_PATH, handler: handleCreate },
    { method: "PATCH", path: ALERT_RULE_PATH, handler: handlePatch },
    { method: "DELETE", path: ALERT_RULE_PATH, handler: handleDelete },
    { method: "POST", path: ALERT_RULE_TOGGLE_PATH, handler: handleToggle },
  ];
}

// ─── OpenAPI fragment (§6) ───────────────────────────────────────────────────

export const ALERT_RULES_OPENAPI = {
  paths: {
    "/alert-rules": {
      get: {
        tags: ["Alerting"],
        operationId: "listAlertRules",
        summary: "List built-in and custom alert rules with the §3.1 columns.",
        permission: ALERT_RULES_READ_PERMISSION,
        security: [{ bearerAuth: [] }],
        responses: {
          "200": { description: "Built-in and custom rules." },
          "401": { description: "Authentication is required." },
          "403": { description: "The caller lacks alerts.read." },
        },
      },
      post: {
        tags: ["Alerting"],
        operationId: "createAlertRule",
        summary: "Create a custom alert rule with a scope and channels.",
        permission: ALERT_RULES_WRITE_PERMISSION,
        security: [{ bearerAuth: [] }],
        responses: {
          "201": { description: "Rule created." },
          "400": { description: "The rule body is invalid." },
          "403": { description: "The caller lacks alerts.write." },
        },
      },
    },
    "/alert-rules/{ruleId}": {
      patch: {
        tags: ["Alerting"],
        operationId: "updateAlertRule",
        summary: "Edit an alert rule's name, source, severity, scope, or channels.",
        permission: ALERT_RULES_WRITE_PERMISSION,
        security: [{ bearerAuth: [] }],
        parameters: [{ name: "ruleId", in: "path", required: true, schema: { type: "string" } }],
        responses: {
          "200": { description: "Rule updated." },
          "400": { description: "The patch body is invalid." },
          "404": { description: "No such rule." },
        },
      },
      delete: {
        tags: ["Alerting"],
        operationId: "deleteAlertRule",
        summary: "Delete an alert rule.",
        permission: ALERT_RULES_WRITE_PERMISSION,
        security: [{ bearerAuth: [] }],
        parameters: [{ name: "ruleId", in: "path", required: true, schema: { type: "string" } }],
        responses: {
          "200": { description: "Rule deleted." },
          "404": { description: "No such rule." },
        },
      },
    },
    "/alert-rules/{ruleId}/toggle": {
      post: {
        tags: ["Alerting"],
        operationId: "toggleAlertRule",
        summary: "Enable or disable an alert rule (audited).",
        permission: ALERT_RULES_WRITE_PERMISSION,
        security: [{ bearerAuth: [] }],
        parameters: [{ name: "ruleId", in: "path", required: true, schema: { type: "string" } }],
        responses: {
          "200": { description: "Rule enabled or disabled." },
          "400": { description: "The toggle body is invalid." },
          "404": { description: "No such rule." },
        },
      },
    },
  },
} as const;
