"use client";

// Site browser (EPIC-025 SPEC.md §2 US-5, §3.4, §4.3; T-0488).
// Read-only per-site enumeration: document libraries, their top-level items,
// site permissions, and external users, plus a deep link into the SharePoint
// admin center for advanced actions not in v1 (site collection upgrade, term
// store, tenant-level sharing settings — SPEC §11 item 4). Permission changes
// are not performed here; the onEditPermissions callback hands the EPIC-027
// flow the site. Strictly uses report theme tokens with zero colour literals.

import React, { type CSSProperties, type ReactElement } from "react";

export interface SiteBrowserLibrary {
  readonly id: string;
  readonly name: string;
  readonly webUrl: string;
  readonly driveType: string;
  readonly quotaUsedBytes: number | null;
  readonly quotaTotalBytes: number | null;
}

export interface SiteBrowserItem {
  readonly id: string;
  readonly name: string;
  readonly webUrl: string;
  readonly libraryId: string;
  readonly libraryName: string;
  readonly isFolder: boolean;
  readonly sizeBytes: number | null;
  readonly lastModifiedDateTime: string | null;
}

export interface SiteBrowserPermission {
  readonly id: string;
  readonly roles: readonly string[];
  readonly principalType: string;
  readonly displayName: string;
  readonly email: string;
  readonly loginName: string;
  readonly userType: string;
  readonly external: boolean;
  readonly linkType: string;
}

export interface SiteBrowserExternalUser {
  readonly displayName: string;
  readonly email: string;
  readonly loginName: string;
  readonly principalType: string;
  readonly permissionId: string;
  readonly roles: readonly string[];
}

export interface SiteBrowserData {
  readonly tenantId: string;
  readonly siteId: string;
  readonly siteUrl: string;
  readonly adminCenterUrl: string;
  readonly libraries: readonly SiteBrowserLibrary[];
  readonly items: readonly SiteBrowserItem[];
  readonly permissions: readonly SiteBrowserPermission[];
  readonly externalUsers: readonly SiteBrowserExternalUser[];
  readonly handoff: {
    readonly permissionEdits: false;
    readonly sharingPermissionsPath: string;
    readonly externalUsersPath: string;
    readonly sharingLinksRemovePath: string;
  };
}

export type SiteBrowserSection = "libraries" | "items" | "permissions" | "externalUsers";

const ALL_SECTIONS: readonly SiteBrowserSection[] = ["libraries", "items", "permissions", "externalUsers"];

export interface SiteBrowserProps {
  readonly browser?: SiteBrowserData | null;
  /** Which panels to render; the site detail pages each show their own slice. Defaults to all four. */
  readonly sections?: readonly SiteBrowserSection[];
  readonly loading?: boolean;
  readonly error?: string | null;
  readonly onEditPermissions?: (browser: SiteBrowserData) => void;
}

const containerStyle: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: "16px",
  width: "100%",
  fontFamily: "var(--font-sans, system-ui, sans-serif)",
  color: "var(--text)",
};

const panelStyle: CSSProperties = {
  background: "var(--bg-elev)",
  border: "1px solid var(--border)",
  borderRadius: "var(--radius, 10px)",
  boxShadow: "var(--shadow-card)",
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
  color: "var(--text)",
};

