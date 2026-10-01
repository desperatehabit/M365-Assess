"use client";

// Permissions Report table (EPIC-027 SPEC.md §2 US-2, §3.2; T-0524).
// Read-only render of the §3.2 columns — Site, Principal, Role, Inherited,
// Scope — for site/OneDrive permission rows. No fetches, no selection, and no
// write controls here; the page owns the read and the §3.2 filters and pushes
// them to the T-0523 API.

import React, { type CSSProperties, type ReactElement } from "react";

export type PermissionsPrincipalType = "user" | "group" | "servicePrincipal";

export interface PermissionsReportItem {
  readonly site: string;
  readonly siteId: string;
  readonly principal: string;
  readonly principalId: string;
  readonly principalType: PermissionsPrincipalType | "";
  readonly role: string;
  readonly inherited: boolean;
  readonly scope: string;
}

export interface PermissionsTableProps {
  readonly items?: readonly PermissionsReportItem[];
  readonly loading?: boolean;
  readonly error?: string | null;
  readonly emptyMessage?: string;
}

const PRINCIPAL_TYPE_LABELS: Record<PermissionsPrincipalType | "", string> = {
  user: "User",
  group: "Group",
  servicePrincipal: "Service principal",
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

const badgeStyle: CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  padding: "2px 8px",
  borderRadius: "999px",
  fontSize: "12px",
  fontWeight: 600,
  background: "var(--surface)",
  color: "var(--text-soft)",
  border: "1px solid var(--border)",
};

function formatValue(value: string): string {
  return value && value.trim().length > 0 ? value : "—";
}

export function PermissionsTable({
  items = [],
  loading = false,
  error = null,
  emptyMessage = "No permissions found.",
}: PermissionsTableProps): ReactElement {
  return (
    <div style={containerStyle} data-testid="permissions-table-container">
      {loading && (
        <div style={{ padding: "32px", textAlign: "center", color: "var(--text-soft)" }} data-testid="permissions-loading">
          Loading permissions...
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
          data-testid="permissions-error"
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
          data-testid="permissions-empty"
        >
          {emptyMessage}
        </div>
      )}

      {!loading && !error && items.length > 0 && (
        <div style={tableWrapperStyle}>
          <table style={tableStyle} aria-label="Permissions report">
            <thead>
              <tr>
                <th style={thStyle}>Site</th>
                <th style={thStyle}>Principal</th>
                <th style={thStyle}>Role</th>
                <th style={thStyle}>Inherited</th>
                <th style={thStyle}>Scope</th>
              </tr>
            </thead>
            <tbody>
              {items.map((item) => (
                <tr key={`${item.siteId}:${item.principalId}`} data-testid={`permissions-row-${item.principalId}`}>
                  <td style={tdStyle}>
                    <div style={{ display: "flex", flexDirection: "column", gap: "2px" }}>
                      <span>{formatValue(item.site)}</span>
                      <span style={monoStyle}>{formatValue(item.siteId)}</span>
                    </div>
                  </td>
                  <td style={tdStyle}>
                    <div style={{ display: "flex", flexDirection: "column", gap: "2px" }}>
                      <span>{formatValue(item.principal)}</span>
                      <span style={badgeStyle} data-testid={`permissions-principal-type-${item.principalId}`}>
                        {PRINCIPAL_TYPE_LABELS[item.principalType]}
                      </span>
                    </div>
                  </td>
                  <td style={tdStyle}>{formatValue(item.role)}</td>
                  <td style={tdStyle} data-testid={`permissions-inherited-${item.principalId}`}>
                    {item.inherited ? "Yes" : "No"}
                  </td>
                  <td style={tdStyle}>{formatValue(item.scope)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
