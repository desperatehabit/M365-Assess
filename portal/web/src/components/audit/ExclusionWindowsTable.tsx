"use client";

// Exclusion Windows table (EPIC-032 SPEC.md §3.6, §4.4; T-0626, T-0629).
// Lists active/upcoming windows and creates a new window; creation validates
// startsAt < endsAt. The T-0626 window client lives here because auditApi.ts
// is owned by T-0627 and outside this ticket's scope. Zero colour literals:
// report theme tokens only.

import React, { useState, type CSSProperties, type ReactElement } from "react";

// ─── Exclusion-window API (T-0626 endpoints) ───────────────────────────────

export type AuditExclusionWindowStatus = "active" | "upcoming" | "expired";

export interface AuditExclusionWindow {
  readonly id: string;
  readonly tenantId: string;
  readonly startsAt: string;
  readonly endsAt: string;
  readonly reason: string | null;
  readonly status: AuditExclusionWindowStatus;
}

export interface AuditExclusionWindowInput {
  readonly startsAt: string;
  readonly endsAt: string;
  readonly reason?: string;
}

export interface AuditExclusionWindowListResult {
  readonly items: readonly AuditExclusionWindow[];
}

export type Fetcher = typeof fetch;

function asFetcher(fetcher?: Fetcher): Fetcher {
  return fetcher ?? fetch;
}

function exclusionWindowsPath(tenantId: string): string {
  return `/v1/tenants/${encodeURIComponent(tenantId)}/audit/exclusion-windows`;
}

async function expectOk(response: Response, what: string): Promise<unknown> {
  if (!response.ok) {
    let detail = response.statusText;
    try {
      const body = (await response.json()) as { message?: string };
      if (body?.message) detail = body.message;
    } catch {
      // non-JSON error body; keep the status text
    }
    throw new Error(`${what} failed: ${response.status} ${detail}`);
  }
  return response.json();
}

export async function listAuditExclusionWindows(
  tenantId: string,
  fetcher?: Fetcher,
): Promise<AuditExclusionWindowListResult> {
  const response = await asFetcher(fetcher)(exclusionWindowsPath(tenantId));
  return (await expectOk(response, "Loading audit exclusion windows")) as AuditExclusionWindowListResult;
}

export async function createAuditExclusionWindow(
  tenantId: string,
  input: AuditExclusionWindowInput,
  fetcher?: Fetcher,
): Promise<AuditExclusionWindow> {
  const response = await asFetcher(fetcher)(exclusionWindowsPath(tenantId), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      startsAt: input.startsAt,
      endsAt: input.endsAt,
      reason: input.reason?.trim() ? input.reason.trim() : undefined,
    }),
  });
  return (await expectOk(response, "Creating audit exclusion window")) as AuditExclusionWindow;
}

// ─── Styles ─────────────────────────────────────────────────────────────────

const containerStyle: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: "16px",
  width: "100%",
  fontFamily: "var(--font-sans, system-ui, sans-serif)",
  color: "var(--text)",
};

const formStyle: CSSProperties = {
  display: "flex",
  flexWrap: "wrap",
  gap: "10px",
  alignItems: "flex-end",
  padding: "12px 16px",
  background: "var(--bg-elev)",
  border: "1px solid var(--border)",
  borderRadius: "var(--radius, 10px)",
};

const fieldStyle: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: "6px",
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
  fontWeight: 400,
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

const tableWrapStyle: CSSProperties = {
  overflowX: "auto",
  background: "var(--bg-elev)",
  border: "1px solid var(--border)",
  borderRadius: "var(--radius, 10px)",
};

const tableStyle: CSSProperties = {
  width: "100%",
  borderCollapse: "collapse",
  fontSize: "13px",
};

const thStyle: CSSProperties = {
  textAlign: "left",
  padding: "10px 12px",
  borderBottom: "1px solid var(--border)",
  color: "var(--text-soft)",
  fontWeight: 600,
  whiteSpace: "nowrap",
};

const tdStyle: CSSProperties = {
  padding: "10px 12px",
  borderBottom: "1px solid var(--border)",
  verticalAlign: "top",
};

const monoStyle: CSSProperties = {
  fontFamily: "var(--font-mono, ui-monospace, monospace)",
  fontSize: "12px",
  wordBreak: "break-all",
};

const badgeBaseStyle: CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  padding: "2px 8px",
  borderRadius: "999px",
  fontSize: "12px",
  fontWeight: 600,
  whiteSpace: "nowrap",
};

const statusBadgeStyle = (status: AuditExclusionWindowStatus): CSSProperties => {
  if (status === "active") {
    return {
      ...badgeBaseStyle,
      background: "var(--success-soft)",
      color: "var(--success-text)",
      border: "1px solid var(--success)",
    };
  }
  if (status === "upcoming") {
    return {
      ...badgeBaseStyle,
      background: "var(--accent-soft)",
      color: "var(--accent-text)",
      border: "1px solid var(--accent)",
    };
  }
  return {
    ...badgeBaseStyle,
    background: "var(--surface)",
    color: "var(--text-soft)",
    border: "1px solid var(--border)",
  };
};

