"use client";

// SharePoint sites table (EPIC-025 SPEC.md §2 US-1/US-3, §3.1; T-0483).
// Renders the §3.1 site list — Name/URL, Type (team/communication), Owners,
// Storage used, Last activity, Sensitivity, External sharing — with the §3.1
// filters (type, sharing, storage %, last activity, sensitivity), an
// active/deleted view, and the §3.1 row actions. Actions hand to the site
// browser (T-0488) and the lifecycle UI (T-0485/T-0486) through callbacks;
// no write logic is duplicated here. Strictly uses report theme tokens with
// zero colour literals.

import React, { useMemo, useState, type CSSProperties, type ReactElement } from "react";

export type SharePointSiteType = "team" | "communication";

export type SharePointSharing =
  | "disabled"
  | "externalUserSharingOnly"
  | "externalUserAndGuestSharing"
  | "existingExternalUserSharingOnly";

export interface SharePointSite {
  readonly id: string;
  readonly name: string;
  readonly url: string;
  readonly type: SharePointSiteType;
  readonly owners: readonly string[];
  readonly storageUsedMB: number | null;
  readonly storageAllocatedMB: number | null;
  readonly storageUsedPercent: number | null;
  readonly lastActivity: string | null;
  readonly sensitivity: string;
  readonly sharing: SharePointSharing | "";
}

export type SitesView = "active" | "deleted";

export interface SitesTableProps {
  readonly sites?: readonly SharePointSite[];
  readonly loading?: boolean;
  readonly error?: string | null;
  readonly view?: SitesView;
  readonly onViewSite?: (site: SharePointSite) => void;
  readonly onBrowse?: (site: SharePointSite) => void;
  readonly onEdit?: (site: SharePointSite) => void;
  readonly onPermissions?: (site: SharePointSite) => void;
  readonly onExternalUsers?: (site: SharePointSite) => void;
  readonly onDelete?: (site: SharePointSite) => void;
  readonly onRestore?: (site: SharePointSite) => void;
  readonly onRecycleBin?: (site: SharePointSite) => void;
  readonly onEmptyRecycleBin?: () => void;
}

const SHARING_LABELS: Record<SharePointSharing | "", string> = {
  disabled: "Disabled",
  externalUserSharingOnly: "External users only",
  externalUserAndGuestSharing: "External users and guests",
  existingExternalUserSharingOnly: "Existing external users only",
  "": "Not set",
};

const STORAGE_THRESHOLDS = [50, 80, 90] as const;

const containerStyle: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: "16px",
  width: "100%",
  fontFamily: "var(--font-sans, system-ui, sans-serif)",
  color: "var(--text)",
};

const headerBarStyle: CSSProperties = {
  display: "flex",
  flexWrap: "wrap",
  gap: "12px",
  alignItems: "center",
  justifyContent: "space-between",
  padding: "16px",
  background: "var(--bg-elev)",
  border: "1px solid var(--border)",
  borderRadius: "var(--radius, 10px)",
};

const filterRowStyle: CSSProperties = {
  display: "flex",
  flexWrap: "wrap",
  gap: "10px",
  alignItems: "center",
};

const inputStyle: CSSProperties = {
  padding: "8px 12px",
  background: "var(--input-bg, var(--bg))",
  border: "1px solid var(--border)",
  borderRadius: "6px",
  color: "var(--text)",
  fontSize: "14px",
};

const selectStyle: CSSProperties = {
  ...inputStyle,
  cursor: "pointer",
};

const tableWrapperStyle: CSSProperties = {
  overflowX: "auto",
  background: "var(--bg-elev)",
  border: "1px solid var(--border)",
  borderRadius: "var(--radius, 10px)",
  boxShadow: "var(--shadow-card)",
};

const tableStyle: CSSProperties = {
  width: "100%",
  borderCollapse: "collapse",
  fontSize: "14px",
  textAlign: "left",
};

const thStyle: CSSProperties = {
  padding: "12px 16px",
  borderBottom: "1px solid var(--border)",
  background: "var(--surface)",
  color: "var(--text-soft)",
  fontWeight: 600,
  fontSize: "12px",
  textTransform: "uppercase",
  letterSpacing: "0.05em",
  whiteSpace: "nowrap",
};

const tdStyle: CSSProperties = {
  padding: "12px 16px",
  borderBottom: "1px solid var(--border)",
  color: "var(--text)",
  verticalAlign: "middle",
};

