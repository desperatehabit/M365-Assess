"use client";

// Incidents page (EPIC-028 SPEC.md §2 US-1, §3.1, §4.2, §6; T-0544).
// Page title "Incidents". Renders IncidentsTable against the T-0543 list API
// (GET /v1/tenants/{id}/incidents, or GET /v1/incidents for the all-tenants
// aggregate). Row and bulk triage actions route to the T-0547 surfaces; this
// page performs no writes. Report theme tokens only.

import React, { useCallback, useEffect, useState, type CSSProperties, type ReactElement } from "react";
import { useRouter } from "next/navigation";
import {
  IncidentsTable,
  type IncidentBulkRequest,
  type IncidentRow,
  type IncidentRowAction,
} from "../../components/incidents/IncidentsTable";
import { useCurrentTenantId } from "../../lib/useCurrentTenant";

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
  flexWrap: "wrap",
  gap: "16px",
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

interface IncidentsApiPage {
  readonly items?: readonly IncidentRow[];
  readonly nextCursor?: string | null;
}

async function throwApiError(response: Response, fallback: string): Promise<never> {
  const body = (await response.json().catch(() => ({}))) as { message?: string };
  throw new Error(body.message || `${fallback}: HTTP ${response.status}`);
}

/** T-0543 list API: tenant-scoped, or the cross-tenant aggregate when allTenants. */
export async function listIncidents(
  tenantId: string,
  allTenants: boolean,
  fetcher: typeof fetch = fetch,
): Promise<readonly IncidentRow[]> {
  const url = allTenants
    ? "/v1/incidents"
    : `/v1/tenants/${encodeURIComponent(tenantId)}/incidents`;
  const response = await fetcher(url);
  if (!response.ok) await throwApiError(response, "Failed to list incidents");
  const body = (await response.json()) as IncidentsApiPage;
  return body.items ?? [];
}

export default function IncidentsPage(): ReactElement {
  const router = useRouter();
  const currentTenant = useCurrentTenantId();
  const [tenantId, setTenantId] = useState("");
  const [allTenants, setAllTenants] = useState(false);
  const [incidents, setIncidents] = useState<readonly IncidentRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async (tenant: string, aggregate: boolean): Promise<void> => {
    if (!aggregate && !tenant.trim()) {
      setError("Enter a tenant id to list incidents.");
      return;
    }
    setLoading(true);
    setError(null);
    try {
      setIncidents(await listIncidents(tenant.trim(), aggregate));
    } catch (err) {
      setIncidents([]);
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (currentTenant) {
      setTenantId(currentTenant);
      void load(currentTenant, false);
    }
  }, [currentTenant, load]);

  const handleToggleAllTenants = (next: boolean): void => {
    setAllTenants(next);
    void load(tenantId, next);
  };

  const handleRowAction = (action: IncidentRowAction, incident: IncidentRow): void => {
    router.push(`/incidents/${encodeURIComponent(incident.id)}?action=${action}`);
  };

  const handleBulkAction = (request: IncidentBulkRequest): void => {
    const first = request.incidents[0];
    if (!first) return;
    const ids = request.incidents.map((incident) => incident.id).join(",");
    router.push(
      `/incidents/${encodeURIComponent(first.id)}?action=${request.action}&bulk=${encodeURIComponent(ids)}`,
    );
  };

  return (
    <div style={pageStyle} data-testid="incidents-page">
      <div style={headerStyle}>
        <div>
          <h1 style={titleStyle}>Incidents</h1>
          <p style={{ margin: "4px 0 0", color: "var(--muted)", fontSize: "14px" }}>
            Triage security incidents across Defender, MDO, and Graph; review, assign, comment,
            and change status.
          </p>
        </div>
        <div style={{ display: "flex", gap: "10px", alignItems: "center" }}>
          <input
            type="text"
            placeholder="Tenant id..."
            value={tenantId}
            onChange={(event) => setTenantId(event.target.value)}
            style={inputStyle}
            aria-label="Tenant id"
            data-testid="incidents-tenant-input"
          />
          <button
            type="button"
            style={buttonStyle}
            onClick={() => void load(tenantId, allTenants)}
            data-testid="incidents-load-button"
          >
            Load
          </button>
        </div>
      </div>

      <IncidentsTable
        incidents={incidents}
        loading={loading}
        error={error}
        allTenants={allTenants}
        onToggleAllTenants={handleToggleAllTenants}
        onRowAction={handleRowAction}
        onBulkAction={handleBulkAction}
      />
    </div>
  );
}
