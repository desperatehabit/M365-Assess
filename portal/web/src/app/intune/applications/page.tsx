"use client";

// Applications page — EPIC-017 SPEC.md §3.1; T-0325.
// Nav: Intune → Applications → Applications.
import React from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { RequireTenant } from "../../../components/shell/RequireTenant";
import { resolveTenantId, useCurrentTenantId } from "../../../lib/useCurrentTenant";
import { ApplicationsPage } from "../../../components/intune/ApplicationTable";

export default function Page() {
  const searchParams = useSearchParams();
  const router = useRouter();
  const tenantId = resolveTenantId(searchParams.get("tenantId"), useCurrentTenantId());
  return (
    <RequireTenant tenantId={tenantId}>
      <ApplicationsPage tenantId={tenantId} navigate={(href) => router.push(href)} />
    </RequireTenant>
  );
}
