"use client";

// PackReport component (EPIC-036 SPEC.md §3.1, §3.3; T-0709).
// Renders per-control results and the score for a compliance test pack run.
// Zero colour literals: report theme tokens only.

import React, { type CSSProperties, type ReactElement } from "react";

export type FindingStatus = "Pass" | "Fail" | "Warning" | "Error" | "Skip";

export interface TestRunResultItem {
  readonly findingId: string;
  readonly status: FindingStatus;
  readonly title?: string;
  readonly message?: string;
}

export interface PackReportData {
  readonly id: string;
  readonly packId: string;
  readonly tenantId: string;
  readonly at: string;
  readonly score: number | null;
  readonly results: readonly TestRunResultItem[];
}

export interface PackReportProps {
  readonly report: PackReportData;
  readonly packName?: string;
  readonly onBack?: () => void;
}

const containerStyle: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: "24px",
  width: "100%",
};

const headerCardStyle: CSSProperties = {
  padding: "24px",
  borderRadius: "var(--radius)",
  background: "var(--bg-elev)",
  border: "1px solid var(--border)",
  display: "flex",
  justifyContent: "space-between",
  alignItems: "center",
  flexWrap: "wrap",
  gap: "16px",
};

const scoreBoxStyle: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  alignItems: "center",
  justifyContent: "center",
  padding: "16px 24px",
  borderRadius: "var(--radius)",
  background: "var(--surface)",
  border: "1px solid var(--border)",
  minWidth: "120px",
};

const scoreValueStyle: CSSProperties = {
  fontSize: "36px",
  fontWeight: 700,
  color: "var(--accent-text)",
  lineHeight: 1,
};

const scoreLabelStyle: CSSProperties = {
  fontSize: "12px",
  color: "var(--muted)",
  marginTop: "4px",
  textTransform: "uppercase",
  letterSpacing: "0.05em",
};

const statsRowStyle: CSSProperties = {
  display: "flex",
  gap: "12px",
  flexWrap: "wrap",
};

const statChipStyle: CSSProperties = {
  padding: "6px 12px",
  borderRadius: "var(--radius)",
  background: "var(--chip)",
  color: "var(--text-soft)",
  fontSize: "13px",
  display: "flex",
  alignItems: "center",
  gap: "6px",
};

const tableWrapperStyle: CSSProperties = {
  overflowX: "auto",
  border: "1px solid var(--border)",
  borderRadius: "var(--radius)",
  background: "var(--bg-elev)",
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
  color: "var(--muted)",
  fontWeight: 600,
  background: "var(--bg-elev-2, var(--surface))",
};

const tdStyle: CSSProperties = {
  padding: "12px 16px",
  borderBottom: "1px solid var(--border)",
  color: "var(--text)",
  verticalAlign: "middle",
};

function getStatusBadgeStyle(status: FindingStatus): CSSProperties {
  switch (status) {
    case "Pass":
      return {
        padding: "4px 8px",
        borderRadius: "var(--radius)",
        fontSize: "12px",
        fontWeight: 600,
        background: "var(--success-soft)",
        color: "var(--success-text)",
        display: "inline-block",
      };
    case "Fail":
      return {
        padding: "4px 8px",
        borderRadius: "var(--radius)",
        fontSize: "12px",
        fontWeight: 600,
        background: "var(--danger-soft)",
        color: "var(--danger-text)",
        display: "inline-block",
      };
    case "Warning":
      return {
        padding: "4px 8px",
        borderRadius: "var(--radius)",
        fontSize: "12px",
        fontWeight: 600,
        background: "var(--warn-soft)",
        color: "var(--warn-text)",
        display: "inline-block",
      };
    default:
      return {
        padding: "4px 8px",
        borderRadius: "var(--radius)",
        fontSize: "12px",
        fontWeight: 600,
        background: "var(--chip)",
        color: "var(--muted)",
        display: "inline-block",
      };
  }
}

export function PackReport({
  report,
  packName,
  onBack,
}: PackReportProps): ReactElement {
  const { packId, tenantId, at, score, results } = report;

  const passedCount = results.filter((r) => r.status === "Pass").length;
  const failedCount = results.filter((r) => r.status === "Fail").length;
  const warningCount = results.filter((r) => r.status === "Warning").length;

  return (
    <div style={containerStyle} aria-label="Pack Report">
      {onBack && (
        <div>
          <button
            type="button"
            onClick={onBack}
            style={{
              padding: "6px 12px",
              borderRadius: "var(--radius)",
              background: "var(--surface)",
              color: "var(--text)",
              border: "1px solid var(--border)",
              cursor: "pointer",
            }}
          >
            ← Back to Packs
          </button>
        </div>
      )}

      <div style={headerCardStyle}>
        <div>
          <h2 style={{ margin: "0 0 8px 0", fontSize: "20px", color: "var(--text)" }}>
            {packName ? `${packName} Report` : `Pack Report: ${packId}`}
          </h2>
          <div style={{ color: "var(--muted)", fontSize: "13px" }}>
            Tenant: <strong>{tenantId}</strong> · Run at:{" "}
            {at ? new Date(at).toLocaleString() : "Unknown"} · Run ID: {report.id}
          </div>
          <div style={{ ...statsRowStyle, marginTop: "12px" }}>
            <span style={statChipStyle}>
              <strong style={{ color: "var(--success-text)" }}>{passedCount}</strong> Passed
            </span>
            <span style={statChipStyle}>
              <strong style={{ color: "var(--danger-text)" }}>{failedCount}</strong> Failed
            </span>
            {warningCount > 0 && (
              <span style={statChipStyle}>
                <strong style={{ color: "var(--warn-text)" }}>{warningCount}</strong> Warning
              </span>
            )}
            <span style={statChipStyle}>
              <strong>{results.length}</strong> Total Controls
            </span>
          </div>
        </div>

        <div style={scoreBoxStyle} aria-label="Pack Score">
          <div style={scoreValueStyle}>
            {score !== null && score !== undefined ? `${Math.round(score)}%` : "N/A"}
          </div>
          <div style={scoreLabelStyle}>Compliance Score</div>
        </div>
      </div>

      <div style={tableWrapperStyle}>
        <table style={tableStyle} aria-label="Per-control results">
          <thead>
            <tr>
              <th style={thStyle}>Control Reference</th>
              <th style={thStyle}>Status</th>
              <th style={thStyle}>Details</th>
            </tr>
          </thead>
          <tbody>
            {results.length === 0 ? (
              <tr>
                <td colSpan={3} style={{ ...tdStyle, textAlign: "center", color: "var(--muted)" }}>
                  No control results found in this report.
                </td>
              </tr>
            ) : (
              results.map((item, index) => (
                <tr key={item.findingId || index}>
                  <td style={tdStyle}>
                    <div style={{ fontWeight: 600 }}>{item.findingId}</div>
                    {item.title && (
                      <div style={{ fontSize: "12px", color: "var(--text-soft)" }}>
                        {item.title}
                      </div>
                    )}
                  </td>
                  <td style={tdStyle}>
                    <span style={getStatusBadgeStyle(item.status)}>{item.status}</span>
                  </td>
                  <td style={tdStyle}>
                    <span style={{ color: "var(--text-soft)" }}>
                      {item.message || "Evaluated by assessment engine."}
                    </span>
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
