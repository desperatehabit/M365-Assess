"use client";

// Remediation plan page (EPIC-006 SPEC.md §3.2, T-0112). Next gives a page no props, so this
// resolves the tenant (?tenantId= wins over the shell's tenant selector), an optional plan and
// run from the query string, and whether the caller may apply, then renders RemediationView.
// Without this the view had no tenant, so Generate plan stayed disabled.

import React, { type ReactElement } from "react";
import { useSearchParams } from "next/navigation";
import { usePermission } from "../../components/PermissionGate";
import { RemediationView } from "../../components/remediation/RemediationView";
import { RequireTenant } from "../../components/shell/RequireTenant";
import { resolveTenantId, useCurrentTenantId } from "../../lib/useCurrentTenant";

/** The permission the apply route requires (bff/src/routes/remediation.ts). */
const REMEDIATION_APPLY_PERMISSION = "Remediation.Apply";

export default function RemediationPage(): ReactElement {
  const searchParams = useSearchParams();
  const tenantId = resolveTenantId(searchParams?.get("tenantId"), useCurrentTenantId());
  const canApply = usePermission(REMEDIATION_APPLY_PERMISSION) === true;
  return (
    <RequireTenant tenantId={tenantId}>
      <RemediationView
        tenantId={tenantId}
        planId={searchParams?.get("planId") ?? ""}
        runId={searchParams?.get("runId") ?? ""}
        canApply={canApply}
      />
    </RequireTenant>
  );
}
