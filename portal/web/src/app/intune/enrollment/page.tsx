"use client";

// Enrollment profiles — EPIC-017 SPEC.md §3.5; T-0846.
import React from "react";
import { useSearchParams } from "next/navigation";
import { RequireTenant } from "../../../components/shell/RequireTenant";
import { resolveTenantId, useCurrentTenantId } from "../../../lib/useCurrentTenant";
import { EnrollmentProfilesPage } from "../../../components/intune/EnrollmentProfiles";

export default function Page() {
  const searchParams = useSearchParams();
  const tenantId = resolveTenantId(searchParams.get("tenantId"), useCurrentTenantId());
  return (
    <RequireTenant tenantId={tenantId}>
      <main style={{ padding: "24px", maxWidth: "1280px", margin: "0 auto" }}>
        <EnrollmentProfilesPage tenantId={tenantId} />
      </main>
    </RequireTenant>
  );
}
