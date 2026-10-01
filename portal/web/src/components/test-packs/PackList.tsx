"use client";

// PackList component (EPIC-036 SPEC.md §3.1, §4.1; T-0709).
// Renders the available Compliance Test Packs with description, check count,
// and row actions: Run, View report, and Configure.
// Zero colour literals: report theme tokens only.

import React, { type CSSProperties, type ReactElement } from "react";

export interface TestPackItem {
  readonly id: string;
  readonly name: string;
  readonly description?: string;
  readonly frameworkId?: string;
  readonly checks: readonly string[];
}

export interface PackListProps {
  readonly packs: readonly TestPackItem[];
  readonly onRun?: (pack: TestPackItem) => void;
  readonly onViewReport?: (pack: TestPackItem) => void;
  readonly onConfigure?: (pack: TestPackItem) => void;
  readonly runningPackId?: string | null;
}

const containerStyle: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: "16px",
  width: "100%",
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

const buttonStyle: CSSProperties = {
  padding: "6px 12px",
  borderRadius: "var(--radius)",
  border: "1px solid var(--border)",
  background: "var(--surface)",
  color: "var(--text)",
  cursor: "pointer",
  fontSize: "13px",
  fontWeight: 500,
  transition: "background 0.15s ease",
};

const primaryButtonStyle: CSSProperties = {
  ...buttonStyle,
  background: "var(--accent)",
  color: "var(--accent-text)",
  borderColor: "var(--accent-border, var(--accent))",
};

const actionGroupStyle: CSSProperties = {
  display: "flex",
  gap: "8px",
  alignItems: "center",
};

const checkCountBadgeStyle: CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  padding: "2px 8px",
  borderRadius: "var(--radius)",
  background: "var(--chip)",
  color: "var(--text-soft)",
  fontSize: "12px",
  fontWeight: 600,
};

export function PackList({
  packs,
  onRun,
  onViewReport,
  onConfigure,
  runningPackId,
}: PackListProps): ReactElement {
  if (packs.length === 0) {
    return (
      <div
        style={{
          padding: "32px",
          textAlign: "center",
          color: "var(--muted)",
          border: "1px dashed var(--border)",
          borderRadius: "var(--radius)",
          background: "var(--bg-elev)",
        }}
      >
        No compliance test packs available.
      </div>
    );
  }

  return (
    <div style={containerStyle}>
      <div style={tableWrapperStyle}>
        <table style={tableStyle} aria-label="Compliance Test Packs">
          <thead>
            <tr>
              <th style={thStyle}>Pack Name</th>
              <th style={thStyle}>Description</th>
              <th style={thStyle}>Checks</th>
              <th style={thStyle}>Actions</th>
            </tr>
          </thead>
          <tbody>
            {packs.map((pack) => {
              const isRunning = runningPackId === pack.id;
              const checkCount = pack.checks?.length ?? 0;

              return (
                <tr key={pack.id}>
                  <td style={tdStyle}>
                    <div style={{ fontWeight: 600 }}>{pack.name}</div>
                    <div style={{ fontSize: "12px", color: "var(--muted)" }}>{pack.id}</div>
                  </td>
                  <td style={tdStyle}>
                    <span style={{ color: "var(--text-soft)" }}>
                      {pack.description || "No description provided."}
                    </span>
                  </td>
                  <td style={tdStyle}>
                    <span style={checkCountBadgeStyle}>
                      {checkCount} {checkCount === 1 ? "check" : "checks"}
                    </span>
                  </td>
                  <td style={tdStyle}>
                    <div style={actionGroupStyle}>
                      <button
                        type="button"
                        style={primaryButtonStyle}
                        disabled={isRunning}
                        onClick={() => onRun?.(pack)}
                        aria-label={`Run ${pack.name}`}
                      >
                        {isRunning ? "Running..." : "Run"}
                      </button>
                      <button
                        type="button"
                        style={buttonStyle}
                        onClick={() => onViewReport?.(pack)}
                        aria-label={`View report for ${pack.name}`}
                      >
                        View report
                      </button>
                      <button
                        type="button"
                        style={buttonStyle}
                        onClick={() => onConfigure?.(pack)}
                        aria-label={`Configure ${pack.name}`}
                      >
                        Configure
                      </button>
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
