"use client";

// OneDrive usage table (EPIC-025 SPEC.md §2 US-6, §3.5; T-0489).
// Renders per-user OneDrive usage (storage used/quota, percent, last activity)
// and sharing state (link counts by scope), supports search and
// no-OneDrive/over-quota/anonymous-link filters, and hands bulk sharing-link
// removal to EPIC-027 through the onRemoveLinks/onBulkRemoveLinks callbacks.
// No removal is performed here. Strictly uses report theme tokens with zero
// colour literals.

import React, { useMemo, useState, type CSSProperties, type ReactElement } from "react";

export interface OneDriveSharingLinkRef {
  readonly linkId: string;
  readonly linkType: string;
  readonly resourceName: string;
  readonly driveId: string;
  readonly itemId: string;
}

export interface OneDriveUserUsage {
  readonly userId: string;
  readonly displayName: string;
  readonly userPrincipalName: string;
  readonly hasOneDrive: boolean;
  readonly storageUsedBytes: number | null;
  readonly storageQuotaBytes: number | null;
  readonly storageUsedPercent: number | null;
  readonly lastActivityDate: string | null;
  readonly sharing: {
    readonly total: number;
    readonly anonymous: number;
    readonly organization: number;
    readonly user: number;
  };
  readonly sharingLinks: readonly OneDriveSharingLinkRef[];
}

export interface OneDriveTableProps {
  readonly users?: readonly OneDriveUserUsage[];
  readonly loading?: boolean;
  readonly error?: string | null;
  readonly onRemoveLinks?: (user: OneDriveUserUsage) => void;
  readonly onBulkRemoveLinks?: (users: readonly OneDriveUserUsage[]) => void;
}

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
  color: "var(--text)",
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

