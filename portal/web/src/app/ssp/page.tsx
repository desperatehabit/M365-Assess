"use client";

// CMMC Level 2 SSP questionnaire for the selected tenant (see components/ssp).
import { useSearchParams } from "next/navigation";
import type { ReactElement } from "react";
import { RequireTenant } from "../../components/shell/RequireTenant";
import { SspQuestionnaire } from "../../components/ssp/SspQuestionnaire";
import { resolveTenantId, useCurrentTenantId } from "../../lib/useCurrentTenant";

export default function SspPage(): ReactElement {
  const searchParams = useSearchParams();
  const tenantId = resolveTenantId(searchParams.get("tenantId"), useCurrentTenantId());
  return (
    <RequireTenant tenantId={tenantId}>
      <SspQuestionnaire tenantId={tenantId} />
    </RequireTenant>
  );
}
