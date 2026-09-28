"use client";

// CVE exception table (EPIC-019 SPEC.md §3.4, T-0369).
// Columns CVE · Scope · Reason · Expires · Created by with row actions Edit
// and Remove plus an Add exception action. Expired exceptions stay listed
// with an "Expired — re-surfaced" flag: a lapsed expiry stops suppressing
// the CVE, it never hides the row. Kit tokens only.

import React, { type CSSProperties, type ReactElement } from "react";

export type CveExceptionScope = "all" | "device" | "software";

export const CVE_EXCEPTION_SCOPES: readonly CveExceptionScope[] = ["all", "device", "software"];

export interface CveException {
  readonly id: string;
  readonly tenantId: string;
  readonly cve: string;
  readonly scope: CveExceptionScope;
  readonly scopeTargetId: string | null;
  readonly reason: string;
  readonly expiresOn: string;
  readonly createdBy: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export type CveExceptionRowAction = "edit" | "remove";

export interface CveExceptionTableProps {
  readonly exceptions?: readonly CveException[];
  readonly loading?: boolean;
  readonly error?: string | null;
  readonly now?: number;
  readonly onAdd?: () => void;
  readonly onAction?: (action: CveExceptionRowAction, exception: CveException) => void;
}

export function isCveExceptionExpired(
  exception: Pick<CveException, "expiresOn">,
  now: number = Date.now(),
): boolean {
  const time = new Date(exception.expiresOn).getTime();
  if (Number.isNaN(time)) return false;
  return time <= now;
}

export function formatExpiry(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}

const containerStyle: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: "16px",
  width: "100%",
  fontFamily: "var(--font-sans, system-ui, sans-serif)",
  color: "var(--text)",
};

const barStyle: CSSProperties = {
  display: "flex",
  flexWrap: "wrap",
  gap: "12px",
  alignItems: "center",
  justifyContent: "space-between",
  padding: "16px",
  background: "var(--bg-elev)",
  border: "1px solid var(--border)",
  borderRadius: "var(--radius, 10px)",
};

const buttonStyle: CSSProperties = {
  padding: "8px 14px",
  background: "var(--surface)",
  border: "1px solid var(--border)",
  borderRadius: "6px",
  color: "var(--text)",
  fontSize: "14px",
  fontWeight: 500,
  cursor: "pointer",
};

const primaryButtonStyle: CSSProperties = {
  ...buttonStyle,
  background: "var(--accent)",
  color: "var(--on-accent)",
  borderColor: "var(--accent)",
};

