"use client";

// Mailbox permissions report (EPIC-027 SPEC.md §2 US-5, §3.5; T-0529).
// Nav: Teams & SharePoint → Sharing → Mailbox Permissions. Read-only render of
// the §3.3 mailbox and calendar permission tables (principal, access rights,
// automap, inherited) flattened across the tenant's mailboxes, with scope and
// search filters and cursor pagination. Every read goes through the BFF
// (GET /v1/tenants/:id/mailbox-permissions); no browser call reaches a tenant
// directly and this page performs no writes.

import React, { useCallback, useEffect, useState, type CSSProperties, type ReactElement } from "react";
import { useSearchParams } from "next/navigation";
import { RequireTenant } from "../../../components/shell/RequireTenant";
import { resolveTenantId, useCurrentTenantId } from "../../../lib/useCurrentTenant";
import {
  MailboxPermissionsTable,
  type MailboxPermissionReportEntry,
  type MailboxPermissionReportScope,
} from "../../../components/sharing/MailboxPermissionsTable";

export interface MailboxPermissionsFilter {
  readonly scope?: MailboxPermissionReportScope | "";
  readonly search?: string;
}

export type Fetcher = typeof fetch;

/** Builds the BFF query string for GET /v1/tenants/:id/mailbox-permissions. */
export function buildMailboxPermissionsQuery(filter: MailboxPermissionsFilter, limit = 100): string {
  const params = new URLSearchParams();
  if (filter.scope) params.set("scope", filter.scope);
  if (filter.search) params.set("search", filter.search);
  params.set("limit", String(limit));
  return `?${params.toString()}`;
}

async function readError(response: Response, fallback: string): Promise<Error> {
  let detail = fallback;
  try {
    const body = (await response.json()) as { message?: string };
    if (body?.message) detail = body.message;
  } catch {
    detail = `${fallback}: HTTP ${response.status}`;
  }
  return new Error(detail);
}

export async function listMailboxPermissions(
  tenantId: string,
  filter: MailboxPermissionsFilter,
  cursor: string | null,
  fetcher: Fetcher = fetch,
): Promise<{ items: MailboxPermissionReportEntry[]; nextCursor: string | null; totalCount: number }> {
  const params = new URLSearchParams(buildMailboxPermissionsQuery(filter).slice(1));
  if (cursor) params.set("cursor", cursor);
  const response = await fetcher(`/v1/tenants/${encodeURIComponent(tenantId)}/mailbox-permissions?${params.toString()}`);
  if (!response.ok) throw await readError(response, "List mailbox permissions");
  const body = (await response.json()) as {
    items?: MailboxPermissionReportEntry[];
    nextCursor?: string | null;
    totalCount?: number;
  };
  return {
    items: [...(body.items ?? [])],
    nextCursor: body.nextCursor ?? null,
    totalCount: body.totalCount ?? 0,
  };
}

const pageStyle: CSSProperties = {
  padding: "24px",
  maxWidth: "1400px",
  margin: "0 auto",
  display: "flex",
  flexDirection: "column",
  gap: "20px",
  fontFamily: "var(--font-sans, system-ui, sans-serif)",
  color: "var(--text)",
};

