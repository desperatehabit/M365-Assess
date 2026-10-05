"use client";

// Resource table (EPIC-023 SPEC.md §3.3, T-0449).
// Columns: Name · Capacity · Location · Type · Hidden. Row actions: View,
// Edit, Add to room list, Delete. Room lists show their membership. Write
// controls are disabled unless `canWrite` (RBAC) is set. Strictly uses report
// theme tokens with zero colour literals.

import React, { type CSSProperties, type ReactElement } from "react";

export type ResourceKind = "rooms" | "equipment" | "roomlists";

export type ResourceType = "room" | "equipment" | "roomlist";

export interface ResourceMember {
  readonly name: string | null;
  readonly primarySmtpAddress: string;
}

export interface ResourceItem {
  readonly id: string;
  readonly name: string | null;
  readonly primarySmtpAddress: string;
  readonly capacity: number | null;
  readonly location: string | null;
  readonly type: ResourceType;
  readonly hidden: boolean;
  readonly members: readonly ResourceMember[];
}

export type ResourceRowAction =
  | "view"
  | "edit"
  | "addMember"
  | "removeMember"
  | "delete";

export interface ResourceTableProps {
  readonly resources?: readonly ResourceItem[];
  readonly loading?: boolean;
  readonly error?: string | null;
  readonly kind: ResourceKind;
  readonly canWrite?: boolean;
  readonly onAddResource?: () => void;
  readonly onAction?: (action: ResourceRowAction, resource: ResourceItem) => void;
}

const ROW_ACTIONS: readonly { readonly action: ResourceRowAction; readonly label: string }[] = [
  { action: "view", label: "View" },
  { action: "edit", label: "Edit" },
  { action: "addMember", label: "Add to room list" },
  { action: "removeMember", label: "Remove from list" },
  { action: "delete", label: "Delete" },
];

const containerStyle: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: "16px",
  width: "100%",
  fontFamily: "var(--font-sans, system-ui, sans-serif)",
  color: "var(--text)",
};

const barStyle: CSSProperties = {
  display: "flex",
  flexWrap: "wrap",
  gap: "10px",
  alignItems: "center",
  justifyContent: "space-between",
  padding: "12px 16px",
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
};

const primaryButtonStyle: CSSProperties = {
  ...buttonStyle,
  background: "var(--accent)",
  color: "var(--on-accent)",
  borderColor: "var(--accent)",
};

const disabledStyle: CSSProperties = { opacity: 0.45, cursor: "not-allowed" };

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

function badgeStyle(tone: "accent" | "muted" | "warn"): CSSProperties {
  const tones = {
    accent: { bg: "var(--accent-soft)", text: "var(--accent-text)", border: "var(--accent-border)" },
    muted: { bg: "var(--surface)", text: "var(--text-soft)", border: "var(--border)" },
    warn: { bg: "var(--warning-soft)", text: "var(--warning-text)", border: "var(--warning)" },
  }[tone];
  return {
    display: "inline-flex",
    alignItems: "center",
    padding: "2px 8px",
    borderRadius: "999px",
    fontSize: "12px",
    fontWeight: 600,
    textTransform: "capitalize",
    background: tones.bg,
    color: tones.text,
    border: `1px solid ${tones.border}`,
  };
}

