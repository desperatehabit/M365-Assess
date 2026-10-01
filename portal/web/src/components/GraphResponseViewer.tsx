"use client";

// Graph Explorer response viewer (EPIC-040 SPEC.md §3.1; T-0782).
// Renders status, headers, duration, and collapsible formatted JSON.
// Zero colour literals: report theme tokens only.

import type { CSSProperties, ReactElement } from "react";

export interface GraphExplorerResponse {
  readonly status: number;
  readonly headers: Record<string, string>;
  readonly durationMs: number;
  readonly body: unknown;
}

export interface GraphResponseViewerProps {
  readonly response: GraphExplorerResponse | null;
  readonly loading: boolean;
  readonly error: string | null;
}

const viewerStyle: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: "12px",
  background: "var(--surface)",
  border: "1px solid var(--border)",
  borderRadius: "var(--radius, 10px)",
  padding: "20px",
};

const metaRowStyle: CSSProperties = {
  display: "flex",
  gap: "24px",
  flexWrap: "wrap",
  alignItems: "center",
};

const metaItemStyle: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: "2px",
};

const labelStyle: CSSProperties = {
  fontSize: "11px",
  fontWeight: 600,
  textTransform: "uppercase",
  letterSpacing: "0.08em",
  color: "var(--muted)",
  fontFamily: "var(--font-mono, monospace)",
};

const valueStyle: CSSProperties = {
  fontSize: "15px",
  fontWeight: 600,
  fontFamily: "var(--font-mono, monospace)",
  color: "var(--text)",
};

const headerListStyle: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: "4px",
  fontSize: "13px",
  fontFamily: "var(--font-mono, monospace)",
};

const headerRowStyle: CSSProperties = {
  display: "flex",
  gap: "8px",
};

const headerNameStyle: CSSProperties = {
  color: "var(--text-soft)",
  fontWeight: 600,
};

const headerValueStyle: CSSProperties = {
  color: "var(--text)",
  overflowWrap: "anywhere",
};

const jsonWrapStyle: CSSProperties = {
  border: "1px solid var(--border)",
  borderRadius: "6px",
  background: "var(--input-bg, var(--bg))",
  overflow: "auto",
};

const summaryStyle: CSSProperties = {
  cursor: "pointer",
  fontSize: "13px",
  fontWeight: 600,
  color: "var(--text-soft)",
  fontFamily: "var(--font-mono, monospace)",
  padding: "8px 12px",
};

const jsonPreStyle: CSSProperties = {
  margin: 0,
  padding: "12px",
  fontSize: "13px",
  fontFamily: "var(--font-mono, monospace)",
  color: "var(--text)",
  whiteSpace: "pre",
};

const errorBoxStyle: CSSProperties = {
  padding: "12px 16px",
  background: "var(--danger-soft)",
  border: "1px solid var(--danger-border)",
  borderRadius: "6px",
  color: "var(--danger-text)",
  fontSize: "14px",
};

const placeholderStyle: CSSProperties = {
  color: "var(--text-soft)",
  fontSize: "14px",
};

function statusColor(status: number): CSSProperties {
  if (status >= 200 && status < 300) return { color: "var(--success-text)" };
  if (status >= 300 && status < 400) return { color: "var(--text-soft)" };
  return { color: "var(--danger-text)" };
}

function formatJson(body: unknown): string {
  if (body === undefined) return "(no body)";
  try {
    return JSON.stringify(body, null, 2);
  } catch {
    return String(body);
  }
}

export function GraphResponseViewer({
  response,
  loading,
  error,
}: GraphResponseViewerProps): ReactElement {
  if (loading) {
    return (
      <div style={viewerStyle} data-testid="graph-response-viewer">
        <div style={valueStyle}>Running…</div>
      </div>
    );
  }

  if (error) {
    return (
      <div style={viewerStyle} data-testid="graph-response-viewer">
        <div style={errorBoxStyle} role="alert" data-testid="graph-response-error">
          {error}
        </div>
      </div>
    );
  }

  if (!response) {
    return (
      <div style={viewerStyle} data-testid="graph-response-viewer">
        <div style={placeholderStyle}>Run a request to see the response.</div>
      </div>
    );
  }

  return (
    <div style={viewerStyle} data-testid="graph-response-viewer">
      <div style={metaRowStyle}>
        <div style={metaItemStyle} data-testid="graph-response-status">
          <span style={labelStyle}>Status</span>
          <span style={{ ...valueStyle, ...statusColor(response.status) }}>{response.status}</span>
        </div>
        <div style={metaItemStyle} data-testid="graph-response-duration">
          <span style={labelStyle}>Duration</span>
          <span style={valueStyle}>{response.durationMs} ms</span>
        </div>
      </div>

      <div style={{ display: "flex", flexDirection: "column", gap: "4px" }}>
        <span style={labelStyle}>Headers</span>
        <div style={headerListStyle} data-testid="graph-response-headers">
          {Object.entries(response.headers).map(([name, value]) => (
            <div key={name} style={headerRowStyle}>
              <span style={headerNameStyle}>{name}:</span>
              <span style={headerValueStyle}>{value}</span>
            </div>
          ))}
        </div>
      </div>

      <div style={{ display: "flex", flexDirection: "column", gap: "4px" }}>
        <span style={labelStyle}>Body</span>
        <div style={jsonWrapStyle}>
          <details open data-testid="graph-response-body-details">
            <summary style={summaryStyle}>Formatted JSON</summary>
            <pre style={jsonPreStyle} data-testid="graph-response-body">
              {formatJson(response.body)}
            </pre>
          </details>
        </div>
      </div>
    </div>
  );
}
