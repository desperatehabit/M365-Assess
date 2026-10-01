"use client";

// Incident detail tabs (EPIC-028 SPEC.md §2 US-2, §3.2; T-0547).
// Renders the five §3.2 tabs against the T-0545 detail API:
// Overview (severity, status, classification, assignee), Alerts (linked,
// T-0542-normalized), Entities (users/devices/mailboxes involved), Timeline
// (events + comments), and Notes (portal comments). Presentational only: it
// performs no fetches and no writes. Report theme tokens only, zero colour
// literals.

import React, { useState, type CSSProperties, type ReactElement } from "react";

export type IncidentTabId = "overview" | "alerts" | "entities" | "timeline" | "notes";

export const INCIDENT_TABS: ReadonlyArray<{ id: IncidentTabId; label: string }> = [
  { id: "overview", label: "Overview" },
  { id: "alerts", label: "Alerts" },
  { id: "entities", label: "Entities" },
  { id: "timeline", label: "Timeline" },
  { id: "notes", label: "Notes" },
];

// Mirrors the T-0545 GET /v1/tenants/:tenantId/incidents/:incidentId result.
export interface IncidentOverview {
  readonly incidentId: string;
  readonly title: string;
  readonly severity: string;
  readonly status: string;
  readonly classification: string;
  readonly assignee: string;
  readonly created: string;
  readonly lastUpdated: string;
  readonly webUrl: string;
}

export interface IncidentAlertEntity {
  readonly kind: string;
  readonly id?: string;
  readonly displayName?: string;
}

export interface IncidentAlert {
  readonly schemaVersion: string;
  readonly id: string;
  readonly source: string;
  readonly title: string;
  readonly severity: string;
  readonly status: string;
  readonly entity: IncidentAlertEntity | null;
  readonly created: string;
  readonly incidentId: string;
  readonly passthrough: Record<string, unknown>;
}

export interface IncidentEntity {
  readonly kind: string;
  readonly id?: string;
  readonly displayName?: string;
  readonly alertIds: readonly string[];
}

export interface IncidentTimelineEvent {
  readonly at: string;
  readonly type: string;
  readonly summary: string;
  readonly actor?: string;
  readonly ref?: string;
}

export interface IncidentNote {
  readonly id: string;
  readonly body: string;
  readonly author?: string;
  readonly at: string;
}

export interface IncidentDetailData {
  readonly tenantId: string;
  readonly incidentId: string;
  readonly overview: IncidentOverview;
  readonly alerts: readonly IncidentAlert[];
  readonly entities: readonly IncidentEntity[];
  readonly timeline: readonly IncidentTimelineEvent[];
  readonly notes: readonly IncidentNote[];
  readonly retrievedAt: string;
}

export interface IncidentTabsProps {
  readonly detail: IncidentDetailData;
  readonly activeTab?: IncidentTabId;
  readonly onTabChange?: (tab: IncidentTabId) => void;
  readonly defaultTab?: IncidentTabId;
}

const containerStyle: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: "16px",
  fontFamily: "var(--font-sans, system-ui, sans-serif)",
  color: "var(--text)",
};

const tabBarStyle: CSSProperties = {
  display: "flex",
  flexWrap: "wrap",
  gap: "4px",
  borderBottom: "1px solid var(--border)",
};

function tabStyle(active: boolean): CSSProperties {
  return {
    padding: "10px 16px",
    background: "transparent",
    border: "none",
    borderBottom: active ? "2px solid var(--accent)" : "2px solid transparent",
    color: active ? "var(--accent-text)" : "var(--text-soft)",
    fontSize: "14px",
    fontWeight: active ? 600 : 400,
    cursor: "pointer",
  };
}

const panelStyle: CSSProperties = {
  background: "var(--bg-elev)",
  border: "1px solid var(--border)",
  borderRadius: "var(--radius, 10px)",
  padding: "16px",
  fontSize: "14px",
  display: "flex",
  flexDirection: "column",
  gap: "12px",
};

