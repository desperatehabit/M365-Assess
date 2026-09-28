"use client";

// CVE exception dialog (EPIC-019 SPEC.md §3.4, §11.3, T-0369).
// Add/edit form for the T-0368 CVE exception route. Expiry is mandatory and
// scope is the §11.3 discriminator (all | device | software, default all):
// device/software require a target id while all forbids one. Kit tokens only.

import React, { useState, type CSSProperties, type ReactElement } from "react";
import {
  CVE_EXCEPTION_SCOPES,
  type CveException,
  type CveExceptionScope,
} from "./CveExceptionTable";

export interface CveExceptionFormValues {
  readonly cve: string;
  readonly scope: CveExceptionScope;
  readonly scopeTargetId: string | null;
  readonly reason: string;
  readonly expiresOn: string;
}

export interface CveExceptionDialogProps {
  readonly initial?: CveException | null;
  readonly submitting?: boolean;
  readonly serverError?: string | null;
  readonly onSubmit: (values: CveExceptionFormValues) => void;
  readonly onClose: () => void;
}

export interface CveExceptionDraft {
  readonly cve: string;
  readonly scope: string;
  readonly scopeTargetId: string;
  readonly reason: string;
  readonly expiresOn: string;
}

const CVE_PATTERN = /^CVE-\d{4}-\d{4,}$/i;
const DATE_ONLY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

export function isCveExceptionScopeValue(value: unknown): value is CveExceptionScope {
  return (
    typeof value === "string" &&
    (CVE_EXCEPTION_SCOPES as readonly string[]).includes(value)
  );
}

function parseExpiry(raw: string): Date {
  const trimmed = raw.trim();
  return new Date(DATE_ONLY_PATTERN.test(trimmed) ? `${trimmed}T00:00:00Z` : trimmed);
}

export function validateCveExceptionForm(
  draft: CveExceptionDraft,
  now: number = Date.now(),
): string | null {
  if (!CVE_PATTERN.test(draft.cve.trim())) return "CVE must look like CVE-YYYY-NNNN.";
  if (!isCveExceptionScopeValue(draft.scope)) return "Scope must be all, device, or software.";
  if (draft.reason.trim().length === 0) return "Reason is required.";
  if (draft.expiresOn.trim().length === 0) return "Expiry is required.";
  const parsed = parseExpiry(draft.expiresOn);
  if (Number.isNaN(parsed.getTime())) return "Expiry must be a valid date.";
  if (parsed.getTime() <= now) return "Expiry must be in the future.";
  const target = draft.scopeTargetId.trim();
  if (draft.scope === "all") {
    if (target.length > 0) return "Target must be empty when scope is all.";
  } else if (target.length === 0) {
    return `Target is required when scope is ${draft.scope}.`;
  }
  return null;
}

export function normalizeCveExceptionForm(draft: CveExceptionDraft): CveExceptionFormValues {
  const scope = draft.scope as CveExceptionScope;
  const target = draft.scopeTargetId.trim();
  return {
    cve: draft.cve.trim().toUpperCase(),
    scope,
    scopeTargetId: scope === "all" ? null : target,
    reason: draft.reason.trim(),
    expiresOn: parseExpiry(draft.expiresOn).toISOString(),
  };
}

const overlayStyle: CSSProperties = {
  position: "fixed",
  inset: 0,
  background: "var(--overlay)",
  zIndex: 60,
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
};

const dialogStyle: CSSProperties = {
  background: "var(--bg-elev)",
  border: "1px solid var(--border)",
  borderRadius: "var(--radius, 10px)",
  padding: "24px",
  width: "min(520px, 90vw)",
  display: "flex",
  flexDirection: "column",
  gap: "12px",
  color: "var(--text)",
};

const labelStyle: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: "6px",
  fontSize: "13px",
  fontWeight: 500,
  color: "var(--text-soft)",
};

const inputStyle: CSSProperties = {
  padding: "8px 12px",
  background: "var(--input-bg, var(--bg))",
  border: "1px solid var(--border)",
  borderRadius: "6px",
  color: "var(--text)",
  fontSize: "14px",
  width: "100%",
  boxSizing: "border-box",
};

const hintStyle: CSSProperties = {
  margin: 0,
  fontSize: "12px",
  color: "var(--text-soft)",
};

