"use client";

// Contacts table (EPIC-023 SPEC.md §3.1, T-0445).
// Renders the §3.1 columns (display name, external address, type, hidden
// from GAL, last modified), the §3.1 filters (search, type, hidden) owned
// by the page and applied through the T-0442 list route
// (GET /v1/tenants/{id}/contacts), and the §3.1 row actions (View, Edit,
// Hide from GAL, Clone to template, Delete). Row actions and `Import CSV`
// report to the page, which routes to the template editor (T-0446) and
// write dialogs instead of duplicating their logic. Write actions are
// disabled unless `canWrite` (RBAC) is set. Strictly uses report theme
// tokens with zero colour literals.

import React, { type CSSProperties, type ReactElement } from "react";

export type ContactType = "mailContact" | "mailUser";

export type ContactRowAction =
  | "view"
  | "edit"
  | "hideFromGal"
  | "cloneToTemplate"
  | "delete";

export interface ContactItem {
  readonly id: string;
  readonly displayName: string | null;
  readonly externalAddress: string | null;
  readonly type: ContactType;
  readonly hiddenFromGal: boolean;
  readonly lastModified: string | null;
}

export interface ContactsFilters {
  readonly search?: string;
  readonly type?: ContactType | "";
  readonly hidden?: "" | "hidden" | "visible";
}

export const EMPTY_CONTACTS_FILTERS: ContactsFilters = {
  search: "",
  type: "",
  hidden: "",
};

export interface BuildContactsQueryOptions {
  readonly cursor?: string | null;
  readonly limit?: number;
}

/** Maps the §3.1 filters onto the T-0442 query parameters. */
export function buildContactsQuery(
  filters: ContactsFilters,
  options: BuildContactsQueryOptions = {},
): string {
  const params = new URLSearchParams();
  if (filters.search) params.set("search", filters.search);
  if (filters.type) params.set("type", filters.type);
  if (filters.hidden === "hidden") params.set("hidden", "true");
  if (filters.hidden === "visible") params.set("hidden", "false");
  if (options.cursor) params.set("cursor", options.cursor);
  if (options.limit !== undefined) params.set("limit", String(options.limit));
  const query = params.toString();
  return query.length > 0 ? `?${query}` : "";
}

export interface ContactsTableProps {
  readonly contacts?: readonly ContactItem[];
  readonly loading?: boolean;
  readonly error?: string | null;
  readonly filters: ContactsFilters;
  readonly onFiltersChange?: (filters: ContactsFilters) => void;
  readonly onAction?: (action: ContactRowAction, contact: ContactItem) => void;
  readonly onImport?: () => void;
  /** False hides write controls the caller lacks RBAC for. */
  readonly canWrite?: boolean;
}

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

const selectStyle: CSSProperties = { ...inputStyle, cursor: "pointer" };

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

