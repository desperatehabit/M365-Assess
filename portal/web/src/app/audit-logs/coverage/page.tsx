"use client";

// Search Coverage page (EPIC-032 SPEC.md §3.3, §4.2; T-0624, T-0628). Nav:
// Tenant Administration → Audit Logs. Hosts the CoverageTable, which renders
// per-tenant audit-log ingestion state, search windows, and gaps linking to the
// EPIC-006 audit-enablement remediation. Zero colour literals: report theme
// tokens only.

import React, { useEffect, useState, type CSSProperties, type ReactElement } from "react";
import { CoverageTable } from "../../../components/audit/CoverageTable";
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

const inputStyle: CSSProperties = {
  padding: "8px 12px",
  background: "var(--input-bg, var(--bg))",
  border: "1px solid var(--border)",
  borderRadius: "6px",
  color: "var(--text)",
  fontSize: "14px",
};

export interface CoveragePageProps {
  readonly fetcher?: typeof fetch;
}

export default function CoveragePage({ fetcher }: CoveragePageProps): ReactElement {
  const currentTenant = useCurrentTenantId();
  const [tenant, setTenant] = useState("");

  useEffect(() => {
    if (currentTenant) {
      setTenant(currentTenant);
    }
  }, [currentTenant]);

  return (
    <div style={pageStyle} data-testid="coverage-page">
      <div style={headerStyle}>
        <div>
          <h1 style={titleStyle}>Search Coverage</h1>
          <p style={{ margin: "4px 0 0", color: "var(--text-soft)", fontSize: "14px" }}>
            Which tenants have audit-log ingestion enabled, their search windows, and gaps —
            so you know where audit visibility is missing.
          </p>
        </div>
        <input
          style={inputStyle}
          aria-label="Tenant id"
          data-testid="coverage-tenant-input"
          placeholder="Tenant id…"
          value={tenant}
          onChange={(event) => setTenant(event.target.value)}
        />
      </div>

      <CoverageTable tenantId={tenant.trim()} fetcher={fetcher} />
    </div>
  );
}
