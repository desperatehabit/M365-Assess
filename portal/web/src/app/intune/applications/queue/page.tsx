"use client";

// Queued Applications — EPIC-017 SPEC.md §3.2; T-0326.
// Nav: Intune → Applications → Queued Applications.
import React from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { RequireTenant } from "../../../../components/shell/RequireTenant";
import { resolveTenantId, useCurrentTenantId } from "../../../../lib/useCurrentTenant";
import { QueuedApplications } from "../../../../components/intune/QueuedApplications";

export default function Page() {
  const searchParams = useSearchParams();
  const router = useRouter();
  const tenantId = resolveTenantId(searchParams.get("tenantId"), useCurrentTenantId());
  return (
    <RequireTenant tenantId={tenantId}>
      <main style={{ padding: "24px", maxWidth: "1280px", margin: "0 auto" }}>
        <h2 style={{ marginTop: 0 }}>Queued Applications</h2>
        <QueuedApplications
          tenantId={tenantId}
          navigate={(href) => router.push(href)}
          highlight={searchParams.get("highlight") ?? undefined}
        />
      </main>
    </RequireTenant>
  );
}
