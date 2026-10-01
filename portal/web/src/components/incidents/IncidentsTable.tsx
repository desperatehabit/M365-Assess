"use client";

// Incidents table (EPIC-028 SPEC.md §3.1, §4.2; T-0544).
// Renders the §3.1 columns (Title, Severity sev-badge, Status, Classification,
// Assigned to, Alerts, Last updated, Tenant), the §3.1 filters (severity,
// status, classification, assigned, date, tenant), the all-tenants toggle, the
// row actions that route to the T-0547 triage surfaces, and confirmation-gated
// bulk assign/set-status. Read-only: this surface performs no writes.
// Report theme tokens only.

import React, { useMemo, useState, type CSSProperties, type ReactElement } from "react";

export type IncidentSeverity = "unknown" | "informational" | "low" | "medium" | "high";

export interface IncidentRow {
  readonly id: string;
  readonly title: string;
  readonly severity: IncidentSeverity | string;
  readonly status: string;
  readonly classification: string;
  readonly assignedTo: string;
  readonly alertCount: number;
  readonly lastUpdated: string;
  readonly tenantId: string;
}

export type IncidentRowAction =
  | "view"
  | "assign"
  | "status"
  | "classify"
  | "comment"
  | "resolve";

export type IncidentBulkAction = "assign" | "status";

export interface IncidentBulkRequest {
  readonly action: IncidentBulkAction;
  readonly incidents: readonly IncidentRow[];
  readonly confirmed: true;
}

export interface IncidentsTableProps {
  readonly incidents?: readonly IncidentRow[];
  readonly loading?: boolean;
  readonly error?: string | null;
  /** True when the list aggregates every tenant in the caller's RBAC scope. */
  readonly allTenants?: boolean;
  readonly onToggleAllTenants?: (next: boolean) => void;
  /** Row triage actions route to the T-0547 surfaces; nothing is written here. */
  readonly onRowAction?: (action: IncidentRowAction, incident: IncidentRow) => void;
  /** Only fires after the confirmation gate is satisfied. */
  readonly onBulkAction?: (request: IncidentBulkRequest) => void;
}

export const INCIDENT_SEVERITIES: readonly IncidentSeverity[] = [
  "unknown",
  "informational",
  "low",
  "medium",
  "high",
];

export const INCIDENT_ROW_ACTIONS: readonly { action: IncidentRowAction; label: string }[] = [
  { action: "view", label: "View" },
  { action: "assign", label: "Assign" },
  { action: "status", label: "Set status" },
  { action: "classify", label: "Classify" },
  { action: "comment", label: "Comment" },
  { action: "resolve", label: "Resolve" },
];

export const INCIDENT_BULK_ACTIONS: readonly { action: IncidentBulkAction; label: string }[] = [
  { action: "assign", label: "Assign" },
  { action: "status", label: "Set status" },
];

export type IncidentDateRange = "all" | "24h" | "7d" | "30d";

const DATE_WINDOW_MS: Record<Exclude<IncidentDateRange, "all">, number> = {
  "24h": 86400000,
  "7d": 7 * 86400000,
  "30d": 30 * 86400000,
};

// ─── Styles ───────────────────────────────────────────────────────────────────

const containerStyle: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: "16px",
  width: "100%",
  fontFamily: "var(--font-sans, system-ui, sans-serif)",
  color: "var(--text)",
};

const filterBarStyle: CSSProperties = {
  display: "flex",
  flexWrap: "wrap",
  gap: "10px",
  alignItems: "center",
  padding: "12px 16px",
  background: "var(--bg-elev)",
  border: "1px solid var(--border)",
  borderRadius: "var(--radius, 10px)",
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
  padding: "6px 12px",
  background: "var(--surface)",
  border: "1px solid var(--border)",
  borderRadius: "6px",
  color: "var(--text)",
  fontSize: "13px",
  fontWeight: 500,
  cursor: "pointer",
};

const disabledButtonStyle: CSSProperties = {
  ...buttonStyle,
  opacity: 0.4,
  cursor: "not-allowed",
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

const dialogStyle: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: "12px",
  padding: "16px",
  background: "var(--bg-elev)",
  border: "1px solid var(--border)",
  borderRadius: "var(--radius, 10px)",
};