const gridStyle: CSSProperties = {
  display: "grid",
  gridTemplateColumns: "repeat(auto-fill, minmax(220px, 1fr))",
  gap: "12px",
};

const labelStyle: CSSProperties = {
  fontSize: "12px",
  fontWeight: 600,
  textTransform: "uppercase",
  letterSpacing: "0.05em",
  color: "var(--text-soft)",
  marginBottom: "4px",
};

const valueStyle: CSSProperties = {
  fontSize: "14px",
  color: "var(--text)",
  wordBreak: "break-word",
};

const tableStyle: CSSProperties = {
  width: "100%",
  borderCollapse: "collapse",
  fontSize: "13px",
};

const thStyle: CSSProperties = {
  textAlign: "left",
  padding: "8px 10px",
  borderBottom: "1px solid var(--border)",
  color: "var(--text-soft)",
  fontWeight: 600,
};

const tdStyle: CSSProperties = {
  padding: "8px 10px",
  borderBottom: "1px solid var(--border)",
  verticalAlign: "top",
};

const emptyStyle: CSSProperties = {
  padding: "24px",
  textAlign: "center",
  color: "var(--muted)",
  border: "1px dashed var(--border)",
  borderRadius: "var(--radius, 8px)",
};

const listStyle: CSSProperties = {
  listStyle: "none",
  padding: 0,
  margin: 0,
  display: "flex",
  flexDirection: "column",
  gap: "10px",
};

const listItemStyle: CSSProperties = {
  padding: "10px 12px",
  background: "var(--surface)",
  border: "1px solid var(--border)",
  borderRadius: "var(--radius, 8px)",
};

export function formatIncidentTime(value?: string | null): string {
  if (!value) return "—";
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime())
    ? value
    : parsed.toLocaleString(undefined, {
        year: "numeric",
        month: "short",
        day: "numeric",
        hour: "2-digit",
        minute: "2-digit",
      });
}

export function incidentSeverityClass(
  severity: string,
): "critical" | "high" | "medium" | "low" | "none" {
  switch (severity.toLowerCase()) {
    case "critical":
      return "critical";
    case "high":
      return "high";
    case "medium":
      return "medium";
    case "low":
      return "low";
    default:
      return "none";
  }
}

function statusBadgeStyle(status: string): CSSProperties {
  const normalized = status.trim().toLowerCase();
  if (normalized === "resolved" || normalized === "closed") {
    return {
      background: "var(--success-soft)",
      color: "var(--success-text)",
      border: "1px solid var(--success)",
    };
  }
  if (normalized === "inprogress" || normalized === "in progress" || normalized === "active") {
    return {
      background: "var(--accent-soft)",
      color: "var(--accent-text)",
      border: "1px solid var(--accent)",
    };
  }
  return {
    background: "var(--warn-soft)",
    color: "var(--warn-text)",
    border: "1px solid var(--warn)",
  };
}

function badgeBase(): CSSProperties {
  return {
    display: "inline-flex",
    alignItems: "center",
    padding: "2px 8px",
    borderRadius: "999px",
    fontSize: "12px",
    fontWeight: 600,
    textTransform: "capitalize",
  };
}

export function IncidentSeverityBadge({
  severity,
  testId = "incident-severity-badge",
}: {
  readonly severity: string;
  readonly testId?: string;
}): ReactElement {
  const level = incidentSeverityClass(severity);
  return (
    <span
      className={`sev-badge ${level}`}
      data-testid={testId}
      data-severity={level}
      style={{ color: "var(--text-soft)", fontSize: "12px", fontWeight: 600 }}
    >
      <span className="bar" aria-hidden="true">
        <i />
        <i />
        <i />
        <i />
      </span>
      {severity}
    </span>
  );
}

