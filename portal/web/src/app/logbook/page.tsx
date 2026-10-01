"use client";

// Logbook page (EPIC-037 SPEC.md §3.5, §4.4; T-0729). Read-only view over
// GET /v1/logbook with actor/action/tenant/result/date filters, per-entry detail with
// correlation IDs, and a CSV export of the filtered set. The export is a plain link so
// the browser downloads the audited CSV from the same endpoint the API exposes.

import { useCallback, useEffect, useState, type CSSProperties, type ReactElement } from "react";

export const LOGBOOK_API_PATH = "/v1/logbook";

export type LogbookResult = "success" | "failure";

export interface LogbookEntry {
  readonly id: string;
  readonly timestamp: string;
  readonly actor: string | null;
  readonly actorType: string;
  readonly tenantId: string | null;
  readonly action: string;
  readonly targetType: string | null;
  readonly targetId: string | null;
  readonly result: LogbookResult;
  readonly error: string | null;
  readonly correlationId: string | null;
}

export interface LogbookFilters {
  readonly actor: string;
  readonly action: string;
  readonly tenant: string;
  readonly result: "" | LogbookResult;
  readonly from: string;
  readonly to: string;
}

export interface LogbookPage {
  readonly items: readonly LogbookEntry[];
  readonly nextCursor: string | null;
  readonly totalCount: number;
}

export const EMPTY_LOGBOOK_FILTERS: LogbookFilters = {
  actor: "",
  action: "",
  tenant: "",
  result: "",
  from: "",
  to: "",
};

export function buildLogbookQuery(filters: LogbookFilters): string {
  const params = new URLSearchParams();
  if (filters.actor.trim().length > 0) params.set("actor", filters.actor.trim());
  if (filters.action.trim().length > 0) params.set("action", filters.action.trim());
  if (filters.tenant.trim().length > 0) params.set("tenant", filters.tenant.trim());
  if (filters.result.length > 0) params.set("result", filters.result);
  if (filters.from.trim().length > 0) params.set("from", filters.from.trim());
  if (filters.to.trim().length > 0) params.set("to", filters.to.trim());
  return params.toString();
}

export async function loadLogbook(
  filters: LogbookFilters,
  fetcher: typeof fetch = fetch,
): Promise<LogbookPage> {
  const query = buildLogbookQuery(filters);
  const response = await fetcher(`${LOGBOOK_API_PATH}${query.length > 0 ? `?${query}` : ""}`);
  if (!response.ok) {
    let detail = `HTTP ${response.status}`;
    try {
      const body = (await response.json()) as { message?: string };
      if (typeof body.message === "string") detail = body.message;
    } catch {
      // non-JSON error body; keep the status
    }
    throw new Error(`Failed to load logbook: ${detail}`);
  }
  return (await response.json()) as LogbookPage;
}

export function logbookExportHref(filters: LogbookFilters): string {
  const query = buildLogbookQuery(filters);
  return `${LOGBOOK_API_PATH}?${query.length > 0 ? `${query}&` : ""}format=csv`;
}

const pageStyle: CSSProperties = {
  padding: "28px 40px",
  maxWidth: "1800px",
  color: "var(--text)",
  fontFamily: "var(--font-sans, system-ui, -apple-system, sans-serif)",
};

const breadcrumbStyle: CSSProperties = {
  fontSize: "12px",
  fontWeight: 600,
  letterSpacing: "0.08em",
  textTransform: "uppercase",
  color: "var(--muted)",
  marginBottom: "12px",
  fontFamily: "var(--font-mono, monospace)",
};

const headingStyle: CSSProperties = {
  fontSize: "24px",
  fontWeight: 700,
  marginBottom: "20px",
  color: "var(--text)",
};

const filterBarStyle: CSSProperties = {
  display: "flex",
  flexWrap: "wrap",
  gap: "10px",
  alignItems: "flex-end",
  marginBottom: "20px",
  padding: "16px",
  background: "var(--bg-elev)",
  border: "1px solid var(--border)",
  borderRadius: "var(--radius, 10px)",
};

const fieldStyle: CSSProperties = {
  background: "var(--input-bg)",
  border: "1px solid var(--border)",
  borderRadius: "6px",
  color: "var(--text)",
  padding: "6px 8px",
  fontFamily: "var(--font-sans, system-ui, -apple-system, sans-serif)",
};

const labelStyle: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: "4px",
  fontSize: "12px",
  fontWeight: 600,
  letterSpacing: "0.07em",
  textTransform: "uppercase",
  color: "var(--muted)",
  fontFamily: "var(--font-mono, monospace)",
};

const tableStyle: CSSProperties = {
  width: "100%",
  borderCollapse: "collapse",
  fontSize: "13px",
};

const thStyle: CSSProperties = {
  textAlign: "left",
  padding: "8px",
  borderBottom: "1px solid var(--border-strong)",
  color: "var(--muted)",
  fontFamily: "var(--font-mono, monospace)",
  textTransform: "uppercase",
  fontSize: "11px",
};

const tdStyle: CSSProperties = {
  padding: "8px",
  borderBottom: "1px solid var(--border)",
  color: "var(--text)",
};

const resultToken = (result: LogbookResult): CSSProperties =>
  result === "success"
    ? { color: "var(--success-text)", fontWeight: 600 }
    : { color: "var(--danger-text)", fontWeight: 600 };

