"use client";

// Tenant Secure Score report (EPIC-031 SPEC.md §2 US-1/US-3/US-4/US-5, §3.1,
// §3.4, §4.3; T-0607). Reads the current score, category split, and improvement
// actions from GET /v1/tenants/:tenantId/secure-score (T-0602) and the peer
// benchmarks from GET .../secure-score/peers (T-0605).
//
// Fix resolves an action's mapped registry check to the EPIC-006 remediation
// plan, or its standard to the EPIC-008 standard report. An action with neither
// mapping is shown honestly as "No automated remediation" with the Microsoft
// Secure Score portal link (SPEC §4.3, §9). Secure Score is read-only.
// Zero colour literals: report theme tokens only.

import React, { use, useEffect, useState, type CSSProperties, type ReactElement } from "react";

export interface SecureScoreCategory {
  readonly category: string;
  readonly achieved: number;
  readonly available: number;
  readonly percentage: number;
}

export interface SecureScoreAction {
  readonly id: string;
  readonly title: string;
  readonly category: string;
  readonly pointsAchieved: number;
  readonly pointsAvailable: number;
  readonly impact: string;
  readonly implementationStatus: string;
  readonly check: string | null;
  readonly standardKey: string | null;
}

export interface SecureScoreData {
  readonly tenantId: string;
  readonly current: number;
  readonly max: number;
  readonly percentage: number;
  readonly categories: readonly SecureScoreCategory[];
  readonly actions: readonly SecureScoreAction[];
}

export interface SecureScoreComparison {
  readonly basis: string;
  readonly averageScore: number;
}

export interface SecureScorePeersData {
  readonly tenantId: string;
  readonly available: boolean;
  readonly comparisons: readonly SecureScoreComparison[];
}

export interface SecureScorePageProps {
  readonly params: Promise<{ tenantId: string }> | { tenantId: string };
}

/** The Microsoft Secure Score page in the security portal, for unmapped actions. */
export const SECURE_SCORE_PORTAL_URL = "https://security.microsoft.com/securescore";

/** The EPIC-006 remediation plan for a registry check (the `?check=` filter convention). */
export function remediationHref(check: string): string {
  return `/remediation?check=${encodeURIComponent(check)}`;
}

/** The EPIC-008 standard report for a mapped standard key. */
export function standardHref(standardKey: string): string {
  return `/standards/${encodeURIComponent(standardKey)}`;
}

export type FixLink =
  | { readonly kind: "remediation"; readonly href: string }
  | { readonly kind: "standard"; readonly href: string }
  | { readonly kind: "unmapped"; readonly portalHref: string };

/** Resolves an action to its Fix destination: plan, standard, or the honest unmapped state. */
export function resolveFixLink(
  action: Pick<SecureScoreAction, "check" | "standardKey">,
): FixLink {
  if (action.check) return { kind: "remediation", href: remediationHref(action.check) };
  if (action.standardKey) return { kind: "standard", href: standardHref(action.standardKey) };
  return { kind: "unmapped", portalHref: SECURE_SCORE_PORTAL_URL };
}

/** The tenant's peer benchmark, preferring Microsoft's all-organisations basis (T-0605). */
export function selectPeerBenchmark(peers: SecureScorePeersData | null): number | null {
  if (!peers || !peers.available || peers.comparisons.length === 0) return null;
  const chosen =
    peers.comparisons.find((comparison) => comparison.basis === "AllTenants") ??
    peers.comparisons[0];
  return chosen && Number.isFinite(chosen.averageScore) ? chosen.averageScore : null;
}

export function formatPoints(value: number): string {
  if (!Number.isFinite(value)) return "0";
  return Number.isInteger(value) ? String(value) : value.toFixed(1);
}

function clampPercent(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(100, Math.max(0, value));
}

function stateBadgeClass(status: string): string {
  const normalized = status.toLowerCase();
  if (normalized.includes("notimplemented") || normalized.includes("not implemented")) {
    return "status-badge fail";
  }
  if (normalized.includes("implemented") || normalized.includes("resolved")) {
    return "status-badge pass";
  }
  return "status-badge";
}

const pageStyle: CSSProperties = {
  padding: "32px",
  maxWidth: "1400px",
  margin: "0 auto",
  fontFamily: "var(--font-sans, system-ui, sans-serif)",
  color: "var(--text)",
  display: "flex",
  flexDirection: "column",
  gap: "32px",
};

const backLinkStyle: CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  gap: "6px",
  color: "var(--accent-text)",
  textDecoration: "none",
  fontSize: "13px",
  fontWeight: 600,
};

const titleStyle: CSSProperties = {
  fontSize: "24px",
  fontWeight: 700,
  margin: "8px 0 0",
  fontFamily: "var(--font-display, var(--font-sans))",
};

