"use client";

// Secure Score trend chart (EPIC-031 SPEC.md §2 US-2, §3.2; T-0608).
// Hand-rolled SVG line + area over the append-only SecureScoreSnapshot points
// the T-0604 trend API returns (SPEC §4.2, §5). No charting dependency: the
// series is a percentage 0-100 plotted against observation time, with an
// accessible label per point. Zero colour literals: report theme tokens only.

import React, { type CSSProperties, type ReactElement } from "react";

export interface SecureScoreTrendPoint {
  readonly at: string;
  readonly current: number;
  readonly max: number;
  readonly percentage: number;
}

export interface SecureScoreTrendProps {
  readonly snapshots?: readonly SecureScoreTrendPoint[];
  readonly loading?: boolean;
  readonly error?: string | null;
}

const CHART_WIDTH = 600;
const CHART_HEIGHT = 200;
const PAD_LEFT = 40;
const PAD_RIGHT = 16;
const PAD_TOP = 16;
const PAD_BOTTOM = 28;

const containerStyle: CSSProperties = {
  width: "100%",
  fontFamily: "var(--font-sans, system-ui, sans-serif)",
  color: "var(--text)",
};

const metaStyle: CSSProperties = {
  fontSize: "13px",
  color: "var(--text-soft)",
  margin: "8px 0 0",
};

function clampPercent(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(100, Math.max(0, value));
}

/** Observation day for the axis labels; falls back to the raw value. */
export function formatSnapshotDate(at: string): string {
  return at.length >= 10 ? at.slice(0, 10) : at;
}

export function SecureScoreTrend({
  snapshots = [],
  loading = false,
  error = null,
}: SecureScoreTrendProps): ReactElement {
  if (loading) {
    return <div data-testid="secure-score-trend-loading">Loading Secure Score trend…</div>;
  }
  if (error) {
    return (
      <div
        data-testid="secure-score-trend-error"
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
  if (snapshots.length === 0) {
    return (
      <p style={metaStyle} data-testid="secure-score-trend-empty">
        No Secure Score snapshots yet — the trend accumulates with the daily snapshot job.
      </p>
    );
  }

  const innerWidth = CHART_WIDTH - PAD_LEFT - PAD_RIGHT;
  const innerHeight = CHART_HEIGHT - PAD_TOP - PAD_BOTTOM;
  const baselineY = PAD_TOP + innerHeight;

  const coordinates = snapshots.map((snapshot, index) => {
    const x =
      snapshots.length === 1
        ? PAD_LEFT + innerWidth / 2
        : PAD_LEFT + (index * innerWidth) / (snapshots.length - 1);
    const percentage = clampPercent(snapshot.percentage);
    const y = PAD_TOP + (1 - percentage / 100) * innerHeight;
    return { x, y, percentage, snapshot };
  });

  const first = coordinates[0]!;
  const last = coordinates[coordinates.length - 1]!;
  const linePath = coordinates
    .map((coord, index) => `${index === 0 ? "M" : "L"}${coord.x.toFixed(1)},${coord.y.toFixed(1)}`)
    .join(" ");
  const areaPath = `${linePath} L${last.x.toFixed(1)},${baselineY.toFixed(1)} L${first.x.toFixed(1)},${baselineY.toFixed(1)} Z`;

  return (
    <div style={containerStyle} data-testid="secure-score-trend">
      <svg
        viewBox={`0 0 ${CHART_WIDTH} ${CHART_HEIGHT}`}
        width="100%"
        role="img"
        aria-label={`Secure Score trend, ${snapshots.length} snapshot${snapshots.length === 1 ? "" : "s"} from ${formatSnapshotDate(first.snapshot.at)} to ${formatSnapshotDate(last.snapshot.at)}`}
        data-testid="secure-score-trend-svg"
        data-points={snapshots.length}
      >
        <defs>
          <linearGradient id="secure-score-trend-grad" x1="0" y1="0" x2="1" y2="0">
            <stop offset="0%" stopColor="var(--accent)" />
            <stop offset="100%" stopColor="var(--accent-text)" />
          </linearGradient>
          <linearGradient id="secure-score-trend-area" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="var(--accent)" stopOpacity={0.28} />
            <stop offset="100%" stopColor="var(--accent)" stopOpacity={0} />
          </linearGradient>
        </defs>
        {[0, 25, 50, 75, 100].map((value) => {
          const y = PAD_TOP + (1 - value / 100) * innerHeight;
          return (
            <g key={value}>
              <line
                x1={PAD_LEFT}
                y1={y}
                x2={CHART_WIDTH - PAD_RIGHT}
                y2={y}
                stroke="var(--border)"
                strokeWidth={1}
              />
              <text
                x={PAD_LEFT - 6}
                y={y + 4}
                textAnchor="end"
                fontSize={10}
                fill="var(--text-soft)"
              >
                {`${value}%`}
              </text>
            </g>
          );
        })}
        <path d={areaPath} fill="url(#secure-score-trend-area)" stroke="none" data-testid="secure-score-trend-area" />
        <path
          d={linePath}
          fill="none"
          stroke="url(#secure-score-trend-grad)"
          strokeWidth={2}
          data-testid="secure-score-trend-path"
        />
        {coordinates.map((coord, index) => (
          <circle
            key={`${coord.snapshot.at}-${index}`}
            cx={coord.x}
            cy={coord.y}
            r={3}
            fill="var(--accent)"
            data-testid={`secure-score-trend-point-${index}`}
          >
            <title>{`${formatSnapshotDate(coord.snapshot.at)}: ${coord.percentage.toFixed(1)}%`}</title>
          </circle>
        ))}
      </svg>
      <p style={metaStyle} data-testid="secure-score-trend-range">
        {formatSnapshotDate(first.snapshot.at)} → {formatSnapshotDate(last.snapshot.at)} ·{" "}
        {snapshots.length} snapshot{snapshots.length === 1 ? "" : "s"}
      </p>
    </div>
  );
}
