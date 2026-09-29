"use client";

// Manual audit-log search (EPIC-032 SPEC.md §3.1, §4.1; T-0622, T-0627).
// Filter form (date range, user, activity, workload, IP) → results table with
// the §3.1 columns (Timestamp · User · Activity · Workload · Object · Result).
// Row actions: View detail, Export CSV (routed through the T-0622 export path
// so the download is audited), Save search (T-0623 create). Zero colour
// literals: report theme tokens only.

import React, { useState, type CSSProperties, type ReactElement } from "react";
import {
  AUDIT_SEARCH_WORKLOADS,
  createSavedSearch,
  exportAuditLogCsv,
  searchAuditLog,
  type AuditSearchFilters,
  type AuditSearchResultItem,
} from "../../lib/auditApi";

// ─── Styles ─────────────────────────────────────────────────────────────────

const containerStyle: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: "16px",
  width: "100%",
  fontFamily: "var(--font-sans, system-ui, sans-serif)",
  color: "var(--text)",
};

const filterBarStyle: CSSProperties = {
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

const selectStyle: CSSProperties = { ...inputStyle, cursor: "pointer" };

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

const resultBadgeStyle: CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  padding: "2px 8px",
  borderRadius: "999px",
  fontSize: "12px",
  fontWeight: 600,
  background: "var(--accent-soft)",
  color: "var(--accent-text)",
  border: "1px solid var(--accent)",
  whiteSpace: "nowrap",
};

const actionBtnStyle: CSSProperties = {
  padding: "4px 8px",
  background: "var(--surface)",
  border: "1px solid var(--border)",
  borderRadius: "4px",
  color: "var(--text)",
  fontSize: "12px",
  cursor: "pointer",
  whiteSpace: "nowrap",
};

const noticeStyle: CSSProperties = {
  padding: "10px 14px",
  background: "var(--accent-soft)",
  border: "1px solid var(--accent)",
  borderRadius: "6px",
  color: "var(--accent-text)",
  fontSize: "13px",
};

const errorStyle: CSSProperties = {
  padding: "10px 14px",
  background: "var(--danger-soft)",
  border: "1px solid var(--danger)",
  borderRadius: "6px",
  color: "var(--danger-text)",
  fontSize: "13px",
};

const overlayStyle: CSSProperties = {
  position: "fixed",
  inset: 0,
  background: "rgba(0, 0, 0, 0.45)",
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  zIndex: 100,
  padding: "16px",
};

const dialogStyle: CSSProperties = {
  background: "var(--bg-elev)",
  border: "1px solid var(--border)",
  borderRadius: "var(--radius, 10px)",
  boxShadow: "var(--shadow-card)",
  padding: "24px",
  width: "100%",
  maxWidth: "520px",
  display: "flex",
  flexDirection: "column",
  gap: "14px",
  color: "var(--text)",
  fontFamily: "var(--font-sans, system-ui, sans-serif)",
};

const titleStyle: CSSProperties = {
  fontSize: "18px",
  fontWeight: 700,
  margin: 0,
  fontFamily: "var(--font-display, var(--font-sans))",
};

const hintStyle: CSSProperties = {
  fontSize: "13px",
  fontWeight: 400,
  color: "var(--text-soft)",
  margin: 0,
};

const rowStyle: CSSProperties = {
  display: "flex",
  gap: "10px",
  justifyContent: "flex-end",
  flexWrap: "wrap",
};

const detailRowStyle: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: "2px",
  fontSize: "13px",
};

const detailLabelStyle: CSSProperties = {
  fontSize: "11px",
  fontWeight: 600,
  textTransform: "uppercase",
  letterSpacing: "0.05em",
  color: "var(--text-soft)",
};

// ─── Helpers ────────────────────────────────────────────────────────────────

