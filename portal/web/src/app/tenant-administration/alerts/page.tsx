"use client";

// Alert Configuration page (EPIC-029 SPEC.md §2 US-1/US-2/US-3, §3.1, §3.3;
// T-0562 rule API, T-0564 dry-run, T-0567 events/snooze API).
//
// Tabs Alert Configuration / Snoozed Alerts. The config tab renders the §3.1
// columns (Name · Source · Severity · Scope · Channels · State · Last fired) and
// the §3.1 row actions (View task details, Edit, Clone & edit, Enable/Disable,
// Delete, Test) plus the primary Add alert button. Enable/disable, clone, and
// delete call the T-0562 rule API and refresh the row; Test calls the T-0564
// dry-run endpoint and renders the match result without delivering; the Snoozed
// tab lists T-0567 snoozed events with their return time. No new server logic;
// report theme tokens only.

import React, { useCallback, useEffect, useState, type CSSProperties, type ReactElement } from "react";

export type Fetcher = typeof fetch;

export const ALERT_SEVERITIES = ["Critical", "High", "Medium", "Low", "Info"] as const;

export type AlertSeverity = (typeof ALERT_SEVERITIES)[number];

export const ALERT_SCOPES = ["tenant", "group"] as const;

export type AlertScope = (typeof ALERT_SCOPES)[number];

export type AlertRuleState = "Enabled" | "Disabled";

// The T-0562 GET /v1/alert-rules view: the §3.1 columns plus the mutable state
// (enabled / lastFiredAt) the operator toggles. Declared locally because the
// web package cannot import the bff's rootDir-local domain types.
export interface AlertRuleView {
  readonly id: string;
  readonly name: string;
  readonly source: string;
  readonly severity: AlertSeverity | string;
  readonly scope: AlertScope | string;
  readonly channels: readonly string[];
  readonly enabled: boolean;
  readonly state: AlertRuleState | string;
  readonly scriptMode: boolean;
  readonly lastFiredAt: string | null;
  readonly builtIn: boolean;
}

// The T-0567 GET /v1/alert-events row; the Snoozed tab reads state=snoozed and
// renders `snoozeUntil` as the return time (§3.3).
export interface AlertEventRow {
  readonly id: string;
  readonly ruleId: string;
  readonly tenantId: string;
  readonly firedAt: string;
  readonly severity: string;
  readonly state: string;
  readonly snoozeUntil: string | null;
}

// The T-0564 POST /v1/alert-rules/{id}/test dry-run result. It reports whether
// the rule would fire and never delivers (SPEC §4.2, §6).
export interface AlertRuleTestResult {
  readonly matched: boolean;
  readonly matchCount?: number;
  readonly evaluated?: number;
  readonly message?: string;
}

async function throwApiError(response: Response, fallback: string): Promise<never> {
  const body = (await response.json().catch(() => ({}))) as { message?: string };
  throw new Error(body.message || `${fallback}: HTTP ${response.status}`);
}

/** T-0562 rule list API. */
export async function listAlertRules(fetcher: Fetcher = fetch): Promise<readonly AlertRuleView[]> {
  const response = await fetcher("/v1/alert-rules");
  if (!response.ok) await throwApiError(response, "Failed to list alert rules");
  const body = (await response.json()) as { rules?: readonly AlertRuleView[] };
  return body.rules ?? [];
}

/** T-0562 enable/disable API; returns the refreshed rule. */
export async function toggleAlertRule(
  ruleId: string,
  enabled: boolean,
  fetcher: Fetcher = fetch,
): Promise<AlertRuleView> {
  const response = await fetcher(`/v1/alert-rules/${encodeURIComponent(ruleId)}/toggle`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ enabled }),
  });
  if (!response.ok) await throwApiError(response, "Failed to toggle alert rule");
  const body = (await response.json()) as { rule: AlertRuleView };
  return body.rule;
}

/** T-0562 delete API. */
export async function deleteAlertRule(ruleId: string, fetcher: Fetcher = fetch): Promise<void> {
  const response = await fetcher(`/v1/alert-rules/${encodeURIComponent(ruleId)}`, {
    method: "DELETE",
  });
  if (!response.ok) await throwApiError(response, "Failed to delete alert rule");
}

