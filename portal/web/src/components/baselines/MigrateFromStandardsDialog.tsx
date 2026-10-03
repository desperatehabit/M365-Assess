"use client";

// Migrate from standards (EPIC-010 SPEC.md §3.2, §4.4; T-0189).
// Converts an EPIC-008 standards template into a staged baseline via
// `POST /v1/baselines/{templateId}/migrate-from-standards`. Drift templates are
// observe-only and are filtered out before this list (the server also rejects
// them). Zero colour literals: report theme tokens only.

import React, { type CSSProperties, type ReactElement } from "react";
import type { StandardTemplate } from "../../lib/standardsApi";

export interface MigrateFromStandardsDialogProps {
  readonly templates?: readonly StandardTemplate[];
  readonly loading?: boolean;
  readonly error?: string | null;
  readonly migratingId?: string | null;
  readonly onMigrate?: (template: StandardTemplate) => void;
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
  maxWidth: "680px",
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

const rowStyle: CSSProperties = {
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

export function MigrateFromStandardsDialog({
  templates = [],
  loading = false,
  error = null,
  migratingId = null,
  onMigrate,
  onClose,
}: MigrateFromStandardsDialogProps): ReactElement {
  const busy = migratingId !== null;

  return (
    <div style={overlayStyle} data-testid="migrate-dialog">
      <div style={dialogStyle} role="dialog" aria-modal="true" aria-label="Migrate from standards">
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <h2 style={{ margin: 0, fontSize: "16px" }}>Migrate from standards</h2>
          <button type="button" style={buttonStyle} onClick={onClose} disabled={busy} data-testid="migrate-close">
            Close
          </button>
        </div>

        <p style={metaStyle}>
          Converting a standards template copies its standards into one opening stage and carries its
          assignments over. The source template is left unchanged.
        </p>

        {loading && <div style={{ color: "var(--text-soft)" }} data-testid="migrate-loading">Loading templates…</div>}
        {error && (
          <div
            style={{ padding: "10px", background: "var(--danger-soft)", border: "1px solid var(--danger)", borderRadius: "6px", color: "var(--danger-text)" }}
            role="alert"
            data-testid="migrate-error"
          >
            {error}
          </div>
        )}

        {!loading && (
          <div style={resultsStyle} data-testid="migrate-results">
            {templates.length === 0 && !error && (
              <div style={{ color: "var(--text-soft)", padding: "16px" }} data-testid="migrate-empty">
                No standards templates are available to migrate.
              </div>
            )}
            {templates.map((template) => (
              <div key={template.id} style={rowStyle} data-testid={`migrate-template-${template.id}`}>
                <div>
                  <strong>{template.name}</strong>
                  <p style={metaStyle}>
                    {template.settings.length} standard{template.settings.length === 1 ? "" : "s"}
                  </p>
                </div>
                <button
                  type="button"
                  style={primaryButtonStyle}
                  disabled={busy}
                  onClick={() => onMigrate?.(template)}
                  data-testid={`migrate-use-${template.id}`}
                >
                  {migratingId === template.id ? "Migrating…" : "Migrate"}
                </button>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
