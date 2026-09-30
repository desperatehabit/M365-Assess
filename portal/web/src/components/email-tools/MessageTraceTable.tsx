"use client";

// Message trace results table (EPIC-024 SPEC.md §2 US-1, §3.1, §4.1; T-0463).
// Renders the §3.1 results table (Timestamp · Sender · Recipient · Subject ·
// Status · Event) with the §3.1 row actions: View details links to the T-0464
// message viewer, Export CSV downloads the current result set client-side.
// Strictly uses report theme tokens with zero colour literals.

import React, { type CSSProperties, type ReactElement } from "react";

export interface MessageTraceRow {
  readonly timestamp: string;
  readonly sender: string;
  readonly recipient: string;
  readonly subject: string;
  readonly status: string;
  readonly event: string;
}

export interface MessageTraceTableProps {
  readonly items: readonly MessageTraceRow[];
  readonly loading?: boolean;
  readonly tenantId?: string;
}

const VIEWER_PATH = "/tools/email/message-viewer";

const tableStyle: CSSProperties = { width: "100%", borderCollapse: "collapse", fontSize: "13px" };

const thStyle: CSSProperties = {
  textAlign: "left",
  padding: "8px 10px",
  borderBottom: "1px solid var(--border-strong, var(--border))",
  color: "var(--text-soft)",
  fontSize: "12px",
  textTransform: "uppercase",
  letterSpacing: "0.07em",
};

const tdStyle: CSSProperties = {
  padding: "8px 10px",
  borderBottom: "1px solid var(--border)",
  verticalAlign: "top",
};

const monoCellStyle: CSSProperties = {
  ...tdStyle,
  fontFamily: "var(--font-mono, monospace)",
  fontSize: "12px",
};

const actionsStyle: CSSProperties = {
  display: "flex",
  gap: "8px",
  flexWrap: "wrap",
  alignItems: "center",
};

const linkStyle: CSSProperties = {
  padding: "6px 12px",
  background: "var(--surface)",
  border: "1px solid var(--border)",
  borderRadius: "6px",
  color: "var(--text)",
  fontSize: "13px",
  fontWeight: 500,
  textDecoration: "none",
  cursor: "pointer",
};

const buttonStyle: CSSProperties = { ...linkStyle };

function csvCell(value: string): string {
  return /[",\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

/** Renders the current result set as a CSV document (§3.1 columns). */
export function buildMessageTraceCsv(items: readonly MessageTraceRow[]): string {
  const header = ["Timestamp", "Sender", "Recipient", "Subject", "Status", "Event"];
  const rows = items.map((row) =>
    [row.timestamp, row.sender, row.recipient, row.subject, row.status, row.event]
      .map(csvCell)
      .join(","),
  );
  return [header.join(","), ...rows].join("\n");
}

function downloadMessageTraceCsv(items: readonly MessageTraceRow[]): void {
  const blob = new Blob([buildMessageTraceCsv(items)], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = "message-trace.csv";
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
}

function viewerHref(tenantId: string, row: MessageTraceRow): string {
  const params = new URLSearchParams();
  if (tenantId) params.set("tenantId", tenantId);
  for (const [key, value] of Object.entries(row)) {
    if (value) params.set(key, value);
  }
  return `${VIEWER_PATH}?${params.toString()}`;
}

export function MessageTraceTable({
  items,
  loading = false,
  tenantId = "",
}: MessageTraceTableProps): ReactElement {
  return (
    <div style={{ overflowX: "auto" }}>
      <table style={tableStyle} data-testid="message-trace-table">
        <thead>
          <tr>
            <th style={thStyle}>Timestamp</th>
            <th style={thStyle}>Sender</th>
            <th style={thStyle}>Recipient</th>
            <th style={thStyle}>Subject</th>
            <th style={thStyle}>Status</th>
            <th style={thStyle}>Event</th>
            <th style={thStyle}>Actions</th>
          </tr>
        </thead>
        <tbody>
          {loading === true ? (
            <tr>
              <td style={tdStyle} colSpan={7} data-testid="message-trace-loading">
                Loading message trace…
              </td>
            </tr>
          ) : items.length === 0 ? (
            <tr>
              <td style={tdStyle} colSpan={7} data-testid="message-trace-no-results">
                No messages matched the trace filter.
              </td>
            </tr>
          ) : (
            items.map((row, index) => (
              <tr key={index} data-testid={`message-trace-row-${index}`}>
                <td style={monoCellStyle}>{row.timestamp}</td>
                <td style={monoCellStyle}>{row.sender}</td>
                <td style={monoCellStyle}>{row.recipient}</td>
                <td style={tdStyle}>{row.subject}</td>
                <td style={tdStyle}>{row.status}</td>
                <td style={tdStyle}>{row.event}</td>
                <td style={tdStyle}>
                  <div style={actionsStyle}>
                    <a
                      href={viewerHref(tenantId, row)}
                      style={linkStyle}
                      data-testid={`message-trace-view-details-${index}`}
                    >
                      View details
                    </a>
                    <button
                      type="button"
                      style={buttonStyle}
                      onClick={() => downloadMessageTraceCsv(items)}
                      data-testid={`message-trace-export-csv-${index}`}
                    >
                      Export CSV
                    </button>
                  </div>
                </td>
              </tr>
            ))
          )}
        </tbody>
      </table>
    </div>
  );
}
