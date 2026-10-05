"use client";

// Mailbox and mail-flow reports (EPIC-020 SPEC.md §3.7, §6; T-0381, T-0850).
// Nav: Email & Exchange → Reports. One tab per report served by
// GET /v1/tenants/:id/mailbox-reports?report= — mailbox statistics, activity,
// permissions, calendar permissions, forwarding, and mail-flow statistics.
// Every row comes from the BFF read API (live EXO via the report workers); this
// page holds no sample data. A report the BFF answers with 501 (no worker backs
// it yet, today the mail-flow report) is shown as "not available", never as an
// empty table. No browser call reaches a tenant directly.

import React, { useCallback, useEffect, useRef, useState, type CSSProperties, type ReactElement } from "react";
import { useSearchParams } from "next/navigation";
import { RequireTenant } from "../../../../components/shell/RequireTenant";
import { resolveTenantId, useCurrentTenantId } from "../../../../lib/useCurrentTenant";
import type { Fetcher } from "../page";

export const MAILBOX_REPORT_NAMES = [
  "statistics",
  "activity",
  "permissions",
  "calendarPermissions",
  "forwarding",
  "mailflow",
] as const;
export type MailboxReportName = (typeof MAILBOX_REPORT_NAMES)[number];

export const MAILBOX_REPORT_TITLES: Readonly<Record<MailboxReportName, string>> = {
  statistics: "Mailbox statistics",
  activity: "Mailbox activity",
  permissions: "Mailbox permissions",
  calendarPermissions: "Calendar permissions",
  forwarding: "Forwarding",
  mailflow: "Mail-flow statistics",
};

export interface ReportColumn {
  readonly key: string;
  readonly label: string;
}

/** Columns per report, matching the row shapes the BFF adapter projects (adapters/mailboxes.ts). */
export const MAILBOX_REPORT_COLUMNS: Readonly<Record<MailboxReportName, readonly ReportColumn[]>> = {
  statistics: [
    { key: "displayName", label: "Display name" },
    { key: "primarySmtpAddress", label: "Primary SMTP" },
    { key: "type", label: "Type" },
    { key: "quotaUsed", label: "Quota used" },
    { key: "quotaPercent", label: "Quota %" },
    { key: "archive", label: "Archive" },
    { key: "hold", label: "Hold" },
  ],
  activity: [
    { key: "displayName", label: "Display name" },
    { key: "primarySmtpAddress", label: "Primary SMTP" },
    { key: "lastActivity", label: "Last activity" },
  ],
  permissions: [
    { key: "mailboxDisplayName", label: "Mailbox" },
    { key: "mailboxPrimarySmtp", label: "Primary SMTP" },
    { key: "permissionType", label: "Permission" },
    { key: "principal", label: "Principal" },
    { key: "accessRights", label: "Access rights" },
    { key: "automap", label: "Automap" },
    { key: "inherited", label: "Inherited" },
  ],
  calendarPermissions: [
    { key: "mailboxDisplayName", label: "Mailbox" },
    { key: "mailboxPrimarySmtp", label: "Primary SMTP" },
    { key: "principal", label: "Principal" },
    { key: "accessRights", label: "Access rights" },
  ],
  forwarding: [
    { key: "displayName", label: "Display name" },
    { key: "primarySmtpAddress", label: "Primary SMTP" },
    { key: "forwarding", label: "Forwarding" },
    { key: "forwardingTo", label: "Forwards to" },
    { key: "deliverToMailboxAndForward", label: "Keeps a copy" },
  ],
  mailflow: [],
};

export interface MailboxReportPage {
  readonly tenantId: string;
  readonly report: MailboxReportName;
  readonly rows: readonly Record<string, unknown>[];
  readonly nextCursor: string | null;
  readonly retrievedAt: string;
}

/** The BFF answered 501: no worker backs this report yet. */
export class ReportUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ReportUnavailableError";
  }
}

export interface MailboxReportQuery {
  readonly cursor?: string | null;
  readonly search?: string;
  readonly limit?: number;
}

export function buildMailboxReportQuery(report: MailboxReportName, query: MailboxReportQuery = {}): string {
  const params = new URLSearchParams({ report });
  if (query.search) params.set("search", query.search);
  if (query.cursor) params.set("cursor", query.cursor);
  params.set("limit", String(query.limit ?? 100));
  return `?${params.toString()}`;
}

