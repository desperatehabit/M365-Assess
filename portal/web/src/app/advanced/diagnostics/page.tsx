"use client";

// Advanced diagnostics page (EPIC-037 SPEC.md §3.5, §6, §7; T-0729). Wired to the
// T-0727 GET /v1/diagnostics report: container/worker health, cache status, and the
// system timers with their last/next run state. A 503 still carries the structured
// health payload, so it is rendered rather than treated as a transport failure.

import { useCallback, useEffect, useState, type CSSProperties, type ReactElement } from "react";

export const DIAGNOSTICS_API_PATH = "/v1/diagnostics";

export interface DiagnosticsHealth {
  readonly status: "healthy" | "degraded" | "unhealthy";
  readonly serviceVersion: string;
  readonly storage: {
    readonly reachable: boolean;
    readonly status: string;
    readonly schemaVersion?: number;
    readonly code?: string;
    readonly message?: string;
  };
  readonly queue: {
    readonly reachable: boolean;
    readonly status: string;
    readonly depth: number;
    readonly code?: string;
    readonly message?: string;
  };
  readonly queueDepth: number;
  readonly workerCount: number;
  readonly lastRunAt: string | null;
}

export interface DiagnosticsCacheStatus {
  readonly configured: boolean;
  readonly entries: number;
}

export interface DiagnosticsTimerState {
  readonly name: string;
  readonly cron: string;
  readonly type: string;
  readonly timezone: string;
  readonly command: string;
  readonly lastRunAt: string | null;
  readonly nextRunAt: string | null;
}

export interface DiagnosticsReport {
  readonly health: DiagnosticsHealth;
  readonly cache: DiagnosticsCacheStatus;
  readonly timers: readonly DiagnosticsTimerState[];
}

export async function loadDiagnostics(
  fetcher: typeof fetch = fetch,
): Promise<DiagnosticsReport> {
  const response = await fetcher(DIAGNOSTICS_API_PATH);
  if (!response.ok && response.status !== 503) {
    throw new Error(`Failed to load diagnostics (HTTP ${response.status})`);
  }
  return (await response.json()) as DiagnosticsReport;
}

const pageStyle: CSSProperties = {
  padding: "28px 40px",
  maxWidth: "1800px",
  color: "var(--text)",
  fontFamily: "var(--font-sans, system-ui, -apple-system, sans-serif)",
};

const breadcrumbStyle: CSSProperties = {
  fontSize: "12px",
  fontWeight: 600,
  letterSpacing: "0.08em",
  textTransform: "uppercase",
  color: "var(--muted)",
  marginBottom: "12px",
  fontFamily: "var(--font-mono, monospace)",
};

const headingStyle: CSSProperties = {
  fontSize: "24px",
  fontWeight: 700,
  marginBottom: "20px",
  color: "var(--text)",
};

const sectionStyle: CSSProperties = {
  marginBottom: "20px",
  padding: "16px",
  background: "var(--bg-elev)",
  border: "1px solid var(--border)",
  borderRadius: "var(--radius, 10px)",
};

const sectionHeadingStyle: CSSProperties = {
  margin: "0 0 12px 0",
  fontSize: "16px",
  color: "var(--text)",
};

const gridStyle: CSSProperties = {
  display: "grid",
  gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))",
  gap: "12px",
};

const labelStyle: CSSProperties = {
  fontSize: "11px",
  fontWeight: 600,
  letterSpacing: "0.08em",
  textTransform: "uppercase",
  color: "var(--muted)",
  fontFamily: "var(--font-mono, monospace)",
};

const valueStyle: CSSProperties = {
  fontSize: "14px",
  color: "var(--text)",
  fontFamily: "var(--font-mono, monospace)",
};

const tableStyle: CSSProperties = {
  width: "100%",
  borderCollapse: "collapse",
  fontSize: "13px",
};

const thStyle: CSSProperties = {
  textAlign: "left",
  padding: "8px",
  borderBottom: "1px solid var(--border-strong)",
  color: "var(--muted)",
  fontFamily: "var(--font-mono, monospace)",
  textTransform: "uppercase",
  fontSize: "11px",
};

const tdStyle: CSSProperties = {
  padding: "8px",
  borderBottom: "1px solid var(--border)",
  color: "var(--text)",
};

