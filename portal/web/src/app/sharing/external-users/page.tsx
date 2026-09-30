"use client";

// SharePoint external users page (EPIC-027 SPEC.md §2 US-3, §3.3; T-0525).
// Nav: Teams & SharePoint → Sharing → SharePoint External Users. Read-only
// render of the §3.3 columns (External user, Email, Sites, Last access,
// Invited by) with cursor pagination and per-user drill-through to the
// sites/items they can access. Every read goes through the BFF
// (GET /v1/tenants/:id/sharing/external-users and its /access drill-through);
// no browser call reaches a tenant directly and this page performs no writes.

import React, { useCallback, useEffect, useState, type CSSProperties, type ReactElement } from "react";
import { useSearchParams } from "next/navigation";
import { RequireTenant } from "../../../components/shell/RequireTenant";
import { resolveTenantId, useCurrentTenantId } from "../../../lib/useCurrentTenant";
import {
  ExternalUsersTable,
  type ExternalUserAccessItem,
  type ExternalUserItem,
} from "../../../components/sharing/ExternalUsersTable";

export interface ExternalUsersFilter {
  readonly search?: string;
}

export type Fetcher = typeof fetch;

/** Builds the BFF query string for GET /v1/tenants/:id/sharing/external-users. */
export function buildExternalUsersQuery(filter: ExternalUsersFilter, limit = 100): string {
  const params = new URLSearchParams();
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

export async function listExternalUsers(
  tenantId: string,
  filter: ExternalUsersFilter,
  cursor: string | null,
  fetcher: Fetcher = fetch,
): Promise<{ items: ExternalUserItem[]; nextCursor: string | null; totalCount: number }> {
  const params = new URLSearchParams(buildExternalUsersQuery(filter).slice(1));
  if (cursor) params.set("cursor", cursor);
  const response = await fetcher(
    `/v1/tenants/${encodeURIComponent(tenantId)}/sharing/external-users?${params.toString()}`,
  );
  if (!response.ok) throw await readError(response, "List external users");
  const body = (await response.json()) as {
    items?: ExternalUserItem[];
    nextCursor?: string | null;
    totalCount?: number;
  };
  return {
    items: [...(body.items ?? [])],
    nextCursor: body.nextCursor ?? null,
    totalCount: body.totalCount ?? 0,
  };
}

export async function listExternalUserAccess(
  tenantId: string,
  externalUserId: string,
  fetcher: Fetcher = fetch,
): Promise<ExternalUserAccessItem[]> {
  const response = await fetcher(
    `/v1/tenants/${encodeURIComponent(tenantId)}/sharing/external-users/${encodeURIComponent(externalUserId)}/access`,
  );
  if (!response.ok) throw await readError(response, "List external user access");
  const body = (await response.json()) as { items?: ExternalUserAccessItem[] };
  return [...(body.items ?? [])];
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

export interface ExternalUsersViewProps {
  readonly tenantId: string;
  readonly fetcher?: Fetcher;
}

export function ExternalUsersView({ tenantId, fetcher = fetch }: ExternalUsersViewProps): ReactElement {
  const [filter, setFilter] = useState<ExternalUsersFilter>({});
  const [items, setItems] = useState<ExternalUserItem[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [totalCount, setTotalCount] = useState(0);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selectedExternalUserId, setSelectedExternalUserId] = useState<string | null>(null);
  const [access, setAccess] = useState<ExternalUserAccessItem[]>([]);
  const [accessLoading, setAccessLoading] = useState(false);
  const [accessError, setAccessError] = useState<string | null>(null);

  const fetchPage = useCallback(
    async (next: ExternalUsersFilter, cursor: string | null, append: boolean): Promise<void> => {
      if (append) {
        setLoadingMore(true);
      } else {
        setLoading(true);
      }
      setError(null);
      try {
        const page = await listExternalUsers(tenantId, next, cursor, fetcher);
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

  async function handleSelect(user: ExternalUserItem): Promise<void> {
    if (selectedExternalUserId === user.externalUserId) {
      setSelectedExternalUserId(null);
      setAccess([]);
      return;
    }
    setSelectedExternalUserId(user.externalUserId);
    setAccess([]);
    setAccessLoading(true);
    setAccessError(null);
    try {
      setAccess(await listExternalUserAccess(tenantId, user.externalUserId, fetcher));
    } catch (err) {
      setAccess([]);
      setAccessError(err instanceof Error ? err.message : String(err));
    } finally {
      setAccessLoading(false);
    }
  }

  return (
    <div style={pageStyle} data-testid="external-users-page">
      <div>
        <div style={{ fontSize: "12px", color: "var(--text-soft)" }}>
          Teams &amp; SharePoint &gt; Sharing &gt; SharePoint External Users
        </div>
        <h1 style={{ fontSize: "24px", fontWeight: 700, margin: "4px 0 0", fontFamily: "var(--font-display, var(--font-sans))" }}>
          SharePoint External Users
        </h1>
        <p style={{ margin: "4px 0 0", color: "var(--text-soft)", fontSize: "14px" }}>
          External users with drill-through to the sites and items they can access.
        </p>
      </div>

      <div style={{ display: "flex", gap: "8px", flexWrap: "wrap" }} data-testid="external-users-filters">
        <input
          type="text"
          placeholder="Search external user or email..."
          value={filter.search ?? ""}
          onChange={(e) => setFilter({ search: e.target.value || undefined })}
          style={inputStyle}
          aria-label="Search external users"
          data-testid="external-users-search"
        />
      </div>

      {error && (
        <div
          role="alert"
          style={{ padding: "12px 16px", borderRadius: "6px", background: "var(--danger-soft)", border: "1px solid var(--danger)", color: "var(--danger-text)", fontSize: "14px" }}
          data-testid="external-users-error"
        >
          {error}
        </div>
      )}

      {accessError && (
        <div
          role="alert"
          style={{ padding: "12px 16px", borderRadius: "6px", background: "var(--danger-soft)", border: "1px solid var(--danger)", color: "var(--danger-text)", fontSize: "14px" }}
          data-testid="external-users-access-error"
        >
          {accessError}
        </div>
      )}

      <div data-testid="external-users-count" style={{ fontSize: "13px", color: "var(--text-soft)" }}>
        {totalCount} external {totalCount === 1 ? "user" : "users"}
      </div>

      <ExternalUsersTable
        items={items}
        loading={loading}
        selectedExternalUserId={selectedExternalUserId}
        access={access}
        accessLoading={accessLoading}
        onSelect={(user) => void handleSelect(user)}
      />

      {nextCursor && (
        <div>
          <button
            type="button"
            style={loadingMore ? { ...buttonStyle, ...disabledStyle } : buttonStyle}
            disabled={loadingMore}
            onClick={() => void fetchPage(filter, nextCursor, true)}
            data-testid="external-users-load-more"
          >
            {loadingMore ? "Loading…" : "Load more"}
          </button>
        </div>
      )}
    </div>
  );
}

export default function ExternalUsersPage(): ReactElement {
  const searchParams = useSearchParams();
  const tenantId = resolveTenantId(searchParams.get("tenantId"), useCurrentTenantId());
  return (
    <RequireTenant tenantId={tenantId}>
      <ExternalUsersView tenantId={tenantId} />
    </RequireTenant>
  );
}