const tableWrapperStyle: CSSProperties = {
  overflowX: "auto",
  background: "var(--bg-elev)",
  border: "1px solid var(--border)",
  borderRadius: "var(--radius, 10px)",
  boxShadow: "var(--shadow-card)",
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

const monoStyle: CSSProperties = {
  fontFamily: "var(--font-mono, monospace)",
  fontSize: "13px",
  color: "var(--text)",
};

const targetStyle: CSSProperties = {
  ...monoStyle,
  fontSize: "12px",
  color: "var(--text-soft)",
  marginTop: "4px",
  wordBreak: "break-all",
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

function badgeStyle(kind: "muted" | "bad"): CSSProperties {
  const tones = {
    muted: { bg: "var(--surface)", text: "var(--text-soft)", border: "var(--border)" },
    bad: { bg: "var(--danger-soft)", text: "var(--danger-text)", border: "var(--danger)" },
  }[kind];
  return {
    display: "inline-flex",
    alignItems: "center",
    padding: "2px 8px",
    borderRadius: "999px",
    fontSize: "12px",
    fontWeight: 600,
    background: tones.bg,
    color: tones.text,
    border: `1px solid ${tones.border}`,
  };
}

export function CveExceptionTable({
  exceptions = [],
  loading = false,
  error = null,
  now,
  onAdd,
  onAction,
}: CveExceptionTableProps): ReactElement {
  const nowMs = now ?? Date.now();

  return (
    <div style={containerStyle} data-testid="cve-exception-table">
      <div style={barStyle}>
        <div style={{ display: "flex", alignItems: "center", gap: "12px" }}>
          <h2 style={{ margin: 0, fontSize: "20px", fontWeight: 600 }}>CVE exceptions</h2>
          <span
            style={{
              padding: "2px 8px",
              background: "var(--surface)",
              border: "1px solid var(--border)",
              borderRadius: "999px",
              fontSize: "12px",
              color: "var(--text-soft)",
            }}
            data-testid="cve-exception-count"
          >
            {exceptions.length} {exceptions.length === 1 ? "exception" : "exceptions"}
          </span>
        </div>
        {onAdd && (
          <button type="button" style={primaryButtonStyle} onClick={onAdd} data-testid="add-exception-button">
            Add exception
          </button>
        )}
      </div>

      {loading && (
        <div style={{ padding: "32px", textAlign: "center", color: "var(--text-soft)" }}>
          Loading CVE exceptions...
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
        >
          {error}
        </div>
      )}

      {!loading && !error && exceptions.length === 0 && (
        <div
          style={{
            padding: "48px 16px",
            textAlign: "center",
            background: "var(--bg-elev)",
            borderRadius: "var(--radius, 10px)",
            border: "1px solid var(--border)",
            color: "var(--text-soft)",
          }}
          data-testid="empty-cve-exceptions"
        >
          No CVE exceptions. Use Add exception to suppress a CVE until its expiry.
        </div>
      )}

      {!loading && !error && exceptions.length > 0 && (
        <div style={tableWrapperStyle}>
          <table style={tableStyle} aria-label="CVE exceptions">
            <thead>
              <tr>
                <th style={thStyle}>CVE</th>
                <th style={thStyle}>Scope</th>
                <th style={thStyle}>Reason</th>
                <th style={thStyle}>Expires</th>
                <th style={thStyle}>Created by</th>
                <th style={{ ...thStyle, textAlign: "right" }}>Actions</th>
              </tr>
            </thead>
            <tbody>
              {exceptions.map((exception) => {
                const expired = isCveExceptionExpired(exception, nowMs);
                return (
                  <tr
                    key={exception.id}
                    data-testid={`cve-row-${exception.id}`}
                    data-expired={expired ? "true" : "false"}
                  >
                    <td style={tdStyle}>
                      <span style={monoStyle}>{exception.cve}</span>
                    </td>
                    <td style={tdStyle}>
                      <span style={badgeStyle("muted")}>{exception.scope}</span>
                      {exception.scopeTargetId && (
                        <div style={targetStyle} data-testid={`cve-target-${exception.id}`}>
                          {exception.scopeTargetId}
                        </div>
                      )}
                    </td>
                    <td style={tdStyle}>{exception.reason}</td>
                    <td style={tdStyle}>
                      <span>{formatExpiry(exception.expiresOn)}</span>
                      {expired && (
                        <div style={{ marginTop: "4px" }}>
                          <span style={badgeStyle("bad")} data-testid={`cve-expired-${exception.id}`}>
                            Expired — re-surfaced
                          </span>
                        </div>
                      )}
                    </td>
                    <td style={tdStyle}>{exception.createdBy}</td>
                    <td style={{ ...tdStyle, textAlign: "right" }}>
                      <div style={{ display: "inline-flex", gap: "6px", justifyContent: "flex-end" }}>
                        <button
                          type="button"
                          style={actionBtnStyle}
                          onClick={() => onAction?.("edit", exception)}
                          aria-label={`Edit ${exception.cve} exception`}
                          data-testid={`action-edit-${exception.id}`}
                        >
                          Edit
                        </button>
                        <button
                          type="button"
                          style={actionBtnStyle}
                          onClick={() => onAction?.("remove", exception)}
                          aria-label={`Remove ${exception.cve} exception`}
                          data-testid={`action-remove-${exception.id}`}
                        >
                          Remove
                        </button>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
