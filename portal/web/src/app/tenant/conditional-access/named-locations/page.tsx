"use client";

// Conditional Access named locations page (EPIC-015 SPEC.md §3.4, US-4; T-0884).
// The mounted /v1/tenants/:id/ca/named-locations routes back the list, create,
// edit, and delete actions rendered by NamedLocationsPanel.
import React from "react";
import { useSearchParams } from "next/navigation";
import { RequireTenant } from "../../../../components/shell/RequireTenant";
import { NamedLocationsPanel } from "../../../../components/conditionalAccess/NamedLocationsPanel";
import { resolveTenantId, useCurrentTenantId } from "../../../../lib/useCurrentTenant";

export default function CaNamedLocationsPage() {
  const searchParams = useSearchParams();
  const tenantId = resolveTenantId(searchParams.get("tenantId"), useCurrentTenantId());
  return (
    <RequireTenant tenantId={tenantId}>
      <div style={{ padding: "24px", maxWidth: "1400px", margin: "0 auto" }}>
        <NamedLocationsPanel tenantId={tenantId} />
      </div>
    </RequireTenant>
  );
}
