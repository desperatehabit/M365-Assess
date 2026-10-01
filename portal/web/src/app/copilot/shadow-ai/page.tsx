"use client";

// Shadow AI Discovery page (EPIC-041 SPEC.md §3.3, §4, §9; T-0807). Report-only:
// it lists unsanctioned AI-tool findings discovered from Defender for Cloud Apps
// (falling back to sign-in logs) and lets an operator triage their state. It
// deliberately offers no block / Conditional Access action — blocking is a
// tenant write that routes through EPIC-006 and requires explicit review.
// Report theme tokens only, zero colour literals.

import React, { useCallback, useEffect, useState, type CSSProperties, type ReactElement } from "react";
import { useCurrentTenantId } from "../../../lib/useCurrentTenant";

// ─── API client (kept in-page; the seam is the route module) ─────────────────

type Fetcher = typeof fetch;

export type ShadowAiSourceKind = "defender-cloud-apps" | "sign-in-logs";

export type ShadowAiFindingState = "open" | "acknowledged" | "dismissed";

export interface ShadowAiFinding {
  readonly id: string;
  readonly tenantId: string;
  readonly tool: string;
  readonly user: string;
  readonly detectedAt: string;
  readonly state: ShadowAiFindingState;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface ShadowAiDiscoveryResult {
  readonly tenantId: string;
  readonly source: ShadowAiSourceKind;
  readonly usedFallback: boolean;
  readonly blocked: false;
  readonly findings: readonly ShadowAiFinding[];
}

export const SHADOW_AI_SOURCE_LABELS: Readonly<Record<ShadowAiSourceKind, string>> = Object.freeze({
  "defender-cloud-apps": "Defender for Cloud Apps",
  "sign-in-logs": "Sign-in logs (fallback)",
});

function asFetcher(fetcher?: Fetcher): Fetcher {
  return fetcher ?? fetch;
}

async function readJson<T>(response: Response, what: string): Promise<T> {
  if (!response.ok) {
    let detail = response.statusText;
    try {
      const body = (await response.json()) as { message?: string };
      if (body?.message) detail = body.message;
    } catch {
      // non-JSON error body; keep the status text
    }
    throw new Error(`${what} failed: ${response.status} ${detail}`);
  }
  return response.json() as Promise<T>;
}

export async function discoverShadowAi(
  tenantId: string,
  fetcher?: Fetcher,
): Promise<ShadowAiDiscoveryResult> {
  return readJson<ShadowAiDiscoveryResult>(
    await asFetcher(fetcher)(`/v1/tenants/${encodeURIComponent(tenantId)}/shadow-ai`),
    "Loading Shadow AI findings",
  );
}

export async function triageShadowAiFinding(
  tenantId: string,
  findingId: string,
  state: ShadowAiFindingState,
  fetcher?: Fetcher,
): Promise<ShadowAiFinding> {
  const body = await readJson<{ finding: ShadowAiFinding }>(
    await asFetcher(fetcher)(
      `/v1/tenants/${encodeURIComponent(tenantId)}/shadow-ai/${encodeURIComponent(findingId)}`,
      {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ state }),
      },
    ),
    "Updating Shadow AI finding",
  );
  return body.finding;
}

// ─── Page ─────────────────────────────────────────────────────────────────────

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

const headerStyle: CSSProperties = {
  display: "flex",
  justifyContent: "space-between",
  alignItems: "flex-start",
  gap: "16px",
  borderBottom: "1px solid var(--border)",
  paddingBottom: "16px",
  flexWrap: "wrap",
};

const titleStyle: CSSProperties = {
  fontSize: "24px",
  fontWeight: 700,
  margin: 0,
  fontFamily: "var(--font-display, var(--font-sans))",
};

const subtitleStyle: CSSProperties = {
  margin: "4px 0 0",
  color: "var(--text-soft)",
  fontSize: "14px",
};

