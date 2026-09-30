"use client";

// Mailbox permissions table (EPIC-027 SPEC.md §3.5; T-0529).
// Read-only render of the §3.3 mailbox and calendar permission rows — principal,
// access rights, automap, inherited — flattened across the tenant's mailboxes.
// No fetches and no write controls here; the page owns the read.

import type { CSSProperties, ReactElement } from "react";

export type MailboxPermissionReportScope = "mailbox" | "calendar";

export interface MailboxPermissionReportEntry {
  readonly mailboxId: string;
  readonly mailboxDisplayName: string | null;
  readonly mailboxPrimarySmtp: string;
  readonly scope: MailboxPermissionReportScope;
  readonly permissionType: "FullAccess" | "SendAs" | "SendOnBehalf" | "Calendar";
  readonly principal: string;
  readonly accessRights: readonly string[];
  readonly automap: boolean;
  readonly inherited: boolean;
}

export interface MailboxPermissionsTableProps {
  readonly items: readonly MailboxPermissionReportEntry[];
  readonly loading?: boolean;
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

const scopeStyle: CSSProperties = {
  display: "inline-block",
  padding: "2px 8px",
  borderRadius: "999px",
  fontSize: "12px",
  fontWeight: 600,
  background: "var(--surface)",
  border: "1px solid var(--border)",
  color: "var(--text-soft)",
};

export function MailboxPermissionsTable({ items, loading = false }: MailboxPermissionsTableProps): ReactElement {
  return (
    <div style={{ overflowX: "auto" }}>
      <table style={tableStyle} data-testid="mailbox-permissions-table">
        <thead>
          <tr>
            <th style={thStyle}>Mailbox</th>
            <th style={thStyle}>Scope</th>
            <th style={thStyle}>Principal</th>
            <th style={thStyle}>Access rights</th>
            <th style={thStyle}>Automap</th>
            <th style={thStyle}>Inherited</th>
          </tr>
        </thead>
        <tbody>
          {loading ? (
            <tr><td style={tdStyle} colSpan={6}>Loading permissions…</td></tr>
          ) : items.length === 0 ? (
            <tr><td style={tdStyle} colSpan={6}>No mailbox or calendar permissions found.</td></tr>
          ) : (
            items.map((entry) => (
              <tr key={`${entry.mailboxId}:${entry.scope}:${entry.permissionType}:${entry.principal}`} data-testid={`mailbox-permission-row-${entry.mailboxId}`}>
                <td style={tdStyle}>
                  <div>{entry.mailboxDisplayName ?? entry.mailboxPrimarySmtp}</div>
                  <div style={{ fontFamily: "var(--font-mono, monospace)", fontSize: "12px", color: "var(--text-soft)" }}>
                    {entry.mailboxPrimarySmtp}
                  </div>
                </td>
                <td style={tdStyle}>
                  <span style={scopeStyle} data-testid={`mailbox-permission-scope-${entry.mailboxId}`}>{entry.scope}</span>
                  <div style={{ fontSize: "12px", color: "var(--text-soft)" }}>{entry.permissionType}</div>
                </td>
                <td style={{ ...tdStyle, fontFamily: "var(--font-mono, monospace)", fontSize: "13px" }}>{entry.principal}</td>
                <td style={tdStyle}>{entry.accessRights.join(", ")}</td>
                <td style={tdStyle}>{entry.automap ? "Yes" : "No"}</td>
                <td style={tdStyle}>{entry.inherited ? "Yes" : "No"}</td>
              </tr>
            ))
          )}
        </tbody>
      </table>
    </div>
  );
}