const errorStyle: CSSProperties = {
  margin: 0,
  padding: "12px",
  borderRadius: "6px",
  background: "var(--danger-soft)",
  border: "1px solid var(--danger)",
  color: "var(--danger-text)",
  fontSize: "13px",
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

const submitButtonStyle: CSSProperties = {
  ...buttonStyle,
  background: "var(--accent)",
  color: "var(--on-accent)",
  borderColor: "var(--accent)",
};

export function CveExceptionDialog({
  initial = null,
  submitting = false,
  serverError = null,
  onSubmit,
  onClose,
}: CveExceptionDialogProps): ReactElement {
  const isEdit = initial !== null;
  const [cve, setCve] = useState(initial?.cve ?? "");
  const [scope, setScope] = useState<string>(initial?.scope ?? "all");
  const [scopeTargetId, setScopeTargetId] = useState(initial?.scopeTargetId ?? "");
  const [reason, setReason] = useState(initial?.reason ?? "");
  const [expiresOn, setExpiresOn] = useState((initial?.expiresOn ?? "").slice(0, 10));
  const [error, setError] = useState<string | null>(null);

  function handleSubmit(event: React.FormEvent): void {
    event.preventDefault();
    const failure = validateCveExceptionForm({ cve, scope, scopeTargetId, reason, expiresOn });
    if (failure) {
      setError(failure);
      return;
    }
    setError(null);
    onSubmit(normalizeCveExceptionForm({ cve, scope, scopeTargetId, reason, expiresOn }));
  }

  return (
    <div style={overlayStyle} data-testid="cve-exception-dialog-overlay">
      <div
        style={dialogStyle}
        role="dialog"
        aria-modal="true"
        aria-label={isEdit ? "Edit CVE exception" : "Add CVE exception"}
        data-testid="cve-exception-dialog"
      >
        <h3 style={{ margin: 0, fontSize: "18px" }}>
          {isEdit ? `Edit exception ${initial.cve}` : "Add exception"}
        </h3>

        {(error || serverError) && (
          <p style={errorStyle} role="alert" data-testid="cve-dialog-error">
            {error ?? serverError}
          </p>
        )}

        <form onSubmit={handleSubmit} style={{ display: "flex", flexDirection: "column", gap: "12px" }}>
          <label style={labelStyle}>
            CVE
            <input
              type="text"
              value={cve}
              onChange={(e) => setCve(e.target.value)}
              placeholder="CVE-2026-1234"
              style={inputStyle}
              aria-label="CVE"
              data-testid="input-cve"
              disabled={isEdit || submitting}
              title={isEdit ? "The CVE cannot change on an existing exception." : undefined}
            />
          </label>

          <label style={labelStyle}>
            Scope
            <select
              value={scope}
              onChange={(e) => setScope(e.target.value)}
              style={{ ...inputStyle, cursor: "pointer" }}
              aria-label="Scope"
              data-testid="input-scope"
              disabled={submitting}
            >
              {CVE_EXCEPTION_SCOPES.map((option) => (
                <option key={option} value={option}>
                  {option}
                </option>
              ))}
            </select>
          </label>
          <p style={hintStyle}>All suppresses the CVE everywhere; device and software narrow it to one target.</p>

          <label style={labelStyle}>
            Scope target
            <input
              type="text"
              value={scopeTargetId}
              onChange={(e) => setScopeTargetId(e.target.value)}
              placeholder="Device or software id"
              style={inputStyle}
              aria-label="Scope target"
              data-testid="input-scope-target"
              disabled={submitting}
            />
          </label>
          <p style={hintStyle}>Required for device and software scopes; leave empty when scope is all.</p>

          <label style={labelStyle}>
            Reason
            <textarea
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder="Why is this CVE excepted?"
              rows={3}
              style={{ ...inputStyle, resize: "vertical" }}
              aria-label="Reason"
              data-testid="input-reason"
              disabled={submitting}
            />
          </label>

          <label style={labelStyle}>
            Expires
            <input
              type="date"
              value={expiresOn}
              onChange={(e) => setExpiresOn(e.target.value)}
              style={inputStyle}
              aria-label="Expires"
              data-testid="input-expires"
              disabled={submitting}
            />
          </label>
          <p style={hintStyle}>Expiry is mandatory. When it lapses the CVE re-surfaces.</p>

          <div style={{ display: "flex", gap: "8px", justifyContent: "flex-end" }}>
            <button
              type="button"
              style={buttonStyle}
              onClick={onClose}
              disabled={submitting}
              data-testid="cve-dialog-cancel"
            >
              Cancel
            </button>
            <button
              type="submit"
              style={submitButtonStyle}
              disabled={submitting}
              data-testid="cve-dialog-submit"
            >
              {submitting ? "Saving..." : isEdit ? "Save changes" : "Add exception"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
