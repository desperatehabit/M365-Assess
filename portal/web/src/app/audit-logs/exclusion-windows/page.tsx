"use client";

// Exclusion Windows page (EPIC-032 SPEC.md §3.6; T-0626, T-0629). Nav: Tenant
// Administration → Audit Logs. Hosts the ExclusionWindowsTable (active/upcoming
// windows with a create action; creation validates startsAt < endsAt). Zero
// colour literals: report theme tokens only.

import React, { useCallback, useEffect, useState, type CSSProperties, type ReactElement } from "react";
import {
  ExclusionWindowsTable,
  createAuditExclusionWindow,
  listAuditExclusionWindows,
  type AuditExclusionWindow,
  type AuditExclusionWindowInput,
} from "../../../components/audit/ExclusionWindowsTable";
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

export interface ExclusionWindowsPageProps {
  readonly fetcher?: typeof fetch;
}

export default function ExclusionWindowsPage({ fetcher }: ExclusionWindowsPageProps): ReactElement {
  const currentTenant = useCurrentTenantId();
  const [tenant, setTenant] = useState("");
  const [windows, setWindows] = useState<readonly AuditExclusionWindow[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (currentTenant) {
      setTenant(currentTenant);
    }
  }, [currentTenant]);

  const load = useCallback(async (): Promise<void> => {
    if (!tenant.trim()) {
      setWindows([]);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const result = await listAuditExclusionWindows(tenant.trim(), fetcher);
      setWindows(result.items);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setWindows([]);
    } finally {
      setLoading(false);
    }
  }, [tenant, fetcher]);

  useEffect(() => {
    void load();
  }, [load]);

  const handleCreate = async (input: AuditExclusionWindowInput): Promise<void> => {
    await createAuditExclusionWindow(tenant.trim(), input, fetcher);
    await load();
  };

  return (
    <div style={pageStyle} data-testid="exclusion-windows-page">
      <div style={headerStyle}>
        <div>
          <h1 style={titleStyle}>Exclusion Windows</h1>
          <p style={{ margin: "4px 0 0", color: "var(--text-soft)", fontSize: "14px" }}>
            Schedule periods during which scheduled audit searches are skipped.
          </p>
        </div>
        <input
          style={inputStyle}
          aria-label="Tenant id"
          data-testid="exclusion-windows-tenant-input"
          placeholder="Tenant id…"
          value={tenant}
          onChange={(event) => setTenant(event.target.value)}
        />
      </div>

      <ExclusionWindowsTable windows={windows} loading={loading} error={error} onCreate={handleCreate} />
    </div>
  );
}
