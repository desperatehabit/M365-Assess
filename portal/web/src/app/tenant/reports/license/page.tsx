"use client";

// Licences page (EPIC-033 SPEC.md §3.1; T-0647).
// Tenant Administration → Reports → Licence. Reads the T-0642 consumption
// report and renders the LicenseTable. View users links into the users view;
// Assign/Unassign are exposed by LicenseTable and are wired to the licence
// assignment dialogs (T-0648) once that surface lands. Strictly uses report
// theme tokens with zero colour literals.

import React, { useCallback, useEffect, useState, type CSSProperties, type ReactElement } from "react";
import { useSearchParams } from "next/navigation";
import { RequireTenant } from "../../../../components/shell/RequireTenant";
import { resolveTenantId, useCurrentTenantId } from "../../../../lib/useCurrentTenant";
import { LicenseTable } from "../../../../components/licensing/LicenseTable";
import { getLicenseReport, type LicenseItem } from "../../../../lib/licensingApi";

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

function LicenseView({ tenantId }: { readonly tenantId: string }): ReactElement {
  const [items, setItems] = useState<LicenseItem[]>([]);
  const [loading, setLoading] = useState<boolean>(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async (): Promise<void> => {
    setLoading(true);
    setError(null);
    try {
      const report = await getLicenseReport(tenantId);
      setItems([...report.items]);
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
    <div style={pageStyle} data-testid="license-page">
      <header style={headerStyle}>
        <h1 style={titleStyle}>Licences</h1>
        <p style={subtitleStyle}>
          Consumption per subscribed SKU, with utilization and effective monthly cost.
        </p>
      </header>

      <LicenseTable items={items} tenantId={tenantId} loading={loading} error={error} />
    </div>
  );
}

export default function LicensePage(): ReactElement {
  const searchParams = useSearchParams();
  const tenantId = resolveTenantId(searchParams.get("tenantId"), useCurrentTenantId());
  return (
    <RequireTenant tenantId={tenantId}>
      <LicenseView tenantId={tenantId} />
    </RequireTenant>
  );
}
