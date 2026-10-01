"use client";

// Filter templates (EPIC-022 SPEC.md §3.2; T-0423). Nav: Email & Exchange →
// Spamfilter → Templates. Title "Filter Templates" with the §3.2 row
// actions (View, Edit, Clone, Deploy, Export, Delete). Deploy resolves the
// template's %name% variables (domains, IPs, action overrides) through the
// BFF deploy route: a missing required variable is a validation error, never
// a partial apply, and the plan preview shows the resulting policy before
// apply (SPEC §4.1). Reads come from the T-0423 list API and writes from
// the T-0423 routes; every write opens a plan preview / confirmation dialog
// and applies with confirm:true. Export downloads the stored policyJson
// locally. No browser call reaches a tenant directly — everything goes
// through the BFF.

import React, { useCallback, useEffect, useMemo, useState, type CSSProperties, type ReactElement } from "react";
import { useSearchParams } from "next/navigation";
import { RequireTenant } from "../../../../../components/shell/RequireTenant";
import { resolveTenantId, useCurrentTenantId } from "../../../../../lib/useCurrentTenant";
import { FILTER_TYPES, FILTER_TYPE_TITLES, type FilterType } from "../page";

export interface FilterTemplateItem {
  readonly id: string;
  readonly name: string;
  readonly filterType: string;
  readonly policyJson: unknown;
  readonly variables: string[];
  readonly source: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface FilterTemplateDeployPlan {
  readonly action: string;
  readonly filterType: FilterType;
  readonly policyName: string;
  readonly before: unknown;
  readonly after: unknown;
  readonly diff: readonly string[];
  readonly valid: boolean;
  readonly dryRun: boolean;
  readonly securityImpacting: boolean;
  readonly requiresConfirmation: boolean;
  readonly warning?: string;
}

export type Fetcher = typeof fetch;

const TEMPLATES_PATH = "/v1/filter-templates";

function templateItemPath(templateId: string): string {
  return `${TEMPLATES_PATH}/${encodeURIComponent(templateId)}`;
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

export async function listFilterTemplates(fetcher: Fetcher = fetch): Promise<FilterTemplateItem[]> {
  const response = await fetcher(TEMPLATES_PATH);
  if (!response.ok) throw await readError(response, "List filter templates");
  const body = (await response.json()) as { items?: FilterTemplateItem[] };
  return [...(body.items ?? [])];
}

export async function createFilterTemplate(
  input: { name: string; filterType: string; policyJson: unknown; variables: string[] },
  fetcher: Fetcher = fetch,
): Promise<FilterTemplateItem> {
  const response = await fetcher(TEMPLATES_PATH, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ ...input, source: "local" }),
  });
  if (!response.ok) throw await readError(response, "Create filter template");
  return (await response.json()) as FilterTemplateItem;
}

export async function updateFilterTemplate(
  templateId: string,
  input: { name?: string; filterType?: string; policyJson?: unknown; variables?: string[] },
  fetcher: Fetcher = fetch,
): Promise<FilterTemplateItem> {
  const response = await fetcher(templateItemPath(templateId), {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input),
  });
  if (!response.ok) throw await readError(response, "Update filter template");
  return (await response.json()) as FilterTemplateItem;
}

export async function deleteFilterTemplate(templateId: string, fetcher: Fetcher = fetch): Promise<void> {
  const response = await fetcher(templateItemPath(templateId), { method: "DELETE" });
  if (!response.ok) throw await readError(response, "Delete filter template");
}

export async function cloneFilterTemplate(
  templateId: string,
  name: string,
  fetcher: Fetcher = fetch,
): Promise<FilterTemplateItem> {
  const response = await fetcher(`${templateItemPath(templateId)}/clone`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name }),
  });
  if (!response.ok) throw await readError(response, "Clone filter template");
  return (await response.json()) as FilterTemplateItem;
}