const subtitleStyle: CSSProperties = {
  margin: "4px 0 0",
  color: "var(--text-soft)",
  fontSize: "14px",
};

const sectionTitleStyle: CSSProperties = {
  fontSize: "17px",
  fontWeight: 700,
  letterSpacing: "-0.01em",
  margin: "0 0 14px",
  fontFamily: "var(--font-display, var(--font-sans))",
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

const tdStyle: CSSProperties = {
  padding: "12px 16px",
  borderBottom: "1px solid var(--border)",
  verticalAlign: "top",
};

const monoStyle: CSSProperties = {
  fontFamily: "var(--font-mono, monospace)",
  fontSize: "13px",
};

const fixLinkStyle: CSSProperties = {
  color: "var(--accent-text)",
  fontWeight: 600,
  textDecoration: "none",
};

const categoryGridStyle: CSSProperties = {
  display: "grid",
  gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))",
  gap: "12px",
};

const categoryCardStyle: CSSProperties = {
  padding: "14px 16px",
  background: "var(--surface)",
  border: "1px solid var(--border)",
  borderRadius: "var(--radius, 10px)",
};

const categoryBarTrackStyle: CSSProperties = {
  height: "6px",
  background: "var(--track)",
  borderRadius: "999px",
  overflow: "hidden",
  marginTop: "8px",
};