const disabledActionBtnStyle: CSSProperties = {
  ...actionBtnStyle,
  opacity: 0.4,
  cursor: "not-allowed",
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

function badgeStyle(tone: "warn" | "muted"): CSSProperties {
  const tones = {
    warn: { bg: "var(--warning-soft)", text: "var(--warning-text)", border: "var(--warning)" },
    muted: { bg: "var(--surface)", text: "var(--text-soft)", border: "var(--border)" },
  }[tone];
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

export function contactTypeLabel(type: ContactType): string {
  return type === "mailContact" ? "Mail contact" : "Mail user";
}

export function formatLastModified(value: string | null): string {
  if (!value) return "—";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleDateString();
}

export function ContactsTable({
  contacts = [],
  loading = false,
  error = null,
  filters,
  onFiltersChange,
  onAction,
  onImport,
  canWrite = true,
}: ContactsTableProps): ReactElement {
  function updateFilters(patch: Partial<ContactsFilters>): void {
    onFiltersChange?.({ ...filters, ...patch });
  }

  const writeDisabled = !canWrite;

  return (
    <div style={containerStyle} data-testid="contacts-table-container">
      <div style={barStyle}>
        <div style={filterRowStyle}>
          <input
            type="text"
            placeholder="Search name or address..."
            value={filters.search ?? ""}
            onChange={(e) => updateFilters({ search: e.target.value })}
            style={inputStyle}
            aria-label="Search contacts"
            data-testid="filter-search"
          />
          <select
            value={filters.type ?? ""}
            onChange={(e) => updateFilters({ type: (e.target.value || undefined) as ContactsFilters["type"] })}
            style={selectStyle}
            aria-label="Filter by type"
            data-testid="filter-type"
          >
            <option value="">All types</option>
            <option value="mailContact">Mail contact</option>
            <option value="mailUser">Mail user</option>
          </select>
          <select
            value={filters.hidden ?? ""}
            onChange={(e) => updateFilters({ hidden: e.target.value as ContactsFilters["hidden"] })}
            style={selectStyle}
            aria-label="Filter by hidden from GAL"
            data-testid="filter-hidden"
          >
            <option value="">GAL: any</option>
            <option value="hidden">Hidden from GAL</option>
            <option value="visible">Visible in GAL</option>
          </select>
        </div>
        {onImport && (
          <button
            type="button"
            style={primaryButtonStyle}
            onClick={onImport}
            data-testid="contacts-import-button"
          >
            Import CSV
          </button>
        )}
      </div>

      {error && (
        <div
          role="alert"
          style={{
            padding: "12px 16px",
            borderRadius: "6px",
            background: "var(--danger-soft)",
            border: "1px solid var(--danger)",
            color: "var(--danger-text)",
            fontSize: "14px",
          }}
          data-testid="contacts-error"
        >
          {error}
        </div>
      )}

      <div style={tableWrapperStyle}>
        <table style={tableStyle} aria-label="Contacts" data-testid="contacts-table">
          <thead>
            <tr>
              <th style={thStyle}>Display name</th>
              <th style={thStyle}>External address</th>
              <th style={thStyle}>Type</th>
              <th style={thStyle}>Hidden from GAL</th>
              <th style={thStyle}>Last modified</th>
              <th style={thStyle}>Actions</th>
            </tr>
          </thead>
          <tbody>
            {loading ? (
              <tr>
                <td style={tdStyle} colSpan={6} data-testid="contacts-loading">
                  Loading contacts…
                </td>
              </tr>
            ) : contacts.length === 0 ? (
              <tr>
                <td style={tdStyle} colSpan={6} data-testid="empty-contacts-state">
                  No contacts found.
                </td>
              </tr>
            ) : (
              contacts.map((contact) => (
                <tr key={contact.id} data-testid={`contact-row-${contact.id}`}>
                  <td style={tdStyle}>{contact.displayName ?? "—"}</td>
                  <td style={{ ...tdStyle, fontFamily: "var(--font-mono, monospace)", fontSize: "13px" }}>
                    {contact.externalAddress ?? "—"}
                  </td>
                  <td style={tdStyle}>{contactTypeLabel(contact.type)}</td>
                  <td style={tdStyle}>
                    {contact.hiddenFromGal ? (
                      <span style={badgeStyle("warn")} data-testid={`contact-hidden-badge-${contact.id}`}>
                        Hidden
                      </span>
                    ) : (
                      <span style={badgeStyle("muted")}>Visible</span>
                    )}
                  </td>
                  <td style={tdStyle}>{formatLastModified(contact.lastModified)}</td>
                  <td style={tdStyle}>
                    <div style={{ display: "flex", gap: "6px", flexWrap: "wrap" }}>
                      <button
                        type="button"
                        style={actionBtnStyle}
                        onClick={() => onAction?.("view", contact)}
                        aria-label={`View ${contact.displayName ?? contact.externalAddress ?? contact.id}`}
                        data-testid={`contact-view-${contact.id}`}
                      >
                        View
                      </button>
                      <button
                        type="button"
                        style={writeDisabled ? disabledActionBtnStyle : actionBtnStyle}
                        disabled={writeDisabled}
                        title={writeDisabled ? "Requires contacts.write permission" : undefined}
                        onClick={() => onAction?.("edit", contact)}
                        aria-label={`Edit ${contact.displayName ?? contact.externalAddress ?? contact.id}`}
                        data-testid={`contact-edit-${contact.id}`}
                      >
                        Edit
                      </button>
                      <button
                        type="button"
                        style={writeDisabled ? disabledActionBtnStyle : actionBtnStyle}
                        disabled={writeDisabled}
                        title={writeDisabled ? "Requires contacts.write permission" : undefined}
                        onClick={() => onAction?.("hideFromGal", contact)}
                        aria-label={`${contact.hiddenFromGal ? "Show in GAL" : "Hide from GAL"} ${contact.displayName ?? contact.externalAddress ?? contact.id}`}
                        data-testid={`contact-hide-${contact.id}`}
                      >
                        {contact.hiddenFromGal ? "Show in GAL" : "Hide from GAL"}
                      </button>
                      <button
                        type="button"
                        style={actionBtnStyle}
                        onClick={() => onAction?.("cloneToTemplate", contact)}
                        aria-label={`Clone ${contact.displayName ?? contact.externalAddress ?? contact.id} to template`}
                        data-testid={`contact-clone-${contact.id}`}
                      >
                        Clone to template
                      </button>
                      <button
                        type="button"
                        style={writeDisabled ? disabledActionBtnStyle : actionBtnStyle}
                        disabled={writeDisabled}
                        title={writeDisabled ? "Requires contacts.write permission" : undefined}
                        onClick={() => onAction?.("delete", contact)}
                        aria-label={`Delete ${contact.displayName ?? contact.externalAddress ?? contact.id}`}
                        data-testid={`contact-delete-${contact.id}`}
                      >
                        Delete
                      </button>
                    </div>
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