function resultBadgeStyleFor(result: string): CSSProperties {
  const normalized = result.trim().toLowerCase();
  if (normalized.startsWith("fail") || normalized === "error") {
    return {
      ...resultBadgeStyle,
      background: "var(--danger-soft)",
      color: "var(--danger-text)",
      borderColor: "var(--danger)",
    };
  }
  if (normalized.startsWith("success") || normalized === "ok" || normalized === "passed") {
    return {
      ...resultBadgeStyle,
      background: "var(--success-soft)",
      color: "var(--success-text)",
      borderColor: "var(--success)",
    };
  }
  return resultBadgeStyle;
}

function downloadCsv(filename: string, csv: string): void {
  const blob = new Blob([csv], { type: "text/csv" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  document.body.removeChild(anchor);
  URL.revokeObjectURL(url);
}

// ─── Component ──────────────────────────────────────────────────────────────

export interface ManualSearchFormProps {
  readonly tenantId: string;
  readonly fetcher?: typeof fetch;
}

export function ManualSearchForm({ tenantId, fetcher }: ManualSearchFormProps): ReactElement {
  const [startDate, setStartDate] = useState("");
  const [endDate, setEndDate] = useState("");
  const [user, setUser] = useState("");
  const [activity, setActivity] = useState("");
  const [workload, setWorkload] = useState("");
  const [ip, setIp] = useState("");
  const [results, setResults] = useState<readonly AuditSearchResultItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [detail, setDetail] = useState<AuditSearchResultItem | null>(null);
  const [saveOpen, setSaveOpen] = useState(false);
  const [saveName, setSaveName] = useState("");
  const [saving, setSaving] = useState(false);

  const currentFilters = (): AuditSearchFilters => ({
    startDate: startDate.trim() || undefined,
    endDate: endDate.trim() || undefined,
    user: user.trim() || undefined,
    activity: activity.trim() || undefined,
    workload: workload || undefined,
    ip: ip.trim() || undefined,
  });

  const handleSearch = async (): Promise<void> => {
    if (!tenantId.trim()) {
      setNotice("Select a tenant before running a search.");
      return;
    }
    setLoading(true);
    setError(null);
    setNotice(null);
    try {
      const filters = currentFilters();
      const run = await searchAuditLog(
        tenantId.trim(),
        { ...filters, workloads: workload ? [workload] : undefined },
        fetcher,
      );
      setResults(run.results);
      if (run.results.length === 0) {
        setNotice("No audit records matched the current filters.");
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setResults([]);
    } finally {
      setLoading(false);
    }
  };

  const handleExportCsv = async (): Promise<void> => {
    if (!tenantId.trim()) {
      setNotice("Select a tenant before exporting.");
      return;
    }
    setError(null);
    try {
      const csv = await exportAuditLogCsv(tenantId.trim(), currentFilters(), fetcher);
      downloadCsv(`audit-log-search-${tenantId.trim()}.csv`, csv);
      setNotice("CSV export downloaded; the export was recorded in the audit log.");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const openSaveDialog = (): void => {
    setSaveName("");
    setSaveOpen(true);
  };

  const handleSaveSearch = async (): Promise<void> => {
    const name = saveName.trim();
    if (!name) {
      setError("Enter a name for the saved search.");
      return;
    }
    setSaving(true);
    setError(null);
    try {
      await createSavedSearch(tenantId.trim(), { name, filters: currentFilters() }, fetcher);
      setSaveOpen(false);
      setSaveName("");
      setNotice(`Saved search "${name}".`);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div style={containerStyle} data-testid="manual-search-form">
      <div style={filterBarStyle} data-testid="manual-search-filters">
        <label style={fieldStyle}>
          Start date
          <input
            type="datetime-local"
            style={inputStyle}
            aria-label="Start date"
            data-testid="manual-filter-start-date"
            value={startDate}
            onChange={(event) => setStartDate(event.target.value)}
          />
        </label>
        <label style={fieldStyle}>
          End date
          <input
            type="datetime-local"
            style={inputStyle}
            aria-label="End date"
            data-testid="manual-filter-end-date"
            value={endDate}
            onChange={(event) => setEndDate(event.target.value)}
          />
        </label>
        <label style={fieldStyle}>
          User
          <input
            type="text"
            style={inputStyle}
            aria-label="User"
            data-testid="manual-filter-user"
            placeholder="User principal name…"
            value={user}
            onChange={(event) => setUser(event.target.value)}
          />
        </label>
        <label style={fieldStyle}>
          Activity
          <input
            type="text"
            style={inputStyle}
            aria-label="Activity"
            data-testid="manual-filter-activity"
            placeholder="Activity…"
            value={activity}
            onChange={(event) => setActivity(event.target.value)}
          />
        </label>
        <label style={fieldStyle}>
          Workload
          <select
            style={selectStyle}
            aria-label="Workload"
            data-testid="manual-filter-workload"
            value={workload}
            onChange={(event) => setWorkload(event.target.value)}
          >
            <option value="">All workloads</option>
            {AUDIT_SEARCH_WORKLOADS.map((name) => (
              <option key={name} value={name}>
                {name}
              </option>
            ))}
          </select>
        </label>
        <label style={fieldStyle}>
          IP address
          <input
            type="text"
            style={inputStyle}
            aria-label="IP address"
            data-testid="manual-filter-ip"
            placeholder="IP address…"
            value={ip}
            onChange={(event) => setIp(event.target.value)}
          />
        </label>
        <button
          type="button"
          style={primaryButtonStyle}
          data-testid="manual-search-submit"
          onClick={() => void handleSearch()}
        >
          Search
        </button>
        <button
          type="button"
          style={buttonStyle}
          data-testid="manual-export-csv"
          onClick={() => void handleExportCsv()}
        >
          Export CSV
        </button>
        <button type="button" style={buttonStyle} data-testid="manual-save-search" onClick={openSaveDialog}>
          Save search
        </button>
      </div>

      {notice && (
        <div style={noticeStyle} data-testid="manual-search-notice">
          {notice}
        </div>
      )}
      {error && (
        <div style={errorStyle} role="alert" data-testid="manual-search-error">
          {error}
        </div>
      )}

      {loading && <div data-testid="manual-search-loading">Running search…</div>}

      {!loading && (
        <div style={tableWrapStyle}>
          <table style={tableStyle} className="DataTable" data-testid="manual-search-results">
            <thead>
              <tr>
                <th style={thStyle}>Timestamp</th>
                <th style={thStyle}>User</th>
                <th style={thStyle}>Activity</th>
                <th style={thStyle}>Workload</th>
                <th style={thStyle}>Object</th>
                <th style={thStyle}>Result</th>
                <th style={thStyle}>Actions</th>
              </tr>
            </thead>
            <tbody>
              {results.map((row, index) => (
                <tr key={`${row.timestamp}-${index}`} data-testid={`manual-result-row-${index}`}>
                  <td style={{ ...tdStyle, ...monoStyle }} data-testid={`manual-result-timestamp-${index}`}>
                    {row.timestamp}
                  </td>
                  <td style={tdStyle} data-testid={`manual-result-user-${index}`}>
                    {row.user}
                  </td>
                  <td style={tdStyle} data-testid={`manual-result-activity-${index}`}>
                    {row.activity}
                  </td>
                  <td style={tdStyle} data-testid={`manual-result-workload-${index}`}>
                    {row.workload}
                  </td>
                  <td style={{ ...tdStyle, ...monoStyle }} data-testid={`manual-result-object-${index}`}>
                    {row.object}
                  </td>
                  <td style={tdStyle} data-testid={`manual-result-result-${index}`}>
                    <span
                      className="status-badge"
                      style={resultBadgeStyleFor(row.result)}
                      data-testid={`manual-result-badge-${index}`}
                    >
                      {row.result}
                    </span>
                  </td>
                  <td style={tdStyle}>
                    <div style={{ display: "flex", gap: "6px", flexWrap: "wrap" }}>
                      <button
                        type="button"
                        style={actionBtnStyle}
                        data-testid={`manual-view-detail-${index}`}
                        onClick={() => setDetail(row)}
                      >
                        View detail
                      </button>
                      <button
                        type="button"
                        style={actionBtnStyle}
                        data-testid={`manual-row-export-${index}`}
                        onClick={() => void handleExportCsv()}
                      >
                        Export CSV
                      </button>
                      <button
                        type="button"
                        style={actionBtnStyle}
                        data-testid={`manual-row-save-${index}`}
                        onClick={openSaveDialog}
                      >
                        Save search
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
              {results.length === 0 && (
                <tr>
                  <td
                    colSpan={7}
                    style={{ ...tdStyle, textAlign: "center", color: "var(--text-soft)" }}
                    data-testid="manual-search-empty"
                  >
                    Run a search to see audit-log results.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      )}

      {detail && (
        <div
          style={overlayStyle}
          data-testid="manual-detail-overlay"
          onClick={() => setDetail(null)}
        >
          <div
            role="dialog"
            aria-modal="true"
            aria-label="Audit record detail"
            style={dialogStyle}
            data-testid="manual-detail-dialog"
            onClick={(event) => event.stopPropagation()}
          >
            <h2 style={titleStyle}>Audit record detail</h2>
            <div style={detailRowStyle} data-testid="manual-detail-timestamp">
              <span style={detailLabelStyle}>Timestamp</span>
              <span style={monoStyle}>{detail.timestamp}</span>
            </div>
            <div style={detailRowStyle} data-testid="manual-detail-user">
              <span style={detailLabelStyle}>User</span>
              <span>{detail.user}</span>
            </div>
            <div style={detailRowStyle} data-testid="manual-detail-activity">
              <span style={detailLabelStyle}>Activity</span>
              <span>{detail.activity}</span>
            </div>
            <div style={detailRowStyle} data-testid="manual-detail-workload">
              <span style={detailLabelStyle}>Workload</span>
              <span>{detail.workload}</span>
            </div>
            <div style={detailRowStyle} data-testid="manual-detail-object">
              <span style={detailLabelStyle}>Object</span>
              <span style={monoStyle}>{detail.object}</span>
            </div>
            <div style={detailRowStyle} data-testid="manual-detail-result">
              <span style={detailLabelStyle}>Result</span>
              <span className="status-badge" style={resultBadgeStyleFor(detail.result)}>
                {detail.result}
              </span>
            </div>
            <div style={rowStyle}>
              <button
                type="button"
                style={buttonStyle}
                data-testid="manual-detail-close"
                onClick={() => setDetail(null)}
              >
                Close
              </button>
            </div>
          </div>
        </div>
      )}

      {saveOpen && (
        <div
          style={overlayStyle}
          data-testid="manual-save-overlay"
          onClick={() => setSaveOpen(false)}
        >
          <div
            role="dialog"
            aria-modal="true"
            aria-label="Save search"
            style={dialogStyle}
            data-testid="manual-save-dialog"
            onClick={(event) => event.stopPropagation()}
          >
            <h2 style={titleStyle}>Save search</h2>
            <p style={hintStyle} data-testid="manual-save-hint">
              Stores the current filters so the search can be re-run from Saved Log Searches.
            </p>
            <label style={fieldStyle}>
              Name
              <input
                type="text"
                style={inputStyle}
                aria-label="Saved search name"
                data-testid="manual-save-name"
                placeholder="Search name…"
                value={saveName}
                onChange={(event) => setSaveName(event.target.value)}
              />
            </label>
            <div style={rowStyle}>
              <button
                type="button"
                style={buttonStyle}
                data-testid="manual-save-cancel"
                onClick={() => setSaveOpen(false)}
              >
                Cancel
              </button>
              <button
                type="button"
                style={primaryButtonStyle}
                data-testid="manual-save-confirm"
                disabled={saving}
                onClick={() => void handleSaveSearch()}
              >
                Save
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
