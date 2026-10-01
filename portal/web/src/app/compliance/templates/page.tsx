"use client";

// Compliance templates (EPIC-030 SPEC.md §3.6, §4.2, §5, §6; T-0589).
// Nav: Security & Compliance → Purview Compliance → Templates. One shared page
// for the per-area titles (DLP Templates, Retention Templates, Label Templates,
// SIT Templates, Safe Links Templates). Row actions: View, Edit, Clone, Deploy,
// Export, Delete. Templates persist through the T-0586 routes
// (`GET/POST/PATCH/DELETE /v1/compliance-templates`); Deploy resolves the
// template plus variables, then applies per tenant through
// `POST /v1/compliance-templates/:id/deploy` on the EPIC-006 gated path, with
// per-target partial failures reported. Reads of tenant policy state stay live
// in Purview; this page only stores and deploys templates.

import React, { useCallback, useEffect, useState, type CSSProperties, type ReactElement } from "react";
import { useSearchParams } from "next/navigation";
import { RequireTenant } from "../../../components/shell/RequireTenant";
import { resolveTenantId, useCurrentTenantId } from "../../../lib/useCurrentTenant";

export type Fetcher = typeof fetch;

export const COMPLIANCE_AREAS = ["dlp", "retention", "label", "sit", "safelinks"] as const;

export type ComplianceArea = (typeof COMPLIANCE_AREAS)[number];

export const AREA_LABELS: Record<ComplianceArea, string> = {
  dlp: "DLP Templates",
  retention: "Retention Templates",
  label: "Label Templates",
  sit: "SIT Templates",
  safelinks: "Safe Links Templates",
};

export interface ComplianceTemplateItem {
  readonly id: string;
  readonly name: string;
  readonly area: ComplianceArea;
  readonly payload: Record<string, unknown>;
  readonly variables: Record<string, unknown>;
  readonly source: string;
  readonly createdAt?: string;
  readonly updatedAt?: string;
}

export interface DeployTargetResult {
  readonly tenantId: string;
  readonly success: boolean;
  readonly state?: string;
  readonly error?: string | null;
}

export interface DeployResponse {
  readonly success?: boolean;
  readonly results?: readonly DeployTargetResult[];
  readonly deployments?: readonly {
    readonly tenantId: string;
    readonly state?: string;
    readonly results?: readonly Record<string, unknown>[];
  }[];
}

function isArea(value: string | null): value is ComplianceArea {
  return value !== null && (COMPLIANCE_AREAS as readonly string[]).includes(value);
}

/** Normalizes the two deploy-response shapes into per-target results. */
export function normalizeDeployResults(response: DeployResponse): DeployTargetResult[] {
  if (Array.isArray(response.results)) {
    return response.results.map((result) => ({
      tenantId: result.tenantId,
      success: result.success === true,
      ...(result.state !== undefined ? { state: result.state } : {}),
      error: result.error ?? null,
    }));
  }
  if (Array.isArray(response.deployments)) {
    return response.deployments.map((deployment) => ({
      tenantId: deployment.tenantId,
      success: deployment.state === undefined || deployment.state === "succeeded",
      ...(deployment.state !== undefined ? { state: deployment.state } : {}),
      error: null,
    }));
  }
  return [];
}

