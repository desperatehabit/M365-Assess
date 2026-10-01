"use client";

// Transport rule templates (EPIC-021 SPEC.md §3.3, §4.2, §5, §6, §11.3; T-0408).
// Nav: Email & Exchange → Transport → Templates. Title "Transport Rule Templates"
// with the §3.3 row actions (View, Edit, Clone, Deploy, Export, Delete). Templates
// persist through the T-0403 routes (`GET/POST/PATCH/DELETE
// /v1/transport-rule-templates`); Clone duplicates the stored template, Deploy
// resolves the template plus variables and applies per tenant through
// `POST /v1/transport-rule-templates/:id/deploy` on the EPIC-006 gated path with
// per-target partial failures reported (SPEC §4.2), and Export writes the
// template JSON to the browser only. No browser call reaches a tenant directly —
// every tenant-touching write goes through the BFF.

import React, { useCallback, useEffect, useState, type CSSProperties, type ReactElement } from "react";
import { useSearchParams } from "next/navigation";
import { RequireTenant } from "../../../../components/shell/RequireTenant";
import { resolveTenantId, useCurrentTenantId } from "../../../../lib/useCurrentTenant";

export type Fetcher = typeof fetch;

export const TRANSPORT_RULE_TEMPLATES_PATH = "/v1/transport-rule-templates";

export interface TemplateVariable {
  readonly name: string;
  readonly defaultValue?: string;
}

export interface TransportRuleTemplateItem {
  readonly id: string;
  readonly name: string;
  readonly ruleJson: Record<string, unknown>;
  readonly variables: readonly TemplateVariable[];
  readonly source: string;
  readonly createdAt?: string;
  readonly updatedAt?: string;
}

export interface DeployTargetPlan {
  readonly tenantId: string;
  readonly targetName: string;
  readonly diff: readonly string[];
}

export interface DeployTargetResult {
  readonly tenantId: string;
  readonly success: boolean;
  readonly before?: Record<string, unknown> | null;
  readonly after?: Record<string, unknown> | null;
  readonly error?: string | null;
}

export interface DeployResponse {
  readonly preview?: boolean;
  readonly payload?: Record<string, unknown>;
  readonly variables?: Record<string, string>;
  readonly targets?: readonly DeployTargetPlan[];
  readonly results?: readonly DeployTargetResult[];
  readonly success?: boolean;
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

function templateBasePath(id?: string): string {
  return id
    ? `${TRANSPORT_RULE_TEMPLATES_PATH}/${encodeURIComponent(id)}`
    : TRANSPORT_RULE_TEMPLATES_PATH;
}

export async function listTransportRuleTemplates(
  fetcher: Fetcher = fetch,
): Promise<TransportRuleTemplateItem[]> {
  const response = await fetcher(TRANSPORT_RULE_TEMPLATES_PATH);
  if (!response.ok) throw await readError(response, "List transport rule templates");
  const body = (await response.json()) as { items?: TransportRuleTemplateItem[] };
  return [...(body.items ?? [])];
}

export async function createTransportRuleTemplate(
  input: { readonly name: string; readonly ruleJson: Record<string, unknown>; readonly variables: readonly TemplateVariable[] },
  fetcher: Fetcher = fetch,
): Promise<TransportRuleTemplateItem> {
  const response = await fetcher(TRANSPORT_RULE_TEMPLATES_PATH, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ ...input, source: "local" }),
  });
  if (!response.ok) throw await readError(response, "Create transport rule template");
  return (await response.json()) as TransportRuleTemplateItem;
}

export async function updateTransportRuleTemplate(
  id: string,
  patch: { readonly name?: string; readonly ruleJson?: Record<string, unknown>; readonly variables?: readonly TemplateVariable[] },
  fetcher: Fetcher = fetch,
): Promise<TransportRuleTemplateItem> {
  const response = await fetcher(templateBasePath(id), {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(patch),
  });
  if (!response.ok) throw await readError(response, "Update transport rule template");
  return (await response.json()) as TransportRuleTemplateItem;
}

export async function cloneTransportRuleTemplate(
  id: string,
  name: string,
  fetcher: Fetcher = fetch,
): Promise<TransportRuleTemplateItem> {
  const response = await fetcher(`${templateBasePath(id)}/clone`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name }),
  });
  if (!response.ok) throw await readError(response, "Clone transport rule template");
  return (await response.json()) as TransportRuleTemplateItem;
}

