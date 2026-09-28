"use client";

// ApplicationTemplates — Intune → Applications → Application Templates (EPIC-017 SPEC.md §3.3; T-0846).
// Lists /v1/app-templates (T-0327); creates and edits a template (the app upload body as JSON,
// with `%name%` tokens, plus declared variables with defaults); deletes; and deploys to tenants:
// a per-target preview of the substituted request, `values` overrides, an explicit count
// confirmation for more than one tenant, and per-target results. Kit tokens only.
import React, { useCallback, useEffect, useState } from "react";
import { badge, errorText, parseJsonObject, requestJson, splitLines, ui } from "./intuneFetch";

export interface TemplateVariable {
  readonly name: string;
  readonly description?: string;
  readonly defaultValue?: string;
}

export interface AppTemplate {
  readonly id: string;
  readonly name: string;
  readonly appType: "win32" | "store";
  readonly config: Record<string, unknown>;
  readonly variables: readonly TemplateVariable[];
  readonly updatedAt: string;
}

export interface TemplateTargetResult {
  readonly tenantId: string;
  readonly state: "planned" | "queued" | "failed";
  readonly request?: Record<string, unknown>;
  readonly issues?: readonly string[];
  readonly deploymentId?: string;
  readonly error?: string;
}

export interface DeployResponse {
  readonly preview: boolean;
  readonly summary: Record<string, number>;
  readonly results: readonly TemplateTargetResult[];
}

export interface AppTemplatesApi {
  list(): Promise<readonly AppTemplate[]>;
  save(id: string | null, body: Record<string, unknown>): Promise<AppTemplate>;
  remove(id: string): Promise<void>;
  deploy(id: string, body: Record<string, unknown>): Promise<DeployResponse>;
}

export function createAppTemplatesApi(baseUrl = ""): AppTemplatesApi {
  const url = (id?: string) => `${baseUrl}/v1/app-templates${id ? `/${encodeURIComponent(id)}` : ""}`;
  return {
    list: async () => (await requestJson<{ items: AppTemplate[] }>(url())).items,
    save: (id, body) => requestJson<AppTemplate>(url(id ?? undefined), { method: id ? "PATCH" : "POST", body }),
    remove: (id) => requestJson<void>(url(id), { method: "DELETE" }),
    deploy: (id, body) => requestJson<DeployResponse>(`${url(id)}/deploy`, { method: "POST", body }),
  };
}

/** Parses `name=value` lines into deploy overrides; returns the bad lines too. */
export function parseValues(text: string): { values: Record<string, string>; invalid: string[] } {
  const values: Record<string, string> = {};
  const invalid: string[] = [];
  for (const line of text.split("\n").map((l) => l.trim()).filter(Boolean)) {
    const eq = line.indexOf("=");
    if (eq <= 0) invalid.push(line);
    else values[line.slice(0, eq).trim()] = line.slice(eq + 1).trim();
  }
  return { values, invalid };
}

const STARTER_CONFIG = JSON.stringify(
  {
    displayName: "%AppName%",
    publisher: "",
    packageId: "%PackageId%",
    installCommandLine: "",
    uninstallCommandLine: "",
    detectionRules: [{ type: "file", path: "", fileOrFolderName: "" }],
  },
  null,
  2,
);

interface Draft {
  id: string | null;
  name: string;
  appType: "win32" | "store";
  config: string;
  variables: TemplateVariable[];
}

