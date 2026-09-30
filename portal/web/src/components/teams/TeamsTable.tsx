"use client";

// Teams table (EPIC-026 SPEC.md §3.1, T-0503).
// Columns: Name · Owners · Members · Visibility · Archived · Created ·
// Sensitivity. Filter values (visibility, archived, activity) are owned by the
// page and applied through the T-0502 list route
// (GET /v1/tenants/{id}/teams); this component only edits the values and
// reports them back. Row actions and `Add team` report to the page, which routes
// to the lifecycle (T-0505) and create-wizard (T-0506) surfaces rather than
// duplicating their logic. Strictly uses report theme tokens with zero colour
// literals.

import React, { type CSSProperties, type ReactElement } from "react";

export type TeamVisibility = "public" | "private";

export type TeamRowAction =
  | "view"
  | "edit"
  | "members"
  | "archive"
  | "clone"
  | "delete";

export interface TeamItem {
  readonly id: string;
  readonly name: string;
  readonly ownerCount: number;
  readonly memberCount: number;
  readonly visibility: TeamVisibility;
  readonly isArchived: boolean;
  readonly createdDateTime: string;
  readonly sensitivityLabel: string;
}

export type TeamActivityWindow = "" | "D7" | "D30" | "D90";

export interface TeamsFilters {
  readonly visibility: "" | TeamVisibility;
  readonly archived: "" | "archived" | "active";
  readonly activity: TeamActivityWindow;
}

export const EMPTY_TEAMS_FILTERS: TeamsFilters = {
  visibility: "",
  archived: "",
  activity: "",
};

export const ACTIVITY_WINDOWS: readonly {
  readonly value: Exclude<TeamActivityWindow, "">;
  readonly label: string;
  readonly days: number;
}[] = [
  { value: "D7", label: "Last 7 days", days: 7 },
  { value: "D30", label: "Last 30 days", days: 30 },
  { value: "D90", label: "Last 90 days", days: 90 },
];

const ACTIVITY_DAYS: Readonly<Record<string, number>> = {
  D7: 7,
  D30: 30,
  D90: 90,
};

const DAY_MS = 86400000;

export interface BuildTeamsQueryOptions {
  readonly cursor?: string | null;
  readonly limit?: number;
  readonly now?: Date;
}

/** Maps the §3.1 filters onto the T-0502 query parameters. */
export function buildTeamsQuery(
  filters: TeamsFilters,
  options: BuildTeamsQueryOptions = {},
): string {
  const params = new URLSearchParams();
  if (filters.visibility) params.set("visibility", filters.visibility);
  if (filters.archived) params.set("archived", filters.archived === "archived" ? "true" : "false");
  const days = ACTIVITY_DAYS[filters.activity];
  if (days) {
    const to = options.now ?? new Date();
    const from = new Date(to.getTime() - days * DAY_MS);
    params.set("from", from.toISOString());
    params.set("to", to.toISOString());
  }
  if (options.cursor) params.set("cursor", options.cursor);
  if (options.limit !== undefined) params.set("limit", String(options.limit));
  const query = params.toString();
  return query.length > 0 ? `?${query}` : "";
}

export interface TeamsTableProps {
  readonly teams?: readonly TeamItem[];
  readonly loading?: boolean;
  readonly error?: string | null;
  readonly filters: TeamsFilters;
  readonly onFiltersChange?: (filters: TeamsFilters) => void;
  readonly onAddTeam?: () => void;
  readonly onAction?: (action: TeamRowAction, team: TeamItem) => void;
  readonly nextCursor?: string | null;
  readonly page?: number;
  readonly onNextPage?: () => void;
  readonly onPrevPage?: () => void;
}

const ROW_ACTIONS: readonly { readonly action: TeamRowAction; readonly label: string }[] = [
  { action: "view", label: "View" },
  { action: "edit", label: "Edit" },
  { action: "members", label: "Members" },
  { action: "archive", label: "Archive" },
  { action: "clone", label: "Clone" },
  { action: "delete", label: "Delete" },
];

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
  gap: "10px",
  alignItems: "center",
  justifyContent: "space-between",
  padding: "12px 16px",
  background: "var(--bg-elev)",
  border: "1px solid var(--border)",
  borderRadius: "var(--radius, 10px)",
};

const filterRowStyle: CSSProperties = {
  display: "flex",
  flexWrap: "wrap",
  gap: "10px",
  alignItems: "center",
};

const inputStyle: CSSProperties = {
  padding: "8px 12px",
  background: "var(--input-bg, var(--bg))",
  border: "1px solid var(--border)",
  borderRadius: "6px",
  color: "var(--text)",
  fontSize: "14px",
};

const selectStyle: CSSProperties = { ...inputStyle, cursor: "pointer" };

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

function badgeStyle(tone: "accent" | "muted" | "warn"): CSSProperties {
  const tones = {
    accent: { bg: "var(--accent-soft)", text: "var(--accent-text)", border: "var(--accent-border)" },
    muted: { bg: "var(--surface)", text: "var(--text-soft)", border: "var(--border)" },
    warn: { bg: "var(--warning-soft)", text: "var(--warning-text)", border: "var(--warning)" },
  }[tone];
  return {
    display: "inline-flex",
    alignItems: "center",
    padding: "2px 8px",
    borderRadius: "999px",
    fontSize: "12px",
    fontWeight: 600,
    textTransform: "capitalize",
    background: tones.bg,
    color: tones.text,
    border: `1px solid ${tones.border}`,
  };
}

export function formatCreatedDateTime(value: string): string {
  if (!value) return "—";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleDateString();
}

