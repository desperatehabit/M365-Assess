"use client";

// Defender status cards (EPIC-019 SPEC.md §3.1, T-0362).
// One card per Defender policy area (AV, EDR, ASR, compliance, firewall,
// exclusions) with current state vs recommended, served read-only by the
// T-0361 status route (GET /v1/tenants/{id}/defender/status). Areas the route
// marks as not supported render an Unsupported badge, never a failing one.
// Supported areas link to the EPIC-008 standards surface where the module's
// Defender check findings are reported. Kit tokens only.

import React, { type CSSProperties, type ReactElement } from "react";

export interface DefenderStatusFinding {
  readonly setting: string;
  readonly currentValue: string;
  readonly recommendedValue: string;
  readonly status: string;
  readonly checkId: string;
}

export interface DefenderAreaStatus {
  readonly area: string;
  readonly displayName: string;
  readonly source?: string;
  readonly supported: boolean;
  readonly current: string;
  readonly recommended: string;
  readonly status: string;
  readonly findings?: readonly DefenderStatusFinding[];
  readonly findingHref?: string | null;
}

export interface DefenderStatusCardsProps {
  readonly areas?: readonly DefenderAreaStatus[];
  readonly loading?: boolean;
  readonly error?: string | null;
  readonly findingHrefFor?: (area: DefenderAreaStatus) => string | null;
}

// Module Defender checks behind each v1 policy area (Get-DefenderStatus.ps1
// registry). Surfaced on the card so findings tie back to the assessment.
export const DEFENDER_AREA_CHECKS: Readonly<Record<string, readonly string[]>> = {
  av: ["DEFENDER-ANTIMALWARE-001", "DEFENDER-ANTIMALWARE-002", "DEFENDER-MALWARE-001", "DEFENDER-MALWARE-002"],
  edr: ["DEFENDER-ZAP-001", "DEFENDER-PRIORITY-001"],
  asr: ["DEFENDER-ANTIPHISH-001", "DEFENDER-SAFELINKS-001", "DEFENDER-SAFEATTACH-001"],
};

export const STANDARDS_ALIGNMENT_HREF = "/standards/alignment";

export function defenderAreaFindingHref(area: DefenderAreaStatus): string | null {
  if (area.findingHref) return area.findingHref;
  if (!area.supported) return null;
  return STANDARDS_ALIGNMENT_HREF;
}

type BadgeTone = "pass" | "fail" | "review" | "neutral";

function badgeToneFor(area: DefenderAreaStatus): { tone: BadgeTone; label: string } {
  if (!area.supported) return { tone: "neutral", label: "Unsupported" };
  const status = area.status.trim().toLowerCase();
  if (status === "pass") return { tone: "pass", label: "Pass" };
  if (status === "fail") return { tone: "fail", label: "Fail" };
  if (status === "warning" || status === "review") {
    return { tone: "review", label: area.status.trim() };
  }
  return { tone: "neutral", label: area.status.trim() || "Unknown" };
}

function badgeStyle(tone: BadgeTone): CSSProperties {
  const palette =
    tone === "pass"
      ? { bg: "var(--success-soft)", text: "var(--success-text)", border: "var(--success)" }
      : tone === "fail"
        ? { bg: "var(--danger-soft)", text: "var(--danger-text)", border: "var(--danger)" }
        : tone === "review"
          ? { bg: "var(--warning-soft)", text: "var(--warning-text)", border: "var(--warning)" }
          : { bg: "var(--surface)", text: "var(--text-soft)", border: "var(--border)" };
  return {
    display: "inline-flex",
    alignItems: "center",
    padding: "2px 10px",
    borderRadius: "999px",
    fontSize: "12px",
    fontWeight: 600,
    background: palette.bg,
    color: palette.text,
    border: `1px solid ${palette.border}`,
  };
}

const gridStyle: CSSProperties = {
  display: "grid",
  gridTemplateColumns: "repeat(auto-fill, minmax(320px, 1fr))",
  gap: "16px",
  width: "100%",
  fontFamily: "var(--font-sans, system-ui, sans-serif)",
  color: "var(--text)",
};

