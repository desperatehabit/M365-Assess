"use client";

// Directory Audits table (EPIC-032 SPEC.md §3.4, §6; T-0622, T-0628).
// Renders the T-0622 directory endpoint with the §3.4 columns (Timestamp ·
// Activity · Initiated by · Target · Result) and filters by category and date.
// Zero colour literals: report theme tokens only.

import React, { useCallback, useEffect, useState, type CSSProperties, type ReactElement } from "react";

export const AUDIT_DIRECTORY_CATEGORIES = [
  "UserManagement",
  "GroupManagement",
  "ApplicationManagement",
  "RoleManagement",
  "DirectoryManagement",
  "PolicyManagement",
  "ResourceManagement",
] as const;
export type AuditDirectoryCategory = (typeof AUDIT_DIRECTORY_CATEGORIES)[number];

export interface AuditDirectoryEntry {
  readonly timestamp: string;
  readonly activity: string;
  readonly initiatedBy: string;
  readonly target: string;
  readonly result: string;
}

export interface AuditDirectoryRun {
  readonly tenantId: string;
  readonly category: string;
  readonly totalCount: number;
  readonly entries: readonly AuditDirectoryEntry[];
}

export interface AuditDirectoryFilters {
  readonly category?: string;
  readonly startDate?: string;
  readonly endDate?: string;
  readonly top?: number;
}

export type Fetcher = typeof fetch;

async function readError(response: Response, what: string): Promise<Error> {
  let detail = response.statusText;
  try {
    const body = (await response.json()) as { message?: string };
    if (body?.message) detail = body.message;
  } catch {
    // non-JSON error body; keep the status text
  }
  return new Error(`${what} failed: ${response.status} ${detail}`);
}

export function auditDirectoryPath(tenantId: string, filters: AuditDirectoryFilters): string {
  const params = new URLSearchParams();
  if (filters.category) params.set("category", filters.category);
  if (filters.startDate) params.set("startDate", filters.startDate);
  if (filters.endDate) params.set("endDate", filters.endDate);
  if (filters.top !== undefined) params.set("top", String(filters.top));
  const query = params.toString();
  const base = `/v1/tenants/${encodeURIComponent(tenantId)}/audit/directory`;
  return query ? `${base}?${query}` : base;
}

