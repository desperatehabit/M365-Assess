"use client";

// Delete-site confirmation dialog (EPIC-025 SPEC.md §2 US-3, §4.1, §8, §9;
// T-0486). Deleting a site is destructive and routes through the T-0485 API,
// which requires an explicit `{ "confirm": true }`. This dialog names the site
// being deleted and gates the confirm button behind a checkbox, so a delete can
// never fire without an operator explicitly confirming the named site. Strictly
// uses report theme tokens with zero colour literals.

import { useState, type CSSProperties, type ReactElement } from "react";

export interface SiteDeleteTarget {
  readonly id: string;
  readonly name: string;
  readonly url?: string;
}

export interface SharePointSiteAuditEvent {
  readonly id: string;
  readonly tenantId: string;
  readonly action: string;
  readonly targetId: string;
  readonly targetName: string;
  readonly timestamp: string;
}

export interface SharePointSiteOperationResult {
  readonly success: boolean;
  readonly state: "succeeded" | "failed";
  readonly operation: string;
  readonly siteId: string;
  readonly targetName: string;
  readonly error: string | null;
  readonly auditEvent?: SharePointSiteAuditEvent;
}

export interface SiteDeleteDialogProps {
  readonly isOpen: boolean;
  readonly tenantId: string;
  readonly site: SiteDeleteTarget | null;
  readonly onClose: () => void;
  readonly onDeleted?: (result: SharePointSiteOperationResult) => void;
  readonly fetcher?: typeof fetch;
}

export function deleteSiteUrl(tenantId: string, siteId: string): string {
  return `/v1/tenants/${encodeURIComponent(tenantId)}/sharepoint/sites/${encodeURIComponent(siteId)}`;
}

const overlayStyle: CSSProperties = {
  position: "fixed",
  inset: 0,
  background: "var(--overlay)",
  zIndex: 60,
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
};

const dialogStyle: CSSProperties = {
  background: "var(--bg-elev)",
  border: "1px solid var(--border)",
  borderRadius: "var(--radius, 10px)",
  padding: "24px",
  width: "min(560px, 92vw)",
  maxHeight: "90vh",
  overflowY: "auto",
  display: "flex",
  flexDirection: "column",
  gap: "16px",
  color: "var(--text)",
  fontFamily: "var(--font-sans, system-ui, sans-serif)",
};

const titleStyle: CSSProperties = {
  margin: 0,
  fontSize: "20px",
  fontWeight: 700,
};

const warningBannerStyle: CSSProperties = {
  padding: "12px 14px",
  borderRadius: "6px",
  background: "var(--danger-soft)",
  border: "1px solid var(--danger)",
  color: "var(--danger-text)",
  fontSize: "13px",
  lineHeight: 1.5,
};

const confirmRowStyle: CSSProperties = {
  display: "flex",
  alignItems: "flex-start",
  gap: "8px",
  fontSize: "13px",
  color: "var(--text)",
};

const buttonStyle: CSSProperties = {
  padding: "8px 16px",
  background: "var(--surface)",
  border: "1px solid var(--border)",
  borderRadius: "6px",
  color: "var(--text)",
  fontSize: "14px",
  fontWeight: 500,
  cursor: "pointer",
};

const dangerButtonStyle: CSSProperties = {
  ...buttonStyle,
  background: "var(--danger)",
  color: "var(--danger-text, var(--text))",
  borderColor: "var(--danger)",
};

const disabledStyle: CSSProperties = {
  opacity: 0.55,
  cursor: "not-allowed",
};

const monoStyle: CSSProperties = {
  fontFamily: "var(--font-mono, monospace)",
  fontSize: "12px",
  color: "var(--text-soft)",
};

async function deleteJson(fetcher: typeof fetch, url: string, body: unknown): Promise<unknown> {
  const response = await fetcher(url, {
    method: "DELETE",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    let detail = response.statusText;
    try {
      const payload = (await response.json()) as { message?: string };
      if (payload?.message) detail = payload.message;
    } catch {
      // non-JSON error body; keep the status text
    }
    throw new Error(`Site deletion failed: ${response.status} ${detail}`);
  }
  return response.json();
}

export function SiteDeleteDialog({
  isOpen,
  tenantId,
  site,
  onClose,
  onDeleted,
  fetcher,
}: SiteDeleteDialogProps): ReactElement | null {
  const [confirmed, setConfirmed] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<SharePointSiteOperationResult | null>(null);

  if (!isOpen || site === null) {
    return null;
  }

  const runFetch = fetcher ?? fetch;
  const canConfirm = confirmed && !deleting && result === null;

  async function handleConfirm(): Promise<void> {
    if (!canConfirm || site === null) return;
    setDeleting(true);
    setError(null);
    try {
      const body = (await deleteJson(runFetch, deleteSiteUrl(tenantId, site.id), {
        confirm: true,
      })) as SharePointSiteOperationResult;
      setResult(body);
      onDeleted?.(body);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setDeleting(false);
    }
  }

  return (
    <div
      style={overlayStyle}
      role="dialog"
      aria-modal="true"
      aria-label={`Delete site ${site.name}`}
      data-testid="site-delete-dialog"
    >
      <div style={dialogStyle}>
        <h2 style={titleStyle} data-testid="site-delete-title">
          Delete site: {site.name}
        </h2>

        <div style={warningBannerStyle} data-testid="site-delete-warning">
          <strong>{site.name}</strong>
          {site.url ? <span> ({site.url})</span> : null} will be deleted. Deleted sites are
          restorable from the recycle bin until the retention window expires. This action is
          audited.
        </div>

        {error && (
          <div
            style={{ ...warningBannerStyle, background: "var(--danger-soft)", color: "var(--danger-text)" }}
            role="alert"
            data-testid="site-delete-error"
          >
            {error}
          </div>
        )}

        {result === null ? (
          <>
            <label style={confirmRowStyle} htmlFor="site-delete-confirm">
              <input
                id="site-delete-confirm"
                type="checkbox"
                checked={confirmed}
                onChange={(e) => setConfirmed(e.target.checked)}
                data-testid="site-delete-confirm-checkbox"
              />
              <span>
                I understand this permanently removes <strong>{site.name}</strong> from the active
                sites view.
              </span>
            </label>

            <div style={{ display: "flex", gap: "10px", justifyContent: "flex-end" }}>
              <button type="button" style={buttonStyle} onClick={onClose} data-testid="site-delete-cancel">
                Cancel
              </button>
              <button
                type="button"
                style={{ ...dangerButtonStyle, ...(canConfirm ? {} : disabledStyle) }}
                disabled={!canConfirm}
                onClick={() => void handleConfirm()}
                data-testid="site-delete-confirm-button"
              >
                {deleting ? "Deleting…" : `Delete ${site.name}`}
              </button>
            </div>
          </>
        ) : (
          <div data-testid="site-delete-result">
            <div style={{ fontWeight: 600, fontSize: "15px" }}>
              {result.success ? "Site deleted" : "Site deletion failed"}
            </div>
            <div style={{ fontSize: "13px", color: "var(--text-soft)", marginTop: "4px" }}>
              {result.targetName}
              {result.error ? ` — ${result.error}` : ""}
            </div>
            <div style={{ ...monoStyle, marginTop: "4px" }}>{site.id}</div>
            <div style={{ display: "flex", justifyContent: "flex-end", marginTop: "12px" }}>
              <button type="button" style={buttonStyle} onClick={onClose} data-testid="site-delete-done">
                Done
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