const inputStyle: CSSProperties = {
  padding: "8px 12px",
  background: "var(--input-bg, var(--bg))",
  border: "1px solid var(--border)",
  borderRadius: "6px",
  color: "var(--text)",
  fontSize: "14px",
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

const disabledStyle: CSSProperties = { opacity: 0.45, cursor: "not-allowed" };

export interface MailboxPermissionsViewProps {
  readonly tenantId: string;
  readonly fetcher?: Fetcher;
}

export function MailboxPermissionsView({ tenantId, fetcher = fetch }: MailboxPermissionsViewProps): ReactElement {
  const [filter, setFilter] = useState<MailboxPermissionsFilter>({});
  const [items, setItems] = useState<MailboxPermissionReportEntry[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [totalCount, setTotalCount] = useState(0);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const fetchPage = useCallback(
    async (next: MailboxPermissionsFilter, cursor: string | null, append: boolean): Promise<void> => {
      if (append) {
        setLoadingMore(true);
      } else {
        setLoading(true);
      }
      setError(null);
      try {
        const page = await listMailboxPermissions(tenantId, next, cursor, fetcher);
        setItems((prev) => (append ? [...prev, ...page.items] : page.items));
        setNextCursor(page.nextCursor);
        setTotalCount(page.totalCount);
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        setLoading(false);
        setLoadingMore(false);
      }
    },
    [tenantId, fetcher],
  );

  useEffect(() => {
    void fetchPage(filter, null, false);
  }, [tenantId, fetchPage, filter]);

  function setFilterField<K extends keyof MailboxPermissionsFilter>(key: K, value: MailboxPermissionsFilter[K]): void {
    setFilter((prev) => ({ ...prev, [key]: value }));
  }

  return (
    <div style={pageStyle} data-testid="mailbox-permissions-page">
      <div>
        <div style={{ fontSize: "12px", color: "var(--text-soft)" }}>Teams &amp; SharePoint &gt; Sharing &gt; Mailbox Permissions</div>
        <h1 style={{ fontSize: "24px", fontWeight: 700, margin: "4px 0 0", fontFamily: "var(--font-display, var(--font-sans))" }}>
          Mailbox Permissions
        </h1>
        <p style={{ margin: "4px 0 0", color: "var(--text-soft)", fontSize: "14px" }}>
          Read-only mailbox and calendar permission report across every tenant mailbox.
        </p>
      </div>

      <div style={{ display: "flex", gap: "8px", flexWrap: "wrap" }} data-testid="mailbox-permissions-filters">
        <input
          type="text"
          placeholder="Search mailbox or principal..."
          value={filter.search ?? ""}
          onChange={(e) => setFilterField("search", e.target.value || undefined)}
          style={inputStyle}
          aria-label="Search mailbox permissions"
          data-testid="mailbox-permissions-search"
        />
        <select
          value={filter.scope ?? ""}
          onChange={(e) => setFilterField("scope", (e.target.value || undefined) as MailboxPermissionsFilter["scope"])}
          style={inputStyle}
          aria-label="Filter by scope"
          data-testid="mailbox-permissions-filter-scope"
        >
          <option value="">All scopes</option>
          <option value="mailbox">Mailbox</option>
          <option value="calendar">Calendar</option>
        </select>
      </div>

      {error && (
        <div role="alert" style={{ padding: "12px 16px", borderRadius: "6px", background: "var(--danger-soft)", border: "1px solid var(--danger)", color: "var(--danger-text)", fontSize: "14px" }} data-testid="mailbox-permissions-error">
          {error}
        </div>
      )}

      <div data-testid="mailbox-permissions-count" style={{ fontSize: "13px", color: "var(--text-soft)" }}>
        {totalCount} permission {totalCount === 1 ? "entry" : "entries"}
      </div>

      <MailboxPermissionsTable items={items} loading={loading} />

      {nextCursor && (
        <div>
          <button
            type="button"
            style={loadingMore ? { ...buttonStyle, ...disabledStyle } : buttonStyle}
            disabled={loadingMore}
            onClick={() => void fetchPage(filter, nextCursor, true)}
            data-testid="mailbox-permissions-load-more"
          >
            {loadingMore ? "Loading…" : "Load more"}
          </button>
        </div>
      )}
    </div>
  );
}

export default function MailboxPermissionsPage(): ReactElement {
  const searchParams = useSearchParams();
  const tenantId = resolveTenantId(searchParams.get("tenantId"), useCurrentTenantId());
  return (
    <RequireTenant tenantId={tenantId}>
      <MailboxPermissionsView tenantId={tenantId} />
    </RequireTenant>
  );
}