export async function fetchMailboxReport(
  tenantId: string,
  report: MailboxReportName,
  query: MailboxReportQuery = {},
  fetcher: Fetcher = fetch,
): Promise<MailboxReportPage> {
  const response = await fetcher(
    `/v1/tenants/${encodeURIComponent(tenantId)}/mailbox-reports${buildMailboxReportQuery(report, query)}`,
  );
  if (!response.ok) {
    let detail = `Load ${MAILBOX_REPORT_TITLES[report]} failed: HTTP ${response.status}`;
    try {
      const body = (await response.json()) as { message?: string };
      if (body?.message) detail = body.message;
    } catch {
      // Keep the status-only message.
    }
    if (response.status === 501) throw new ReportUnavailableError(detail);
    throw new Error(detail);
  }
  const body = (await response.json()) as Partial<MailboxReportPage>;
  return {
    tenantId: body.tenantId ?? tenantId,
    report,
    rows: [...(body.rows ?? [])],
    nextCursor: body.nextCursor ?? null,
    retrievedAt: body.retrievedAt ?? "",
  };
}

/** Renders one cell value: booleans as Yes/No, lists joined, missing values as a dash. */
export function formatReportCell(value: unknown): string {
  if (value === null || value === undefined || value === "") return "—";
  if (typeof value === "boolean") return value ? "Yes" : "No";
  if (Array.isArray(value)) return value.length === 0 ? "—" : value.map((entry) => String(entry)).join(", ");
  return String(value);
}

const pageStyle: CSSProperties = {
  padding: "24px",
  maxWidth: "1200px",
  margin: "0 auto",
  display: "flex",
  flexDirection: "column",
  gap: "20px",
  fontFamily: "var(--font-sans, system-ui, sans-serif)",
  color: "var(--text)",
};

