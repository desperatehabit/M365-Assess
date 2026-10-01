// Domain Analyser recommendations (EPIC-034 SPEC.md §3.3; T-0669).
// Renders the ranked, actionable items from the T-0666 recommendations
// endpoint: record family, severity, plain-language explanation, and a working
// remediation link (portal instruction or module CheckID). A clean domain
// yields an empty list and the component shows the empty state, never an
// error. Report theme tokens only (zero colour literals).

import React, { type CSSProperties, type ReactElement } from "react";

export type DnsRecommendationSeverity = "high" | "medium" | "low" | "info";

export interface DnsRecommendation {
  readonly recordFamily: string;
  readonly severity: DnsRecommendationSeverity;
  readonly explanation: string;
  readonly remediationUrl: string;
  readonly remediation?: string;
  readonly checkId?: string | null;
}

export interface DnsRecommendationsProps {
  readonly recommendations?: readonly DnsRecommendation[];
  readonly loading?: boolean;
  readonly error?: string | null;
}

const SEVERITY_STATUS: Readonly<Record<DnsRecommendationSeverity, string>> = {
  high: "fail",
  medium: "warn",
  low: "info",
  info: "info",
};

const containerStyle: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: "12px",
  color: "var(--text)",
  fontFamily: "var(--font-sans, system-ui, sans-serif)",
};

const listStyle: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: "10px",
  margin: 0,
  padding: 0,
  listStyle: "none",
};

const itemStyle: CSSProperties = {
  border: "1px solid var(--border)",
  borderRadius: "var(--radius, 10px)",
  background: "var(--bg-elev)",
  padding: "12px 14px",
  display: "flex",
  flexDirection: "column",
  gap: "6px",
};

const headStyle: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: "8px",
  flexWrap: "wrap",
};

const familyStyle: CSSProperties = {
  fontWeight: 700,
  fontSize: "13px",
  fontFamily: "var(--font-mono, monospace)",
};

const linkStyle: CSSProperties = {
  color: "var(--accent-text, var(--accent))",
  fontSize: "13px",
  fontWeight: 600,
};

const noteStyle: CSSProperties = {
  color: "var(--text-soft)",
  fontSize: "13px",
  margin: 0,
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

export function DnsRecommendations({
  recommendations = [],
  loading = false,
  error = null,
}: DnsRecommendationsProps): ReactElement {
  if (loading) {
    return (
      <div style={stateStyle} data-testid="dns-recommendations-loading">
        Loading recommendations…
      </div>
    );
  }

  if (error) {
    return (
      <div style={errorStyle} data-testid="dns-recommendations-error" role="alert">
        {error}
      </div>
    );
  }

  if (recommendations.length === 0) {
    return (
      <div style={stateStyle} data-testid="dns-recommendations-empty">
        No DNS recommendations — this domain is clean.
      </div>
    );
  }

  return (
    <div style={containerStyle} data-testid="dns-recommendations">
      <div className="dns-panel-label">Recommendations</div>
      <ul style={listStyle}>
        {recommendations.map((recommendation, index) => (
          <li
            key={`${recommendation.recordFamily}-${index}`}
            style={itemStyle}
            data-testid={`dns-recommendation-${index}`}
          >
            <div style={headStyle}>
              <span style={familyStyle}>{recommendation.recordFamily}</span>
              <span
                className={`status-badge ${SEVERITY_STATUS[recommendation.severity]}`}
                data-testid={`dns-recommendation-severity-${index}`}
              >
                <span className="dot" />
                {recommendation.severity}
              </span>
              {recommendation.checkId && (
                <span style={{ ...noteStyle, fontFamily: "var(--font-mono, monospace)" }}>
                  {recommendation.checkId}
                </span>
              )}
            </div>
            <p style={noteStyle}>{recommendation.explanation}</p>
            {recommendation.remediation && (
              <p style={noteStyle}>{recommendation.remediation}</p>
            )}
            <a
              href={recommendation.remediationUrl}
              style={linkStyle}
              target="_blank"
              rel="noreferrer"
              data-testid={`dns-recommendation-link-${index}`}
            >
              Remediation guidance →
            </a>
          </li>
        ))}
      </ul>
    </div>
  );
}