/** T-0562 create API, used for Clone & edit; returns the new rule. */
export async function cloneAlertRule(
  rule: AlertRuleView,
  fetcher: Fetcher = fetch,
): Promise<AlertRuleView> {
  const response = await fetcher("/v1/alert-rules", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      name: `${rule.name} (copy)`,
      source: rule.source,
      severity: rule.severity,
      scope: rule.scope,
      channels: rule.channels,
      scriptMode: rule.scriptMode,
    }),
  });
  if (!response.ok) await throwApiError(response, "Failed to clone alert rule");
  const body = (await response.json()) as { rule: AlertRuleView };
  return body.rule;
}

/** T-0564 dry-run API; evaluates the rule and delivers nothing. */
export async function testAlertRule(
  ruleId: string,
  fetcher: Fetcher = fetch,
): Promise<AlertRuleTestResult> {
  const response = await fetcher(`/v1/alert-rules/${encodeURIComponent(ruleId)}/test`, {
    method: "POST",
  });
  if (!response.ok) await throwApiError(response, "Failed to test alert rule");
  return (await response.json()) as AlertRuleTestResult;
}

/** T-0567 events API, filtered to the snoozed queue (§3.3). */
export async function listSnoozedAlerts(fetcher: Fetcher = fetch): Promise<readonly AlertEventRow[]> {
  const response = await fetcher("/v1/alert-events?state=snoozed");
  if (!response.ok) await throwApiError(response, "Failed to list snoozed alerts");
  const body = (await response.json()) as { items?: readonly AlertEventRow[] };
  return body.items ?? [];
}

// ─── Formatting helpers ──────────────────────────────────────────────────────

export function formatAlertTimestamp(value: string | null): string {
  if (value === null || value.length === 0) {
    return "—";
  }
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    return value;
  }
  return parsed.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}

export function formatChannels(channels: readonly string[]): string {
  return channels.length === 0 ? "—" : channels.join(", ");
}

export function describeTestResult(result: AlertRuleTestResult): string {
  const headline = result.matched ? "Matched" : "No match";
  const counts: string[] = [];
  if (result.matchCount !== undefined) counts.push(`${result.matchCount} matched`);
  if (result.evaluated !== undefined) counts.push(`${result.evaluated} evaluated`);
  const detail = counts.length > 0 ? ` · ${counts.join(" / ")}` : "";
  return result.message ? `${headline}${detail} — ${result.message}` : `${headline}${detail}`;
}

// ─── Styles ──────────────────────────────────────────────────────────────────

const pageStyle: CSSProperties = {
  padding: "24px",
  maxWidth: "1400px",
  margin: "0 auto",
  display: "flex",
  flexDirection: "column",
  gap: "20px",
  fontFamily: "var(--font-sans, system-ui, sans-serif)",
  color: "var(--text)",
};

const buttonStyle: CSSProperties = {
  padding: "6px 12px",
  background: "var(--surface)",
  border: "1px solid var(--border)",
  borderRadius: "6px",
  color: "var(--text)",
  fontSize: "13px",
  fontWeight: 500,
  cursor: "pointer",
  whiteSpace: "nowrap",
};

const primaryButtonStyle: CSSProperties = {
  ...buttonStyle,
  background: "var(--accent)",
  color: "var(--on-accent, var(--text))",
  borderColor: "var(--accent)",
};

const tabStyle: CSSProperties = {
  ...buttonStyle,
  background: "transparent",
  border: "none",
  borderBottom: "2px solid transparent",
  borderRadius: 0,
  padding: "8px 4px",
};

const activeTabStyle: CSSProperties = {
  ...tabStyle,
  borderBottom: "2px solid var(--accent)",
  color: "var(--accent-text, var(--text))",
  fontWeight: 700,
};

const tableStyle: CSSProperties = { width: "100%", borderCollapse: "collapse", fontSize: "14px" };

const thStyle: CSSProperties = {
  textAlign: "left",
  padding: "10px 12px",
  borderBottom: "1px solid var(--border-strong, var(--border))",
  color: "var(--text-soft)",
  fontSize: "12px",
  textTransform: "uppercase",
  letterSpacing: "0.07em",
  whiteSpace: "nowrap",
};

const tdStyle: CSSProperties = {
  padding: "10px 12px",
  borderBottom: "1px solid var(--border)",
  verticalAlign: "top",
};

