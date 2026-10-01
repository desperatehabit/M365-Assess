// Custom alert criteria validation, script-mode gating, and condition
// evaluation (EPIC-029 SPEC.md §3.2, §4.1, §4.2, §7, §8; T-0563).
//
// `@m365-assess/contracts/alert-conditions` owns the canonical criteria model,
// but that module is not an exported subpath of `@m365-assess/contracts` and
// sits outside the BFF tsconfig rootDir, so the pure helpers are restated here
// (the same convention as domain/alerts/builtin-catalog.ts and
// domain/alerts/delivery/email.ts). The evaluator is pure and side-effect-free:
// it never executes scripts — script-mode rules are dispatched to the
// EPIC-007 sandbox by the T-0564 evaluator.

import { AppError, ErrorCodes } from "../../errors.js";
import { RbacErrorCodes, isAdmin, type Caller } from "../../rbac/authorize.js";

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

export type AlertChannel = "email" | "webhook" | "psa" | "slack";

export interface AlertConditionRow {
  readonly property: string;
  readonly operator: AlertConditionOperator;
  readonly input: unknown;
}

export interface AlertChannelCriteriaAction {
  kind: "channel";
  channel: AlertChannel;
  target?: string;
}

export interface AlertScriptCriteriaAction {
  kind: "script";
  scriptId: string;
  recurrence?: string;
  firstRunAt?: string;
  dynamicInputs?: string[];
  postExecutionActions?: string[];
}

export type AlertCriteriaAction = AlertChannelCriteriaAction | AlertScriptCriteriaAction;

export interface AlertCriteria {
  conditions: AlertConditionRow[];
  actions: AlertCriteriaAction[];
}

export interface AlertConditionEvaluation {
  readonly property: string;
  readonly operator: AlertConditionOperator;
  readonly matched: boolean;
}

export interface AlertEvaluationResult {
  readonly matched: boolean;
  readonly evaluations: readonly AlertConditionEvaluation[];
}

export function isAlertConditionOperator(value: unknown): value is AlertConditionOperator {
  return typeof value === "string" && (ALERT_CONDITION_OPERATORS as readonly string[]).includes(value);
}

export function isChannelCriteriaAction(
  action: AlertCriteriaAction,
): action is AlertChannelCriteriaAction {
  return action.kind === "channel";
}

export function isScriptCriteriaAction(
  action: AlertCriteriaAction,
): action is AlertScriptCriteriaAction {
  return action.kind === "script";
}

// Script mode is the only high-privilege action kind (§7): it can run
// arbitrary script, so persisting it requires the admin gate.
export function isHighPrivilegeCriteriaAction(action: AlertCriteriaAction): boolean {
  return isScriptCriteriaAction(action);
}

/** True when any action in the document is script mode and needs the admin gate. */
export function criteriaRequiresAdminGate(criteria: AlertCriteria): boolean {
  return criteria.actions.some(isHighPrivilegeCriteriaAction);
}

/**
 * Validates a decoded criteria document. Unknown operators, unknown action
 * kinds/channels, and malformed rows raise a 400 `AppError` so the route can
 * reject the payload rather than persisting garbage.
 */
export function validateAlertCriteria(value: unknown): AlertCriteria {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw validationError("Criteria document must be a JSON object", "criteria");
  }
  const record = value as Record<string, unknown>;
  if (!Array.isArray(record.conditions)) {
    throw validationError("Field 'conditions' must be a JSON array", "conditions");
  }
  if (!Array.isArray(record.actions)) {
    throw validationError("Field 'actions' must be a JSON array", "actions");
  }
  return {
    conditions: record.conditions.map((entry, index) => parseConditionRow(entry, `conditions[${index}]`)),
    actions: record.actions.map((entry, index) => parseCriteriaAction(entry, `actions[${index}]`)),
  };
}

/**
 * Persist gate for a criteria document. Script-mode actions are high privilege
 * (§7) and gated like EPIC-007 custom scripts: only a caller holding the admin
 * role may persist them. Channel-only documents persist for any caller.
 */
export function assertCriteriaPersistable(criteria: AlertCriteria, caller: Caller): void {
  if (!criteriaRequiresAdminGate(criteria)) {
    return;
  }
  if (isAdmin(caller)) {
    return;
  }
  throw new AppError(
    RbacErrorCodes.forbidden,
    "script-mode alert criteria are high privilege and require the admin gate",
    403,
    [{ field: "actions", reason: "script_mode_requires_admin" }],
  );
}

/**
 * Evaluates a condition set against a property bag. Pure and deterministic:
 * every row must match (AND semantics; an empty set matches vacuously), and a
 * property absent from the bag never matches — fail-closed on incomplete
 * data. Operator semantics:
 * - `eq` / `ne`: deep equality (and its negation) between value and input.
 * - `like`: SQL-LIKE pattern — `%` matches any run of characters, `_` matches
 *   exactly one, case-insensitive; both sides must be strings.
 * - `match`: ECMAScript regex; the input is the pattern, the value must be a
 *   string, and an invalid pattern never matches.
 * - `gt`: numeric comparison when both sides are numbers, lexicographic when
 *   both are strings, otherwise no match.
 * - `in`: the input must be an array and the value must equal one of its
 *   elements.
 * - `contains`: substring for string values, element equality for array
 *   values.
 */
export function evaluate(
  conditions: readonly AlertConditionRow[],
  propertyBag: Record<string, unknown>,
): AlertEvaluationResult {
  const evaluations = conditions.map((condition) => ({
    property: condition.property,
    operator: condition.operator,
    matched: evaluateConditionRow(condition, propertyBag),
  }));
  return { matched: evaluations.every((entry) => entry.matched), evaluations };
}

