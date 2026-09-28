"use client";

// AutopilotProfiles — Intune → Autopilot & Enrollment → Autopilot Profiles (EPIC-017 SPEC.md §3.4; T-0846).
// Live tab: the tenant's deployment profiles (T-0328) with create-from-template, edit (a JSON
// change), group assignment changes, and delete (typed name; the API refuses while assigned)
// through the T-0845 write routes. Templates tab: portal-wide profile templates (T-0328) with
// create / edit / delete and deploy to tenants (preview, explicit count confirmation for more
// than one, per-target results). Every write previews first and shows the plan. Kit tokens only.
import React, { useCallback, useEffect, useState } from "react";
import { badge, errorText, parseJsonObject, requestJson, splitLines, tenantPath, ui } from "./intuneFetch";

export interface LiveProfile {
  readonly id: string;
  readonly displayName: string;
  readonly description?: string;
  readonly deviceNameTemplate?: string;
  readonly profileType?: string;
}

export interface ProfileTemplate {
  readonly id: string;
  readonly name: string;
  readonly profileJson: Record<string, unknown>;
  readonly groupTag: string | null;
}

export interface WriteResult {
  readonly preview: boolean;
  readonly applied?: boolean;
  readonly plan?: Record<string, unknown>;
  readonly steps?: readonly { step: string; groupId: string; status: string; error?: string }[];
}

export interface AutopilotProfilesApi {
  listLive(tenantId: string): Promise<readonly LiveProfile[]>;
  create(tenantId: string, body: Record<string, unknown>): Promise<WriteResult>;
  update(tenantId: string, id: string, body: Record<string, unknown>): Promise<WriteResult>;
  remove(tenantId: string, id: string, body: Record<string, unknown>): Promise<WriteResult>;
  assign(tenantId: string, id: string, body: Record<string, unknown>): Promise<WriteResult>;
  listTemplates(): Promise<readonly ProfileTemplate[]>;
  saveTemplate(id: string | null, body: Record<string, unknown>): Promise<ProfileTemplate>;
  removeTemplate(id: string): Promise<void>;
  deployTemplate(id: string, body: Record<string, unknown>): Promise<{ preview: boolean; results: readonly { tenantId: string; state: string; error?: string }[] }>;
}

export function createAutopilotProfilesApi(): AutopilotProfilesApi {
  const live = (t: string, id?: string) => tenantPath(t, `/autopilot/profiles${id ? `/${encodeURIComponent(id)}` : ""}`);
  const tpl = (id?: string) => `/v1/autopilot/profile-templates${id ? `/${encodeURIComponent(id)}` : ""}`;
  return {
    listLive: async (t) => (await requestJson<{ items: LiveProfile[] }>(live(t))).items,
    create: (t, body) => requestJson(live(t), { method: "POST", body }),
    update: (t, id, body) => requestJson(live(t, id), { method: "PATCH", body }),
    remove: (t, id, body) => requestJson(live(t, id), { method: "DELETE", body }),
    assign: (t, id, body) => requestJson(`${live(t, id)}/assignments`, { method: "POST", body }),
    listTemplates: async () => (await requestJson<{ items: ProfileTemplate[] }>(tpl())).items,
    saveTemplate: (id, body) => requestJson(tpl(id ?? undefined), { method: id ? "PATCH" : "POST", body }),
    removeTemplate: (id) => requestJson(tpl(id), { method: "DELETE" }),
    deployTemplate: (id, body) => requestJson(`${tpl(id)}/deploy`, { method: "POST", body }),
  };
}

const STARTER_PROFILE = JSON.stringify(
  {
    "@odata.type": "#microsoft.graph.azureADWindowsAutopilotDeploymentProfile",
    displayName: "Standard user",
    deviceNameTemplate: "CORP-%SERIAL%",
    outOfBoxExperienceSettings: { hideEULA: true, hidePrivacySettings: true, userType: "standard" },
  },
  null,
  2,
);

type LiveAction = { kind: "edit" | "assign"; profile: LiveProfile } | { kind: "create" };

/** Plan summary for display: changed keys, or assignment steps. */
function planSummary(result: WriteResult): string {
  if (result.steps && result.steps.length > 0) return result.steps.map((s) => `${s.step} ${s.groupId}: ${s.status}${s.error ? ` (${s.error})` : ""}`).join("; ");
  const plan = result.plan ?? {};
  const steps = plan["steps"] as { step: string; groupId: string }[] | undefined;
  if (steps) return steps.length === 0 ? "No assignment changes." : steps.map((s) => `${s.step} ${s.groupId}`).join("; ");
  const after = plan["after"] as Record<string, unknown> | null | undefined;
  return after ? `Profile: ${String(after["displayName"] ?? "")}` : "No changes.";
}

