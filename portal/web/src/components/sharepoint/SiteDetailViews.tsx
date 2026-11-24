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
  editSite,
  fetchSiteBrowser,
  fetchSiteStorage,
  fetchSites,
  previewVersionCleanup,
  type SharePointLockState,
  type SharePointSharing,
  type SiteEditInput,
  type SiteEditPlan,
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

const primaryButtonStyle: CSSProperties = {
  ...buttonStyle,
  background: "var(--accent)",
  borderColor: "var(--accent)",
  color: "var(--on-accent)",
};

const fieldStyle: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: "6px",
};

const labelStyle: CSSProperties = {
  fontSize: "13px",
  fontWeight: 600,
  color: "var(--text)",
};

const inputStyle: CSSProperties = {
  padding: "8px 12px",
  background: "var(--input-bg, var(--bg))",
  border: "1px solid var(--border)",
  borderRadius: "6px",
  color: "var(--text)",
  fontSize: "14px",
};

const SHARING_OPTIONS: readonly { readonly value: SharePointSharing; readonly label: string }[] = [
  { value: "disabled", label: "Disabled" },
  { value: "externalUserSharingOnly", label: "External users only" },
  { value: "externalUserAndGuestSharing", label: "External users and guests" },
  { value: "existingExternalUserSharingOnly", label: "Existing external users only" },
];

const LOCK_STATE_OPTIONS: readonly { readonly value: SharePointLockState; readonly label: string }[] = [
  { value: "Unlock", label: "Unlock" },
  { value: "NoAdditions", label: "No additions" },
  { value: "ReadOnly", label: "Read-only" },
  { value: "NoAccess", label: "No access" },
];

function parseOwnerUpns(raw: string): string[] {
  return raw
    .split(/[\n,;]+/)
    .map((entry) => entry.trim())
    .filter(Boolean);
}

/**
 * Edits site properties in-portal via PATCH /v1/tenants/:tenantId/sharepoint/sites/:siteId,
 * keeps the SharePoint admin-center deep link for advanced tenant/site-collection settings,
 * and exposes soft-delete through the named confirmation dialog.
 */
