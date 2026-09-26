import type { CSSProperties, ReactElement } from "react";

export interface DiagnosticsStorageInfo {
  readonly reachable: boolean;
  readonly status: string;
  readonly schemaVersion?: number;
  readonly code?: string;
  readonly message?: string;
}

export interface DiagnosticsQueueInfo {
  readonly reachable: boolean;
  readonly status: string;
  readonly depth: number;
  readonly code?: string;
  readonly message?: string;
}

export interface DiagnosticsPayload {
  readonly status: "healthy" | "degraded" | "unhealthy";
  readonly serviceVersion: string;
  readonly storage: DiagnosticsStorageInfo;
  readonly queue?: DiagnosticsQueueInfo;
  readonly queueDepth: number;
  readonly workerCount: number;
  readonly lastRunAt: string | null;
}

export interface DiagnosticsCardProps {
  readonly data?: DiagnosticsPayload | null;
  readonly loading?: boolean;
  readonly error?: string | null;
  readonly onRefresh?: () => void;
}

const cardStyle: CSSProperties = {
  background: "var(--bg-elev)",
  border: "1px solid var(--border)",
  borderRadius: "var(--radius, 10px)",
  padding: "24px",
  color: "var(--text)",
  fontFamily: "var(--font-sans, system-ui, -apple-system, sans-serif)",
  boxShadow: "var(--shadow-card)",
  maxWidth: "720px",
  display: "flex",
  flexDirection: "column",
  gap: "20px",
};

const headerStyle: CSSProperties = {
  display: "flex",
  justifyContent: "space-between",
  alignItems: "center",
  borderBottom: "1px solid var(--border)",
  paddingBottom: "16px",
};

const titleStyle: CSSProperties = {
  fontSize: "18px",
  fontWeight: 600,
  color: "var(--text)",
  margin: 0,
};

const gridStyle: CSSProperties = {
  display: "grid",
  gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))",
  gap: "16px",
};

const fieldItemStyle: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: "4px",
};

const labelStyle: CSSProperties = {
  fontSize: "12px",
  fontWeight: 600,
  textTransform: "uppercase",
  letterSpacing: "0.08em",
  color: "var(--muted)",
  fontFamily: "var(--font-mono, monospace)",
};

const valueStyle: CSSProperties = {
  fontSize: "16px",
  fontWeight: 500,
  color: "var(--text)",
  fontFamily: "var(--font-mono, monospace)",
  fontVariantNumeric: "tabular-nums",
};

const buttonStyle: CSSProperties = {
  background: "var(--surface)",
  border: "1px solid var(--border)",
  borderRadius: "6px",
  color: "var(--text)",
  padding: "8px 16px",
  cursor: "pointer",
  fontFamily: "var(--font-sans, system-ui, -apple-system, sans-serif)",
  fontSize: "13px",
  fontWeight: 500,
  alignSelf: "flex-start",
};

const loadingStyle: CSSProperties = {
  padding: "24px",
  textAlign: "center",
  color: "var(--muted)",
  fontFamily: "var(--font-mono, monospace)",
  fontSize: "14px",
};

const errorStyle: CSSProperties = {
  padding: "16px",
  background: "var(--danger-soft)",
  border: "1px solid var(--border)",
  borderRadius: "6px",
  color: "var(--danger-text)",
  fontSize: "14px",
};

export default function DiagnosticsCard({
  data,
  loading = false,
  error = null,
  onRefresh,
}: DiagnosticsCardProps): ReactElement {
  if (loading) {
    return (
      <div className="card" style={cardStyle} data-testid="diagnostics-card" aria-busy="true">
        <div style={headerStyle}>
          <h2 style={titleStyle}>Service Diagnostics</h2>
          {onRefresh && (
            <button
              type="button"
              style={buttonStyle}
              onClick={onRefresh}
              data-testid="diagnostics-refresh"
              disabled
            >
              Refresh
            </button>
          )}
        </div>
        <div style={loadingStyle} data-testid="diagnostics-loading">
          Loading service diagnostics...
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="card" style={cardStyle} data-testid="diagnostics-card">
        <div style={headerStyle}>
          <h2 style={titleStyle}>Service Diagnostics</h2>
          {onRefresh && (
            <button
              type="button"
              style={buttonStyle}
              onClick={onRefresh}
              data-testid="diagnostics-refresh"
            >
              Refresh
            </button>
          )}
        </div>
        <div style={errorStyle} data-testid="diagnostics-error">
          {error}
        </div>
      </div>
    );
  }

  const storageStatusLabel = data?.storage?.reachable
    ? `Connected${data.storage.schemaVersion ? ` (v${data.storage.schemaVersion})` : ""}`
    : `Degraded (${data?.storage?.code ?? "down"})`;

  const storageColor = data?.storage?.reachable ? "var(--success)" : "var(--danger)";

  return (
    <div className="card" style={cardStyle} data-testid="diagnostics-card">
      <div style={headerStyle}>
        <h2 style={titleStyle}>Service Diagnostics</h2>
        {onRefresh && (
          <button
            type="button"
            style={buttonStyle}
            onClick={onRefresh}
            data-testid="diagnostics-refresh"
          >
            Refresh
          </button>
        )}
      </div>

      <div style={gridStyle}>
        <div style={fieldItemStyle} data-testid="field-service-version">
          <span style={labelStyle}>Service Version</span>
          <span style={valueStyle}>{data?.serviceVersion ?? "Unknown"}</span>
        </div>

        <div style={fieldItemStyle} data-testid="field-storage-status">
          <span style={labelStyle}>Storage Status</span>
          <span style={{ ...valueStyle, color: storageColor }}>{storageStatusLabel}</span>
        </div>

        <div style={fieldItemStyle} data-testid="field-queue-depth">
          <span style={labelStyle}>Queue Depth</span>
          <span style={valueStyle}>{data?.queueDepth ?? 0}</span>
        </div>

        <div style={fieldItemStyle} data-testid="field-worker-count">
          <span style={labelStyle}>Worker Count</span>
          <span style={valueStyle}>{data?.workerCount ?? 0}</span>
        </div>

        <div style={fieldItemStyle} data-testid="field-last-run">
          <span style={labelStyle}>Last Run</span>
          <span style={valueStyle}>{data?.lastRunAt ?? "None"}</span>
        </div>
      </div>
    </div>
  );
}
