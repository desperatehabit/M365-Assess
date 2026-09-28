"use client";

// KeyReveal — time-limited key/credential display (EPIC-018 SPEC.md §3.4; T-0350).
// Shows a Reveal action, copies via an explicit button, and auto-hides after
// the configured window with a visible countdown. The value is never persisted
// client-side.
import React, { useState, useEffect, useRef, type CSSProperties } from "react";

export interface KeyRevealProps {
  readonly keyValue: string;
  readonly revealWindowSec?: number;
  readonly label?: string;
}

const containerStyle: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: "8px",
  padding: "12px 16px",
  background: "var(--bg-elev, #f9fafb)",
  border: "1px solid var(--border, #e5e7eb)",
  borderRadius: "8px",
};

const valueStyle: CSSProperties = {
  fontFamily: "monospace",
  fontSize: "14px",
  color: "var(--text, #111827)",
  wordBreak: "break-all",
  padding: "8px 12px",
  background: "var(--bg, #ffffff)",
  border: "1px solid var(--border, #e5e7eb)",
  borderRadius: "6px",
};

const buttonStyle: CSSProperties = {
  padding: "6px 12px",
  fontSize: "12px",
  border: "1px solid var(--border, #e5e7eb)",
  borderRadius: "4px",
  background: "var(--bg, #ffffff)",
  color: "var(--text, #111827)",
  cursor: "pointer",
};

const countdownStyle: CSSProperties = {
  fontSize: "12px",
  color: "var(--text-muted, #6b7280)",
};

export function KeyReveal({ keyValue, revealWindowSec = 30, label = "Key" }: KeyRevealProps) {
  const [revealed, setRevealed] = useState(false);
  const [countdown, setCountdown] = useState(revealWindowSec);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    if (!revealed) return;

    setCountdown(revealWindowSec);
    timerRef.current = setInterval(() => {
      setCountdown((prev) => {
        if (prev <= 1) {
          setRevealed(false);
          if (timerRef.current) clearInterval(timerRef.current);
          return 0;
        }
        return prev - 1;
      });
    }, 1000);

    return () => {
      if (timerRef.current) clearInterval(timerRef.current);
    };
  }, [revealed, revealWindowSec]);

  function handleReveal() {
    setRevealed(true);
  }

  function handleCopy() {
    void navigator.clipboard.writeText(keyValue);
  }

  function handleHide() {
    setRevealed(false);
    if (timerRef.current) clearInterval(timerRef.current);
  }

  return (
    <div style={containerStyle}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <span style={{ fontSize: "13px", fontWeight: 600 }}>{label}</span>
        {!revealed ? (
          <button style={buttonStyle} onClick={handleReveal}>
            Reveal
          </button>
        ) : (
          <div style={{ display: "flex", gap: "8px", alignItems: "center" }}>
            <span style={countdownStyle}>{countdown}s</span>
            <button style={buttonStyle} onClick={handleCopy}>
              Copy
            </button>
            <button style={buttonStyle} onClick={handleHide}>
              Hide
            </button>
          </div>
        )}
      </div>
      {revealed && <div style={valueStyle}>{keyValue}</div>}
    </div>
  );
}
