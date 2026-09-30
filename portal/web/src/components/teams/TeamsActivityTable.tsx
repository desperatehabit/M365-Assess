"use client";

// TeamsActivityTable — Teams activity report tables (EPIC-026 SPEC.md §3.2; T-0507).
// Report-style per-team and per-user usage tables (active users, messages,
// meetings) with per-team drill-through into the per-user table. Read-only:
// no write path is introduced here. Strictly uses report theme tokens with
// zero colour literals.
import React, { useMemo, useState, type CSSProperties, type ReactElement } from "react";

export interface TeamsActivitySources {
  readonly teams: string;
  readonly users: string;
}

export interface TeamsActivityTeamRow {
  readonly teamId: string | null;
  readonly displayName: string;
  readonly activeUsers: number;
  readonly messages: number;
  readonly meetings: number;
  readonly calls: number;
  readonly lastActivityDate: string | null;
  readonly source: string;
}

export interface TeamsActivityUserRow {
  readonly userId: string | null;
  readonly displayName: string;
  readonly userPrincipalName: string;
  readonly teamId: string | null;
  readonly active: boolean;
  readonly messages: number;
  readonly meetings: number;
  readonly calls: number;
  readonly lastActivityDate: string | null;
  readonly source: string;
}

export interface TeamsActivityReportData {
  readonly tenantId: string;
  readonly generatedAt: string;
  readonly period: string;
  readonly startDate: string | null;
  readonly endDate: string | null;
  readonly teams: readonly TeamsActivityTeamRow[];
  readonly users: readonly TeamsActivityUserRow[];
  readonly sources: TeamsActivitySources;
  readonly nextCursor: string | null;
}

export interface TeamsActivityTableProps {
  readonly report?: TeamsActivityReportData | null;
  readonly loading?: boolean;
  readonly error?: string | null;
  readonly period?: string;
  readonly onPeriodChange?: (period: string) => void;
  readonly startDate?: string;
  readonly onStartDateChange?: (value: string) => void;
  readonly endDate?: string;
  readonly onEndDateChange?: (value: string) => void;
  readonly onRefresh?: () => void;
}

const PERIODS = ["D7", "D30", "D90", "D180"] as const;

const sectionStyle: CSSProperties = {
  background: "var(--bg-elev, #ffffff)",
  border: "1px solid var(--border, #e5e7eb)",
  borderRadius: "var(--radius, 10px)",
  padding: "20px",
  display: "flex",
  flexDirection: "column",
  gap: "14px",
};

const tableStyle: CSSProperties = {
  width: "100%",
  borderCollapse: "collapse",
  fontSize: "13px",
  textAlign: "left",
};

const thStyle: CSSProperties = {
  padding: "10px 12px",
  borderBottom: "1px solid var(--border, #e5e7eb)",
  fontWeight: 600,
  color: "var(--text-muted, #6b7280)",
  background: "var(--bg-muted, #f9fafb)",
};

const tdStyle: CSSProperties = {
  padding: "10px 12px",
  borderBottom: "1px solid var(--border, #f3f4f6)",
  verticalAlign: "middle",
};

const inputStyle: CSSProperties = {
  padding: "6px 12px",
  borderRadius: "6px",
  border: "1px solid var(--border, #d1d5db)",
  background: "var(--input-bg, #ffffff)",
  color: "var(--text, #111827)",
  fontSize: "13px",
};

const buttonStyle: CSSProperties = {
  padding: "6px 14px",
  background: "var(--bg-muted, #f3f4f6)",
  border: "1px solid var(--border, #d1d5db)",
  borderRadius: "6px",
  fontSize: "13px",
  fontWeight: 600,
  cursor: "pointer",
  color: "var(--text, #111827)",
};

const badgeStyle: CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  padding: "2px 8px",
  borderRadius: "12px",
  fontSize: "12px",
  fontWeight: 600,
  border: "1px solid var(--border, #e5e7eb)",
  background: "var(--bg-elev, #ffffff)",
  color: "var(--text, #111827)",
};

