"use client";

// SharePoint Sites page (EPIC-025 SPEC.md §2 US-1/US-3, §3.1; T-0483).
// Page title "SharePoint Sites": the §3.1 site list read live from Graph via
// GET /v1/tenants/{id}/sharepoint/sites (T-0482), rendered by SitesTable with
// the §3.1 filters and an active/deleted view toggle. The deleted view reads
// the recycle-bin list (T-0485). Row actions hand to the site browser
// (T-0488) and the lifecycle UI (T-0485/T-0486); no writes happen on this
// page. Strictly uses report theme tokens with zero colour literals.

import React, { useCallback, useEffect, useState, type CSSProperties, type ReactElement } from "react";
import { useRouter } from "next/navigation";
import {
  SitesTable,
  type SharePointSite,
  type SitesView,
} from "../../../components/sharepoint/SitesTable";
import { useCurrentTenantId } from "../../../lib/useCurrentTenant";

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

const headerStyle: CSSProperties = {
  display: "flex",
  justifyContent: "space-between",
  alignItems: "center",
  borderBottom: "1px solid var(--border)",
  paddingBottom: "16px",
  flexWrap: "wrap",
  gap: "16px",
};

const titleStyle: CSSProperties = {
  fontSize: "24px",
  fontWeight: 700,
  margin: 0,
  fontFamily: "var(--font-display, var(--font-sans))",
};

const subtitleStyle: CSSProperties = {
  margin: "4px 0 0",
  color: "var(--text-soft)",
  fontSize: "14px",
};

const inputStyle: CSSProperties = {
  padding: "8px 12px",
  background: "var(--input-bg, var(--bg))",
  border: "1px solid var(--border)",
  borderRadius: "6px",
  color: "var(--text)",
  fontSize: "14px",
};

const buttonStyle: CSSProperties = {
  padding: "8px 14px",
  background: "var(--surface)",
  border: "1px solid var(--border)",
  borderRadius: "6px",
  color: "var(--text)",
  fontSize: "14px",
  fontWeight: 500,
  cursor: "pointer",
};

const activeToggleStyle: CSSProperties = {
  ...buttonStyle,
  background: "var(--accent)",
  color: "var(--on-accent)",
  borderColor: "var(--accent)",
};

const handoffBannerStyle: CSSProperties = {
  padding: "12px 14px",
  borderRadius: "6px",
  background: "var(--surface)",
  border: "1px solid var(--border)",
  color: "var(--text-soft)",
  fontSize: "13px",
  lineHeight: "1.5",
};

type Fetcher = typeof fetch;

async function readError(response: Response, fallback: string): Promise<Error> {
  let detail = fallback;
  try {
    const body = (await response.json()) as { message?: string };
    if (body?.message) detail = body.message;
  } catch {
    detail = `${fallback}: HTTP ${response.status}`;
  }
  return new Error(detail);
}

async function fetchSites(tenantId: string, fetcher: Fetcher): Promise<SharePointSite[]> {
  const response = await fetcher(`/v1/tenants/${encodeURIComponent(tenantId)}/sharepoint/sites?limit=100`, {
    method: "GET",
    headers: { Accept: "application/json" },
  });
  if (!response.ok) throw await readError(response, "List SharePoint sites");
  const payload = (await response.json()) as { items?: SharePointSite[] };
  return payload.items ?? [];
}

// The recycle-bin list (T-0485) carries the same site shape as the list API.
async function fetchDeletedSites(tenantId: string, fetcher: Fetcher): Promise<SharePointSite[]> {
  const response = await fetcher(`/v1/tenants/${encodeURIComponent(tenantId)}/sharepoint/recyclebin`, {
    method: "GET",
    headers: { Accept: "application/json" },
  });
  if (!response.ok) throw await readError(response, "List deleted SharePoint sites");
  const payload = (await response.json()) as { items?: SharePointSite[] };
  return payload.items ?? [];
}