export function severityBadgeStyle(severity: string): CSSProperties {
  switch (severity.toLowerCase()) {
    case "critical":
    case "high":
      return { ...badgeBaseStyle, background: "var(--danger-soft)", color: "var(--danger-text)", border: "1px solid var(--danger)" };
    case "medium":
      return { ...badgeBaseStyle, background: "var(--warning-soft)", color: "var(--warning-text)", border: "1px solid var(--warning)" };
    case "low":
    case "informational":
    case "info":
      return { ...badgeBaseStyle, background: "var(--surface)", color: "var(--text-soft)", border: "1px solid var(--border)" };
    default:
      return { ...badgeBaseStyle, background: "var(--surface)", color: "var(--text)", border: "1px solid var(--border)" };
  }
}

function statusBadgeStyle(status: string): CSSProperties {
  switch (status.trim().toLowerCase()) {
    case "resolved":
    case "closed":
      return { ...badgeBaseStyle, background: "var(--success-soft)", color: "var(--success-text)", border: "1px solid var(--success)" };
    case "active":
    case "in progress":
    case "inprogress":
      return { ...badgeBaseStyle, background: "var(--warning-soft)", color: "var(--warning-text)", border: "1px solid var(--warning)" };
    default:
      return { ...badgeBaseStyle, background: "var(--surface)", color: "var(--text-soft)", border: "1px solid var(--border)" };
  }
}

function distinct(values: readonly string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter((value) => value.length > 0))].sort();
}

function formatTimestamp(value: string): string {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    return value;
  }
  return parsed.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}