function TemplateEditor({ draft, onChange, onSave, onCancel, busy }: { draft: Draft; onChange: (d: Draft) => void; onSave: () => void; onCancel: () => void; busy: boolean }) {
  const setVar = (i: number, patch: Partial<TemplateVariable>) =>
    onChange({ ...draft, variables: draft.variables.map((v, j) => (j === i ? { ...v, ...patch } : v)) });
  return (
    <section style={ui.panel} aria-label="Template editor">
      <div style={{ display: "flex", gap: "8px", flexWrap: "wrap" }}>
        <label style={{ display: "flex", flexDirection: "column", gap: "4px", fontSize: "13px", flex: 1 }}>
          Name
          <input style={ui.input} value={draft.name} onChange={(e) => onChange({ ...draft, name: e.target.value })} />
        </label>
        <label style={{ display: "flex", flexDirection: "column", gap: "4px", fontSize: "13px" }}>
          App type
          <select style={ui.input} value={draft.appType} disabled={draft.id !== null} onChange={(e) => onChange({ ...draft, appType: e.target.value as Draft["appType"] })}>
            <option value="win32">Win32</option>
            <option value="store">Store</option>
          </select>
        </label>
      </div>
      <label style={{ display: "flex", flexDirection: "column", gap: "4px", fontSize: "13px" }}>
        Config (JSON; use %Name% for per-tenant values)
        <textarea style={{ ...ui.input, ...ui.mono, minHeight: "180px" }} value={draft.config} onChange={(e) => onChange({ ...draft, config: e.target.value })} />
      </label>
      <div style={{ fontSize: "13px" }}>Variables</div>
      {draft.variables.map((v, i) => (
        <div key={i} style={{ display: "flex", gap: "6px", flexWrap: "wrap" }}>
          <input aria-label={`Variable ${i + 1} name`} placeholder="Name" style={ui.input} value={v.name} onChange={(e) => setVar(i, { name: e.target.value })} />
          <input aria-label={`Variable ${i + 1} description`} placeholder="Description" style={{ ...ui.input, flex: 1 }} value={v.description ?? ""} onChange={(e) => setVar(i, { description: e.target.value })} />
          <input aria-label={`Variable ${i + 1} default`} placeholder="Default (optional)" style={ui.input} value={v.defaultValue ?? ""} onChange={(e) => setVar(i, { defaultValue: e.target.value })} />
          <button type="button" style={ui.button} aria-label={`Remove variable ${i + 1}`} onClick={() => onChange({ ...draft, variables: draft.variables.filter((_, j) => j !== i) })}>
            Remove
          </button>
        </div>
      ))}
      <div style={{ display: "flex", gap: "8px", justifyContent: "space-between" }}>
        <button type="button" style={ui.button} onClick={() => onChange({ ...draft, variables: [...draft.variables, { name: "" }] })}>
          + Add variable
        </button>
        <span style={{ display: "flex", gap: "8px" }}>
          <button type="button" style={ui.button} onClick={onCancel}>
            Cancel
          </button>
          <button type="button" style={ui.primary} disabled={busy} onClick={onSave}>
            Save template
          </button>
        </span>
      </div>
    </section>
  );
}

