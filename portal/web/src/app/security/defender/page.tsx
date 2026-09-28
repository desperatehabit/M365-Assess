"use client";

// Defender Status page (EPIC-019 SPEC.md §3.1, T-0362).
// Renders one card per Defender policy area (AV, EDR, ASR, compliance,
// firewall, exclusions) with current state vs recommended through the T-0361
// status route (GET /v1/tenants/{id}/defender/status). Read-only.
// Nav: Security & Compliance → Defender → Status. Kit tokens only.

import React, { useCallback, useEffect, useState, type CSSProperties, type ReactElement } from "react";
import {
  DefenderStatusCards,
  type DefenderAreaStatus,
} from "../../../components/defender/DefenderStatusCards";
import { useCurrentTenantId } from "../../../lib/useCurrentTenant";

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

export async function listDefenderStatus(tenantId: string): Promise<DefenderAreaStatus[]> {
  const res = await fetch(`/v1/tenants/${encodeURIComponent(tenantId)}/defender/status`);
  if (!res.ok) await throwApiError(res, "Failed to list Defender status");
  const body = (await res.json()) as { areas?: DefenderAreaStatus[] };
  return body.areas ?? [];
}

export default function DefenderStatusPage(): ReactElement {
  const [tenantId, setTenantId] = useState("");
  const currentTenant = useCurrentTenantId();
  const [areas, setAreas] = useState<DefenderAreaStatus[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const fetchStatus = useCallback(async (tenant: string): Promise<void> => {
    if (!tenant.trim()) {
      setError("Enter a tenant id to list its Defender status.");
      return;
    }
    setLoading(true);
    setError(null);
    try {
      setAreas(await listDefenderStatus(tenant.trim()));
    } catch (err) {
      setAreas([]);
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (currentTenant) {
      setTenantId(currentTenant);
      void fetchStatus(currentTenant);
    }
  }, [currentTenant, fetchStatus]);

  return (
    <div style={pageStyle} data-testid="defender-status-page">
      <div style={headerStyle}>
        <div>
          <h1 style={titleStyle}>Defender Status</h1>
          <p style={{ margin: "4px 0 0", color: "var(--text-soft)", fontSize: "14px" }}>
            Defender configuration state per policy area, current vs recommended.
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
            data-testid="defender-status-tenant-input"
          />
          <button
            type="button"
            style={buttonStyle}
            onClick={() => void fetchStatus(tenantId)}
            data-testid="defender-status-load-button"
          >
            Load
          </button>
        </div>
      </div>

      <DefenderStatusCards areas={areas} loading={loading} error={error} />
    </div>
  );
}
