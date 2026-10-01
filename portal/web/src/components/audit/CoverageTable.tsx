"use client";

// Search Coverage table (EPIC-032 SPEC.md §3.3, §4.2, §5, §6, §8; T-0624, T-0628).
// Renders the T-0624 coverage endpoint per tenant: audit-log ingestion state, the
// search window (last search instant), and gaps. Gaps render as .status-badge
// chips that link to the finding's EPIC-006 remediation. Zero colour literals:
// report theme tokens only.

import React, { useCallback, useEffect, useState, type CSSProperties, type ReactElement } from "react";

export interface AuditCoverageGap {
  readonly checkId: string;
  readonly title: string;
  readonly description: string;
  readonly remediation: string;
  readonly findingId: string | null;
  readonly runId: string | null;
}

export interface AuditCoverage {
  readonly tenantId: string;
  readonly auditEnabled: boolean;
  readonly lastSearchAt: string | null;
  readonly gaps: readonly AuditCoverageGap[];
}

export type Fetcher = typeof fetch;

// EPIC-006 remediation link convention: the remediation history filtered to the
// check that the gap ties to (mirrors ApplyActionDialog's `?check=` link).
export function auditRemediationHref(gap: Pick<AuditCoverageGap, "checkId">): string {
  return `/remediation/history?check=${encodeURIComponent(gap.checkId)}`;
}

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

export async function fetchAuditCoverage(
  tenantId: string,
  fetcher?: Fetcher,
): Promise<AuditCoverage> {
  const response = await (fetcher ?? fetch)(
    `/v1/tenants/${encodeURIComponent(tenantId)}/audit/coverage`,
  );
  if (!response.ok) {
    throw await readError(response, "Loading audit coverage");
  }
  return (await response.json()) as AuditCoverage;
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

const enabledBadgeStyle: CSSProperties = {
  ...badgeBaseStyle,
  background: "var(--success-soft)",
  color: "var(--success-text)",
  border: "1px solid var(--success)",
};

const disabledBadgeStyle: CSSProperties = {
  ...badgeBaseStyle,
  background: "var(--danger-soft)",
  color: "var(--danger-text)",
  border: "1px solid var(--danger)",
};

const gapChipStyle: CSSProperties = {
  ...disabledBadgeStyle,
  textDecoration: "none",
};

const gapRowStyle: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: "8px",
  flexWrap: "wrap",
  marginBottom: "4px",
};

const gapTitleStyle: CSSProperties = {
  fontSize: "12px",
  color: "var(--text-soft)",
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

function formatDateTime(value: string | null): string {
  if (!value) return "—";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
}

// ─── Component ──────────────────────────────────────────────────────────────

export interface CoverageTableProps {
  readonly tenantId: string;
  readonly fetcher?: Fetcher;
}

export function CoverageTable({ tenantId, fetcher }: CoverageTableProps): ReactElement {
  const [coverage, setCoverage] = useState<AuditCoverage | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async (): Promise<void> => {
    const id = tenantId.trim();
    if (!id) {
      setCoverage(null);
      setError(null);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      setCoverage(await fetchAuditCoverage(id, fetcher));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setCoverage(null);
    } finally {
      setLoading(false);
    }
  }, [tenantId, fetcher]);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <div style={containerStyle} data-testid="coverage-table">
      {error && (
        <div style={errorStyle} role="alert" data-testid="coverage-error">
          {error}
        </div>
      )}

      {!tenantId.trim() && (
        <div style={noticeStyle} data-testid="coverage-no-tenant">
          Select a tenant to see its audit-log search coverage.
        </div>
      )}

      {loading && <div data-testid="coverage-loading">Loading audit coverage…</div>}

      {!loading && tenantId.trim() && !error && !coverage && (
        <div style={noticeStyle} data-testid="coverage-empty">
          No audit coverage reported for this tenant.
        </div>
      )}

      {!loading && coverage && (
        <div style={tableWrapStyle}>
          <table style={tableStyle} className="DataTable" data-testid="coverage-grid">
            <thead>
              <tr>
                <th style={thStyle}>Tenant</th>
                <th style={thStyle}>Audit ingestion</th>
                <th style={thStyle}>Search window</th>
                <th style={thStyle}>Gaps</th>
              </tr>
            </thead>
            <tbody>
              <tr data-testid={`coverage-row-${coverage.tenantId}`}>
                <td style={{ ...tdStyle, ...monoStyle }} data-testid={`coverage-tenant-${coverage.tenantId}`}>
                  {coverage.tenantId}
                </td>
                <td style={tdStyle} data-testid={`coverage-ingestion-${coverage.tenantId}`}>
                  <span
                    className="status-badge"
                    style={coverage.auditEnabled ? enabledBadgeStyle : disabledBadgeStyle}
                    data-testid={`coverage-ingestion-badge-${coverage.tenantId}`}
                  >
                    {coverage.auditEnabled ? "Enabled" : "Disabled"}
                  </span>
                </td>
                <td style={{ ...tdStyle, ...monoStyle }} data-testid={`coverage-window-${coverage.tenantId}`}>
                  {formatDateTime(coverage.lastSearchAt)}
                </td>
                <td style={tdStyle} data-testid={`coverage-gaps-${coverage.tenantId}`}>
                  {coverage.gaps.length === 0 ? (
                    <span
                      className="status-badge"
                      style={enabledBadgeStyle}
                      data-testid={`coverage-no-gaps-${coverage.tenantId}`}
                    >
                      No gaps
                    </span>
                  ) : (
                    coverage.gaps.map((gap) => (
                      <div key={gap.checkId} style={gapRowStyle}>
                        <a
                          className="status-badge"
                          style={gapChipStyle}
                          href={auditRemediationHref(gap)}
                          title={gap.remediation}
                          data-testid={`coverage-gap-${gap.checkId}`}
                        >
                          {gap.checkId}
                        </a>
                        <span style={gapTitleStyle}>{gap.title}</span>
                      </div>
                    ))
                  )}
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
