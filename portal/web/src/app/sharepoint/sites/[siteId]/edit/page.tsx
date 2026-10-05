"use client";

// Site edit page (EPIC-025 SPEC.md §3.1, §11 items 1 and 4; T-0855).

import React, { type ReactElement } from "react";
import { SiteDetailShell } from "../../../../../components/sharepoint/SiteDetailShell";
import { SiteEditView } from "../../../../../components/sharepoint/SiteDetailViews";

export default function SiteEditPage(): ReactElement {
  return (
    <SiteDetailShell
      title="Edit site"
      subtitle="Site details, the admin-center hand-off for advanced settings, and site deletion."
      active="edit"
    >
      {({ tenantId, siteId }) => <SiteEditView tenantId={tenantId} siteId={siteId} />}
    </SiteDetailShell>
  );
}
