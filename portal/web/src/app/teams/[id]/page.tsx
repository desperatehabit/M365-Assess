"use client";

// Team detail page (EPIC-026 SPEC.md §3.1, §4.1; T-0856).
// Nav: Teams & SharePoint → Teams → View. Renders one team's live §3.1 columns
// from GET /v1/tenants/{id}/teams and the lifecycle actions (edit, archive,
// clone, delete). Delete is the named, explicitly confirmed dialog; archive and
// clone route through the gated lifecycle API. Links to the members and edit
// pages the Teams table also targets.

import React, { useCallback, useEffect, useState, type CSSProperties, type ReactElement } from "react";
import { useParams, useSearchParams } from "next/navigation";
import { RequireTenant } from "../../../components/shell/RequireTenant";
import { TeamLifecycleActions } from "../../../components/teams/TeamDeleteDialog";
import { fetchTeam } from "../../../components/teams/teamLookup";
import type { TeamItem } from "../../../components/teams/TeamsTable";
import { resolveTenantId, useCurrentTenantId } from "../../../lib/useCurrentTenant";

const pageStyle: CSSProperties = {
  padding: "32px",
  maxWidth: "1000px",
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
  gap: "12px",
};

const gridStyle: CSSProperties = {
  display: "grid",
  gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))",
  gap: "12px",
};

const termStyle: CSSProperties = { fontSize: "12px", color: "var(--text-soft)", margin: 0 };
const valueStyle: CSSProperties = { fontSize: "14px", margin: "2px 0 0", fontWeight: 600 };

const linkStyle: CSSProperties = {
  color: "var(--accent)",
  fontSize: "13px",
  textDecoration: "none",
};

function Field({ label, value }: { readonly label: string; readonly value: string }): ReactElement {
  return (
    <div>
      <p style={termStyle}>{label}</p>
      <p style={valueStyle}>{value}</p>
    </div>
  );
}

export function TeamDetailView({
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

  if (loading) {
    return <div data-testid="team-detail-loading">Loading team…</div>;
  }
  if (error !== null) {
    return (
      <div role="alert" data-testid="team-detail-error">
        {error}
      </div>
    );
  }
  if (team === null) {
    return <div data-testid="team-detail-not-found">Team {teamId} was not found in this tenant.</div>;
  }

  return (
    <div style={panelStyle} data-testid="team-detail">
      <div style={{ display: "flex", justifyContent: "space-between", gap: "12px", flexWrap: "wrap" }}>
        <div>
          <h2 style={{ margin: 0, fontSize: "20px", fontWeight: 700 }}>{team.name}</h2>
          <div style={{ fontSize: "12px", color: "var(--text-soft)" }}>{team.id}</div>
        </div>
        <TeamLifecycleActions
          tenantId={tenantId}
          team={{ id: team.id, name: team.name, visibility: team.visibility }}
          onChanged={() => void load()}
          fetcher={fetcher}
        />
      </div>

      <div style={gridStyle} data-testid="team-detail-fields">
        <Field label="Visibility" value={team.visibility} />
        <Field label="Archived" value={team.isArchived ? "Yes" : "No"} />
        <Field label="Owners" value={String(team.ownerCount)} />
        <Field label="Members" value={String(team.memberCount)} />
        <Field label="Created" value={team.createdDateTime || "—"} />
        <Field label="Sensitivity" value={team.sensitivityLabel || "None"} />
      </div>

      <div style={{ display: "flex", gap: "16px", flexWrap: "wrap" }}>
        <a href={`/teams/${encodeURIComponent(team.id)}/members?tenantId=${encodeURIComponent(tenantId)}`} style={linkStyle} data-testid="team-detail-members-link">
          View members
        </a>
        <a href={`/teams/${encodeURIComponent(team.id)}/edit?tenantId=${encodeURIComponent(tenantId)}`} style={linkStyle} data-testid="team-detail-edit-link">
          Edit team
        </a>
        <a href={`/teams?tenantId=${encodeURIComponent(tenantId)}`} style={linkStyle}>
          Back to teams
        </a>
      </div>
    </div>
  );
}

export default function TeamDetailPage(): ReactElement {
  const params = useParams();
  const searchParams = useSearchParams();
  const tenantId = resolveTenantId(searchParams.get("tenantId"), useCurrentTenantId());
  const teamId = typeof params?.id === "string" ? params.id : "";

  return (
    <RequireTenant tenantId={tenantId}>
      <div style={pageStyle} data-testid="team-detail-page">
        <div>
          <div style={{ fontSize: "12px", color: "var(--text-soft)" }}>
            Teams &amp; SharePoint &gt; Teams &gt; View
          </div>
          <h1 style={{ fontSize: "24px", fontWeight: 700, margin: "4px 0 0" }}>Team</h1>
        </div>
        <TeamDetailView tenantId={tenantId} teamId={teamId} />
      </div>
    </RequireTenant>
  );
}