export async function deleteTransportRuleTemplate(id: string, fetcher: Fetcher = fetch): Promise<void> {
  const response = await fetcher(templateBasePath(id), { method: "DELETE" });
  if (!response.ok) throw await readError(response, "Delete transport rule template");
}

export async function deployTransportRuleTemplate(
  id: string,
  input: { readonly targets: readonly string[]; readonly variables: Record<string, string>; readonly preview?: boolean },
  fetcher: Fetcher = fetch,
): Promise<DeployResponse> {
  const response = await fetcher(`${templateBasePath(id)}/deploy`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input),
  });
  let body: unknown = null;
  try {
    body = await response.json();
  } catch {
    body = null;
  }
  const record =
    body !== null && typeof body === "object" && !Array.isArray(body)
      ? (body as Record<string, unknown>)
      : null;
  // 207 (partial) and 422 (all failed) still carry the per-target results; only a
  // response with no results is a hard error (missing variable, out-of-scope target).
  if (!response.ok && !(record && Array.isArray(record["results"]))) {
    const message =
      record && typeof record["message"] === "string"
        ? (record["message"] as string)
        : `Deploy transport rule template: HTTP ${response.status}`;
    throw new Error(message);
  }
  return (record ?? {}) as DeployResponse;
}

/** The deploy form's initial values: each declared variable's default. */
export function variableDefaults(variables: readonly TemplateVariable[]): Record<string, string> {
  const values: Record<string, string> = {};
  for (const variable of variables) values[variable.name] = variable.defaultValue ?? "";
  return values;
}

/** The template JSON written to the browser by Export — never a tenant write. */
export function exportTemplateJson(template: TransportRuleTemplateItem): string {
  return JSON.stringify(
    {
      name: template.name,
      ruleJson: template.ruleJson,
      variables: template.variables,
      source: template.source,
    },
    null,
    2,
  );
}

