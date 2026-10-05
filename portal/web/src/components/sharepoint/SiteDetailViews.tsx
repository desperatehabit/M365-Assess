"use client";

// Bodies of the SharePoint site detail pages (EPIC-025 SPEC.md §3.1, §3.3, §3.4; T-0855).
// Each view reads the live BFF endpoints through lib/sharepointApi and renders the existing
// SharePoint components; the route files in app/sharepoint/sites/[siteId] only frame them.

import React, { useCallback, useEffect, useState, type CSSProperties, type ReactElement } from "react";
import { useRouter } from "next/navigation";
import { SiteBrowser, type SiteBrowserData, type SiteBrowserSection } from "./SiteBrowser";
import { SiteDeleteDialog, type SiteDeleteTarget } from "./SiteDeleteDialog";
import { StoragePanel, type SiteStorageComposition } from "./StoragePanel";
import {
  applyVersionCleanup,
  fetchSiteBrowser,
  fetchSiteStorage,
  fetchSites,
  previewVersionCleanup,
} from "../../lib/sharepointApi";

export interface SiteViewProps {
  readonly tenantId: string;
  readonly siteId: string;
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

interface BrowserState {
  readonly browser: SiteBrowserData | null;
  readonly loading: boolean;
  readonly error: string | null;
}

function useSiteBrowser(tenantId: string, siteId: string): BrowserState {
  const [state, setState] = useState<BrowserState>({ browser: null, loading: true, error: null });
  useEffect(() => {
    let cancelled = false;
    setState({ browser: null, loading: true, error: null });
    fetchSiteBrowser(tenantId, siteId)
      .then((browser) => {
        if (!cancelled) setState({ browser, loading: false, error: null });
      })
      .catch((err: unknown) => {
        if (!cancelled) setState({ browser: null, loading: false, error: errorText(err) });
      });
    return () => {
      cancelled = true;
    };
  }, [tenantId, siteId]);
  return state;
}

/** Storage composition + version cleanup (§3.3) above the read-only site browser (§3.4). */
export function SiteBrowseView({ tenantId, siteId }: SiteViewProps): ReactElement {
  const router = useRouter();
  const { browser, loading, error } = useSiteBrowser(tenantId, siteId);
  const [storage, setStorage] = useState<SiteStorageComposition | null>(null);
  const [storageLoading, setStorageLoading] = useState(true);
  const [storageError, setStorageError] = useState<string | null>(null);

  const loadStorage = useCallback(async (): Promise<void> => {
    setStorageLoading(true);
    setStorageError(null);
    try {
      setStorage(await fetchSiteStorage(tenantId, siteId));
    } catch (err) {
      setStorageError(errorText(err));
    } finally {
      setStorageLoading(false);
    }
  }, [tenantId, siteId]);

  useEffect(() => {
    void loadStorage();
  }, [loadStorage]);

  return (
    <>
      <StoragePanel
        storage={storage}
        loading={storageLoading}
        error={storageError}
        onPreviewCleanup={(input) => previewVersionCleanup(tenantId, siteId, input)}
        onApplyCleanup={async (input) => {
          const result = await applyVersionCleanup(tenantId, siteId, input);
          void loadStorage();
          return result;
        }}
      />
      <SiteBrowser
        browser={browser}
        loading={loading}
        error={error}
        onEditPermissions={() => router.push(`/sharepoint/sites/${encodeURIComponent(siteId)}/permissions`)}
      />
    </>
  );
}

function SiteBrowserSlice({
  tenantId,
  siteId,
  sections,
  onEditPermissions,
}: SiteViewProps & {
  readonly sections: readonly SiteBrowserSection[];
  readonly onEditPermissions?: (browser: SiteBrowserData) => void;
}): ReactElement {
  const { browser, loading, error } = useSiteBrowser(tenantId, siteId);
  return (
    <SiteBrowser
      browser={browser}
      loading={loading}
      error={error}
      sections={sections}
      {...(onEditPermissions ? { onEditPermissions } : {})}
    />
  );
}

/** Read-only grants; changes hand to the EPIC-027 permissions report. */
export function SitePermissionsView({ tenantId, siteId }: SiteViewProps): ReactElement {
  const router = useRouter();
  return (
    <SiteBrowserSlice
      tenantId={tenantId}
      siteId={siteId}
      sections={["permissions"]}
      onEditPermissions={() => router.push(`/sharing/permissions?tenantId=${encodeURIComponent(tenantId)}`)}
    />
  );
}

/** Read-only external identities; removal hands to the EPIC-027 external-users report. */
export function SiteExternalUsersView({ tenantId, siteId }: SiteViewProps): ReactElement {
  return (
    <>
      <SiteBrowserSlice tenantId={tenantId} siteId={siteId} sections={["externalUsers"]} />
      <p style={{ margin: 0, color: "var(--text-soft)", fontSize: "13px" }}>
        Tenant-wide external-user review and sharing-link removal are in the{" "}
        <a
          href={`/sharing/external-users?tenantId=${encodeURIComponent(tenantId)}`}
          style={{ color: "var(--accent)" }}
          data-testid="external-users-report-link"
        >
          External users report
        </a>
        .
      </p>
    </>
  );
}

const panelStyle: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: "12px",
  padding: "16px",
  background: "var(--bg-elev)",
  border: "1px solid var(--border)",
  borderRadius: "var(--radius, 10px)",
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
  textDecoration: "none",
  alignSelf: "flex-start",
};