export function TeamsTable({
  teams = [],
  loading = false,
  error = null,
  filters,
  onFiltersChange,
  onAddTeam,
  onAction,
  nextCursor = null,
  page = 1,
  onNextPage,
  onPrevPage,
}: TeamsTableProps): ReactElement {
  function updateFilters(patch: Partial<TeamsFilters>): void {
    onFiltersChange?.({ ...filters, ...patch });
  }

  const showPagination = Boolean(onNextPage || onPrevPage);

  return (
    <div style={containerStyle} data-testid="teams-table-container">
      <div style={barStyle}>
        <div style={filterRowStyle}>
          <select
            value={filters.visibility}
            onChange={(e) => updateFilters({ visibility: e.target.value as TeamsFilters["visibility"] })}
            style={selectStyle}
            aria-label="Filter by visibility"
            data-testid="filter-visibility"
          >
            <option value="">All visibilities</option>
            <option value="public">Public</option>
            <option value="private">Private</option>
          </select>

          <select
            value={filters.archived}
            onChange={(e) => updateFilters({ archived: e.target.value as TeamsFilters["archived"] })}
            style={selectStyle}
            aria-label="Filter by archived"
            data-testid="filter-archived"
          >
            <option value="">All teams</option>
            <option value="active">Active</option>
            <option value="archived">Archived</option>
          </select>

          <select
            value={filters.activity}
            onChange={(e) => updateFilters({ activity: e.target.value as TeamActivityWindow })}
            style={selectStyle}
            aria-label="Filter by activity"
            data-testid="filter-activity"
          >
            <option value="">Any activity</option>
            {ACTIVITY_WINDOWS.map((window) => (
              <option key={window.value} value={window.value}>
                {window.label}
              </option>
            ))}
          </select>
        </div>

        <div style={{ display: "flex", alignItems: "center", gap: "10px" }}>
          <span
            style={{
              padding: "2px 8px",
              background: "var(--surface)",
              border: "1px solid var(--border)",
              borderRadius: "999px",
              fontSize: "12px",
              color: "var(--text-soft)",
            }}
            data-testid="teams-count"
          >
            {teams.length} {teams.length === 1 ? "team" : "teams"}
          </span>
          {onAddTeam && (
            <button type="button" style={primaryButtonStyle} onClick={onAddTeam} data-testid="add-team-button">
              Add team
            </button>
          )}
        </div>
      </div>

      {loading && (
        <div style={{ padding: "32px", textAlign: "center", color: "var(--text-soft)" }} data-testid="teams-loading">
          Loading teams...
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
          data-testid="teams-error"
        >
          {error}
        </div>
      )}

      {!loading && !error && teams.length === 0 && (
        <div
          style={{
            padding: "48px 16px",
            textAlign: "center",
            background: "var(--bg-elev)",
            borderRadius: "var(--radius, 10px)",
            border: "1px solid var(--border)",
            color: "var(--text-soft)",
          }}
          data-testid="empty-teams-state"
        >
          No teams match the current filters.
        </div>
      )}

      {!loading && !error && teams.length > 0 && (
        <div style={tableWrapperStyle}>
          <table style={tableStyle} aria-label="Teams">
            <thead>
              <tr>
                <th style={thStyle}>Name</th>
                <th style={thStyle}>Owners</th>
                <th style={thStyle}>Members</th>
                <th style={thStyle}>Visibility</th>
                <th style={thStyle}>Archived</th>
                <th style={thStyle}>Created</th>
                <th style={thStyle}>Sensitivity</th>
                <th style={{ ...thStyle, textAlign: "right" }}>Actions</th>
              </tr>
            </thead>
            <tbody>
              {teams.map((team) => (
                <tr key={team.id} data-testid={`team-row-${team.id}`}>
                  <td style={tdStyle}>{team.name}</td>
                  <td style={tdStyle}>{team.ownerCount}</td>
                  <td style={tdStyle}>{team.memberCount}</td>
                  <td style={tdStyle}>
                    <span style={badgeStyle(team.visibility === "public" ? "accent" : "muted")}>{team.visibility}</span>
                  </td>
                  <td style={tdStyle}>
                    <span style={badgeStyle(team.isArchived ? "warn" : "muted")}>
                      {team.isArchived ? "Archived" : "Active"}
                    </span>
                  </td>
                  <td style={tdStyle}>{formatCreatedDateTime(team.createdDateTime)}</td>
                  <td style={tdStyle}>{team.sensitivityLabel || "—"}</td>
                  <td style={{ ...tdStyle, textAlign: "right" }}>
                    <div style={{ display: "inline-flex", gap: "6px", justifyContent: "flex-end", flexWrap: "wrap" }}>
                      {ROW_ACTIONS.map(({ action, label }) => (
                        <button
                          key={action}
                          type="button"
                          style={actionBtnStyle}
                          onClick={() => onAction?.(action, team)}
                          aria-label={`${label} ${team.name}`}
                          data-testid={`team-action-${action}-${team.id}`}
                        >
                          {label}
                        </button>
                      ))}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {showPagination && (
        <div style={barStyle} data-testid="teams-pagination">
          <button
            type="button"
            style={buttonStyle}
            disabled={page <= 1}
            onClick={onPrevPage}
            data-testid="teams-prev-page"
          >
            Previous
          </button>
          <span style={{ fontSize: "13px", color: "var(--text-soft)" }} data-testid="teams-page-number">
            Page {page}
          </span>
          <button
            type="button"
            style={buttonStyle}
            disabled={!nextCursor}
            onClick={onNextPage}
            data-testid="teams-next-page"
          >
            Next
          </button>
        </div>
      )}
    </div>
  );
}
