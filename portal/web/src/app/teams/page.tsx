"use client";

// Teams page (EPIC-026 SPEC.md §3.1, T-0503).
// Nav: Teams & SharePoint → Teams. Title "Teams"; renders the TeamsTable with
// the §3.1 columns, the visibility/archived/activity filters, and cursor
// pagination against the T-0502 list route (GET /v1/tenants/{id}/teams).
// `Add team` and the row actions route to the create wizard (T-0506) and
// lifecycle (T-0505) surfaces instead of duplicating their logic. Strictly uses
// report theme tokens with zero colour literals.

import React, { useCallback, useEffect, useState, type CSSProperties, type ReactElement } from "react";
import { useSearchParams } from "next/navigation";
import { RequireTenant } from "../../components/shell/RequireTenant";
import { resolveTenantId, useCurrentTenantId } from "../../lib/useCurrentTenant";
import {
  EMPTY_TEAMS_FILTERS,
  TeamsTable,
  buildTeamsQuery,
  type TeamItem,
  type TeamRowAction,
  type TeamsFilters,
} from "../../components/teams/TeamsTable";

interface TeamsListResponse {
  readonly tenantId?: string;
  readonly totalCount?: number;
  readonly items?: readonly TeamItem[];
  readonly nextCursor?: string | null;
}

interface TeamsListPage {
  readonly items: readonly TeamItem[];
  readonly nextCursor: string | null;
}

async function fetchTeams(
  tenantId: string,
  filters: TeamsFilters,
  cursor: string | null,
): Promise<TeamsListPage> {
  const response = await fetch(
    `/v1/tenants/${encodeURIComponent(tenantId)}/teams${buildTeamsQuery(filters, { cursor, limit: 100 })}`,
  );
  if (!response.ok) {
    const body = (await response.json().catch(() => ({}))) as { message?: string };
    throw new Error(body.message || `Failed to load teams: HTTP ${response.status}`);
  }
  const body = (await response.json()) as TeamsListResponse;
  return { items: body.items ?? [], nextCursor: body.nextCursor ?? null };
}

const pageStyle: CSSProperties = {
  padding: "32px",
  maxWidth: "1400px",
  margin: "0 auto",
  fontFamily: "var(--font-sans, system-ui, sans-serif)",
  color: "var(--text)",
  display: "flex",
  flexDirection: "column",
  gap: "20px",
};

const headerStyle: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: "4px",
  borderBottom: "1px solid var(--border)",
  paddingBottom: "16px",
};

const breadcrumbStyle: CSSProperties = {
  fontSize: "12px",
  color: "var(--text-soft)",
};

const titleStyle: CSSProperties = {
  fontSize: "24px",
  fontWeight: 700,
  margin: 0,
  fontFamily: "var(--font-display, var(--font-sans))",
};

const subtitleStyle: CSSProperties = {
  margin: 0,
  fontSize: "14px",
  color: "var(--text-soft)",
};

function TeamsView({ tenantId }: { readonly tenantId: string }): ReactElement {
  const [filters, setFilters] = useState<TeamsFilters>(EMPTY_TEAMS_FILTERS);
  const [teams, setTeams] = useState<readonly TeamItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [page, setPage] = useState(1);
  const [cursors, setCursors] = useState<readonly string[]>([]);

  const load = useCallback(
    async (cursor: string | null): Promise<void> => {
      setLoading(true);
      setError(null);
      try {
        const result = await fetchTeams(tenantId, filters, cursor);
        setTeams(result.items);
        setNextCursor(result.nextCursor);
      } catch (err) {
        setTeams([]);
        setNextCursor(null);
        setError(err instanceof Error ? err.message : "Failed to load teams");
      } finally {
        setLoading(false);
      }
    },
    [tenantId, filters],
  );

  useEffect(() => {
    setPage(1);
    setCursors([]);
    void load(null);
  }, [load]);

  function handleNextPage(): void {
    if (!nextCursor) return;
    setCursors((previous) => [...previous, nextCursor]);
    setPage((current) => current + 1);
    void load(nextCursor);
  }

  function handlePrevPage(): void {
    const stack = cursors.slice(0, -1);
    const cursor = stack.length > 0 ? stack[stack.length - 1]! : null;
    setCursors(stack);
    setPage((current) => Math.max(1, current - 1));
    void load(cursor);
  }

  function handleAddTeam(): void {
    window.location.href = `/teams/new?tenantId=${encodeURIComponent(tenantId)}`;
  }

  function handleAction(action: TeamRowAction, team: TeamItem): void {
    const tenant = encodeURIComponent(tenantId);
    const id = encodeURIComponent(team.id);
    switch (action) {
      case "view":
        window.location.href = `/teams/${id}?tenantId=${tenant}`;
        break;
      case "members":
        window.location.href = `/teams/${id}/members?tenantId=${tenant}`;
        break;
      case "edit":
        window.location.href = `/teams/${id}/edit?tenantId=${tenant}`;
        break;
      case "archive":
        window.location.href = `/teams/${id}?tenantId=${tenant}&action=archive`;
        break;
      case "clone":
        window.location.href = `/teams/new?tenantId=${tenant}&cloneFrom=${id}`;
        break;
      case "delete":
        window.location.href = `/teams/${id}?tenantId=${tenant}&action=delete`;
        break;
    }
  }

  return (
    <div style={pageStyle} data-testid="teams-page">
      <div style={headerStyle}>
        <div style={breadcrumbStyle}>Teams &amp; SharePoint &gt; Teams</div>
        <h1 style={titleStyle}>Teams</h1>
        <p style={subtitleStyle}>
          List, filter, and manage Microsoft 365 teams. Open a team to view or change its lifecycle.
        </p>
      </div>

      <TeamsTable
        teams={teams}
        loading={loading}
        error={error}
        filters={filters}
        onFiltersChange={setFilters}
        onAddTeam={handleAddTeam}
        onAction={handleAction}
        nextCursor={nextCursor}
        page={page}
        onNextPage={handleNextPage}
        onPrevPage={handlePrevPage}
      />
    </div>
  );
}

export default function TeamsPage(): ReactElement {
  const searchParams = useSearchParams();
  const tenantId = resolveTenantId(searchParams.get("tenantId"), useCurrentTenantId());
  return (
    <RequireTenant tenantId={tenantId}>
      <TeamsView tenantId={tenantId} />
    </RequireTenant>
  );
}