const badgeBaseStyle: CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  padding: "2px 8px",
  borderRadius: "999px",
  fontSize: "12px",
  fontWeight: 600,
};

export function alertSeverityBadgeStyle(severity: string): CSSProperties {
  switch (severity.trim().toLowerCase()) {
    case "critical":
    case "high":
      return { ...badgeBaseStyle, background: "var(--danger-soft)", color: "var(--danger-text)", border: "1px solid var(--danger)" };
    case "medium":
      return { ...badgeBaseStyle, background: "var(--warning-soft)", color: "var(--warning-text)", border: "1px solid var(--warning)" };
    default:
      return { ...badgeBaseStyle, background: "var(--surface)", color: "var(--text-soft)", border: "1px solid var(--border)" };
  }
}

function alertStateBadgeStyle(enabled: boolean): CSSProperties {
  return enabled
    ? { ...badgeBaseStyle, background: "var(--success-soft)", color: "var(--success-text)", border: "1px solid var(--success)" }
    : { ...badgeBaseStyle, background: "var(--surface)", color: "var(--text-soft)", border: "1px solid var(--border)" };
}

const drawerStyle: CSSProperties = {
  position: "fixed",
  top: 0,
  right: 0,
  bottom: 0,
  width: "min(520px, 92vw)",
  background: "var(--bg-elev)",
  borderLeft: "1px solid var(--border)",
  boxShadow: "var(--shadow)",
  zIndex: 70,
  overflowY: "auto",
  padding: "24px",
  display: "flex",
  flexDirection: "column",
  gap: "16px",
};

// ─── Component ───────────────────────────────────────────────────────────────

export type AlertConfigurationTab = "config" | "snoozed";

export interface AlertConfigurationViewProps {
  readonly fetcher?: Fetcher;
}

