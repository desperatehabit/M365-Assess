// Transport rule condition/action builder (EPIC-021 SPEC.md §4.1, §11.1; T-0402).
// Resolved §11.1 adopts the common condition/action set first; full EXO parity
// is a later cut. The builder validates every condition, action, and exception
// against the adopted common set and rejects anything outside it with a
// structured error — an unsupported field is never silently dropped.
import { AppError, ErrorCodes } from "../../errors.js";

export const TRANSPORT_RULE_CONDITIONS = [
  "From",
  "FromMemberOf",
  "FromScope",
  "SentTo",
  "SentToMemberOf",
  "SentToScope",
  "SubjectContainsWords",
  "SubjectOrBodyContainsWords",
  "HeaderContainsMessageHeader",
  "HasAttachment",
  "MessageSizeOver",
  "AttachmentExtensionMatchesWords",
  "RecipientDomainIs",
] as const;

export const TRANSPORT_RULE_ACTIONS = [
  "AddToRecipients",
  "BlindCopyTo",
  "CopyTo",
  "ModerateMessageByUser",
  "RedirectMessageTo",
  "RejectMessageReasonText",
  "DeleteMessage",
  "Quarantine",
  "PrependSubject",
  "SetHeaderName",
  "ApplyHtmlDisclaimerText",
  "ApplyHtmlDisclaimerFallbackAction",
  "RouteMessageOutboundConnector",
] as const;

export const TRANSPORT_RULE_EXCEPTIONS = [
  "ExceptIfFrom",
  "ExceptIfFromMemberOf",
  "ExceptIfFromScope",
  "ExceptIfSentTo",
  "ExceptIfSentToMemberOf",
  "ExceptIfSubjectContainsWords",
  "ExceptIfSubjectOrBodyContainsWords",
  "ExceptIfHasAttachment",
  "ExceptIfRecipientDomainIs",
] as const;

export type TransportRuleConditionName = (typeof TRANSPORT_RULE_CONDITIONS)[number];
export type TransportRuleActionName = (typeof TRANSPORT_RULE_ACTIONS)[number];
export type TransportRuleExceptionName = (typeof TRANSPORT_RULE_EXCEPTIONS)[number];

export type TransportRuleFieldName =
  | TransportRuleConditionName
  | TransportRuleActionName
  | TransportRuleExceptionName;

export type TransportRuleFieldValue = string | readonly string[] | boolean | number;

export type TransportRuleFieldInput = Partial<Record<TransportRuleFieldName, TransportRuleFieldValue>>;

export const TRANSPORT_RULE_UNSUPPORTED_CONDITION = "transport_rule.unsupported_condition";
export const TRANSPORT_RULE_UNSUPPORTED_ACTION = "transport_rule.unsupported_action";
export const TRANSPORT_RULE_UNSUPPORTED_EXCEPTION = "transport_rule.unsupported_exception";

export interface TransportRuleFields {
  readonly priority?: number;
  readonly conditions?: TransportRuleFieldInput;
  readonly actions?: TransportRuleFieldInput;
  readonly exceptions?: TransportRuleFieldInput;
}

export interface TransportRuleDefinition extends TransportRuleFields {
  readonly name: string;
  readonly enabled?: boolean;
}

export interface TransportRuleJson {
  readonly name: string;
  readonly enabled: boolean;
  readonly priority: number;
  readonly parameters: Readonly<Record<string, TransportRuleFieldValue>>;
}

const CONDITION_SET: ReadonlySet<string> = new Set(TRANSPORT_RULE_CONDITIONS);
const ACTION_SET: ReadonlySet<string> = new Set(TRANSPORT_RULE_ACTIONS);
const EXCEPTION_SET: ReadonlySet<string> = new Set(TRANSPORT_RULE_EXCEPTIONS);

function rejectUnsupportedField(
  fields: TransportRuleFieldInput | undefined,
  allowed: ReadonlySet<string>,
  code: string,
  label: string,
): void {
  if (fields === undefined) {
    return;
  }
  for (const key of Object.keys(fields)) {
    if (!allowed.has(key)) {
      throw new AppError(code, `unsupported ${label} '${key}'`, 400, [
        { field: key, reason: "unsupported" },
      ]);
    }
  }
}

function isEmptyValue(value: TransportRuleFieldValue): boolean {
  if (typeof value === "string") {
    return value.trim().length === 0;
  }
  if (Array.isArray(value)) {
    return value.length === 0;
  }
  return false;
}

export function validateTransportRuleFields(fields: TransportRuleFields): void {
  rejectUnsupportedField(
    fields.conditions,
    CONDITION_SET,
    TRANSPORT_RULE_UNSUPPORTED_CONDITION,
    "condition",
  );
  rejectUnsupportedField(fields.actions, ACTION_SET, TRANSPORT_RULE_UNSUPPORTED_ACTION, "action");
  rejectUnsupportedField(
    fields.exceptions,
    EXCEPTION_SET,
    TRANSPORT_RULE_UNSUPPORTED_EXCEPTION,
    "exception",
  );

  const groups: ReadonlyArray<readonly [string, TransportRuleFieldInput | undefined]> = [
    ["conditions", fields.conditions],
    ["actions", fields.actions],
    ["exceptions", fields.exceptions],
  ];
  for (const [group, groupFields] of groups) {
    if (groupFields === undefined) {
      continue;
    }
    for (const [key, value] of Object.entries(groupFields)) {
      if (isEmptyValue(value)) {
        throw new AppError(
          ErrorCodes.validationFailed,
          `${group} field '${key}' must carry a value`,
          400,
          [{ field: key, reason: "empty" }],
        );
      }
    }
  }

  if (fields.priority !== undefined && (!Number.isInteger(fields.priority) || fields.priority < 0)) {
    throw new AppError(ErrorCodes.validationFailed, "priority must be a non-negative integer", 400, [
      { field: "priority", reason: "invalid" },
    ]);
  }
}

export function buildTransportRuleJson(definition: TransportRuleDefinition): TransportRuleJson {
  if (definition.name.trim().length === 0) {
    throw new AppError(ErrorCodes.validationFailed, "name is required", 400, [
      { field: "name", reason: "required" },
    ]);
  }
  validateTransportRuleFields(definition);
  const parameters: Record<string, TransportRuleFieldValue> = {};
  for (const group of [definition.conditions, definition.actions, definition.exceptions]) {
    if (group === undefined) {
      continue;
    }
    for (const [key, value] of Object.entries(group)) {
      parameters[key] = value;
    }
  }
  return {
    name: definition.name,
    enabled: definition.enabled ?? true,
    priority: definition.priority ?? 0,
    parameters,
  };
}
