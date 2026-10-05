"use client";

// Shared frame for the SharePoint site detail pages (EPIC-025 SPEC.md §3.1, §3.4; T-0855):
// resolves the tenant (?tenantId= wins over the shell selection) and the site id from the
// route, and renders the breadcrumb and the Browse / Edit / Permissions / External users
// tabs that the sites list row actions link to.

import React, { type CSSProperties, type ReactElement, type ReactNode } from "react";
import { useParams, useSearchParams } from "next/navigation";
import { RequireTenant } from "../shell/RequireTenant";
import { decodeSiteId } from "../../lib/sharepointApi";
import { resolveTenantId, useCurrentTenantId } from "../../lib/useCurrentTenant";

export type SiteDetailTab = "browse" | "edit" | "permissions" | "external-users";

const TABS: readonly { readonly id: SiteDetailTab; readonly label: string }[] = [
  { id: "browse", label: "Browse" },
  { id: "edit", label: "Edit" },
  { id: "permissions", label: "Permissions" },
  { id: "external-users", label: "External users" },
];

export interface SiteRoute {
  readonly tenantId: string;
  readonly siteId: string;
}

/** Tenant and site for a `/sharepoint/sites/[siteId]/...` page. */
export function useSiteRoute(): SiteRoute {
  const params = useParams();
  const searchParams = useSearchParams();
  const currentTenant = useCurrentTenantId();
  const rawSiteId = params["siteId"];
  return {
    tenantId: resolveTenantId(searchParams?.get("tenantId"), currentTenant),
    siteId: decodeSiteId(typeof rawSiteId === "string" || Array.isArray(rawSiteId) ? rawSiteId : undefined),
  };
}

/** Link to another page of the same site, carrying an explicit ?tenantId= through. */
export function siteTabHref(siteId: string, tab: SiteDetailTab, tenantId: string, fromQuery: boolean): string {
  const base = `/sharepoint/sites/${encodeURIComponent(siteId)}/${tab}`;
  return fromQuery ? `${base}?tenantId=${encodeURIComponent(tenantId)}` : base;
}

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

const tabStyle: CSSProperties = {
  padding: "8px 14px",
  border: "1px solid var(--border)",
  borderRadius: "6px",
  background: "var(--surface)",
  color: "var(--text)",
  fontSize: "14px",
  fontWeight: 500,
  textDecoration: "none",
};

const activeTabStyle: CSSProperties = {
  ...tabStyle,
  background: "var(--accent)",
  color: "var(--on-accent)",
  borderColor: "var(--accent)",
};

export interface SiteDetailShellProps {
  readonly title: string;
  readonly subtitle: string;
  readonly active: SiteDetailTab;
  readonly children: (route: SiteRoute) => ReactNode;
}

export function SiteDetailShell({ title, subtitle, active, children }: SiteDetailShellProps): ReactElement {
  const route = useSiteRoute();
  const searchParams = useSearchParams();
  const fromQuery = Boolean(searchParams?.get("tenantId")?.trim());

  return (
    <RequireTenant tenantId={route.tenantId}>
      <div style={pageStyle} data-testid="sharepoint-site-detail">
        <div>
          <div style={{ fontSize: "12px", color: "var(--text-soft)" }} data-testid="site-detail-breadcrumb">
            Teams &amp; SharePoint &gt;{" "}
            <a href="/sharepoint/sites" style={{ color: "var(--accent)" }}>
              SharePoint Sites
            </a>{" "}
            &gt; {title}
          </div>
          <h1
            style={{
              fontSize: "24px",
              fontWeight: 700,
              margin: "4px 0 0",
              fontFamily: "var(--font-display, var(--font-sans))",
            }}
          >
            {title}
          </h1>
          <p style={{ margin: "4px 0 0", color: "var(--text-soft)", fontSize: "14px" }}>{subtitle}</p>
          <p
            style={{ margin: "4px 0 0", color: "var(--text-soft)", fontSize: "12px", wordBreak: "break-all" }}
            data-testid="site-detail-id"
          >
            Site id: {route.siteId}
          </p>
        </div>
        <nav aria-label="Site sections" style={{ display: "flex", gap: "8px", flexWrap: "wrap" }}>
          {TABS.map((tab) => (
            <a
              key={tab.id}
              href={siteTabHref(route.siteId, tab.id, route.tenantId, fromQuery)}
              style={tab.id === active ? activeTabStyle : tabStyle}
              aria-current={tab.id === active ? "page" : undefined}
              data-testid={`site-tab-${tab.id}`}
            >
              {tab.label}
            </a>
          ))}
        </nav>
        {children(route)}
      </div>
    </RequireTenant>
  );
}