const buttonStyle: CSSProperties = {
  padding: "8px 14px",
  background: "var(--surface)",
  border: "1px solid var(--border)",
  borderRadius: "6px",
  color: "var(--text)",
  fontSize: "14px",
  fontWeight: 500,
  cursor: "pointer",
};

const inputStyle: CSSProperties = {
  padding: "8px 12px",
  background: "var(--input-bg, var(--bg))",
  border: "1px solid var(--border)",
  borderRadius: "6px",
  color: "var(--text)",
  fontSize: "14px",
};

const panelStyle: CSSProperties = {
  padding: "16px",
  background: "var(--bg-elev)",
  border: "1px solid var(--border)",
  borderRadius: "var(--radius, 10px)",
  boxShadow: "var(--shadow-card)",
};

const thStyle: CSSProperties = {
  padding: "10px 12px",
  borderBottom: "1px solid var(--border)",
  color: "var(--text-soft)",
  fontSize: "12px",
  textTransform: "uppercase",
  textAlign: "left",
};

const tdStyle: CSSProperties = {
  padding: "10px 12px",
  borderBottom: "1px solid var(--border)",
};

function stateBadgeStyle(state: ShadowAiFindingState): CSSProperties {
  const active = state !== "open";
  return {
    padding: "2px 10px",
    borderRadius: "999px",
    fontSize: "12px",
    fontWeight: 600,
    background: active ? "var(--accent-soft)" : "var(--surface)",
    color: active ? "var(--accent-text)" : "var(--text-soft)",
    border: `1px solid ${active ? "var(--accent)" : "var(--border)"}`,
  };
}

export interface ShadowAiPageProps {
  readonly fetcher?: Fetcher;
  readonly tenantId?: string;
}