export function downloadTemplateJson(template: TransportRuleTemplateItem): void {
  const url = URL.createObjectURL(
    new Blob([exportTemplateJson(template)], { type: "application/json" }),
  );
  const link = document.createElement("a");
  link.href = url;
  link.download = `${template.name.replace(/[^\w.-]+/g, "_")}.json`;
  link.click();
  URL.revokeObjectURL(url);
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
  maxWidth: "720px",
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
  width: "min(620px, 94vw)",
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

const preStyle: CSSProperties = {
  margin: 0,
  padding: "10px",
  background: "var(--input-bg, var(--bg))",
  border: "1px solid var(--border)",
  borderRadius: "6px",
  fontSize: "12px",
  whiteSpace: "pre-wrap",
  wordBreak: "break-word",
};

export interface TemplateDeployDrawerProps {
  readonly template: TransportRuleTemplateItem;
  readonly onClose: () => void;
  readonly fetcher: Fetcher;
}

export function TransportRuleTemplateDeployDrawer({
  template,
  onClose,
  fetcher,
}: TemplateDeployDrawerProps): ReactElement {
  const [targetsInput, setTargetsInput] = useState("");
  const [variables, setVariables] = useState<Record<string, string>>(() => variableDefaults(template.variables));
  const [plan, setPlan] = useState<DeployResponse | null>(null);
  const [results, setResults] = useState<readonly DeployTargetResult[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function targets(): string[] {
    return targetsInput
      .split(",")
      .map((entry) => entry.trim())
      .filter((entry) => entry.length > 0);
  }

  async function run(isPreview: boolean): Promise<void> {
    const list = targets();
    if (list.length === 0) {
      setError("At least one target tenant is required.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const response = await deployTransportRuleTemplate(
        template.id,
        { targets: list, variables, preview: isPreview },
        fetcher,
      );
      if (isPreview) {
        setPlan(response);
        setResults(null);
      } else {
        setResults(response.results ?? []);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  const succeeded = results?.filter((result) => result.success).length ?? 0;

  return (
    <div style={overlayStyle} role="dialog" aria-modal="true" aria-label={`Deploy ${template.name}`} data-testid="transport-rule-template-deploy-drawer">
      <div style={drawerStyle}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <h3 style={{ margin: 0 }}>Deploy — {template.name}</h3>
          <button type="button" style={buttonStyle} onClick={onClose} data-testid="transport-rule-template-deploy-close">Close</button>
        </div>
        <p style={{ margin: 0, color: "var(--text-soft)", fontSize: "14px" }}>
          Resolve the template and variables, preview the resolved rule, then apply per tenant. Partial failures are reported per target.
        </p>
        <label style={{ display: "flex", flexDirection: "column", gap: "6px", fontSize: "14px" }}>
          Target tenants (comma-separated)
          <input type="text" value={targetsInput} onChange={(e) => setTargetsInput(e.target.value)} style={inputStyle} aria-label="Target tenants" data-testid="transport-rule-template-deploy-targets" />
        </label>
        {template.variables.length === 0 ? (
          <p style={{ margin: 0, color: "var(--text-soft)", fontSize: "13px" }}>This template declares no variables.</p>
        ) : (
          <fieldset style={{ border: "1px solid var(--border)", borderRadius: "6px", padding: "12px", display: "flex", flexDirection: "column", gap: "10px" }}>
            <legend style={{ fontSize: "13px", color: "var(--text-soft)" }}>Variables</legend>
            {template.variables.map((variable) => (
              <label key={variable.name} style={{ display: "flex", flexDirection: "column", gap: "6px", fontSize: "14px" }}>
                {variable.name}
                <input
                  type="text"
                  value={variables[variable.name] ?? ""}
                  onChange={(e) => setVariables((prev) => ({ ...prev, [variable.name]: e.target.value }))}
                  style={inputStyle}
                  aria-label={variable.name}
                  data-testid={`transport-rule-template-deploy-variable-${variable.name}`}
                />
              </label>
            ))}
          </fieldset>
        )}
        {error && <div role="alert" style={{ color: "var(--danger-text)", fontSize: "14px" }} data-testid="transport-rule-template-deploy-error">{error}</div>}
        {plan && (
          <div style={{ display: "flex", flexDirection: "column", gap: "8px", fontSize: "14px" }} data-testid="transport-rule-template-deploy-preview">
            <div style={{ fontWeight: 600 }}>Resolved rule JSON</div>
            <pre style={preStyle} data-testid="transport-rule-template-deploy-payload">{JSON.stringify(plan.payload ?? {}, null, 2)}</pre>
            <div style={{ fontWeight: 600 }} data-testid="transport-rule-template-deploy-plan">
              Plan resolved for {plan.targets?.length ?? 0} target{(plan.targets?.length ?? 0) === 1 ? "" : "s"}.
            </div>
            {(plan.targets ?? []).map((target) => (
              <div key={target.tenantId} style={{ padding: "8px 10px", border: "1px solid var(--border)", borderRadius: "6px" }} data-testid={`transport-rule-template-deploy-plan-${target.tenantId}`}>
                <strong>{target.targetName}</strong>
                {target.diff.map((line, index) => (
                  <div key={index} style={{ color: "var(--text-soft)", fontSize: "13px" }}>{line}</div>
                ))}
              </div>
            ))}
          </div>
        )}
        <div style={{ display: "flex", gap: "8px", justifyContent: "flex-end" }}>
          <button type="button" style={buttonStyle} onClick={() => void run(true)} disabled={busy} data-testid="transport-rule-template-deploy-preview-button">Preview plan</button>
          <button type="button" style={{ ...primaryButtonStyle, ...(busy ? disabledStyle : {}) }} onClick={() => void run(false)} disabled={busy} data-testid="transport-rule-template-deploy-run">Deploy</button>
        </div>
        {results && (
          <div style={{ display: "flex", flexDirection: "column", gap: "8px" }} data-testid="transport-rule-template-deploy-results">
            <div style={{ fontSize: "14px", fontWeight: 600 }} data-testid="transport-rule-template-deploy-summary">
              {succeeded} of {results.length} targets succeeded.
            </div>
            {results.map((result) => (
              <div
                key={result.tenantId}
                style={{
                  padding: "10px 12px",
                  border: "1px solid var(--border)",
                  borderRadius: "6px",
                  background: result.success ? "var(--success-soft)" : "var(--danger-soft)",
                  color: result.success ? "var(--success-text)" : "var(--danger-text)",
                  fontSize: "13px",
                }}
                data-testid={`transport-rule-template-deploy-result-${result.tenantId}`}
              >
                <strong>{result.tenantId}</strong>: {result.success ? "succeeded" : "failed"}
                {!result.success && result.error ? ` — ${result.error}` : ""}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

export interface TransportRuleTemplatesViewProps {
  /** False disables write controls the caller lacks RBAC for. */
  readonly canWrite?: boolean;
  readonly fetcher?: Fetcher;
}

interface TemplateEditor {
  readonly mode: "create" | "edit";
  readonly template: TransportRuleTemplateItem | null;
  readonly name: string;
  readonly json: string;
  readonly variables: readonly TemplateVariable[];
}

function emptyVariable(): TemplateVariable {
  return { name: "", defaultValue: "" };
}

export function TransportRuleTemplatesView({
  canWrite = true,
  fetcher = fetch,
}: TransportRuleTemplatesViewProps): ReactElement {
  const [items, setItems] = useState<TransportRuleTemplateItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [viewing, setViewing] = useState<TransportRuleTemplateItem | null>(null);
  const [editing, setEditing] = useState<TemplateEditor | null>(null);
  const [deploying, setDeploying] = useState<TransportRuleTemplateItem | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async (): Promise<void> => {
    setLoading(true);
    setError(null);
    try {
      setItems(await listTransportRuleTemplates(fetcher));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [fetcher]);

  useEffect(() => {
    void load();
  }, [load]);

  async function runClone(template: TransportRuleTemplateItem): Promise<void> {
    setBusy(true);
    setNotice(null);
    try {
      await cloneTransportRuleTemplate(template.id, `${template.name} (copy)`, fetcher);
      setNotice(`Cloned “${template.name}”.`);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function runDelete(template: TransportRuleTemplateItem): Promise<void> {
    setBusy(true);
    setNotice(null);
    try {
      await deleteTransportRuleTemplate(template.id, fetcher);
      setNotice(`Deleted “${template.name}”.`);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  function runExport(template: TransportRuleTemplateItem): void {
    downloadTemplateJson(template);
    setNotice(`Exported “${template.name}”.`);
  }

  function openCreate(): void {
    setEditing({ mode: "create", template: null, name: "", json: "{\n  \n}", variables: [emptyVariable()] });
    setError(null);
  }

  function openEdit(template: TransportRuleTemplateItem): void {
    setEditing({
      mode: "edit",
      template,
      name: template.name,
      json: JSON.stringify(template.ruleJson, null, 2),
      variables: template.variables.length === 0 ? [emptyVariable()] : [...template.variables],
    });
    setError(null);
  }

  async function saveEdit(): Promise<void> {
    if (!editing) return;
    let ruleJson: Record<string, unknown>;
    try {
      const parsed = JSON.parse(editing.json) as unknown;
      if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
        throw new Error("not an object");
      }
      ruleJson = parsed as Record<string, unknown>;
    } catch {
      setError("Template JSON must be a JSON object.");
      return;
    }
    const variables = editing.variables
      .map((variable) => ({ ...variable, name: variable.name.trim() }))
      .filter((variable) => variable.name.length > 0);
    setBusy(true);
    setError(null);
    try {
      if (editing.mode === "edit" && editing.template) {
        await updateTransportRuleTemplate(editing.template.id, { name: editing.name, ruleJson, variables }, fetcher);
        setNotice(`Updated “${editing.name}”.`);
      } else {
        await createTransportRuleTemplate({ name: editing.name, ruleJson, variables }, fetcher);
        setNotice(`Created “${editing.name}”.`);
      }
      setEditing(null);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  const writeDisabled = !canWrite;
  const writeTitle = writeDisabled ? "Requires transport.write permission" : "";

  return (
    <div style={pageStyle} data-testid="transport-rule-templates-page">
      <div>
        <div style={{ fontSize: "12px", color: "var(--text-soft)" }}>Email &amp; Exchange &gt; Transport &gt; Templates</div>
        <h1 style={{ fontSize: "24px", fontWeight: 700, margin: "4px 0 0", fontFamily: "var(--font-display, var(--font-sans))" }}>
          Transport Rule Templates
        </h1>
        <p style={{ margin: "4px 0 0", color: "var(--text-soft)", fontSize: "14px" }}>
          Store reusable transport rules and deploy them across tenants with variable substitution. Partial failures are reported per target.
        </p>
      </div>

      <div style={{ display: "flex", gap: "8px", flexWrap: "wrap", alignItems: "center" }} data-testid="transport-rule-templates-toolbar">
        <button
          type="button"
          style={{ ...primaryButtonStyle, ...(writeDisabled ? disabledStyle : {}) }}
          disabled={writeDisabled}
          title={writeTitle}
          onClick={openCreate}
          data-testid="transport-rule-template-new"
        >
          New template
        </button>
      </div>

      {notice && (
        <div style={{ padding: "12px 16px", borderRadius: "6px", background: "var(--success-soft)", border: "1px solid var(--success)", color: "var(--success-text)", fontSize: "14px" }} data-testid="transport-rule-templates-notice">
          {notice}
        </div>
      )}
      {error && (
        <div role="alert" style={{ padding: "12px 16px", borderRadius: "6px", background: "var(--danger-soft)", border: "1px solid var(--danger)", color: "var(--danger-text)", fontSize: "14px" }} data-testid="transport-rule-templates-error">
          {error}
        </div>
      )}

      <div style={{ overflowX: "auto" }}>
        <table style={tableStyle} data-testid="transport-rule-templates-table">
          <thead>
            <tr>
              <th style={thStyle}>Name</th>
              <th style={thStyle}>Variables</th>
              <th style={thStyle}>Source</th>
              <th style={thStyle}>Updated</th>
              <th style={thStyle}>Actions</th>
            </tr>
          </thead>
          <tbody>
            {loading ? (
              <tr><td style={tdStyle} colSpan={5}>Loading transport rule templates…</td></tr>
            ) : items.length === 0 ? (
              <tr><td style={tdStyle} colSpan={5}>No transport rule templates found.</td></tr>
            ) : (
              items.map((template) => (
                <tr key={template.id} data-testid={`transport-rule-template-row-${template.id}`}>
                  <td style={tdStyle}>{template.name}</td>
                  <td style={tdStyle} data-testid={`transport-rule-template-variables-${template.id}`}>{template.variables.map((variable) => variable.name).join(", ") || "—"}</td>
                  <td style={tdStyle}>{template.source}</td>
                  <td style={tdStyle}>{template.updatedAt ?? "—"}</td>
                  <td style={tdStyle}>
                    <div style={{ display: "flex", gap: "6px", flexWrap: "wrap" }}>
                      <button type="button" style={buttonStyle} onClick={() => setViewing(template)} data-testid={`transport-rule-template-view-${template.id}`}>View</button>
                      <button type="button" style={writeDisabled ? { ...buttonStyle, ...disabledStyle } : buttonStyle} disabled={writeDisabled} title={writeTitle} onClick={() => openEdit(template)} data-testid={`transport-rule-template-edit-${template.id}`}>Edit</button>
                      <button type="button" style={writeDisabled ? { ...buttonStyle, ...disabledStyle } : buttonStyle} disabled={writeDisabled || busy} title={writeTitle} onClick={() => void runClone(template)} data-testid={`transport-rule-template-clone-${template.id}`}>Clone</button>
                      <button type="button" style={writeDisabled ? { ...buttonStyle, ...disabledStyle } : buttonStyle} disabled={writeDisabled} title={writeTitle} onClick={() => setDeploying(template)} data-testid={`transport-rule-template-deploy-${template.id}`}>Deploy</button>
                      <button type="button" style={buttonStyle} onClick={() => runExport(template)} data-testid={`transport-rule-template-export-${template.id}`}>Export</button>
                      <button type="button" style={writeDisabled ? { ...buttonStyle, ...disabledStyle } : buttonStyle} disabled={writeDisabled || busy} title={writeTitle} onClick={() => void runDelete(template)} data-testid={`transport-rule-template-delete-${template.id}`}>Delete</button>
                    </div>
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      {viewing && (
        <div style={overlayStyle} role="dialog" aria-modal="true" aria-label={`View ${viewing.name}`} data-testid="transport-rule-template-view-dialog">
          <div style={dialogStyle}>
            <h3 style={{ margin: 0 }}>{viewing.name}</h3>
            <pre style={preStyle} data-testid="transport-rule-template-view-body">{JSON.stringify(viewing.ruleJson, null, 2)}</pre>
            <div style={{ display: "flex", gap: "8px", justifyContent: "flex-end" }}>
              <button type="button" style={buttonStyle} onClick={() => setViewing(null)} data-testid="transport-rule-template-view-close">Close</button>
            </div>
          </div>
        </div>
      )}

      {editing && (
        <div style={overlayStyle} role="dialog" aria-modal="true" aria-label={editing.mode === "edit" ? "Edit template" : "New template"} data-testid="transport-rule-template-edit-dialog">
          <div style={dialogStyle}>
            <h3 style={{ margin: 0 }}>{editing.mode === "edit" ? `Edit template — ${editing.template?.name}` : "New transport rule template"}</h3>
            <label style={{ display: "flex", flexDirection: "column", gap: "6px", fontSize: "14px" }}>
              Name
              <input type="text" value={editing.name} onChange={(e) => setEditing({ ...editing, name: e.target.value })} style={inputStyle} aria-label="Template name" data-testid="transport-rule-template-edit-name" />
            </label>
            <label style={{ display: "flex", flexDirection: "column", gap: "6px", fontSize: "14px" }}>
              Rule JSON
              <textarea value={editing.json} onChange={(e) => setEditing({ ...editing, json: e.target.value })} style={{ ...inputStyle, minHeight: "160px", fontFamily: "var(--font-mono, monospace)" }} aria-label="Rule JSON" data-testid="transport-rule-template-edit-json" />
            </label>
            <fieldset style={{ border: "1px solid var(--border)", borderRadius: "6px", padding: "12px", display: "flex", flexDirection: "column", gap: "8px" }} data-testid="transport-rule-template-edit-variables">
              <legend style={{ fontSize: "12px", textTransform: "uppercase", letterSpacing: "0.07em", color: "var(--text-soft)" }}>Variables</legend>
              {editing.variables.map((variable, index) => (
                <div key={index} style={{ display: "flex", gap: "6px", flexWrap: "wrap" }}>
                  <input
                    type="text"
                    value={variable.name}
                    placeholder="name"
                    onChange={(e) => setEditing({ ...editing, variables: editing.variables.map((entry, i) => (i === index ? { ...entry, name: e.target.value } : entry)) })}
                    style={inputStyle}
                    aria-label={`Variable ${index + 1} name`}
                    data-testid={`transport-rule-template-edit-variable-name-${index}`}
                  />
                  <input
                    type="text"
                    value={variable.defaultValue ?? ""}
                    placeholder="default"
                    onChange={(e) => setEditing({ ...editing, variables: editing.variables.map((entry, i) => (i === index ? { ...entry, defaultValue: e.target.value } : entry)) })}
                    style={{ ...inputStyle, flex: 1, minWidth: "140px" }}
                    aria-label={`Variable ${index + 1} default`}
                    data-testid={`transport-rule-template-edit-variable-default-${index}`}
                  />
                  <button type="button" style={buttonStyle} onClick={() => setEditing({ ...editing, variables: editing.variables.filter((_, i) => i !== index) })} data-testid={`transport-rule-template-edit-variable-remove-${index}`}>Remove</button>
                </div>
              ))}
              <div>
                <button type="button" style={buttonStyle} onClick={() => setEditing({ ...editing, variables: [...editing.variables, emptyVariable()] })} data-testid="transport-rule-template-edit-variable-add">Add variable</button>
              </div>
            </fieldset>
            <div style={{ display: "flex", gap: "8px", justifyContent: "flex-end" }}>
              <button type="button" style={buttonStyle} onClick={() => setEditing(null)} data-testid="transport-rule-template-edit-cancel">Cancel</button>
              <button type="button" style={{ ...primaryButtonStyle, ...(busy || editing.name.trim().length === 0 ? disabledStyle : {}) }} disabled={busy || editing.name.trim().length === 0} onClick={() => void saveEdit()} data-testid="transport-rule-template-edit-save">Save</button>
            </div>
          </div>
        </div>
      )}

      {deploying && (
        <TransportRuleTemplateDeployDrawer template={deploying} onClose={() => setDeploying(null)} fetcher={fetcher} />
      )}
    </div>
  );
}

export default function TransportRuleTemplatesPage(): ReactElement {
  const searchParams = useSearchParams();
  const tenantId = resolveTenantId(searchParams.get("tenantId"), useCurrentTenantId());
  return (
    <RequireTenant tenantId={tenantId}>
      <TransportRuleTemplatesView />
    </RequireTenant>
  );
}
