"use client";

// Historical search results (EPIC-024 SPEC.md §2 US-2, §3.2, §4.1, §7; T-0466).
// Renders the §3.2 results surface for one T-0465 job: a live progress
// indicator with a cancel action while the job is queued/running, the
// matching-messages list once it succeeds, and terminal notices for cancelled
// and failed jobs. The download affordance renders only for callers holding
// the download permission (SPEC §7) and only when the job carries a
// downloadRef; it downloads the ephemeral matches client-side. Strictly uses
// report theme tokens with zero colour literals.

import React, { type CSSProperties, type ReactElement } from "react";
import { PermissionGate } from "../PermissionGate";

export const HISTORICAL_SEARCH_DOWNLOAD_PERMISSION = "Exchange.MailSearchResults.Read";

export interface HistoricalSearchJob {
  readonly id: string;
  readonly tenantId: string;
  readonly searchName: string;
  readonly state: "queued" | "running" | "succeeded" | "failed" | "cancelled";
  readonly progressPercent?: number;
  readonly createdBy?: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface HistoricalSearchMatch {
  readonly mailbox: string;
  readonly subject: string;
  readonly receivedAt: string;
  readonly sizeBytes?: number | null;
}

export interface HistoricalSearchResult {
  readonly job: HistoricalSearchJob;
  readonly matches: readonly HistoricalSearchMatch[];
  readonly totalCount: number;
  readonly downloadRef?: string;
}

export interface HistoricalSearchResultsProps {
  readonly result: HistoricalSearchResult | null;
  readonly loading: boolean;
  readonly onCancel: () => void;
}

const sectionStyle: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: "12px",
};

const panelStyle: CSSProperties = {
  padding: "16px",
  background: "var(--bg-elev)",
  border: "1px solid var(--border)",
  borderRadius: "var(--radius, 10px)",
};

const statusStyle: CSSProperties = {
  fontSize: "13px",
  color: "var(--text-soft)",
};

const progressTrackStyle: CSSProperties = {
  height: "8px",
  background: "var(--surface)",
  border: "1px solid var(--border)",
  borderRadius: "var(--radius, 10px)",
  overflow: "hidden",
};

function progressFillStyle(percent: number): CSSProperties {
  const clamped = Math.max(0, Math.min(100, percent));
  return {
    height: "100%",
    width: `${clamped}%`,
    background: "var(--accent)",
    transition: "width 200ms ease",
  };
}

const cancelStyle: CSSProperties = {
  padding: "8px 14px",
  background: "var(--surface)",
  border: "1px solid var(--border)",
  borderRadius: "6px",
  color: "var(--text)",
  fontSize: "13px",
  fontWeight: 500,
  cursor: "pointer",
};

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

const downloadStyle: CSSProperties = {
  padding: "8px 14px",
  background: "var(--accent)",
  border: "1px solid var(--accent)",
  borderRadius: "6px",
  color: "var(--on-accent)",
  fontSize: "13px",
  fontWeight: 500,
  cursor: "pointer",
};

const noticeStyle: CSSProperties = {
  padding: "12px 16px",
  borderRadius: "6px",
  background: "var(--warn-soft)",
  border: "1px solid var(--warn)",
  color: "var(--warn-text)",
  fontSize: "14px",
};

const failureStyle: CSSProperties = {
  padding: "12px 16px",
  borderRadius: "6px",
  background: "var(--danger-soft)",
  border: "1px solid var(--danger)",
  color: "var(--danger-text)",
  fontSize: "14px",
};

function csvCell(value: string): string {
  return /[",\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

/** Renders the ephemeral matches as a CSV document (§3.2 columns). */
export function buildHistoricalSearchCsv(matches: readonly HistoricalSearchMatch[]): string {
  const header = ["Mailbox", "Subject", "Received At", "Size (bytes)"];
  const rows = matches.map((match) =>
    [match.mailbox, match.subject, match.receivedAt, match.sizeBytes?.toString() ?? ""]
      .map(csvCell)
      .join(","),
  );
  return [header.join(","), ...rows].join("\n");
}

function downloadHistoricalSearchCsv(matches: readonly HistoricalSearchMatch[]): void {
  const blob = new Blob([buildHistoricalSearchCsv(matches)], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = "historical-search.csv";
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
}

export function HistoricalSearchResults({
  result,
  loading,
  onCancel,
}: HistoricalSearchResultsProps): ReactElement {
  const job = result?.job ?? null;
  const inProgress = loading === true;
  const succeeded = job?.state === "succeeded";
  const downloadRef = succeeded ? result?.downloadRef : undefined;
  const percent = typeof job?.progressPercent === "number" ? job.progressPercent : 0;

  return (
    <div style={sectionStyle} data-testid="historical-search-results">
      {inProgress && (
        <div style={panelStyle} data-testid="historical-search-progress">
          <div style={statusStyle} data-testid="historical-search-state">
            {job === null || job.state === "queued"
              ? "Search queued…"
              : `Search running… ${percent}%`}
          </div>
          <div
            style={progressTrackStyle}
            role="progressbar"
            aria-valuenow={percent}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-label="Search progress"
            data-testid="historical-search-progress-bar"
          >
            <div style={progressFillStyle(percent)} />
          </div>
          <div style={actionsStyle}>
            <button
              type="button"
              style={cancelStyle}
              onClick={onCancel}
              data-testid="historical-search-cancel"
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      {succeeded && (
        <div style={panelStyle} data-testid="historical-search-matches">
          <div style={statusStyle} data-testid="historical-search-total">
            {result?.totalCount ?? 0} matching message(s)
          </div>
          <div style={{ overflowX: "auto" }}>
            <table style={tableStyle} data-testid="historical-search-table">
              <thead>
                <tr>
                  <th style={thStyle}>Mailbox</th>
                  <th style={thStyle}>Subject</th>
                  <th style={thStyle}>Received</th>
                  <th style={thStyle}>Size</th>
                </tr>
              </thead>
              <tbody>
                {(result?.matches ?? []).length === 0 ? (
                  <tr>
                    <td style={tdStyle} colSpan={4} data-testid="historical-search-no-results">
                      No messages matched the search.
                    </td>
                  </tr>
                ) : (
                  (result?.matches ?? []).map((match, index) => (
                    <tr key={index} data-testid={`historical-search-row-${index}`}>
                      <td style={monoCellStyle}>{match.mailbox}</td>
                      <td style={tdStyle}>{match.subject}</td>
                      <td style={monoCellStyle}>{match.receivedAt}</td>
                      <td style={monoCellStyle}>{match.sizeBytes?.toString() ?? "—"}</td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
          {downloadRef !== undefined && (
            <div style={actionsStyle}>
              <PermissionGate permission={HISTORICAL_SEARCH_DOWNLOAD_PERMISSION}>
                <button
                  type="button"
                  style={downloadStyle}
                  onClick={() => downloadHistoricalSearchCsv(result?.matches ?? [])}
                  data-testid="historical-search-download"
                >
                  Download CSV
                </button>
              </PermissionGate>
            </div>
          )}
        </div>
      )}

      {job?.state === "cancelled" && (
        <div style={noticeStyle} role="status" data-testid="historical-search-cancelled">
          The search was cancelled.
        </div>
      )}

      {job?.state === "failed" && (
        <div style={failureStyle} role="alert" data-testid="historical-search-failed">
          The search failed. Start a new search to try again.
        </div>
      )}
    </div>
  );
}