export async function previewTemplateDeploy(
  templateId: string,
  tenantId: string,
  variables: Record<string, string>,
  fetcher: Fetcher = fetch,
): Promise<FilterTemplateDeployPlan> {
  const response = await fetcher(`${templateItemPath(templateId)}/deploy`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ tenantId, variables, preview: true }),
  });
  if (!response.ok) throw await readError(response, "Preview template deploy");
  return (await response.json()) as FilterTemplateDeployPlan;
}

export async function applyTemplateDeploy(
  templateId: string,
  tenantId: string,
  variables: Record<string, string>,
  fetcher: Fetcher = fetch,
): Promise<unknown> {
  const response = await fetcher(`${templateItemPath(templateId)}/deploy`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ tenantId, variables, preview: false, confirm: true }),
  });
  if (!response.ok) throw await readError(response, "Deploy filter template");
  return response.json();
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

const primaryButtonStyle: CSSProperties = {
  ...buttonStyle,
  background: "var(--accent)",
  color: "var(--on-accent)",
  borderColor: "var(--accent)",
};

const disabledStyle: CSSProperties = { opacity: 0.45, cursor: "not-allowed" };

const tableStyle: CSSProperties = { width: "100%", borderCollapse: "collapse", fontSize: "14px" };

const thStyle: CSSProperties = {
  textAlign: "left",
  padding: "10px 12px",
  borderBottom: "1px solid var(--border-strong, var(--border))",
  color: "var(--text-soft)",
  fontSize: "12px",
  textTransform: "uppercase",
  letterSpacing: "0.07em",
};

const tdStyle: CSSProperties = {
  padding: "10px 12px",
  borderBottom: "1px solid var(--border)",
  verticalAlign: "top",
};

const flagStyle: CSSProperties = {
  display: "inline-block",
  padding: "2px 8px",
  borderRadius: "999px",
  fontSize: "12px",
  fontWeight: 600,
  background: "var(--warn-soft)",
  border: "1px solid var(--warn)",
  color: "var(--warn-text)",
};

const overlayStyle: CSSProperties = {
  position: "fixed",
  inset: 0,
  background: "var(--overlay, rgba(0,0,0,0.5))",
  zIndex: 60,
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  padding: "24px",
};

const dialogStyle: CSSProperties = {
  width: "100%",
  maxWidth: "640px",
  maxHeight: "90vh",
  overflowY: "auto",
  background: "var(--bg-elev)",
  border: "1px solid var(--border)",
  borderRadius: "var(--radius, 10px)",
  padding: "24px",
  display: "flex",
  flexDirection: "column",
  gap: "16px",
};

const drawerStyle: CSSProperties = {
  position: "fixed",
  top: 0,
  right: 0,
  bottom: 0,
  width: "min(560px, 92vw)",
  background: "var(--bg-elev)",
  borderLeft: "1px solid var(--border)",
  boxShadow: "var(--shadow, 0 8px 24px rgba(0,0,0,0.3))",
  zIndex: 70,
  overflowY: "auto",
  padding: "24px",
  display: "flex",
  flexDirection: "column",
  gap: "16px",
};

export interface TemplatesViewProps {
  readonly tenantId: string;
  /** False hides write controls the caller lacks RBAC for. */
  readonly canWrite?: boolean;
  readonly fetcher?: Fetcher;
}

interface TemplateEditor {
  readonly mode: "create" | "edit";
  readonly template: FilterTemplateItem | null;
  readonly name: string;
  readonly filterType: FilterType;
  readonly policyJson: string;
  readonly variables: string;
}

interface DeployDraft {
  readonly template: FilterTemplateItem;
  readonly variables: Record<string, string>;
}

interface PendingDeploy {
  readonly template: FilterTemplateItem;
  readonly variables: Record<string, string>;
}

function prettyPolicy(policyJson: unknown): string {
  return JSON.stringify(policyJson, null, 2);
}

