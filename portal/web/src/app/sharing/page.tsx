"use client";

// Sharing Report page (EPIC-027 SPEC.md §2 US-1, §3.1, §6; T-0522).
// Page title "Sharing Report": reads the §3.1 sharing links live from the T-0521
// API (GET /v1/tenants/:id/sharing/report) with the §3.1 filters (link type,
// permissions, site, created date, anonymous-only) pushed to the worker, renders
// SharingTable, and offers a first-class RiskyLinksView for anonymous and
// organization-wide links (SPEC §11 item 2). Row and bulk removal actions hand
// to the bulk-removal dialog (T-0527/T-0528); this page performs no removal and
// issues no writes. Nav/breadcrumb follows Teams & SharePoint → Sharing Report.

import React, { useCallback, useEffect, useMemo, useState, type CSSProperties, type ReactElement } from "react";
import { useSearchParams } from "next/navigation";
import { RequireTenant } from "../../components/shell/RequireTenant";
import { resolveTenantId, useCurrentTenantId } from "../../lib/useCurrentTenant";
import { RemoveLinksDialog } from "../../components/sharing/RemoveLinksDialog";
import type { SharingLinkRef } from "../../components/sharing/RemovalPlanPreview";
import {
  SharingTable,
  type SharingLinkPermissions,
  type SharingLinkType,
  type SharingReportItem,
} from "../../components/sharing/SharingTable";
import { RiskyLinksView } from "../../components/sharing/RiskyLinksView";

export type SharingReportViewMode = "all" | "risky";

export interface SharingFilter {
  readonly linkType?: SharingLinkType;
  readonly permissions?: SharingLinkPermissions;
  readonly site?: string;
  readonly createdAfter?: string;
  readonly anonymousOnly?: boolean;
}

export type Fetcher = typeof fetch;

