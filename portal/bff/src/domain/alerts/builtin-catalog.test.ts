// T-0562 — curated v1 built-in alert catalog.
import { describe, expect, it } from "vitest";
import {
  ALERT_CHANNELS,
  ALERT_SCOPES,
  ALERT_SEVERITIES,
  BUILTIN_ALERT_CATALOG,
  BUILTIN_ALERT_IDS,
  alertRuleState,
  getBuiltinAlert,
  isAlertChannel,
  isAlertScope,
  isAlertSeverity,
  isBuiltinAlertId,
  seedBuiltinRules,
  toAlertRuleView,
} from "./builtin-catalog.js";

const EXPECTED_IDS = [
  "credential-expiry-approaching",
  "run-failed",
  "run-partial",
  "new-drift-deviation",
  "standards-regression",
  "connector-transport-change",
  "conditional-access-policy-change",
  "privileged-role-assignment",
  "mailbox-forwarding-enabled",
  "secure-score-drop",
  "delivery-channel-failure",
  "incident-spike",
] as const;

describe("curated v1 built-in catalog (T-0562)", () => {
  it("enumerates exactly the §11.1 curated subset", () => {
    expect(BUILTIN_ALERT_IDS).toEqual(EXPECTED_IDS);
    expect(BUILTIN_ALERT_CATALOG).toHaveLength(EXPECTED_IDS.length);
  });

  it("gives every entry a source, default severity, scope, and channels", () => {
    for (const entry of BUILTIN_ALERT_CATALOG) {
      expect(entry.name.trim().length).toBeGreaterThan(0);
      expect(entry.source.trim().length).toBeGreaterThan(0);
      expect(entry.description.trim().length).toBeGreaterThan(0);
      expect(isAlertSeverity(entry.severity)).toBe(true);
      expect(isAlertScope(entry.scope)).toBe(true);
      expect(entry.channels.length).toBeGreaterThan(0);
      for (const channel of entry.channels) {
        expect(isAlertChannel(channel)).toBe(true);
      }
    }
  });

  it("keeps ids unique and resolvable", () => {
    expect(new Set(BUILTIN_ALERT_IDS).size).toBe(BUILTIN_ALERT_IDS.length);
    for (const id of BUILTIN_ALERT_IDS) {
      expect(isBuiltinAlertId(id)).toBe(true);
      expect(getBuiltinAlert(id)?.id).toBe(id);
    }
    expect(isBuiltinAlertId("not-a-builtin")).toBe(false);
    expect(getBuiltinAlert("not-a-builtin")).toBeUndefined();
  });

  it("seeds built-ins as disabled rules the operator can enable", () => {
    const rules = seedBuiltinRules();
    expect(rules).toHaveLength(EXPECTED_IDS.length);
    for (const rule of rules) {
      expect(rule.builtIn).toBe(true);
      expect(rule.enabled).toBe(false);
      expect(rule.scriptMode).toBe(false);
      expect(rule.scheduleId).toBeNull();
      expect(rule.lastFiredAt).toBeNull();
      expect(rule.channels.length).toBeGreaterThan(0);
    }
    expect(seedBuiltinRules(true).every((rule) => rule.enabled)).toBe(true);
  });

  it("derives the §3.1 State column and marks built-in rows", () => {
    const [builtin] = seedBuiltinRules();
    expect(builtin).toBeDefined();
    const view = toAlertRuleView({ ...builtin!, enabled: true });
    expect(view.state).toBe("Enabled");
    expect(alertRuleState({ enabled: false })).toBe("Disabled");
    expect(view.builtIn).toBe(true);
  });

  it("exposes the contract vocabularies", () => {
    expect([...ALERT_CHANNELS]).toEqual(["email", "webhook", "psa", "slack"]);
    expect([...ALERT_SEVERITIES]).toEqual(["Critical", "High", "Medium", "Low", "Info"]);
    expect([...ALERT_SCOPES]).toEqual(["tenant", "group"]);
  });
});
