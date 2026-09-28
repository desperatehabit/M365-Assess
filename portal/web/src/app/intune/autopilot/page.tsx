"use client";

// Autopilot devices — EPIC-017 SPEC.md §3.4; T-0846.
import React from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { RequireTenant } from "../../../components/shell/RequireTenant";
import { resolveTenantId, useCurrentTenantId } from "../../../lib/useCurrentTenant";
import { AutopilotDevicesPage } from "../../../components/intune/AutopilotDevices";

export default function Page() {
  const searchParams = useSearchParams();
  const router = useRouter();
  const tenantId = resolveTenantId(searchParams.get("tenantId"), useCurrentTenantId());
  return (
    <RequireTenant tenantId={tenantId}>
      <main style={{ padding: "24px", maxWidth: "1280px", margin: "0 auto" }}>
        <AutopilotDevicesPage tenantId={tenantId} navigate={(href) => router.push(href)} />
      </main>
    </RequireTenant>
  );
}
