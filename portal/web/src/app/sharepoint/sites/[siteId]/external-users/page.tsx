"use client";

// Site external users page (EPIC-025 SPEC.md §3.4; T-0855).

import React, { type ReactElement } from "react";
import { SiteDetailShell } from "../../../../../components/sharepoint/SiteDetailShell";
import { SiteExternalUsersView } from "../../../../../components/sharepoint/SiteDetailViews";

export default function SiteExternalUsersPage(): ReactElement {
  return (
    <SiteDetailShell
      title="Site external users"
      subtitle="External identities with access to this site. Read-only."
      active="external-users"
    >
      {({ tenantId, siteId }) => <SiteExternalUsersView tenantId={tenantId} siteId={siteId} />}
    </SiteDetailShell>
  );
}
