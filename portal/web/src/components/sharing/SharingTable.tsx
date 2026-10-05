"use client";

// Sharing Report table (EPIC-027 SPEC.md §2 US-1, §3.1; T-0522).
// Renders the §3.1 columns — Site/OneDrive, Item, Link type
// (anonymous/organization/people), Permissions (view/edit), Created by, Created,
// Expires — with row selection and the §3.1 row actions (View item, Remove link,
// Open in SharePoint) plus the gated bulk action (Remove selected links).
// Removal actions hand off to the bulk-removal surface (T-0527/T-0528) through
// callbacks; this component performs no removal and issues no writes. The page
// owns the reads and the §3.1 filters and pushes them to the T-0521 API.

import React, { type CSSProperties, type ReactElement } from "react";

export type SharingLinkType = "anonymous" | "organization" | "people";
export type SharingLinkPermissions = "view" | "edit";

export interface SharingReportItem {
  readonly siteId: string;
  readonly siteName: string;
  readonly siteUrl: string;
  readonly itemId: string;
  readonly itemName: string;
  readonly itemUrl: string;
  readonly driveId: string;
  readonly linkId: string;
  readonly linkType: SharingLinkType | "";
  readonly permissions: SharingLinkPermissions | "";
  readonly createdBy: string;
  readonly created: string | null;
  readonly expires: string | null;
}

export interface SharingTableProps {
  readonly items?: readonly SharingReportItem[];
  readonly loading?: boolean;
  readonly error?: string | null;
  readonly selectedLinkIds?: readonly string[];
  readonly canRemove?: boolean;
  readonly emptyMessage?: string;
  readonly onToggleSelect?: (item: SharingReportItem) => void;
  readonly onToggleSelectAll?: (items: readonly SharingReportItem[]) => void;
  readonly onViewItem?: (item: SharingReportItem) => void;
  readonly onRemoveLink?: (item: SharingReportItem) => void;
  readonly onOpenInSharePoint?: (item: SharingReportItem) => void;
  readonly onRemoveSelected?: (items: readonly SharingReportItem[]) => void;
}

const LINK_TYPE_LABELS: Record<SharingLinkType | "", string> = {
  anonymous: "Anonymous",
  organization: "Organization",
  people: "People",
  "": "—",
};

const PERMISSION_LABELS: Record<SharingLinkPermissions | "", string> = {
  view: "View",
  edit: "Edit",
  "": "—",
};

const containerStyle: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: "16px",
  width: "100%",
  fontFamily: "var(--font-sans, system-ui, sans-serif)",
  color: "var(--text)",
};

