"use client";

// Licence Optimization page (EPIC-033 SPEC.md §3.2, §4.2, §11.1; T-0648).
// Advisory unused/overused/expiring findings with links to affected users.
import React, { useCallback, useEffect, useState, type CSSProperties } from "react";
import { useSearchParams } from "next/navigation";
import { RequireTenant } from "../../../../../components/shell/RequireTenant";
import { OptimizationCards } from "../../../../../components/licensing/OptimizationCards";
import { resolveTenantId, useCurrentTenantId } from "../../../../../lib/useCurrentTenant";
import {
  getLicenseOptimization,
  type LicenseOptimizationResult,
} from "../../../../../lib/licensingApi";

const pageStyle: CSSProperties = {
  padding: "32px",
  maxWidth: "1400px",
  margin: "0 auto",
  display: "flex",
  flexDirection: "column",
  gap: "20px",
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

function OptimizationView({ tenantId }: { readonly tenantId: string }) {
  const [inactivityDays, setInactivityDays] = useState(30);
  const [result, setResult] = useState<LicenseOptimizationResult | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(
    async (days: number): Promise<void> => {
      setLoading(true);
      setError(null);
      try {
        setResult(await getLicenseOptimization(tenantId, days));
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        setLoading(false);
      }
    },
    [tenantId],
  );

  useEffect(() => {
    void load(inactivityDays);
  }, [load, inactivityDays]);

  return (
    <div style={pageStyle} data-testid="license-optimization-page">
      <div>
        <h1 style={{ margin: 0, fontSize: "24px", fontFamily: "var(--font-display, var(--font-sans))" }}>
          Licence Optimization
        </h1>
        <p style={{ margin: "4px 0 0", color: "var(--text-soft)", fontSize: "14px" }}>
          Advisory unused, overused, and expiring licences. Nothing is removed automatically.
        </p>
      </div>

      <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
        <label htmlFor="inactivity-days" style={{ fontSize: "13px", color: "var(--text-soft)" }}>
          Inactivity window (days)
        </label>
        <input
          id="inactivity-days"
          type="number"
          min={1}
          max={3650}
          value={inactivityDays}
          onChange={(event) => setInactivityDays(Number(event.target.value) || 30)}
          style={{ ...inputStyle, width: "96px" }}
          data-testid="optimization-inactivity-days"
        />
        <button type="button" style={buttonStyle} onClick={() => void load(inactivityDays)} data-testid="optimization-reload">
          Refresh
        </button>
      </div>

      {error && (
        <div
          style={{ padding: "12px", background: "var(--danger-soft)", border: "1px solid var(--danger)", borderRadius: "6px", color: "var(--danger-text)" }}
          role="alert"
          data-testid="optimization-error"
        >
          {error}
        </div>
      )}

      {loading && !result && (
        <div style={{ color: "var(--text-soft)" }} data-testid="optimization-loading">
          Loading licence optimization…
        </div>
      )}

      {result && <OptimizationCards tenantId={tenantId} optimization={result} />}
    </div>
  );
}

export default function LicenseOptimizationPage() {
  const searchParams = useSearchParams();
  const tenantId = resolveTenantId(searchParams.get("tenantId"), useCurrentTenantId());
  return (
    <RequireTenant tenantId={tenantId}>
      <OptimizationView tenantId={tenantId} />
    </RequireTenant>
  );
}
