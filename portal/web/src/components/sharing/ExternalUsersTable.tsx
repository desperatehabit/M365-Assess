"use client";

// External users table (EPIC-027 SPEC.md §3.3; T-0525).
// Read-only render of the §3.3 columns — External user · Email · Sites ·
// Last access · Invited by — with per-user drill-through to the sites/items the
// selected external user can access. The page owns the reads; this component
// only reports selection and renders the drill-through it is handed.

import React, { type CSSProperties, type ReactElement } from "react";

export interface ExternalUserItem {
  readonly externalUserId: string;
  readonly externalUser: string;
  readonly email: string;
  readonly sites: readonly string[];
  readonly siteCount: number;
  readonly accessCount: number;
  readonly lastAccess: string | null;
  readonly invitedBy: string | null;
}

export interface ExternalUserAccessItem {
  readonly siteId: string;
  readonly siteName: string;
  readonly siteUrl: string;
  readonly itemId: string | null;
  readonly itemName: string | null;
  readonly roles: readonly string[];
  readonly linkType: string | null;
  readonly invitedBy: string | null;
  readonly invitedAt: string | null;
  readonly lastAccess: string | null;
}

export interface ExternalUsersTableProps {
  readonly items: readonly ExternalUserItem[];
  readonly loading?: boolean;
  readonly selectedExternalUserId?: string | null;
  readonly access?: readonly ExternalUserAccessItem[];
  readonly accessLoading?: boolean;
  readonly onSelect?: (user: ExternalUserItem) => void;
}

const tableStyle: CSSProperties = {
  width: "100%",
  borderCollapse: "collapse",
  fontSize: "14px",
};

const thStyle: CSSProperties = {
  textAlign: "left",
  padding: "10px 12px",
  borderBottom: "1px solid var(--border-strong, var(--border))",
  color: "var(--text-soft)",
  fontSize: "12px",
  textTransform: "uppercase",
  letterSpacing: "0.07em",
};

const tdStyle: CSSProperties = {
  padding: "10px 12px",
  borderBottom: "1px solid var(--border)",
  verticalAlign: "top",
};

const detailCellStyle: CSSProperties = {
  padding: "12px 16px",
  borderBottom: "1px solid var(--border)",
  background: "var(--surface)",
};

const monoStyle: CSSProperties = {
  fontFamily: "var(--font-mono, monospace)",
  fontSize: "13px",
};

const actionButtonStyle: CSSProperties = {
  padding: "4px 10px",
  background: "var(--surface)",
  border: "1px solid var(--border)",
  borderRadius: "6px",
  color: "var(--text)",
  fontSize: "12px",
  cursor: "pointer",
  whiteSpace: "nowrap",
};

const linkStyle: CSSProperties = {
  color: "var(--accent, var(--text))",
  textDecoration: "none",
};

function formatDate(value: string | null): string {
  return value && value.trim().length > 0 ? value : "—";
}

export function ExternalUsersTable({
  items,
  loading = false,
  selectedExternalUserId = null,
  access = [],
  accessLoading = false,
  onSelect,
}: ExternalUsersTableProps): ReactElement {
  return (
    <div style={{ overflowX: "auto" }}>
      <table style={tableStyle} data-testid="external-users-table">
        <thead>
          <tr>
            <th style={thStyle}>External user</th>
            <th style={thStyle}>Email</th>
            <th style={thStyle}>Sites</th>
            <th style={thStyle}>Last access</th>
            <th style={thStyle}>Invited by</th>
            <th style={thStyle}>Access</th>
          </tr>
        </thead>
        <tbody>
          {loading ? (
            <tr>
              <td style={tdStyle} colSpan={6}>
                Loading external users…
              </td>
            </tr>
          ) : items.length === 0 ? (
            <tr>
              <td style={tdStyle} colSpan={6}>
                No external users found.
              </td>
            </tr>
          ) : (
            items.map((entry) => {
              const selected = selectedExternalUserId === entry.externalUserId;
              return (
                <React.Fragment key={entry.externalUserId}>
                  <tr data-testid={`external-user-row-${entry.externalUserId}`}>
                    <td style={tdStyle}>{entry.externalUser}</td>
                    <td style={{ ...tdStyle, ...monoStyle }}>{entry.email}</td>
                    <td style={tdStyle}>
                      {entry.siteCount} {entry.siteCount === 1 ? "site" : "sites"}
                      <div style={{ fontSize: "12px", color: "var(--text-soft)" }}>
                        {entry.sites.join(", ")}
                      </div>
                    </td>
                    <td style={tdStyle}>{formatDate(entry.lastAccess)}</td>
                    <td style={tdStyle}>{entry.invitedBy ?? "—"}</td>
                    <td style={tdStyle}>
                      <button
                        type="button"
                        style={actionButtonStyle}
                        aria-expanded={selected}
                        aria-label={`View access for ${entry.externalUser}`}
                        data-testid={`external-user-access-button-${entry.externalUserId}`}
                        onClick={() => onSelect?.(entry)}
                      >
                        {selected ? "Hide access" : "View access"}
                      </button>
                    </td>
                  </tr>
                  {selected && (
                    <tr data-testid={`external-user-access-${entry.externalUserId}`}>
                      <td style={detailCellStyle} colSpan={6}>
                        {accessLoading ? (
                          <div style={{ color: "var(--text-soft)" }}>Loading access…</div>
                        ) : access.length === 0 ? (
                          <div style={{ color: "var(--text-soft)" }}>
                            No site or item access recorded for this external user.
                          </div>
                        ) : (
                          <ul style={{ margin: 0, paddingLeft: "18px", display: "grid", gap: "6px" }}>
                            {access.map((grant, index) => (
                              <li
                                key={`${grant.siteId}:${grant.itemId ?? ""}:${index}`}
                                data-testid={`external-user-access-entry-${index}`}
                              >
                                <a
                                  href={grant.siteUrl}
                                  target="_blank"
                                  rel="noreferrer"
                                  style={linkStyle}
                                  data-testid={`external-user-access-site-${index}`}
                                >
                                  {grant.siteName}
                                </a>
                                {grant.itemName ? ` · ${grant.itemName}` : " · Site access"}
                                {grant.roles.length > 0 ? ` · ${grant.roles.join(", ")}` : ""}
                                {grant.linkType ? ` · ${grant.linkType} link` : ""}
                                {grant.invitedBy ? ` · invited by ${grant.invitedBy}` : ""}
                                <span style={{ color: "var(--text-soft)" }}>
                                  {` · last access ${formatDate(grant.lastAccess)}`}
                                </span>
                              </li>
                            ))}
                          </ul>
                        )}
                      </td>
                    </tr>
                  )}
                </React.Fragment>
              );
            })
          )}
        </tbody>
      </table>
    </div>
  );
}
