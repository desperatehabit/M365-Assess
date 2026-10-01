"use client";

// Contacts bulk import dialog (EPIC-023 SPEC.md §3.1, §4.1, §8, §9; T-0445).
// Uploads a CSV (header: displayName, externalAddress) and posts it to the
// T-0444 import route (POST /v1/tenants/{id}/contacts/import), then renders
// the per-row report — created, skipped-duplicate, invalid, failed — so a
// malformed address or a duplicate never aborts the rest of the file. A
// `fetcher` seam keeps the dialog testable without a live BFF. Strictly uses
// report theme tokens with zero colour literals.

import React, { useState, type CSSProperties, type ReactElement } from "react";

export type ContactImportRowStatus =
  | "created"
  | "skipped-duplicate"
  | "invalid"
  | "failed"
  | "ready";

export interface ContactImportRowResult {
  readonly row: number;
  readonly displayName: string;
  readonly externalAddress: string;
  readonly status: ContactImportRowStatus;
  readonly reason: string | null;
  readonly contactId: string | null;
}

export interface ContactImportSummary {
  readonly total: number;
  readonly created: number;
  readonly skippedDuplicate: number;
  readonly invalid: number;
  readonly failed: number;
  readonly ready: number;
}

export interface ContactsImportReport {
  readonly tenantId: string;
  readonly preview: boolean;
  readonly rows: readonly ContactImportRowResult[];
  readonly summary: ContactImportSummary;
}

export interface ContactImportDialogProps {
  readonly tenantId: string;
  readonly open: boolean;
  readonly onClose: () => void;
  /** Called after a successful import so the contacts list can refresh. */
  readonly onImported?: () => void;
  readonly fetcher?: typeof fetch;
}

/** Counts data rows in a bulk CSV (the header row does not count). */
export function countCsvRows(csv: string): number {
  const lines = csv
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  return Math.max(0, lines.length - 1);
}

const overlayStyle: CSSProperties = {
  position: "fixed",
  inset: 0,
  background: "var(--overlay)",
  zIndex: 60,
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  padding: "24px",
};

const dialogStyle: CSSProperties = {
  background: "var(--bg-elev)",
  border: "1px solid var(--border)",
  borderRadius: "var(--radius, 10px)",
  padding: "24px",
  width: "min(680px, 94vw)",
  maxHeight: "90vh",
  overflowY: "auto",
  display: "flex",
  flexDirection: "column",
  gap: "16px",
  color: "var(--text)",
  fontFamily: "var(--font-sans, system-ui, sans-serif)",
};

const titleStyle: CSSProperties = {
  margin: 0,
  fontSize: "20px",
  fontWeight: 700,
};

const guidanceStyle: CSSProperties = {
  margin: 0,
  fontSize: "13px",
  color: "var(--text-soft)",
  lineHeight: 1.5,
};

const fieldStyle: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: "6px",
};

const labelStyle: CSSProperties = {
  fontSize: "13px",
  fontWeight: 600,
  color: "var(--text)",
};

const inputStyle: CSSProperties = {
  padding: "8px 12px",
  background: "var(--input-bg, var(--bg))",
  border: "1px solid var(--border)",
  borderRadius: "6px",
  color: "var(--text)",
  fontSize: "14px",
};

