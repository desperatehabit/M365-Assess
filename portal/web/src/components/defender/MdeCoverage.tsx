"use client";

// MDE onboarding coverage (EPIC-019 SPEC.md §3.5, T-0370).
// Renders onboarded vs total devices per platform from the T-0370 coverage
// route (GET /v1/tenants/{id}/defender/mde-onboarding). Devices without an
// onboarding record are listed as gaps; each gap links to the onboarding
// deployment policy carried on the gap (falling back to the coverage-level
// deploymentPolicyUrl). Read-only.

import React, { type CSSProperties, type ReactElement } from "react";

export interface MdeOnboardingGap {
  readonly id: string;
  readonly deviceName: string;
  readonly platform: string;
  readonly policyUrl: string;
}

export interface MdeOnboardingPlatformCoverage {
  readonly platform: string;
  readonly total: number;
  readonly onboarded: number;
  readonly notOnboarded: number;
  readonly coveragePct: number;
  readonly gaps: readonly MdeOnboardingGap[];
}

export interface MdeOnboardingTotals {
  readonly total: number;
  readonly onboarded: number;
  readonly notOnboarded: number;
  readonly coveragePct: number;
}

export interface MdeOnboardingCoverage {
  readonly tenantId: string;
  readonly deploymentPolicyUrl: string;
  readonly platforms: readonly MdeOnboardingPlatformCoverage[];
  readonly totals: MdeOnboardingTotals;
}

export interface MdeCoverageProps {
  readonly coverage?: MdeOnboardingCoverage | null;
  readonly loading?: boolean;
  readonly error?: string | null;
}

const containerStyle: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: "16px",
  width: "100%",
  fontFamily: "var(--font-sans, system-ui, sans-serif)",
  color: "var(--text)",
};

const barStyle: CSSProperties = {
  display: "flex",
  flexWrap: "wrap",
  gap: "12px",
  alignItems: "center",
  justifyContent: "space-between",
  padding: "16px",
  background: "var(--bg-elev)",
  border: "1px solid var(--border)",
  borderRadius: "var(--radius, 10px)",
};

const cardStyle: CSSProperties = {
  padding: "16px",
  background: "var(--bg-elev)",
  border: "1px solid var(--border)",
  borderRadius: "var(--radius, 10px)",
  boxShadow: "var(--shadow-card)",
};

const tableWrapperStyle: CSSProperties = {
  overflowX: "auto",
  marginTop: "12px",
  background: "var(--bg-elev)",
  border: "1px solid var(--border)",
  borderRadius: "var(--radius, 10px)",
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
  background: "var(--surface)",
  color: "var(--text-soft)",
  fontWeight: 600,
  fontSize: "12px",
  textTransform: "uppercase",
  letterSpacing: "0.05em",
  whiteSpace: "nowrap",
};

const tdStyle: CSSProperties = {
  padding: "12px 16px",
  borderBottom: "1px solid var(--border)",
  color: "var(--text)",
  verticalAlign: "middle",
};

const monoStyle: CSSProperties = {
  fontFamily: "var(--font-mono, monospace)",
  fontSize: "13px",
  color: "var(--text)",
};

function coverageBadgeStyle(coveragePct: number): CSSProperties {
  const tone =
    coveragePct >= 90
      ? { bg: "var(--success-soft, var(--surface))", text: "var(--success-text, var(--text))" }
      : coveragePct >= 50
        ? { bg: "var(--warning-soft)", text: "var(--warning-text)" }
        : { bg: "var(--danger-soft)", text: "var(--danger-text)" };
  return {
    display: "inline-flex",
    alignItems: "center",
    padding: "2px 8px",
    borderRadius: "999px",
    fontSize: "12px",
    fontWeight: 600,
    background: tone.bg,
    color: tone.text,
    border: "1px solid var(--border)",
  };
}

export function MdeCoverage({
  coverage = null,
  loading = false,
  error = null,
}: MdeCoverageProps): ReactElement {
  return (
    <div style={containerStyle} data-testid="mde-coverage">
      {loading && (
        <div style={{ padding: "32px", textAlign: "center", color: "var(--text-soft)" }}>
          Loading onboarding coverage...
        </div>
      )}

      {error && (
        <div
          style={{
            padding: "16px",
            borderRadius: "6px",
            background: "var(--danger-soft)",
            border: "1px solid var(--danger)",
            color: "var(--danger-text)",
          }}
          role="alert"
        >
          {error}
        </div>
      )}

      {!loading && !error && !coverage && (
        <div
          style={{
            padding: "48px 16px",
            textAlign: "center",
            background: "var(--bg-elev)",
            borderRadius: "var(--radius, 10px)",
            border: "1px solid var(--border)",
            color: "var(--text-soft)",
          }}
          data-testid="empty-mde-coverage"
        >
          No onboarding coverage to show yet.
        </div>
      )}

      {!loading && !error && coverage && (
        <>
          <div style={barStyle}>
            <h2 style={{ margin: 0, fontSize: "20px", fontWeight: 600 }}>Coverage</h2>
            <span style={monoStyle} data-testid="mde-totals">
              {coverage.totals.onboarded}/{coverage.totals.total} onboarded
            </span>
            <span style={coverageBadgeStyle(coverage.totals.coveragePct)} data-testid="mde-totals-pct">
              {coverage.totals.coveragePct}% covered
            </span>
            <a href={coverage.deploymentPolicyUrl} data-testid="mde-deploy-policy-link">
              Open onboarding deployment policy
            </a>
          </div>

          {coverage.platforms.map((platform) => (
            <div key={platform.platform} style={cardStyle} data-testid={`mde-platform-${platform.platform}`}>
              <div style={{ display: "flex", gap: "12px", alignItems: "center", flexWrap: "wrap" }}>
                <h3 style={{ margin: 0, fontSize: "16px", fontWeight: 600, textTransform: "capitalize" }}>
                  {platform.platform}
                </h3>
                <span style={monoStyle} data-testid={`mde-platform-count-${platform.platform}`}>
                  {platform.onboarded}/{platform.total} onboarded
                </span>
                <span
                  style={coverageBadgeStyle(platform.coveragePct)}
                  data-testid={`mde-platform-pct-${platform.platform}`}
                >
                  {platform.coveragePct}% covered
                </span>
              </div>

              {platform.gaps.length === 0 ? (
                <p style={{ margin: "12px 0 0", color: "var(--text-soft)", fontSize: "14px" }}>
                  No gaps on this platform.
                </p>
              ) : (
                <div style={tableWrapperStyle}>
                  <table style={tableStyle} aria-label={`${platform.platform} onboarding gaps`}>
                    <thead>
                      <tr>
                        <th style={thStyle}>Device</th>
                        <th style={thStyle}>Id</th>
                        <th style={{ ...thStyle, textAlign: "right" }}>Deployment policy</th>
                      </tr>
                    </thead>
                    <tbody>
                      {platform.gaps.map((gap) => (
                        <tr key={gap.id} data-testid={`mde-gap-${gap.id}`}>
                          <td style={tdStyle}>
                            <span style={monoStyle}>{gap.deviceName || gap.id}</span>
                          </td>
                          <td style={tdStyle}>
                            <span style={monoStyle}>{gap.id}</span>
                          </td>
                          <td style={{ ...tdStyle, textAlign: "right" }}>
                            <a
                              href={gap.policyUrl || coverage.deploymentPolicyUrl}
                              data-testid={`mde-gap-policy-${gap.id}`}
                            >
                              Open deployment policy
                            </a>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          ))}
        </>
      )}
    </div>
  );
}
