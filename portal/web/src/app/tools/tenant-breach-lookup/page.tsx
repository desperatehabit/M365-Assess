"use client";

// Tenant Breach Lookup page (EPIC-040 SPEC.md §3.4; T-0870). Pre-fills the
// selected tenant so an operator can query the tenant itself (or add an account)
// without retyping the id. The same fail-closed breach provider backs it.

import React, { type ReactElement } from "react";
import { useCurrentTenantId } from "../../../lib/useCurrentTenant";
import { BreachLookupView } from "../breach-lookup/BreachLookupView";

export default function TenantBreachLookupPage(): ReactElement {
  const tenantId = useCurrentTenantId();
  return <BreachLookupView tenantId={tenantId ?? undefined} tenantOnly />;
}