function DeployPanel({ template, api, defaultTenant, onClose }: { template: AppTemplate; api: AppTemplatesApi; defaultTenant: string; onClose: () => void }) {
  const [targets, setTargets] = useState(defaultTenant);
  const [valuesText, setValuesText] = useState("");
  const [confirmed, setConfirmed] = useState(false);
  const [result, setResult] = useState<DeployResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const tenantIds = splitLines(targets);

  async function run(preview: boolean) {
    const { values, invalid } = parseValues(valuesText);
    if (invalid.length > 0) return setError(`Values must be name=value lines: ${invalid.join(", ")}`);
    if (tenantIds.length === 0) return setError("Enter at least one tenant ID.");
    if (!preview && tenantIds.length > 1 && !confirmed) return setError(`Confirm deploying to ${tenantIds.length} tenants.`);
    setBusy(true);
    setError(null);
    try {
      setResult(
        await api.deploy(template.id, {
          targets: tenantIds,
          values,
          preview,
          ...(!preview && tenantIds.length > 1 ? { confirmTargetCount: tenantIds.length } : {}),
        }),
      );
    } catch (err) {
      setError(errorText(err, "Deploy failed."));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section style={ui.panel} aria-label="Deploy template">
      <h3 style={{ margin: 0, fontSize: "15px" }}>Deploy {template.name}</h3>
      <label style={{ display: "flex", flexDirection: "column", gap: "4px", fontSize: "13px" }}>
        Target tenant IDs (one per line)
        <textarea style={{ ...ui.input, ...ui.mono, minHeight: "60px" }} value={targets} onChange={(e) => { setTargets(e.target.value); setResult(null); setConfirmed(false); }} />
      </label>
      <label style={{ display: "flex", flexDirection: "column", gap: "4px", fontSize: "13px" }}>
        Value overrides (name=value, one per line; otherwise tenant and global variables apply)
        <textarea style={{ ...ui.input, ...ui.mono, minHeight: "50px" }} value={valuesText} onChange={(e) => { setValuesText(e.target.value); setResult(null); }} />
      </label>
      {tenantIds.length > 1 && (
        <label style={{ fontSize: "13px" }}>
          <input type="checkbox" checked={confirmed} onChange={(e) => setConfirmed(e.target.checked)} /> I confirm deploying to {tenantIds.length} tenants
        </label>
      )}
      {error && <div role="alert" style={ui.error}>{error}</div>}
      {result && (
        <table aria-label="Deploy results" style={ui.table}>
          <thead>
            <tr>
              <th style={ui.th}>Tenant</th>
              <th style={ui.th}>State</th>
              <th style={ui.th}>App</th>
              <th style={ui.th}>Detail</th>
            </tr>
          </thead>
          <tbody>
            {result.results.map((r) => (
              <tr key={r.tenantId}>
                <td style={{ ...ui.td, ...ui.mono }}>{r.tenantId}</td>
                <td style={ui.td}>
                  <span style={badge(r.state)}>{r.state}</span>
                </td>
                <td style={ui.td}>{String(r.request?.["displayName"] ?? "—")}</td>
                <td style={ui.td}>{r.error ?? r.issues?.join("; ") ?? r.deploymentId ?? ""}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <div style={{ display: "flex", gap: "8px", justifyContent: "flex-end" }}>
        <button type="button" style={ui.button} onClick={onClose}>
          Close
        </button>
        <button type="button" style={ui.button} disabled={busy} onClick={() => void run(true)}>
          Preview
        </button>
        <button type="button" style={ui.primary} disabled={busy || !result?.preview} onClick={() => void run(false)}>
          Deploy
        </button>
      </div>
    </section>
  );
}

export interface ApplicationTemplatesPageProps {
  readonly tenantId: string;
  readonly api?: AppTemplatesApi;
}

export function ApplicationTemplatesPage({ tenantId, api }: ApplicationTemplatesPageProps) {
  const [client] = useState(() => api ?? createAppTemplatesApi());
  const [templates, setTemplates] = useState<readonly AppTemplate[] | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [deploying, setDeploying] = useState<AppTemplate | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      setTemplates(await client.list());
    } catch (err) {
      setError(errorText(err, "Failed to load templates."));
    }
  }, [client]);

  useEffect(() => {
    void load();
  }, [load]);

  async function save() {
    if (!draft) return;
    const parsed = parseJsonObject(draft.config);
    if ("error" in parsed) return setError(parsed.error);
    setBusy(true);
    setError(null);
    try {
      const saved = await client.save(draft.id, {
        name: draft.name,
        ...(draft.id ? {} : { appType: draft.appType }),
        config: parsed.value,
        variables: draft.variables.filter((v) => v.name.trim()).map((v) => ({
          name: v.name.trim(),
          ...(v.description?.trim() ? { description: v.description.trim() } : {}),
          ...(v.defaultValue?.trim() ? { defaultValue: v.defaultValue.trim() } : {}),
        })),
      });
      setNotice(`Saved ${saved.name}.`);
      setDraft(null);
      await load();
    } catch (err) {
      setError(errorText(err, "Save failed."));
    } finally {
      setBusy(false);
    }
  }

  async function remove(t: AppTemplate) {
    if (!window.confirm(`Delete the template '${t.name}'?`)) return;
    try {
      await client.remove(t.id);
      setNotice(`Deleted ${t.name}.`);
      await load();
    } catch (err) {
      setError(errorText(err, "Delete failed."));
    }
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "12px", color: "var(--text)" }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <h2 style={{ margin: 0, fontSize: "18px" }}>Application templates</h2>
        <button type="button" style={ui.primary} onClick={() => { setDraft({ id: null, name: "", appType: "win32", config: STARTER_CONFIG, variables: [{ name: "PackageId", description: "The app package ID on each tenant" }] }); setDeploying(null); }}>
          + New template
        </button>
      </div>
      {notice && <div role="status" style={ui.notice}>{notice}</div>}
      {error && <div role="alert" style={ui.error}>{error}</div>}
      {draft && <TemplateEditor draft={draft} onChange={setDraft} onSave={() => void save()} onCancel={() => setDraft(null)} busy={busy} />}
      {deploying && <DeployPanel template={deploying} api={client} defaultTenant={tenantId} onClose={() => setDeploying(null)} />}
      {templates === null && !error && <div style={ui.muted}>Loading templates…</div>}
      {templates && (
        <table aria-label="Application templates" style={ui.table}>
          <thead>
            <tr>
              <th style={ui.th}>Name</th>
              <th style={ui.th}>Type</th>
              <th style={ui.th}>Variables</th>
              <th style={ui.th}>Updated</th>
              <th style={ui.th}>Actions</th>
            </tr>
          </thead>
          <tbody>
            {templates.length === 0 ? (
              <tr>
                <td colSpan={5} style={{ ...ui.td, textAlign: "center", color: "var(--muted)" }}>
                  No application templates yet. Create one here or use Clone to template on the Applications page.
                </td>
              </tr>
            ) : (
              templates.map((t) => (
                <tr key={t.id} data-testid={`template-${t.id}`}>
                  <td style={ui.td}>{t.name}</td>
                  <td style={ui.td}>{t.appType === "win32" ? "Win32" : "Store"}</td>
                  <td style={ui.td}>{t.variables.map((v) => v.name).join(", ") || "—"}</td>
                  <td style={ui.td}>{new Date(t.updatedAt).toLocaleDateString()}</td>
                  <td style={ui.td}>
                    <span style={{ display: "flex", gap: "4px" }}>
                      <button type="button" style={ui.button} aria-label={`Deploy ${t.name}`} onClick={() => { setDeploying(t); setDraft(null); }}>
                        Deploy
                      </button>
                      <button
                        type="button"
                        style={ui.button}
                        aria-label={`Edit ${t.name}`}
                        onClick={() => { setDraft({ id: t.id, name: t.name, appType: t.appType, config: JSON.stringify(t.config, null, 2), variables: [...t.variables] }); setDeploying(null); }}
                      >
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