export default function SharePointSitesPage(): ReactElement {
  const router = useRouter();
  const [tenantId, setTenantId] = useState("");
  const currentTenant = useCurrentTenantId();
  const [view, setView] = useState<SitesView>("active");
  const [sites, setSites] = useState<SharePointSite[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const loadSites = useCallback(
    async (tenant: string, targetView: SitesView): Promise<void> => {
      if (!tenant.trim()) {
        setError("Enter a tenant id to list SharePoint sites.");
        return;
      }
      setLoading(true);
      setError(null);
      try {
        const items =
          targetView === "deleted"
            ? await fetchDeletedSites(tenant.trim(), fetch)
            : await fetchSites(tenant.trim(), fetch);
        setSites(items);
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        setLoading(false);
      }
    },
    [],
  );

  useEffect(() => {
    if (currentTenant) {
      setTenantId(currentTenant);
      void loadSites(currentTenant, view);
    }
  }, [currentTenant, view, loadSites]);

  function openSite(site: SharePointSite): void {
    window.open(site.url, "_blank", "noopener,noreferrer");
  }

  function browseSite(site: SharePointSite): void {
    void router.push(`/sharepoint/sites/${encodeURIComponent(site.id)}/browse`);
  }

  function editSite(site: SharePointSite): void {
    void router.push(`/sharepoint/sites/${encodeURIComponent(site.id)}/edit`);
  }

  function permissionsSite(site: SharePointSite): void {
    void router.push(`/sharepoint/sites/${encodeURIComponent(site.id)}/permissions`);
  }

  function externalUsersSite(site: SharePointSite): void {
    void router.push(`/sharepoint/sites/${encodeURIComponent(site.id)}/external-users`);
  }

  function showDeletedView(): void {
    setView("deleted");
  }

  function showActiveView(): void {
    setView("active");
  }

  return (
    <div style={pageStyle} data-testid="sharepoint-sites-page">
      <div style={headerStyle}>
        <div>
          <h1 style={titleStyle}>SharePoint Sites</h1>
          <p style={subtitleStyle}>
            SharePoint sites read live from Graph, with filters and a deleted-sites view. Site lifecycle and
            browser actions are handed to the owning tickets.
          </p>
        </div>
        <div style={{ display: "flex", gap: "10px", alignItems: "center" }}>
          <input
            type="text"
            placeholder="Tenant id..."
            value={tenantId}
            onChange={(e) => setTenantId(e.target.value)}
            style={inputStyle}
            aria-label="Tenant id"
            data-testid="sites-tenant-input"
          />
          <button
            type="button"
            style={buttonStyle}
            onClick={() => void loadSites(tenantId, view)}
            data-testid="sites-load-button"
          >
            Load
          </button>
          <button
            type="button"
            style={view === "active" ? activeToggleStyle : buttonStyle}
            onClick={showActiveView}
            aria-pressed={view === "active"}
            data-testid="view-toggle-active"
          >
            Active sites
          </button>
          <button
            type="button"
            style={view === "deleted" ? activeToggleStyle : buttonStyle}
            onClick={showDeletedView}
            aria-pressed={view === "deleted"}
            data-testid="view-toggle-deleted"
          >
            Deleted sites
          </button>
        </div>
      </div>

      <div style={handoffBannerStyle} data-testid="sites-handoff-banner">
        Delete, restore, and recycle-bin operations are delivered with the site lifecycle UI (T-0485/T-0486);
        the site browser (T-0488) renders libraries, permissions, and external users. No writes happen on this
        page.
      </div>

      <SitesTable
        key={view}
        sites={sites}
        loading={loading}
        error={error}
        view={view}
        onViewSite={openSite}
        onBrowse={browseSite}
        onEdit={editSite}
        onPermissions={permissionsSite}
        onExternalUsers={externalUsersSite}
        onRecycleBin={showDeletedView}
      />
    </div>
  );
}
