"use client";

// Assign app — EPIC-017 SPEC.md §4.2; T-0843.
// Reached from Applications → Assign and Queued Applications → Assign (?tenantId=&appId=).
import React from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { RequireTenant } from "../../../../components/shell/RequireTenant";
import { resolveTenantId, useCurrentTenantId } from "../../../../lib/useCurrentTenant";
import { AppAssignmentPanel } from "../../../../components/intune/AppAssignmentPanel";

export default function Page() {
  const searchParams = useSearchParams();
  const router = useRouter();
  const tenantId = resolveTenantId(searchParams.get("tenantId"), useCurrentTenantId());
  const appId = searchParams.get("appId") ?? "";
  return (
    <RequireTenant tenantId={tenantId}>
      <main style={{ padding: "24px", maxWidth: "960px", margin: "0 auto" }}>
        {appId ? (
          <AppAssignmentPanel tenantId={tenantId} appId={appId} />
        ) : (
          <p>
            Choose an app to assign from{" "}
            <button type="button" onClick={() => router.push(`/intune/applications?tenantId=${encodeURIComponent(tenantId)}`)}>
              Applications
            </button>
            .
          </p>
        )}
      </main>
    </RequireTenant>
  );
}
