// Domain Analyser history chart (EPIC-034 SPEC.md §3.4; T-0669).
// Renders the stored T-0665 DomainChecks for a domain over time. Each point is
// the check's health score (0-1): the `health.overall` verdict when present,
// otherwise the share of the six record families that pass. The chart is a
// hand-rolled SVG so it stays dependency-free and uses report theme tokens
// only (zero colour literals).

import React, { useMemo, type CSSProperties, type ReactElement } from "react";
import { buildDnsFamilies } from "./DnsPanel";

export interface DnsHistoryCheck {
  readonly id: string;
  readonly at: string;
  readonly records?: Record<string, unknown>;
  readonly health?: Record<string, unknown>;
}

export interface DnsHistoryChartProps {
  readonly checks?: readonly DnsHistoryCheck[];
  readonly loading?: boolean;
  readonly error?: string | null;
}

export function dnsHealthScore(check: DnsHistoryCheck): number {
  const overall = check.health?.["overall"];
  if (typeof overall === "string") {
    switch (overall.trim().toLowerCase()) {
      case "healthy":
      case "pass":
        return 1;
      case "degraded":
      case "warn":
      case "warning":
        return 0.5;
      case "unhealthy":
      case "fail":
        return 0;
      case "unknown":
      case "info":
        return 0.25;
      default:
        break;
    }
  }
  const families = buildDnsFamilies(check.records, check.health);
  if (families.length === 0) return 0;
  const passing = families.filter((family) => family.status === "pass").length;
  return passing / families.length;
}

const containerStyle: CSSProperties = {
  width: "100%",
  color: "var(--text)",
  fontFamily: "var(--font-sans, system-ui, sans-serif)",
};

const metaStyle: CSSProperties = {
  fontSize: "13px",
  color: "var(--text-soft)",
  margin: "8px 0 0",
};

const stateStyle: CSSProperties = {
  padding: "24px",
  textAlign: "center",
  color: "var(--text-soft)",
};

const errorStyle: CSSProperties = {
  padding: "16px",
  background: "var(--danger-soft)",
  border: "1px solid var(--danger)",
  borderRadius: "var(--radius, 10px)",
  color: "var(--danger-text)",
};

const CHART_WIDTH = 600;
const CHART_HEIGHT = 180;
const PAD_LEFT = 40;
const PAD_RIGHT = 12;
const PAD_TOP = 12;
const PAD_BOTTOM = 24;

export function DnsHistoryChart({
  checks = [],
  loading = false,
  error = null,
}: DnsHistoryChartProps): ReactElement {
  const ordered = useMemo(
    () => [...checks].sort((a, b) => a.at.localeCompare(b.at)),
    [checks],
  );

  if (loading) {
    return (
      <div style={stateStyle} data-testid="dns-history-loading">
        Loading DNS history…
      </div>
    );
  }

  if (error) {
    return (
      <div style={errorStyle} data-testid="dns-history-error" role="alert">
        {error}
      </div>
    );
  }

  if (ordered.length === 0) {
    return (
      <div style={stateStyle} data-testid="dns-history-empty">
        No stored checks yet — run the analyser to start the trend.
      </div>
    );
  }

  const innerWidth = CHART_WIDTH - PAD_LEFT - PAD_RIGHT;
  const innerHeight = CHART_HEIGHT - PAD_TOP - PAD_BOTTOM;
  const coordinates = ordered.map((check, index) => {
    const x =
      ordered.length === 1
        ? PAD_LEFT + innerWidth / 2
        : PAD_LEFT + (index * innerWidth) / (ordered.length - 1);
    const score = Math.min(1, Math.max(0, dnsHealthScore(check)));
    const y = PAD_TOP + (1 - score) * innerHeight;
    return { x, y, score, check };
  });
  const path = coordinates
    .map((coord, index) => `${index === 0 ? "M" : "L"}${coord.x.toFixed(1)},${coord.y.toFixed(1)}`)
    .join(" ");

  return (
    <div style={containerStyle} data-testid="dns-history-chart">
      <div className="dns-panel-label">DNS history</div>
      <svg
        viewBox={`0 0 ${CHART_WIDTH} ${CHART_HEIGHT}`}
        width="100%"
        role="img"
        aria-label={`DNS health history, ${ordered.length} checks`}
        data-testid="dns-history-svg"
        data-points={ordered.length}
      >
        {[0, 0.5, 1].map((fraction) => {
          const y = PAD_TOP + (1 - fraction) * innerHeight;
          return (
            <g key={fraction}>
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
                {`${Math.round(fraction * 100)}%`}
              </text>
            </g>
          );
        })}
        <path
          d={path}
          fill="none"
          stroke="var(--accent)"
          strokeWidth={2}
          data-testid="dns-history-path"
        />
        {coordinates.map((coord, index) => (
          <circle
            key={`${coord.check.id}-${index}`}
            cx={coord.x}
            cy={coord.y}
            r={3}
            fill="var(--accent)"
            data-testid={`dns-history-point-${index}`}
          >
            <title>{`${coord.check.at}: ${Math.round(coord.score * 100)}% healthy`}</title>
          </circle>
        ))}
      </svg>
      <p style={metaStyle} data-testid="dns-history-range">
        {ordered[0]!.at} → {ordered[ordered.length - 1]!.at} · {ordered.length} checks
      </p>
    </div>
  );
}
