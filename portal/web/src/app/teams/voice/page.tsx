"use client";

// Teams Business Voice page (EPIC-026 SPEC.md §3.3; T-0508).
// Nav: Teams & SharePoint → Teams Business Voice. Renders the voice-number
// inventory, the license-gate message when voice is not licensed, and the
// assign/release/policy dialogs through the VoiceNumbers component.

import React, { type ReactElement } from "react";
import { useSearchParams } from "next/navigation";
import { RequireTenant } from "../../../components/shell/RequireTenant";
import { resolveTenantId, useCurrentTenantId } from "../../../lib/useCurrentTenant";
import { VoiceNumbers } from "../../../components/teams/VoiceNumbers";

export default function VoicePage(): ReactElement {
  const searchParams = useSearchParams();
  const tenantId = resolveTenantId(searchParams.get("tenantId"), useCurrentTenantId());
  return (
    <RequireTenant tenantId={tenantId}>
      <VoiceNumbers tenantId={tenantId} />
    </RequireTenant>
  );
}
