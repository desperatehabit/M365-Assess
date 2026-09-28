"use client";

// Status Pages — EPIC-017 SPEC.md §3.6; T-0330.
// Nav: Intune → Autopilot & Enrollment → Status Pages.
import React from "react";
import { useSearchParams } from "next/navigation";
import { RequireTenant } from "../../../components/shell/RequireTenant";
import { resolveTenantId, useCurrentTenantId } from "../../../lib/useCurrentTenant";
import { DeploymentStatusPage } from "../../../components/intune/DeploymentStatusTable";

export default function Page() {
  const searchParams = useSearchParams();
  const tenantId = resolveTenantId(searchParams.get("tenantId"), useCurrentTenantId());
  return (
    <RequireTenant tenantId={tenantId}>
      <main style={{ padding: "24px", maxWidth: "1280px", margin: "0 auto" }}>
        <h2 style={{ marginTop: 0 }}>Deployment and enrollment status</h2>
        <DeploymentStatusPage tenantId={tenantId} />
      </main>
    </RequireTenant>
  );
}
