"use client";

// Autopilot profiles — EPIC-017 SPEC.md §3.4; T-0846.
import React from "react";
import { useSearchParams } from "next/navigation";
import { RequireTenant } from "../../../../components/shell/RequireTenant";
import { resolveTenantId, useCurrentTenantId } from "../../../../lib/useCurrentTenant";
import { AutopilotProfilesPage } from "../../../../components/intune/AutopilotProfiles";

export default function Page() {
  const searchParams = useSearchParams();
  const tenantId = resolveTenantId(searchParams.get("tenantId"), useCurrentTenantId());
  return (
    <RequireTenant tenantId={tenantId}>
      <main style={{ padding: "24px", maxWidth: "1280px", margin: "0 auto" }}>
        <AutopilotProfilesPage tenantId={tenantId} />
      </main>
    </RequireTenant>
  );
}
