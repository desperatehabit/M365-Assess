"use client";

// Saved Log Searches table (EPIC-032 SPEC.md §3.2; T-0623, T-0627).
// Columns: Name · Filter summary · Last run · Schedule · State. Row actions:
// Run, Edit, Schedule, Delete. Zero colour literals: report theme tokens only.

import React, { type CSSProperties, type ReactElement } from "react";
import type { AuditSearch } from "../../lib/auditApi";

// ─── Styles ─────────────────────────────────────────────────────────────────

const containerStyle: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: "16px",
  width: "100%",
  fontFamily: "var(--font-sans, system-ui, sans-serif)",
  color: "var(--text)",
};

const tableWrapStyle: CSSProperties = {
  overflowX: "auto",
  background: "var(--bg-elev)",
  border: "1px solid var(--border)",
  borderRadius: "var(--radius, 10px)",
};

const tableStyle: CSSProperties = {
  width: "100%",
  borderCollapse: "collapse",
  fontSize: "13px",
};

const thStyle: CSSProperties = {
  textAlign: "left",
  padding: "10px 12px",
  borderBottom: "1px solid var(--border)",
  color: "var(--text-soft)",
  fontWeight: 600,
  whiteSpace: "nowrap",
};

const tdStyle: CSSProperties = {
  padding: "10px 12px",
  borderBottom: "1px solid var(--border)",
  verticalAlign: "top",
};

const monoStyle: CSSProperties = {
  fontFamily: "var(--font-mono, ui-monospace, monospace)",
  fontSize: "12px",
  wordBreak: "break-all",
};

const badgeBaseStyle: CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  padding: "2px 8px",
  borderRadius: "999px",
  fontSize: "12px",
  fontWeight: 600,
  whiteSpace: "nowrap",
};

const stateBadgeStyle = (scheduled: boolean): CSSProperties =>
  scheduled
    ? {
        ...badgeBaseStyle,
        background: "var(--accent-soft)",
        color: "var(--accent-text)",
        border: "1px solid var(--accent)",
      }
    : {
        ...badgeBaseStyle,
        background: "var(--surface)",
        color: "var(--text-soft)",
        border: "1px solid var(--border)",
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

const errorStyle: CSSProperties = {
  padding: "10px 14px",
  background: "var(--danger-soft)",
  border: "1px solid var(--danger)",
  borderRadius: "6px",
  color: "var(--danger-text)",
  fontSize: "13px",
};

// ─── Helpers ────────────────────────────────────────────────────────────────

function formatDateTime(value: string | null): string {
  if (!value) return "—";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
}

/** Human-readable filter summary for the §3.1 filter shape. */
export function formatAuditSearchFilters(filters: Record<string, unknown> | null | undefined): string {
  if (!filters) return "—";
  const parts: string[] = [];
  const startDate = typeof filters["startDate"] === "string" ? filters["startDate"] : null;
  const endDate = typeof filters["endDate"] === "string" ? filters["endDate"] : null;
  if (startDate || endDate) {
    parts.push(`${startDate ?? "…"} → ${endDate ?? "…"}`);
  }
  for (const field of ["user", "activity", "workload", "ip"] as const) {
    const value = filters[field];
    if (typeof value === "string" && value.trim()) {
      parts.push(`${field}: ${value.trim()}`);
    }
  }
  return parts.length > 0 ? parts.join(" · ") : "—";
}

// ─── Component ──────────────────────────────────────────────────────────────

export interface SavedSearchesTableProps {
  readonly searches?: readonly AuditSearch[];
  readonly loading?: boolean;
  readonly error?: string | null;
  readonly onRun?: (search: AuditSearch) => void;
  readonly onEdit?: (search: AuditSearch) => void;
  readonly onSchedule?: (search: AuditSearch) => void;
  readonly onDelete?: (search: AuditSearch) => void;
}

export function SavedSearchesTable({
  searches = [],
  loading = false,
  error = null,
  onRun,
  onEdit,
  onSchedule,
  onDelete,
}: SavedSearchesTableProps): ReactElement {
  return (
    <div style={containerStyle} data-testid="saved-searches-table">
      {error && (
        <div style={errorStyle} role="alert" data-testid="saved-searches-error">
          {error}
        </div>
      )}

      {loading && <div data-testid="saved-searches-loading">Loading saved searches…</div>}

      {!loading && (
        <div style={tableWrapStyle}>
          <table style={tableStyle} className="DataTable" data-testid="saved-searches-grid">
            <thead>
              <tr>
                <th style={thStyle}>Name</th>
                <th style={thStyle}>Filter summary</th>
                <th style={thStyle}>Last run</th>
                <th style={thStyle}>Schedule</th>
                <th style={thStyle}>State</th>
                <th style={thStyle}>Actions</th>
              </tr>
            </thead>
            <tbody>
              {searches.map((search) => {
                const scheduled = search.scheduleId !== null;
                return (
                  <tr key={search.id} data-testid={`saved-search-row-${search.id}`}>
                    <td style={tdStyle} data-testid={`saved-search-name-${search.id}`}>
                      {search.name}
                    </td>
                    <td style={tdStyle} data-testid={`saved-search-filters-${search.id}`}>
                      {formatAuditSearchFilters(search.filters)}
                    </td>
                    <td style={{ ...tdStyle, ...monoStyle }} data-testid={`saved-search-lastrun-${search.id}`}>
                      {formatDateTime(search.lastRunAt)}
                    </td>
                    <td style={tdStyle} data-testid={`saved-search-schedule-${search.id}`}>
                      {scheduled ? "Scheduled" : "—"}
                    </td>
                    <td style={tdStyle} data-testid={`saved-search-state-${search.id}`}>
                      <span
                        className="status-badge"
                        style={stateBadgeStyle(scheduled)}
                        data-testid={`saved-search-state-badge-${search.id}`}
                      >
                        {scheduled ? "Scheduled" : "On demand"}
                      </span>
                    </td>
                    <td style={tdStyle}>
                      <div style={{ display: "flex", gap: "6px", flexWrap: "wrap" }}>
                        {onRun && (
                          <button
                            type="button"
                            style={actionBtnStyle}
                            data-testid={`saved-search-run-${search.id}`}
                            onClick={() => onRun(search)}
                          >
                            Run
                          </button>
                        )}
                        {onEdit && (
                          <button
                            type="button"
                            style={actionBtnStyle}
                            data-testid={`saved-search-edit-${search.id}`}
                            onClick={() => onEdit(search)}
                          >
                            Edit
                          </button>
                        )}
                        {onSchedule && (
                          <button
                            type="button"
                            style={actionBtnStyle}
                            data-testid={`saved-search-schedule-action-${search.id}`}
                            onClick={() => onSchedule(search)}
                          >
                            Schedule
                          </button>
                        )}
                        {onDelete && (
                          <button
                            type="button"
                            style={actionBtnStyle}
                            data-testid={`saved-search-delete-${search.id}`}
                            onClick={() => onDelete(search)}
                          >
                            Delete
                          </button>
                        )}
                      </div>
                    </td>
                  </tr>
                );
              })}
              {searches.length === 0 && (
                <tr>
                  <td
                    colSpan={6}
                    style={{ ...tdStyle, textAlign: "center", color: "var(--text-soft)" }}
                    data-testid="saved-searches-empty"
                  >
                    No saved searches yet.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
