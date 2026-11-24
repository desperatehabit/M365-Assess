"use client";

// Intune reusable settings page (EPIC-016 SPEC.md §3.3, US-4; T-0885).
import React from "react";
import { useSearchParams } from "next/navigation";
import { RequireTenant } from "../../../components/shell/RequireTenant";
import { ReusableSettingsPanel } from "../../../components/intune/ReusableSettingsPanel";
import { resolveTenantId, useCurrentTenantId } from "../../../lib/useCurrentTenant";

export default function IntuneReusableSettingsPage() {
  const searchParams = useSearchParams();
  const tenantId = resolveTenantId(searchParams.get("tenantId"), useCurrentTenantId());
  return (
    <RequireTenant tenantId={tenantId}>
      <div style={{ padding: "24px", maxWidth: "1400px", margin: "0 auto" }}>
        <ReusableSettingsPanel tenantId={tenantId} />
      </div>
    </RequireTenant>
  );
}
