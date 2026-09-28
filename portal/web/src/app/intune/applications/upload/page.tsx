"use client";

// Add app (upload wizard) — EPIC-017 SPEC.md §3.2; T-0326.
// Nav: Intune → Applications → Add app. Accepts ?fromDetected=&publisher=&version= from
// the detected-apps hand-off (T-0325).
import React from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { RequireTenant } from "../../../../components/shell/RequireTenant";
import { resolveTenantId, useCurrentTenantId } from "../../../../lib/useCurrentTenant";
import { AppUploadWizard } from "../../../../components/intune/AppUploadWizard";

export default function Page() {
  const searchParams = useSearchParams();
  const router = useRouter();
  const tenantId = resolveTenantId(searchParams.get("tenantId"), useCurrentTenantId());
  const tenantQuery = `tenantId=${encodeURIComponent(tenantId)}`;
  return (
    <RequireTenant tenantId={tenantId}>
      <main style={{ padding: "24px", maxWidth: "960px", margin: "0 auto" }}>
        <h2 style={{ marginTop: 0 }}>Add app</h2>
        <AppUploadWizard
          tenantId={tenantId}
          prefill={{
            displayName: searchParams.get("fromDetected") ?? undefined,
            publisher: searchParams.get("publisher") ?? undefined,
            version: searchParams.get("version") ?? undefined,
          }}
          onQueued={(queued) =>
            router.push(`/intune/applications/queue?${tenantQuery}&highlight=${encodeURIComponent(queued.deploymentId)}`)
          }
          onCancel={() => router.push(`/intune/applications?${tenantQuery}`)}
        />
      </main>
    </RequireTenant>
  );
}
