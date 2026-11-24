"use client";

// Edit team page (EPIC-026 SPEC.md §3.1, §4.1; T-0856).
// Nav: Teams & SharePoint → Teams → Edit. Loads the live team row from
// GET /v1/tenants/{id}/teams and saves name/visibility through the gated
// lifecycle API (PATCH /v1/tenants/{id}/teams/{teamId} with `changes`).

import React, { useCallback, useEffect, useState, type CSSProperties, type ReactElement } from "react";
import { useParams, useSearchParams } from "next/navigation";
import { RequireTenant } from "../../../../components/shell/RequireTenant";
import { fetchTeam } from "../../../../components/teams/teamLookup";
import type { TeamItem, TeamVisibility } from "../../../../components/teams/TeamsTable";
import { resolveTenantId, useCurrentTenantId } from "../../../../lib/useCurrentTenant";

const pageStyle: CSSProperties = {
  padding: "32px",
  maxWidth: "720px",
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
  gap: "14px",
};

const fieldStyle: CSSProperties = { display: "flex", flexDirection: "column", gap: "6px" };
const labelStyle: CSSProperties = { fontSize: "13px", fontWeight: 600 };
const inputStyle: CSSProperties = {
  padding: "8px 12px",
  background: "var(--input-bg, var(--bg))",
  border: "1px solid var(--border)",
  borderRadius: "6px",
  color: "var(--text)",
  fontSize: "14px",
};
const primaryButtonStyle: CSSProperties = {
  padding: "8px 16px",
  background: "var(--accent)",
  color: "var(--on-accent)",
  border: "1px solid var(--accent)",
  borderRadius: "6px",
  fontWeight: 600,
  fontSize: "14px",
  cursor: "pointer",
};
const errorStyle: CSSProperties = {
  padding: "12px 14px",
  borderRadius: "6px",
  background: "var(--danger-soft)",
  border: "1px solid var(--danger)",
  color: "var(--danger-text)",
  fontSize: "13px",
};

export function TeamEditView({
  tenantId,
  teamId,
  fetcher,
}: {
  readonly tenantId: string;
  readonly teamId: string;
  readonly fetcher?: typeof fetch;
}): ReactElement {
  const runFetch = fetcher ?? fetch;
  const [team, setTeam] = useState<TeamItem | null>(null);
  const [name, setName] = useState("");
  const [visibility, setVisibility] = useState<TeamVisibility>("private");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  const load = useCallback(async (): Promise<void> => {
    setLoading(true);
    setError(null);
    try {
      const found = await fetchTeam(tenantId, teamId, runFetch);
      setTeam(found);
      if (found !== null) {
        setName(found.name);
        setVisibility(found.visibility);
      }
    } catch (err) {
      setTeam(null);
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [tenantId, teamId, runFetch]);

  useEffect(() => {
    void load();
  }, [load]);

  async function save(): Promise<void> {
    if (saving || name.trim().length === 0) return;
    setSaving(true);
    setError(null);
    setSaved(false);
    try {
      const response = await runFetch(
        `/v1/tenants/${encodeURIComponent(tenantId)}/teams/${encodeURIComponent(teamId)}`,
        {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ changes: { displayName: name.trim(), visibility } }),
        },
      );
      if (!response.ok) {
        const body = (await response.json().catch(() => ({}))) as { message?: string };
        throw new Error(body.message || `Save failed: HTTP ${response.status}`);
      }
      setSaved(true);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  }

  if (loading) return <div data-testid="team-edit-loading">Loading team…</div>;
  if (team === null) {
    return (
      <div data-testid="team-edit-not-found" style={errorStyle}>
        Team {teamId} was not found in this tenant.
      </div>
    );
  }

  return (
    <form
      style={panelStyle}
      data-testid="team-edit"
      onSubmit={(event) => {
        event.preventDefault();
        void save();
      }}
    >
      <div>
        <h2 style={{ margin: 0, fontSize: "20px", fontWeight: 700 }}>Edit {team.name}</h2>
        <div style={{ fontSize: "12px", color: "var(--text-soft)" }}>{team.id}</div>
      </div>

      {error !== null && (
        <div role="alert" style={errorStyle} data-testid="team-edit-error">
          {error}
        </div>
      )}
      {saved && (
        <div role="status" data-testid="team-edit-saved" style={{ fontSize: "13px", color: "var(--success-text)" }}>
          Team changes saved.
        </div>
      )}

      <div style={fieldStyle}>
        <label style={labelStyle} htmlFor="team-edit-name">
          Team name
        </label>
        <input
          id="team-edit-name"
          style={inputStyle}
          value={name}
          onChange={(event) => setName(event.target.value)}
          data-testid="team-edit-name-input"
        />
      </div>

      <div style={fieldStyle}>
        <label style={labelStyle} htmlFor="team-edit-visibility">
          Visibility
        </label>
        <select
          id="team-edit-visibility"
          style={inputStyle}
          value={visibility}
          onChange={(event) => setVisibility(event.target.value as TeamVisibility)}
          data-testid="team-edit-visibility-select"
        >
          <option value="private">private</option>
          <option value="public">public</option>
        </select>
      </div>

      <div style={{ display: "flex", justifyContent: "space-between", gap: "12px" }}>
        <a
          href={`/teams/${encodeURIComponent(team.id)}?tenantId=${encodeURIComponent(tenantId)}`}
          style={{ color: "var(--accent)", fontSize: "13px", textDecoration: "none", alignSelf: "center" }}
        >
          Back to team
        </a>
        <button
          type="submit"
          style={primaryButtonStyle}
          disabled={saving || name.trim().length === 0}
          data-testid="team-edit-save"
        >
          {saving ? "Saving…" : "Save changes"}
        </button>
      </div>
    </form>
  );
}

export default function TeamEditPage(): ReactElement {
  const params = useParams();
  const searchParams = useSearchParams();
  const tenantId = resolveTenantId(searchParams.get("tenantId"), useCurrentTenantId());
  const teamId = typeof params?.id === "string" ? params.id : "";

  return (
    <RequireTenant tenantId={tenantId}>
      <div style={pageStyle} data-testid="team-edit-page">
        <div>
          <div style={{ fontSize: "12px", color: "var(--text-soft)" }}>
            Teams &amp; SharePoint &gt; Teams &gt; Edit
          </div>
          <h1 style={{ fontSize: "24px", fontWeight: 700, margin: "4px 0 0" }}>Edit team</h1>
        </div>
        <TeamEditView tenantId={tenantId} teamId={teamId} />
      </div>
    </RequireTenant>
  );
}
