"use client";

// DeviceActionHistory — append-only action history list (EPIC-018 SPEC.md §3.2, §5; T-0349).
// Shows the device's action history newest first with actor, reason, and result.
import React, { type CSSProperties } from "react";
import type { DeviceAction } from "../../lib/deviceApi";

export interface DeviceActionHistoryProps {
  readonly actions: readonly DeviceAction[];
  readonly loading?: boolean;
  readonly error?: string | null;
}

const listStyle: CSSProperties = {
  listStyle: "none",
  padding: 0,
  margin: 0,
};

const listItemStyle: CSSProperties = {
  padding: "12px 0",
  borderBottom: "1px solid var(--border, #e5e7eb)",
};

const actionStyle: CSSProperties = {
  fontSize: "14px",
  fontWeight: 600,
  color: "var(--text, #111827)",
  textTransform: "capitalize",
};

const metaStyle: CSSProperties = {
  fontSize: "13px",
  color: "var(--text-muted, #6b7280)",
  marginTop: "4px",
};

const stateBadgeStyle: CSSProperties = {
  display: "inline-block",
  padding: "2px 8px",
  borderRadius: "4px",
  fontSize: "11px",
  fontWeight: 600,
  textTransform: "uppercase",
  marginLeft: "8px",
};

function formatDate(dt: string): string {
  if (!dt) return "";
  const d = new Date(dt);
  return Number.isNaN(d.getTime())
    ? dt
    : d.toLocaleString(undefined, { year: "numeric", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

function stateColor(state: string): string {
  switch (state) {
    case "applied":
      return "#065f46";
    case "pending-approval":
      return "#92400e";
    case "failed":
      return "#991b1b";
    default:
      return "#374151";
  }
}

function stateBg(state: string): string {
  switch (state) {
    case "applied":
      return "#d1fae5";
    case "pending-approval":
      return "#fef3c7";
    case "failed":
      return "#fee2e2";
    default:
      return "#f3f4f6";
  }
}

export function DeviceActionHistory({ actions, loading = false, error = null }: DeviceActionHistoryProps) {
  if (error) {
    return (
      <div
        role="alert"
        style={{
          padding: "12px 16px",
          background: "#fef2f2",
          border: "1px solid #fca5a5",
          borderRadius: "8px",
          color: "#b91c1c",
        }}
      >
        {error}
      </div>
    );
  }

  if (loading) {
    return <div style={{ padding: "24px", textAlign: "center" }}>Loading action history…</div>;
  }

  if (actions.length === 0) {
    return <div style={{ padding: "24px", textAlign: "center", color: "var(--text-muted, #6b7280)" }}>No action history.</div>;
  }

  return (
    <ul style={listStyle}>
      {actions.map((action) => (
        <li key={action.id} style={listItemStyle}>
          <div>
            <span style={actionStyle}>{action.action}</span>
            <span
              style={{
                ...stateBadgeStyle,
                color: stateColor(action.state),
                background: stateBg(action.state),
              }}
            >
              {action.state}
            </span>
          </div>
          <div style={metaStyle}>
            {formatDate(action.appliedAt)} — by {action.appliedBy}
            {action.reason && <span> — {action.reason}</span>}
          </div>
        </li>
      ))}
    </ul>
  );
}