export function AlertConfigurationView({ fetcher = fetch }: AlertConfigurationViewProps): ReactElement {
  const [tab, setTab] = useState<AlertConfigurationTab>("config");
  const [rules, setRules] = useState<readonly AlertRuleView[]>([]);
  const [snoozed, setSnoozed] = useState<readonly AlertEventRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [testResults, setTestResults] = useState<Record<string, AlertRuleTestResult>>({});
  const [selected, setSelected] = useState<AlertRuleView | null>(null);

  const loadRules = useCallback(async (): Promise<void> => {
    setLoading(true);
    setError(null);
    try {
      setRules(await listAlertRules(fetcher));
    } catch (err) {
      setRules([]);
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [fetcher]);

  const loadSnoozed = useCallback(async (): Promise<void> => {
    try {
      setSnoozed(await listSnoozedAlerts(fetcher));
    } catch (err) {
      setSnoozed([]);
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [fetcher]);

  useEffect(() => {
    void loadRules();
  }, [loadRules]);

  useEffect(() => {
    void loadSnoozed();
  }, [loadSnoozed]);

  const handleToggle = useCallback(
    async (rule: AlertRuleView): Promise<void> => {
      try {
        const updated = await toggleAlertRule(rule.id, !rule.enabled, fetcher);
        setRules((current) => current.map((entry) => (entry.id === updated.id ? updated : entry)));
        setNotice(`${updated.name} ${updated.enabled ? "enabled" : "disabled"}.`);
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      }
    },
    [fetcher],
  );

  const handleDelete = useCallback(
    async (rule: AlertRuleView): Promise<void> => {
      try {
        await deleteAlertRule(rule.id, fetcher);
        setRules((current) => current.filter((entry) => entry.id !== rule.id));
        setNotice(`Deleted ${rule.name}.`);
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      }
    },
    [fetcher],
  );

  const handleClone = useCallback(
    async (rule: AlertRuleView): Promise<void> => {
      try {
        const cloned = await cloneAlertRule(rule, fetcher);
        setRules((current) => [...current, cloned]);
        setNotice(`Cloned ${rule.name}.`);
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      }
    },
    [fetcher],
  );

  const handleTest = useCallback(
    async (rule: AlertRuleView): Promise<void> => {
      try {
        const result = await testAlertRule(rule.id, fetcher);
        setTestResults((current) => ({ ...current, [rule.id]: result }));
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      }
    },
    [fetcher],
  );

  return (
    <div style={pageStyle} data-testid="alert-configuration-page">
      <div>
        <div style={{ fontSize: "12px", color: "var(--text-soft)" }}>
          Tenant Administration &gt; Alert Configuration
        </div>
        <h1 style={{ fontSize: "24px", fontWeight: 700, margin: "4px 0 0", fontFamily: "var(--font-display, var(--font-sans))" }}>
          Alert Configuration
        </h1>
        <p style={{ margin: "4px 0 0", color: "var(--text-soft)", fontSize: "14px" }}>
          Enable, test, and tune built-in and custom alert rules; snoozed alerts auto-return.
        </p>
      </div>

      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", borderBottom: "1px solid var(--border)", flexWrap: "wrap", gap: "12px" }}>
        <div role="tablist" aria-label="Alert views" style={{ display: "flex", gap: "16px" }}>
          <button
            type="button"
            role="tab"
            aria-selected={tab === "config"}
            style={tab === "config" ? activeTabStyle : tabStyle}
            onClick={() => setTab("config")}
            data-testid="alert-tab-config"
          >
            Alert Configuration
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={tab === "snoozed"}
            style={tab === "snoozed" ? activeTabStyle : tabStyle}
            onClick={() => setTab("snoozed")}
            data-testid="alert-tab-snoozed"
          >
            Snoozed Alerts
          </button>
        </div>
        {tab === "config" && (
          <button
            type="button"
            style={primaryButtonStyle}
            onClick={() => setNotice("Opening the alert builder…")}
            data-testid="alert-add"
          >
            Add alert
          </button>
        )}
      </div>

      {notice && (
        <div style={{ padding: "12px 16px", borderRadius: "6px", background: "var(--success-soft)", border: "1px solid var(--success)", color: "var(--success-text)", fontSize: "14px" }} data-testid="alert-configuration-notice">
          {notice}
        </div>
      )}
      {error && (
        <div role="alert" style={{ padding: "12px 16px", borderRadius: "6px", background: "var(--danger-soft)", border: "1px solid var(--danger)", color: "var(--danger-text)", fontSize: "14px" }} data-testid="alert-configuration-error">
          {error}
        </div>
      )}

      {tab === "config" ? (
        <div style={{ overflowX: "auto" }}>
          <table style={tableStyle} data-testid="alert-config-table">
            <thead>
              <tr>
                <th style={thStyle}>Name</th>
                <th style={thStyle}>Source</th>
                <th style={thStyle}>Severity</th>
                <th style={thStyle}>Scope</th>
                <th style={thStyle}>Channels</th>
                <th style={thStyle}>State</th>
                <th style={thStyle}>Last fired</th>
                <th style={thStyle}>Actions</th>
              </tr>
            </thead>
            <tbody>
              {loading ? (
                <tr>
                  <td style={tdStyle} colSpan={8}>Loading alert rules…</td>
                </tr>
              ) : rules.length === 0 ? (
                <tr>
                  <td style={tdStyle} colSpan={8} data-testid="alert-config-empty">No alert rules found.</td>
                </tr>
              ) : (
                rules.map((rule) => {
                  const result = testResults[rule.id];
                  return (
                    <tr key={rule.id} data-testid={`alert-rule-row-${rule.id}`}>
                      <td style={tdStyle}>{rule.name}</td>
                      <td style={tdStyle}>{rule.source}</td>
                      <td style={tdStyle}>
                        <span className="sev-badge" style={alertSeverityBadgeStyle(rule.severity)} data-testid={`alert-rule-severity-${rule.id}`}>
                          {rule.severity}
                        </span>
                      </td>
                      <td style={tdStyle}>{rule.scope}</td>
                      <td style={tdStyle}>{formatChannels(rule.channels)}</td>
                      <td style={tdStyle}>
                        <span className="status-badge" style={alertStateBadgeStyle(rule.enabled)} data-testid={`alert-rule-state-${rule.id}`}>
                          {rule.enabled ? "Enabled" : "Disabled"}
                        </span>
                      </td>
                      <td style={tdStyle}>{formatAlertTimestamp(rule.lastFiredAt)}</td>
                      <td style={tdStyle}>
                        <div style={{ display: "flex", gap: "6px", flexWrap: "wrap" }}>
                          <button type="button" style={buttonStyle} onClick={() => setSelected(rule)} data-testid={`alert-rule-view-${rule.id}`}>
                            View task details
                          </button>
                          <button type="button" style={buttonStyle} onClick={() => setNotice(`Editing ${rule.name}.`)} data-testid={`alert-rule-edit-${rule.id}`}>
                            Edit
                          </button>
                          <button type="button" style={buttonStyle} onClick={() => void handleClone(rule)} data-testid={`alert-rule-clone-${rule.id}`}>
                            Clone &amp; edit
                          </button>
                          <button type="button" style={buttonStyle} onClick={() => void handleToggle(rule)} data-testid={`alert-rule-toggle-${rule.id}`}>
                            {rule.enabled ? "Disable" : "Enable"}
                          </button>
                          <button type="button" style={buttonStyle} onClick={() => void handleDelete(rule)} data-testid={`alert-rule-delete-${rule.id}`}>
                            Delete
                          </button>
                          <button type="button" style={buttonStyle} onClick={() => void handleTest(rule)} data-testid={`alert-rule-test-${rule.id}`}>
                            Test
                          </button>
                        </div>
                        {result && (
                          <div style={{ marginTop: "6px", fontSize: "12px", color: "var(--text-soft)" }} data-testid={`alert-rule-test-result-${rule.id}`}>
                            <span>{describeTestResult(result)}</span>
                            <span> · Dry run — nothing delivered.</span>
                          </div>
                        )}
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>
      ) : (
        <div style={{ overflowX: "auto" }}>
          <table style={tableStyle} data-testid="alert-snoozed-table">
            <thead>
              <tr>
                <th style={thStyle}>Rule</th>
                <th style={thStyle}>Tenant</th>
                <th style={thStyle}>Severity</th>
                <th style={thStyle}>Fired</th>
                <th style={thStyle}>Snoozed until</th>
              </tr>
            </thead>
            <tbody>
              {snoozed.length === 0 ? (
                <tr>
                  <td style={tdStyle} colSpan={5} data-testid="alert-snoozed-empty">No snoozed alerts.</td>
                </tr>
              ) : (
                snoozed.map((event) => (
                  <tr key={event.id} data-testid={`alert-snoozed-row-${event.id}`}>
                    <td style={tdStyle}>{event.ruleId}</td>
                    <td style={tdStyle}>{event.tenantId}</td>
                    <td style={tdStyle}>{event.severity}</td>
                    <td style={tdStyle}>{formatAlertTimestamp(event.firedAt)}</td>
                    <td style={tdStyle} data-testid={`alert-snoozed-until-${event.id}`}>{formatAlertTimestamp(event.snoozeUntil)}</td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      )}

      {selected && (
        <aside style={drawerStyle} role="dialog" aria-modal="true" aria-label={`Alert rule ${selected.name}`} data-testid="alert-rule-drawer">
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
            <h2 style={{ margin: 0, fontSize: "18px" }}>{selected.name}</h2>
            <button type="button" style={buttonStyle} onClick={() => setSelected(null)} data-testid="alert-rule-drawer-close">
              Close
            </button>
          </div>
          <dl style={{ margin: 0, display: "grid", gridTemplateColumns: "140px 1fr", gap: "8px", fontSize: "14px" }}>
            <dt style={{ color: "var(--text-soft)" }}>Source</dt><dd style={{ margin: 0 }}>{selected.source}</dd>
            <dt style={{ color: "var(--text-soft)" }}>Severity</dt><dd style={{ margin: 0 }}>{selected.severity}</dd>
            <dt style={{ color: "var(--text-soft)" }}>Scope</dt><dd style={{ margin: 0 }}>{selected.scope}</dd>
            <dt style={{ color: "var(--text-soft)" }}>Channels</dt><dd style={{ margin: 0 }}>{formatChannels(selected.channels)}</dd>
            <dt style={{ color: "var(--text-soft)" }}>State</dt><dd style={{ margin: 0 }}>{selected.enabled ? "Enabled" : "Disabled"}</dd>
            <dt style={{ color: "var(--text-soft)" }}>Last fired</dt><dd style={{ margin: 0 }}>{formatAlertTimestamp(selected.lastFiredAt)}</dd>
            <dt style={{ color: "var(--text-soft)" }}>Script mode</dt><dd style={{ margin: 0 }}>{selected.scriptMode ? "Yes" : "No"}</dd>
          </dl>
        </aside>
      )}
    </div>
  );
}

export default function AlertConfigurationPage(): ReactElement {
  return <AlertConfigurationView />;
}
