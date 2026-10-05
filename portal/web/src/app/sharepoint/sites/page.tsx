"use client";

// SharePoint Sites page (EPIC-025 SPEC.md §2 US-1..US-3, §3.1, §3.2; T-0483, T-0855).
// Page title "SharePoint Sites": the §3.1 site list read live from Graph via
// GET /v1/tenants/{id}/sharepoint/sites, rendered by SitesTable with the §3.1
// filters and an active/deleted view. The deleted view reads the recycle-bin list.
// Row actions open the site detail pages (browse, edit, permissions, external
// users), delete through SiteDeleteDialog, restore through the restore endpoint, and
// hand the recycle bin to its own page; "Add site" opens AddSiteWizard. Strictly
// uses report theme tokens with zero colour literals.

import React, { useCallback, useEffect, useState, type CSSProperties, type ReactElement } from "react";
import { useRouter } from "next/navigation";
import { AddSiteWizard } from "../../../components/sharepoint/AddSiteWizard";
import { SiteDeleteDialog } from "../../../components/sharepoint/SiteDeleteDialog";
import {
  SitesTable,
  type SharePointSite,
  type SitesView,
} from "../../../components/sharepoint/SitesTable";
import { fetchDeletedSites, fetchSites, restoreSite } from "../../../lib/sharepointApi";
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

const noticeStyle: CSSProperties = {
  padding: "12px 14px",
  borderRadius: "6px",
  background: "var(--surface)",
  border: "1px solid var(--border)",
  color: "var(--text-soft)",
  fontSize: "13px",
  lineHeight: "1.5",
};

const wizardPanelStyle: CSSProperties = {
  background: "var(--bg-elev)",
  border: "1px solid var(--border)",
  borderRadius: "var(--radius, 10px)",
  padding: "16px",
};

export default function SharePointSitesPage(): ReactElement {
  const router = useRouter();
  const [tenantId, setTenantId] = useState("");
  const currentTenant = useCurrentTenantId();
  const [view, setView] = useState<SitesView>("active");
  const [sites, setSites] = useState<SharePointSite[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showWizard, setShowWizard] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<SharePointSite | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

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
            ? await fetchDeletedSites(tenant.trim())
            : await fetchSites(tenant.trim());
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

  // The detail pages default to the shell's tenant; a different tenant typed into the box
  // here travels as ?tenantId= so it is not silently replaced.
  function withTenant(path: string): string {
    const typed = tenantId.trim();
    return typed && typed !== currentTenant ? `${path}?tenantId=${encodeURIComponent(typed)}` : path;
  }

  function detailHref(site: SharePointSite, tab: string): string {
    return withTenant(`/sharepoint/sites/${encodeURIComponent(site.id)}/${tab}`);
  }

  function recycleBinHref(): string {
    return withTenant("/sharepoint/recycle-bin");
  }

  function browseSite(site: SharePointSite): void {
    void router.push(detailHref(site, "browse"));
  }

  function editSite(site: SharePointSite): void {
    void router.push(detailHref(site, "edit"));
  }

  function permissionsSite(site: SharePointSite): void {
    void router.push(detailHref(site, "permissions"));
  }

  function externalUsersSite(site: SharePointSite): void {
    void router.push(detailHref(site, "external-users"));
  }

  function openRecycleBin(): void {
    void router.push(recycleBinHref());
  }

  async function restoreDeletedSite(site: SharePointSite): Promise<void> {
    setNotice(null);
    try {
      await restoreSite(tenantId.trim(), site.id);
      setNotice(`Restored ${site.name}.`);
      await loadSites(tenantId, "deleted");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
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
            SharePoint sites read live from Graph, with filters and a deleted-sites view.
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
          <button
            type="button"
            style={buttonStyle}
            onClick={() => setShowWizard((open) => !open)}
            disabled={!tenantId.trim()}
            data-testid="add-site-button"
          >
            Add site
          </button>
        </div>
      </div>

      {showWizard && tenantId.trim() && (
        <div style={wizardPanelStyle} data-testid="add-site-panel">
          <AddSiteWizard
            tenantId={tenantId.trim()}
            onClose={() => setShowWizard(false)}
            onCreated={() => void loadSites(tenantId, view)}
          />
        </div>
      )}

      {notice && (
        <div style={noticeStyle} role="status" data-testid="sites-notice">
          {notice}
        </div>
      )}

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
        onDelete={setDeleteTarget}
        onRestore={(site) => void restoreDeletedSite(site)}
        onRecycleBin={openRecycleBin}
        onEmptyRecycleBin={openRecycleBin}
      />

      <SiteDeleteDialog
        isOpen={deleteTarget !== null}
        tenantId={tenantId.trim()}
        site={deleteTarget ? { id: deleteTarget.id, name: deleteTarget.name, url: deleteTarget.url } : null}
        onClose={() => setDeleteTarget(null)}
        onDeleted={() => {
          setNotice(`Deleted ${deleteTarget?.name ?? "site"}. It can be restored from the recycle bin.`);
          void loadSites(tenantId, view);
        }}
      />
    </div>
  );
}
