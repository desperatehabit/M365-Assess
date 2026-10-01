"use client";

// Secure Score peer comparison (EPIC-031 SPEC.md §2 US-3, §3.3, §9, §11.3;
// T-0608). Bars compare the tenant's score against the similar-organisation
// and all-organisation benchmarks the T-0605 peers API returns, with the
// benchmark marked on the tenant bar. Microsoft frequently omits the comparison
// fields, so when the response reports `available: false` (or carries no
// entries) this renders an explicit empty state rather than fabricated bars.
// Zero colour literals: report theme tokens only.

import React, { type CSSProperties, type ReactElement } from "react";

export interface SecureScoreComparison {
  readonly basis: string;
  readonly averageScore: number;
}

export interface SecureScorePeersData {
  readonly tenantId: string;
  readonly available: boolean;
  readonly comparisons: readonly SecureScoreComparison[];
}

export interface PeerComparisonProps {
  readonly peers?: SecureScorePeersData | null;
  readonly tenantPercentage: number;
  readonly loading?: boolean;
  readonly error?: string | null;
}

const containerStyle: CSSProperties = {
  width: "100%",
  fontFamily: "var(--font-sans, system-ui, sans-serif)",
  color: "var(--text)",
  display: "flex",
  flexDirection: "column",
  gap: "14px",
};

const listStyle: CSSProperties = {
  listStyle: "none",
  margin: 0,
  padding: 0,
  display: "flex",
  flexDirection: "column",
  gap: "12px",
};

const rowHeaderStyle: CSSProperties = {
  display: "flex",
  justifyContent: "space-between",
  fontSize: "13px",
  marginBottom: "6px",
};

const trackStyle: CSSProperties = {
  position: "relative",
  height: "10px",
  background: "var(--track)",
  borderRadius: "999px",
  overflow: "hidden",
};

const barStyle: CSSProperties = {
  height: "100%",
  background: "var(--accent)",
  borderRadius: "999px",
};

const tenantBarStyle: CSSProperties = {
  ...barStyle,
  background: "var(--accent-grad, var(--accent))",
};

const markerStyle: CSSProperties = {
  position: "absolute",
  top: "-3px",
  bottom: "-3px",
  width: "2px",
  background: "var(--accent-text)",
  borderRadius: "1px",
};

const emptyStyle: CSSProperties = {
  padding: "14px 16px",
  background: "var(--surface)",
  border: "1px dashed var(--border)",
  borderRadius: "var(--radius, 10px)",
  color: "var(--muted)",
  fontSize: "13px",
  margin: 0,
};

function clampPercent(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(100, Math.max(0, value));
}

/** Human-readable label for a Graph averageComparativeScores basis. */
export function peerBasisLabel(basis: string): string {
  const normalized = basis.toLowerCase();
  if (normalized.includes("all")) return "All organisations";
  if (normalized.includes("similar") || normalized.includes("vertical")) {
    return "Similar organisations";
  }
  return basis;
}

/** The benchmark marked on the tenant bar: Microsoft's all-organisations value when present. */
export function selectPeerBenchmark(peers: SecureScorePeersData | null | undefined): number | null {
  if (!peers || !peers.available || peers.comparisons.length === 0) return null;
  const chosen =
    peers.comparisons.find((comparison) => comparison.basis.toLowerCase().includes("all")) ??
    peers.comparisons[0];
  return chosen && Number.isFinite(chosen.averageScore) ? chosen.averageScore : null;
}

function ComparisonRow(props: {
  readonly label: string;
  readonly value: number;
  readonly testId: string;
  readonly tenant?: boolean;
  readonly benchmark?: number | null;
}): ReactElement {
  const percentage = clampPercent(props.value);
  return (
    <li data-testid={props.testId} data-basis={props.label}>
      <div style={rowHeaderStyle}>
        <span style={{ fontWeight: props.tenant ? 700 : 500 }}>{props.label}</span>
        <span style={{ fontFamily: "var(--font-mono, monospace)" }}>{percentage.toFixed(1)}%</span>
      </div>
      <div
        style={trackStyle}
        role="img"
        aria-label={`${props.label}: ${percentage.toFixed(1)}%`}
      >
        <div
          style={{ ...(props.tenant ? tenantBarStyle : barStyle), width: `${percentage}%` }}
          data-testid={`${props.testId}-bar`}
        />
        {props.tenant && props.benchmark != null && Number.isFinite(props.benchmark) && (
          <div
            style={{ ...markerStyle, left: `${clampPercent(props.benchmark)}%` }}
            data-testid="peer-benchmark-marker"
            title={`Peer benchmark ${clampPercent(props.benchmark).toFixed(1)}%`}
          />
        )}
      </div>
    </li>
  );
}

export function PeerComparison({
  peers = null,
  tenantPercentage,
  loading = false,
  error = null,
}: PeerComparisonProps): ReactElement {
  if (loading) {
    return <div data-testid="peer-comparison-loading">Loading peer comparison…</div>;
  }
  if (error) {
    return (
      <div
        data-testid="peer-comparison-error"
        style={{
          padding: "10px 14px",
          background: "var(--danger-soft)",
          border: "1px solid var(--danger)",
          borderRadius: "6px",
          color: "var(--danger-text)",
          fontSize: "13px",
        }}
      >
        {error}
      </div>
    );
  }
  if (!peers || !peers.available || peers.comparisons.length === 0) {
    return (
      <div data-testid="peer-comparison-empty">
        <p style={emptyStyle}>
          Peer comparison unavailable — Microsoft did not provide comparison data for this tenant.
        </p>
      </div>
    );
  }

  const benchmark = selectPeerBenchmark(peers);

  return (
    <div style={containerStyle} data-testid="peer-comparison">
      <ul style={listStyle} aria-label="Secure Score peer comparison">
        <ComparisonRow
          label="This tenant"
          value={tenantPercentage}
          testId="peer-row-tenant"
          tenant
          benchmark={benchmark}
        />
        {peers.comparisons.map((comparison) => (
          <ComparisonRow
            key={comparison.basis}
            label={peerBasisLabel(comparison.basis)}
            value={comparison.averageScore}
            testId={`peer-row-${comparison.basis}`}
          />
        ))}
      </ul>
    </div>
  );
}
