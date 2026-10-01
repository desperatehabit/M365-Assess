// Alert snooze state machine (EPIC-029 SPEC.md §2 US-3, §3.3, §3.5, §4.4, §5; T-0567).
//
// §3.3: snoozing an alert/rule for a duration moves it to the Snoozed tab and
// auto-returns it. The AlertEvent row carries that state (SPEC §5): `snoozeUntil`
// stamps the return instant and `state` is open/snoozed/resolved. The transitions
// are pure and take `now` so the scheduler can resolve due snoozes on tick
// (SPEC §4.1) with no per-event timer, and tests can drive them deterministically.
//
// `@m365-assess/contracts/alerting` owns the canonical AlertEvent vocabulary, but
// the bff tsconfig rootDir cannot reach the contracts source, so the fields used
// here are declared locally, mirroring that contract exactly (the same
// convention as domain/alerts/builtin-catalog.ts).

export const ALERT_EVENT_STATES = ["open", "snoozed", "resolved"] as const;

export type AlertEventState = (typeof ALERT_EVENT_STATES)[number];

export const ALERT_EVENT_SEVERITIES = ["Critical", "High", "Medium", "Low", "Info"] as const;

export type AlertEventSeverity = (typeof ALERT_EVENT_SEVERITIES)[number];

export interface AlertEvent {
  readonly id: string;
  readonly ruleId: string;
  readonly tenantId: string;
  readonly firedAt: string;
  readonly severity: AlertEventSeverity;
  readonly payload: Record<string, unknown>;
  readonly state: AlertEventState;
  readonly snoozeUntil: string | null;
}

export function isAlertEventState(value: unknown): value is AlertEventState {
  return typeof value === "string" && (ALERT_EVENT_STATES as readonly string[]).includes(value);
}

export function isAlertEventSeverity(value: unknown): value is AlertEventSeverity {
  return (
    typeof value === "string" && (ALERT_EVENT_SEVERITIES as readonly string[]).includes(value)
  );
}

/** A snoozed event whose `snoozeUntil` has elapsed is due to auto-return (§3.3). */
export function isSnoozeDue(event: AlertEvent, now: Date): boolean {
  if (event.state !== "snoozed" || event.snoozeUntil === null) {
    return false;
  }
  const until = Date.parse(event.snoozeUntil);
  return !Number.isNaN(until) && until <= now.getTime();
}

/** Moves an event to snoozed with the given return instant. */
export function snoozeEvent(event: AlertEvent, snoozeUntil: string): AlertEvent {
  return { ...event, state: "snoozed", snoozeUntil };
}

/** Auto-returns a snoozed event to open once its snooze has elapsed; otherwise unchanged. */
export function resolveSnooze(event: AlertEvent, now: Date): AlertEvent {
  if (!isSnoozeDue(event, now)) {
    return event;
  }
  return { ...event, state: "open", snoozeUntil: null };
}

/** Maps resolveSnooze over a batch — the scheduler tick entry point for auto-return. */
export function resolveSnoozedEvents(events: readonly AlertEvent[], now: Date): AlertEvent[] {
  return events.map((event) => resolveSnooze(event, now));
}
