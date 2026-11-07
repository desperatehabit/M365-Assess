"use client";

// Shared team lookup for the linked Teams pages (EPIC-026 SPEC.md §3.1; T-0856).
// The v1 API exposes the filtered team list but no single-team detail route, so
// the detail, members, and edit pages read the list page and select the team by
// id. Live data comes from GET /v1/tenants/{id}/teams; nothing is cached.

import type { TeamItem } from "./TeamsTable";

export type Fetcher = typeof fetch;

export interface TeamsListResponse {
  readonly tenantId?: string;
  readonly totalCount?: number;
  readonly items?: readonly TeamItem[];
  readonly nextCursor?: string | null;
}

export async function fetchTeam(
  tenantId: string,
  teamId: string,
  fetcher: Fetcher = fetch,
): Promise<TeamItem | null> {
  const response = await fetcher(`/v1/tenants/${encodeURIComponent(tenantId)}/teams?limit=1000`);
  if (!response.ok) {
    const body = (await response.json().catch(() => ({}))) as { message?: string };
    throw new Error(body.message || `Failed to load teams: HTTP ${response.status}`);
  }
  const body = (await response.json()) as TeamsListResponse;
  return (body.items ?? []).find((team) => team.id === teamId) ?? null;
}
