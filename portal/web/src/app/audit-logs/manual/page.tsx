"use client";

// Manual Searches page (EPIC-032 SPEC.md §3.1; T-0627). Nav: Tenant
// Administration → Audit Logs. Hosts the ManualSearchForm (T-0622 search with
// the §3.1 filters and result columns, plus the View detail / Export CSV /
// Save search row actions). Zero colour literals: report theme tokens only.

import React, { useEffect, useState, type CSSProperties, type ReactElement } from "react";
import { ManualSearchForm } from "../../../components/audit/ManualSearchForm";
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

export interface ManualSearchPageProps {
  readonly fetcher?: typeof fetch;
}

export default function ManualSearchPage({ fetcher }: ManualSearchPageProps): ReactElement {
  const currentTenant = useCurrentTenantId();
  const [tenant, setTenant] = useState("");

  useEffect(() => {
    if (currentTenant) {
      setTenant(currentTenant);
    }
  }, [currentTenant]);

  return (
    <div style={pageStyle} data-testid="manual-search-page">
      <div style={headerStyle}>
        <div>
          <h1 style={titleStyle}>Manual Searches</h1>
          <p style={{ margin: "4px 0 0", color: "var(--text-soft)", fontSize: "14px" }}>
            Search audit logs by date range, user, activity, workload, or IP address.
          </p>
        </div>
        <input
          style={inputStyle}
          aria-label="Tenant id"
          data-testid="manual-search-tenant-input"
          placeholder="Tenant id…"
          value={tenant}
          onChange={(event) => setTenant(event.target.value)}
        />
      </div>

      <ManualSearchForm tenantId={tenant.trim()} fetcher={fetcher} />
    </div>
  );
}
