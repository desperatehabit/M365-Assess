"use client";

// OneDrive page (EPIC-025 SPEC.md §2 US-6, §3.5; T-0489).
// Page title "OneDrive": per-user usage and sharing state read live from
// Graph via GET /v1/tenants/{id}/onedrive, rendered by OneDriveTable. Bulk
// sharing-link removal is handed to EPIC-027 through RemoveLinksDialog; no
// removal is performed on this page. Strictly uses report theme tokens with
// zero colour literals.

import React, { useCallback, useEffect, useState, type CSSProperties, type ReactElement } from "react";
import { OneDriveTable, type OneDriveUserUsage } from "../../components/sharepoint/OneDriveTable";
import { RemoveLinksDialog } from "../../components/sharing/RemoveLinksDialog";
import type { SharingLinkRef } from "../../components/sharing/RemovalPlanPreview";
import { useCurrentTenantId } from "../../lib/useCurrentTenant";

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

async function fetchOneDriveUsage(
  tenantId: string,
  fetcher: Fetcher,
): Promise<OneDriveUserUsage[]> {
  const response = await fetcher(`/v1/tenants/${encodeURIComponent(tenantId)}/onedrive?limit=100`, {
    method: "GET",
    headers: { Accept: "application/json" },
  });
  if (!response.ok) {
    let detail = response.statusText;
    try {
      const body = (await response.json()) as { message?: string };
      if (body?.message) detail = body.message;
    } catch {
      // non-JSON error body; keep the status text
    }
    throw new Error(`Failed to load OneDrive usage (${response.status}): ${detail}`);
  }
  const payload = (await response.json()) as { items?: OneDriveUserUsage[] };
  return payload.items ?? [];
}

function toSharingLinkRefs(users: readonly OneDriveUserUsage[]): SharingLinkRef[] {
  return users.flatMap((user) =>
    user.sharingLinks.map((link) => ({
      linkId: link.linkId,
      itemId: link.itemId,
      driveId: link.driveId,
      linkType: link.linkType,
      resourceName: link.resourceName,
    })),
  );
}

export default function OneDrivePage(): ReactElement {
  const [tenantId, setTenantId] = useState("");
  // Follow the tenant chosen in the shell; the box still accepts another id.
  const currentTenant = useCurrentTenantId();
  useEffect(() => {
    if (currentTenant) {
      setTenantId(currentTenant);
      void loadUsage(currentTenant);
    }
  }, [currentTenant]);
  const [users, setUsers] = useState<OneDriveUserUsage[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [removalUsers, setRemovalUsers] = useState<OneDriveUserUsage[]>([]);

  const loadUsage = useCallback(async (tenant: string): Promise<void> => {
    if (!tenant.trim()) {
      setError("Enter a tenant id to list OneDrive usage.");
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const items = await fetchOneDriveUsage(tenant.trim(), fetch);
      setUsers(items);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  function openRemoval(usersToRemove: readonly OneDriveUserUsage[]): void {
    setRemovalUsers([...usersToRemove]);
  }

  return (
    <div style={pageStyle} data-testid="onedrive-page">
      <div style={headerStyle}>
        <div>
          <h1 style={titleStyle}>OneDrive</h1>
          <p style={subtitleStyle}>
            Per-user OneDrive usage and sharing state, read live from Graph. Bulk sharing-link removal is
            handed to EPIC-027.
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
            data-testid="onedrive-tenant-input"
          />
          <button
            type="button"
            style={buttonStyle}
            onClick={() => void loadUsage(tenantId)}
            data-testid="onedrive-load-button"
          >
            Load
          </button>
        </div>
      </div>

      <div style={handoffBannerStyle} data-testid="onedrive-handoff-banner">
        Sharing links are reported per user. Use <strong>Remove links</strong> on a row or select users for
        bulk <strong>Remove sharing links</strong> — both hand the exact link set to the EPIC-027 removal
        flow (plan preview, typed-count confirmation, per-link audit). No removal happens on this page.
      </div>

      <OneDriveTable
        users={users}
        loading={loading}
        error={error}
        onRemoveLinks={(user) => openRemoval([user])}
        onBulkRemoveLinks={(selected) => openRemoval(selected)}
      />

      <RemoveLinksDialog
        isOpen={removalUsers.length > 0}
        onClose={() => setRemovalUsers([])}
        tenantId={tenantId.trim()}
        links={toSharingLinkRefs(removalUsers)}
      />
    </div>
  );
}
