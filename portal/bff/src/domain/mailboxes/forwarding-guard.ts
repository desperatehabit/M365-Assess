// Mailbox forwarding guard (EPIC-020 SPEC.md §3.4, §8, §9; T-0385).
// Classifies an inbox-rule or mailbox-forwarding change as security-sensitive
// (BEC vector): a forwarding-enabling change forces the warning path — the
// plan carries the warning with requiresConfirmation, and apply requires
// explicit confirmation. Every write is still audited with before/after via
// the EPIC-006 gated executor (T-0107).
export const FORWARDING_SENSITIVE_CODE = "mailbox.forwarding_sensitive";

export const FORWARDING_SENSITIVE_WARNING =
  "Forwarding change is security-sensitive (BEC vector): review the forwarding target " +
  "before applying. This change is audited with before/after.";

export interface RuleForwardingState {
  readonly forwardTo?: unknown;
  readonly forwardAsAttachmentTo?: unknown;
  readonly redirectTo?: unknown;
  readonly deleteMessage?: boolean;
  readonly enabled?: boolean;
}

export interface MailboxForwardingState {
  readonly forwardingTo?: string | null;
  readonly deliverToMailboxAndForward?: boolean;
}

export interface ForwardingAssessment {
  readonly securitySensitive: boolean;
  readonly requiresConfirmation: boolean;
  readonly warning?: string;
  readonly reasons: readonly string[];
}

function hasTarget(value: unknown): boolean {
  if (value === null || value === undefined) {
    return false;
  }
  if (typeof value === "string") {
    return value.trim().length > 0;
  }
  if (Array.isArray(value)) {
    return value.length > 0;
  }
  return true;
}

export function ruleForwardsMail(rule: RuleForwardingState | null | undefined): boolean {
  if (!rule) {
    return false;
  }
  return (
    hasTarget(rule.forwardTo) ||
    hasTarget(rule.forwardAsAttachmentTo) ||
    hasTarget(rule.redirectTo)
  );
}

export function ruleDeletesMail(rule: RuleForwardingState | null | undefined): boolean {
  return rule?.deleteMessage === true;
}

function sensitive(reason: string): ForwardingAssessment {
  return {
    securitySensitive: true,
    requiresConfirmation: true,
    warning: FORWARDING_SENSITIVE_WARNING,
    reasons: [reason],
  };
}

function notSensitive(): ForwardingAssessment {
  return { securitySensitive: false, requiresConfirmation: false, reasons: [] };
}

export interface RuleChangeInput {
  readonly action: "create" | "edit" | "delete";
  readonly before?: RuleForwardingState | null;
  readonly after?: RuleForwardingState | null;
}

export function assessRuleChange(input: RuleChangeInput): ForwardingAssessment {
  const { action, before, after } = input;
  if (action === "create") {
    if (ruleForwardsMail(after)) {
      return sensitive("new rule forwards mail to an external target");
    }
    if (ruleDeletesMail(after)) {
      return sensitive("new rule deletes matching mail");
    }
    return notSensitive();
  }
  if (action === "delete") {
    if (ruleForwardsMail(before)) {
      return sensitive("removed rule forwarded mail to an external target");
    }
    if (ruleDeletesMail(before)) {
      return sensitive("removed rule deleted matching mail");
    }
    return notSensitive();
  }
  const beforeForwarded = ruleForwardsMail(before);
  const afterForwarded = ruleForwardsMail(after);
  if (!beforeForwarded && afterForwarded) {
    return sensitive("edit enables forwarding on the rule");
  }
  if (afterForwarded && before?.enabled === false && after?.enabled !== false) {
    return sensitive("edit enables a rule that forwards mail");
  }
  if (!ruleDeletesMail(before) && ruleDeletesMail(after)) {
    return sensitive("edit enables deletion of matching mail");
  }
  if (beforeForwarded || afterForwarded) {
    return sensitive("edit touches a rule that forwards mail");
  }
  return notSensitive();
}

export function isForwardingEnablingRuleChange(input: RuleChangeInput): boolean {
  const { action, before, after } = input;
  if (action === "create") {
    return ruleForwardsMail(after) || ruleDeletesMail(after);
  }
  if (action === "delete") {
    return false;
  }
  return (
    (!ruleForwardsMail(before) && ruleForwardsMail(after)) ||
    (!ruleDeletesMail(before) && ruleDeletesMail(after))
  );
}

export function assessMailboxForwardingChange(
  before: MailboxForwardingState | null | undefined,
  after: MailboxForwardingState | null | undefined,
): ForwardingAssessment {
  const beforeTarget = typeof before?.forwardingTo === "string" ? before.forwardingTo.trim() : "";
  const afterTarget = typeof after?.forwardingTo === "string" ? after.forwardingTo.trim() : "";
  if (beforeTarget.length === 0 && afterTarget.length > 0) {
    return sensitive("mailbox forwarding is enabled to a new target");
  }
  if (beforeTarget.length > 0 && afterTarget.length === 0) {
    return sensitive("mailbox forwarding target is removed");
  }
  if (
    beforeTarget.length > 0 &&
    afterTarget.length > 0 &&
    beforeTarget.toLowerCase() !== afterTarget.toLowerCase()
  ) {
    return sensitive("mailbox forwarding target changes");
  }
  return notSensitive();
}
