"use client";

// DeploymentStatusTable — Intune → Autopilot & Enrollment → Status Pages (EPIC-017 SPEC.md §2 US-7, §3.5, §3.6; T-0330).
// Per-device state for app deployments and enrollment profiles from
// GET /v1/tenants/{id}/apps/status. Tabs pick the view; summary chips count each state over the
// whole filtered set (and filter by it when clicked); state, platform, and search filters go to
// the API. Kit tokens only.
import React, { useCallback, useEffect, useState, type CSSProperties } from "react";

export type StatusView = "all" | "apps" | "enrollment";

export interface AppStatusRow {
  readonly kind: "app";
  readonly deviceId: string;
  readonly deviceName: string | null;
  readonly userPrincipalName: string | null;
  readonly platform: string | null;
  readonly appId: string;
  readonly appName: string;
  readonly state: string;
  readonly rawState: string | null;
  readonly errorCode: string | null;
  readonly lastSyncDateTime: string | null;
}

export interface EnrollmentStatusRow {
  readonly kind: "enrollment";
  readonly deviceId: string | null;
  readonly serialNumber: string | null;
  readonly deviceName: string | null;
  readonly source: string;
  readonly platform: string | null;
  readonly profileName: string | null;
  readonly state: string;
  readonly rawState: string | null;
  readonly lastContactedDateTime: string | null;
}

export type StatusRow = AppStatusRow | EnrollmentStatusRow;

export interface StatusPage {
  readonly view: StatusView;
  readonly summary: { apps?: Record<string, number>; enrollment?: Record<string, number> };
  readonly totalCount: number;
  readonly items: readonly StatusRow[];
  readonly nextCursor: string | null;
}

export interface StatusQuery {
  readonly view: StatusView;
  readonly state?: string;
  readonly platform?: string;
  readonly search?: string;
  readonly cursor?: string;
}

export async function fetchDeploymentStatus(tenantId: string, query: StatusQuery, baseUrl = ""): Promise<StatusPage> {
  const params = new URLSearchParams({ view: query.view });
  if (query.state) params.set("state", query.state);
  if (query.platform) params.set("platform", query.platform);
  if (query.search) params.set("search", query.search);
  if (query.cursor) params.set("cursor", query.cursor);
  const res = await fetch(`${baseUrl}/v1/tenants/${encodeURIComponent(tenantId)}/apps/status?${params.toString()}`);
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { message?: string };
    throw new Error(body.message || `Failed to load status: HTTP ${res.status}`);
  }
  return (await res.json()) as StatusPage;
}

const STATE_LABELS: Record<string, string> = {
  installed: "Installed",
  failed: "Failed",
  pending: "Pending",
  notInstalled: "Not installed",
  notApplicable: "Not applicable",
  enrolled: "Enrolled",
  notContacted: "Not contacted",
  blocked: "Blocked",
  unknown: "Unknown",
};

const SOURCE_LABELS: Record<string, string> = {
  autopilot: "Autopilot",
  "apple-ade": "Apple ADE",
  "android-enterprise": "Android Enterprise",
};

function tone(state: string): CSSProperties {
  if (state === "installed" || state === "enrolled") return { background: "var(--success-soft)", color: "var(--success-text)" };
  if (state === "failed" || state === "blocked") return { background: "var(--danger-soft)", color: "var(--danger-text)" };
  if (state === "pending" || state === "notContacted") return { background: "var(--warn-soft)", color: "var(--warn-text)" };
  return { background: "var(--chip)", color: "var(--muted)" };
}

const cellStyle: CSSProperties = { padding: "9px 12px", borderBottom: "1px solid var(--border)", textAlign: "left", fontSize: "13px", verticalAlign: "top" };
const headStyle: CSSProperties = { ...cellStyle, background: "var(--bg-elev)", fontSize: "12px", textTransform: "uppercase", letterSpacing: "0.05em", color: "var(--muted)" };
const inputStyle: CSSProperties = { padding: "6px 10px", border: "1px solid var(--border)", borderRadius: "6px", fontSize: "13px", background: "var(--input-bg, var(--bg))", color: "var(--text)" };
const badge = (state: string): CSSProperties => ({ ...tone(state), padding: "2px 8px", borderRadius: "999px", fontSize: "12px", fontWeight: 600, whiteSpace: "nowrap" });