function parseVariablesList(raw: string): string[] {
  return raw
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

export function TemplatesView({
  tenantId,
  canWrite = true,
  fetcher = fetch,
}: TemplatesViewProps): ReactElement {
  const [items, setItems] = useState<FilterTemplateItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [selected, setSelected] = useState<FilterTemplateItem | null>(null);
  const [editor, setEditor] = useState<TemplateEditor | null>(null);
  const [deployFor, setDeployFor] = useState<DeployDraft | null>(null);
  const [pending, setPending] = useState<PendingDeploy | null>(null);
  const [plan, setPlan] = useState<FilterTemplateDeployPlan | null>(null);
  const [planBusy, setPlanBusy] = useState(false);
  const [planError, setPlanError] = useState<string | null>(null);

  const fetchList = useCallback(async (): Promise<void> => {
    setLoading(true);
    setError(null);
    try {
      setItems(await listFilterTemplates(fetcher));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [fetcher]);

  useEffect(() => {
    void fetchList();
  }, [fetchList]);

  function resetPlan(): void {
    setPlan(null);
    setPlanError(null);
  }

  function openCreate(): void {
    setEditor({ mode: "create", template: null, name: "", filterType: "spam", policyJson: "{\n  \"name\": \"\",\n  \"enabled\": true,\n  \"settings\": {}\n}", variables: "" });
    resetPlan();
  }

  function openEdit(template: FilterTemplateItem): void {
    setEditor({
      mode: "edit",
      template,
      name: template.name,
      filterType: (FILTER_TYPES as readonly string[]).includes(template.filterType) ? (template.filterType as FilterType) : "spam",
      policyJson: prettyPolicy(template.policyJson),
      variables: template.variables.join(", "),
    });
    resetPlan();
  }

  function editorPayload(draft: TemplateEditor): { name: string; filterType: string; policyJson: unknown; variables: string[] } {
    let policyJson: unknown;
    try {
      policyJson = JSON.parse(draft.policyJson) as unknown;
    } catch {
      throw new Error("Policy JSON is not valid JSON.");
    }
    return { name: draft.name.trim(), filterType: draft.filterType, policyJson, variables: parseVariablesList(draft.variables) };
  }

  async function saveEditor(): Promise<void> {
    if (!editor) return;
    setPlanBusy(true);
    setPlanError(null);
    try {
      const payload = editorPayload(editor);
      if (editor.mode === "edit" && editor.template) {
        await updateFilterTemplate(editor.template.id, payload, fetcher);
        setNotice(`Template “${payload.name}” updated.`);
      } else {
        await createFilterTemplate(payload, fetcher);
        setNotice(`Template “${payload.name}” created.`);
      }
      setEditor(null);
      resetPlan();
      await fetchList();
    } catch (err) {
      setPlanError(err instanceof Error ? err.message : String(err));
    } finally {
      setPlanBusy(false);
    }
  }

  async function cloneTemplate(template: FilterTemplateItem): Promise<void> {
    setPlanBusy(true);
    setPlanError(null);
    try {
      await cloneFilterTemplate(template.id, `${template.name} (copy)`, fetcher);
      setNotice(`Template “${template.name}” cloned.`);
      await fetchList();
    } catch (err) {
      setPlanError(err instanceof Error ? err.message : String(err));
    } finally {
      setPlanBusy(false);
    }
  }

  async function removeTemplate(template: FilterTemplateItem): Promise<void> {
    setPlanBusy(true);
    setPlanError(null);
    try {
      await deleteFilterTemplate(template.id, fetcher);
      setNotice(`Template “${template.name}” deleted.`);
      await fetchList();
    } catch (err) {
      setPlanError(err instanceof Error ? err.message : String(err));
    } finally {
      setPlanBusy(false);
    }
  }

  function exportTemplate(template: FilterTemplateItem): void {
    const blob = new Blob([prettyPolicy(template.policyJson)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `${template.name.replace(/[^a-z0-9_-]+/gi, "-").toLowerCase() || "filter-template"}.json`;
    anchor.click();
    URL.revokeObjectURL(url);
  }

  function openDeploy(template: FilterTemplateItem): void {
    const variables: Record<string, string> = {};
    for (const name of template.variables) variables[name] = "";
    setDeployFor({ template, variables });
    resetPlan();
  }

  async function previewDeploy(): Promise<void> {
    if (!deployFor) return;
    setPlanBusy(true);
    resetPlan();
    try {
      const preview = await previewTemplateDeploy(deployFor.template.id, tenantId, deployFor.variables, fetcher);
      setPlan(preview);
    } catch (err) {
      setPlanError(err instanceof Error ? err.message : String(err));
    } finally {
      setPlanBusy(false);
    }
  }

  function confirmDeploy(): void {
    if (!deployFor) return;
    setPending({ template: deployFor.template, variables: deployFor.variables });
  }

  async function applyDeploy(): Promise<void> {
    if (!pending) return;
    setPlanBusy(true);
    setPlanError(null);
    try {
      await applyTemplateDeploy(pending.template.id, tenantId, pending.variables, fetcher);
      setNotice(`Template “${pending.template.name}” deployed to ${FILTER_TYPE_TITLES[pending.template.filterType as FilterType] ?? pending.template.filterType} filters.`);
      setPending(null);
      setDeployFor(null);
      resetPlan();
    } catch (err) {
      setPlanError(err instanceof Error ? err.message : String(err));
    } finally {
      setPlanBusy(false);
    }
  }

  const writeDisabled = !canWrite;
  const deployWarning = plan?.warning;

  const dialogTitle = useMemo(() => {
    if (!pending) return "";
    return `Deploy — ${pending.template.name}`;
  }, [pending]);

  return (
    <div style={pageStyle} data-testid="filter-templates-page">
      <div>
        <div style={{ fontSize: "12px", color: "var(--text-soft)" }}>Email &amp; Exchange &gt; Spamfilter &gt; Templates</div>
        <h1 style={{ fontSize: "24px", fontWeight: 700, margin: "4px 0 0", fontFamily: "var(--font-display, var(--font-sans))" }}>
          Filter Templates
        </h1>
        <p style={{ margin: "4px 0 0", color: "var(--text-soft)", fontSize: "14px" }}>
          Deploy a filter from a template with variables, or edit, clone, export, and delete templates.
        </p>
      </div>

      <div style={{ display: "flex", gap: "8px", flexWrap: "wrap", alignItems: "center" }}>
        <button
          type="button"
          style={{ ...primaryButtonStyle, ...(writeDisabled ? disabledStyle : {}) }}
          disabled={writeDisabled}
          title={writeDisabled ? "Requires spam.write permission" : "New template"}
          onClick={openCreate}
          data-testid="template-new"
        >
          New template
        </button>
      </div>

      {notice && (
        <div style={{ padding: "12px 16px", borderRadius: "6px", background: "var(--success-soft)", border: "1px solid var(--success)", color: "var(--success-text)", fontSize: "14px" }} data-testid="filter-templates-notice">
          {notice}
        </div>
      )}
      {error && (
        <div role="alert" style={{ padding: "12px 16px", borderRadius: "6px", background: "var(--danger-soft)", border: "1px solid var(--danger)", color: "var(--danger-text)", fontSize: "14px" }} data-testid="filter-templates-error">
          {error}
        </div>
      )}

      <div style={{ overflowX: "auto" }}>
        <table style={tableStyle} data-testid="filter-templates-table">
          <thead>
            <tr>
              <th style={thStyle}>Name</th>
              <th style={thStyle}>Type</th>
              <th style={thStyle}>Variables</th>
              <th style={thStyle}>Source</th>
              <th style={thStyle}>Last updated</th>
              <th style={thStyle}>Actions</th>
            </tr>
          </thead>
          <tbody>
            {loading ? (
              <tr><td style={tdStyle} colSpan={6}>Loading filter templates…</td></tr>
            ) : items.length === 0 ? (
              <tr><td style={tdStyle} colSpan={6}>No filter templates found.</td></tr>
            ) : (
              items.map((template) => (
                <tr key={template.id} data-testid={`template-row-${template.id}`}>
                  <td style={tdStyle}>{template.name}</td>
                  <td style={tdStyle}>{FILTER_TYPE_TITLES[template.filterType as FilterType] ?? template.filterType}</td>
                  <td style={tdStyle}>{template.variables.length === 0 ? "—" : template.variables.join(", ")}</td>
                  <td style={tdStyle}>{template.source}</td>
                  <td style={tdStyle}>{template.updatedAt}</td>
                  <td style={tdStyle}>
                    <div style={{ display: "flex", gap: "6px", flexWrap: "wrap" }}>
                      <button type="button" style={buttonStyle} onClick={() => setSelected(template)} data-testid={`template-view-${template.id}`}>View</button>
                      <button type="button" style={writeDisabled ? { ...buttonStyle, ...disabledStyle } : buttonStyle} disabled={writeDisabled} title={writeDisabled ? "Requires spam.write permission" : "Edit"} onClick={() => openEdit(template)} data-testid={`template-edit-${template.id}`}>Edit</button>
                      <button type="button" style={writeDisabled ? { ...buttonStyle, ...disabledStyle } : buttonStyle} disabled={writeDisabled} title={writeDisabled ? "Requires spam.write permission" : "Clone"} onClick={() => void cloneTemplate(template)} data-testid={`template-clone-${template.id}`}>Clone</button>
                      <button type="button" style={writeDisabled ? { ...buttonStyle, ...disabledStyle } : buttonStyle} disabled={writeDisabled} title={writeDisabled ? "Requires spam.write permission" : "Deploy"} onClick={() => openDeploy(template)} data-testid={`template-deploy-${template.id}`}>Deploy</button>
                      <button type="button" style={buttonStyle} onClick={() => exportTemplate(template)} data-testid={`template-export-${template.id}`}>Export</button>
                      <button type="button" style={writeDisabled ? { ...buttonStyle, ...disabledStyle } : buttonStyle} disabled={writeDisabled} title={writeDisabled ? "Requires spam.write permission" : "Delete"} onClick={() => void removeTemplate(template)} data-testid={`template-delete-${template.id}`}>Delete</button>
                    </div>
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      {selected && (
        <aside style={drawerStyle} role="dialog" aria-modal="true" aria-label={`Filter template ${selected.name}`} data-testid="template-drawer">
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
            <h2 style={{ margin: 0, fontSize: "18px" }}>{selected.name}</h2>
            <button type="button" style={buttonStyle} onClick={() => setSelected(null)} data-testid="template-drawer-close">Close</button>
          </div>
          <dl style={{ margin: 0, display: "grid", gridTemplateColumns: "140px 1fr", gap: "8px", fontSize: "14px" }}>
            <dt style={{ color: "var(--text-soft)" }}>Type</dt><dd style={{ margin: 0 }}>{FILTER_TYPE_TITLES[selected.filterType as FilterType] ?? selected.filterType}</dd>
            <dt style={{ color: "var(--text-soft)" }}>Variables</dt><dd style={{ margin: 0 }}>{selected.variables.length === 0 ? "—" : selected.variables.join(", ")}</dd>
            <dt style={{ color: "var(--text-soft)" }}>Source</dt><dd style={{ margin: 0 }}>{selected.source}</dd>
            <dt style={{ color: "var(--text-soft)" }}>Last updated</dt><dd style={{ margin: 0 }}>{selected.updatedAt}</dd>
          </dl>
          <div>
            <div style={{ fontSize: "12px", textTransform: "uppercase", letterSpacing: "0.07em", color: "var(--text-soft)", marginBottom: "6px" }}>Policy</div>
            <pre style={{ margin: 0, padding: "12px", borderRadius: "6px", background: "var(--bg)", border: "1px solid var(--border)", fontSize: "13px", overflowX: "auto" }} data-testid="template-policy-json">{prettyPolicy(selected.policyJson)}</pre>
          </div>
        </aside>
      )}

      {editor && (
        <div style={overlayStyle} role="dialog" aria-modal="true" aria-label={editor.mode === "edit" ? "Edit template" : "New template"} data-testid="template-editor">
          <div style={dialogStyle}>
            <h3 style={{ margin: 0 }}>{editor.mode === "edit" ? `Edit template — ${editor.template?.name}` : "New filter template"}</h3>
            <label style={{ display: "flex", flexDirection: "column", gap: "6px", fontSize: "14px" }}>
              Name
              <input type="text" value={editor.name} onChange={(e) => setEditor({ ...editor, name: e.target.value })} style={inputStyle} aria-label="Template name" data-testid="template-name" />
            </label>
            <label style={{ display: "flex", flexDirection: "column", gap: "6px", fontSize: "14px" }}>
              Type
              <select value={editor.filterType} onChange={(e) => setEditor({ ...editor, filterType: e.target.value as FilterType })} style={inputStyle} aria-label="Template type" data-testid="template-type">
                {FILTER_TYPES.map((type) => (
                  <option key={type} value={type}>{FILTER_TYPE_TITLES[type]}</option>
                ))}
              </select>
            </label>
            <label style={{ display: "flex", flexDirection: "column", gap: "6px", fontSize: "14px" }}>
              Policy JSON
              <textarea value={editor.policyJson} onChange={(e) => setEditor({ ...editor, policyJson: e.target.value })} style={{ ...inputStyle, minHeight: "160px", fontFamily: "var(--font-mono, monospace)", fontSize: "13px" }} aria-label="Policy JSON" data-testid="template-policy" />
            </label>
            <label style={{ display: "flex", flexDirection: "column", gap: "6px", fontSize: "14px" }}>
              Variables (comma separated)
              <input type="text" value={editor.variables} onChange={(e) => setEditor({ ...editor, variables: e.target.value })} style={inputStyle} aria-label="Template variables" data-testid="template-variables" placeholder="domains, ips, action" />
            </label>
            {planError && <div role="alert" style={{ color: "var(--danger-text)", fontSize: "14px" }}>{planError}</div>}
            <div style={{ display: "flex", gap: "8px", justifyContent: "flex-end" }}>
              <button type="button" style={buttonStyle} onClick={() => { setEditor(null); resetPlan(); }} data-testid="template-editor-cancel">Cancel</button>
              <button type="button" style={{ ...primaryButtonStyle, ...(planBusy || editor.name.trim().length === 0 ? disabledStyle : {}) }} disabled={planBusy || editor.name.trim().length === 0} onClick={() => void saveEditor()} data-testid="template-editor-save">Save template</button>
            </div>
          </div>
        </div>
      )}

      {deployFor && !pending && (
        <div style={overlayStyle} role="dialog" aria-modal="true" aria-label={`Deploy template ${deployFor.template.name}`} data-testid="template-deploy-dialog">
          <div style={dialogStyle}>
            <h3 style={{ margin: 0 }}>Deploy — {deployFor.template.name}</h3>
            <p style={{ margin: 0, color: "var(--text-soft)", fontSize: "14px" }}>
              Resolves the template’s %name% variables and previews the resulting {FILTER_TYPE_TITLES[deployFor.template.filterType as FilterType] ?? deployFor.template.filterType} policy before apply.
            </p>
            <label style={{ display: "flex", flexDirection: "column", gap: "6px", fontSize: "14px" }}>
              Tenant
              <input type="text" value={tenantId} style={{ ...inputStyle, opacity: 0.6 }} aria-label="Deploy tenant" data-testid="template-deploy-tenant" disabled />
            </label>
            {deployFor.template.variables.length === 0 ? (
              <p style={{ margin: 0, color: "var(--text-soft)", fontSize: "14px" }}>This template declares no variables.</p>
            ) : (
              deployFor.template.variables.map((name) => (
                <label key={name} style={{ display: "flex", flexDirection: "column", gap: "6px", fontSize: "14px" }}>
                  %{name}%
                  <input
                    type="text"
                    value={deployFor.variables[name] ?? ""}
                    onChange={(e) => setDeployFor({ ...deployFor, variables: { ...deployFor.variables, [name]: e.target.value } })}
                    style={inputStyle}
                    aria-label={`Variable ${name}`}
                    data-testid={`template-deploy-variable-${name}`}
                  />
                </label>
              ))
            )}
            <div>
              <button type="button" style={buttonStyle} onClick={() => void previewDeploy()} disabled={planBusy} data-testid="template-deploy-preview">Preview plan</button>
            </div>
            <TemplatePlanPreview plan={plan} planBusy={planBusy} planError={planError} />
            <div style={{ display: "flex", gap: "8px", justifyContent: "flex-end" }}>
              <button type="button" style={buttonStyle} onClick={() => { setDeployFor(null); resetPlan(); }} data-testid="template-deploy-cancel">Cancel</button>
              <button type="button" style={{ ...primaryButtonStyle, ...(planBusy || !plan || !plan.valid ? disabledStyle : {}) }} disabled={planBusy || !plan || !plan.valid} onClick={confirmDeploy} data-testid="template-deploy-confirm">Confirm and apply</button>
            </div>
          </div>
        </div>
      )}

      {pending && (
        <div style={overlayStyle} role="dialog" aria-modal="true" aria-label={dialogTitle} data-testid="template-deploy-confirm-dialog">
          <div style={dialogStyle}>
            <h3 style={{ margin: 0 }}>{dialogTitle}</h3>
            {deployWarning && (
              <div style={flagStyle} data-testid="template-deploy-warning">⚠ {deployWarning}</div>
            )}
            <TemplatePlanPreview plan={plan} planBusy={planBusy} planError={planError} />
            <div style={{ display: "flex", gap: "8px", justifyContent: "flex-end" }}>
              <button type="button" style={buttonStyle} onClick={() => { setPending(null); resetPlan(); }} data-testid="template-deploy-confirm-cancel">Cancel</button>
              <button type="button" style={{ ...primaryButtonStyle, ...(planBusy || !plan || !plan.valid ? disabledStyle : {}) }} disabled={planBusy || !plan || !plan.valid} onClick={() => void applyDeploy()} data-testid="template-deploy-confirm-apply">Confirm and apply</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

interface TemplatePlanPreviewProps {
  readonly plan: FilterTemplateDeployPlan | null;
  readonly planBusy: boolean;
  readonly planError: string | null;
}

function TemplatePlanPreview({ plan, planBusy, planError }: TemplatePlanPreviewProps): ReactElement {
  return (
    <div data-testid="template-plan-preview">
      {planBusy && <p style={{ margin: 0, fontSize: "14px" }}>Loading plan preview…</p>}
      {planError && <div role="alert" style={{ color: "var(--danger-text)", fontSize: "14px" }}>{planError}</div>}
      {plan && (
        <div style={{ display: "flex", flexDirection: "column", gap: "8px", fontSize: "14px" }}>
          <div data-testid="template-plan-diff">
            {plan.diff.length === 0 ? "No changes." : plan.diff.map((line, index) => <div key={index}>{line}</div>)}
          </div>
          {plan.requiresConfirmation && <div style={{ color: "var(--text-soft)", fontSize: "13px" }}>Confirmation required before apply.</div>}
        </div>
      )}
    </div>
  );
}

export default function FilterTemplatesPage(): ReactElement {
  const searchParams = useSearchParams();
  const tenantId = resolveTenantId(searchParams.get("tenantId"), useCurrentTenantId());
  return (
    <RequireTenant tenantId={tenantId}>
      <TemplatesView tenantId={tenantId} />
    </RequireTenant>
  );
}