const errorStyle: CSSProperties = {
  padding: "10px 14px",
  background: "var(--danger-soft)",
  border: "1px solid var(--danger)",
  borderRadius: "6px",
  color: "var(--danger-text)",
  fontSize: "13px",
};

// ─── Helpers ────────────────────────────────────────────────────────────────

function formatDateTime(value: string | null | undefined): string {
  if (!value) return "—";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
}

// ─── Component ──────────────────────────────────────────────────────────────

export interface ExclusionWindowsTableProps {
  readonly windows?: readonly AuditExclusionWindow[];
  readonly loading?: boolean;
  readonly error?: string | null;
  readonly onCreate?: (input: AuditExclusionWindowInput) => void;
}

export function ExclusionWindowsTable({
  windows = [],
  loading = false,
  error = null,
  onCreate,
}: ExclusionWindowsTableProps): ReactElement {
  const [startsAt, setStartsAt] = useState("");
  const [endsAt, setEndsAt] = useState("");
  const [reason, setReason] = useState("");
  const [validationError, setValidationError] = useState<string | null>(null);

  const handleCreate = (): void => {
    setValidationError(null);
    if (!startsAt.trim() || !endsAt.trim()) {
      setValidationError("Both startsAt and endsAt are required.");
      return;
    }
    if (Date.parse(endsAt) <= Date.parse(startsAt)) {
      setValidationError("endsAt must be after startsAt.");
      return;
    }
    onCreate?.({ startsAt, endsAt, reason: reason.trim() || undefined });
  };

  return (
    <div style={containerStyle} data-testid="exclusion-windows-table">
      {error && (
        <div style={errorStyle} role="alert" data-testid="exclusion-windows-error">
          {error}
        </div>
      )}

      {onCreate && (
        <div style={formStyle} data-testid="exclusion-windows-create">
          <label style={fieldStyle}>
            Starts at
            <input
              type="datetime-local"
              style={inputStyle}
              aria-label="Starts at"
              data-testid="exclusion-window-starts"
              value={startsAt}
              onChange={(event) => setStartsAt(event.target.value)}
            />
          </label>
          <label style={fieldStyle}>
            Ends at
            <input
              type="datetime-local"
              style={inputStyle}
              aria-label="Ends at"
              data-testid="exclusion-window-ends"
              value={endsAt}
              onChange={(event) => setEndsAt(event.target.value)}
            />
          </label>
          <label style={fieldStyle}>
            Reason
            <input
              type="text"
              style={inputStyle}
              aria-label="Reason"
              data-testid="exclusion-window-reason"
              placeholder="e.g. Vacation"
              value={reason}
              onChange={(event) => setReason(event.target.value)}
            />
          </label>
          <button
            type="button"
            style={primaryButtonStyle}
            data-testid="exclusion-window-create-submit"
            onClick={handleCreate}
          >
            Create window
          </button>
        </div>
      )}

      {validationError && (
        <div style={errorStyle} role="alert" data-testid="exclusion-window-validation-error">
          {validationError}
        </div>
      )}

      {loading && <div data-testid="exclusion-windows-loading">Loading exclusion windows…</div>}

      {!loading && (
        <div style={tableWrapStyle}>
          <table style={tableStyle} className="DataTable" data-testid="exclusion-windows-grid">
            <thead>
              <tr>
                <th style={thStyle}>Reason</th>
                <th style={thStyle}>Starts</th>
                <th style={thStyle}>Ends</th>
                <th style={thStyle}>Status</th>
              </tr>
            </thead>
            <tbody>
              {windows.map((window) => (
                <tr key={window.id} data-testid={`exclusion-window-row-${window.id}`}>
                  <td style={tdStyle} data-testid={`exclusion-window-reason-${window.id}`}>
                    {window.reason ?? "—"}
                  </td>
                  <td
                    style={{ ...tdStyle, ...monoStyle }}
                    data-testid={`exclusion-window-starts-${window.id}`}
                  >
                    {formatDateTime(window.startsAt)}
                  </td>
                  <td
                    style={{ ...tdStyle, ...monoStyle }}
                    data-testid={`exclusion-window-ends-${window.id}`}
                  >
                    {formatDateTime(window.endsAt)}
                  </td>
                  <td style={tdStyle} data-testid={`exclusion-window-status-${window.id}`}>
                    <span
                      className="status-badge"
                      style={statusBadgeStyle(window.status)}
                      data-testid={`exclusion-window-status-badge-${window.id}`}
                    >
                      {window.status}
                    </span>
                  </td>
                </tr>
              ))}
              {windows.length === 0 && (
                <tr>
                  <td
                    colSpan={4}
                    style={{ ...tdStyle, textAlign: "center", color: "var(--text-soft)" }}
                    data-testid="exclusion-windows-empty"
                  >
                    No exclusion windows yet.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
