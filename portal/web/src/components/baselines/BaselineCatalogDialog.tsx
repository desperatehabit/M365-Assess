"use client";

// Baseline catalog browser (EPIC-010 SPEC.md §3.2, §4.4; T-0190).
// Modal list of the local prebuilt baselines returned by
// `GET /v1/baselines/catalog`; each entry seeds a new baseline in the builder.
// The EPIC-039 community catalog is shown as unavailable until that epic lands.
// Zero colour literals: report theme tokens only.

import React, { type CSSProperties, type ReactElement } from "react";
import type { BaselineCatalog, BaselineCatalogEntry } from "../../lib/baselinesApi";

export interface BaselineCatalogDialogProps {
  readonly catalog?: BaselineCatalog | null;
  readonly loading?: boolean;
  readonly error?: string | null;
  readonly onUse?: (entry: BaselineCatalogEntry) => void;
  readonly onClose?: () => void;
}

const overlayStyle: CSSProperties = {
  position: "fixed",
  inset: 0,
  background: "var(--overlay, rgba(0,0,0,0.5))",
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  padding: "24px",
  zIndex: 50,
};

const dialogStyle: CSSProperties = {
  width: "100%",
  maxWidth: "720px",
  maxHeight: "85vh",
  display: "flex",
  flexDirection: "column",
  gap: "14px",
  padding: "20px",
  background: "var(--bg-elev)",
  border: "1px solid var(--border)",
  borderRadius: "var(--radius, 10px)",
  boxShadow: "var(--shadow-card)",
  fontFamily: "var(--font-sans, system-ui, sans-serif)",
  color: "var(--text)",
};

const buttonStyle: CSSProperties = {
  padding: "8px 14px",
  background: "var(--surface)",
  border: "1px solid var(--border)",
  borderRadius: "6px",
  color: "var(--text)",
  fontSize: "14px",
  fontWeight: 500,
  cursor: "pointer",
};

const primaryButtonStyle: CSSProperties = {
  ...buttonStyle,
  background: "var(--accent)",
  color: "var(--on-accent)",
  borderColor: "var(--accent)",
};

const resultsStyle: CSSProperties = {
  overflowY: "auto",
  display: "flex",
  flexDirection: "column",
  gap: "8px",
  minHeight: "120px",
};

const entryStyle: CSSProperties = {
  display: "flex",
  justifyContent: "space-between",
  alignItems: "center",
  gap: "12px",
  padding: "12px 14px",
  background: "var(--surface)",
  border: "1px solid var(--border)",
  borderRadius: "6px",
};

const metaStyle: CSSProperties = {
  fontSize: "12px",
  color: "var(--text-soft)",
  margin: "4px 0 0",
};

function standardCount(entry: BaselineCatalogEntry): number {
  return entry.stages.reduce((count, stage) => count + stage.conditions.length, 0);
}

export function BaselineCatalogDialog({
  catalog = null,
  loading = false,
  error = null,
  onUse,
  onClose,
}: BaselineCatalogDialogProps): ReactElement {
  const entries = catalog?.entries ?? [];

  return (
    <div style={overlayStyle} data-testid="baseline-catalog-dialog">
      <div style={dialogStyle} role="dialog" aria-modal="true" aria-label="Browse baseline catalog">
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <h2 style={{ margin: 0, fontSize: "16px" }}>Browse baseline catalog</h2>
          <button type="button" style={buttonStyle} onClick={onClose} data-testid="catalog-close">
            Close
          </button>
        </div>

        {catalog && !catalog.community.available && (
          <p style={metaStyle} data-testid="catalog-community-note">
            {catalog.community.reason}
          </p>
        )}

        {loading && <div style={{ color: "var(--text-soft)" }} data-testid="catalog-loading">Loading catalog…</div>}
        {error && (
          <div
            style={{ padding: "10px", background: "var(--danger-soft)", border: "1px solid var(--danger)", borderRadius: "6px", color: "var(--danger-text)" }}
            role="alert"
            data-testid="catalog-error"
          >
            {error}
          </div>
        )}

        {!loading && !error && (
          <div style={resultsStyle} data-testid="catalog-results">
            {entries.length === 0 && (
              <div style={{ color: "var(--text-soft)", padding: "16px" }} data-testid="catalog-empty">
                No prebuilt baselines are available.
              </div>
            )}
            {entries.map((entry) => (
              <div key={entry.id} style={entryStyle} data-testid={`catalog-entry-${entry.id}`}>
                <div>
                  <strong>{entry.name}</strong>
                  <p style={metaStyle}>
                    {entry.description || "No description."} · {entry.stages.length} stage
                    {entry.stages.length === 1 ? "" : "s"} · {standardCount(entry)} standard
                    {standardCount(entry) === 1 ? "" : "s"}
                  </p>
                </div>
                <button
                  type="button"
                  style={primaryButtonStyle}
                  onClick={() => onUse?.(entry)}
                  data-testid={`catalog-use-${entry.id}`}
                >
                  Use baseline
                </button>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
