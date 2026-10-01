"use client";

// Add community repo dialog (EPIC-039 SPEC.md §3.2; T-0763).
// Accepts a URL or owner/repo reference, the template types the repo provides,
// and the user/org install scope (the GitHub integration that consumes the scope
// is deferred, SPEC §11.1). The parent owns the API call; this component only
// collects and validates the form.

import React, { useState, type CSSProperties, type ReactElement } from "react";
import { TEMPLATE_TYPE_CHIPS } from "./TemplateRepoCard";

export interface AddRepoInput {
  readonly ref: string;
  readonly types: readonly string[];
  readonly scope: "user" | "org";
}

export interface AddRepoDialogProps {
  readonly open?: boolean;
  readonly busy?: boolean;
  readonly error?: string | null;
  readonly onClose?: () => void;
  readonly onSubmit?: (input: AddRepoInput) => void | Promise<void>;
}

const overlayStyle: CSSProperties = {
  position: "fixed",
  top: 0,
  left: 0,
  right: 0,
  bottom: 0,
  background: "var(--overlay-bg, var(--overlay))",
  backdropFilter: "blur(4px)",
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  zIndex: 1000,
  padding: "16px",
};

const dialogStyle: CSSProperties = {
  background: "var(--bg-elev)",
  border: "1px solid var(--border)",
  borderRadius: "var(--radius, 12px)",
  boxShadow: "var(--shadow-lg, var(--shadow-card))",
  width: "100%",
  maxWidth: "560px",
  maxHeight: "90vh",
  display: "flex",
  flexDirection: "column",
  fontFamily: "var(--font-sans, system-ui, sans-serif)",
  color: "var(--text)",
  overflow: "hidden",
};

const headerStyle: CSSProperties = {
  padding: "20px 24px",
  borderBottom: "1px solid var(--border)",
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
};

const bodyStyle: CSSProperties = {
  padding: "24px",
  overflowY: "auto",
  display: "flex",
  flexDirection: "column",
  gap: "20px",
  flex: 1,
};

const footerStyle: CSSProperties = {
  padding: "16px 24px",
  borderTop: "1px solid var(--border)",
  display: "flex",
  alignItems: "center",
  justifyContent: "flex-end",
  gap: "8px",
  background: "var(--surface)",
};

const buttonStyle: CSSProperties = {
  padding: "8px 16px",
  borderRadius: "6px",
  border: "1px solid var(--border)",
  background: "var(--surface)",
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

const fieldStyle: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: "6px",
};

const labelStyle: CSSProperties = {
  fontSize: "13px",
  fontWeight: 600,
};

const inputStyle: CSSProperties = {
  padding: "8px 12px",
  background: "var(--input-bg, var(--bg))",
  border: "1px solid var(--border)",
  borderRadius: "6px",
  color: "var(--text)",
  fontSize: "14px",
};

const chipGridStyle: CSSProperties = {
  display: "grid",
  gridTemplateColumns: "repeat(auto-fill, minmax(160px, 1fr))",
  gap: "8px",
};

const chipStyle = (selected: boolean): CSSProperties => ({
  display: "flex",
  alignItems: "center",
  gap: "8px",
  padding: "8px 10px",
  borderRadius: "6px",
  border: selected ? "1px solid var(--accent)" : "1px solid var(--border)",
  background: selected ? "var(--accent-soft)" : "var(--surface)",
  cursor: "pointer",
  fontSize: "13px",
});

const errorStyle: CSSProperties = {
  padding: "10px 14px",
  background: "var(--danger-soft)",
  border: "1px solid var(--danger)",
  borderRadius: "6px",
  color: "var(--danger-text)",
  fontSize: "13px",
};

const hintStyle: CSSProperties = {
  fontSize: "12px",
  color: "var(--text-soft)",
};