function LiveTab({ tenantId, api }: { tenantId: string; api: AutopilotProfilesApi }) {
  const [profiles, setProfiles] = useState<readonly LiveProfile[] | null>(null);
  const [templates, setTemplates] = useState<readonly ProfileTemplate[]>([]);
  const [action, setAction] = useState<LiveAction | null>(null);
  const [text, setText] = useState("");
  const [removeText, setRemoveText] = useState("");
  const [templateId, setTemplateId] = useState("");
  const [preview, setPreview] = useState<WriteResult | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setProfiles(await api.listLive(tenantId));
      setTemplates(await api.listTemplates());
    } catch (err) {
      setError(errorText(err, "Failed to load profiles."));
    }
  }, [api, tenantId]);

  useEffect(() => {
    void load();
  }, [load]);

  const open = (a: LiveAction) => {
    setAction(a);
    setText(a.kind === "edit" ? JSON.stringify({ description: a.profile.description ?? "", deviceNameTemplate: a.profile.deviceNameTemplate ?? "" }, null, 2) : "");
    setRemoveText("");
    setPreview(null);
    setError(null);
  };

  function body(previewing: boolean): Record<string, unknown> | null {
    if (!action) return null;
    if (action.kind === "create") return templateId ? { templateId, preview: previewing } : (setError("Choose a template."), null);
    if (action.kind === "assign") return { add: splitLines(text), remove: splitLines(removeText), preview: previewing };
    const parsed = parseJsonObject(text);
    if ("error" in parsed) return (setError(parsed.error), null);
    return { profile: parsed.value, preview: previewing };
  }

  async function run(previewing: boolean) {
    const payload = body(previewing);
    if (!payload || !action) return;
    setError(null);
    try {
      const result =
        action.kind === "create"
          ? await api.create(tenantId, payload)
          : action.kind === "edit"
            ? await api.update(tenantId, action.profile.id, payload)
            : await api.assign(tenantId, action.profile.id, payload);
      if (previewing) setPreview(result);
      else {
        setNotice(action.kind === "assign" ? `Assignments: ${planSummary(result)}` : "Saved.");
        setAction(null);
        setPreview(null);
        await load();
      }
    } catch (err) {
      setError(errorText(err, "The change failed."));
    }
  }

  async function remove(p: LiveProfile) {
    const typed = window.prompt(`Type the profile name '${p.displayName}' to delete it. Assigned profiles cannot be deleted.`);
    if (!typed) return;
    try {
      await api.remove(tenantId, p.id, { confirmName: typed });
      setNotice(`Deleted ${p.displayName}.`);
      await load();
    } catch (err) {
      setError(errorText(err, "Delete failed."));
    }
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "10px" }}>
      <div>
        <button type="button" style={ui.primary} onClick={() => open({ kind: "create" })}>
          + Create from template
        </button>
      </div>
      {notice && <div role="status" style={ui.notice}>{notice}</div>}
      {error && <div role="alert" style={ui.error}>{error}</div>}
      {action && (
        <section aria-label="Profile change" style={ui.panel}>
          <strong>{action.kind === "create" ? "Create a profile from a template" : action.kind === "edit" ? `Edit ${action.profile.displayName}` : `Assignments for ${action.profile.displayName}`}</strong>
          {action.kind === "create" && (
            <select aria-label="Template" style={ui.input} value={templateId} onChange={(e) => { setTemplateId(e.target.value); setPreview(null); }}>
              <option value="">Choose a template…</option>
              {templates.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name}
                </option>
              ))}
            </select>
          )}
          {action.kind === "edit" && (
            <textarea aria-label="Profile changes (JSON)" style={{ ...ui.input, ...ui.mono, minHeight: "120px" }} value={text} onChange={(e) => { setText(e.target.value); setPreview(null); }} />
          )}
          {action.kind === "assign" && (
            <>
              <textarea aria-label="Groups to add" placeholder="Group object IDs to add, one per line" style={{ ...ui.input, ...ui.mono, minHeight: "50px" }} value={text} onChange={(e) => { setText(e.target.value); setPreview(null); }} />
              <textarea aria-label="Groups to remove" placeholder="Group object IDs to remove, one per line" style={{ ...ui.input, ...ui.mono, minHeight: "50px" }} value={removeText} onChange={(e) => { setRemoveText(e.target.value); setPreview(null); }} />
            </>
          )}
          {preview && <div role="status" aria-label="Plan" style={ui.notice}>{planSummary(preview)}</div>}
          <div style={{ display: "flex", gap: "8px", justifyContent: "flex-end" }}>
            <button type="button" style={ui.button} onClick={() => setAction(null)}>
              Cancel
            </button>
            <button type="button" style={ui.button} onClick={() => void run(true)}>
              Preview
            </button>
            <button type="button" style={ui.primary} disabled={!preview} onClick={() => void run(false)}>
              Apply
            </button>
          </div>
        </section>
      )}
      {profiles && (
        <table aria-label="Deployment profiles" style={ui.table}>
          <thead>
            <tr>
              <th style={ui.th}>Name</th>
              <th style={ui.th}>Type</th>
              <th style={ui.th}>Device name</th>
              <th style={ui.th}>Actions</th>
            </tr>
          </thead>
          <tbody>
            {profiles.length === 0 ? (
              <tr>
                <td colSpan={4} style={{ ...ui.td, textAlign: "center", color: "var(--muted)" }}>
                  No deployment profiles in this tenant.
                </td>
              </tr>
            ) : (
              profiles.map((p) => (
                <tr key={p.id} data-testid={`profile-${p.id}`}>
                  <td style={ui.td}>{p.displayName}</td>
                  <td style={ui.td}>{p.profileType?.startsWith("activeDirectory") ? "Hybrid joined" : "Entra joined"}</td>
                  <td style={{ ...ui.td, ...ui.mono }}>{p.deviceNameTemplate || "—"}</td>
                  <td style={ui.td}>
                    <span style={{ display: "flex", gap: "4px" }}>
                      <button type="button" style={ui.button} aria-label={`Edit ${p.displayName}`} onClick={() => open({ kind: "edit", profile: p })}>
                        Edit
                      </button>
                      <button type="button" style={ui.button} aria-label={`Assignments for ${p.displayName}`} onClick={() => open({ kind: "assign", profile: p })}>
                        Assignments
                      </button>
                      <button type="button" style={{ ...ui.button, color: "var(--danger-text)" }} aria-label={`Delete ${p.displayName}`} onClick={() => void remove(p)}>
                        Delete
                      </button>
                    </span>
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      )}
    </div>
  );
}

function TemplatesTab({ tenantId, api }: { tenantId: string; api: AutopilotProfilesApi }) {
  const [templates, setTemplates] = useState<readonly ProfileTemplate[] | null>(null);
  const [editing, setEditing] = useState<{ id: string | null; name: string; groupTag: string; json: string } | null>(null);
  const [deploying, setDeploying] = useState<ProfileTemplate | null>(null);
  const [targets, setTargets] = useState(tenantId);
  const [confirmed, setConfirmed] = useState(false);
  const [results, setResults] = useState<{ preview: boolean; results: readonly { tenantId: string; state: string; error?: string }[] } | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setTemplates(await api.listTemplates());
    } catch (err) {
      setError(errorText(err, "Failed to load templates."));
    }
  }, [api]);

  useEffect(() => {
    void load();
  }, [load]);

  async function save() {
    if (!editing) return;
    const parsed = parseJsonObject(editing.json);
    if ("error" in parsed) return setError(parsed.error);
    setError(null);
    try {
      await api.saveTemplate(editing.id, { name: editing.name, profileJson: parsed.value, groupTag: editing.groupTag.trim() || null });
      setNotice(`Saved ${editing.name}.`);
      setEditing(null);
      await load();
    } catch (err) {
      setError(errorText(err, "Save failed."));
    }
  }

  async function deploy(preview: boolean) {
    if (!deploying) return;
    const ids = splitLines(targets);
    if (ids.length === 0) return setError("Enter at least one tenant ID.");
    if (!preview && ids.length > 1 && !confirmed) return setError(`Confirm deploying to ${ids.length} tenants.`);
    setError(null);
    try {
      setResults(await api.deployTemplate(deploying.id, { targets: ids, preview, ...(!preview && ids.length > 1 ? { confirmTargetCount: ids.length } : {}) }));
    } catch (err) {
      setError(errorText(err, "Deploy failed."));
    }
  }

  async function remove(t: ProfileTemplate) {
    if (!window.confirm(`Delete the template '${t.name}'?`)) return;
    try {
      await api.removeTemplate(t.id);
      await load();
    } catch (err) {
      setError(errorText(err, "Delete failed."));
    }
  }

  const ids = splitLines(targets);
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "10px" }}>
      <div>
        <button type="button" style={ui.primary} onClick={() => { setEditing({ id: null, name: "", groupTag: "", json: STARTER_PROFILE }); setDeploying(null); }}>
          + New profile template
        </button>
      </div>
      {notice && <div role="status" style={ui.notice}>{notice}</div>}
      {error && <div role="alert" style={ui.error}>{error}</div>}
      {editing && (
        <section aria-label="Profile template editor" style={ui.panel}>
          <input aria-label="Template name" placeholder="Name" style={ui.input} value={editing.name} onChange={(e) => setEditing({ ...editing, name: e.target.value })} />
          <input aria-label="Group tag" placeholder="Group tag (optional)" style={ui.input} value={editing.groupTag} onChange={(e) => setEditing({ ...editing, groupTag: e.target.value })} />
          <textarea aria-label="Profile JSON" style={{ ...ui.input, ...ui.mono, minHeight: "160px" }} value={editing.json} onChange={(e) => setEditing({ ...editing, json: e.target.value })} />
          <div style={{ display: "flex", gap: "8px", justifyContent: "flex-end" }}>
            <button type="button" style={ui.button} onClick={() => setEditing(null)}>
              Cancel
            </button>
            <button type="button" style={ui.primary} onClick={() => void save()}>
              Save template
            </button>
          </div>
        </section>
      )}
      {deploying && (
        <section aria-label="Deploy profile template" style={ui.panel}>
          <strong>Deploy {deploying.name}</strong>
          <textarea aria-label="Target tenant IDs" style={{ ...ui.input, ...ui.mono, minHeight: "50px" }} value={targets} onChange={(e) => { setTargets(e.target.value); setResults(null); setConfirmed(false); }} />
          {ids.length > 1 && (
            <label style={{ fontSize: "13px" }}>
              <input type="checkbox" checked={confirmed} onChange={(e) => setConfirmed(e.target.checked)} /> I confirm deploying to {ids.length} tenants
            </label>
          )}
          {results && (
            <ul aria-label="Deploy results" style={{ margin: 0, paddingLeft: "18px", fontSize: "13px" }}>
              {results.results.map((r) => (
                <li key={r.tenantId}>
                  <span style={ui.mono}>{r.tenantId}</span> <span style={badge(r.state)}>{r.state}</span> {r.error ?? ""}
                </li>
              ))}
            </ul>
          )}
          <div style={{ display: "flex", gap: "8px", justifyContent: "flex-end" }}>
            <button type="button" style={ui.button} onClick={() => setDeploying(null)}>
              Close
            </button>
            <button type="button" style={ui.button} onClick={() => void deploy(true)}>
              Preview
            </button>
            <button type="button" style={ui.primary} disabled={!results?.preview} onClick={() => void deploy(false)}>
              Deploy
            </button>
          </div>
        </section>
      )}
      {templates && (
        <table aria-label="Profile templates" style={ui.table}>
          <thead>
            <tr>
              <th style={ui.th}>Name</th>
              <th style={ui.th}>Group tag</th>
              <th style={ui.th}>Actions</th>
            </tr>
          </thead>
          <tbody>
            {templates.length === 0 ? (
              <tr>
                <td colSpan={3} style={{ ...ui.td, textAlign: "center", color: "var(--muted)" }}>
                  No profile templates yet.
                </td>
              </tr>
            ) : (
              templates.map((t) => (
                <tr key={t.id} data-testid={`profile-template-${t.id}`}>
                  <td style={ui.td}>{t.name}</td>
                  <td style={ui.td}>{t.groupTag ?? "—"}</td>
                  <td style={ui.td}>
                    <span style={{ display: "flex", gap: "4px" }}>
                      <button type="button" style={ui.button} aria-label={`Deploy ${t.name}`} onClick={() => { setDeploying(t); setResults(null); setEditing(null); }}>
                        Deploy
                      </button>
                      <button type="button" style={ui.button} aria-label={`Edit ${t.name}`} onClick={() => { setEditing({ id: t.id, name: t.name, groupTag: t.groupTag ?? "", json: JSON.stringify(t.profileJson, null, 2) }); setDeploying(null); }}>
                        Edit
                      </button>
                      <button type="button" style={{ ...ui.button, color: "var(--danger-text)" }} aria-label={`Delete ${t.name}`} onClick={() => void remove(t)}>
                        Delete
                      </button>
                    </span>
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      )}
    </div>
  );
}

export interface AutopilotProfilesPageProps {
  readonly tenantId: string;
  readonly api?: AutopilotProfilesApi;
}

export function AutopilotProfilesPage({ tenantId, api }: AutopilotProfilesPageProps) {
  const [client] = useState(() => api ?? createAutopilotProfilesApi());
  const [tab, setTab] = useState<"live" | "templates">("live");
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "12px", color: "var(--text)" }}>
      <h2 style={{ margin: 0, fontSize: "18px" }}>Autopilot profiles</h2>
      <div role="tablist" aria-label="Profile view" style={{ display: "flex", gap: "4px" }}>
        {(["live", "templates"] as const).map((t) => (
          <button
            key={t}
            role="tab"
            type="button"
            aria-selected={tab === t}
            onClick={() => setTab(t)}
            style={{ ...ui.button, ...(tab === t ? { background: "var(--accent-soft)", color: "var(--accent-text)" } : {}) }}
          >
            {t === "live" ? "Tenant profiles" : "Templates"}
          </button>
        ))}
      </div>
      {tab === "live" ? <LiveTab tenantId={tenantId} api={client} /> : <TemplatesTab tenantId={tenantId} api={client} />}
    </div>
  );
}