export default function ShadowAiDiscoveryPage({
  fetcher,
  tenantId = "",
}: ShadowAiPageProps): ReactElement {
  const doFetch = fetcher ?? fetch;
  const [tenantInput, setTenantInput] = useState(tenantId);
  const [activeTenant, setActiveTenant] = useState("");
  const currentTenant = useCurrentTenantId();
  useEffect(() => {
    if (currentTenant) {
      setTenantInput(currentTenant);
      setActiveTenant(currentTenant);
    }
  }, [currentTenant]);

  const [result, setResult] = useState<ShadowAiDiscoveryResult | null>(null);
  const [findings, setFindings] = useState<readonly ShadowAiFinding[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [triagingId, setTriagingId] = useState<string | null>(null);

  const load = useCallback(
    async (tenant: string): Promise<void> => {
      if (!tenant) return;
      setLoading(true);
      setError(null);
      try {
        const discovery = await discoverShadowAi(tenant, doFetch);
        setResult(discovery);
        setFindings(discovery.findings);
        setActiveTenant(tenant);
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
        setResult(null);
        setFindings([]);
      } finally {
        setLoading(false);
      }
    },
    [doFetch],
  );

  useEffect(() => {
    if (activeTenant) void load(activeTenant);
  }, [activeTenant, load]);

  const triage = async (findingId: string, state: ShadowAiFindingState): Promise<void> => {
    if (!activeTenant) return;
    setTriagingId(findingId);
    setError(null);
    try {
      const updated = await triageShadowAiFinding(activeTenant, findingId, state, doFetch);
      setFindings((prev) => prev.map((finding) => (finding.id === updated.id ? updated : finding)));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setTriagingId(null);
    }
  };

  return (
    <div style={pageStyle} data-testid="shadow-ai-page">
      <div style={headerStyle}>
        <div>
          <h1 style={titleStyle}>Shadow AI Discovery</h1>
          <p style={subtitleStyle}>
            Unsanctioned AI-tool usage discovered from Defender for Cloud Apps, with sign-in logs
            as a fallback. Report-only: triage findings here; blocking is a separate, reviewed
            tenant write.
          </p>
        </div>
        <div style={{ display: "flex", gap: "8px", alignItems: "center", flexWrap: "wrap" }}>
          <input
            type="text"
            placeholder="Tenant id"
            value={tenantInput}
            onChange={(e) => setTenantInput(e.target.value)}
            style={inputStyle}
            aria-label="Tenant id"
            data-testid="shadow-ai-tenant"
          />
          <button
            type="button"
            style={buttonStyle}
            onClick={() => void load(tenantInput.trim())}
            data-testid="shadow-ai-load"
          >
            Load
          </button>
        </div>
      </div>

      {error && (
        <div
          style={{
            padding: "12px",
            background: "var(--danger-soft)",
            border: "1px solid var(--danger)",
            borderRadius: "6px",
            color: "var(--danger-text)",
          }}
          role="alert"
          data-testid="shadow-ai-error"
        >
          {error}
        </div>
      )}

      <div style={panelStyle} data-testid="shadow-ai-panel">
        {loading && <div style={{ color: "var(--text-soft)" }}>Discovering...</div>}
        {!loading && result && (
          <div
            style={{
              display: "flex",
              gap: "12px",
              alignItems: "center",
              flexWrap: "wrap",
              marginBottom: "12px",
            }}
          >
            <span
              style={{
                padding: "2px 10px",
                borderRadius: "999px",
                fontSize: "12px",
                fontWeight: 600,
                background: "var(--accent-soft)",
                color: "var(--accent-text)",
                border: "1px solid var(--accent)",
              }}
              data-testid="shadow-ai-source"
            >
              Source: {SHADOW_AI_SOURCE_LABELS[result.source]}
            </span>
            {result.usedFallback && (
              <span style={{ color: "var(--text-soft)", fontSize: "13px" }} data-testid="shadow-ai-fallback">
                Defender for Cloud Apps was unavailable; showing sign-in log detections.
              </span>
            )}
            <span style={{ color: "var(--text-soft)", fontSize: "13px" }}>
              {findings.length} finding{findings.length === 1 ? "" : "s"}
            </span>
          </div>
        )}
        {!loading && !result && (
          <div style={{ color: "var(--text-soft)" }} data-testid="shadow-ai-empty">
            Load a tenant to discover unsanctioned AI-tool usage.
          </div>
        )}
        {!loading && result && findings.length === 0 && (
          <div style={{ color: "var(--text-soft)" }} data-testid="shadow-ai-none">
            No unsanctioned AI-tool usage detected.
          </div>
        )}
        {!loading && result && findings.length > 0 && (
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "14px" }} aria-label="Shadow AI findings">
            <thead>
              <tr>
                <th style={thStyle}>Tool</th>
                <th style={thStyle}>User</th>
                <th style={thStyle}>Detected</th>
                <th style={thStyle}>State</th>
                <th style={thStyle}>Triage</th>
              </tr>
            </thead>
            <tbody>
              {findings.map((finding) => (
                <tr key={finding.id} data-testid={`shadow-ai-finding-${finding.id}`}>
                  <td style={tdStyle}>{finding.tool}</td>
                  <td style={tdStyle}>{finding.user}</td>
                  <td style={tdStyle}>{finding.detectedAt}</td>
                  <td style={tdStyle}>
                    <span style={stateBadgeStyle(finding.state)} data-testid={`shadow-ai-state-${finding.id}`}>
                      {finding.state}
                    </span>
                  </td>
                  <td style={tdStyle}>
                    <div style={{ display: "flex", gap: "8px", flexWrap: "wrap" }}>
                      <button
                        type="button"
                        style={buttonStyle}
                        disabled={triagingId === finding.id || finding.state !== "open"}
                        onClick={() => void triage(finding.id, "acknowledged")}
                        data-testid={`shadow-ai-acknowledge-${finding.id}`}
                      >
                        Acknowledge
                      </button>
                      <button
                        type="button"
                        style={buttonStyle}
                        disabled={triagingId === finding.id || finding.state === "dismissed"}
                        onClick={() => void triage(finding.id, "dismissed")}
                        data-testid={`shadow-ai-dismiss-${finding.id}`}
                      >
                        Dismiss
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