function OverviewPanel({ overview }: { readonly overview: IncidentOverview }): ReactElement {
  return (
    <div style={panelStyle} role="tabpanel" id="incident-tabpanel-overview" data-testid="incident-tabpanel-overview">
      <div style={gridStyle}>
        <div>
          <div style={labelStyle}>Severity</div>
          <div style={valueStyle}>
            <IncidentSeverityBadge severity={overview.severity} testId="incident-overview-severity" />
          </div>
        </div>
        <div>
          <div style={labelStyle}>Status</div>
          <div style={valueStyle}>
            <span className="status-badge" data-testid="incident-overview-status" style={{ ...badgeBase(), ...statusBadgeStyle(overview.status) }}>
              {overview.status}
            </span>
          </div>
        </div>
        <div>
          <div style={labelStyle}>Classification</div>
          <div style={valueStyle} data-testid="incident-overview-classification">
            {overview.classification || "—"}
          </div>
        </div>
        <div>
          <div style={labelStyle}>Assigned to</div>
          <div style={valueStyle} data-testid="incident-overview-assignee">
            {overview.assignee || "Unassigned"}
          </div>
        </div>
        <div>
          <div style={labelStyle}>Created</div>
          <div style={valueStyle}>{formatIncidentTime(overview.created)}</div>
        </div>
        <div>
          <div style={labelStyle}>Last updated</div>
          <div style={valueStyle}>{formatIncidentTime(overview.lastUpdated)}</div>
        </div>
      </div>
      {overview.webUrl && (
        <a
          href={overview.webUrl}
          target="_blank"
          rel="noreferrer"
          data-testid="incident-overview-weburl"
          style={{ color: "var(--accent-text)", fontSize: "13px" }}
        >
          Open in Microsoft 365 Defender
        </a>
      )}
    </div>
  );
}