export function AddRepoDialog({
  open = true,
  busy = false,
  error = null,
  onClose,
  onSubmit,
}: AddRepoDialogProps): ReactElement | null {
  const [ref, setRef] = useState("");
  const [types, setTypes] = useState<string[]>([]);
  const [scope, setScope] = useState<"user" | "org">("org");
  const [validationError, setValidationError] = useState<string | null>(null);

  if (!open) return null;

  const toggleType = (value: string): void => {
    setTypes((current) => (current.includes(value) ? current.filter((t) => t !== value) : [...current, value]));
  };

  const handleSubmit = async (): Promise<void> => {
    if (busy) return;
    if (!ref.trim()) {
      setValidationError("Enter a repository URL or owner/repo.");
      return;
    }
    setValidationError(null);
    await onSubmit?.({ ref: ref.trim(), types, scope });
  };

  return (
    <div style={overlayStyle} data-testid="add-repo-dialog-overlay" role="dialog" aria-modal="true">
      <div style={dialogStyle} data-testid="add-repo-dialog">
        <div style={headerStyle}>
          <h2 style={{ margin: 0, fontSize: "18px", fontWeight: 600 }}>Add repo</h2>
          {onClose && (
            <button
              type="button"
              onClick={onClose}
              style={{ ...buttonStyle, border: "none", fontSize: "20px", padding: "4px 8px" }}
              aria-label="Close dialog"
              data-testid="add-repo-close"
            >
              ×
            </button>
          )}
        </div>

        <div style={bodyStyle}>
          <div style={fieldStyle}>
            <label style={labelStyle} htmlFor="add-repo-ref">
              Repository URL or owner/repo
            </label>
            <input
              id="add-repo-ref"
              type="text"
              value={ref}
              onChange={(e) => setRef(e.target.value)}
              placeholder="https://github.com/owner/repo or owner/repo"
              style={inputStyle}
              data-testid="add-repo-ref-input"
            />
            <span style={hintStyle}>A full URL or the owner/repo shorthand.</span>
          </div>

          <div style={fieldStyle}>
            <span style={labelStyle}>Template types</span>
            <div style={chipGridStyle}>
              {TEMPLATE_TYPE_CHIPS.map((chip) => {
                const selected = types.includes(chip.value);
                return (
                  <label key={chip.value} style={chipStyle(selected)} data-testid={`add-repo-type-${chip.value}`}>
                    <input
                      type="checkbox"
                      checked={selected}
                      onChange={() => toggleType(chip.value)}
                      style={{ cursor: "pointer" }}
                    />
                    {chip.label}
                  </label>
                );
              })}
            </div>
          </div>

          <div style={fieldStyle}>
            <span style={labelStyle}>Install scope</span>
            <div style={{ display: "flex", gap: "8px" }}>
              {(["user", "org"] as const).map((option) => (
                <label key={option} style={chipStyle(scope === option)} data-testid={`add-repo-scope-${option}`}>
                  <input
                    type="radio"
                    name="add-repo-scope"
                    checked={scope === option}
                    onChange={() => setScope(option)}
                    style={{ cursor: "pointer" }}
                  />
                  {option === "user" ? "User" : "Organization"}
                </label>
              ))}
            </div>
            <span style={hintStyle}>Consumed by the GitHub integration when it lands (SPEC §11.1).</span>
          </div>

          {(validationError || error) && (
            <div style={errorStyle} role="alert" data-testid="add-repo-error">
              {validationError ?? error}
            </div>
          )}
        </div>

        <div style={footerStyle}>
          {onClose && (
            <button type="button" onClick={onClose} style={buttonStyle} data-testid="add-repo-cancel">
              Cancel
            </button>
          )}
          <button
            type="button"
            onClick={handleSubmit}
            disabled={busy}
            style={primaryButtonStyle}
            data-testid="add-repo-submit"
          >
            {busy ? "Adding..." : "Add repo"}
          </button>
        </div>
      </div>
    </div>
  );
}
