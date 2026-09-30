"use client";

// Configured Template Libraries table (EPIC-039 SPEC.md §3.1, T-0762). Row
// actions per §3.1: `View`, `Clone to tenant`, `Export`, `Delete`. Browsing is
// read-only (SPEC §8): View/Export are local render/download only, Clone is
// owned by the T-0765 drawer, and the destructive `Delete` is gated on
// `templates.write` (the BFF enforces the same permission through the T-0743
// testPortalAccess path). Zero colour literals: report theme tokens only.

import React, { type CSSProperties, type ReactElement } from "react";

export interface TemplateLibraryItem {
  readonly id: string;
  readonly type: string;
  readonly name: string;
  readonly body: string;
  readonly source: "local" | "community";
  readonly repoId?: string | null;
  readonly updatedAt?: string;
}

export interface TemplateTypeGroup {
  readonly label: string;
  readonly type: string;
}

/**
 * The §3.1 checkbox groups mapped onto the T-0761 §9 type registry. `CA
 * Templates` is the CIPP community category for conditional-access
 * templates, so it shares the `conditional-access` type.
 */
export const TEMPLATE_TYPE_GROUPS: readonly TemplateTypeGroup[] = [
  { label: "Conditional Access", type: "conditional-access" },
  { label: "Intune Configuration", type: "intune-configuration" },
  { label: "Intune Compliance", type: "intune-compliance" },
  { label: "Intune Protection", type: "intune-protection" },
  { label: "Template Standards", type: "standards" },
  { label: "Group", type: "group" },
  { label: "Policy", type: "policy" },
  { label: "CA Templates", type: "conditional-access" },
];

export function templateTypeLabel(type: string): string {
  return TEMPLATE_TYPE_GROUPS.find((group) => group.type === type)?.label ?? type;
}

export interface TemplateLibraryTableProps {
  readonly items?: readonly TemplateLibraryItem[];
  readonly loading?: boolean;
  readonly error?: string | null;
  /** Whether the caller holds `templates.write`; hides the destructive Delete action. */
  readonly canWrite?: boolean;
  readonly onView?: (item: TemplateLibraryItem) => void;
  readonly onClone?: (item: TemplateLibraryItem) => void;
  readonly onExport?: (item: TemplateLibraryItem) => void;
  readonly onDelete?: (item: TemplateLibraryItem) => void;
}

const containerStyle: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: "16px",
  width: "100%",
  fontFamily: "var(--font-sans, system-ui, sans-serif)",
  color: "var(--text)",
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

const badgeBaseStyle: CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  padding: "2px 8px",
  borderRadius: "999px",
  fontSize: "12px",
  fontWeight: 600,
  background: "var(--accent-soft)",
  color: "var(--accent-text)",
  border: "1px solid var(--accent)",
};

const sourceBadgeStyle: CSSProperties = {
  ...badgeBaseStyle,
  background: "var(--surface)",
  color: "var(--text-soft)",
  border: "1px solid var(--border)",
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

const deleteBtnStyle: CSSProperties = {
  ...actionBtnStyle,
  color: "var(--danger-text)",
  borderColor: "var(--danger)",
};

function formatDateTime(value: string | undefined): string {
  if (!value) return "—";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
}

export function TemplateLibraryTable({
  items = [],
  loading = false,
  error = null,
  canWrite = false,
  onView,
  onClone,
  onExport,
  onDelete,
}: TemplateLibraryTableProps): ReactElement {
  return (
    <div style={containerStyle} data-testid="template-library-table">
      {loading && (
        <div style={{ padding: "32px", textAlign: "center", color: "var(--text-soft)" }} data-testid="template-library-loading">
          Loading template library...
        </div>
      )}

      {error && (
        <div
          style={{
            padding: "16px",
            background: "var(--danger-soft)",
            border: "1px solid var(--danger)",
            borderRadius: "6px",
            color: "var(--danger-text)",
          }}
          role="alert"
          data-testid="template-library-error"
        >
          {error}
        </div>
      )}

      {!loading && !error && (
        <div style={tableWrapperStyle}>
          <table style={tableStyle} className="DataTable" aria-label="Configured Template Libraries">
            <thead>
              <tr>
                <th style={thStyle}>Name</th>
                <th style={thStyle}>Type</th>
                <th style={thStyle}>Source</th>
                <th style={thStyle}>Updated</th>
                <th style={{ ...thStyle, textAlign: "right" }}>Actions</th>
              </tr>
            </thead>
            <tbody>
              {items.length === 0 && (
                <tr>
                  <td
                    style={{ ...tdStyle, textAlign: "center", color: "var(--text-soft)" }}
                    colSpan={5}
                    data-testid="template-library-empty"
                  >
                    No templates match the current selection.
                  </td>
                </tr>
              )}
              {items.map((item) => (
                <tr key={item.id} data-testid={`library-row-${item.id}`}>
                  <td style={{ ...tdStyle, fontWeight: 600 }}>{item.name}</td>
                  <td style={tdStyle}>
                    <span className="status-badge" style={badgeBaseStyle} data-testid={`library-type-${item.id}`}>
                      {templateTypeLabel(item.type)}
                    </span>
                  </td>
                  <td style={tdStyle}>
                    <span className="status-badge" style={sourceBadgeStyle} data-testid={`library-source-${item.id}`}>
                      {item.source}
                    </span>
                  </td>
                  <td style={tdStyle}>{formatDateTime(item.updatedAt)}</td>
                  <td style={{ ...tdStyle, textAlign: "right" }}>
                    <div style={{ display: "inline-flex", gap: "6px", justifyContent: "flex-end", flexWrap: "wrap" }}>
                      {onView && (
                        <button
                          type="button"
                          style={actionBtnStyle}
                          onClick={() => onView(item)}
                          data-testid={`library-view-${item.id}`}
                        >
                          View
                        </button>
                      )}
                      {onClone && (
                        <button
                          type="button"
                          style={actionBtnStyle}
                          onClick={() => onClone(item)}
                          data-testid={`library-clone-${item.id}`}
                        >
                          Clone to tenant
                        </button>
                      )}
                      {onExport && (
                        <button
                          type="button"
                          style={actionBtnStyle}
                          onClick={() => onExport(item)}
                          data-testid={`library-export-${item.id}`}
                        >
                          Export
                        </button>
                      )}
                      {onDelete && canWrite && (
                        <button
                          type="button"
                          style={deleteBtnStyle}
                          onClick={() => onDelete(item)}
                          data-testid={`library-delete-${item.id}`}
                        >
                          Delete
                        </button>
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
