"use client";

// Persistent shell banner displayed across every portal route whenever system-wide
// demo mode is explicitly active (T-0892). Uses report theme tokens exclusively.

import React, { useEffect, useState, type CSSProperties, type ReactElement } from "react";
import { useDemoMode } from "./DemoProvider";

const bannerStyle: CSSProperties = {
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  gap: "12px",
  flexWrap: "wrap",
  padding: "10px 16px",
  marginTop: "12px",
  marginBottom: "12px",
  background: "var(--warn-soft)",
  border: "1px solid var(--warn)",
  borderRadius: "var(--radius, 8px)",
  color: "var(--warn-text)",
  fontSize: "13px",
  fontWeight: 600,
  fontFamily: "var(--font-sans, system-ui, sans-serif)",
};

const messageWrapStyle: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: "8px",
};

const exitButtonStyle: CSSProperties = {
  padding: "5px 12px",
  background: "var(--surface)",
  color: "var(--text)",
  border: "1px solid var(--border)",
  borderRadius: "var(--radius, 6px)",
  fontSize: "12px",
  fontWeight: 600,
  cursor: "pointer",
  fontFamily: "var(--font-sans, system-ui, sans-serif)",
};

export function DemoBanner(): ReactElement | null {
  const { enabled, setEnabled } = useDemoMode();
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    setMounted(true);
  }, []);

  if (!mounted || !enabled) {
    return null;
  }

  return (
    <div style={bannerStyle} role="status" data-testid="demo-banner">
      <div style={messageWrapStyle}>
        <span aria-hidden="true">⚠</span>
        <span>Demo data active — Simulated tenant data is displayed; writes are not persisted.</span>
      </div>
      <button
        type="button"
        data-testid="exit-demo-mode-button"
        onClick={() => setEnabled(false)}
        style={exitButtonStyle}
      >
        Exit demo mode
      </button>
    </div>
  );
}