export function IncidentsTable({
  incidents = [],
  loading = false,
  error = null,
  allTenants = false,
  onToggleAllTenants,
  onRowAction,
  onBulkAction,
}: IncidentsTableProps): ReactElement {
  const [severityFilter, setSeverityFilter] = useState<string>("all");
  const [statusFilter, setStatusFilter] = useState<string>("all");
  const [classificationFilter, setClassificationFilter] = useState<string>("all");
  const [assignedFilter, setAssignedFilter] = useState<string>("all");
  const [dateFilter, setDateFilter] = useState<IncidentDateRange>("all");
  const [tenantFilter, setTenantFilter] = useState<string>("all");
  const [selected, setSelected] = useState<readonly string[]>([]);
  const [pendingBulk, setPendingBulk] = useState<IncidentBulkAction | null>(null);

  const statuses = useMemo(() => distinct(incidents.map((incident) => incident.status)), [incidents]);
  const classifications = useMemo(
    () => distinct(incidents.map((incident) => incident.classification)),
    [incidents],
  );
  const assignees = useMemo(() => distinct(incidents.map((incident) => incident.assignedTo)), [incidents]);
  const tenants = useMemo(() => distinct(incidents.map((incident) => incident.tenantId)), [incidents]);

  const filtered = useMemo(() => {
    const now = Date.now();
    const windowMs = dateFilter === "all" ? null : DATE_WINDOW_MS[dateFilter];
    return incidents.filter((incident) => {
      if (severityFilter !== "all" && incident.severity.toLowerCase() !== severityFilter) return false;
      if (statusFilter !== "all" && incident.status.trim().toLowerCase() !== statusFilter) return false;
      if (classificationFilter !== "all" && incident.classification.trim().toLowerCase() !== classificationFilter) return false;
      if (assignedFilter === "unassigned" && incident.assignedTo.trim().length > 0) return false;
      if (assignedFilter !== "all" && assignedFilter !== "unassigned" && incident.assignedTo.trim().toLowerCase() !== assignedFilter) return false;
      if (tenantFilter !== "all" && incident.tenantId !== tenantFilter) return false;
      if (windowMs !== null) {
        const updated = Date.parse(incident.lastUpdated);
        if (Number.isNaN(updated) || now - updated > windowMs) return false;
      }
      return true;
    });
  }, [
    incidents,
    severityFilter,
    statusFilter,
    classificationFilter,
    assignedFilter,
    dateFilter,
    tenantFilter,
  ]);

  const selectedIncidents = useMemo(
    () => incidents.filter((incident) => selected.includes(incident.id)),
    [incidents, selected],
  );
  const allFilteredSelected =
    filtered.length > 0 && filtered.every((incident) => selected.includes(incident.id));

  function toggleSelected(id: string): void {
    setSelected((current) =>
      current.includes(id) ? current.filter((entry) => entry !== id) : [...current, id],
    );
  }

  function toggleAllFiltered(): void {
    const filteredIds = filtered.map((incident) => incident.id);
    setSelected((current) =>
      allFilteredSelected
        ? current.filter((id) => !filteredIds.includes(id))
        : [...new Set([...current, ...filteredIds])],
    );
  }

  function requestBulk(action: IncidentBulkAction): void {
    if (selectedIncidents.length === 0) return;
    setPendingBulk(action);
  }

  function confirmBulk(): void {
    if (pendingBulk === null || selectedIncidents.length === 0) {
      setPendingBulk(null);
      return;
    }
    onBulkAction?.({ action: pendingBulk, incidents: selectedIncidents, confirmed: true });
    setPendingBulk(null);
  }

  const pendingLabel =
    INCIDENT_BULK_ACTIONS.find((entry) => entry.action === pendingBulk)?.label ?? "";

  return (
    <div style={containerStyle} data-testid="incidents-table">
      <div style={filterBarStyle}>
        <label style={{ display: "flex", alignItems: "center", gap: "6px", fontSize: "14px" }}>
          <input
            type="checkbox"
            checked={allTenants}
            onChange={(event) => onToggleAllTenants?.(event.target.checked)}
            aria-label="All tenants"
            data-testid="all-tenants-toggle"
          />
          All tenants
        </label>

        <select
          value={severityFilter}
          onChange={(event) => setSeverityFilter(event.target.value)}
          style={selectStyle}
          aria-label="Filter by severity"
          data-testid="filter-severity"
        >
          <option value="all">All severities</option>
          {INCIDENT_SEVERITIES.map((severity) => (
            <option key={severity} value={severity}>
              {severity}
            </option>
          ))}
        </select>

        <select
          value={statusFilter}
          onChange={(event) => setStatusFilter(event.target.value)}
          style={selectStyle}
          aria-label="Filter by status"
          data-testid="filter-status"
        >
          <option value="all">All statuses</option>
          {statuses.map((status) => (
            <option key={status} value={status.toLowerCase()}>
              {status}
            </option>
          ))}
        </select>

        <select
          value={classificationFilter}
          onChange={(event) => setClassificationFilter(event.target.value)}
          style={selectStyle}
          aria-label="Filter by classification"
          data-testid="filter-classification"
        >
          <option value="all">All classifications</option>
          {classifications.map((classification) => (
            <option key={classification} value={classification.toLowerCase()}>
              {classification}
            </option>
          ))}
        </select>

        <select
          value={assignedFilter}
          onChange={(event) => setAssignedFilter(event.target.value)}
          style={selectStyle}
          aria-label="Filter by assignee"
          data-testid="filter-assigned"
        >
          <option value="all">Anyone</option>
          <option value="unassigned">Unassigned</option>
          {assignees.map((assignee) => (
            <option key={assignee} value={assignee.toLowerCase()}>
              {assignee}
            </option>
          ))}
        </select>

        <select
          value={dateFilter}
          onChange={(event) => setDateFilter(event.target.value as IncidentDateRange)}
          style={selectStyle}
          aria-label="Filter by date"
          data-testid="filter-date"
        >
          <option value="all">Any date</option>
          <option value="24h">Last 24 hours</option>
          <option value="7d">Last 7 days</option>
          <option value="30d">Last 30 days</option>
        </select>

        <select
          value={tenantFilter}
          onChange={(event) => setTenantFilter(event.target.value)}
          style={selectStyle}
          aria-label="Filter by tenant"
          data-testid="filter-tenant"
        >
          <option value="all">All tenants</option>
          {tenants.map((tenant) => (
            <option key={tenant} value={tenant}>
              {tenant}
            </option>
          ))}
        </select>
      </div>

      <div style={{ display: "flex", flexWrap: "wrap", gap: "8px", alignItems: "center" }}>
        {INCIDENT_BULK_ACTIONS.map(({ action, label }) => {
          const disabled = selectedIncidents.length === 0;
          return (
            <button
              key={action}
              type="button"
              style={disabled ? disabledButtonStyle : buttonStyle}
              disabled={disabled}
              onClick={() => requestBulk(action)}
              data-testid={`bulk-${action}`}
            >
              {label} selected ({selectedIncidents.length})
            </button>
          );
        })}
      </div>

      {loading && (
        <div style={{ padding: "32px", textAlign: "center", color: "var(--text-soft)" }} data-testid="incidents-loading">
          Loading incidents...
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
          data-testid="incidents-error"
        >
          {error}
        </div>
      )}

      {!loading && !error && (
        <div style={tableWrapperStyle}>
          <table style={tableStyle} aria-label="Incidents">
            <thead>
              <tr>
                <th style={thStyle}>
                  <input
                    type="checkbox"
                    checked={allFilteredSelected}
                    onChange={toggleAllFiltered}
                    aria-label="Select all incidents"
                    data-testid="select-all-incidents"
                  />
                </th>
                <th style={thStyle}>Title</th>
                <th style={thStyle}>Severity</th>
                <th style={thStyle}>Status</th>
                <th style={thStyle}>Classification</th>
                <th style={thStyle}>Assigned to</th>
                <th style={thStyle}>Alerts</th>
                <th style={thStyle}>Last updated</th>
                <th style={thStyle}>Tenant</th>
                <th style={{ ...thStyle, textAlign: "right" }}>Actions</th>
              </tr>
            </thead>
            <tbody>
              {filtered.length === 0 && (
                <tr>
                  <td
                    style={{ ...tdStyle, textAlign: "center", color: "var(--text-soft)" }}
                    colSpan={10}
                    data-testid="incidents-empty"
                  >
                    No incidents match the current filters.
                  </td>
                </tr>
              )}
              {filtered.map((incident) => (
                <tr key={incident.id} data-testid={`incident-row-${incident.id}`}>
                  <td style={tdStyle}>
                    <input
                      type="checkbox"
                      checked={selected.includes(incident.id)}
                      onChange={() => toggleSelected(incident.id)}
                      aria-label={`Select ${incident.title}`}
                      data-testid={`select-incident-${incident.id}`}
                    />
                  </td>
                  <td style={tdStyle}>{incident.title}</td>
                  <td style={tdStyle}>
                    <span
                      className="sev-badge"
                      style={severityBadgeStyle(incident.severity)}
                      data-testid={`severity-${incident.id}`}
                    >
                      {incident.severity}
                    </span>
                  </td>
                  <td style={tdStyle}>
                    <span className="status-badge" style={statusBadgeStyle(incident.status)}>
                      {incident.status}
                    </span>
                  </td>
                  <td style={tdStyle}>{incident.classification || "—"}</td>
                  <td style={tdStyle}>{incident.assignedTo || "Unassigned"}</td>
                  <td style={tdStyle}>{incident.alertCount}</td>
                  <td style={tdStyle}>{formatTimestamp(incident.lastUpdated)}</td>
                  <td style={tdStyle}>{incident.tenantId}</td>
                  <td style={{ ...tdStyle, textAlign: "right" }}>
                    <div style={{ display: "inline-flex", gap: "6px", justifyContent: "flex-end", flexWrap: "wrap" }}>
                      {INCIDENT_ROW_ACTIONS.map(({ action, label }) => (
                        <button
                          key={action}
                          type="button"
                          style={actionBtnStyle}
                          onClick={() => onRowAction?.(action, incident)}
                          data-testid={`row-action-${action}-${incident.id}`}
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

      {pendingBulk !== null && (
        <div
          role="dialog"
          aria-modal="true"
          aria-label="Confirm bulk action"
          style={dialogStyle}
          data-testid="bulk-confirm-dialog"
        >
          <p style={{ margin: 0, fontSize: "14px" }}>
            {pendingLabel} {selectedIncidents.length} selected incident
            {selectedIncidents.length === 1 ? "" : "s"}? This cannot be undone.
          </p>
          <div style={{ display: "flex", gap: "8px", justifyContent: "flex-end" }}>
            <button
              type="button"
              style={buttonStyle}
              onClick={() => setPendingBulk(null)}
              data-testid="bulk-confirm-cancel"
            >
              Cancel
            </button>
            <button
              type="button"
              style={primaryButtonStyle}
              onClick={confirmBulk}
              data-testid="bulk-confirm-apply"
            >
              Confirm
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