export function ResourceTable({
  resources = [],
  loading = false,
  error = null,
  kind,
  canWrite = true,
  onAddResource,
  onAction,
}: ResourceTableProps): ReactElement {
  const writeDisabled = !canWrite;
  const isRoomList = kind === "roomlists";

  return (
    <div style={containerStyle} data-testid="resource-table-container">
      <div style={barStyle}>
        <div style={{ display: "flex", alignItems: "center", gap: "10px" }}>
          <span
            style={{
              padding: "2px 8px",
              background: "var(--surface)",
              border: "1px solid var(--border)",
              borderRadius: "999px",
              fontSize: "12px",
              color: "var(--text-soft)",
            }}
            data-testid="resource-count"
          >
            {resources.length} {resources.length === 1 ? "resource" : "resources"}
          </span>
          {onAddResource && (
            <button type="button" style={primaryButtonStyle} onClick={onAddResource} data-testid="add-resource-button">
              Add resource
            </button>
          )}
        </div>
      </div>

      {loading && (
        <div style={{ padding: "32px", textAlign: "center", color: "var(--text-soft)" }} data-testid="resource-loading">
          Loading resources...
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
          data-testid="resource-error"
        >
          {error}
        </div>
      )}

      {!loading && !error && resources.length === 0 && (
        <div
          style={{
            padding: "48px 16px",
            textAlign: "center",
            background: "var(--bg-elev)",
            borderRadius: "var(--radius, 10px)",
            border: "1px solid var(--border)",
            color: "var(--text-soft)",
          }}
          data-testid="empty-resource-state"
        >
          No resources found.
        </div>
      )}

      {!loading && !error && resources.length > 0 && (
        <div style={tableWrapperStyle}>
          <table style={tableStyle} aria-label="Resources">
            <thead>
              <tr>
                <th style={thStyle}>Name</th>
                <th style={thStyle}>Capacity</th>
                <th style={thStyle}>Location</th>
                <th style={thStyle}>Type</th>
                <th style={thStyle}>Hidden</th>
                {isRoomList && <th style={thStyle}>Members</th>}
                <th style={{ ...thStyle, textAlign: "right" }}>Actions</th>
              </tr>
            </thead>
            <tbody>
              {resources.map((resource) => (
                <tr key={resource.id} data-testid={`resource-row-${resource.id}`}>
                  <td style={tdStyle}>{resource.name ?? "—"}</td>
                  <td style={tdStyle}>{resource.capacity ?? "—"}</td>
                  <td style={tdStyle}>{resource.location ?? "—"}</td>
                  <td style={tdStyle}>
                    <span style={badgeStyle(resource.type === "roomlist" ? "accent" : "muted")}>{resource.type}</span>
                  </td>
                  <td style={tdStyle}>
                    <span style={badgeStyle(resource.hidden ? "warn" : "muted")}>
                      {resource.hidden ? "Hidden" : "Visible"}
                    </span>
                  </td>
                  {isRoomList && (
                    <td style={tdStyle}>
                      {resource.members.length === 0 ? (
                        "—"
                      ) : (
                        <div style={{ display: "flex", flexDirection: "column", gap: "2px" }}>
                          {resource.members.map((member) => (
                            <span key={member.primarySmtpAddress} style={{ fontSize: "13px" }}>
                              {member.name ?? member.primarySmtpAddress}
                            </span>
                          ))}
                        </div>
                      )}
                    </td>
                  )}
                  <td style={{ ...tdStyle, textAlign: "right" }}>
                    <div style={{ display: "inline-flex", gap: "6px", justifyContent: "flex-end", flexWrap: "wrap" }}>
                      {ROW_ACTIONS.map(({ action, label }) => {
                        const isWriteAction = action !== "view";
                        const isMembershipAction = action === "addMember" || action === "removeMember";
                        const hideForKind = isMembershipAction && !isRoomList;
                        if (hideForKind) return null;
                        return (
                          <button
                            key={action}
                            type="button"
                            style={isWriteAction && writeDisabled ? { ...actionBtnStyle, ...disabledStyle } : actionBtnStyle}
                            disabled={isWriteAction && writeDisabled}
                            title={isWriteAction && writeDisabled ? "Requires Exchange.Resource.ReadWrite permission" : label}
                            onClick={() => onAction?.(action, resource)}
                            aria-label={`${label} ${resource.name ?? resource.id}`}
                            data-testid={`resource-action-${action}-${resource.id}`}
                          >
                            {label}
                          </button>
                        );
                      })}
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
