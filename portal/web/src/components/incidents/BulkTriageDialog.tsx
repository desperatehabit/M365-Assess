"use client";

// Bulk triage confirmation dialog (EPIC-028 SPEC.md §3.1, §4.1, §8, §9; T-0547).
// The confirmation gate the Incidents list (T-0544) uses before a bulk assign or
// status change. Bulk changes are audited tenant writes that must never proceed
// silently (SPEC §9 risk), so this dialog requires an explicit acknowledgement
// plus the target value and a reason; `onConfirm` is only called once all three
// are present, and always with `confirm: true`. Styling uses the report theme
// tokens; the scrim follows the portal dialog convention.

import React, { useState, type CSSProperties, type ReactElement } from "react";
import { INCIDENT_STATUS_OPTIONS } from "./TriagePanel";

export type BulkTriageAction = "assign" | "status";

export interface BulkTriagePayload {
  readonly value: string;
  readonly reason: string;
  readonly confirm: true;
}

export interface BulkTriageDialogProps {
  readonly open: boolean;
  readonly action: BulkTriageAction;
  readonly incidentIds: readonly string[];
  readonly busy?: boolean;
  readonly error?: string | null;
  readonly onConfirm: (payload: BulkTriagePayload) => void | Promise<void>;
  readonly onClose: () => void;
}

/** A change touching more than one incident is bulk and needs the confirmation gate. */
export function requiresBulkConfirmation(incidentIds: readonly string[]): boolean {
  return incidentIds.length > 1;
}

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

const warningStyle: CSSProperties = {
  padding: "12px 16px",
  background: "var(--warn-soft)",
  border: "1px solid var(--warn)",
  borderRadius: "8px",
  color: "var(--warn-text)",
  fontSize: "13px",
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

const disabledStyle: CSSProperties = {
  opacity: 0.5,
  cursor: "not-allowed",
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

export function BulkTriageDialog({
  open,
  action,
  incidentIds,
  busy = false,
  error = null,
  onConfirm,
  onClose,
}: BulkTriageDialogProps): ReactElement | null {
  const [value, setValue] = useState(action === "status" ? INCIDENT_STATUS_OPTIONS[0] : "");
  const [reason, setReason] = useState("");
  const [acknowledged, setAcknowledged] = useState(false);

  if (!open) {
    return null;
  }

  const canConfirm =
    acknowledged && value.trim().length > 0 && reason.trim().length > 0 && !busy;

  function handleConfirm(): void {
    if (!canConfirm) return;
    void onConfirm({ value: value.trim(), reason: reason.trim(), confirm: true });
  }

  return (
    <div
      style={overlayStyle}
      role="dialog"
      aria-modal="true"
      aria-label={`Confirm bulk ${action}`}
      data-testid="bulk-triage-dialog"
    >
      <div style={dialogStyle}>
        <h2 style={{ margin: 0, fontSize: "18px" }}>
          Confirm bulk {action === "status" ? "status change" : "assignment"}
        </h2>

        <div style={warningStyle} data-testid="bulk-triage-warning">
          This will {action === "status" ? "change the status of" : "reassign"} {incidentIds.length}{" "}
          incidents. Bulk changes are audited and can never silently auto-resolve. Review the list
          before confirming.
        </div>

        <ul style={{ margin: 0, paddingLeft: "18px", fontSize: "13px", color: "var(--text-soft)", maxHeight: "120px", overflowY: "auto" }}>
          {incidentIds.map((id) => (
            <li key={id} data-testid={`bulk-triage-target-${id}`}>
              {id}
            </li>
          ))}
        </ul>

        <label style={fieldStyle}>
          {action === "status" ? "New status" : "Assignee"}
          {action === "status" ? (
            <select
              style={controlStyle}
              value={value}
              onChange={(e) => setValue(e.target.value)}
              disabled={busy}
              data-testid="bulk-triage-value"
            >
              {INCIDENT_STATUS_OPTIONS.map((option) => (
                <option key={option} value={option}>
                  {option}
                </option>
              ))}
            </select>
          ) : (
            <input
              type="text"
              style={controlStyle}
              value={value}
              onChange={(e) => setValue(e.target.value)}
              placeholder="Analyst UPN"
              disabled={busy}
              data-testid="bulk-triage-value"
            />
          )}
        </label>

        <label style={fieldStyle}>
          Reason
          <input
            type="text"
            style={controlStyle}
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder="Reason for the bulk change"
            disabled={busy}
            data-testid="bulk-triage-reason"
          />
        </label>

        <label style={{ display: "flex", alignItems: "center", gap: "8px", fontSize: "13px", color: "var(--text)" }}>
          <input
            type="checkbox"
            checked={acknowledged}
            onChange={(e) => setAcknowledged(e.target.checked)}
            disabled={busy}
            data-testid="bulk-triage-ack"
          />
          I understand this changes {incidentIds.length} incidents and will be audited.
        </label>

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
            data-testid="bulk-triage-error"
          >
            {error}
          </div>
        )}

        <div style={{ display: "flex", justifyContent: "flex-end", gap: "8px" }}>
          <button type="button" style={cancelStyle} onClick={onClose} disabled={busy} data-testid="bulk-triage-cancel">
            Cancel
          </button>
          <button
            type="button"
            style={{ ...primaryStyle, ...(canConfirm ? {} : disabledStyle) }}
            disabled={!canConfirm}
            onClick={handleConfirm}
            data-testid="bulk-triage-confirm"
          >
            {busy ? "Applying…" : "Confirm bulk change"}
          </button>
        </div>
      </div>
    </div>
  );
}
