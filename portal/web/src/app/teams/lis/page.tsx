"use client";

// LIS Locations page — Teams & SharePoint -> Teams Business Voice -> LIS Locations
// (EPIC-026 SPEC.md §3.4; T-0509).
import React from "react";
import { useSearchParams } from "next/navigation";
import { RequireTenant } from "../../../components/shell/RequireTenant";
import { resolveTenantId, useCurrentTenantId } from "../../../lib/useCurrentTenant";
import { LisLocations } from "../../../components/teams/LisLocations";

function LisLocationsView({ tenantId }: { readonly tenantId: string }): React.ReactElement {
  return (
    <div style={{ padding: "24px", display: "flex", flexDirection: "column", gap: "20px" }}>
      <div style={{ display: "flex", flexDirection: "column", gap: "4px" }}>
        <div style={{ fontSize: "12px", color: "var(--text-muted, #6b7280)" }}>
          Teams &amp; SharePoint &gt; Teams Business Voice &gt; LIS Locations
        </div>
        <h1 style={{ fontSize: "24px", fontWeight: 700, margin: 0 }}>LIS Locations</h1>
      </div>

      <LisLocations tenantId={tenantId} />
    </div>
  );
}

export default function LisLocationsPage(): React.ReactElement {
  const searchParams = useSearchParams();
  const tenantId = resolveTenantId(searchParams.get("tenantId"), useCurrentTenantId());
  return (
    <RequireTenant tenantId={tenantId}>
      <LisLocationsView tenantId={tenantId} />
    </RequireTenant>
  );
}
