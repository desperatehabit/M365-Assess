"use client";

// Permissions Report page (EPIC-027 SPEC.md §2 US-2, §3.2, §6; T-0524).
// Page title "Permissions Report": reads the §3.2 permission rows live from
// the T-0523 API (GET /v1/tenants/:id/sharing/permissions) with the §3.2
// filters (role, principal type) pushed to the worker, renders
// PermissionsTable, and is strictly read-only — the page offers no mutation
// controls and issues no writes. Nav/breadcrumb follows
// Teams & SharePoint → Permissions Report (SPEC §3).

import React, { useCallback, useEffect, useState, type CSSProperties, type ReactElement } from "react";
import { useSearchParams } from "next/navigation";
import { RequireTenant } from "../../../components/shell/RequireTenant";
import { resolveTenantId, useCurrentTenantId } from "../../../lib/useCurrentTenant";
import {
  PermissionsTable,
  type PermissionsPrincipalType,
  type PermissionsReportItem,
} from "../../../components/sharing/PermissionsTable";

export interface PermissionsFilter {
  readonly role?: string;
  readonly principalType?: PermissionsPrincipalType;
}

export type Fetcher = typeof fetch;

/** Builds the BFF query string for GET /v1/tenants/:id/sharing/permissions (T-0523 filters). */
export function buildPermissionsQuery(filter: PermissionsFilter, cursor: string | null, limit = 100): string {
  const params = new URLSearchParams();
  if (filter.role) params.set("role", filter.role);
  if (filter.principalType) params.set("principalType", filter.principalType);
  if (cursor) params.set("cursor", cursor);
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

export async function fetchPermissionsReport(
  tenantId: string,
  filter: PermissionsFilter,
  cursor: string | null,
  fetcher: Fetcher = fetch,
): Promise<{ items: PermissionsReportItem[]; nextCursor: string | null; totalCount: number }> {
  const response = await fetcher(
    `/v1/tenants/${encodeURIComponent(tenantId)}/sharing/permissions${buildPermissionsQuery(filter, cursor)}`,
    { method: "GET", headers: { Accept: "application/json" } },
  );
  if (!response.ok) throw await readError(response, "List permissions report");
  const body = (await response.json()) as {
    items?: readonly PermissionsReportItem[];
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

const filterBarStyle: CSSProperties = {
  display: "flex",
  flexWrap: "wrap",
  gap: "10px",
  alignItems: "center",
  padding: "12px 16px",
  background: "var(--bg-elev)",
  border: "1px solid var(--border)",
  borderRadius: "var(--radius, 10px)",
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

const disabledStyle: CSSProperties = { opacity: 0.45, cursor: "not-allowed" };

export interface PermissionsReportViewProps {
  readonly tenantId: string;
  readonly fetcher?: Fetcher;
}

export function PermissionsReportView({ tenantId, fetcher = fetch }: PermissionsReportViewProps): ReactElement {
  const [filter, setFilter] = useState<PermissionsFilter>({});
  const [items, setItems] = useState<PermissionsReportItem[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [totalCount, setTotalCount] = useState(0);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const fetchPage = useCallback(
    async (target: PermissionsFilter, cursor: string | null, append: boolean): Promise<void> => {
      if (append) {
        setLoadingMore(true);
      } else {
        setLoading(true);
      }
      setError(null);
      try {
        const page = await fetchPermissionsReport(tenantId, target, cursor, fetcher);
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
  }, [tenantId, filter, fetchPage]);

  return (
    <div style={pageStyle} data-testid="permissions-report-page">
      <div>
        <div style={{ fontSize: "12px", color: "var(--text-soft)" }} data-testid="permissions-breadcrumb">
          Teams &amp; SharePoint &gt; Permissions Report
        </div>
        <h1
          style={{ fontSize: "24px", fontWeight: 700, margin: "4px 0 0", fontFamily: "var(--font-display, var(--font-sans))" }}
        >
          Permissions Report
        </h1>
        <p style={{ margin: "4px 0 0", color: "var(--text-soft)", fontSize: "14px" }}>
          Read-only site and OneDrive permissions across the tenant. Filters apply through the API; this page offers no
          mutation controls.
        </p>
      </div>

      <div style={filterBarStyle} data-testid="permissions-filters">
        <input
          type="text"
          placeholder="Role (e.g. owner, read, write)..."
          value={filter.role ?? ""}
          onChange={(e) => setFilter((prev) => ({ ...prev, role: e.target.value || undefined }))}
          style={inputStyle}
          aria-label="Filter by role"
          data-testid="filter-role"
        />
        <select
          aria-label="Filter by principal type"
          data-testid="filter-principal-type"
          value={filter.principalType ?? ""}
          onChange={(e) =>
            setFilter((prev) => ({
              ...prev,
              principalType: (e.target.value || undefined) as PermissionsPrincipalType | undefined,
            }))
          }
          style={selectStyle}
        >
          <option value="">All principal types</option>
          <option value="user">User</option>
          <option value="group">Group</option>
          <option value="servicePrincipal">Service principal</option>
        </select>
        <span style={{ fontSize: "13px", color: "var(--text-soft)" }} data-testid="permissions-count">
          {totalCount} permission {totalCount === 1 ? "entry" : "entries"}
        </span>
      </div>

      <PermissionsTable items={items} loading={loading} error={error} />

      {nextCursor && (
        <div>
          <button
            type="button"
            style={loadingMore ? { ...buttonStyle, ...disabledStyle } : buttonStyle}
            disabled={loadingMore}
            onClick={() => void fetchPage(filter, nextCursor, true)}
            data-testid="permissions-load-more"
          >
            {loadingMore ? "Loading..." : "Load more"}
          </button>
        </div>
      )}
    </div>
  );
}

export default function PermissionsReportPage(): ReactElement {
  const searchParams = useSearchParams();
  const tenantId = resolveTenantId(searchParams.get("tenantId"), useCurrentTenantId());
  return (
    <RequireTenant tenantId={tenantId}>
      <PermissionsReportView tenantId={tenantId} />
    </RequireTenant>
  );
}