function basePath(): string {
  return "/v1/compliance-templates";
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

export async function listTemplates(
  area: ComplianceArea,
  fetcher: Fetcher = fetch,
): Promise<ComplianceTemplateItem[]> {
  const response = await fetcher(`${basePath()}?area=${encodeURIComponent(area)}`);
  if (!response.ok) throw await readError(response, "List compliance templates");
  const body = (await response.json()) as { items?: ComplianceTemplateItem[] };
  return [...(body.items ?? [])];
}

export async function updateTemplate(
  id: string,
  patch: { readonly name?: string; readonly payload?: Record<string, unknown> },
  fetcher: Fetcher = fetch,
): Promise<ComplianceTemplateItem> {
  const response = await fetcher(`${basePath()}/${encodeURIComponent(id)}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(patch),
  });
  if (!response.ok) throw await readError(response, "Update compliance template");
  return (await response.json()) as ComplianceTemplateItem;
}

export async function cloneTemplate(
  template: ComplianceTemplateItem,
  fetcher: Fetcher = fetch,
): Promise<ComplianceTemplateItem> {
  const response = await fetcher(basePath(), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      name: `${template.name} (copy)`,
      area: template.area,
      payload: template.payload,
      variables: template.variables,
      source: template.source,
    }),
  });
  if (!response.ok) throw await readError(response, "Clone compliance template");
  return (await response.json()) as ComplianceTemplateItem;
}

export async function deleteTemplate(id: string, fetcher: Fetcher = fetch): Promise<void> {
  const response = await fetcher(`${basePath()}/${encodeURIComponent(id)}`, { method: "DELETE" });
  if (!response.ok) throw await readError(response, "Delete compliance template");
}

export async function deployTemplate(
  id: string,
  input: {
    readonly targets: readonly string[];
    readonly variables: Record<string, string>;
    readonly preview?: boolean;
  },
  fetcher: Fetcher = fetch,
): Promise<DeployResponse> {
  const response = await fetcher(`${basePath()}/${encodeURIComponent(id)}/deploy`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input),
  });
  if (!response.ok) throw await readError(response, "Deploy compliance template");
  return (await response.json()) as DeployResponse;
}

function downloadTemplate(template: ComplianceTemplateItem): void {
  const url = URL.createObjectURL(
    new Blob([JSON.stringify(template, null, 2)], { type: "application/json" }),
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

function variableKeys(template: ComplianceTemplateItem): string[] {
  return Object.keys(template.variables);
}

function variableDefaults(template: ComplianceTemplateItem): Record<string, string> {
  const values: Record<string, string> = {};
  for (const [key, value] of Object.entries(template.variables)) {
    values[key] = value === null || value === undefined ? "" : String(value);
  }
  return values;
}

export interface DeployDrawerProps {
  readonly template: ComplianceTemplateItem;
  readonly onClose: () => void;
  readonly fetcher: Fetcher;
}

export function TemplateDeployDrawer({ template, onClose, fetcher }: DeployDrawerProps): ReactElement {
  const [targetsInput, setTargetsInput] = useState("");
  const [variables, setVariables] = useState<Record<string, string>>(() => variableDefaults(template));
  const [preview, setPreview] = useState<DeployTargetResult[] | null>(null);
  const [results, setResults] = useState<DeployTargetResult[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const keys = variableKeys(template);

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
      const response = await deployTemplate(
        template.id,
        { targets: list, variables, preview: isPreview },
        fetcher,
      );
      const normalized = normalizeDeployResults(response);
      if (isPreview) setPreview(normalized);
      else setResults(normalized);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div style={overlayStyle} role="dialog" aria-modal="true" aria-label={`Deploy ${template.name}`} data-testid="template-deploy-drawer">
      <div style={drawerStyle}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <h3 style={{ margin: 0 }}>Deploy — {template.name}</h3>
          <button type="button" style={buttonStyle} onClick={onClose} data-testid="template-deploy-close">Close</button>
        </div>
        <p style={{ margin: 0, color: "var(--text-soft)", fontSize: "14px" }}>
          Resolve the template and variables, preview the plan, then apply per target. Partial failures are reported per tenant.
        </p>
        <label style={{ display: "flex", flexDirection: "column", gap: "6px", fontSize: "14px" }}>
          Target tenants (comma-separated)
          <input type="text" value={targetsInput} onChange={(e) => setTargetsInput(e.target.value)} style={inputStyle} aria-label="Target tenants" data-testid="template-deploy-targets" />
        </label>
        {keys.length === 0 ? (
          <p style={{ margin: 0, color: "var(--text-soft)", fontSize: "13px" }}>This template has no variables.</p>
        ) : (
          <fieldset style={{ border: "1px solid var(--border)", borderRadius: "6px", padding: "12px", display: "flex", flexDirection: "column", gap: "10px" }}>
            <legend style={{ fontSize: "13px", color: "var(--text-soft)" }}>Variables</legend>
            {keys.map((key) => (
              <label key={key} style={{ display: "flex", flexDirection: "column", gap: "6px", fontSize: "14px" }}>
                {key}
                <input
                  type="text"
                  value={variables[key] ?? ""}
                  onChange={(e) => setVariables((prev) => ({ ...prev, [key]: e.target.value }))}
                  style={inputStyle}
                  aria-label={key}
                  data-testid={`template-deploy-variable-${key}`}
                />
              </label>
            ))}
          </fieldset>
        )}
        {error && <div role="alert" style={{ color: "var(--danger-text)", fontSize: "14px" }} data-testid="template-deploy-error">{error}</div>}
        {preview && preview.length > 0 && (
          <div style={{ fontSize: "14px" }} data-testid="template-deploy-preview">
            Plan resolved for {preview.length} target{preview.length === 1 ? "" : "s"}.
          </div>
        )}
        <div style={{ display: "flex", gap: "8px", justifyContent: "flex-end" }}>
          <button type="button" style={buttonStyle} onClick={() => void run(true)} disabled={busy} data-testid="template-deploy-preview-button">Preview plan</button>
          <button type="button" style={{ ...primaryButtonStyle, ...(busy ? disabledStyle : {}) }} onClick={() => void run(false)} disabled={busy} data-testid="template-deploy-run">Deploy</button>
        </div>
        {results && (
          <div style={{ display: "flex", flexDirection: "column", gap: "8px" }} data-testid="template-deploy-results">
            <div style={{ fontSize: "14px", fontWeight: 600 }} data-testid="template-deploy-summary">
              {results.filter((result) => result.success).length} of {results.length} targets succeeded.
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
                data-testid={`template-deploy-result-${result.tenantId}`}
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

export interface TemplatesViewProps {
  readonly tenantId: string;
  readonly initialArea?: ComplianceArea;
  /** False disables write controls the caller lacks RBAC for. */
  readonly canWrite?: boolean;
  readonly fetcher?: Fetcher;
}

export function TemplatesView({
  tenantId,
  initialArea = "dlp",
  canWrite = true,
  fetcher = fetch,
}: TemplatesViewProps): ReactElement {
  const [area, setArea] = useState<ComplianceArea>(initialArea);
  const [items, setItems] = useState<ComplianceTemplateItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [viewing, setViewing] = useState<ComplianceTemplateItem | null>(null);
  const [editing, setEditing] = useState<{ template: ComplianceTemplateItem; name: string; payload: string } | null>(null);
  const [deploying, setDeploying] = useState<ComplianceTemplateItem | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(
    async (next: ComplianceArea): Promise<void> => {
      setLoading(true);
      setError(null);
      try {
        setItems(await listTemplates(next, fetcher));
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        setLoading(false);
      }
    },
    [fetcher],
  );

  useEffect(() => {
    void load(area);
  }, [area, load]);

  async function runClone(template: ComplianceTemplateItem): Promise<void> {
    setBusy(true);
    setNotice(null);
    try {
      await cloneTemplate(template, fetcher);
      setNotice(`Cloned “${template.name}”.`);
      await load(area);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function runDelete(template: ComplianceTemplateItem): Promise<void> {
    setBusy(true);
    setNotice(null);
    try {
      await deleteTemplate(template.id, fetcher);
      setNotice(`Deleted “${template.name}”.`);
      await load(area);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function saveEdit(): Promise<void> {
    if (!editing) return;
    let payload: Record<string, unknown>;
    try {
      payload = JSON.parse(editing.payload) as Record<string, unknown>;
    } catch {
      setError("Template payload must be valid JSON.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await updateTemplate(editing.template.id, { name: editing.name, payload }, fetcher);
      setNotice(`Updated “${editing.name}”.`);
      setEditing(null);
      await load(area);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  const writeDisabled = !canWrite;
  const writeTitle = writeDisabled ? "Requires purview.templates permission" : "";

  return (
    <div style={pageStyle} data-testid="compliance-templates-page">
      <div>
        <div style={{ fontSize: "12px", color: "var(--text-soft)" }}>Security &amp; Compliance &gt; Purview Compliance &gt; Templates</div>
        <h1 style={{ fontSize: "24px", fontWeight: 700, margin: "4px 0 0", fontFamily: "var(--font-display, var(--font-sans))" }}>
          Compliance Templates
        </h1>
        <p style={{ margin: "4px 0 0", color: "var(--text-soft)", fontSize: "14px" }}>
          Deploy a template across tenants with variables; partial failures are reported per target.
        </p>
      </div>

      <div style={{ display: "flex", gap: "8px", flexWrap: "wrap" }} data-testid="compliance-templates-areas">
        {COMPLIANCE_AREAS.map((candidate) => (
          <button
            key={candidate}
            type="button"
            style={candidate === area ? primaryButtonStyle : buttonStyle}
            onClick={() => setArea(candidate)}
            aria-pressed={candidate === area}
            data-testid={`compliance-templates-area-${candidate}`}
          >
            {AREA_LABELS[candidate]}
          </button>
        ))}
      </div>

      {notice && (
        <div style={{ padding: "12px 16px", borderRadius: "6px", background: "var(--success-soft)", border: "1px solid var(--success)", color: "var(--success-text)", fontSize: "14px" }} data-testid="compliance-templates-notice">
          {notice}
        </div>
      )}
      {error && (
        <div role="alert" style={{ padding: "12px 16px", borderRadius: "6px", background: "var(--danger-soft)", border: "1px solid var(--danger)", color: "var(--danger-text)", fontSize: "14px" }} data-testid="compliance-templates-error">
          {error}
        </div>
      )}

      <h2 style={{ margin: 0, fontSize: "18px", fontWeight: 700, fontFamily: "var(--font-display, var(--font-sans))" }} data-testid="compliance-templates-title">
        {AREA_LABELS[area]}
      </h2>

      <div style={{ overflowX: "auto" }}>
        <table style={tableStyle} data-testid="compliance-templates-table">
          <thead>
            <tr>
              <th style={thStyle}>Name</th>
              <th style={thStyle}>Area</th>
              <th style={thStyle}>Variables</th>
              <th style={thStyle}>Source</th>
              <th style={thStyle}>Updated</th>
              <th style={thStyle}>Actions</th>
            </tr>
          </thead>
          <tbody>
            {loading ? (
              <tr><td style={tdStyle} colSpan={6}>Loading templates…</td></tr>
            ) : items.length === 0 ? (
              <tr><td style={tdStyle} colSpan={6}>No templates found for this area.</td></tr>
            ) : (
              items.map((template) => (
                <tr key={template.id} data-testid={`templates-row-${template.id}`}>
                  <td style={tdStyle}>{template.name}</td>
                  <td style={tdStyle}>{template.area}</td>
                  <td style={tdStyle} data-testid={`templates-variables-${template.id}`}>{variableKeys(template).join(", ") || "—"}</td>
                  <td style={tdStyle}>{template.source}</td>
                  <td style={tdStyle}>{template.updatedAt ?? "—"}</td>
                  <td style={tdStyle}>
                    <div style={{ display: "flex", gap: "6px", flexWrap: "wrap" }}>
                      <button type="button" style={buttonStyle} onClick={() => setViewing(template)} data-testid={`templates-view-${template.id}`}>View</button>
                      <button type="button" style={writeDisabled ? { ...buttonStyle, ...disabledStyle } : buttonStyle} disabled={writeDisabled} title={writeTitle} onClick={() => setEditing({ template, name: template.name, payload: JSON.stringify(template.payload, null, 2) })} data-testid={`templates-edit-${template.id}`}>Edit</button>
                      <button type="button" style={writeDisabled ? { ...buttonStyle, ...disabledStyle } : buttonStyle} disabled={writeDisabled || busy} title={writeTitle} onClick={() => void runClone(template)} data-testid={`templates-clone-${template.id}`}>Clone</button>
                      <button type="button" style={writeDisabled ? { ...buttonStyle, ...disabledStyle } : buttonStyle} disabled={writeDisabled} title={writeTitle} onClick={() => setDeploying(template)} data-testid={`templates-deploy-${template.id}`}>Deploy</button>
                      <button type="button" style={buttonStyle} onClick={() => downloadTemplate(template)} data-testid={`templates-export-${template.id}`}>Export</button>
                      <button type="button" style={writeDisabled ? { ...buttonStyle, ...disabledStyle } : buttonStyle} disabled={writeDisabled || busy} title={writeTitle} onClick={() => void runDelete(template)} data-testid={`templates-delete-${template.id}`}>Delete</button>
                    </div>
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      {viewing && (
        <div style={overlayStyle} role="dialog" aria-modal="true" aria-label={`View ${viewing.name}`} data-testid="template-view-dialog">
          <div style={dialogStyle}>
            <h3 style={{ margin: 0 }}>{viewing.name}</h3>
            <pre style={preStyle} data-testid="template-view-body">{JSON.stringify(viewing.payload, null, 2)}</pre>
            <div style={{ display: "flex", gap: "8px", justifyContent: "flex-end" }}>
              <button type="button" style={buttonStyle} onClick={() => setViewing(null)} data-testid="template-view-close">Close</button>
            </div>
          </div>
        </div>
      )}

      {editing && (
        <div style={overlayStyle} role="dialog" aria-modal="true" aria-label={`Edit ${editing.template.name}`} data-testid="template-edit-dialog">
          <div style={dialogStyle}>
            <h3 style={{ margin: 0 }}>Edit template — {editing.template.name}</h3>
            <label style={{ display: "flex", flexDirection: "column", gap: "6px", fontSize: "14px" }}>
              Name
              <input type="text" value={editing.name} onChange={(e) => setEditing({ ...editing, name: e.target.value })} style={inputStyle} aria-label="Template name" data-testid="template-edit-name" />
            </label>
            <label style={{ display: "flex", flexDirection: "column", gap: "6px", fontSize: "14px" }}>
              Payload (JSON)
              <textarea value={editing.payload} onChange={(e) => setEditing({ ...editing, payload: e.target.value })} style={{ ...inputStyle, minHeight: "160px", fontFamily: "var(--font-mono, monospace)" }} aria-label="Template payload" data-testid="template-edit-payload" />
            </label>
            <div style={{ display: "flex", gap: "8px", justifyContent: "flex-end" }}>
              <button type="button" style={buttonStyle} onClick={() => setEditing(null)} data-testid="template-edit-cancel">Cancel</button>
              <button type="button" style={{ ...primaryButtonStyle, ...(busy || editing.name.trim().length === 0 ? disabledStyle : {}) }} disabled={busy || editing.name.trim().length === 0} onClick={() => void saveEdit()} data-testid="template-edit-save">Save</button>
            </div>
          </div>
        </div>
      )}

      {deploying && (
        <TemplateDeployDrawer template={deploying} onClose={() => setDeploying(null)} fetcher={fetcher} />
      )}
    </div>
  );
}

export default function TemplatesPage(): ReactElement {
  const searchParams = useSearchParams();
  const tenantId = resolveTenantId(searchParams.get("tenantId"), useCurrentTenantId());
  const areaParam = searchParams.get("area");
  return (
    <RequireTenant tenantId={tenantId}>
      <TemplatesView tenantId={tenantId} initialArea={isArea(areaParam) ? areaParam : "dlp"} />
    </RequireTenant>
  );
}