/** Builds the BFF query string for GET /v1/tenants/:id/sharing/report (T-0521 filters). */
export function buildSharingReportQuery(filter: SharingFilter, cursor: string | null, limit = 100): string {
  const params = new URLSearchParams();
  if (filter.linkType) params.set("linkType", filter.linkType);
  if (filter.permissions) params.set("permissions", filter.permissions);
  if (filter.site) params.set("site", filter.site);
  if (filter.createdAfter) params.set("createdAfter", filter.createdAfter);
  if (filter.anonymousOnly) params.set("anonymousOnly", "true");
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

export async function fetchSharingReport(
  tenantId: string,
  filter: SharingFilter,
  cursor: string | null,
  fetcher: Fetcher = fetch,
): Promise<{ items: SharingReportItem[]; nextCursor: string | null; totalCount: number }> {
  const response = await fetcher(
    `/v1/tenants/${encodeURIComponent(tenantId)}/sharing/report${buildSharingReportQuery(filter, cursor)}`,
    { method: "GET", headers: { Accept: "application/json" } },
  );
  if (!response.ok) throw await readError(response, "List sharing report");
  const body = (await response.json()) as {
    items?: SharingReportItem[];
    nextCursor?: string | null;
    totalCount?: number;
  };
  return {
    items: [...(body.items ?? [])],
    nextCursor: body.nextCursor ?? null,
    totalCount: body.totalCount ?? 0,
  };
}

/** Maps a §3.1 sharing-report row to the bulk-removal link reference (T-0528). */
export function toSharingLinkRef(item: SharingReportItem): SharingLinkRef {
  return {
    linkId: item.linkId,
    itemId: item.itemId ? item.itemId : null,
    driveId: item.driveId ? item.driveId : null,
    linkType: item.linkType ? item.linkType : null,
    resourceName: item.itemName ? item.itemName : null,
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

const activeToggleStyle: CSSProperties = {
  ...buttonStyle,
  background: "var(--accent)",
  color: "var(--on-accent)",
  borderColor: "var(--accent)",
};

const disabledStyle: CSSProperties = { opacity: 0.45, cursor: "not-allowed" };

export interface SharingReportViewProps {
  readonly tenantId: string;
  readonly fetcher?: Fetcher;
}

export function SharingReportView({ tenantId, fetcher = fetch }: SharingReportViewProps): ReactElement {
  const [view, setView] = useState<SharingReportViewMode>("all");
  const [filter, setFilter] = useState<SharingFilter>({});
  const [items, setItems] = useState<SharingReportItem[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [totalCount, setTotalCount] = useState(0);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selectedLinkIds, setSelectedLinkIds] = useState<string[]>([]);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [dialogLinks, setDialogLinks] = useState<SharingLinkRef[]>([]);

  // The risky view defines its own link-type set (anonymous + organization), so
  // the linkType/anonymous-only filters are not pushed for it (SPEC §11 item 2).
  const effectiveFilter = useMemo<SharingFilter>(() => {
    if (view === "risky") {
      return { permissions: filter.permissions, site: filter.site, createdAfter: filter.createdAfter };
    }
    return filter;
  }, [view, filter]);

  const fetchPage = useCallback(
    async (target: SharingFilter, cursor: string | null, append: boolean): Promise<void> => {
      if (append) {
        setLoadingMore(true);
      } else {
        setLoading(true);
      }
      setError(null);
      try {
        const page = await fetchSharingReport(tenantId, target, cursor, fetcher);
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
    setSelectedLinkIds([]);
    void fetchPage(effectiveFilter, null, false);
  }, [tenantId, effectiveFilter, fetchPage]);

  function toggleSelect(item: SharingReportItem): void {
    setSelectedLinkIds((prev) =>
      prev.includes(item.linkId) ? prev.filter((id) => id !== item.linkId) : [...prev, item.linkId],
    );
  }

  function toggleSelectAll(links: readonly SharingReportItem[]): void {
    setSelectedLinkIds(links.map((item) => item.linkId));
  }

  function openRemoveLinks(links: readonly SharingLinkRef[]): void {
    if (links.length === 0) return;
    setDialogLinks([...links]);
    setDialogOpen(true);
  }

  function handleRemoved(): void {
    setSelectedLinkIds([]);
    void fetchPage(effectiveFilter, null, false);
  }

  function openItem(item: SharingReportItem): void {
    window.open(item.itemUrl, "_blank", "noopener,noreferrer");
  }

  function openInSharePoint(item: SharingReportItem): void {
    window.open(item.siteUrl, "_blank", "noopener,noreferrer");
  }

  const tableProps = {
    selectedLinkIds,
    onToggleSelect: toggleSelect,
    onToggleSelectAll: toggleSelectAll,
    onViewItem: openItem,
    onRemoveLink: (item: SharingReportItem) => openRemoveLinks([toSharingLinkRef(item)]),
    onOpenInSharePoint: openInSharePoint,
    onRemoveSelected: (links: readonly SharingReportItem[]) => openRemoveLinks(links.map(toSharingLinkRef)),
  };

  return (
    <div style={pageStyle} data-testid="sharing-report-page">
      <div>
        <div style={{ fontSize: "12px", color: "var(--text-soft)" }} data-testid="sharing-breadcrumb">
          Teams &amp; SharePoint &gt; Sharing Report
        </div>
        <h1
          style={{ fontSize: "24px", fontWeight: 700, margin: "4px 0 0", fontFamily: "var(--font-display, var(--font-sans))" }}
        >
          Sharing Report
        </h1>
        <p style={{ margin: "4px 0 0", color: "var(--text-soft)", fontSize: "14px" }}>
          Sharing links across sites and OneDrive, with a dedicated risky/anonymous-link view. Removal hands to the
          bulk-removal dialog; no removal happens on this page.
        </p>
      </div>

      <div style={{ display: "flex", gap: "10px", flexWrap: "wrap", alignItems: "center" }}>
        <button
          type="button"
          style={view === "all" ? activeToggleStyle : buttonStyle}
          aria-pressed={view === "all"}
          onClick={() => setView("all")}
          data-testid="sharing-view-all"
        >
          All links
        </button>
        <button
          type="button"
          style={view === "risky" ? activeToggleStyle : buttonStyle}
          aria-pressed={view === "risky"}
          onClick={() => setView("risky")}
          data-testid="sharing-view-risky"
        >
          Risky links
        </button>
        <span style={{ fontSize: "13px", color: "var(--text-soft)" }} data-testid="sharing-count">
          {totalCount} sharing link{totalCount === 1 ? "" : "s"}
        </span>
      </div>

      <div style={filterBarStyle} data-testid="sharing-filters">
        {view === "all" && (
          <select
            aria-label="Filter by link type"
            data-testid="filter-link-type"
            value={filter.linkType ?? ""}
            onChange={(e) =>
              setFilter((prev) => ({ ...prev, linkType: (e.target.value || undefined) as SharingLinkType | undefined }))
            }
            style={selectStyle}
          >
            <option value="">All link types</option>
            <option value="anonymous">Anonymous</option>
            <option value="organization">Organization</option>
            <option value="people">People</option>
          </select>
        )}
        <select
          aria-label="Filter by permissions"
          data-testid="filter-permissions"
          value={filter.permissions ?? ""}
          onChange={(e) =>
            setFilter((prev) => ({
              ...prev,
              permissions: (e.target.value || undefined) as SharingLinkPermissions | undefined,
            }))
          }
          style={selectStyle}
        >
          <option value="">All permissions</option>
          <option value="view">View</option>
          <option value="edit">Edit</option>
        </select>
        <input
          type="text"
          placeholder="Site name, id, or URL..."
          value={filter.site ?? ""}
          onChange={(e) => setFilter((prev) => ({ ...prev, site: e.target.value || undefined }))}
          style={inputStyle}
          aria-label="Filter by site"
          data-testid="filter-site"
        />
        <label style={{ display: "inline-flex", alignItems: "center", gap: "6px", fontSize: "13px" }}>
          Created after
          <input
            type="date"
            value={filter.createdAfter ?? ""}
            onChange={(e) => setFilter((prev) => ({ ...prev, createdAfter: e.target.value || undefined }))}
            style={inputStyle}
            aria-label="Filter by created date"
            data-testid="filter-created-after"
          />
        </label>
        {view === "all" && (
          <label style={{ display: "inline-flex", alignItems: "center", gap: "6px", fontSize: "13px" }}>
            <input
              type="checkbox"
              checked={filter.anonymousOnly ?? false}
              onChange={(e) => setFilter((prev) => ({ ...prev, anonymousOnly: e.target.checked || undefined }))}
              aria-label="Anonymous links only"
              data-testid="filter-anonymous-only"
            />
            Anonymous only
          </label>
        )}
      </div>

      {view === "risky" ? (
        <RiskyLinksView
          items={items}
          loading={loading}
          error={error}
          {...tableProps}
        />
      ) : (
        <SharingTable items={items} loading={loading} error={error} {...tableProps} />
      )}

      {nextCursor && (
        <div>
          <button
            type="button"
            style={loadingMore ? { ...buttonStyle, ...disabledStyle } : buttonStyle}
            disabled={loadingMore}
            onClick={() => void fetchPage(effectiveFilter, nextCursor, true)}
            data-testid="sharing-load-more"
          >
            {loadingMore ? "Loading..." : "Load more"}
          </button>
        </div>
      )}

      <RemoveLinksDialog
        isOpen={dialogOpen}
        onClose={() => setDialogOpen(false)}
        tenantId={tenantId}
        links={dialogLinks}
        onRemoved={handleRemoved}
      />
    </div>
  );
}

export default function SharingReportPage(): ReactElement {
  const searchParams = useSearchParams();
  const tenantId = resolveTenantId(searchParams.get("tenantId"), useCurrentTenantId());
  return (
    <RequireTenant tenantId={tenantId}>
      <SharingReportView tenantId={tenantId} />
    </RequireTenant>
  );
}
