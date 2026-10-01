"use client";

// License Pricing page (EPIC-033 SPEC.md §3.3, §11.2; T-0647).
// Tenant Administration → Reports → Licence → License Pricing. Reads the T-0644
// effective pricing for the tenant and lets an admin edit the per-SKU unit price
// and currency; a save writes the tenant override (global seed otherwise). The
// page entry is gated on the CIPP.Admin.* scope. Theme tokens only.

import React, { useCallback, useEffect, useState, type CSSProperties, type ReactElement } from "react";
import { useSearchParams } from "next/navigation";
import { PermissionGate } from "../../../../../components/PermissionGate";
import { RequireTenant } from "../../../../../components/shell/RequireTenant";
import { resolveTenantId, useCurrentTenantId } from "../../../../../lib/useCurrentTenant";
import { PricingTable } from "../../../../../components/licensing/PricingTable";
import {
  LICENSE_PRICING_ADMIN_SCOPE,
  listLicensePricing,
  saveLicensePricing,
  type LicensePricing,
  type LicensePricingInput,
} from "../../../../../lib/licensingApi";

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
  borderBottom: "1px solid var(--border)",
  paddingBottom: "16px",
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

function PricingView({ tenantId }: { readonly tenantId: string }): ReactElement {
  const [rows, setRows] = useState<LicensePricing[]>([]);
  const [loading, setLoading] = useState<boolean>(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async (): Promise<void> => {
    setLoading(true);
    setError(null);
    try {
      setRows(await listLicensePricing(tenantId));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [tenantId]);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <div style={pageStyle} data-testid="license-pricing-page">
      <header style={headerStyle}>
        <h1 style={titleStyle}>License Pricing</h1>
        <p style={subtitleStyle}>
          Effective unit price per SKU for this tenant; saving writes the tenant override.
        </p>
      </header>

      <PricingTable
        rows={rows}
        tenantId={tenantId}
        loading={loading}
        error={error}
        onSave={(input: LicensePricingInput) => saveLicensePricing({ ...input, tenantId })}
      />
    </div>
  );
}

export default function LicensePricingPage(): ReactElement {
  const searchParams = useSearchParams();
  const tenantId = resolveTenantId(searchParams.get("tenantId"), useCurrentTenantId());
  return (
    <RequireTenant tenantId={tenantId}>
      <PermissionGate
        permission={LICENSE_PRICING_ADMIN_SCOPE}
        fallback={
          <p role="alert" style={{ margin: 0, color: "var(--danger-text)" }} data-testid="license-pricing-forbidden">
            You do not have permission to edit license pricing.
          </p>
        }
      >
        <PricingView tenantId={tenantId} />
      </PermissionGate>
    </RequireTenant>
  );
}
