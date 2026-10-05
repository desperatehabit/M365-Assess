"use client";

// SharePoint recycle-bin page (EPIC-025 SPEC.md §2 US-3, §3.1, §4.1; T-0855).
// Lists the tenant's deleted sites (GET .../sharepoint/recyclebin) and restores or permanently
// empties selected entries (POST .../sharepoint/recyclebin); emptying asks for confirmation.

import React, { type CSSProperties, type ReactElement } from "react";
import { useSearchParams } from "next/navigation";
import { RecycleBin } from "../../../components/sharepoint/RecycleBin";
import { RequireTenant } from "../../../components/shell/RequireTenant";
import { resolveTenantId, useCurrentTenantId } from "../../../lib/useCurrentTenant";

const pageStyle: CSSProperties = {
  padding: "32px",
  maxWidth: "1400px",
  margin: "0 auto",
  fontFamily: "var(--font-sans, system-ui, sans-serif)",
  color: "var(--text)",
  display: "flex",
  flexDirection: "column",
  gap: "24px",
};

export default function SharePointRecycleBinPage(): ReactElement {
  const searchParams = useSearchParams();
  const tenantId = resolveTenantId(searchParams?.get("tenantId"), useCurrentTenantId());
  return (
    <RequireTenant tenantId={tenantId}>
      <div style={pageStyle} data-testid="sharepoint-recycle-bin-page">
        <div>
          <div style={{ fontSize: "12px", color: "var(--text-soft)" }}>
            Teams &amp; SharePoint &gt;{" "}
            <a href="/sharepoint/sites" style={{ color: "var(--accent)" }}>
              SharePoint Sites
            </a>{" "}
            &gt; Recycle bin
          </div>
          <h1
            style={{
              fontSize: "24px",
              fontWeight: 700,
              margin: "4px 0 0",
              fontFamily: "var(--font-display, var(--font-sans))",
            }}
          >
            SharePoint Recycle Bin
          </h1>
          <p style={{ margin: "4px 0 0", color: "var(--text-soft)", fontSize: "14px" }}>
            Restore deleted sites, or empty entries permanently. Emptying cannot be undone.
          </p>
        </div>
        <RecycleBin tenantId={tenantId} />
      </div>
    </RequireTenant>
  );
}