export default function LogbookPageView(): ReactElement {
  const [filters, setFilters] = useState<LogbookFilters>(EMPTY_LOGBOOK_FILTERS);
  const [applied, setApplied] = useState<LogbookFilters>(EMPTY_LOGBOOK_FILTERS);
  const [page, setPage] = useState<LogbookPage | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    setLoading(true);
    setError(null);
    void (async () => {
      try {
        const loaded = await loadLogbook(applied);
        if (active) setPage(loaded);
      } catch (cause) {
        if (active) setError(cause instanceof Error ? cause.message : "Failed to load logbook.");
      } finally {
        if (active) setLoading(false);
      }
    })();
    return () => {
      active = false;
    };
  }, [applied]);

  const search = useCallback(() => {
    setApplied({ ...filters });
  }, [filters]);

  const items = page?.items ?? [];

  return (
    <div style={pageStyle} data-testid="logbook-page">
      <div style={breadcrumbStyle}>Application Settings &rarr; Logbook</div>
      <h1 style={headingStyle}>Logbook</h1>

      <div style={filterBarStyle} role="search">
        <label style={labelStyle}>
          Actor
          <input
            type="text"
            aria-label="Filter by actor"
            data-testid="logbook-filter-actor"
            value={filters.actor}
            onChange={(event) => setFilters({ ...filters, actor: event.target.value })}
            style={fieldStyle}
          />
        </label>
        <label style={labelStyle}>
          Action
          <input
            type="text"
            aria-label="Filter by action"
            data-testid="logbook-filter-action"
            value={filters.action}
            onChange={(event) => setFilters({ ...filters, action: event.target.value })}
            style={fieldStyle}
          />
        </label>
        <label style={labelStyle}>
          Tenant
          <input
            type="text"
            aria-label="Filter by tenant"
            data-testid="logbook-filter-tenant"
            value={filters.tenant}
            onChange={(event) => setFilters({ ...filters, tenant: event.target.value })}
            style={fieldStyle}
          />
        </label>
        <label style={labelStyle}>
          Result
          <select
            aria-label="Filter by result"
            data-testid="logbook-filter-result"
            value={filters.result}
            onChange={(event) =>
              setFilters({ ...filters, result: event.target.value as LogbookFilters["result"] })
            }
            style={fieldStyle}
          >
            <option value="">All</option>
            <option value="success">Success</option>
            <option value="failure">Failure</option>
          </select>
        </label>
        <label style={labelStyle}>
          From
          <input
            type="date"
            aria-label="Filter from date"
            data-testid="logbook-filter-from"
            value={filters.from}
            onChange={(event) => setFilters({ ...filters, from: event.target.value })}
            style={fieldStyle}
          />
        </label>
        <label style={labelStyle}>
          To
          <input
            type="date"
            aria-label="Filter to date"
            data-testid="logbook-filter-to"
            value={filters.to}
            onChange={(event) => setFilters({ ...filters, to: event.target.value })}
            style={fieldStyle}
          />
        </label>
        <button type="button" data-testid="logbook-search" onClick={search} style={fieldStyle}>
          Search
        </button>
        <a
          data-testid="logbook-export"
          href={logbookExportHref(applied)}
          download="logbook.csv"
          style={fieldStyle}
        >
          Export CSV
        </a>
      </div>

      {loading ? (
        <p data-testid="logbook-loading" style={{ color: "var(--muted)" }}>
          Loading logbook...
        </p>
      ) : null}
      {error !== null ? (
        <p role="alert" data-testid="logbook-error" style={{ color: "var(--danger-text)" }}>
          {error}
        </p>
      ) : null}

      {!loading && error === null ? (
        <table data-testid="logbook-table" style={tableStyle}>
          <thead>
            <tr>
              <th style={thStyle}>Timestamp</th>
              <th style={thStyle}>Actor</th>
              <th style={thStyle}>Action</th>
              <th style={thStyle}>Tenant</th>
              <th style={thStyle}>Result</th>
              <th style={thStyle}>Correlation ID</th>
              <th style={thStyle}>Detail</th>
            </tr>
          </thead>
          <tbody>
            {items.length === 0 ? (
              <tr>
                <td style={tdStyle} colSpan={7} data-testid="logbook-empty">
                  No logbook entries match the current filters.
                </td>
              </tr>
            ) : (
              items.map((entry) => (
                <tr key={entry.id} data-testid={`logbook-row-${entry.id}`}>
                  <td style={tdStyle}>{entry.timestamp}</td>
                  <td style={tdStyle}>{entry.actor ?? entry.actorType}</td>
                  <td style={tdStyle}>{entry.action}</td>
                  <td style={tdStyle}>{entry.tenantId ?? "—"}</td>
                  <td style={{ ...tdStyle, ...resultToken(entry.result) }}>{entry.result}</td>
                  <td style={tdStyle}>{entry.correlationId ?? "—"}</td>
                  <td style={tdStyle}>
                    <button
                      type="button"
                      data-testid={`logbook-detail-${entry.id}`}
                      aria-expanded={expanded === entry.id}
                      onClick={() => setExpanded(expanded === entry.id ? null : entry.id)}
                    >
                      {expanded === entry.id ? "Hide" : "Details"}
                    </button>
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      ) : null}

      {expanded !== null
        ? (() => {
            const entry = items.find((item) => item.id === expanded);
            if (entry === undefined) return null;
            return (
              <div
                data-testid={`logbook-detail-panel-${entry.id}`}
                style={{
                  marginTop: "12px",
                  padding: "16px",
                  background: "var(--bg-elev)",
                  border: "1px solid var(--border)",
                  borderRadius: "var(--radius, 10px)",
                  fontSize: "13px",
                }}
              >
                <div>Target: {entry.targetType ?? "—"} {entry.targetId ?? ""}</div>
                <div>Error: {entry.error ?? "—"}</div>
                <div>Correlation ID: {entry.correlationId ?? "—"}</div>
              </div>
            );
          })()
        : null}

      {page !== null ? (
        <p data-testid="logbook-total" style={{ color: "var(--muted)", fontSize: "12px" }}>
          {page.totalCount} entries
        </p>
      ) : null}
    </div>
  );
}
