"use client";

// Vulnerabilities page (EPIC-019 SPEC.md §3.3, T-0367).
// Lists the tenant's TVM vulnerabilities through the T-0366 route
// (GET /v1/tenants/{id}/defender/vulnerabilities) with the §3.3 columns and
// severity, software, and device filters applied through the API. Selecting a
// CVE opens the AffectedDevicesDrawer drill-through
// (GET .../vulnerabilities/{cveId}) with links to the EPIC-018 device detail
// surface. Read-only. Kit tokens only.

import React, { useCallback, useEffect, useState, type CSSProperties, type ReactElement } from "react";
import {
  AffectedDevicesDrawer,
  type AffectedDevice,
} from "../../../../components/defender/AffectedDevicesDrawer";
import {
  buildVulnerabilitiesQuery,
  EMPTY_VULNERABILITY_FILTERS,
  type VulnerabilityFilters,
  type VulnerabilityItem,
} from "../../../../components/defender/VulnerabilityTable";
import { VulnerabilityTable } from "../../../../components/defender/VulnerabilityTable";
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

export async function listVulnerabilities(
  tenantId: string,
  filters: VulnerabilityFilters,
): Promise<VulnerabilityItem[]> {
  const res = await fetch(
    `/v1/tenants/${encodeURIComponent(tenantId)}/defender/vulnerabilities${buildVulnerabilitiesQuery(filters)}`,
  );
  if (!res.ok) await throwApiError(res, "Failed to list vulnerabilities");
  const body = (await res.json()) as { items?: VulnerabilityItem[] };
  return body.items ?? [];
}

export async function listAffectedDevices(
  tenantId: string,
  cve: string,
): Promise<AffectedDevice[]> {
  const res = await fetch(
    `/v1/tenants/${encodeURIComponent(tenantId)}/defender/vulnerabilities/${encodeURIComponent(cve)}`,
  );
  if (!res.ok) await throwApiError(res, `Failed to list devices affected by ${cve}`);
  const body = (await res.json()) as { items?: AffectedDevice[] };
  return body.items ?? [];
}

export default function VulnerabilitiesPage(): ReactElement {
  const [tenantId, setTenantId] = useState("");
  const currentTenant = useCurrentTenantId();
  const [vulnerabilities, setVulnerabilities] = useState<VulnerabilityItem[]>([]);
  const [filters, setFilters] = useState<VulnerabilityFilters>(EMPTY_VULNERABILITY_FILTERS);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<VulnerabilityItem | null>(null);
  const [devices, setDevices] = useState<AffectedDevice[]>([]);
  const [devicesLoading, setDevicesLoading] = useState(false);
  const [devicesError, setDevicesError] = useState<string | null>(null);

  const fetchVulnerabilities = useCallback(
    async (tenant: string, activeFilters: VulnerabilityFilters): Promise<void> => {
      if (!tenant.trim()) {
        setError("Enter a tenant id to list its vulnerabilities.");
        return;
      }
      setLoading(true);
      setError(null);
      try {
        setVulnerabilities(await listVulnerabilities(tenant.trim(), activeFilters));
      } catch (err) {
        setVulnerabilities([]);
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        setLoading(false);
      }
    },
    [],
  );

  useEffect(() => {
    if (currentTenant) {
      setTenantId(currentTenant);
      void fetchVulnerabilities(currentTenant, filters);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentTenant, fetchVulnerabilities]);

  useEffect(() => {
    if (!tenantId.trim()) return;
    void fetchVulnerabilities(tenantId, filters);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filters]);

  async function handleSelect(vulnerability: VulnerabilityItem): Promise<void> {
    setSelected(vulnerability);
    setDevices([]);
    const tenant = tenantId.trim();
    if (!tenant) {
      setDevicesError("Enter a tenant id to list affected devices.");
      return;
    }
    setDevicesLoading(true);
    setDevicesError(null);
    try {
      setDevices(await listAffectedDevices(tenant, vulnerability.cve));
    } catch (err) {
      setDevices([]);
      setDevicesError(err instanceof Error ? err.message : String(err));
    } finally {
      setDevicesLoading(false);
    }
  }

  return (
    <div style={pageStyle} data-testid="vulnerabilities-page">
      <div style={headerStyle}>
        <div>
          <h1 style={titleStyle}>Vulnerabilities</h1>
          <p style={{ margin: "4px 0 0", color: "var(--text-soft)", fontSize: "14px" }}>
            Device vulnerabilities (TVM) with drill-through to affected devices.
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
            data-testid="vuln-tenant-input"
          />
          <button
            type="button"
            style={buttonStyle}
            onClick={() => void fetchVulnerabilities(tenantId, filters)}
            data-testid="vuln-load-button"
          >
            Load
          </button>
        </div>
      </div>

      <VulnerabilityTable
        vulnerabilities={vulnerabilities}
        loading={loading}
        error={error}
        filters={filters}
        onFiltersChange={setFilters}
        onSelect={(vulnerability) => void handleSelect(vulnerability)}
      />

      <AffectedDevicesDrawer
        cve={selected?.cve ?? null}
        devices={devices}
        loading={devicesLoading}
        error={devicesError}
        onClose={() => setSelected(null)}
      />
    </div>
  );
}