const linkStyle: CSSProperties = {
  color: "var(--accent, var(--text))",
  textDecoration: "underline",
  cursor: "pointer",
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

function badgeStyle(kind: "ok" | "warn" | "muted"): CSSProperties {
  const tones = {
    ok: { bg: "var(--success-soft)", text: "var(--success-text)", border: "var(--success)" },
    warn: { bg: "var(--warning-soft)", text: "var(--warning-text)", border: "var(--warning)" },
    muted: { bg: "var(--surface)", text: "var(--text-soft)", border: "var(--border)" },
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

export function formatBrowserBytes(bytes: number | null): string {
  if (bytes === null) return "—";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${Number.isInteger(value) ? value : value.toFixed(1)} ${units[unit]}`;
}

function sectionHeading(title: string, count: number): ReactElement {
  return (
    <div style={{ ...headerBarStyle, borderBottomLeftRadius: 0, borderBottomRightRadius: 0 }}>
      <h3 style={{ margin: 0, fontSize: "16px", fontWeight: 600 }}>{title}</h3>
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
        {count}
      </span>
    </div>
  );
}

export function SiteBrowser({
  browser = null,
  loading = false,
  error = null,
  sections = ALL_SECTIONS,
  onEditPermissions,
}: SiteBrowserProps): ReactElement {
  const show = (section: SiteBrowserSection): boolean => sections.includes(section);
  if (loading) {
    return (
      <div style={containerStyle} data-testid="site-browser-container">
        <div
          style={{ ...panelStyle, padding: "32px", textAlign: "center", color: "var(--text-soft)" }}
          data-testid="site-browser-loading"
        >
          Loading site browser...
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div style={containerStyle} data-testid="site-browser-container">
        <div
          style={{
            padding: "16px",
            borderRadius: "6px",
            background: "var(--danger-soft)",
            border: "1px solid var(--danger)",
            color: "var(--danger-text)",
          }}
          role="alert"
          data-testid="site-browser-error"
        >
          {error}
        </div>
      </div>
    );
  }

  if (!browser) {
    return (
      <div style={containerStyle} data-testid="site-browser-container">
        <div
          style={{ ...panelStyle, padding: "48px 16px", textAlign: "center", color: "var(--text-soft)" }}
          data-testid="site-browser-empty"
        >
          Select a site to browse its libraries, permissions, and external users.
        </div>
      </div>
    );
  }

  return (
    <div style={containerStyle} data-testid="site-browser-container">
      <div style={headerBarStyle}>
        <div style={{ display: "flex", flexDirection: "column", gap: "4px" }}>
          <h2 style={{ margin: 0, fontSize: "20px", fontWeight: 600 }}>Site browser</h2>
          <a
            href={browser.siteUrl}
            target="_blank"
            rel="noopener noreferrer"
            style={linkStyle}
            data-testid="site-url-link"
          >
            {browser.siteUrl}
          </a>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: "12px" }}>
          <a
            href={browser.adminCenterUrl}
            target="_blank"
            rel="noopener noreferrer"
            style={{ ...buttonStyle, textDecoration: "none" }}
            title="Site collection upgrade, term store, and tenant-level sharing settings"
            data-testid="admin-center-link"
          >
            Open in SharePoint admin center
          </a>
          {onEditPermissions && (
            <button
              type="button"
              style={buttonStyle}
              onClick={() => onEditPermissions(browser)}
              title="Hand permission changes to EPIC-027"
              data-testid="edit-permissions"
            >
              Edit permissions
            </button>
          )}
        </div>
      </div>

      <p style={{ margin: 0, color: "var(--text-soft)", fontSize: "13px" }}>
        Advanced actions (site collection upgrade, term store, tenant-level sharing settings) stay
        in the SharePoint admin center. Permission changes are handed to the sharing and
        permissions workflow; nothing is changed here.
      </p>

      {show("libraries") && (
        <div style={panelStyle}>
          {sectionHeading("Document libraries", browser.libraries.length)}
          {browser.libraries.length === 0 ? (
            <div style={{ padding: "24px 16px", color: "var(--text-soft)" }} data-testid="libraries-empty">
              No document libraries.
            </div>
          ) : (
            <table style={tableStyle} aria-label="Site document libraries">
              <thead>
                <tr>
                  <th style={thStyle}>Library</th>
                  <th style={thStyle}>Type</th>
                  <th style={thStyle}>Storage</th>
                </tr>
              </thead>
              <tbody>
                {browser.libraries.map((library) => (
                  <tr key={library.id} data-testid={`library-row-${library.id}`}>
                    <td style={tdStyle}>
                      <a
                        href={library.webUrl}
                        target="_blank"
                        rel="noopener noreferrer"
                        style={linkStyle}
                      >
                        {library.name}
                      </a>
                    </td>
                    <td style={tdStyle}>{library.driveType}</td>
                    <td style={tdStyle}>
                      {formatBrowserBytes(library.quotaUsedBytes)} /{" "}
                      {formatBrowserBytes(library.quotaTotalBytes)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      )}

      {show("items") && (
        <div style={panelStyle}>
          {sectionHeading("Items", browser.items.length)}
          {browser.items.length === 0 ? (
            <div style={{ padding: "24px 16px", color: "var(--text-soft)" }} data-testid="items-empty">
              No items.
            </div>
          ) : (
            <table style={tableStyle} aria-label="Site library items">
              <thead>
                <tr>
                  <th style={thStyle}>Item</th>
                  <th style={thStyle}>Library</th>
                  <th style={thStyle}>Type</th>
                  <th style={thStyle}>Size</th>
                  <th style={thStyle}>Last modified</th>
                </tr>
              </thead>
              <tbody>
                {browser.items.map((item) => (
                  <tr key={item.id} data-testid={`item-row-${item.id}`}>
                    <td style={tdStyle}>
                      <a href={item.webUrl} target="_blank" rel="noopener noreferrer" style={linkStyle}>
                        {item.name}
                      </a>
                    </td>
                    <td style={tdStyle}>{item.libraryName}</td>
                    <td style={tdStyle}>{item.isFolder ? "Folder" : "File"}</td>
                    <td style={tdStyle}>{formatBrowserBytes(item.sizeBytes)}</td>
                    <td style={tdStyle}>{item.lastModifiedDateTime ?? "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      )}

      {show("permissions") && (
        <div style={panelStyle}>
          {sectionHeading("Permissions", browser.permissions.length)}
          {browser.permissions.length === 0 ? (
            <div style={{ padding: "24px 16px", color: "var(--text-soft)" }} data-testid="permissions-empty">
              No permission grants.
            </div>
          ) : (
            <table style={tableStyle} aria-label="Site permissions">
              <thead>
                <tr>
                  <th style={thStyle}>Principal</th>
                  <th style={thStyle}>Type</th>
                  <th style={thStyle}>Roles</th>
                  <th style={thStyle}>External</th>
                </tr>
              </thead>
              <tbody>
                {browser.permissions.map((permission, index) => (
                  <tr key={`${permission.id}-${index}`} data-testid={`permission-row-${index}`}>
                    <td style={tdStyle}>
                      {permission.displayName}
                      {permission.email ? (
                        <div style={{ ...monoStyle, color: "var(--text-soft)" }}>{permission.email}</div>
                      ) : null}
                    </td>
                    <td style={tdStyle}>{permission.principalType}</td>
                    <td style={tdStyle}>{permission.roles.join(", ")}</td>
                    <td style={tdStyle}>
                      {permission.external ? (
                        <span style={badgeStyle("warn")} data-testid={`permission-external-${index}`}>
                          External
                        </span>
                      ) : (
                        <span style={badgeStyle("muted")}>Internal</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      )}

      {show("externalUsers") && (
        <div style={panelStyle}>
          {sectionHeading("External users", browser.externalUsers.length)}
          {browser.externalUsers.length === 0 ? (
            <div
              style={{ padding: "24px 16px", color: "var(--text-soft)" }}
              data-testid="external-users-empty"
            >
              No external users.
            </div>
          ) : (
            <table style={tableStyle} aria-label="Site external users">
              <thead>
                <tr>
                  <th style={thStyle}>External user</th>
                  <th style={thStyle}>Email</th>
                  <th style={thStyle}>Roles</th>
                </tr>
              </thead>
              <tbody>
                {browser.externalUsers.map((user, index) => (
                  <tr key={`${user.permissionId}-${index}`} data-testid={`external-user-row-${index}`}>
                    <td style={tdStyle}>{user.displayName}</td>
                    <td style={tdStyle}>
                      <span style={monoStyle}>{user.email}</span>
                    </td>
                    <td style={tdStyle}>{user.roles.join(", ")}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      )}
    </div>
  );
}
