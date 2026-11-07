"use client";

// Team members page (EPIC-026 SPEC.md §3.1; T-0856).
// Nav: Teams & SharePoint → Teams → Members. The v1 list API exposes the team's
// owner and member counts, not the identities, so this page renders the live
// counts and the team's membership shape from GET /v1/tenants/{id}/teams.
// Identity-level membership remains a Graph read and is not mirrored here.

import React, { useCallback, useEffect, useState, type CSSProperties, type ReactElement } from "react";
import { useParams, useSearchParams } from "next/navigation";
import { RequireTenant } from "../../../../components/shell/RequireTenant";
import { fetchTeam } from "../../../../components/teams/teamLookup";
import type { TeamItem } from "../../../../components/teams/TeamsTable";
import { resolveTenantId, useCurrentTenantId } from "../../../../lib/useCurrentTenant";

const pageStyle: CSSProperties = {
  padding: "32px",
  maxWidth: "900px",
  margin: "0 auto",
  display: "flex",
  flexDirection: "column",
  gap: "20px",
  fontFamily: "var(--font-sans, system-ui, sans-serif)",
  color: "var(--text)",
};

const panelStyle: CSSProperties = {
  padding: "20px",
  background: "var(--bg-elev)",
  border: "1px solid var(--border)",
  borderRadius: "var(--radius, 10px)",
  display: "flex",
  flexDirection: "column",
  gap: "10px",
};

const rowStyle: CSSProperties = {
  display: "flex",
  justifyContent: "space-between",
  padding: "8px 0",
  borderBottom: "1px solid var(--border)",
  fontSize: "14px",
};

export function TeamMembersView({
  tenantId,
  teamId,
  fetcher,
}: {
  readonly tenantId: string;
  readonly teamId: string;
  readonly fetcher?: typeof fetch;
}): ReactElement {
  const [team, setTeam] = useState<TeamItem | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async (): Promise<void> => {
    setLoading(true);
    setError(null);
    try {
      setTeam(await fetchTeam(tenantId, teamId, fetcher));
    } catch (err) {
      setTeam(null);
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [tenantId, teamId, fetcher]);

  useEffect(() => {
    void load();
  }, [load]);

  if (loading) return <div data-testid="team-members-loading">Loading members…</div>;
  if (error !== null) {
    return (
      <div role="alert" data-testid="team-members-error">
        {error}
      </div>
    );
  }
  if (team === null) {
    return <div data-testid="team-members-not-found">Team {teamId} was not found in this tenant.</div>;
  }

  return (
    <div style={panelStyle} data-testid="team-members">
      <div>
        <h2 style={{ margin: 0, fontSize: "20px", fontWeight: 700 }}>{team.name}</h2>
        <div style={{ fontSize: "12px", color: "var(--text-soft)" }}>{team.id}</div>
      </div>
      <div style={rowStyle}>
        <span>Owners</span>
        <strong data-testid="team-members-owner-count">{team.ownerCount}</strong>
      </div>
      <div style={rowStyle}>
        <span>Members</span>
        <strong data-testid="team-members-member-count">{team.memberCount}</strong>
      </div>
      <div style={rowStyle}>
        <span>Visibility</span>
        <strong>{team.visibility}</strong>
      </div>
      <div style={rowStyle}>
        <span>Archived</span>
        <strong>{team.isArchived ? "Yes" : "No"}</strong>
      </div>
      <p style={{ margin: 0, fontSize: "13px", color: "var(--text-soft)" }}>
        Member identities are read live from Microsoft Graph and are not mirrored by the portal.
      </p>
      <a
        href={`/teams/${encodeURIComponent(team.id)}?tenantId=${encodeURIComponent(tenantId)}`}
        style={{ color: "var(--accent)", fontSize: "13px", textDecoration: "none" }}
      >
        Back to team
      </a>
    </div>
  );
}

export default function TeamMembersPage(): ReactElement {
  const params = useParams();
  const searchParams = useSearchParams();
  const tenantId = resolveTenantId(searchParams.get("tenantId"), useCurrentTenantId());
  const teamId = typeof params?.id === "string" ? params.id : "";

  return (
    <RequireTenant tenantId={tenantId}>
      <div style={pageStyle} data-testid="team-members-page">
        <div>
          <div style={{ fontSize: "12px", color: "var(--text-soft)" }}>
            Teams &amp; SharePoint &gt; Teams &gt; Members
          </div>
          <h1 style={{ fontSize: "24px", fontWeight: 700, margin: "4px 0 0" }}>Team members</h1>
        </div>
        <TeamMembersView tenantId={tenantId} teamId={teamId} />
      </div>
    </RequireTenant>
  );
}