function formatTime(value: string | null): string {
  if (!value) return "—";
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? value : new Date(parsed).toLocaleString();
}

export interface DeploymentStatusTableProps {
  readonly rows: readonly StatusRow[];
}

/** The per-device table; app and enrollment rows share Device and State columns. */
export function DeploymentStatusTable({ rows }: DeploymentStatusTableProps) {
  return (
    <table aria-label="Device status" style={{ width: "100%", borderCollapse: "collapse", background: "var(--bg)", border: "1px solid var(--border)" }}>
      <thead>
        <tr>
          <th style={headStyle}>Device</th>
          <th style={headStyle}>Kind</th>
          <th style={headStyle}>App or profile</th>
          <th style={headStyle}>State</th>
          <th style={headStyle}>Detail</th>
          <th style={headStyle}>Last seen</th>
        </tr>
      </thead>
      <tbody>
        {rows.length === 0 ? (
          <tr>
            <td colSpan={6} style={{ ...cellStyle, textAlign: "center", color: "var(--muted)" }}>
              No devices match.
            </td>
          </tr>
        ) : (
          rows.map((row, i) => (
            <tr key={`${row.kind}-${row.deviceId ?? (row.kind === "enrollment" ? row.serialNumber : "")}-${row.kind === "app" ? row.appId : row.source}-${i}`} data-testid={`status-row-${i}`}>
              <td style={cellStyle}>
                <div style={{ fontWeight: 500 }}>{row.deviceName ?? (row.kind === "enrollment" ? row.serialNumber : null) ?? row.deviceId ?? "—"}</div>
                <div style={{ fontSize: "12px", color: "var(--muted)" }}>
                  {row.kind === "app" ? (row.userPrincipalName ?? "") : row.serialNumber && row.deviceName ? row.serialNumber : ""}
                </div>
              </td>
              <td style={cellStyle}>{row.kind === "app" ? "App deployment" : `Enrollment · ${SOURCE_LABELS[row.source] ?? row.source}`}</td>
              <td style={cellStyle}>{row.kind === "app" ? row.appName : (row.profileName ?? "—")}</td>
              <td style={cellStyle}>
                <span style={badge(row.state)} title={row.rawState ?? undefined}>
                  {STATE_LABELS[row.state] ?? row.state}
                </span>
              </td>
              <td style={{ ...cellStyle, fontFamily: row.kind === "app" && row.errorCode ? "var(--font-mono)" : undefined }}>
                {row.kind === "app" ? (row.errorCode ?? "—") : (row.platform ?? "—")}
              </td>
              <td style={cellStyle}>{formatTime(row.kind === "app" ? row.lastSyncDateTime : row.lastContactedDateTime)}</td>
            </tr>
          ))
        )}
      </tbody>
    </table>
  );
}

function SummaryChips({
  label,
  counts,
  active,
  onPick,
}: {
  label: string;
  counts: Record<string, number>;
  active: string;
  onPick: (state: string) => void;
}) {
  return (
    <div role="group" aria-label={`${label} summary`} style={{ display: "flex", gap: "6px", alignItems: "center", flexWrap: "wrap" }}>
      <span style={{ fontSize: "12px", color: "var(--muted)", marginRight: "4px" }}>{label}</span>
      {Object.entries(counts).map(([state, count]) => (
        <button
          key={state}
          type="button"
          aria-pressed={active === state}
          onClick={() => onPick(active === state ? "" : state)}
          style={{ ...badge(state), border: active === state ? "1px solid var(--accent-border)" : "1px solid transparent", cursor: "pointer" }}
        >
          {STATE_LABELS[state] ?? state}: {count}
        </button>
      ))}
    </div>
  );
}

export interface DeploymentStatusPageProps {
  readonly tenantId: string;
  readonly load?: (tenantId: string, query: StatusQuery) => Promise<StatusPage>;
}

const TABS: readonly { view: StatusView; label: string }[] = [
  { view: "all", label: "All" },
  { view: "apps", label: "App deployments" },
  { view: "enrollment", label: "Enrollment" },
];