const monoStyle: CSSProperties = {
  fontFamily: "var(--font-mono, monospace)",
  fontSize: "13px",
  color: "var(--text-soft)",
};

const actionBtnStyle: CSSProperties = {
  padding: "4px 8px",
  background: "var(--surface)",
  border: "1px solid var(--border)",
  borderRadius: "4px",
  color: "var(--text)",
  fontSize: "12px",
  cursor: "pointer",
  whiteSpace: "nowrap",
};

const disabledActionStyle: CSSProperties = {
  opacity: 0.45,
  cursor: "not-allowed",
};

function badgeStyle(kind: "ok" | "warn" | "muted" | "bad"): CSSProperties {
  const tones = {
    ok: { bg: "var(--success-soft)", text: "var(--success-text)", border: "var(--success)" },
    warn: { bg: "var(--warning-soft)", text: "var(--warning-text)", border: "var(--warning)" },
    muted: { bg: "var(--surface)", text: "var(--text-soft)", border: "var(--border)" },
    bad: { bg: "var(--danger-soft)", text: "var(--danger-text)", border: "var(--danger)" },
  }[kind];
  return {
    display: "inline-flex",
    alignItems: "center",
    padding: "2px 8px",
    borderRadius: "999px",
    fontSize: "12px",
    fontWeight: 600,
    background: tones.bg,
    color: tones.text,
    border: `1px solid ${tones.border}`,
  };
}

function sharingBadge(site: SharePointSite): ReactElement {
  const label = SHARING_LABELS[site.sharing];
  if (site.sharing === "disabled" || site.sharing === "") return <span style={badgeStyle("muted")}>{label}</span>;
  if (site.sharing === "externalUserAndGuestSharing") return <span style={badgeStyle("bad")}>{label}</span>;
  return <span style={badgeStyle("warn")}>{label}</span>;
}

export function formatMB(mb: number): string {
  if (mb >= 1024) {
    const gb = mb / 1024;
    return `${Number.isInteger(gb) ? gb : gb.toFixed(1)} GB`;
  }
  return `${mb} MB`;
}

export function formatLastActivity(value: string | null): string {
  if (!value) return "—";
  try {
    const date = new Date(value);
    if (isNaN(date.getTime())) return value;
    return date.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
  } catch {
    return value;
  }
}

function storageText(site: SharePointSite): string {
  if (site.storageUsedMB === null) return "—";
  const used = formatMB(site.storageUsedMB);
  if (site.storageAllocatedMB === null) return used;
  const percent = site.storageUsedPercent === null ? "" : ` (${site.storageUsedPercent}%)`;
  return `${used} of ${formatMB(site.storageAllocatedMB)}${percent}`;
}

interface ActionButtonProps {
  readonly label: string;
  readonly testid: string;
  readonly site: SharePointSite;
  readonly onClick?: (site: SharePointSite) => void;
  readonly unwiredTitle: string;
}

function ActionButton({ label, testid, site, onClick, unwiredTitle }: ActionButtonProps): ReactElement {
  const disabled = !onClick;
  return (
    <button
      type="button"
      style={{ ...actionBtnStyle, ...(disabled ? disabledActionStyle : {}) }}
      disabled={disabled}
      title={disabled ? unwiredTitle : undefined}
      aria-label={`${label} ${site.name}`}
      data-testid={`${testid}-${site.id}`}
      onClick={() => onClick?.(site)}
    >
      {label}
    </button>
  );
}

