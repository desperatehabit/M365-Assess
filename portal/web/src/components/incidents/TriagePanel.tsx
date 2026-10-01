"use client";

// Incident header triage panel (EPIC-028 SPEC.md §2 US-3, §3.2, §4.1; T-0547).
// The header actions for assign, status, classify, and comment. It is
// presentational: the page owns the T-0546 POST and the refresh, so this
// component only collects the value, reason, and comment and hands them to
// `onSubmit`. Status and classification values match the T-0546 API enums.
// Report theme tokens only, zero colour literals.

import React, { useState, type CSSProperties, type ReactElement } from "react";

export type IncidentTriageAction = "assign" | "status" | "classify" | "comment";

export const INCIDENT_STATUS_OPTIONS = ["active", "redirected", "resolved"] as const;
export const INCIDENT_CLASSIFICATION_OPTIONS = [
  "truePositive",
  "falsePositive",
  "informationalExpectedActivity",
  "benignPositive",
] as const;

export interface TriagePayload {
  readonly value: string;
  readonly comment: string;
  readonly reason: string;
}

export interface TriagePanelProps {
  readonly incidentId: string;
  readonly status?: string;
  readonly classification?: string;
  readonly assignee?: string;
  readonly busy?: boolean;
  readonly disabled?: boolean;
  readonly error?: string | null;
  readonly onSubmit: (action: IncidentTriageAction, payload: TriagePayload) => void | Promise<void>;
}

const containerStyle: CSSProperties = {
  display: "flex",
  flexWrap: "wrap",
  alignItems: "flex-end",
  gap: "12px",
  padding: "12px 16px",
  background: "var(--surface)",
  border: "1px solid var(--border)",
  borderRadius: "var(--radius, 10px)",
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
  minWidth: "140px",
};

const buttonStyle: CSSProperties = {
  padding: "8px 14px",
  background: "var(--accent)",
  border: "1px solid var(--accent)",
  borderRadius: "6px",
  color: "var(--on-accent, var(--bg))",
  fontSize: "13px",
  fontWeight: 600,
  cursor: "pointer",
};

const disabledButtonStyle: CSSProperties = {
  opacity: 0.5,
  cursor: "not-allowed",
};

const errorStyle: CSSProperties = {
  width: "100%",
  padding: "8px 12px",
  background: "var(--danger-soft)",
  border: "1px solid var(--danger)",
  borderRadius: "6px",
  color: "var(--danger-text)",
  fontSize: "13px",
};

export function TriagePanel({
  incidentId,
  status,
  classification,
  assignee,
  busy = false,
  disabled = false,
  error = null,
  onSubmit,
}: TriagePanelProps): ReactElement {
  const [statusValue, setStatusValue] = useState(status && status.length > 0 ? status : INCIDENT_STATUS_OPTIONS[0]);
  const [classifyValue, setClassifyValue] = useState(
    classification && classification.length > 0 ? classification : INCIDENT_CLASSIFICATION_OPTIONS[0],
  );
  const [assignValue, setAssignValue] = useState(assignee ?? "");
  const [commentValue, setCommentValue] = useState("");
  const [reason, setReason] = useState("");

  const blocked = busy || disabled;
  const reasonMissing = reason.trim().length === 0;

  function submit(action: IncidentTriageAction, payload: TriagePayload): void {
    void onSubmit(action, payload);
  }

  return (
    <div style={containerStyle} data-testid="triage-panel" data-incident-id={incidentId}>
      {error && (
        <div role="alert" style={errorStyle} data-testid="triage-error">
          {error}
        </div>
      )}

      <label style={fieldStyle}>
        Status
        <select
          style={controlStyle}
          value={statusValue}
          onChange={(e) => setStatusValue(e.target.value)}
          disabled={blocked}
          data-testid="triage-status-value"
        >
          {INCIDENT_STATUS_OPTIONS.map((option) => (
            <option key={option} value={option}>
              {option}
            </option>
          ))}
        </select>
      </label>
      <button
        type="button"
        style={{ ...buttonStyle, ...(blocked || reasonMissing ? disabledButtonStyle : {}) }}
        disabled={blocked || reasonMissing}
        onClick={() => submit("status", { value: statusValue, comment: "", reason: reason.trim() })}
        data-testid="triage-status-submit"
      >
        Set status
      </button>

      <label style={fieldStyle}>
        Classification
        <select
          style={controlStyle}
          value={classifyValue}
          onChange={(e) => setClassifyValue(e.target.value)}
          disabled={blocked}
          data-testid="triage-classify-value"
        >
          {INCIDENT_CLASSIFICATION_OPTIONS.map((option) => (
            <option key={option} value={option}>
              {option}
            </option>
          ))}
        </select>
      </label>
      <button
        type="button"
        style={{ ...buttonStyle, ...(blocked || reasonMissing ? disabledButtonStyle : {}) }}
        disabled={blocked || reasonMissing}
        onClick={() => submit("classify", { value: classifyValue, comment: "", reason: reason.trim() })}
        data-testid="triage-classify-submit"
      >
        Classify
      </button>

      <label style={fieldStyle}>
        Assign to
        <input
          type="text"
          style={controlStyle}
          value={assignValue}
          onChange={(e) => setAssignValue(e.target.value)}
          placeholder="Analyst UPN"
          disabled={blocked}
          data-testid="triage-assign-value"
        />
      </label>
      <button
        type="button"
        style={{ ...buttonStyle, ...(blocked || reasonMissing || assignValue.trim().length === 0 ? disabledButtonStyle : {}) }}
        disabled={blocked || reasonMissing || assignValue.trim().length === 0}
        onClick={() => submit("assign", { value: assignValue.trim(), comment: "", reason: reason.trim() })}
        data-testid="triage-assign-submit"
      >
        Assign
      </button>

      <label style={fieldStyle}>
        Reason
        <input
          type="text"
          style={controlStyle}
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          placeholder="Reason for the change"
          disabled={blocked}
          data-testid="triage-reason"
        />
      </label>

      <label style={{ ...fieldStyle, flex: "1 1 220px" }}>
        Comment
        <textarea
          style={{ ...controlStyle, minHeight: "38px" }}
          value={commentValue}
          onChange={(e) => setCommentValue(e.target.value)}
          placeholder="Add a portal note"
          disabled={blocked}
          data-testid="triage-comment-value"
        />
      </label>
      <button
        type="button"
        style={{ ...buttonStyle, ...(blocked || commentValue.trim().length === 0 ? disabledButtonStyle : {}) }}
        disabled={blocked || commentValue.trim().length === 0}
        onClick={() => submit("comment", { value: "", comment: commentValue.trim(), reason: "" })}
        data-testid="triage-comment-submit"
      >
        Add comment
      </button>
    </div>
  );
}