const healthColor = (status: DiagnosticsHealth["status"]): CSSProperties => {
  if (status === "healthy") return { color: "var(--success-text)", fontWeight: 600 };
  if (status === "degraded") return { color: "var(--warn-text)", fontWeight: 600 };
  return { color: "var(--danger-text)", fontWeight: 600 };
};

export default function AdvancedDiagnosticsPage(): ReactElement {
  const [report, setReport] = useState<DiagnosticsReport | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setReport(await loadDiagnostics());
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Failed to load diagnostics.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  return (
    <div style={pageStyle} data-testid="advanced-diagnostics-page">
      <div style={breadcrumbStyle}>CIPP &rarr; Advanced &rarr; Diagnostics</div>
      <h1 style={headingStyle}>Diagnostics</h1>

      {loading ? (
        <p data-testid="advanced-diagnostics-loading" style={{ color: "var(--muted)" }}>
          Loading diagnostics...
        </p>
      ) : null}
      {error !== null ? (
        <p role="alert" data-testid="advanced-diagnostics-error" style={{ color: "var(--danger-text)" }}>
          {error}
        </p>
      ) : null}

      {report !== null && !loading ? (
        <>
          <section style={sectionStyle} data-testid="diagnostics-health">
            <h2 style={sectionHeadingStyle}>Health</h2>
            <div style={gridStyle}>
              <div>
                <div style={labelStyle}>Status</div>
                <div style={{ ...valueStyle, ...healthColor(report.health.status) }}>
                  {report.health.status}
                </div>
              </div>
              <div>
                <div style={labelStyle}>Service version</div>
                <div style={valueStyle}>{report.health.serviceVersion}</div>
              </div>
              <div>
                <div style={labelStyle}>Storage</div>
                <div style={valueStyle}>
                  {report.health.storage.reachable
                    ? `Connected${report.health.storage.schemaVersion ? ` (v${report.health.storage.schemaVersion})` : ""}`
                    : `Down (${report.health.storage.code ?? "unknown"})`}
                </div>
              </div>
              <div>
                <div style={labelStyle}>Queue depth</div>
                <div style={valueStyle}>{report.health.queueDepth}</div>
              </div>
              <div>
                <div style={labelStyle}>Workers</div>
                <div style={valueStyle}>{report.health.workerCount}</div>
              </div>
              <div>
                <div style={labelStyle}>Last run</div>
                <div style={valueStyle}>{report.health.lastRunAt ?? "None"}</div>
              </div>
            </div>
          </section>

          <section style={sectionStyle} data-testid="diagnostics-cache">
            <h2 style={sectionHeadingStyle}>Cache</h2>
            <div style={gridStyle}>
              <div>
                <div style={labelStyle}>Configured</div>
                <div style={valueStyle}>{report.cache.configured ? "Yes" : "No"}</div>
              </div>
              <div>
                <div style={labelStyle}>Entries</div>
                <div style={valueStyle}>{report.cache.entries}</div>
              </div>
            </div>
          </section>

          <section style={sectionStyle} data-testid="diagnostics-timers">
            <h2 style={sectionHeadingStyle}>Timers</h2>
            <table style={tableStyle}>
              <thead>
                <tr>
                  <th style={thStyle}>Name</th>
                  <th style={thStyle}>Type</th>
                  <th style={thStyle}>Cron</th>
                  <th style={thStyle}>Last run</th>
                  <th style={thStyle}>Next run</th>
                </tr>
              </thead>
              <tbody>
                {report.timers.length === 0 ? (
                  <tr>
                    <td style={tdStyle} colSpan={5} data-testid="diagnostics-timers-empty">
                      No timers registered.
                    </td>
                  </tr>
                ) : (
                  report.timers.map((timer) => (
                    <tr key={timer.name} data-testid={`diagnostics-timer-${timer.name}`}>
                      <td style={tdStyle}>{timer.name}</td>
                      <td style={tdStyle}>{timer.type}</td>
                      <td style={tdStyle}>{timer.cron}</td>
                      <td style={tdStyle}>{timer.lastRunAt ?? "—"}</td>
                      <td style={tdStyle}>{timer.nextRunAt ?? "—"}</td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </section>

          <button type="button" data-testid="advanced-diagnostics-refresh" onClick={() => void refresh()}>
            Refresh
          </button>
        </>
      ) : null}
    </div>
  );
}