export function SiteEditView({ tenantId, siteId }: SiteViewProps): ReactElement {
  const router = useRouter();
  const { browser, loading, error } = useSiteBrowser(tenantId, siteId);
  const [siteName, setSiteName] = useState<string | null>(null);
  const [displayName, setDisplayName] = useState("");
  const [sharing, setSharing] = useState<SharePointSharing | "">("");
  const [lockState, setLockState] = useState<SharePointLockState | "">("");
  const [ownersInput, setOwnersInput] = useState("");
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [plan, setPlan] = useState<SiteEditPlan | null>(null);
  const [savedMessage, setSavedMessage] = useState<string | null>(null);
  const [deleteOpen, setDeleteOpen] = useState(false);

  // The browse endpoint carries no display name or sharing setting; hydrate them from the site list when present.
  useEffect(() => {
    let cancelled = false;
    fetchSites(tenantId)
      .then((sites) => {
        const match = sites.find((site) => site.id === siteId);
        if (!cancelled && match) {
          setSiteName(match.name);
          setDisplayName(match.name);
          setSharing(match.sharing);
        }
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

  function buildEditInput(preview: boolean): SiteEditInput | null {
    const trimmedName = displayName.trim();
    const owners = parseOwnerUpns(ownersInput);
    if (!trimmedName && !sharing && !lockState && owners.length === 0) {
      return null;
    }
    return {
      ...(trimmedName ? { displayName: trimmedName } : {}),
      ...(sharing ? { sharing } : {}),
      ...(lockState ? { lockState } : {}),
      ...(owners.length > 0 ? { owners } : {}),
      preview,
    };
  }

  async function handlePreview(): Promise<void> {
    const input = buildEditInput(true);
    if (!input || saving) {
      setSaveError("Enter at least one property change to preview.");
      return;
    }
    setSaving(true);
    setSaveError(null);
    setSavedMessage(null);
    try {
      const outcome = await editSite(tenantId, siteId, input);
      if ("dryRun" in outcome && outcome.dryRun) {
        setPlan(outcome);
      }
    } catch (err) {
      setSaveError(errorText(err));
    } finally {
      setSaving(false);
    }
  }

  async function handleSave(event: React.FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    const input = buildEditInput(false);
    if (!input || saving) {
      setSaveError("Enter at least one property change to save.");
      return;
    }
    setSaving(true);
    setSaveError(null);
    setSavedMessage(null);
    try {
      const outcome = await editSite(tenantId, siteId, input);
      setPlan(null);
      if ("targetName" in outcome && outcome.targetName) {
        setSiteName(outcome.targetName);
      } else if (input.displayName) {
        setSiteName(input.displayName);
      }
      setOwnersInput("");
      setSavedMessage("Site properties updated.");
    } catch (err) {
      setSaveError(errorText(err));
    } finally {
      setSaving(false);
    }
  }

  const hasChanges =
    displayName.trim().length > 0 ||
    sharing !== "" ||
    lockState !== "" ||
    parseOwnerUpns(ownersInput).length > 0;

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
              Edit core site properties below, or open the SharePoint admin center for advanced settings
              (site collection upgrade, term store, tenant-level sharing).
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

          <form style={panelStyle} onSubmit={(e) => void handleSave(e)} data-testid="site-edit-form">
            <h2 style={{ margin: 0, fontSize: "18px", fontWeight: 600 }}>Site properties</h2>

            {saveError && (
              <div
                style={{
                  padding: "10px 12px",
                  borderRadius: "6px",
                  background: "var(--danger-soft)",
                  border: "1px solid var(--danger)",
                  color: "var(--danger-text)",
                  fontSize: "13px",
                }}
                role="alert"
                data-testid="site-edit-save-error"
              >
                {saveError}
              </div>
            )}

            {savedMessage && (
              <div
                style={{
                  padding: "10px 12px",
                  borderRadius: "6px",
                  background: "var(--success-soft)",
                  border: "1px solid var(--success)",
                  color: "var(--success-text)",
                  fontSize: "13px",
                }}
                role="status"
                data-testid="site-edit-saved"
              >
                {savedMessage}
              </div>
            )}

            <div style={fieldStyle}>
              <label style={labelStyle} htmlFor="site-edit-display-name">
                Display name
              </label>
              <input
                id="site-edit-display-name"
                type="text"
                value={displayName}
                onChange={(e) => setDisplayName(e.target.value)}
                style={inputStyle}
                data-testid="site-edit-display-name"
              />
            </div>

            <div style={fieldStyle}>
              <label style={labelStyle} htmlFor="site-edit-sharing">
                External sharing
              </label>
              <select
                id="site-edit-sharing"
                value={sharing}
                onChange={(e) => setSharing(e.target.value as SharePointSharing | "")}
                style={inputStyle}
                data-testid="site-edit-sharing"
              >
                <option value="">Keep current</option>
                {SHARING_OPTIONS.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </select>
            </div>

            <div style={fieldStyle}>
              <label style={labelStyle} htmlFor="site-edit-lock-state">
                Lock state
              </label>
              <select
                id="site-edit-lock-state"
                value={lockState}
                onChange={(e) => setLockState(e.target.value as SharePointLockState | "")}
                style={inputStyle}
                data-testid="site-edit-lock-state"
              >
                <option value="">Keep current</option>
                {LOCK_STATE_OPTIONS.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </select>
            </div>

            <div style={fieldStyle}>
              <label style={labelStyle} htmlFor="site-edit-owners">
                Add owners (optional, comma or line separated UPNs)
              </label>
              <textarea
                id="site-edit-owners"
                rows={2}
                value={ownersInput}
                onChange={(e) => setOwnersInput(e.target.value)}
                style={{ ...inputStyle, resize: "vertical", fontFamily: "var(--font-mono, monospace)" }}
                placeholder="owner2@example.invalid"
                data-testid="site-edit-owners"
              />
            </div>

            {plan && (
              <div
                style={{
                  padding: "12px",
                  borderRadius: "6px",
                  background: "var(--surface)",
                  border: "1px solid var(--border)",
                  fontSize: "13px",
                }}
                data-testid="site-edit-plan"
              >
                <div style={{ fontWeight: 600, marginBottom: "6px" }}>
                  Planned changes for {plan.targetName}
                </div>
                <ul style={{ margin: 0, paddingLeft: "20px" }}>
                  {plan.diff.map((entry) => (
                    <li key={entry}>{entry}</li>
                  ))}
                </ul>
              </div>
            )}

            <div style={{ display: "flex", gap: "10px", flexWrap: "wrap" }}>
              <button
                type="button"
                style={buttonStyle}
                disabled={saving || !hasChanges}
                onClick={() => void handlePreview()}
                data-testid="site-edit-preview"
              >
                {saving ? "Working…" : "Preview changes"}
              </button>
              <button
                type="submit"
                style={primaryButtonStyle}
                disabled={saving || !hasChanges}
                data-testid="site-edit-save"
              >
                {saving ? "Saving…" : "Save changes"}
              </button>
            </div>
          </form>

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