export function formatBytes(bytes: number): string {
  const units = ["B", "KB", "MB", "GB", "TB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${Number.isInteger(value) ? value : value.toFixed(1)} ${units[unit]}`;
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

export function OneDriveTable({
  users = [],
  loading = false,
  error = null,
  onRemoveLinks,
  onBulkRemoveLinks,
}: OneDriveTableProps): ReactElement {
  const [search, setSearch] = useState("");
  const [noOneDriveFilter, setNoOneDriveFilter] = useState(false);
  const [overQuotaFilter, setOverQuotaFilter] = useState(false);
  const [anonymousFilter, setAnonymousFilter] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());

  const filteredUsers = useMemo(() => {
    const query = search.trim().toLowerCase();
    return users.filter((user) => {
      if (query) {
        const haystack = `${user.displayName} ${user.userPrincipalName}`.toLowerCase();
        if (!haystack.includes(query)) return false;
      }
      if (noOneDriveFilter && user.hasOneDrive) return false;
      if (overQuotaFilter && (user.storageUsedPercent ?? 0) < 90) return false;
      if (anonymousFilter && user.sharing.anonymous === 0) return false;
      return true;
    });
  }, [users, search, noOneDriveFilter, overQuotaFilter, anonymousFilter]);

  const allSelected = filteredUsers.length > 0 && filteredUsers.every((user) => selected.has(user.userId));
  const selectedUsers = useMemo(
    () => filteredUsers.filter((user) => selected.has(user.userId)),
    [filteredUsers, selected],
  );
  const selectedLinkCount = selectedUsers.reduce((sum, user) => sum + user.sharingLinks.length, 0);

  function toggleSelect(id: string): void {
    setSelected((previous) => {
      const next = new Set(previous);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  }

  function toggleSelectAll(): void {
    if (allSelected) {
      setSelected(new Set());
    } else {
      setSelected(new Set(filteredUsers.map((user) => user.userId)));
    }
  }

  return (
    <div style={containerStyle} data-testid="onedrive-table-container">
      <div style={headerBarStyle}>
        <div style={{ display: "flex", alignItems: "center", gap: "12px" }}>
          <h2 style={{ margin: 0, fontSize: "20px", fontWeight: 600 }}>OneDrive</h2>
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
            {filteredUsers.length} {filteredUsers.length === 1 ? "user" : "users"}
          </span>
        </div>
      </div>

      <div style={{ ...headerBarStyle, padding: "12px 16px" }}>
        <div style={filterRowStyle}>
          <input
            type="text"
            placeholder="Search name or UPN..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            style={inputStyle}
            aria-label="Search OneDrive users"
            data-testid="filter-search"
          />
          <label style={{ display: "inline-flex", alignItems: "center", gap: "6px", fontSize: "13px" }}>
            <input
              type="checkbox"
              checked={noOneDriveFilter}
              onChange={(e) => setNoOneDriveFilter(e.target.checked)}
              data-testid="filter-no-onedrive"
            />
            Without OneDrive
          </label>
          <label style={{ display: "inline-flex", alignItems: "center", gap: "6px", fontSize: "13px" }}>
            <input
              type="checkbox"
              checked={overQuotaFilter}
              onChange={(e) => setOverQuotaFilter(e.target.checked)}
              data-testid="filter-over-quota"
            />
            Over quota warning (≥90%)
          </label>
          <label style={{ display: "inline-flex", alignItems: "center", gap: "6px", fontSize: "13px" }}>
            <input
              type="checkbox"
              checked={anonymousFilter}
              onChange={(e) => setAnonymousFilter(e.target.checked)}
              data-testid="filter-anonymous-links"
            />
            Has anonymous links
          </label>
        </div>
      </div>

      {selectedUsers.length > 0 && (
        <div style={{ ...headerBarStyle, padding: "12px 16px" }} data-testid="bulk-actions-bar">
          <span style={{ fontSize: "14px", color: "var(--text-soft)" }}>
            {selectedUsers.length} selected · {selectedLinkCount} sharing links
          </span>
          <div style={{ display: "flex", gap: "8px" }}>
            {onBulkRemoveLinks && (
              <button
                type="button"
                style={actionBtnStyle}
                disabled={selectedLinkCount === 0}
                title={
                  selectedLinkCount === 0
                    ? "Selected users have no sharing links"
                    : "Hand the selected links to EPIC-027 bulk removal"
                }
                onClick={() => onBulkRemoveLinks(selectedUsers)}
                data-testid="bulk-remove-links"
              >
                Remove sharing links
              </button>
            )}
          </div>
        </div>
      )}

      {loading && (
        <div style={{ padding: "32px", textAlign: "center", color: "var(--text-soft)" }}>
          Loading OneDrive usage...
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
        >
          {error}
        </div>
      )}

      {!loading && !error && filteredUsers.length === 0 && (
        <div
          style={{
            padding: "48px 16px",
            textAlign: "center",
            background: "var(--bg-elev)",
            borderRadius: "var(--radius, 10px)",
            border: "1px solid var(--border)",
            color: "var(--text-soft)",
          }}
          data-testid="empty-onedrive-state"
        >
          No users found.
        </div>
      )}

      {!loading && !error && filteredUsers.length > 0 && (
        <div style={tableWrapperStyle}>
          <table style={tableStyle} aria-label="Tenant OneDrive usage">
            <thead>
              <tr>
                <th style={thStyle}>
                  <input
                    type="checkbox"
                    checked={allSelected}
                    onChange={toggleSelectAll}
                    aria-label="Select all users"
                    data-testid="select-all-onedrive"
                  />
                </th>
                <th style={thStyle}>User</th>
                <th style={thStyle}>UPN</th>
                <th style={thStyle}>Storage used</th>
                <th style={thStyle}>Last activity</th>
                <th style={thStyle}>Sharing links</th>
                <th style={{ ...thStyle, textAlign: "right" }}>Actions</th>
              </tr>
            </thead>
            <tbody>
              {filteredUsers.map((user) => (
                <tr key={user.userId} data-testid={`onedrive-row-${user.userId}`}>
                  <td style={tdStyle}>
                    <input
                      type="checkbox"
                      checked={selected.has(user.userId)}
                      onChange={() => toggleSelect(user.userId)}
                      aria-label={`Select ${user.userPrincipalName}`}
                      data-testid={`select-onedrive-${user.userId}`}
                    />
                  </td>
                  <td style={tdStyle}>{user.displayName}</td>
                  <td style={tdStyle}>
                    <span style={monoStyle}>{user.userPrincipalName}</span>
                  </td>
                  <td style={tdStyle}>
                    {user.hasOneDrive ? (
                      <div style={{ display: "flex", flexDirection: "column", gap: "2px" }}>
                        <span>
                          {formatBytes(user.storageUsedBytes ?? 0)} / {formatBytes(user.storageQuotaBytes ?? 0)}
                        </span>
                        <span
                          style={{
                            fontSize: "12px",
                            color:
                              (user.storageUsedPercent ?? 0) >= 90
                                ? "var(--warning-text)"
                                : "var(--text-soft)",
                          }}
                        >
                          {user.storageUsedPercent ?? 0}% used
                          {(user.storageUsedPercent ?? 0) >= 90 ? " — over quota warning" : ""}
                        </span>
                      </div>
                    ) : (
                      <span style={{ color: "var(--text-soft)" }}>No OneDrive provisioned</span>
                    )}
                  </td>
                  <td style={tdStyle}>{formatLastActivity(user.lastActivityDate)}</td>
                  <td style={tdStyle}>
                    {user.sharing.total > 0 ? (
                      <div style={{ display: "flex", flexDirection: "column", gap: "2px" }}>
                        <span>{user.sharing.total} total</span>
                        <span style={{ fontSize: "12px", color: "var(--text-soft)" }}>
                          {user.sharing.anonymous} anonymous · {user.sharing.organization} organization ·{" "}
                          {user.sharing.user} user
                        </span>
                      </div>
                    ) : (
                      <span style={{ color: "var(--text-soft)" }}>None</span>
                    )}
                  </td>
                  <td style={{ ...tdStyle, textAlign: "right" }}>
                    {onRemoveLinks &&
                      (user.sharingLinks.length > 0 ? (
                        <button
                          type="button"
                          style={actionBtnStyle}
                          onClick={() => onRemoveLinks(user)}
                          aria-label={`Remove sharing links for ${user.userPrincipalName}`}
                          data-testid={`remove-links-${user.userId}`}
                        >
                          Remove links ({user.sharingLinks.length})
                        </button>
                      ) : (
                        <button
                          type="button"
                          style={{ ...actionBtnStyle, opacity: 0.4, cursor: "not-allowed" }}
                          disabled
                          title="No sharing links to remove"
                          aria-label={`Remove sharing links for ${user.userPrincipalName} (no links)`}
                          data-testid={`remove-links-${user.userId}`}
                        >
                          Remove links
                        </button>
                      ))}
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
