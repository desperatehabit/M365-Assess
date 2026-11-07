"use client";

// Persistent indicator shown whenever the dashboard renders demo data
// (EPIC-004 SPEC.md §3.5, §11.1; T-0891). Demo mode is opt-in only, and this
// banner makes the fabricated payload impossible to mistake for live data.

import React, { type CSSProperties, type ReactElement } from "react";

const bannerStyle: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: "10px",
  padding: "10px 14px",
  background: "var(--warning-soft)",
  border: "1px solid var(--warning)",
  borderRadius: "var(--radius, 8px)",
  color: "var(--warning-text)",
  fontSize: "13px",
  fontWeight: 600,
};

export function DemoDataBanner(): ReactElement {
  return (
    <div style={bannerStyle} role="status" data-testid="demo-data-banner">
      <span aria-hidden="true">⚠</span>
      <span>Demo data — the values on this page are sample placeholders, not live tenant data.</span>
    </div>
  );
}
