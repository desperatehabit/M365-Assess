"use client";

// Alerts table (EPIC-028 SPEC.md §3.3; consumes the T-0548 alert list API).
// Renders the §3.3 columns (Title, Service source, Severity, Status, Entity,
// Created) and the §3.3 row actions (View, Set status, Assign, Comment, Create
// incident where the source supports it). Read-only: every action is handed to
// the T-0548 triage surface through onRowAction, so this component writes
// nothing. Report theme tokens only.

import React, { type CSSProperties, type ReactElement } from "react";
import { severityBadgeStyle } from "./IncidentsTable";

export { severityBadgeStyle };

export type AlertSource = "defender" | "mdo" | "graph";

export type AlertRowAction = "view" | "status" | "assign" | "comment" | "create-incident";

/** The T-0548 normalized entity shape (kind + optional id/displayName). */
export interface AlertEntity {
  readonly kind: string;
  readonly id?: string;
  readonly displayName?: string;
}

export interface AlertRow {
  readonly id: string;
  readonly title: string;
  readonly source: AlertSource | string;
  readonly severity: string;
  readonly status: string;
  readonly entity?: AlertEntity | string | null;
  readonly created: string;
  /**
   * The T-0548 `availableActions` for the alert. When present, create-incident
   * appears only if listed; when absent, it is offered for the sources that
   * support promotion (Defender/MDO), mirroring the route's source gate.
   */
  readonly availableActions?: readonly string[];
}

export interface AlertsTableProps {
  readonly alerts?: readonly AlertRow[];
  readonly loading?: boolean;
  readonly error?: string | null;
  /** Row triage actions hand off to the T-0548 surfaces; nothing is written here. */
  readonly onRowAction?: (action: AlertRowAction, alert: AlertRow) => void;
}

export const ALERT_ROW_ACTIONS: readonly { action: AlertRowAction; label: string }[] = [
  { action: "view", label: "View" },
  { action: "status", label: "Set status" },
  { action: "assign", label: "Assign" },
  { action: "comment", label: "Comment" },
];

export const ALERT_CREATE_INCIDENT_ACTION = {
  action: "create-incident",
  label: "Create incident",
} as const;

/** The row actions offered for an alert; create-incident is source-gated. */
export function availableAlertRowActions(alert: AlertRow): readonly AlertRowAction[] {
  const actions: AlertRowAction[] = ALERT_ROW_ACTIONS.map((entry) => entry.action);
  const supported =
    alert.availableActions === undefined
      ? alert.source === "defender" || alert.source === "mdo"
      : alert.availableActions.includes("create-incident");
  if (supported) {
    actions.push("create-incident");
  }
  return actions;
}

export function formatAlertEntity(entity: AlertRow["entity"]): string {
  if (entity === null || entity === undefined) {
    return "—";
  }
  if (typeof entity === "string") {
    return entity.trim() || "—";
  }
  return entity.displayName?.trim() || entity.id?.trim() || entity.kind || "—";
}

function formatTimestamp(value: string): string {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    return value;
  }
  return parsed.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}

// ─── Styles ───────────────────────────────────────────────────────────────────

const containerStyle: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: "16px",
  width: "100%",
  fontFamily: "var(--font-sans, system-ui, sans-serif)",
  color: "var(--text)",
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

const actionBtnStyle: CSSProperties = {
  padding: "4px 8px",
  background: "var(--surface)",
  border: "1px solid var(--border)",
  borderRadius: "4px",
  color: "var(--text)",
  fontSize: "12px",
  cursor: "pointer",
  whiteSpace: "nowrap",
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

export function alertStatusBadgeStyle(status: string): CSSProperties {
  switch (status.trim().toLowerCase()) {
    case "resolved":
    case "closed":
      return { ...badgeBaseStyle, background: "var(--success-soft)", color: "var(--success-text)", border: "1px solid var(--success)" };
    case "in progress":
    case "inprogress":
    case "new":
    case "open":
      return { ...badgeBaseStyle, background: "var(--warning-soft)", color: "var(--warning-text)", border: "1px solid var(--warning)" };
    default:
      return { ...badgeBaseStyle, background: "var(--surface)", color: "var(--text-soft)", border: "1px solid var(--border)" };
  }
}

export function AlertsTable({
  alerts = [],
  loading = false,
  error = null,
  onRowAction,
}: AlertsTableProps): ReactElement {
  return (
    <div style={containerStyle} data-testid="alerts-table">
      {loading && (
        <div style={{ padding: "32px", textAlign: "center", color: "var(--text-soft)" }} data-testid="alerts-loading">
          Loading alerts...
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
          data-testid="alerts-error"
        >
          {error}
        </div>
      )}

      {!loading && !error && (
        <div style={tableWrapperStyle}>
          <table style={tableStyle} aria-label="Alerts">
            <thead>
              <tr>
                <th style={thStyle}>Title</th>
                <th style={thStyle}>Service source</th>
                <th style={thStyle}>Severity</th>
                <th style={thStyle}>Status</th>
                <th style={thStyle}>Entity</th>
                <th style={thStyle}>Created</th>
                <th style={{ ...thStyle, textAlign: "right" }}>Actions</th>
              </tr>
            </thead>
            <tbody>
              {alerts.length === 0 && (
                <tr>
                  <td
                    style={{ ...tdStyle, textAlign: "center", color: "var(--text-soft)" }}
                    colSpan={7}
                    data-testid="alerts-empty"
                  >
                    No alerts match the current filters.
                  </td>
                </tr>
              )}
              {alerts.map((alert) => (
                <tr key={alert.id} data-testid={`alert-row-${alert.id}`}>
                  <td style={tdStyle}>{alert.title}</td>
                  <td style={tdStyle}>
                    <span className="source-badge" style={{ ...badgeBaseStyle, background: "var(--surface)", color: "var(--text-soft)", border: "1px solid var(--border)" }}>
                      {alert.source}
                    </span>
                  </td>
                  <td style={tdStyle}>
                    <span
                      className="sev-badge"
                      style={severityBadgeStyle(alert.severity)}
                      data-testid={`alert-severity-${alert.id}`}
                    >
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
                  <td style={{ ...tdStyle, textAlign: "right" }}>
                    <div style={{ display: "inline-flex", gap: "6px", justifyContent: "flex-end", flexWrap: "wrap" }}>
                      {availableAlertRowActions(alert).map((action) => {
                        const label =
                          action === "create-incident"
                            ? ALERT_CREATE_INCIDENT_ACTION.label
                            : ALERT_ROW_ACTIONS.find((entry) => entry.action === action)?.label ?? action;
                        return (
                          <button
                            key={action}
                            type="button"
                            style={actionBtnStyle}
                            onClick={() => onRowAction?.(action, alert)}
                            data-testid={`alert-action-${action}-${alert.id}`}
                          >
                            {label}
                          </button>
                        );
                      })}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
