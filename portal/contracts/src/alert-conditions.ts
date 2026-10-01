// Custom alert criteria model (EPIC-029 SPEC.md §3.2, §7, §8; T-0563).
//
// The builder's criteria document: dynamic condition rows (Property / Operator /
// Input) plus the actions taken on a match. §3.2 offers two action kinds —
// notification channels and script mode — so actions are a discriminated union
// on `kind`. Script mode is high privilege (arbitrary script, §7): it is
// representable here, but persisting it is gated on the admin role exactly
// like EPIC-007 custom scripts (T-0126 sandbox, admin gate, audit).
// `postExecutionActions` name EPIC-006 remediation actions and are never
// executed by this contract.
//
// The operator vocabulary and the condition-row shape come from `./alerting.js`
// so the whole portal keeps one list of §3.2 operators.

import {
  ALERT_CONDITION_OPERATORS,
  AlertValidationError,
  isAlertChannel,
  isAlertConditionOperator,
  parseConditionArray,
  type AlertChannel,
  type AlertCondition,
  type AlertConditionOperator,
} from "./alerting.js";

export {
  ALERT_CONDITION_OPERATORS,
  isAlertConditionOperator,
  type AlertChannel,
  type AlertCondition,
  type AlertConditionOperator,
};

// One dynamic condition row of the §3.2 builder table: property / operator /
// input, where `input` is the comparison value and may be any JSON scalar.
export type AlertConditionRow = AlertCondition;

// A notification-channel action: deliver the fired alert to `channel` at
// `target` (recipient address, webhook id, …).
export interface AlertChannelCriteriaAction {
  kind: "channel";
  channel: AlertChannel;
  target?: string;
}

// A script-mode action (§3.2): run the EPIC-007 alerting `scriptId` instead of
// delivering a notification. `recurrence` and `firstRunAt` are schedule
// inputs, `dynamicInputs` are resolved from the matched event at run time, and
// `postExecutionActions` are EPIC-006 remediation action ids. Nothing here
// executes a script — the T-0564 evaluator dispatches script-mode rules to the
// EPIC-007 sandbox.
export interface AlertScriptCriteriaAction {
  kind: "script";
  scriptId: string;
  recurrence?: string;
  firstRunAt?: string;
  dynamicInputs?: string[];
  postExecutionActions?: string[];
}

export type AlertCriteriaAction = AlertChannelCriteriaAction | AlertScriptCriteriaAction;

// The criteria document the builder produces and the evaluator consumes.
export interface AlertCriteria {
  conditions: AlertConditionRow[];
  actions: AlertCriteriaAction[];
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
 * kinds/channels, and malformed rows raise a structured `AlertValidationError`
 * so the caller can map it to a 4xx rather than persisting garbage.
 */
export function validateAlertCriteria(value: unknown): AlertCriteria {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw invalid("Criteria document must be a JSON object", "criteria", "alert.invalid_criteria");
  }
  const record = value as Record<string, unknown>;
  if (!Array.isArray(record.conditions)) {
    throw invalid("Field 'conditions' must be a JSON array", "conditions", "alert.invalid_criteria");
  }
  if (!Array.isArray(record.actions)) {
    throw invalid("Field 'actions' must be a JSON array", "actions", "alert.invalid_criteria");
  }
  return {
    conditions: parseConditionArray(record.conditions, "conditions"),
    actions: record.actions.map((entry, index) => parseCriteriaAction(entry, `actions[${index}]`)),
  };
}

function parseCriteriaAction(value: unknown, path: string): AlertCriteriaAction {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw invalid(`'${path}' must be a JSON object`, path, "alert.invalid_criteria_action");
  }
  const record = value as Record<string, unknown>;
  if (record.kind === "channel") {
    if (!isAlertChannel(record.channel)) {
      throw invalid(
        `Action has unknown channel ${JSON.stringify(record.channel)}`,
        `${path}.channel`,
        "alert.invalid_criteria_action",
      );
    }
    if (record.target !== undefined && record.target !== null && typeof record.target !== "string") {
      throw invalid(`Action field 'target' must be a string`, `${path}.target`, "alert.invalid_criteria_action");
    }
    const action: AlertChannelCriteriaAction = { kind: "channel", channel: record.channel };
    if (typeof record.target === "string") action.target = record.target;
    return action;
  }
  if (record.kind === "script") {
    if (typeof record.scriptId !== "string" || record.scriptId.length === 0) {
      throw invalid(
        `Script action is missing required string field 'scriptId'`,
        `${path}.scriptId`,
        "alert.invalid_criteria_action",
      );
    }
    for (const field of ["recurrence", "firstRunAt"] as const) {
      if (record[field] !== undefined && record[field] !== null && typeof record[field] !== "string") {
        throw invalid(`Script action field '${field}' must be a string`, `${path}.${field}`, "alert.invalid_criteria_action");
      }
    }
    for (const field of ["dynamicInputs", "postExecutionActions"] as const) {
      if (record[field] !== undefined && record[field] !== null && !isStringArray(record[field])) {
        throw invalid(
          `Script action field '${field}' must be an array of strings`,
          `${path}.${field}`,
          "alert.invalid_criteria_action",
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
  throw invalid(
    `Action has unknown kind ${JSON.stringify(record.kind)}`,
    `${path}.kind`,
    "alert.invalid_criteria_action",
  );
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string");
}

function invalid(message: string, path: string, code: string): AlertValidationError {
  return new AlertValidationError(code, message, path);
}
