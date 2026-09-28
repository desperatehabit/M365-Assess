"use client";

// MDE Onboarding page (EPIC-019 SPEC.md §3.5, T-0370).
// Renders onboarded vs total devices by platform through the T-0370 route
// (GET /v1/tenants/{id}/defender/mde-onboarding) with gaps listed and each
// gap linked to the onboarding deployment policy. Read-only. Kit tokens only.

import React, { useCallback, useEffect, useState, type CSSProperties, type ReactElement } from "react";
import { MdeCoverage, type MdeOnboardingCoverage } from "../../../../components/defender/MdeCoverage";
import { useCurrentTenantId } from "../../../../lib/useCurrentTenant";

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
  alignItems: "center",
  borderBottom: "1px solid var(--border)",
  paddingBottom: "16px",
};

const titleStyle: CSSProperties = {
  fontSize: "24px",
  fontWeight: 700,
  margin: 0,
  fontFamily: "var(--font-display, var(--font-sans))",
};

const inputStyle: CSSProperties = {
  padding: "8px 12px",
  background: "var(--input-bg, var(--bg))",
  border: "1px solid var(--border)",
  borderRadius: "6px",
  color: "var(--text)",
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

async function throwApiError(res: Response, fallback: string): Promise<never> {
  const body = (await res.json().catch(() => ({}))) as { message?: string };
  throw new Error(body.message || `${fallback}: HTTP ${res.status}`);
}

export async function getMdeOnboarding(tenantId: string): Promise<MdeOnboardingCoverage> {
  const res = await fetch(
    `/v1/tenants/${encodeURIComponent(tenantId)}/defender/mde-onboarding`,
  );
  if (!res.ok) await throwApiError(res, "Failed to load MDE onboarding coverage");
  return (await res.json()) as MdeOnboardingCoverage;
}

export default function MdeOnboardingPage(): ReactElement {
  const [tenantId, setTenantId] = useState("");
  const currentTenant = useCurrentTenantId();
  const [coverage, setCoverage] = useState<MdeOnboardingCoverage | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const fetchCoverage = useCallback(async (tenant: string): Promise<void> => {
    if (!tenant.trim()) {
      setError("Enter a tenant id to load its onboarding coverage.");
      return;
    }
    setLoading(true);
    setError(null);
    try {
      setCoverage(await getMdeOnboarding(tenant.trim()));
    } catch (err) {
      setCoverage(null);
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (currentTenant) {
      setTenantId(currentTenant);
      void fetchCoverage(currentTenant);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentTenant, fetchCoverage]);

  return (
    <div style={pageStyle} data-testid="mde-onboarding-page">
      <div style={headerStyle}>
        <div>
          <h1 style={titleStyle}>MDE Onboarding</h1>
          <p style={{ margin: "4px 0 0", color: "var(--text-soft)", fontSize: "14px" }}>
            Onboarded vs total devices by platform, with gaps linked to the deployment policy.
          </p>
        </div>
        <div style={{ display: "flex", gap: "10px", alignItems: "center" }}>
          <input
            type="text"
            placeholder="Tenant id..."
            value={tenantId}
            onChange={(e) => setTenantId(e.target.value)}
            style={inputStyle}
            aria-label="Tenant id"
            data-testid="mde-tenant-input"
          />
          <button
            type="button"
            style={buttonStyle}
            onClick={() => void fetchCoverage(tenantId)}
            data-testid="mde-load-button"
          >
            Load
          </button>
        </div>
      </div>

      <MdeCoverage coverage={coverage} loading={loading} error={error} />
    </div>
  );
}
