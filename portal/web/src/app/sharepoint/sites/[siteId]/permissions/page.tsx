"use client";

// Site permissions page (EPIC-025 SPEC.md §3.4, §4.3; T-0855).

import React, { type ReactElement } from "react";
import { SiteDetailShell } from "../../../../../components/sharepoint/SiteDetailShell";
import { SitePermissionsView } from "../../../../../components/sharepoint/SiteDetailViews";

export default function SitePermissionsPage(): ReactElement {
  return (
    <SiteDetailShell
      title="Site permissions"
      subtitle="Who has access to this site. Read-only; permission changes are handled in the sharing and permissions workflow."
      active="permissions"
    >
      {({ tenantId, siteId }) => <SitePermissionsView tenantId={tenantId} siteId={siteId} />}
    </SiteDetailShell>
  );
}