const bulkBarStyle: CSSProperties = {
  display: "flex",
  flexWrap: "wrap",
  gap: "12px",
  alignItems: "center",
  justifyContent: "space-between",
  padding: "12px 16px",
  background: "var(--bg-elev)",
  border: "1px solid var(--border)",
  borderRadius: "var(--radius, 10px)",
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
  fontSize: "12px",
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

const dangerBtnStyle: CSSProperties = {
  ...actionBtnStyle,
  background: "var(--danger-soft)",
  borderColor: "var(--danger)",
  color: "var(--danger-text)",
};

const disabledStyle: CSSProperties = {
  opacity: 0.45,
  cursor: "not-allowed",
};

function badgeStyle(kind: "warn" | "muted" | "bad"): CSSProperties {
  const tones = {
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

function linkTypeBadge(linkType: SharingLinkType | ""): ReactElement {
  const label = LINK_TYPE_LABELS[linkType];
  if (linkType === "anonymous") return <span style={badgeStyle("bad")}>{label}</span>;
  if (linkType === "organization") return <span style={badgeStyle("warn")}>{label}</span>;
  return <span style={badgeStyle("muted")}>{label}</span>;
}

function formatValue(value: string | null): string {
  return value && value.trim().length > 0 ? value : "—";
}

export function SharingTable({
  items = [],
  loading = false,
  error = null,
  selectedLinkIds = [],
  canRemove = true,
  emptyMessage = "No sharing links found.",
  onToggleSelect,
  onToggleSelectAll,
  onViewItem,
  onRemoveLink,
  onOpenInSharePoint,
  onRemoveSelected,
}: SharingTableProps): ReactElement {
  const selected = new Set(selectedLinkIds);
  const selectedItems = items.filter((item) => selected.has(item.linkId));
  const allSelected = items.length > 0 && selectedItems.length === items.length;
  const bulkDisabled = selectedItems.length === 0 || !canRemove;

  return (
    <div style={containerStyle} data-testid="sharing-table-container">
      <div style={bulkBarStyle}>
        <span style={{ fontSize: "13px", color: "var(--text-soft)" }} data-testid="sharing-selection-count">
          {selectedItems.length} selected
        </span>
        <button
          type="button"
          style={{ ...dangerBtnStyle, ...(bulkDisabled ? disabledStyle : {}) }}
          disabled={bulkDisabled}
          title={
            canRemove
              ? "Removes the selected links through the bulk-removal dialog (T-0528), which confirms the count before any apply."
              : "Removing links requires Sharing.Permissions.ReadWrite and Remediation.Apply (T-0527/T-0528)."
          }
          onClick={() => onRemoveSelected?.(selectedItems)}
          data-testid="sharing-remove-selected"
        >
          Remove selected links{selectedItems.length > 0 ? ` (${selectedItems.length})` : ""}
        </button>
      </div>

      {loading && (
        <div style={{ padding: "32px", textAlign: "center", color: "var(--text-soft)" }} data-testid="sharing-loading">
          Loading sharing links...
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
          data-testid="sharing-error"
        >
          {error}
        </div>
      )}

      {!loading && !error && items.length === 0 && (
        <div
          style={{
            padding: "48px 16px",
            textAlign: "center",
            background: "var(--bg-elev)",
            borderRadius: "var(--radius, 10px)",
            border: "1px solid var(--border)",
            color: "var(--text-soft)",
          }}
          data-testid="sharing-empty"
        >
          {emptyMessage}
        </div>
      )}

      {!loading && !error && items.length > 0 && (
        <div style={tableWrapperStyle}>
          <table style={tableStyle} aria-label="Sharing report">
            <thead>
              <tr>
                <th style={thStyle}>
                  <input
                    type="checkbox"
                    checked={allSelected}
                    aria-label="Select all sharing links"
                    data-testid="sharing-select-all"
                    onChange={() => onToggleSelectAll?.(allSelected ? [] : items)}
                  />
                </th>
                <th style={thStyle}>Site/OneDrive</th>
                <th style={thStyle}>Item</th>
                <th style={thStyle}>Link type</th>
                <th style={thStyle}>Permissions</th>
                <th style={thStyle}>Created by</th>
                <th style={thStyle}>Created</th>
                <th style={thStyle}>Expires</th>
                <th style={{ ...thStyle, textAlign: "right" }}>Actions</th>
              </tr>
            </thead>
            <tbody>
              {items.map((item) => {
                const isSelected = selected.has(item.linkId);
                return (
                  <tr key={item.linkId} data-testid={`sharing-row-${item.linkId}`}>
                    <td style={tdStyle}>
                      <input
                        type="checkbox"
                        checked={isSelected}
                        aria-label={`Select ${item.itemName || item.linkId}`}
                        data-testid={`sharing-select-${item.linkId}`}
                        onChange={() => onToggleSelect?.(item)}
                      />
                    </td>
                    <td style={tdStyle}>
                      <div style={{ display: "flex", flexDirection: "column", gap: "2px" }}>
                        <span>{item.siteName || "—"}</span>
                        <span style={monoStyle}>{item.siteUrl || "—"}</span>
                      </div>
                    </td>
                    <td style={tdStyle}>
                      <div style={{ display: "flex", flexDirection: "column", gap: "2px" }}>
                        <span>{item.itemName || "—"}</span>
                        <span style={monoStyle}>{item.itemUrl || "—"}</span>
                      </div>
                    </td>
                    <td style={tdStyle}>{linkTypeBadge(item.linkType)}</td>
                    <td style={tdStyle}>{PERMISSION_LABELS[item.permissions]}</td>
                    <td style={tdStyle}>{formatValue(item.createdBy)}</td>
                    <td style={tdStyle}>{formatValue(item.created)}</td>
                    <td style={tdStyle}>{formatValue(item.expires)}</td>
                    <td style={{ ...tdStyle, textAlign: "right" }}>
                      <div style={{ display: "flex", gap: "6px", justifyContent: "flex-end", flexWrap: "wrap" }}>
                        <button
                          type="button"
                          style={actionBtnStyle}
                          onClick={() => onViewItem?.(item)}
                          data-testid={`sharing-view-${item.linkId}`}
                        >
                          View item
                        </button>
                        <button
                          type="button"
                          style={{ ...dangerBtnStyle, ...(canRemove ? {} : disabledStyle) }}
                          disabled={!canRemove}
                          title={
                            canRemove
                              ? "Opens the bulk-removal dialog; the removal is confirmed there (T-0528)."
                              : "Removing links requires Sharing.Permissions.ReadWrite and Remediation.Apply (T-0527/T-0528)."
                          }
                          onClick={() => onRemoveLink?.(item)}
                          data-testid={`sharing-remove-${item.linkId}`}
                        >
                          Remove link
                        </button>
                        <button
                          type="button"
                          style={actionBtnStyle}
                          onClick={() => onOpenInSharePoint?.(item)}
                          data-testid={`sharing-open-${item.linkId}`}
                        >
                          Open in SharePoint
                        </button>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