export function SitesTable({
  sites = [],
  loading = false,
  error = null,
  view = "active",
  onViewSite,
  onBrowse,
  onEdit,
  onPermissions,
  onExternalUsers,
  onDelete,
  onRestore,
  onRecycleBin,
  onEmptyRecycleBin,
}: SitesTableProps): ReactElement {
  const [typeFilter, setTypeFilter] = useState<"all" | SharePointSiteType>("all");
  const [sharingFilter, setSharingFilter] = useState<"all" | SharePointSharing>("all");
  const [storageFilter, setStorageFilter] = useState<"all" | (typeof STORAGE_THRESHOLDS)[number]>("all");
  const [lastActivityFilter, setLastActivityFilter] = useState("");
  const [sensitivityFilter, setSensitivityFilter] = useState("");

  const filteredSites = useMemo(() => {
    const sensitivityQuery = sensitivityFilter.trim().toLowerCase();
    return sites.filter((site) => {
      if (typeFilter !== "all" && site.type !== typeFilter) return false;
      if (sharingFilter !== "all" && site.sharing !== sharingFilter) return false;
      if (storageFilter !== "all" && (site.storageUsedPercent === null || site.storageUsedPercent < storageFilter)) {
        return false;
      }
      if (lastActivityFilter && (site.lastActivity === null || site.lastActivity < lastActivityFilter)) return false;
      if (sensitivityQuery && !site.sensitivity.toLowerCase().includes(sensitivityQuery)) return false;
      return true;
    });
  }, [sites, typeFilter, sharingFilter, storageFilter, lastActivityFilter, sensitivityFilter]);

  const deleted = view === "deleted";

  return (
    <div style={containerStyle} data-testid="sites-table-container">
      <div style={headerBarStyle}>
        <div style={{ display: "flex", alignItems: "center", gap: "12px" }}>
          <h2 style={{ margin: 0, fontSize: "20px", fontWeight: 600 }}>SharePoint Sites</h2>
          <span
            style={{
              padding: "2px 8px",
              background: "var(--surface)",
              border: "1px solid var(--border)",
              borderRadius: "999px",
              fontSize: "12px",
              color: "var(--text-soft)",
            }}
          >
            {filteredSites.length} {filteredSites.length === 1 ? "site" : "sites"}
          </span>
          <span
            style={{
              padding: "2px 8px",
              background: deleted ? "var(--warning-soft)" : "var(--surface)",
              border: `1px solid ${deleted ? "var(--warning)" : "var(--border)"}`,
              borderRadius: "999px",
              fontSize: "12px",
              color: deleted ? "var(--warning-text)" : "var(--text-soft)",
            }}
          >
            {deleted ? "Deleted" : "Active"}
          </span>
        </div>
      </div>

      <div style={{ ...headerBarStyle, padding: "12px 16px" }}>
        <div style={filterRowStyle}>
          <select
            aria-label="Filter by site type"
            data-testid="filter-type"
            value={typeFilter}
            onChange={(e) => setTypeFilter(e.target.value as "all" | SharePointSiteType)}
            style={selectStyle}
          >
            <option value="all">All types</option>
            <option value="team">Team</option>
            <option value="communication">Communication</option>
          </select>
          <select
            aria-label="Filter by external sharing"
            data-testid="filter-sharing"
            value={sharingFilter}
            onChange={(e) => setSharingFilter(e.target.value as "all" | SharePointSharing)}
            style={selectStyle}
          >
            <option value="all">All sharing</option>
            <option value="disabled">Disabled</option>
            <option value="externalUserSharingOnly">External users only</option>
            <option value="externalUserAndGuestSharing">External users and guests</option>
            <option value="existingExternalUserSharingOnly">Existing external users only</option>
          </select>
          <select
            aria-label="Filter by storage used percent"
            data-testid="filter-storage"
            value={storageFilter}
            onChange={(e) =>
              setStorageFilter(e.target.value === "all" ? "all" : (Number(e.target.value) as (typeof STORAGE_THRESHOLDS)[number]))
            }
            style={selectStyle}
          >
            <option value="all">Any storage</option>
            {STORAGE_THRESHOLDS.map((threshold) => (
              <option key={threshold} value={String(threshold)}>
                ≥ {threshold}%
              </option>
            ))}
          </select>
          <label style={{ display: "inline-flex", alignItems: "center", gap: "6px", fontSize: "13px" }}>
            Active since
            <input
              type="date"
              value={lastActivityFilter}
              onChange={(e) => setLastActivityFilter(e.target.value)}
              style={inputStyle}
              aria-label="Filter by last activity date"
              data-testid="filter-last-activity"
            />
          </label>
          <input
            type="text"
            placeholder="Sensitivity label..."
            value={sensitivityFilter}
            onChange={(e) => setSensitivityFilter(e.target.value)}
            style={inputStyle}
            aria-label="Filter by sensitivity label"
            data-testid="filter-sensitivity"
          />
        </div>
      </div>

      {deleted && (
        <div style={{ ...headerBarStyle, padding: "12px 16px" }} data-testid="recycle-bin-bar">
          <span style={{ fontSize: "14px", color: "var(--text-soft)" }}>
            Deleted sites are restorable from the recycle bin. Emptying is irreversible.
          </span>
          <button
            type="button"
            style={{ ...actionBtnStyle, ...(onEmptyRecycleBin ? {} : disabledActionStyle) }}
            disabled={!onEmptyRecycleBin}
            title={onEmptyRecycleBin ? "Empty the recycle bin" : "Empty recycle bin is delivered with the site lifecycle UI (T-0486)"}
            onClick={() => onEmptyRecycleBin?.()}
            data-testid="empty-recycle-bin"
          >
            Empty recycle bin
          </button>
        </div>
      )}

      {loading && (
        <div style={{ padding: "32px", textAlign: "center", color: "var(--text-soft)" }} data-testid="sites-loading">
          Loading SharePoint sites...
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
          data-testid="sites-error"
        >
          {error}
        </div>
      )}

      {!loading && !error && filteredSites.length === 0 && (
        <div
          style={{
            padding: "48px 16px",
            textAlign: "center",
            background: "var(--bg-elev)",
            borderRadius: "var(--radius, 10px)",
            border: "1px solid var(--border)",
            color: "var(--text-soft)",
          }}
          data-testid="sites-empty"
        >
          {deleted ? "No deleted sites found." : "No sites found."}
        </div>
      )}

      {!loading && !error && filteredSites.length > 0 && (
        <div style={tableWrapperStyle}>
          <table style={tableStyle} aria-label="Tenant SharePoint sites">
            <thead>
              <tr>
                <th style={thStyle}>Name/URL</th>
                <th style={thStyle}>Type</th>
                <th style={thStyle}>Owners</th>
                <th style={thStyle}>Storage used</th>
                <th style={thStyle}>Last activity</th>
                <th style={thStyle}>Sensitivity</th>
                <th style={thStyle}>External sharing</th>
                <th style={{ ...thStyle, textAlign: "right" }}>Actions</th>
              </tr>
            </thead>
            <tbody>
              {filteredSites.map((site) => (
                <tr key={site.id} data-testid={`site-row-${site.id}`}>
                  <td style={tdStyle}>
                    <div style={{ display: "flex", flexDirection: "column", gap: "2px" }}>
                      <span>{site.name}</span>
                      <span style={monoStyle}>{site.url}</span>
                    </div>
                  </td>
                  <td style={tdStyle}>
                    <span style={badgeStyle("muted")}>{site.type === "team" ? "Team" : "Communication"}</span>
                  </td>
                  <td style={tdStyle}>{site.owners.length > 0 ? site.owners.join(", ") : "—"}</td>
                  <td style={tdStyle}>{storageText(site)}</td>
                  <td style={tdStyle}>{formatLastActivity(site.lastActivity)}</td>
                  <td style={tdStyle}>{site.sensitivity || "—"}</td>
                  <td style={tdStyle}>{sharingBadge(site)}</td>
                  <td style={{ ...tdStyle, textAlign: "right" }}>
                    <div style={{ display: "flex", gap: "6px", justifyContent: "flex-end", flexWrap: "wrap" }}>
                      <ActionButton
                        label="View"
                        testid="action-view"
                        site={site}
                        onClick={onViewSite}
                        unwiredTitle="View is delivered with the site browser (T-0488)"
                      />
                      <ActionButton
                        label="Browse"
                        testid="action-browse"
                        site={site}
                        onClick={onBrowse}
                        unwiredTitle="Browse is delivered with the site browser (T-0488)"
                      />
                      <ActionButton
                        label="Edit"
                        testid="action-edit"
                        site={site}
                        onClick={onEdit}
                        unwiredTitle="Edit is delivered with the site lifecycle UI (T-0486)"
                      />
                      <ActionButton
                        label="Permissions"
                        testid="action-permissions"
                        site={site}
                        onClick={onPermissions}
                        unwiredTitle="Permissions is delivered with the site browser (T-0488)"
                      />
                      <ActionButton
                        label="External users"
                        testid="action-external-users"
                        site={site}
                        onClick={onExternalUsers}
                        unwiredTitle="External users is delivered with the site browser (T-0488)"
                      />
                      {deleted ? (
                        <ActionButton
                          label="Restore"
                          testid="action-restore"
                          site={site}
                          onClick={onRestore}
                          unwiredTitle="Restore is delivered with the site lifecycle UI (T-0486)"
                        />
                      ) : (
                        <>
                          <ActionButton
                            label="Delete"
                            testid="action-delete"
                            site={site}
                            onClick={onDelete}
                            unwiredTitle="Delete is delivered with the site lifecycle UI (T-0486)"
                          />
                          <ActionButton
                            label="Recycle bin"
                            testid="action-recycle-bin"
                            site={site}
                            onClick={onRecycleBin}
                            unwiredTitle="Recycle bin is delivered with the site lifecycle UI (T-0486)"
                          />
                        </>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