const dangerButtonStyle: CSSProperties = {
  ...buttonStyle,
  background: "var(--danger-soft)",
  borderColor: "var(--danger)",
  color: "var(--danger-text)",
};

/**
 * v1 site operations are list, add, delete, and restore (SPEC §11 item 1); no BFF endpoint edits site
 * properties, so this page offers the lifecycle action that exists (delete) and the admin-center
 * deep link for everything else (SPEC §11 item 4).
 */
export function SiteEditView({ tenantId, siteId }: SiteViewProps): ReactElement {
  const router = useRouter();
  const { browser, loading, error } = useSiteBrowser(tenantId, siteId);
  const [siteName, setSiteName] = useState<string | null>(null);
  const [deleteOpen, setDeleteOpen] = useState(false);

  // The browse endpoint carries no display name; take it from the site list when present.
  useEffect(() => {
    let cancelled = false;
    fetchSites(tenantId)
      .then((sites) => {
        const match = sites.find((site) => site.id === siteId);
        if (!cancelled && match) setSiteName(match.name);
      })
      .catch(() => {
        // the URL stands in as the name
      });
    return () => {
      cancelled = true;
    };
  }, [tenantId, siteId]);

  const target: SiteDeleteTarget | null = browser
    ? { id: siteId, name: siteName ?? browser.siteUrl, url: browser.siteUrl }
    : null;

  return (
    <>
      {loading && (
        <div style={{ ...panelStyle, color: "var(--text-soft)" }} data-testid="site-edit-loading">
          Loading site...
        </div>
      )}
      {error && (
        <div
          style={{
            padding: "16px",
            borderRadius: "6px",
            background: "var(--danger-soft)",
            border: "1px solid var(--danger)",
            color: "var(--danger-text)",
          }}
          role="alert"
          data-testid="site-edit-error"
        >
          {error}
        </div>
      )}
      {browser && (
        <>
          <div style={panelStyle} data-testid="site-edit-details">
            <h2 style={{ margin: 0, fontSize: "18px", fontWeight: 600 }}>{siteName ?? "Site"}</h2>
            <a
              href={browser.siteUrl}
              target="_blank"
              rel="noopener noreferrer"
              style={{ color: "var(--accent)", fontSize: "14px" }}
              data-testid="site-edit-url"
            >
              {browser.siteUrl}
            </a>
            <p style={{ margin: 0, color: "var(--text-soft)", fontSize: "13px" }}>
              The portal does not edit site properties in v1. Rename, template, sharing, and other advanced
              settings are changed in the SharePoint admin center.
            </p>
            <a
              href={browser.adminCenterUrl}
              target="_blank"
              rel="noopener noreferrer"
              style={buttonStyle}
              data-testid="site-edit-admin-center"
            >
              Edit in SharePoint admin center
            </a>
          </div>
          <div style={panelStyle} data-testid="site-edit-danger">
            <h2 style={{ margin: 0, fontSize: "18px", fontWeight: 600 }}>Delete site</h2>
            <p style={{ margin: 0, color: "var(--text-soft)", fontSize: "13px" }}>
              Deleting moves the site to the recycle bin, where it can be restored.
            </p>
            <button type="button" style={dangerButtonStyle} onClick={() => setDeleteOpen(true)} data-testid="site-edit-delete">
              Delete site
            </button>
          </div>
        </>
      )}
      <SiteDeleteDialog
        isOpen={deleteOpen}
        tenantId={tenantId}
        site={target}
        onClose={() => setDeleteOpen(false)}
        onDeleted={() => router.push("/sharepoint/sites")}
      />
    </>
  );
}
