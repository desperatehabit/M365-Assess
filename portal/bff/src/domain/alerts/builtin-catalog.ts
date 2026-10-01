// Curated v1 built-in alert catalog (EPIC-029 SPEC.md §2 US-1, §3.1, §11.1; T-0562).
//
// §11.1 resolved to ship a curated subset of the CIPP ~70 built-ins for v1 and add
// the rest later. This module is that subset: each entry carries the §3.1 columns
// (name, source, severity, scope, channels) plus the mutable state (enabled, last
// fired) that the operator toggles. `seedBuiltinRules()` projects the catalog into
// AlertRule rows a seeder can persist; the operator then enables the ones they want.
//
// `@m365-assess/contracts/alerting` owns the canonical AlertRule vocabulary, but the
// bff tsconfig rootDir cannot reach the contracts source, so the fields used here are
// declared locally, mirroring that contract exactly (the same convention as
// domain/auth-methods/phishing-resistant.ts).

export const ALERT_CHANNELS = ["email", "webhook", "psa", "slack"] as const;

export type AlertChannel = (typeof ALERT_CHANNELS)[number];

export const ALERT_SEVERITIES = ["Critical", "High", "Medium", "Low", "Info"] as const;

export type AlertSeverity = (typeof ALERT_SEVERITIES)[number];

// §3.1 scopes a rule to a tenant or a group.
export const ALERT_SCOPES = ["tenant", "group"] as const;

export type AlertScope = (typeof ALERT_SCOPES)[number];

export type AlertRuleState = "Enabled" | "Disabled";

export interface AlertRule {
  readonly id: string;
  readonly name: string;
  readonly source: string;
  readonly severity: AlertSeverity;
  readonly scope: AlertScope;
  readonly channels: readonly AlertChannel[];
  readonly enabled: boolean;
  readonly scriptMode: boolean;
  readonly scheduleId: string | null;
  readonly lastFiredAt: string | null;
  readonly builtIn: boolean;
}

/** An AlertRule plus the derived §3.1 `State` column. */
export interface AlertRuleView extends AlertRule {
  readonly state: AlertRuleState;
}

export interface BuiltinAlertDefinition {
  readonly id: string;
  readonly name: string;
  readonly source: string;
  readonly severity: AlertSeverity;
  readonly scope: AlertScope;
  readonly channels: readonly AlertChannel[];
  readonly description: string;
}

// The curated v1 subset (§11.1). Ids are stable slugs the seeder, the web UI, and
// the toggle route key on; `source` names the log source the evaluator reads
// (T-0564). Defaults are deliberately conservative: the operator opts in.
export const BUILTIN_ALERT_CATALOG: readonly BuiltinAlertDefinition[] = Object.freeze([
  {
    id: "credential-expiry-approaching",
    name: "Credential expiry approaching",
    source: "credentials",
    severity: "High",
    scope: "tenant",
    channels: ["email"],
    description: "A tenant credential is nearing its expiry date.",
  },
  {
    id: "run-failed",
    name: "Assessment run failed",
    source: "runs",
    severity: "High",
    scope: "tenant",
    channels: ["email", "webhook"],
    description: "An assessment run finished in a failed state.",
  },
  {
    id: "run-partial",
    name: "Assessment run partial",
    source: "runs",
    severity: "Medium",
    scope: "tenant",
    channels: ["email"],
    description: "An assessment run completed with skipped or errored sections.",
  },
  {
    id: "new-drift-deviation",
    name: "New drift deviation",
    source: "drift",
    severity: "Medium",
    scope: "tenant",
    channels: ["email", "webhook"],
    description: "A resource drifted from its expected baseline value.",
  },
  {
    id: "standards-regression",
    name: "Standards regression",
    source: "standards",
    severity: "High",
    scope: "tenant",
    channels: ["email"],
    description: "A standard's compliance score regressed against the prior run.",
  },
  {
    id: "connector-transport-change",
    name: "Connector or transport rule change",
    source: "transport",
    severity: "Medium",
    scope: "tenant",
    channels: ["email", "webhook"],
    description: "A connector or transport rule was created, modified, or removed.",
  },
  {
    id: "conditional-access-policy-change",
    name: "Conditional Access policy change",
    source: "conditional-access",
    severity: "High",
    scope: "tenant",
    channels: ["email", "webhook"],
    description: "A Conditional Access policy was created, modified, or removed.",
  },
  {
    id: "privileged-role-assignment",
    name: "New privileged role assignment",
    source: "roles",
    severity: "High",
    scope: "tenant",
    channels: ["email", "webhook"],
    description: "A principal was granted a privileged directory role.",
  },
  {
    id: "mailbox-forwarding-enabled",
    name: "Mailbox forwarding enabled",
    source: "mailboxes",
    severity: "High",
    scope: "tenant",
    channels: ["email"],
    description: "A mailbox gained external or hidden forwarding.",
  },
  {
    id: "secure-score-drop",
    name: "Secure score drop",
    source: "secure-score",
    severity: "Medium",
    scope: "tenant",
    channels: ["email"],
    description: "The tenant secure score dropped beyond the configured threshold.",
  },
  {
    id: "delivery-channel-failure",
    name: "Delivery channel failure",
    source: "alerts",
    severity: "High",
    scope: "tenant",
    channels: ["email"],
    description: "An alert delivery channel failed after retries (meta-alert).",
  },
  {
    id: "incident-spike",
    name: "Incident spike",
    source: "incidents",
    severity: "Medium",
    scope: "tenant",
    channels: ["email", "webhook"],
    description: "Open incidents rose sharply against the trailing baseline.",
  },
]);

const BUILTIN_BY_ID: ReadonlyMap<string, BuiltinAlertDefinition> = new Map(
  BUILTIN_ALERT_CATALOG.map((entry) => [entry.id, entry]),
);

export const BUILTIN_ALERT_IDS: readonly string[] = Object.freeze(
  BUILTIN_ALERT_CATALOG.map((entry) => entry.id),
);

export function isBuiltinAlertId(id: string): boolean {
  return BUILTIN_BY_ID.has(id);
}

export function getBuiltinAlert(id: string): BuiltinAlertDefinition | undefined {
  return BUILTIN_BY_ID.get(id);
}

export function isAlertChannel(value: unknown): value is AlertChannel {
  return typeof value === "string" && (ALERT_CHANNELS as readonly string[]).includes(value);
}

export function isAlertSeverity(value: unknown): value is AlertSeverity {
  return typeof value === "string" && (ALERT_SEVERITIES as readonly string[]).includes(value);
}

export function isAlertScope(value: unknown): value is AlertScope {
  return typeof value === "string" && (ALERT_SCOPES as readonly string[]).includes(value);
}

export function alertRuleState(rule: Pick<AlertRule, "enabled">): AlertRuleState {
  return rule.enabled ? "Enabled" : "Disabled";
}

export function toAlertRuleView(rule: AlertRule): AlertRuleView {
  return { ...rule, state: alertRuleState(rule) };
}

// Projects the catalog into AlertRule rows. Built-ins start disabled unless the
// seeder opts in, so a fresh install raises nothing until the operator enables it.
export function seedBuiltinRules(enabled = false): AlertRule[] {
  return BUILTIN_ALERT_CATALOG.map((entry) => ({
    id: entry.id,
    name: entry.name,
    source: entry.source,
    severity: entry.severity,
    scope: entry.scope,
    channels: [...entry.channels],
    enabled,
    scriptMode: false,
    scheduleId: null,
    lastFiredAt: null,
    builtIn: true,
  }));
}