export function TeamsActivityTable({
  report,
  loading = false,
  error = null,
  period = "D7",
  onPeriodChange,
  startDate = "",
  onStartDateChange,
  endDate = "",
  onEndDateChange,
  onRefresh,
}: TeamsActivityTableProps): ReactElement {
  const [selectedTeamId, setSelectedTeamId] = useState<string | null>(null);

  const selectedTeam = useMemo(() => {
    if (!selectedTeamId || !report) return null;
    return report.teams.find((t) => t.teamId === selectedTeamId) ?? null;
  }, [selectedTeamId, report]);

  const visibleUsers = useMemo(() => {
    if (!report) return [];
    if (!selectedTeamId) return report.users;
    return report.users.filter((u) => u.teamId === selectedTeamId);
  }, [report, selectedTeamId]);

  if (loading) {
    return (
      <div style={{ padding: "40px", textAlign: "center", color: "var(--text-muted, #6b7280)" }} data-testid="teams-activity-loading">
        Loading Teams activity report...
      </div>
    );
  }

  if (error) {
    return (
      <div
        data-testid="teams-activity-error"
        style={{
          padding: "16px",
          background: "var(--danger-bg, #fef2f2)",
          border: "1px solid var(--danger-border, #fecaca)",
          borderRadius: "8px",
          color: "var(--danger, #991b1b)",
          fontSize: "14px",
        }}
      >
        <strong>Error loading report:</strong> {error}
      </div>
    );
  }

  if (!report) {
    return (
      <div style={{ padding: "40px", textAlign: "center", color: "var(--text-muted, #6b7280)" }} data-testid="teams-activity-empty">
        No report data available.
      </div>
    );
  }

  const totalActiveUsers = report.teams.reduce((sum, t) => sum + t.activeUsers, 0);
  const totalMessages = report.teams.reduce((sum, t) => sum + t.messages, 0);
  const totalMeetings = report.teams.reduce((sum, t) => sum + t.meetings, 0);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "24px" }} data-testid="teams-activity-table">
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: "12px" }}>
        <div style={{ display: "flex", alignItems: "center", gap: "8px", flexWrap: "wrap" }}>
          <label htmlFor="teams-period" style={{ fontSize: "13px", fontWeight: 600, color: "var(--text, #111827)" }}>
            Period:
          </label>
          <select
            id="teams-period"
            data-testid="teams-period-select"
            value={period}
            onChange={(e) => onPeriodChange?.(e.target.value)}
            style={inputStyle}
          >
            {PERIODS.map((p) => (
              <option key={p} value={p}>
                {p}
              </option>
            ))}
          </select>
          <input
            type="date"
            aria-label="Start date"
            data-testid="teams-start-date"
            value={startDate}
            onChange={(e) => onStartDateChange?.(e.target.value)}
            style={inputStyle}
          />
          <input
            type="date"
            aria-label="End date"
            data-testid="teams-end-date"
            value={endDate}
            onChange={(e) => onEndDateChange?.(e.target.value)}
            style={inputStyle}
          />
        </div>
        {onRefresh && (
          <button type="button" data-testid="teams-refresh-button" onClick={onRefresh} style={buttonStyle}>
            Refresh
          </button>
        )}
      </div>

      <div style={{ display: "flex", flexWrap: "wrap", gap: "12px" }} data-testid="teams-activity-kpis">
        <div style={kpiStyle} data-testid="kpi-teams">
          <div style={kpiLabelStyle}>Teams</div>
          <div style={kpiValueStyle}>{report.teams.length}</div>
        </div>
        <div style={kpiStyle} data-testid="kpi-active-users">
          <div style={kpiLabelStyle}>Active Users</div>
          <div style={kpiValueStyle}>{totalActiveUsers}</div>
        </div>
        <div style={kpiStyle} data-testid="kpi-messages">
          <div style={kpiLabelStyle}>Messages</div>
          <div style={kpiValueStyle}>{totalMessages}</div>
        </div>
        <div style={kpiStyle} data-testid="kpi-meetings">
          <div style={kpiLabelStyle}>Meetings</div>
          <div style={kpiValueStyle}>{totalMeetings}</div>
        </div>
      </div>

      <div style={sectionStyle} data-testid="section-teams">
        <div>
          <h2 style={{ fontSize: "16px", fontWeight: 700, margin: 0 }}>Per-team usage</h2>
          <div style={{ fontSize: "12px", color: "var(--text-muted, #6b7280)", marginTop: "2px" }}>
            Active users, messages, and meetings per team. Use &quot;View users&quot; to drill through.
          </div>
        </div>
        {report.teams.length === 0 ? (
          <div style={{ fontSize: "13px", color: "var(--text-muted, #6b7280)" }} data-testid="teams-none">
            No team activity recorded in this period.
          </div>
        ) : (
          <div style={{ overflowX: "auto" }}>
            <table style={tableStyle} data-testid="table-teams">
              <thead>
                <tr>
                  <th style={thStyle}>Team</th>
                  <th style={{ ...thStyle, textAlign: "right" }}>Active users</th>
                  <th style={{ ...thStyle, textAlign: "right" }}>Messages</th>
                  <th style={{ ...thStyle, textAlign: "right" }}>Meetings</th>
                  <th style={{ ...thStyle, textAlign: "right" }}>Calls</th>
                  <th style={thStyle}>Last activity</th>
                  <th style={thStyle}>Source</th>
                  <th style={{ ...thStyle, textAlign: "right" }}>Drill-through</th>
                </tr>
              </thead>
              <tbody>
                {report.teams.map((team) => {
                  const isSelected = team.teamId !== null && team.teamId === selectedTeamId;
                  return (
                    <tr
                      key={team.teamId ?? team.displayName}
                      style={{ background: isSelected ? "var(--bg-muted, #f9fafb)" : "transparent" }}
                      data-testid={`team-row-${team.teamId ?? team.displayName}`}
                    >
                      <td style={tdStyle}>
                        <strong>{team.displayName}</strong>
                      </td>
                      <td style={{ ...tdStyle, textAlign: "right" }}>{team.activeUsers}</td>
                      <td style={{ ...tdStyle, textAlign: "right" }}>{team.messages}</td>
                      <td style={{ ...tdStyle, textAlign: "right" }}>{team.meetings}</td>
                      <td style={{ ...tdStyle, textAlign: "right" }}>{team.calls}</td>
                      <td style={tdStyle}>
                        {team.lastActivityDate ? new Date(team.lastActivityDate).toLocaleDateString() : "—"}
                      </td>
                      <td style={tdStyle}>
                        <span style={badgeStyle}>{team.source}</span>
                      </td>
                      <td style={{ ...tdStyle, textAlign: "right" }}>
                        <button
                          type="button"
                          style={{
                            ...buttonStyle,
                            ...(team.teamId === null ? { opacity: 0.6, cursor: "not-allowed" } : {}),
                          }}
                          disabled={team.teamId === null}
                          title={team.teamId === null ? "Team id unavailable in this report" : `View users of ${team.displayName}`}
                          onClick={() => setSelectedTeamId(isSelected ? null : team.teamId)}
                          data-testid={`team-drill-${team.teamId ?? team.displayName}`}
                        >
                          {isSelected ? "Close" : "View users"}
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <div style={sectionStyle} data-testid="section-users">
        <div>
          <h2 style={{ fontSize: "16px", fontWeight: 700, margin: 0 }}>Per-user usage</h2>
          <div style={{ fontSize: "12px", color: "var(--text-muted, #6b7280)", marginTop: "2px" }} data-testid="users-context">
            {selectedTeam
              ? `Drilled into: ${selectedTeam.displayName}. Showing that team's users; clear to see tenant-wide activity.`
              : "Active users, messages, and meetings per user across the tenant."}
          </div>
        </div>
        {selectedTeam && (
          <button
            type="button"
            style={{ ...buttonStyle, alignSelf: "flex-start" }}
            onClick={() => setSelectedTeamId(null)}
            data-testid="users-clear-drill"
          >
            Clear drill-through
          </button>
        )}
        {visibleUsers.length === 0 ? (
          <div style={{ fontSize: "13px", color: "var(--text-muted, #6b7280)" }} data-testid="users-none">
            No user activity recorded in this period.
          </div>
        ) : (
          <div style={{ overflowX: "auto" }}>
            <table style={tableStyle} data-testid="table-users">
              <thead>
                <tr>
                  <th style={thStyle}>User</th>
                  <th style={thStyle}>UPN</th>
                  <th style={{ ...thStyle, textAlign: "right" }}>Active</th>
                  <th style={{ ...thStyle, textAlign: "right" }}>Messages</th>
                  <th style={{ ...thStyle, textAlign: "right" }}>Meetings</th>
                  <th style={{ ...thStyle, textAlign: "right" }}>Calls</th>
                  <th style={thStyle}>Last activity</th>
                  <th style={thStyle}>Source</th>
                </tr>
              </thead>
              <tbody>
                {visibleUsers.map((user) => (
                  <tr key={user.userId ?? user.userPrincipalName} data-testid={`user-row-${user.userId ?? user.userPrincipalName}`}>
                    <td style={tdStyle}>
                      <strong>{user.displayName || "—"}</strong>
                    </td>
                    <td style={{ ...tdStyle, fontFamily: "var(--font-mono, monospace)" }}>{user.userPrincipalName}</td>
                    <td style={{ ...tdStyle, textAlign: "right" }}>
                      <span style={{ ...badgeStyle, borderColor: user.active ? "var(--accent, #2563eb)" : "var(--border, #e5e7eb)" }}>
                        {user.active ? "Active" : "Inactive"}
                      </span>
                    </td>
                    <td style={{ ...tdStyle, textAlign: "right" }}>{user.messages}</td>
                    <td style={{ ...tdStyle, textAlign: "right" }}>{user.meetings}</td>
                    <td style={{ ...tdStyle, textAlign: "right" }}>{user.calls}</td>
                    <td style={tdStyle}>
                      {user.lastActivityDate ? new Date(user.lastActivityDate).toLocaleDateString() : "—"}
                    </td>
                    <td style={tdStyle}>
                      <span style={badgeStyle}>{user.source}</span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}

const kpiStyle: CSSProperties = {
  background: "var(--bg-elev, #ffffff)",
  border: "1px solid var(--border, #e5e7eb)",
  borderRadius: "var(--radius, 8px)",
  padding: "16px 20px",
  display: "flex",
  flexDirection: "column",
  gap: "4px",
  flex: "1 1 160px",
};

const kpiLabelStyle: CSSProperties = {
  fontSize: "12px",
  color: "var(--text-muted, #6b7280)",
  fontWeight: 500,
};

const kpiValueStyle: CSSProperties = {
  fontSize: "24px",
  fontWeight: 700,
  color: "var(--text, #111827)",
};
