"use client";

// Fleet Secure Score overview (EPIC-031 SPEC.md §2 US-6, §3.5, §6, §7; T-0609).
// Loads the latest snapshot per visible tenant from GET /v1/secure-score/fleet
// (T-0606) and renders a sortable table with a trend sparkline per row; each
// row links to the tenant report (T-0607). A tenant with no snapshot shows an
// explicit empty state. Read-only; report theme tokens only (zero colour
// literals).

import React, { useEffect, useMemo, useState, type CSSProperties, type ReactElement } from "react";

export interface SecureScoreFleetTrendPoint {
  readonly at: string;
  readonly percentage: number;
}

export interface SecureScoreFleetTenant {
  readonly tenantId: string;
  readonly hasSnapshot: boolean;
  readonly at: string | null;
  readonly current: number | null;
  readonly max: number | null;
  readonly percentage: number | null;
  readonly trend: readonly SecureScoreFleetTrendPoint[];
}

export interface SecureScoreFleet {
  readonly tenants: readonly SecureScoreFleetTenant[];
}

type SortColumn = "tenant" | "score" | "percentage" | "snapshot";
type SortDirection = "asc" | "desc";

const SPARKLINE_WIDTH = 96;
const SPARKLINE_HEIGHT = 28;
const SPARKLINE_PADDING = 3;

function formatPoints(value: number | null): string {
  if (value === null || !Number.isFinite(value)) return "0";
  return Number.isInteger(value) ? String(value) : value.toFixed(1);
}

function formatPercent(value: number | null): string {
  if (value === null || !Number.isFinite(value)) return "—";
  return `${value.toFixed(1)}%`;
}

function formatSnapshot(iso: string | null): string {
  if (!iso) return "—";
  try {
    return new Date(iso).toLocaleString(undefined, {
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });
  } catch {
    return iso;
  }
}

function Sparkline(props: {
  readonly trend: readonly SecureScoreFleetTrendPoint[];
  readonly tenantId: string;
}): ReactElement | null {
  const { trend, tenantId } = props;
  if (trend.length === 0) return null;

  const percentages = trend.map((point) => point.percentage);
  const min = Math.min(...percentages);
  const max = Math.max(...percentages);
  const range = max - min;
  const innerWidth = SPARKLINE_WIDTH - SPARKLINE_PADDING * 2;
  const innerHeight = SPARKLINE_HEIGHT - SPARKLINE_PADDING * 2;
  const xAt = (index: number): number =>
    trend.length === 1
      ? SPARKLINE_WIDTH / 2
      : SPARKLINE_PADDING + (index / (trend.length - 1)) * innerWidth;
  const yAt = (value: number): number =>
    range === 0
      ? SPARKLINE_HEIGHT / 2
      : SPARKLINE_PADDING + (1 - (value - min) / range) * innerHeight;
  const line = trend
    .map(
      (point, i) =>
        `${i === 0 ? "M" : "L"}${xAt(i).toFixed(1)},${yAt(point.percentage).toFixed(1)}`,
    )
    .join(" ");
  const area = `${line} L${xAt(trend.length - 1).toFixed(1)},${SPARKLINE_HEIGHT - SPARKLINE_PADDING} L${xAt(0).toFixed(1)},${SPARKLINE_HEIGHT - SPARKLINE_PADDING} Z`;
  const summary = percentages.map((value) => `${value.toFixed(1)}%`).join(", ");
  const lastIndex = trend.length - 1;

  return (
    <svg
      viewBox={`0 0 ${SPARKLINE_WIDTH} ${SPARKLINE_HEIGHT}`}
      width={SPARKLINE_WIDTH}
      height={SPARKLINE_HEIGHT}
      role="img"
      aria-label={`Score trend for ${tenantId}: ${summary}`}
      data-testid={`fleet-score-trend-${tenantId}`}
      style={{ display: "block" }}
    >
      <title>{`Score trend: ${summary}`}</title>
      {trend.length > 1 && <path d={area} fill="var(--accent)" opacity={0.18} />}
      {trend.length > 1 && (
        <path
          d={line}
          fill="none"
          stroke="var(--accent)"
          strokeWidth={1.8}
          strokeLinejoin="round"
          strokeLinecap="round"
        />
      )}
      <circle
        cx={xAt(lastIndex)}
        cy={yAt(trend[lastIndex].percentage)}
        r={2.5}
        fill="var(--accent)"
      />
    </svg>
  );
}