function evaluateConditionRow(condition: AlertConditionRow, propertyBag: Record<string, unknown>): boolean {
  if (!Object.hasOwn(propertyBag, condition.property)) {
    return false;
  }
  const value = propertyBag[condition.property];
  const input = condition.input;
  switch (condition.operator) {
    case "eq":
      return valuesEqual(value, input);
    case "ne":
      return !valuesEqual(value, input);
    case "like":
      return typeof value === "string" && typeof input === "string" && likeMatches(value, input);
    case "match":
      return typeof value === "string" && typeof input === "string" && regexMatches(value, input);
    case "gt":
      return compareGreater(value, input);
    case "in":
      return Array.isArray(input) && input.some((entry) => valuesEqual(value, entry));
    case "contains":
      return containsValue(value, input);
  }
}

function likeMatches(value: string, pattern: string): boolean {
  let source = "^";
  for (const char of pattern) {
    if (char === "%") {
      source += ".*";
    } else if (char === "_") {
      source += ".";
    } else {
      source += escapeRegExp(char);
    }
  }
  return new RegExp(`${source}$`, "i").test(value);
}

function regexMatches(value: string, pattern: string): boolean {
  try {
    return new RegExp(pattern).test(value);
  } catch {
    return false;
  }
}

function compareGreater(value: unknown, input: unknown): boolean {
  if (typeof value === "number" && typeof input === "number") {
    return value > input;
  }
  if (typeof value === "string" && typeof input === "string") {
    return value > input;
  }
  return false;
}

function containsValue(value: unknown, input: unknown): boolean {
  if (typeof value === "string") {
    return typeof input === "string" && value.includes(input);
  }
  if (Array.isArray(value)) {
    return value.some((entry) => valuesEqual(entry, input));
  }
  return false;
}

function valuesEqual(left: unknown, right: unknown): boolean {
  if (left === right) {
    return true;
  }
  if (Array.isArray(left) && Array.isArray(right)) {
    return left.length === right.length && left.every((entry, index) => valuesEqual(entry, right[index]));
  }
  if (isRecord(left) && isRecord(right)) {
    const leftKeys = Object.keys(left);
    const rightKeys = Object.keys(right);
    return (
      leftKeys.length === rightKeys.length &&
      leftKeys.every((key) => key in right && valuesEqual(left[key], right[key]))
    );
  }
  return false;
}

function parseConditionRow(value: unknown, path: string): AlertConditionRow {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw validationError(`'${path}' must be a JSON object`, path);
  }
  const record = value as Record<string, unknown>;
  if (typeof record.property !== "string" || record.property.length === 0) {
    throw validationError(`Condition is missing required string field 'property'`, `${path}.property`);
  }
  if (!isAlertConditionOperator(record.operator)) {
    throw validationError(
      `Condition has unknown operator ${JSON.stringify(record.operator)}`,
      `${path}.operator`,
    );
  }
  return { property: record.property, operator: record.operator, input: record.input };
}

function parseCriteriaAction(value: unknown, path: string): AlertCriteriaAction {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw validationError(`'${path}' must be a JSON object`, path);
  }
  const record = value as Record<string, unknown>;
  if (record.kind === "channel") {
    if (!isAlertChannel(record.channel)) {
      throw validationError(
        `Action has unknown channel ${JSON.stringify(record.channel)}`,
        `${path}.channel`,
      );
    }
    if (record.target !== undefined && record.target !== null && typeof record.target !== "string") {
      throw validationError(`Action field 'target' must be a string`, `${path}.target`);
    }
    const action: AlertChannelCriteriaAction = { kind: "channel", channel: record.channel };
    if (typeof record.target === "string") action.target = record.target;
    return action;
  }
  if (record.kind === "script") {
    if (typeof record.scriptId !== "string" || record.scriptId.length === 0) {
      throw validationError(
        `Script action is missing required string field 'scriptId'`,
        `${path}.scriptId`,
      );
    }
    for (const field of ["recurrence", "firstRunAt"] as const) {
      if (record[field] !== undefined && record[field] !== null && typeof record[field] !== "string") {
        throw validationError(`Script action field '${field}' must be a string`, `${path}.${field}`);
      }
    }
    for (const field of ["dynamicInputs", "postExecutionActions"] as const) {
      if (record[field] !== undefined && record[field] !== null && !isStringArray(record[field])) {
        throw validationError(
          `Script action field '${field}' must be an array of strings`,
          `${path}.${field}`,
        );
      }
    }
    const action: AlertScriptCriteriaAction = { kind: "script", scriptId: record.scriptId };
    if (typeof record.recurrence === "string") action.recurrence = record.recurrence;
    if (typeof record.firstRunAt === "string") action.firstRunAt = record.firstRunAt;
    if (Array.isArray(record.dynamicInputs)) action.dynamicInputs = record.dynamicInputs;
    if (Array.isArray(record.postExecutionActions)) action.postExecutionActions = record.postExecutionActions;
    return action;
  }
  throw validationError(`Action has unknown kind ${JSON.stringify(record.kind)}`, `${path}.kind`);
}

function isAlertChannel(value: unknown): value is AlertChannel {
  return value === "email" || value === "webhook" || value === "psa" || value === "slack";
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function escapeRegExp(char: string): string {
  return /[.*+?^${}()|[\]\\]/.test(char) ? `\\${char}` : char;
}

function validationError(message: string, field: string): AppError {
  return new AppError(ErrorCodes.validationFailed, message, 400, [{ field, reason: "invalid" }]);
}
