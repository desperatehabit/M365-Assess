"use client";

// Check-alerts panel (EPIC-028 SPEC.md §3.4, §4.3, §11 item 3; T-0549).
// Lists the module's own check alerts alongside the tenant alerts served by
// T-0548 so portal-detected issues appear in the same view. Read-only: snooze,
// resolve, and auto-incident creation are deferred to EPIC-029, so a check
// alert offers no action here. Report theme tokens only.

import React, { type CSSProperties, type ReactElement } from "react";
import { alertStatusBadgeStyle, formatAlertEntity, severityBadgeStyle, type AlertRow } from "./AlertsTable";

/** A module check alert as returned by GET /v1/check-alerts (T-0549). */
export interface CheckAlertRow {
  readonly id: string;
  readonly checkId: string;
  readonly title: string;
  readonly category?: string | null;
  readonly severity: string;
  readonly status: string;
  readonly entity?: string | null;
  readonly created: string;
  readonly remediation?: string | null;
}

export interface CheckAlertsPanelProps {
  readonly checkAlerts?: readonly CheckAlertRow[];
  /** Tenant alerts from T-0548, rendered in the same view for context. */
  readonly tenantAlerts?: readonly AlertRow[];
  readonly loading?: boolean;
  readonly error?: string | null;
}

// ─── Styles ───────────────────────────────────────────────────────────────────

const containerStyle: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: "12px",
  width: "100%",
  fontFamily: "var(--font-sans, system-ui, sans-serif)",
  color: "var(--text)",
};

const titleStyle: CSSProperties = {
  fontSize: "18px",
  fontWeight: 700,
  margin: 0,
  fontFamily: "var(--font-display, var(--font-sans))",
};

const tableWrapperStyle: CSSProperties = {
  overflowX: "auto",
  background: "var(--bg-elev)",
  border: "1px solid var(--border)",
  borderRadius: "var(--radius, 10px)",
};

const tableStyle: CSSProperties = {
  width: "100%",
  borderCollapse: "collapse",
  fontSize: "14px",
  textAlign: "left",
};

const thStyle: CSSProperties = {
  padding: "12px 16px",
  borderBottom: "1px solid var(--border)",
  background: "var(--surface)",
  color: "var(--text-soft)",
  fontWeight: 600,
  fontSize: "12px",
  textTransform: "uppercase",
  letterSpacing: "0.05em",
  whiteSpace: "nowrap",
};

const tdStyle: CSSProperties = {
  padding: "12px 16px",
  borderBottom: "1px solid var(--border)",
  color: "var(--text)",
  verticalAlign: "middle",
};

const badgeBaseStyle: CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  padding: "2px 8px",
  borderRadius: "999px",
  fontSize: "12px",
  fontWeight: 600,
  textTransform: "capitalize",
};

const checkBadgeStyle: CSSProperties = {
  ...badgeBaseStyle,
  background: "var(--accent-soft, var(--surface))",
  color: "var(--accent-text, var(--text))",
  border: "1px solid var(--accent, var(--border))",
};

function formatTimestamp(value: string): string {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    return value;
  }
  return parsed.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}

export function CheckAlertsPanel({
  checkAlerts = [],
  tenantAlerts = [],
  loading = false,
  error = null,
}: CheckAlertsPanelProps): ReactElement {
  const total = checkAlerts.length + tenantAlerts.length;

  return (
    <div style={containerStyle} data-testid="check-alerts-panel">
      <div>
        <h2 style={titleStyle}>Check Alerts</h2>
        <p style={{ margin: "4px 0 0", color: "var(--muted)", fontSize: "14px" }}>
          Module check findings shown alongside tenant alerts. Snooze and resolve are managed in
          Alert Configuration.
        </p>
      </div>

      {loading && (
        <div style={{ padding: "32px", textAlign: "center", color: "var(--text-soft)" }} data-testid="check-alerts-loading">
          Loading check alerts...
        </div>
      )}

      {error && (
        <div
          style={{
            padding: "16px",
            borderRadius: "6px",
            background: "var(--danger-soft)",
            border: "1px solid var(--danger)",
            color: "var(--danger-text)",
          }}
          role="alert"
          data-testid="check-alerts-error"
        >
          {error}
        </div>
      )}

      {!loading && !error && (
        <div style={tableWrapperStyle}>
          <table style={tableStyle} aria-label="Check Alerts">
            <thead>
              <tr>
                <th style={thStyle}>Source</th>
                <th style={thStyle}>Title</th>
                <th style={thStyle}>Severity</th>
                <th style={thStyle}>Status</th>
                <th style={thStyle}>Entity</th>
                <th style={thStyle}>Created</th>
              </tr>
            </thead>
            <tbody>
              {total === 0 && (
                <tr>
                  <td
                    style={{ ...tdStyle, textAlign: "center", color: "var(--text-soft)" }}
                    colSpan={6}
                    data-testid="check-alerts-empty"
                  >
                    No check alerts or tenant alerts to show.
                  </td>
                </tr>
              )}
              {tenantAlerts.map((alert) => (
                <tr key={`tenant-${alert.id}`} data-testid={`panel-tenant-alert-${alert.id}`}>
                  <td style={tdStyle}>
                    <span className="source-badge" style={badgeBaseStyle}>
                      {alert.source}
                    </span>
                  </td>
                  <td style={tdStyle}>{alert.title}</td>
                  <td style={tdStyle}>
                    <span className="sev-badge" style={severityBadgeStyle(alert.severity)}>
                      {alert.severity}
                    </span>
                  </td>
                  <td style={tdStyle}>
                    <span className="status-badge" style={alertStatusBadgeStyle(alert.status)}>
                      {alert.status}
                    </span>
                  </td>
                  <td style={tdStyle}>{formatAlertEntity(alert.entity)}</td>
                  <td style={tdStyle}>{formatTimestamp(alert.created)}</td>
                </tr>
              ))}
              {checkAlerts.map((alert) => (
                <tr key={`check-${alert.id}`} data-testid={`panel-check-alert-${alert.id}`}>
                  <td style={tdStyle}>
                    <span className="source-badge" style={checkBadgeStyle}>
                      Check
                    </span>
                  </td>
                  <td style={tdStyle}>
                    <div>{alert.title}</div>
                    <div style={{ color: "var(--muted)", fontSize: "12px" }}>{alert.checkId}</div>
                  </td>
                  <td style={tdStyle}>
                    <span
                      className="sev-badge"
                      style={severityBadgeStyle(alert.severity)}
                      data-testid={`check-alert-severity-${alert.id}`}
                    >
                      {alert.severity}
                    </span>
                  </td>
                  <td style={tdStyle}>
                    <span className="status-badge" style={alertStatusBadgeStyle(alert.status)}>
                      {alert.status}
                    </span>
                  </td>
                  <td style={tdStyle}>{alert.entity?.trim() || "—"}</td>
                  <td style={tdStyle}>{formatTimestamp(alert.created)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
