"use client";

// New team page (EPIC-026 SPEC.md §2 US-2, §3.1, §4.1; T-0506/T-0856).
// Nav: Teams & SharePoint → Teams → Add team. Hosts the AddTeamWizard, which
// previews the resolved plan (including a local template expansion) and then
// posts the create to POST /v1/tenants/{id}/teams. `cloneFrom` is accepted so
// the Teams row's Clone action lands here; the wizard creates a fresh team.

import React, { type CSSProperties, type ReactElement } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { RequireTenant } from "../../../components/shell/RequireTenant";
import { AddTeamWizard } from "../../../components/teams/AddTeamWizard";
import { resolveTenantId, useCurrentTenantId } from "../../../lib/useCurrentTenant";

const pageStyle: CSSProperties = {
  padding: "32px",
  maxWidth: "900px",
  margin: "0 auto",
  display: "flex",
  flexDirection: "column",
  gap: "20px",
  fontFamily: "var(--font-sans, system-ui, sans-serif)",
  color: "var(--text)",
};

export default function NewTeamPage(): ReactElement {
  const router = useRouter();
  const searchParams = useSearchParams();
  const tenantId = resolveTenantId(searchParams.get("tenantId"), useCurrentTenantId());
  const cloneFrom = searchParams.get("cloneFrom");

  return (
    <RequireTenant tenantId={tenantId}>
      <div style={pageStyle} data-testid="team-new-page">
        <div>
          <div style={{ fontSize: "12px", color: "var(--text-soft)" }}>
            Teams &amp; SharePoint &gt; Teams &gt; Add team
          </div>
          <h1 style={{ fontSize: "24px", fontWeight: 700, margin: "4px 0 0" }}>Add team</h1>
          {cloneFrom !== null && (
            <p style={{ margin: "4px 0 0", color: "var(--text-soft)", fontSize: "14px" }}>
              Creating a new team from {cloneFrom}. Review the configuration before creating it.
            </p>
          )}
        </div>
        <AddTeamWizard
          tenantId={tenantId}
          onClose={() => router.push(`/teams?tenantId=${encodeURIComponent(tenantId)}`)}
          onCreated={() => router.push(`/teams?tenantId=${encodeURIComponent(tenantId)}`)}
        />
      </div>
    </RequireTenant>
  );
}
