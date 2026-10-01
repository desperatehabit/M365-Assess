// Bulk quarantine release/delete domain logic (EPIC-022 SPEC.md §3.3, §4.2,
// §8, §9; resolved §11.2; T-0425).
//
// The resolved §11.2 decision is a capped bulk action with explicit
// confirmation. This module owns the per-action cap, the all-or-nothing
// selection validation (a batch over the cap is rejected, never silently
// truncated), and the confirmation count model the route renders before any
// release or delete. It is pure: no tenant write, no EXO/Graph call, no audit.
// The route enqueues through the EPIC-006 gated path and the PowerShell worker
// applies each item, reporting per-message failures without aborting the rest.

export const QUARANTINE_BULK_ACTIONS = ["release", "releaseAll", "delete"] as const;
export type QuarantineBulkAction = (typeof QUARANTINE_BULK_ACTIONS)[number];

/** Default per-action cap; the route may configure a different positive value. */
export const DEFAULT_QUARANTINE_BULK_CAP = 100;

export const QUARANTINE_BULK_INVALID = "quarantine.bulk_invalid";
export const QUARANTINE_BULK_EMPTY_SELECTION = "quarantine.bulk_empty_selection";
export const QUARANTINE_BULK_CAP_EXCEEDED = "quarantine.bulk_cap_exceeded";
export const QUARANTINE_BULK_CONFIRM_REQUIRED = "quarantine.bulk_confirm_required";

export const QUARANTINE_BULK_WARNING =
  "Bulk quarantine release/delete is security-impacting: it can deliver malicious " +
  "content or destroy quarantined evidence. Each item is audited with actor, message, " +
  "and recipient; a failure on one message does not stop the rest.";

export class QuarantineBulkInputError extends Error {
  readonly code: string;
  readonly field: string;

  constructor(code: string, field: string, message: string) {
    super(message);
    this.name = "QuarantineBulkInputError";
    this.code = code;
    this.field = field;
  }
}

export interface QuarantineBulkConfirmation {
  readonly action: QuarantineBulkAction;
  readonly count: number;
  readonly cap: number;
  /** How many more messages the selection could have carried under the cap. */
  readonly remaining: number;
  readonly requiresConfirmation: boolean;
  readonly confirmed: boolean;
  readonly warning: string;
}

export interface QuarantineBulkSelection {
  readonly action: QuarantineBulkAction;
  readonly messageIds: readonly string[];
  readonly count: number;
  readonly cap: number;
}

export function resolveQuarantineBulkCap(configured?: number): number {
  if (configured === undefined) {
    return DEFAULT_QUARANTINE_BULK_CAP;
  }
  if (!Number.isInteger(configured) || configured < 1) {
    throw new QuarantineBulkInputError(
      QUARANTINE_BULK_INVALID,
      "cap",
      "Bulk cap must be a positive integer",
    );
  }
  return configured;
}

export function parseQuarantineBulkAction(value: unknown): QuarantineBulkAction {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new QuarantineBulkInputError(
      QUARANTINE_BULK_INVALID,
      "action",
      "Field 'action' is required",
    );
  }
  const normalized = value.trim().toLowerCase().replace(/[-_]/g, "");
  switch (normalized) {
    case "release":
      return "release";
    case "releaseall":
    case "releasetoall":
      return "releaseAll";
    case "delete":
      return "delete";
    default:
      throw new QuarantineBulkInputError(
        QUARANTINE_BULK_INVALID,
        "action",
        `action must be one of: ${QUARANTINE_BULK_ACTIONS.join(", ")}`,
      );
  }
}

/**
 * Validates a bulk selection against the cap. An empty, malformed, or
 * duplicate-bearing selection is rejected, and a selection larger than the cap
 * is rejected outright — never truncated — so the caller knows the whole batch
 * was refused and can narrow it.
 */
export function validateQuarantineBulkSelection(
  action: QuarantineBulkAction,
  messageIds: unknown,
  configuredCap?: number,
): QuarantineBulkSelection {
  const cap = resolveQuarantineBulkCap(configuredCap);
  if (
    !Array.isArray(messageIds) ||
    messageIds.some((id) => typeof id !== "string" || id.trim().length === 0)
  ) {
    throw new QuarantineBulkInputError(
      QUARANTINE_BULK_INVALID,
      "messageIds",
      "Field 'messageIds' must be an array of non-empty strings",
    );
  }
  const normalized = messageIds.map((id) => (id as string).trim());
  if (normalized.length === 0) {
    throw new QuarantineBulkInputError(
      QUARANTINE_BULK_EMPTY_SELECTION,
      "messageIds",
      "Bulk selection is empty; nothing to release or delete",
    );
  }
  const unique = [...new Set(normalized)];
  if (unique.length !== normalized.length) {
    throw new QuarantineBulkInputError(
      QUARANTINE_BULK_INVALID,
      "messageIds",
      "Bulk selection contains duplicate message ids",
    );
  }
  if (unique.length > cap) {
    throw new QuarantineBulkInputError(
      QUARANTINE_BULK_CAP_EXCEEDED,
      "messageIds",
      `Bulk selection of ${unique.length} exceeds the configured cap of ${cap}; ` +
        "nothing was released or deleted — narrow the selection",
    );
  }
  return { action, messageIds: unique, count: unique.length, cap };
}

/** The count model shown before apply; `confirmed` stays false until confirm. */
export function buildQuarantineBulkConfirmation(
  selection: QuarantineBulkSelection,
): QuarantineBulkConfirmation {
  return {
    action: selection.action,
    count: selection.count,
    cap: selection.cap,
    remaining: selection.cap - selection.count,
    requiresConfirmation: true,
    confirmed: false,
    warning: QUARANTINE_BULK_WARNING,
  };
}

/**
 * Enforces explicit confirmation for the whole batch. The thrown error carries
 * the count so a caller that skips the preview still sees how many messages the
 * action would affect.
 */
export function requireQuarantineBulkConfirmation(
  selection: QuarantineBulkSelection,
  confirm: unknown,
): QuarantineBulkConfirmation {
  const confirmation = buildQuarantineBulkConfirmation(selection);
  if (confirm !== true) {
    throw new QuarantineBulkInputError(
      QUARANTINE_BULK_CONFIRM_REQUIRED,
      "confirm",
      `Bulk ${selection.action} of ${selection.count} message(s) requires confirm: true`,
    );
  }
  return { ...confirmation, confirmed: true };
}