export function DeploymentStatusPage({ tenantId, load = fetchDeploymentStatus }: DeploymentStatusPageProps) {
  const [view, setView] = useState<StatusView>("all");
  const [state, setState] = useState("");
  const [platform, setPlatform] = useState("");
  const [search, setSearch] = useState("");
  const [page, setPage] = useState<StatusPage | null>(null);
  const [cursors, setCursors] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const cursor = cursors.at(-1);
  const run = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setPage(
        await load(tenantId, {
          view,
          ...(state ? { state } : {}),
          ...(platform ? { platform } : {}),
          ...(search.trim() ? { search: search.trim() } : {}),
          ...(cursor ? { cursor } : {}),
        }),
      );
    } catch (err: unknown) {
      setPage(null);
      setError(err instanceof Error ? err.message : "Failed to load status.");
    } finally {
      setLoading(false);
    }
  }, [load, tenantId, view, state, platform, search, cursor]);

  useEffect(() => {
    void run();
  }, [run]);

  const resetPaging = () => setCursors([]);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "12px", color: "var(--text)" }}>
      <div role="tablist" aria-label="Status view" style={{ display: "flex", gap: "4px" }}>
        {TABS.map((t) => (
          <button
            key={t.view}
            role="tab"
            type="button"
            aria-selected={view === t.view}
            onClick={() => {
              setView(t.view);
              setState("");
              resetPaging();
            }}
            style={{
              padding: "6px 14px",
              borderRadius: "6px",
              border: "1px solid var(--border)",
              background: view === t.view ? "var(--accent-soft)" : "var(--bg)",
              color: view === t.view ? "var(--accent-text)" : "var(--text)",
              cursor: "pointer",
              fontSize: "13px",
            }}
          >
            {t.label}
          </button>
        ))}
      </div>

      {page && (
        <div style={{ display: "flex", flexDirection: "column", gap: "6px" }}>
          {page.summary.apps && (
            <SummaryChips label="App deployments" counts={page.summary.apps} active={state} onPick={(s) => { setState(s); resetPaging(); }} />
          )}
          {page.summary.enrollment && (
            <SummaryChips label="Enrollment" counts={page.summary.enrollment} active={state} onPick={(s) => { setState(s); resetPaging(); }} />
          )}
        </div>
      )}

      <div style={{ display: "flex", gap: "8px", flexWrap: "wrap" }}>
        <input
          type="search"
          aria-label="Search devices"
          placeholder="Search device, serial, user, app…"
          style={inputStyle}
          value={search}
          onChange={(e) => {
            setSearch(e.target.value);
            resetPaging();
          }}
        />
        <select aria-label="Filter by platform" style={inputStyle} value={platform} onChange={(e) => { setPlatform(e.target.value); resetPaging(); }}>
          <option value="">All platforms</option>
          <option value="windows">Windows</option>
          <option value="ios">iOS</option>
          <option value="macos">macOS</option>
          <option value="android">Android</option>
        </select>
        {state && (
          <button type="button" style={{ ...inputStyle, cursor: "pointer" }} onClick={() => { setState(""); resetPaging(); }}>
            Clear state: {STATE_LABELS[state] ?? state}
          </button>
        )}
      </div>

      {error && (
        <div role="alert" style={{ padding: "10px 14px", background: "var(--danger-soft)", color: "var(--danger-text)", borderRadius: "8px" }}>
          {error}
        </div>
      )}
      {loading && !page && <div style={{ color: "var(--muted)" }}>Loading status…</div>}
      {page && <DeploymentStatusTable rows={page.items} />}
      {page && (
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", fontSize: "12px", color: "var(--muted)" }}>
          <span>{page.totalCount} device rows</span>
          <span style={{ display: "flex", gap: "6px" }}>
            <button type="button" style={{ ...inputStyle, cursor: "pointer" }} disabled={cursors.length === 0} onClick={() => setCursors((c) => c.slice(0, -1))}>
              Previous
            </button>
            <button type="button" style={{ ...inputStyle, cursor: "pointer" }} disabled={!page.nextCursor} onClick={() => page.nextCursor && setCursors((c) => [...c, page.nextCursor!])}>
              Next
            </button>
          </span>
        </div>
      )}
    </div>
  );
}