export default function SecureScoreFleetPage(): ReactElement {
  const [fleet, setFleet] = useState<SecureScoreFleet | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [sortColumn, setSortColumn] = useState<SortColumn>("tenant");
  const [sortDirection, setSortDirection] = useState<SortDirection>("asc");

  useEffect(() => {
    let active = true;
    setLoading(true);
    setError(null);
    void (async () => {
      try {
        const res = await fetch("/v1/secure-score/fleet");
        if (!res.ok) {
          throw new Error(`Failed to load Secure Score fleet: ${res.statusText}`);
        }
        const data = (await res.json()) as SecureScoreFleet;
        if (!active) return;
        setFleet(data);
      } catch (err) {
        if (active) setError(err instanceof Error ? err.message : String(err));
      } finally {
        if (active) setLoading(false);
      }
    })();
    return () => {
      active = false;
    };
  }, []);

  const sortedTenants = useMemo(() => {
    const list = [...(fleet?.tenants ?? [])];
    list.sort((a, b) => {
      let cmp = 0;
      switch (sortColumn) {
        case "tenant":
          cmp = a.tenantId.localeCompare(b.tenantId);
          break;
        case "score":
          cmp = (a.current ?? -1) - (b.current ?? -1);
          break;
        case "percentage":
          cmp = (a.percentage ?? -1) - (b.percentage ?? -1);
          break;
        case "snapshot":
          cmp = (a.at ?? "").localeCompare(b.at ?? "");
          break;
      }
      return sortDirection === "asc" ? cmp : -cmp;
    });
    return list;
  }, [fleet, sortColumn, sortDirection]);

  const handleSort = (column: SortColumn): void => {
    if (sortColumn === column) {
      setSortDirection((prev) => (prev === "asc" ? "desc" : "asc"));
    } else {
      setSortColumn(column);
      setSortDirection("asc");
    }
  };

  const sortIndicator = (column: SortColumn): string =>
    sortColumn === column ? (sortDirection === "asc" ? " ▲" : " ▼") : "";

  if (loading) {
    return (
      <div style={pageStyle} data-testid="secure-score-fleet-loading">
        <div style={{ padding: "64px 0", textAlign: "center", color: "var(--muted)" }}>
          Loading Secure Score fleet…
        </div>
      </div>
    );
  }

  if (error || !fleet) {
    return (
      <div style={pageStyle} data-testid="secure-score-fleet-error">
        <div
          role="alert"
          style={{
            padding: "24px",
            background: "var(--danger-soft)",
            border: "1px solid var(--danger)",
            borderRadius: "var(--radius, 10px)",
            color: "var(--danger-text)",
          }}
        >
          <strong>Error loading Secure Score fleet:</strong> {error ?? "Fleet data not found"}
        </div>
      </div>
    );
  }

  return (
    <div style={pageStyle} data-testid="secure-score-fleet-page">
      <header>
        <div style={eyebrowStyle}>Tenant Administration</div>
        <h1 style={titleStyle} data-testid="secure-score-fleet-title">
          Secure Score — Table Overview
        </h1>
        <p style={subtitleStyle}>
          Microsoft Secure Score for every tenant in scope, with the recent trend per tenant.
        </p>
      </header>

      {sortedTenants.length === 0 ? (
        <div style={emptyStateStyle} data-testid="secure-score-fleet-empty">
          No tenants are in your scope.
        </div>
      ) : (
        <div style={tableWrapperStyle}>
          <table style={tableStyle} data-testid="secure-score-fleet-table">
            <thead>
              <tr>
                <th scope="col" style={thStyle}>
                  <button
                    type="button"
                    data-testid="fleet-sort-tenant"
                    onClick={() => handleSort("tenant")}
                    style={sortButtonStyle}
                  >
                    Tenant{sortIndicator("tenant")}
                  </button>
                </th>
                <th scope="col" style={thStyle}>
                  <button
                    type="button"
                    data-testid="fleet-sort-score"
                    onClick={() => handleSort("score")}
                    style={sortButtonStyle}
                  >
                    Score{sortIndicator("score")}
                  </button>
                </th>
                <th scope="col" style={thStyle}>
                  <button
                    type="button"
                    data-testid="fleet-sort-percentage"
                    onClick={() => handleSort("percentage")}
                    style={sortButtonStyle}
                  >
                    Percentage{sortIndicator("percentage")}
                  </button>
                </th>
                <th scope="col" style={thStyle}>
                  <button
                    type="button"
                    data-testid="fleet-sort-snapshot"
                    onClick={() => handleSort("snapshot")}
                    style={sortButtonStyle}
                  >
                    Last snapshot{sortIndicator("snapshot")}
                  </button>
                </th>
                <th scope="col" style={thStyle}>
                  Trend
                </th>
              </tr>
            </thead>
            <tbody>
              {sortedTenants.map((tenant) => (
                <tr key={tenant.tenantId} data-testid={`fleet-score-row-${tenant.tenantId}`}>
                  <td style={tdStyle}>
                    <a
                      href={`/secure-score/${encodeURIComponent(tenant.tenantId)}`}
                      data-testid={`fleet-score-link-${tenant.tenantId}`}
                      style={rowLinkStyle}
                    >
                      {tenant.tenantId}
                    </a>
                  </td>
                  {tenant.hasSnapshot ? (
                    <>
                      <td
                        style={{ ...tdStyle, ...monoStyle }}
                        data-testid={`fleet-score-points-${tenant.tenantId}`}
                      >
                        {formatPoints(tenant.current)} / {formatPoints(tenant.max)}
                      </td>
                      <td
                        style={{ ...tdStyle, ...monoStyle }}
                        data-testid={`fleet-score-percentage-${tenant.tenantId}`}
                      >
                        {formatPercent(tenant.percentage)}
                      </td>
                      <td
                        style={tdStyle}
                        data-testid={`fleet-score-snapshot-${tenant.tenantId}`}
                      >
                        {formatSnapshot(tenant.at)}
                      </td>
                      <td style={tdStyle}>
                        <Sparkline trend={tenant.trend} tenantId={tenant.tenantId} />
                      </td>
                    </>
                  ) : (
                    <td
                      colSpan={4}
                      style={emptyCellStyle}
                      data-testid={`fleet-score-empty-${tenant.tenantId}`}
                    >
                      No snapshot recorded yet.
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

const pageStyle: CSSProperties = {
  padding: "32px",
  maxWidth: "1400px",
  margin: "0 auto",
  fontFamily: "var(--font-sans, system-ui, sans-serif)",
  color: "var(--text)",
  display: "flex",
  flexDirection: "column",
  gap: "24px",
};

const eyebrowStyle: CSSProperties = {
  fontSize: "12px",
  fontWeight: 600,
  textTransform: "uppercase",
  letterSpacing: "0.08em",
  color: "var(--muted)",
};

const titleStyle: CSSProperties = {
  fontSize: "24px",
  fontWeight: 700,
  margin: "4px 0 0",
  fontFamily: "var(--font-display, var(--font-sans))",
};

const subtitleStyle: CSSProperties = {
  margin: "4px 0 0",
  color: "var(--text-soft)",
  fontSize: "14px",
};

const tableWrapperStyle: CSSProperties = {
  overflowX: "auto",
  background: "var(--bg-elev)",
  border: "1px solid var(--border)",
  borderRadius: "var(--radius, 10px)",
  boxShadow: "var(--shadow-card)",
};

const tableStyle: CSSProperties = {
  width: "100%",
  borderCollapse: "collapse",
  fontSize: "14px",
  textAlign: "left",
};

const thStyle: CSSProperties = {
  padding: "12px 16px",
  borderBottom: "1px solid var(--border)",
  color: "var(--muted)",
  fontSize: "12px",
  fontWeight: 600,
  textTransform: "uppercase",
  letterSpacing: "0.06em",
  whiteSpace: "nowrap",
};

const sortButtonStyle: CSSProperties = {
  background: "none",
  border: "none",
  padding: 0,
  font: "inherit",
  color: "inherit",
  cursor: "pointer",
};

const tdStyle: CSSProperties = {
  padding: "12px 16px",
  borderBottom: "1px solid var(--border)",
  verticalAlign: "middle",
};

const monoStyle: CSSProperties = {
  fontFamily: "var(--font-mono, monospace)",
  fontSize: "13px",
};

const rowLinkStyle: CSSProperties = {
  color: "var(--accent-text)",
  fontWeight: 600,
  textDecoration: "none",
};

const emptyCellStyle: CSSProperties = {
  padding: "12px 16px",
  borderBottom: "1px solid var(--border)",
  color: "var(--muted)",
  fontSize: "13px",
  fontStyle: "italic",
};

const emptyStateStyle: CSSProperties = {
  padding: "48px 24px",
  textAlign: "center",
  color: "var(--muted)",
  fontSize: "14px",
  background: "var(--surface)",
  border: "1px dashed var(--border)",
  borderRadius: "var(--radius, 10px)",
};