function AlertsPanel({ alerts }: { readonly alerts: readonly IncidentAlert[] }): ReactElement {
  if (alerts.length === 0) {
    return (
      <div style={panelStyle} role="tabpanel" id="incident-tabpanel-alerts" data-testid="incident-tabpanel-alerts">
        <div style={emptyStyle} data-testid="incident-alerts-empty">
          No alerts are linked to this incident.
        </div>
      </div>
    );
  }
  return (
    <div style={panelStyle} role="tabpanel" id="incident-tabpanel-alerts" data-testid="incident-tabpanel-alerts">
      <table style={tableStyle} data-testid="incident-alerts-table">
        <thead>
          <tr>
            <th style={thStyle}>Title</th>
            <th style={thStyle}>Source</th>
            <th style={thStyle}>Severity</th>
            <th style={thStyle}>Status</th>
            <th style={thStyle}>Entity</th>
          </tr>
        </thead>
        <tbody>
          {alerts.map((alert) => (
            <tr key={alert.id} data-testid={`incident-alert-${alert.id}`}>
              <td style={tdStyle}>{alert.title}</td>
              <td style={tdStyle}>{alert.source}</td>
              <td style={tdStyle}>
                <IncidentSeverityBadge severity={alert.severity} testId={`incident-alert-severity-${alert.id}`} />
              </td>
              <td style={tdStyle}>{alert.status}</td>
              <td style={tdStyle}>
                {alert.entity
                  ? `${alert.entity.kind}: ${alert.entity.displayName ?? alert.entity.id ?? "—"}`
                  : "—"}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function EntitiesPanel({ entities }: { readonly entities: readonly IncidentEntity[] }): ReactElement {
  if (entities.length === 0) {
    return (
      <div style={panelStyle} role="tabpanel" id="incident-tabpanel-entities" data-testid="incident-tabpanel-entities">
        <div style={emptyStyle} data-testid="incident-entities-empty">
          No users, devices, or mailboxes are linked to this incident.
        </div>
      </div>
    );
  }
  return (
    <div style={panelStyle} role="tabpanel" id="incident-tabpanel-entities" data-testid="incident-tabpanel-entities">
      <ul style={listStyle}>
        {entities.map((entity, index) => (
          <li
            key={entity.id ?? `${entity.kind}-${index}`}
            style={listItemStyle}
            data-testid={`incident-entity-${entity.id ?? index}`}
          >
            <div style={{ fontWeight: 600 }}>{entity.displayName ?? entity.id ?? "Unknown"}</div>
            <div style={{ color: "var(--text-soft)", fontSize: "12px" }}>
              {entity.kind} · {entity.alertIds.length} linked alert{entity.alertIds.length === 1 ? "" : "s"}
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}

function TimelinePanel({ timeline }: { readonly timeline: readonly IncidentTimelineEvent[] }): ReactElement {
  if (timeline.length === 0) {
    return (
      <div style={panelStyle} role="tabpanel" id="incident-tabpanel-timeline" data-testid="incident-tabpanel-timeline">
        <div style={emptyStyle} data-testid="incident-timeline-empty">
          No timeline events recorded.
        </div>
      </div>
    );
  }
  return (
    <div style={panelStyle} role="tabpanel" id="incident-tabpanel-timeline" data-testid="incident-tabpanel-timeline">
      <ul style={listStyle}>
        {timeline.map((event, index) => (
          <li
            key={event.ref ?? `${event.at}-${index}`}
            style={listItemStyle}
            data-testid={`incident-timeline-event-${index}`}
          >
            <div style={{ display: "flex", justifyContent: "space-between", gap: "12px" }}>
              <span style={{ fontWeight: 600 }}>{event.summary}</span>
              <span style={{ color: "var(--muted)", fontSize: "12px", whiteSpace: "nowrap" }}>
                {formatIncidentTime(event.at)}
              </span>
            </div>
            <div style={{ color: "var(--text-soft)", fontSize: "12px" }}>
              {event.type}
              {event.actor ? ` · ${event.actor}` : ""}
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}

function NotesPanel({ notes }: { readonly notes: readonly IncidentNote[] }): ReactElement {
  if (notes.length === 0) {
    return (
      <div style={panelStyle} role="tabpanel" id="incident-tabpanel-notes" data-testid="incident-tabpanel-notes">
        <div style={emptyStyle} data-testid="incident-notes-empty">
          No portal notes yet.
        </div>
      </div>
    );
  }
  return (
    <div style={panelStyle} role="tabpanel" id="incident-tabpanel-notes" data-testid="incident-tabpanel-notes">
      <ul style={listStyle} data-testid="incident-notes-list">
        {notes.map((note) => (
          <li key={note.id} style={listItemStyle} data-testid={`incident-note-${note.id}`}>
            <div style={{ whiteSpace: "pre-wrap" }}>{note.body}</div>
            <div style={{ color: "var(--muted)", fontSize: "12px", marginTop: "4px" }}>
              {note.author ?? "Unknown"} · {formatIncidentTime(note.at)}
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}

export function IncidentTabs({
  detail,
  activeTab,
  onTabChange,
  defaultTab = "overview",
}: IncidentTabsProps): ReactElement {
  const [internalTab, setInternalTab] = useState<IncidentTabId>(defaultTab);
  const tab = activeTab ?? internalTab;

  function select(next: IncidentTabId): void {
    setInternalTab(next);
    onTabChange?.(next);
  }

  return (
    <div style={containerStyle} data-testid="incident-tabs">
      <nav style={tabBarStyle} aria-label="Incident detail tabs" role="tablist">
        {INCIDENT_TABS.map((entry) => (
          <button
            key={entry.id}
            type="button"
            role="tab"
            aria-selected={tab === entry.id}
            aria-controls={`incident-tabpanel-${entry.id}`}
            style={tabStyle(tab === entry.id)}
            onClick={() => select(entry.id)}
            data-testid={`incident-tab-${entry.id}`}
          >
            {entry.label}
          </button>
        ))}
      </nav>

      {tab === "overview" && <OverviewPanel overview={detail.overview} />}
      {tab === "alerts" && <AlertsPanel alerts={detail.alerts} />}
      {tab === "entities" && <EntitiesPanel entities={detail.entities} />}
      {tab === "timeline" && <TimelinePanel timeline={detail.timeline} />}
      {tab === "notes" && <NotesPanel notes={detail.notes} />}
    </div>
  );
}