const cardStyle: CSSProperties = {
  background: "var(--surface)",
  border: "1px solid var(--border)",
  borderRadius: "var(--radius, 10px)",
  padding: "20px",
  display: "flex",
  flexDirection: "column",
  gap: "12px",
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

const activeTabStyle: CSSProperties = {
  ...buttonStyle,
  background: "var(--accent)",
  color: "var(--on-accent)",
  borderColor: "var(--accent)",
};

const inputStyle: CSSProperties = {
  padding: "8px 12px",
  background: "var(--input-bg, var(--bg))",
  border: "1px solid var(--border)",
  borderRadius: "6px",
  color: "var(--text)",
  fontSize: "14px",
};

const tableStyle: CSSProperties = { width: "100%", borderCollapse: "collapse", fontSize: "14px" };
const thStyle: CSSProperties = {
  textAlign: "left",
  padding: "10px 12px",
  borderBottom: "1px solid var(--border-strong, var(--border))",
  color: "var(--text-soft)",
  fontSize: "12px",
  textTransform: "uppercase",
  letterSpacing: "0.07em",
};
const tdStyle: CSSProperties = { padding: "10px 12px", borderBottom: "1px solid var(--border)" };

export interface MailboxReportsViewProps {
  readonly tenantId: string;
  readonly initialReport?: MailboxReportName;
  readonly fetcher?: Fetcher;
}

export function MailboxReportsView({
  tenantId,
  initialReport = "statistics",
  fetcher = fetch,
}: MailboxReportsViewProps): ReactElement {
  const [report, setReport] = useState<MailboxReportName>(initialReport);
  const [search, setSearch] = useState("");
  const [rows, setRows] = useState<readonly Record<string, unknown>[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [retrievedAt, setRetrievedAt] = useState("");
  const [loading, setLoading] = useState(true);
  const [unavailable, setUnavailable] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Only the latest request may write state, so a slow response for a previous tab cannot overwrite the current one.
  const latest = useRef(0);

  const load = useCallback(
    async (cursor: string | null): Promise<void> => {
      const request = ++latest.current;
      setLoading(true);
      setError(null);
      if (cursor === null) setUnavailable(null);
      try {
        const page = await fetchMailboxReport(tenantId, report, { cursor, search: search.trim() }, fetcher);
        if (request !== latest.current) return;
        setRows((previous) => (cursor === null ? page.rows : [...previous, ...page.rows]));
        setNextCursor(page.nextCursor);
        setRetrievedAt(page.retrievedAt);
      } catch (err) {
        if (request !== latest.current) return;
        if (cursor === null) {
          setRows([]);
          setNextCursor(null);
          setRetrievedAt("");
        }
        if (err instanceof ReportUnavailableError) setUnavailable(err.message);
        else setError(err instanceof Error ? err.message : String(err));
      } finally {
        if (request === latest.current) setLoading(false);
      }
    },
    [tenantId, report, search, fetcher],
  );

  useEffect(() => {
    void load(null);
  }, [load]);

  const columns = MAILBOX_REPORT_COLUMNS[report];

  return (
    <div style={pageStyle} data-testid="mailbox-reports-page">
      <div>
        <div style={{ fontSize: "12px", color: "var(--text-soft)" }}>Email &amp; Exchange &gt; Reports &gt; Mailbox Reports</div>
        <h1 style={{ fontSize: "24px", fontWeight: 700, margin: "4px 0 0" }}>Mailbox Reports</h1>
        <p style={{ margin: "4px 0 0", color: "var(--text-soft)", fontSize: "14px" }}>
          Read live from Exchange Online for the selected tenant.
        </p>
      </div>

      <div role="tablist" aria-label="Mailbox reports" style={{ display: "flex", gap: "8px", flexWrap: "wrap" }}>
        {MAILBOX_REPORT_NAMES.map((name) => (
          <button
            key={name}
            type="button"
            role="tab"
            aria-selected={name === report}
            style={name === report ? activeTabStyle : buttonStyle}
            onClick={() => { setRows([]); setNextCursor(null); setReport(name); }}
            data-testid={`mailbox-report-tab-${name}`}
          >
            {MAILBOX_REPORT_TITLES[name]}
          </button>
        ))}
      </div>

      <section style={cardStyle} aria-label={MAILBOX_REPORT_TITLES[report]} data-testid="mailbox-report-card">
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: "12px", flexWrap: "wrap" }}>
          <h2 style={{ margin: 0, fontSize: "16px" }}>{MAILBOX_REPORT_TITLES[report]}</h2>
          {report !== "mailflow" && (
            <input
              type="search"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search"
              aria-label="Search report"
              style={inputStyle}
              data-testid="mailbox-report-search"
            />
          )}
        </div>

        {loading && <p data-testid="mailbox-report-loading">Loading report…</p>}
        {unavailable && (
          <div role="status" style={{ color: "var(--text-soft)", fontSize: "14px" }} data-testid="mailbox-report-unavailable">
            <strong>Not available.</strong> {unavailable}
          </div>
        )}
        {error && (
          <div role="alert" style={{ color: "var(--danger-text)" }} data-testid="mailbox-report-error">
            {error}
          </div>
        )}

        {!unavailable && !error && (
          <div style={{ overflowX: "auto" }}>
            <table style={tableStyle} data-testid="mailbox-report-table">
              <thead>
                <tr>
                  {columns.map((column) => (
                    <th key={column.key} style={thStyle}>{column.label}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {rows.length === 0 && !loading ? (
                  <tr>
                    <td style={tdStyle} colSpan={Math.max(columns.length, 1)} data-testid="mailbox-report-empty">
                      No rows returned.
                    </td>
                  </tr>
                ) : (
                  rows.map((row, index) => (
                    <tr key={index} data-testid={`mailbox-report-row-${index}`}>
                      {columns.map((column) => (
                        <td key={column.key} style={tdStyle}>{formatReportCell(row[column.key])}</td>
                      ))}
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        )}

        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", fontSize: "13px", color: "var(--text-soft)" }}>
          <span data-testid="mailbox-report-retrieved">{retrievedAt ? `Retrieved ${retrievedAt}` : ""}</span>
          {nextCursor && (
            <button type="button" style={buttonStyle} disabled={loading} onClick={() => void load(nextCursor)} data-testid="mailbox-report-more">
              Load more
            </button>
          )}
        </div>
      </section>
    </div>
  );
}

export default function MailboxReportsPage(): ReactElement {
  const searchParams = useSearchParams();
  const tenantId = resolveTenantId(searchParams.get("tenantId"), useCurrentTenantId());
  return (
    <RequireTenant tenantId={tenantId}>
      <MailboxReportsView tenantId={tenantId} />
    </RequireTenant>
  );
}