export async function fetchAuditDirectory(
  tenantId: string,
  filters: AuditDirectoryFilters,
  fetcher?: Fetcher,
): Promise<AuditDirectoryRun> {
  const response = await (fetcher ?? fetch)(auditDirectoryPath(tenantId, filters));
  if (!response.ok) {
    throw await readError(response, "Loading directory audits");
  }
  return (await response.json()) as AuditDirectoryRun;
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
  background: "var(--accent)",
  border: "1px solid var(--accent)",
  borderRadius: "6px",
  color: "var(--on-accent)",
  fontSize: "14px",
  fontWeight: 500,
  cursor: "pointer",
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

const successBadgeStyle: CSSProperties = {
  ...badgeBaseStyle,
  background: "var(--success-soft)",
  color: "var(--success-text)",
  border: "1px solid var(--success)",
};

const dangerBadgeStyle: CSSProperties = {
  ...badgeBaseStyle,
  background: "var(--danger-soft)",
  color: "var(--danger-text)",
  border: "1px solid var(--danger)",
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

// ─── Helpers ────────────────────────────────────────────────────────────────

function resultBadgeStyleFor(result: string): CSSProperties {
  const normalized = result.trim().toLowerCase();
  if (normalized.startsWith("fail") || normalized === "error") {
    return dangerBadgeStyle;
  }
  if (normalized.startsWith("success") || normalized === "ok" || normalized === "passed") {
    return successBadgeStyle;
  }
  return badgeBaseStyle;
}

// ─── Component ──────────────────────────────────────────────────────────────

export interface DirectoryAuditsTableProps {
  readonly tenantId: string;
  readonly fetcher?: Fetcher;
}

export function DirectoryAuditsTable({ tenantId, fetcher }: DirectoryAuditsTableProps): ReactElement {
  const [category, setCategory] = useState("");
  const [startDate, setStartDate] = useState("");
  const [endDate, setEndDate] = useState("");
  const [entries, setEntries] = useState<readonly AuditDirectoryEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(
    async (filters: AuditDirectoryFilters): Promise<void> => {
      const id = tenantId.trim();
      if (!id) {
        setEntries([]);
        setError(null);
        return;
      }
      setLoading(true);
      setError(null);
      try {
        const run = await fetchAuditDirectory(id, filters, fetcher);
        setEntries(run.entries);
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
        setEntries([]);
      } finally {
        setLoading(false);
      }
    },
    [tenantId, fetcher],
  );

  useEffect(() => {
    void load({});
  }, [load]);

  const applyFilters = (): void => {
    void load({
      category: category || undefined,
      startDate: startDate.trim() || undefined,
      endDate: endDate.trim() || undefined,
    });
  };

  return (
    <div style={containerStyle} data-testid="directory-audits-table">
      <div style={filterBarStyle} data-testid="directory-filters">
        <label style={fieldStyle}>
          Category
          <select
            style={selectStyle}
            aria-label="Category"
            data-testid="directory-filter-category"
            value={category}
            onChange={(event) => setCategory(event.target.value)}
          >
            <option value="">All categories</option>
            {AUDIT_DIRECTORY_CATEGORIES.map((name) => (
              <option key={name} value={name}>
                {name}
              </option>
            ))}
          </select>
        </label>
        <label style={fieldStyle}>
          Start date
          <input
            type="datetime-local"
            style={inputStyle}
            aria-label="Start date"
            data-testid="directory-filter-start-date"
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
            data-testid="directory-filter-end-date"
            value={endDate}
            onChange={(event) => setEndDate(event.target.value)}
          />
        </label>
        <button
          type="button"
          style={buttonStyle}
          data-testid="directory-apply"
          onClick={applyFilters}
        >
          Apply filters
        </button>
      </div>

      {error && (
        <div style={errorStyle} role="alert" data-testid="directory-audits-error">
          {error}
        </div>
      )}

      {!tenantId.trim() && (
        <div style={noticeStyle} data-testid="directory-audits-no-tenant">
          Select a tenant to see its directory audits.
        </div>
      )}

      {loading && <div data-testid="directory-audits-loading">Loading directory audits…</div>}

      {!loading && (
        <div style={tableWrapStyle}>
          <table style={tableStyle} className="DataTable" data-testid="directory-audits-grid">
            <thead>
              <tr>
                <th style={thStyle}>Timestamp</th>
                <th style={thStyle}>Activity</th>
                <th style={thStyle}>Initiated by</th>
                <th style={thStyle}>Target</th>
                <th style={thStyle}>Result</th>
              </tr>
            </thead>
            <tbody>
              {entries.map((entry, index) => (
                <tr key={`${entry.timestamp}-${index}`} data-testid={`directory-audit-row-${index}`}>
                  <td style={{ ...tdStyle, ...monoStyle }} data-testid={`directory-audit-timestamp-${index}`}>
                    {entry.timestamp}
                  </td>
                  <td style={tdStyle} data-testid={`directory-audit-activity-${index}`}>
                    {entry.activity}
                  </td>
                  <td style={tdStyle} data-testid={`directory-audit-initiatedby-${index}`}>
                    {entry.initiatedBy}
                  </td>
                  <td style={{ ...tdStyle, ...monoStyle }} data-testid={`directory-audit-target-${index}`}>
                    {entry.target}
                  </td>
                  <td style={tdStyle} data-testid={`directory-audit-result-${index}`}>
                    <span
                      className="status-badge"
                      style={resultBadgeStyleFor(entry.result)}
                      data-testid={`directory-audit-badge-${index}`}
                    >
                      {entry.result}
                    </span>
                  </td>
                </tr>
              ))}
              {entries.length === 0 && (
                <tr>
                  <td
                    colSpan={5}
                    style={{ ...tdStyle, textAlign: "center", color: "var(--text-soft)" }}
                    data-testid="directory-audits-empty"
                  >
                    No directory audits match the current filters.
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