const cardStyle: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: "12px",
  padding: "16px",
  background: "var(--bg-elev)",
  border: "1px solid var(--border)",
  borderRadius: "var(--radius, 10px)",
  boxShadow: "var(--shadow-card)",
};

const cardHeaderStyle: CSSProperties = {
  display: "flex",
  justifyContent: "space-between",
  alignItems: "flex-start",
  gap: "12px",
};

const cardTitleStyle: CSSProperties = {
  margin: 0,
  fontSize: "16px",
  fontWeight: 600,
};

const rowLabelStyle: CSSProperties = {
  fontSize: "12px",
  fontWeight: 600,
  color: "var(--text-soft)",
  textTransform: "uppercase",
  letterSpacing: "0.05em",
};

const rowValueStyle: CSSProperties = {
  margin: "4px 0 0",
  fontSize: "14px",
  color: "var(--text)",
};

const linkStyle: CSSProperties = {
  color: "var(--accent-text)",
  fontSize: "14px",
  fontWeight: 500,
};

const checksStyle: CSSProperties = {
  fontFamily: "var(--font-mono, monospace)",
  fontSize: "12px",
  color: "var(--text-soft)",
};

export function DefenderStatusCards({
  areas = [],
  loading = false,
  error = null,
  findingHrefFor,
}: DefenderStatusCardsProps): ReactElement {
  if (loading) {
    return (
      <div style={{ padding: "32px", textAlign: "center", color: "var(--text-soft)" }}>
        Loading Defender status...
      </div>
    );
  }

  if (error) {
    return (
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
    );
  }

  if (areas.length === 0) {
    return (
      <div
        style={{
          padding: "48px 16px",
          textAlign: "center",
          background: "var(--bg-elev)",
          borderRadius: "var(--radius, 10px)",
          border: "1px solid var(--border)",
          color: "var(--text-soft)",
        }}
        data-testid="empty-defender-status"
      >
        No Defender policy areas reported for this tenant.
      </div>
    );
  }

  return (
    <div style={gridStyle} data-testid="defender-status-cards">
      {areas.map((area) => {
        const badge = badgeToneFor(area);
        const href = findingHrefFor ? findingHrefFor(area) : defenderAreaFindingHref(area);
        const checks = DEFENDER_AREA_CHECKS[area.area] ?? [];
        return (
          <section key={area.area} style={cardStyle} data-testid={`defender-status-card-${area.area}`}>
            <div style={cardHeaderStyle}>
              <h2 style={cardTitleStyle}>{area.displayName}</h2>
              <span style={badgeStyle(badge.tone)} data-testid={`defender-status-badge-${area.area}`}>
                {badge.label}
              </span>
            </div>

            <div>
              <div style={rowLabelStyle}>Current</div>
              <p style={rowValueStyle} data-testid={`defender-status-current-${area.area}`}>
                {area.supported ? area.current : "Not yet supported in v1"}
              </p>
            </div>

            <div>
              <div style={rowLabelStyle}>Recommended</div>
              <p style={rowValueStyle} data-testid={`defender-status-recommended-${area.area}`}>
                {area.recommended}
              </p>
            </div>

            {area.supported && area.findings && area.findings.length > 0 && (
              <ul
                style={{ margin: 0, paddingLeft: "18px", display: "flex", flexDirection: "column", gap: "4px" }}
                data-testid={`defender-status-findings-${area.area}`}
              >
                {area.findings.map((finding) => (
                  <li key={finding.checkId} style={{ fontSize: "13px" }}>
                    {finding.setting} — {finding.currentValue} (recommended {finding.recommendedValue})
                  </li>
                ))}
              </ul>
            )}

            {area.supported && checks.length > 0 && (
              <div style={checksStyle} data-testid={`defender-status-checks-${area.area}`}>
                Related checks: {checks.join(", ")}
              </div>
            )}

            {href ? (
              <a
                href={href}
                style={linkStyle}
                aria-label={`View ${area.displayName} findings in standards alignment`}
                data-testid={`defender-status-link-${area.area}`}
              >
                View findings
              </a>
            ) : (
              <span style={{ fontSize: "13px", color: "var(--text-soft)" }}>
                Findings unavailable for this area.
              </span>
            )}
          </section>
        );
      })}
    </div>
  );
}