const buttonStyle: CSSProperties = {
  padding: "8px 16px",
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

const disabledStyle: CSSProperties = {
  opacity: 0.55,
  cursor: "not-allowed",
};

const errorBannerStyle: CSSProperties = {
  padding: "12px 14px",
  borderRadius: "6px",
  background: "var(--danger-soft)",
  border: "1px solid var(--danger)",
  color: "var(--danger-text)",
  fontSize: "13px",
};

const summaryStyle: CSSProperties = {
  padding: "12px 14px",
  borderRadius: "6px",
  background: "var(--surface)",
  border: "1px solid var(--border)",
  color: "var(--text)",
  fontSize: "13px",
  lineHeight: 1.6,
};

const tableStyle: CSSProperties = {
  width: "100%",
  borderCollapse: "collapse",
  fontSize: "13px",
  textAlign: "left",
};

const thStyle: CSSProperties = {
  padding: "8px 12px",
  borderBottom: "1px solid var(--border)",
  color: "var(--text-soft)",
  fontSize: "12px",
  textTransform: "uppercase",
  letterSpacing: "0.05em",
};

const tdStyle: CSSProperties = {
  padding: "8px 12px",
  borderBottom: "1px solid var(--border)",
  color: "var(--text)",
};

function statusTone(status: ContactImportRowStatus): CSSProperties {
  if (status === "failed") return { color: "var(--danger-text)", fontWeight: 600 };
  if (status === "invalid") return { color: "var(--warning-text)", fontWeight: 600 };
  if (status === "created") return { color: "var(--success-text)", fontWeight: 600 };
  return { color: "var(--text-soft)", fontWeight: 600 };
}

function RowResultsTable({
  rows,
}: {
  readonly rows: readonly ContactImportRowResult[];
}): ReactElement {
  return (
    <div
      style={{ overflowX: "auto", border: "1px solid var(--border)", borderRadius: "6px" }}
      data-testid="contact-import-results"
    >
      <table style={tableStyle} aria-label="Import results">
        <thead>
          <tr>
            <th style={thStyle}>Row</th>
            <th style={thStyle}>Display name</th>
            <th style={thStyle}>External address</th>
            <th style={thStyle}>Status</th>
            <th style={thStyle}>Detail</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.row} data-testid={`contact-import-row-${row.row}`}>
              <td style={tdStyle}>{row.row}</td>
              <td style={tdStyle}>{row.displayName}</td>
              <td style={{ ...tdStyle, fontFamily: "var(--font-mono, monospace)" }}>
                {row.externalAddress}
              </td>
              <td style={{ ...tdStyle, ...statusTone(row.status) }}>{row.status}</td>
              <td style={tdStyle}>{row.reason ?? row.contactId ?? "—"}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function ContactImportDialog({
  tenantId,
  open,
  onClose,
  onImported,
  fetcher,
}: ContactImportDialogProps): ReactElement | null {
  const [csvText, setCsvText] = useState("");
  const [fileName, setFileName] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [report, setReport] = useState<ContactsImportReport | null>(null);

  if (!open) {
    return null;
  }

  const runFetch = fetcher ?? fetch;
  const rowCount = countCsvRows(csvText);
  const canImport = !busy && rowCount > 0;

  function handleFile(file: File | undefined): void {
    if (!file) return;
    setFileName(file.name);
    const reader = new FileReader();
    reader.onload = (event) => setCsvText(String(event.target?.result ?? ""));
    reader.readAsText(file);
  }

  async function handleImport(): Promise<void> {
    if (!canImport) return;
    setBusy(true);
    setError(null);
    try {
      const response = await runFetch(
        `/v1/tenants/${encodeURIComponent(tenantId)}/contacts/import`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json", Accept: "application/json" },
          body: JSON.stringify({ csv: csvText, preview: false }),
        },
      );
      if (!response.ok) {
        let detail = response.statusText;
        try {
          const payload = (await response.json()) as { message?: string };
          if (payload?.message) detail = payload.message;
        } catch {
          // non-JSON error body; keep the status text
        }
        throw new Error(`Import failed: ${response.status} ${detail}`);
      }
      const body = (await response.json()) as ContactsImportReport;
      setReport(body);
      onImported?.();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  function handleClose(): void {
    setCsvText("");
    setFileName(null);
    setError(null);
    setReport(null);
    onClose();
  }

  const summary = report?.summary;

  return (
    <div
      style={overlayStyle}
      role="dialog"
      aria-modal="true"
      aria-label="Import contacts from CSV"
      data-testid="contact-import-dialog"
    >
      <div style={dialogStyle}>
        <h2 style={titleStyle}>Import contacts</h2>
        <p style={guidanceStyle}>
          Upload a CSV with header <strong>displayName,externalAddress</strong>. Each row is
          imported separately: duplicates are skipped and malformed addresses are reported
          without aborting the rest of the file.
        </p>

        <div style={fieldStyle}>
          <label style={labelStyle} htmlFor="contact-import-file">
            Upload CSV
          </label>
          <input
            id="contact-import-file"
            type="file"
            accept=".csv,.txt"
            onChange={(e) => handleFile(e.target.files?.[0])}
            data-testid="contact-import-file"
          />
          {fileName && (
            <span style={{ fontSize: "12px", color: "var(--text-soft)" }} data-testid="contact-import-file-name">
              {fileName}
            </span>
          )}
        </div>

        <div style={fieldStyle}>
          <label style={labelStyle} htmlFor="contact-import-csv-input">
            CSV (header: displayName, externalAddress)
          </label>
          <textarea
            id="contact-import-csv-input"
            value={csvText}
            onChange={(e) => setCsvText(e.target.value)}
            rows={8}
            placeholder={"displayName,externalAddress\nVendor Sales,vendor@example.invalid"}
            style={{ ...inputStyle, resize: "vertical", fontFamily: "var(--font-mono, monospace)" }}
            data-testid="contact-import-csv-input"
          />
          <span style={{ fontSize: "12px", color: "var(--text-soft)" }} data-testid="contact-import-csv-count">
            {rowCount} contact{rowCount === 1 ? "" : "s"} in CSV
          </span>
        </div>

        {error && (
          <div style={errorBannerStyle} role="alert" data-testid="contact-import-error">
            {error}
          </div>
        )}

        {report && summary && (
          <>
            <div style={summaryStyle} data-testid="contact-import-summary">
              <strong>{summary.total}</strong> row{summary.total === 1 ? "" : "s"}:{" "}
              <span style={{ color: "var(--success-text)" }}>{summary.created} created</span>,{" "}
              {summary.skippedDuplicate} skipped-duplicate, {summary.invalid} invalid,{" "}
              {summary.failed} failed
              {summary.ready > 0 ? `, ${summary.ready} ready` : ""}
            </div>
            <RowResultsTable rows={report.rows} />
          </>
        )}

        <div style={{ display: "flex", gap: "10px", justifyContent: "flex-end" }}>
          <button type="button" style={buttonStyle} onClick={handleClose} data-testid="contact-import-close">
            Close
          </button>
          <button
            type="button"
            style={{ ...primaryButtonStyle, ...(canImport ? {} : disabledStyle) }}
            disabled={!canImport}
            onClick={() => void handleImport()}
            data-testid="contact-import-submit"
          >
            {busy ? "Importing…" : "Import"}
          </button>
        </div>
      </div>
    </div>
  );
}
