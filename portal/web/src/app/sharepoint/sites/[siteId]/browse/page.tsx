"use client";

// Site browse page (EPIC-025 SPEC.md §3.3, §3.4; T-0855).

import React, { type ReactElement } from "react";
import { SiteDetailShell } from "../../../../../components/sharepoint/SiteDetailShell";
import { SiteBrowseView } from "../../../../../components/sharepoint/SiteDetailViews";

export default function SiteBrowsePage(): ReactElement {
  return (
    <SiteDetailShell
      title="Browse site"
      subtitle="Storage composition, version cleanup, and the site's libraries, items, permissions, and external users."
      active="browse"
    >
      {({ tenantId, siteId }) => <SiteBrowseView tenantId={tenantId} siteId={siteId} />}
    </SiteDetailShell>
  );
}
