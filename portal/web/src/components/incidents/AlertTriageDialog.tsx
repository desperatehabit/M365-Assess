"use client";

// Alert triage dialog (EPIC-028 SPEC.md §3.3, §4.1, §8; T-0548/T-0858).
//
// The alert list's row actions used to navigate to /alerts/{id}, a page that never
// existed, so every action 404'd. This dialog keeps the analyst on the list and
// drives the T-0548 triage API with an explicit reason; the route gates resolving
// and create-incident on `confirm: true`, which the dialog always sends.

import React, { useState, type CSSProperties, type ReactElement } from "react";

export type AlertDialogAction = "status" | "assign" | "comment" | "create-incident";

export interface AlertTriagePayload {
  readonly value: string;
  readonly comment: string;
  readonly reason: string;
  readonly confirm: true;
}

export interface AlertTriageDialogProps {
  readonly open: boolean;
  readonly action: AlertDialogAction;
  readonly alertTitle: string;
  readonly busy?: boolean;
  readonly error?: string | null;
  readonly onConfirm: (payload: AlertTriagePayload) => void | Promise<void>;
  readonly onClose: () => void;
}

export const ALERT_STATUS_OPTIONS = ["new", "inProgress", "resolved"] as const;

const overlayStyle: CSSProperties = {
  position: "fixed",
  inset: 0,
  background: "var(--overlay, rgba(0,0,0,0.5))",
  zIndex: 200,
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  padding: "16px",
};

const dialogStyle: CSSProperties = {
  width: "520px",
  maxWidth: "calc(100vw - 32px)",
  background: "var(--surface)",
  color: "var(--text)",
  border: "1px solid var(--border)",
  borderRadius: "var(--radius, 10px)",
  padding: "20px 24px",
  display: "flex",
  flexDirection: "column",
  gap: "12px",
  boxShadow: "var(--shadow-card)",
};

const fieldStyle: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: "4px",
  fontSize: "12px",
  color: "var(--text-soft)",
};

const controlStyle: CSSProperties = {
  padding: "8px 10px",
  background: "var(--input-bg, var(--bg))",
  border: "1px solid var(--border)",
  borderRadius: "6px",
  color: "var(--text)",
  fontSize: "13px",
};

const primaryStyle: CSSProperties = {
  padding: "8px 16px",
  background: "var(--accent)",
  border: "1px solid var(--accent)",
  borderRadius: "6px",
  color: "var(--on-accent, var(--bg))",
  fontSize: "13px",
  fontWeight: 600,
  cursor: "pointer",
};

const cancelStyle: CSSProperties = {
  padding: "8px 16px",
  background: "var(--surface)",
  border: "1px solid var(--border)",
  borderRadius: "6px",
  color: "var(--text)",
  fontSize: "13px",
  cursor: "pointer",
};

const ACTION_TITLES: Readonly<Record<AlertDialogAction, string>> = {
  status: "Set alert status",
  assign: "Assign alert",
  comment: "Comment on alert",
  "create-incident": "Create incident from alert",
};

export function AlertTriageDialog({
  open,
  action,
  alertTitle,
  busy = false,
  error = null,
  onConfirm,
  onClose,
}: AlertTriageDialogProps): ReactElement | null {
  const [value, setValue] = useState(action === "status" ? ALERT_STATUS_OPTIONS[0] : "");
  const [comment, setComment] = useState("");
  const [reason, setReason] = useState("");

  if (!open) {
    return null;
  }

  const needsReason = action !== "comment";
  const canConfirm =
    reason.trim().length > 0 &&
    (action === "comment" ? comment.trim().length > 0 : true) &&
    !busy;

  function handleConfirm(): void {
    if (!canConfirm) return;
    void onConfirm({ value: value.trim(), comment: comment.trim(), reason: reason.trim(), confirm: true });
  }

  return (
    <div
      style={overlayStyle}
      role="dialog"
      aria-modal="true"
      aria-label={ACTION_TITLES[action]}
      data-testid="alert-triage-dialog"
    >
      <div style={dialogStyle}>
        <h2 style={{ margin: 0, fontSize: "18px" }}>{ACTION_TITLES[action]}</h2>
        <p style={{ margin: 0, fontSize: "13px", color: "var(--text-soft)" }}>{alertTitle}</p>

        {action === "status" && (
          <label style={fieldStyle}>
            New status
            <select
              style={controlStyle}
              value={value}
              onChange={(event) => setValue(event.target.value)}
              disabled={busy}
              data-testid="alert-triage-value"
            >
              {ALERT_STATUS_OPTIONS.map((option) => (
                <option key={option} value={option}>
                  {option}
                </option>
              ))}
            </select>
          </label>
        )}

        {action === "assign" && (
          <label style={fieldStyle}>
            Assignee
            <input
              type="text"
              style={controlStyle}
              value={value}
              onChange={(event) => setValue(event.target.value)}
              placeholder="Analyst UPN"
              disabled={busy}
              data-testid="alert-triage-value"
            />
          </label>
        )}

        {(action === "comment" || action === "create-incident") && (
          <label style={fieldStyle}>
            Comment
            <textarea
              style={{ ...controlStyle, minHeight: "72px" }}
              value={comment}
              onChange={(event) => setComment(event.target.value)}
              placeholder="What the analyst observed"
              disabled={busy}
              data-testid="alert-triage-comment"
            />
          </label>
        )}

        {needsReason && (
          <label style={fieldStyle}>
            Reason
            <input
              type="text"
              style={controlStyle}
              value={reason}
              onChange={(event) => setReason(event.target.value)}
              placeholder="Reason for the change"
              disabled={busy}
              data-testid="alert-triage-reason"
            />
          </label>
        )}

        {error && (
          <div
            role="alert"
            style={{
              padding: "8px 12px",
              background: "var(--danger-soft)",
              border: "1px solid var(--danger)",
              borderRadius: "6px",
              color: "var(--danger-text)",
              fontSize: "13px",
            }}
            data-testid="alert-triage-error"
          >
            {error}
          </div>
        )}

        <div style={{ display: "flex", justifyContent: "flex-end", gap: "8px" }}>
          <button type="button" style={cancelStyle} onClick={onClose} disabled={busy} data-testid="alert-triage-cancel">
            Cancel
          </button>
          <button
            type="button"
            style={canConfirm ? primaryStyle : { ...primaryStyle, opacity: 0.5, cursor: "not-allowed" }}
            disabled={!canConfirm}
            onClick={handleConfirm}
            data-testid="alert-triage-confirm"
          >
            {busy ? "Applying…" : "Apply"}
          </button>
        </div>
      </div>
    </div>
  );
}
