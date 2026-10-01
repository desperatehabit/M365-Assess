// T-0567 — alert snooze state machine and scheduler-aware auto-return.
import { describe, expect, it } from "vitest";
import {
  ALERT_EVENT_SEVERITIES,
  ALERT_EVENT_STATES,
  isAlertEventSeverity,
  isAlertEventState,
  isSnoozeDue,
  resolveSnooze,
  resolveSnoozedEvents,
  snoozeEvent,
  type AlertEvent,
} from "./snooze.js";

function event(overrides: Partial<AlertEvent> = {}): AlertEvent {
  return {
    id: "evt-1",
    ruleId: "run-failed",
    tenantId: "tenant-1",
    firedAt: "2026-01-01T00:00:00.000Z",
    severity: "High",
    payload: {},
    state: "open",
    snoozeUntil: null,
    ...overrides,
  };
}

const AT = new Date("2026-01-02T02:00:00.000Z");

describe("snooze state machine (T-0567)", () => {
  it("enumerates the §5 event states and severities", () => {
    expect(ALERT_EVENT_STATES).toEqual(["open", "snoozed", "resolved"]);
    expect(ALERT_EVENT_SEVERITIES).toEqual(["Critical", "High", "Medium", "Low", "Info"]);
    expect(isAlertEventState("snoozed")).toBe(true);
    expect(isAlertEventState("muted")).toBe(false);
    expect(isAlertEventSeverity("High")).toBe(true);
    expect(isAlertEventSeverity("high")).toBe(false);
  });

  it("moves an open event to snoozed with the return instant", () => {
    const snoozed = snoozeEvent(event(), "2026-01-02T01:00:00.000Z");
    expect(snoozed.state).toBe("snoozed");
    expect(snoozed.snoozeUntil).toBe("2026-01-02T01:00:00.000Z");
    expect(event().state).toBe("open");
  });

  it("treats a snooze as due only once snoozeUntil has elapsed", () => {
    const snoozed = snoozeEvent(event(), "2026-01-02T01:00:00.000Z");
    expect(isSnoozeDue(snoozed, new Date("2026-01-02T00:59:59.999Z"))).toBe(false);
    expect(isSnoozeDue(snoozed, new Date("2026-01-02T01:00:00.000Z"))).toBe(true);
    expect(isSnoozeDue(snoozed, AT)).toBe(true);
  });

  it("never treats an open or resolved event as due, even with a stale snoozeUntil", () => {
    expect(isSnoozeDue(event({ state: "open", snoozeUntil: "2020-01-01T00:00:00.000Z" }), AT)).toBe(false);
    expect(isSnoozeDue(event({ state: "resolved", snoozeUntil: "2020-01-01T00:00:00.000Z" }), AT)).toBe(false);
    expect(isSnoozeDue(event({ state: "snoozed", snoozeUntil: null }), AT)).toBe(false);
  });

  it("auto-returns a due snoozed event to open and clears snoozeUntil", () => {
    const snoozed = snoozeEvent(event(), "2026-01-02T01:00:00.000Z");
    const returned = resolveSnooze(snoozed, AT);
    expect(returned.state).toBe("open");
    expect(returned.snoozeUntil).toBeNull();
  });

  it("leaves a snoozed event snoozed before its return instant", () => {
    const snoozed = snoozeEvent(event(), "2026-01-02T01:00:00.000Z");
    const before = resolveSnooze(snoozed, new Date("2026-01-02T00:00:00.000Z"));
    expect(before.state).toBe("snoozed");
    expect(before.snoozeUntil).toBe("2026-01-02T01:00:00.000Z");
  });

  it("resolves only the due events in a batch, leaving the rest untouched", () => {
    const due = snoozeEvent(event({ id: "due" }), "2026-01-01T00:00:00.000Z");
    const pending = snoozeEvent(event({ id: "pending" }), "2026-01-03T00:00:00.000Z");
    const open = event({ id: "open" });
    const resolved = event({ id: "resolved", state: "resolved" });
    const resolved2 = resolveSnoozedEvents([due, pending, open, resolved], AT);
    expect(resolved2.map((e) => [e.id, e.state, e.snoozeUntil])).toEqual([
      ["due", "open", null],
      ["pending", "snoozed", "2026-01-03T00:00:00.000Z"],
      ["open", "open", null],
      ["resolved", "resolved", null],
    ]);
  });
});
