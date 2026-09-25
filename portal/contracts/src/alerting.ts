// Alerting contracts (EPIC-029 SPEC.md §5). `AlertRule.conditions` and
// `AlertRule.actions` are free-form JSON at storage level but are validated at
// the boundary: a malformed rule is rejected here rather than persisted and
// discovered by the evaluator. The shapes are shared by the BFF repository and
// the web UI so one list of channels/operators is the source of truth.

export const ALERT_CHANNELS = ["email", "webhook", "psa", "slack"] as const;

export type AlertChannel = (typeof ALERT_CHANNELS)[number];

export const ALERT_CONDITION_OPERATORS = [
  "eq",
  "ne",
  "like",
  "match",
  "gt",
  "in",
  "contains",
] as const;

export type AlertConditionOperator = (typeof ALERT_CONDITION_OPERATORS)[number];

export const ALERT_EVENT_STATES = ["open", "snoozed", "resolved"] as const;

export type AlertEventState = (typeof ALERT_EVENT_STATES)[number];

export const ALERT_SEVERITIES = ["Critical", "High", "Medium", "Low", "Info"] as const;

export type AlertSeverity = (typeof ALERT_SEVERITIES)[number];

// One row of the builder's dynamic condition table (SPEC §3.2): property /
// operator / input. `input` is the comparison value and may be any JSON scalar.
export interface AlertCondition {
  property: string;
  operator: AlertConditionOperator;
  input: unknown;
}

// An action names a delivery channel and the target within it (recipient
// address, webhook id, …). Script mode replaces actions with the schedule in
// `AlertRule.scheduleId`.
export interface AlertAction {
  channel: AlertChannel;
  target?: string;
}

export interface AlertRule {
  id: string;
  name: string;
  source: string;
  conditions: AlertCondition[];
  actions: AlertAction[];
  enabled: boolean;
  scriptMode: boolean;
  scheduleId: string | null;
}

export interface AlertEvent {
  id: string;
  ruleId: string;
  tenantId: string;
  firedAt: string;
  severity: AlertSeverity;
  payload: Record<string, unknown>;
  state: AlertEventState;
  snoozeUntil: string | null;
}

export interface NotificationConfig {
  id: string;
  channel: AlertChannel;
  target: string;
  enabled: boolean;
}

export interface WebhookRule {
  id: string;
  url: string;
  match: string;
  enabled: boolean;
}

export class AlertValidationError extends Error {
  readonly code: string;
  readonly path: string | undefined;

  constructor(code: string, message: string, path?: string) {
    super(message);
    this.name = "AlertValidationError";
    this.code = code;
    this.path = path;
  }
}

export function isAlertChannel(value: unknown): value is AlertChannel {
  return typeof value === "string" && (ALERT_CHANNELS as readonly string[]).includes(value);
}

export function isAlertConditionOperator(value: unknown): value is AlertConditionOperator {
  return (
    typeof value === "string" &&
    (ALERT_CONDITION_OPERATORS as readonly string[]).includes(value)
  );
}

export function isAlertEventState(value: unknown): value is AlertEventState {
  return typeof value === "string" && (ALERT_EVENT_STATES as readonly string[]).includes(value);
}

/**
 * Parses a rule's `conditions`, which may be given as a JSON string or an
 * already-decoded value. Malformed JSON — or a shape that is not an array of
 * `{ property, operator, input }` — raises a structured error so the caller
 * can map it to a 4xx rather than storing garbage.
 */
export function parseAlertConditions(input: string | unknown): AlertCondition[] {
  const value = decodeJson(input, "conditions", "alert.invalid_conditions_json");
  return parseConditionArray(value, "conditions");
}

/**
 * Parses a rule's `actions` (JSON string or decoded value). Each entry must
 * name a known `channel`; `target` is optional but must be a string when set.
 */
export function parseAlertActions(input: string | unknown): AlertAction[] {
  const value = decodeJson(input, "actions", "alert.invalid_actions_json");
  return parseActionArray(value, "actions");
}

/** Validates a decoded `AlertCondition[]` (used by the repository on read). */
export function parseConditionArray(value: unknown, path = "conditions"): AlertCondition[] {
  if (!Array.isArray(value)) {
    throw invalid(`Field '${path}' must be a JSON array`, path, "alert.invalid_conditions");
  }
  return value.map((entry, index) => parseCondition(entry, `${path}[${index}]`));
}

/** Validates a decoded `AlertAction[]` (used by the repository on read). */
export function parseActionArray(value: unknown, path = "actions"): AlertAction[] {
  if (!Array.isArray(value)) {
    throw invalid(`Field '${path}' must be a JSON array`, path, "alert.invalid_actions");
  }
  return value.map((entry, index) => parseAction(entry, `${path}[${index}]`));
}

function parseCondition(value: unknown, path: string): AlertCondition {
  const record = asRecord(value, path, "alert.invalid_conditions");
  if (typeof record.property !== "string" || record.property.length === 0) {
    throw invalid(`Condition is missing required string field 'property'`, `${path}.property`, "alert.invalid_conditions");
  }
  if (!isAlertConditionOperator(record.operator)) {
    throw invalid(
      `Condition has unknown operator ${JSON.stringify(record.operator)}`,
      `${path}.operator`,
      "alert.invalid_conditions",
    );
  }
  return {
    property: record.property,
    operator: record.operator,
    input: record.input,
  };
}

function parseAction(value: unknown, path: string): AlertAction {
  const record = asRecord(value, path, "alert.invalid_actions");
  if (!isAlertChannel(record.channel)) {
    throw invalid(
      `Action has unknown channel ${JSON.stringify(record.channel)}`,
      `${path}.channel`,
      "alert.invalid_actions",
    );
  }
  if (record.target !== undefined && record.target !== null && typeof record.target !== "string") {
    throw invalid(`Action field 'target' must be a string`, `${path}.target`, "alert.invalid_actions");
  }
  const action: AlertAction = { channel: record.channel };
  if (typeof record.target === "string") action.target = record.target;
  return action;
}

function decodeJson(input: string | unknown, path: string, jsonCode: string): unknown {
  if (typeof input !== "string") {
    return input;
  }
  try {
    return JSON.parse(input);
  } catch {
    throw invalid(`Field '${path}' is not valid JSON`, path, jsonCode);
  }
}

function asRecord(value: unknown, path: string, code: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw invalid(`'${path}' must be a JSON object`, path, code);
  }
  return value as Record<string, unknown>;
}

function invalid(message: string, path: string, code: string): AlertValidationError {
  return new AlertValidationError(code, message, path);
}