export default function SecureScorePage(props: SecureScorePageProps): ReactElement {
  const resolvedParams =
    typeof (props.params as Promise<{ tenantId: string }>).then === "function"
      ? use(props.params as Promise<{ tenantId: string }>)
      : (props.params as { tenantId: string });

  const tenantId = resolvedParams.tenantId;

  const [score, setScore] = useState<SecureScoreData | null>(null);
  const [peers, setPeers] = useState<SecureScorePeersData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    if (!tenantId) {
      setLoading(false);
      return;
    }
    setLoading(true);
    setError(null);
    void (async () => {
      try {
        const base = `/v1/tenants/${encodeURIComponent(tenantId)}/secure-score`;
        const [scoreResponse, peerResponse] = await Promise.all([
          fetch(base),
          fetch(`${base}/peers`).catch(() => null),
        ]);
        if (!scoreResponse.ok) {
          throw new Error(`Failed to load Secure Score: ${scoreResponse.statusText}`);
        }
        const scoreData = (await scoreResponse.json()) as SecureScoreData;
        let peerData: SecureScorePeersData | null = null;
        if (peerResponse && peerResponse.ok) {
          peerData = (await peerResponse.json()) as SecureScorePeersData;
        }
        if (!active) return;
        setScore(scoreData);
        setPeers(peerData);
      } catch (err) {
        if (active) setError(err instanceof Error ? err.message : String(err));
      } finally {
        if (active) setLoading(false);
      }
    })();
    return () => {
      active = false;
    };
  }, [tenantId]);

  const backLink = (
    <a href={`/dashboard/${encodeURIComponent(tenantId)}`} style={backLinkStyle} data-testid="back-to-tenant-dashboard">
      ← Tenant dashboard
    </a>
  );

  if (loading) {
    return (
      <div style={pageStyle} data-testid="secure-score-loading">
        {backLink}
        <div style={{ padding: "64px 0", textAlign: "center", color: "var(--muted)" }}>
          Loading Secure Score for {tenantId}...
        </div>
      </div>
    );
  }

  if (error || !score) {
    return (
      <div style={pageStyle} data-testid="secure-score-error">
        {backLink}
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
          <strong>Error loading Secure Score:</strong> {error ?? "Score not found"}
        </div>
      </div>
    );
  }

  const percentage = clampPercent(score.percentage);
  const notAchieved = Math.max(0, score.max - score.current);
  const benchmark = selectPeerBenchmark(peers);

  return (
    <div style={pageStyle} data-testid="secure-score-page">
      <header>
        {backLink}
        <h1 style={titleStyle} data-testid="secure-score-title">
          Secure Score — {tenantId}
        </h1>
        <p style={subtitleStyle}>
          Microsoft Secure Score, its category split, and the improvement actions that raise it.
        </p>
      </header>

      <section data-testid="secure-score-hero">
        <div className="score-card">
          <div className="score-eyebrow">Microsoft Secure Score</div>
          <div className="score-headline">
            <span className="score-num" data-testid="secure-score-percentage">
              {score.percentage.toFixed(1)}
            </span>
            <span className="score-denom">/ 100%</span>
          </div>
          <div className="score-label" data-testid="secure-score-points">
            {formatPoints(score.current)} of {formatPoints(score.max)} points achieved.
            {benchmark !== null && ` Peer average is ${benchmark.toFixed(1)}%.`}
          </div>
          <div className="score-bar">
            <span
              data-testid="secure-score-bar"
              style={{ width: `${percentage}%` }}
            />
            {benchmark !== null && (
              <div
                className="bench"
                data-testid="secure-score-peer-marker"
                style={{ left: `${clampPercent(benchmark)}%` }}
                title={`Peer avg ${benchmark.toFixed(1)}%`}
              />
            )}
          </div>
          <div className="score-footnote">
            <span>0</span>
            {benchmark !== null && <span>Peer avg · {benchmark.toFixed(1)}%</span>}
            <span>100</span>
          </div>

          <div className="score-split" data-testid="secure-score-split">
            <div className="score-split-item">
              <div className="score-split-label">Achieved</div>
              <div className="score-split-value">{formatPoints(score.current)} pts</div>
            </div>
            <div className="score-split-item">
              <div className="score-split-label">Not achieved</div>
              <div className="score-split-value">{formatPoints(notAchieved)} pts</div>
            </div>
          </div>
        </div>
      </section>

      <section data-testid="secure-score-categories">
        <h2 style={sectionTitleStyle}>Category breakdown</h2>
        {score.categories.length === 0 ? (
          <div style={{ color: "var(--muted)", fontSize: "14px" }}>No category data.</div>
        ) : (
          <div style={categoryGridStyle}>
            {score.categories.map((category) => (
              <div
                key={category.category}
                style={categoryCardStyle}
                data-testid={`category-${category.category}`}
              >
                <div style={{ fontSize: "13px", fontWeight: 600 }}>{category.category}</div>
                <div style={{ fontSize: "20px", fontWeight: 700, fontFamily: "var(--font-display, var(--font-sans))" }}>
                  {category.percentage.toFixed(1)}%
                </div>
                <div style={{ fontSize: "12px", color: "var(--muted)" }}>
                  {formatPoints(category.achieved)} / {formatPoints(category.available)} pts
                </div>
                <div style={categoryBarTrackStyle}>
                  <div
                    style={{
                      width: `${clampPercent(category.percentage)}%`,
                      height: "100%",
                      background: "var(--accent)",
                    }}
                  />
                </div>
              </div>
            ))}
          </div>
        )}
      </section>

      <section data-testid="secure-score-actions">
        <h2 style={sectionTitleStyle}>Improvement actions</h2>
        {score.actions.length === 0 ? (
          <div style={{ color: "var(--muted)", fontSize: "14px" }}>No improvement actions.</div>
        ) : (
          <div style={tableWrapperStyle}>
            <table style={tableStyle} data-testid="secure-score-actions-table">
              <thead>
                <tr>
                  <th style={thStyle}>Action</th>
                  <th style={thStyle}>Category</th>
                  <th style={thStyle}>Points</th>
                  <th style={thStyle}>Impact</th>
                  <th style={thStyle}>Mapped standard</th>
                  <th style={thStyle}>State</th>
                  <th style={thStyle}>Fix</th>
                </tr>
              </thead>
              <tbody>
                {score.actions.map((action) => {
                  const fix = resolveFixLink(action);
                  return (
                    <tr key={action.id} data-testid={`action-row-${action.id}`}>
                      <td style={tdStyle}>
                        <div style={{ fontWeight: 600 }}>{action.title}</div>
                        <div style={{ ...monoStyle, color: "var(--muted)" }}>{action.id}</div>
                      </td>
                      <td style={tdStyle}>{action.category}</td>
                      <td style={{ ...tdStyle, ...monoStyle }}>
                        {formatPoints(action.pointsAchieved)} / {formatPoints(action.pointsAvailable)}
                      </td>
                      <td style={tdStyle}>{action.impact}</td>
                      <td style={{ ...tdStyle, ...monoStyle }} data-testid={`action-standard-${action.id}`}>
                        {action.standardKey ?? "—"}
                      </td>
                      <td style={tdStyle}>
                        <span className={stateBadgeClass(action.implementationStatus)}>
                          {action.implementationStatus}
                        </span>
                      </td>
                      <td style={tdStyle}>
                        {fix.kind === "unmapped" ? (
                          <span data-testid={`action-fix-${action.id}`}>
                            <span style={{ color: "var(--muted)" }}>No automated remediation</span>
                            {" · "}
                            <a
                              href={fix.portalHref}
                              style={fixLinkStyle}
                              target="_blank"
                              rel="noreferrer"
                              data-testid={`action-portal-${action.id}`}
                            >
                              Open in portal
                            </a>
                          </span>
                        ) : (
                          <a
                            href={fix.href}
                            style={fixLinkStyle}
                            data-testid={`action-fix-${action.id}`}
                          >
                            Fix
                          </a>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}
