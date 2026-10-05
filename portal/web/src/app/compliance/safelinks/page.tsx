"use client";

// Safe Links policies (EPIC-030 SPEC.md §3.5, §4.1, §8; T-0588).
// Nav: Security & Compliance → Safe Links. Title "Safe Links Policies". Table:
// Name · State · Key settings (URL rewriting, scan on click, detonation) · Last
// modified. Row actions: View, Edit, Enable/Disable, Clone to template, Delete.
// Reads come from the T-0585 GET route; create/edit/enable/disable/delete apply
// through the T-0585 change routes on the EPIC-006 gated path. The change routes
// support a real plan preview (`preview:true`), so the editor and the action
// dialog fetch the before/after plan from the BFF before apply; disable and
// delete are compliance-impacting and require confirmation. No browser call
// reaches a tenant directly.

import React, { useCallback, useEffect, useState, type CSSProperties, type ReactElement } from "react";
import { useSearchParams } from "next/navigation";
import { RequireTenant } from "../../../components/shell/RequireTenant";
import { resolveTenantId, useCurrentTenantId } from "../../../lib/useCurrentTenant";

export type Fetcher = typeof fetch;
export type SafeLinksMethod = "POST" | "PATCH" | "DELETE";

export interface SafeLinksPolicyItem {
  readonly id: string;
  readonly name: string;
  readonly state: string;
  readonly urlRewriting: boolean;
  readonly scanOnClick: boolean;
  readonly detonation: boolean;
  readonly lastModified: string | null;
}

export interface SafeLinksPlan {
  readonly action: string;
  readonly policyId?: string;
  readonly targetName: string;
  readonly before?: Record<string, unknown> | null;
  readonly after?: Record<string, unknown> | null;
  readonly diff: readonly string[];
  readonly valid: boolean;
  readonly dryRun: boolean;
  readonly requiresConfirmation: boolean;
}

export const SAFELINKS_COMPLIANCE_WARNING =
  "Disabling or deleting a Safe Links policy weakens link protection. Review the before/after plan, then confirm. The change is audited with before/after.";

/** Builds the BFF query string for GET /v1/tenants/:id/safelinks. */
export function buildSafeLinksQuery(filter: { readonly search?: string; readonly state?: string }, limit = 100): string {
  const params = new URLSearchParams();
  if (filter.search) params.set("search", filter.search);
  if (filter.state) params.set("state", filter.state);
  params.set("limit", String(limit));
  return `?${params.toString()}`;
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

function basePath(tenantId: string): string {
  return `/v1/tenants/${encodeURIComponent(tenantId)}/safelinks`;
}

function itemPath(tenantId: string, policyId: string | null): string {
  return policyId ? `${basePath(tenantId)}/${encodeURIComponent(policyId)}` : basePath(tenantId);
}

export async function listSafeLinksPolicies(
  tenantId: string,
  filter: { readonly search?: string; readonly state?: string },
  fetcher: Fetcher = fetch,
): Promise<{ items: SafeLinksPolicyItem[]; nextCursor: string | null }> {
  const response = await fetcher(`${basePath(tenantId)}${buildSafeLinksQuery(filter)}`);
  if (!response.ok) throw await readError(response, "List Safe Links policies");
  const body = (await response.json()) as { items?: SafeLinksPolicyItem[]; nextCursor?: string | null };
  return { items: [...(body.items ?? [])], nextCursor: body.nextCursor ?? null };
}

/** Fetches the worker plan preview (preview:true) without a tenant write. */
export async function previewSafeLinksChange(
  tenantId: string,
  policyId: string | null,
  method: SafeLinksMethod,
  payload: Record<string, unknown>,
  fetcher: Fetcher = fetch,
): Promise<SafeLinksPlan> {
  const response = await fetcher(itemPath(tenantId, policyId), {
    method,
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ ...payload, preview: true }),
  });
  if (!response.ok) throw await readError(response, "Preview Safe Links change");
  return (await response.json()) as SafeLinksPlan;
}

/** Applies a plan through the T-0585 change routes (EPIC-006 gated path). */
export async function applySafeLinksChange(
  tenantId: string,
  policyId: string | null,
  method: SafeLinksMethod,
  payload: Record<string, unknown>,
  fetcher: Fetcher = fetch,
): Promise<unknown> {
  const response = await fetcher(itemPath(tenantId, policyId), {
    method,
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ ...payload, preview: false, confirm: true }),
  });
  if (!response.ok) throw await readError(response, "Apply Safe Links change");
  return response.json();
}

/** Saves the policy as a local compliance template (SPEC §5/§6; T-0586 route). */
export async function saveSafeLinksTemplate(
  name: string,
  payload: Record<string, unknown>,
  fetcher: Fetcher = fetch,
): Promise<unknown> {
  const response = await fetcher("/v1/compliance-templates", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ area: "safelinks", name, payload, variables: {}, source: "local" }),
  });
  if (!response.ok) throw await readError(response, "Save Safe Links template");
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
  padding: "8px 12px",
  borderRadius: "6px",
  fontSize: "13px",
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

const planGridStyle: CSSProperties = {
  display: "grid",
  gridTemplateColumns: "1fr 1fr",
  gap: "12px",
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

function yesNo(value: boolean): string {
  return value ? "Yes" : "No";
}

export interface SafeLinksViewProps {
  readonly tenantId: string;
  /** False disables write controls the caller lacks RBAC for. */
  readonly canWrite?: boolean;
  readonly fetcher?: Fetcher;
}

interface EditorState {
  readonly mode: "create" | "edit";
  readonly policy: SafeLinksPolicyItem | null;
  readonly name: string;
  readonly enabled: boolean;
  readonly urlRewriting: boolean;
  readonly scanOnClick: boolean;
  readonly detonation: boolean;
}

interface PendingWrite {
  readonly label: string;
  readonly policyId: string | null;
  readonly method: SafeLinksMethod;
  readonly payload: Record<string, unknown>;
}

function settingsOf(draft: EditorState): Record<string, unknown> {
  return {
    isEnabled: draft.enabled,
    urlRewriting: draft.urlRewriting,
    scanOnClick: draft.scanOnClick,
    detonation: draft.detonation,
  };
}

function editorWrite(draft: EditorState): { method: SafeLinksMethod; policyId: string | null; payload: Record<string, unknown> } {
  if (draft.mode === "create") {
    return { method: "POST", policyId: null, payload: { name: draft.name.trim(), settings: settingsOf(draft) } };
  }
  const wasEnabled = draft.policy?.state === "enabled";
  const action = !draft.enabled && wasEnabled ? "disable" : draft.enabled && !wasEnabled ? "enable" : "edit";
  return {
    method: "PATCH",
    policyId: draft.policy?.id ?? null,
    payload: { action, settings: settingsOf(draft) },
  };
}

export function SafeLinksView({ tenantId, canWrite = true, fetcher = fetch }: SafeLinksViewProps): ReactElement {
  const [filter, setFilter] = useState<{ search?: string; state?: string }>({});
  const [items, setItems] = useState<SafeLinksPolicyItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [selected, setSelected] = useState<SafeLinksPolicyItem | null>(null);
  const [editor, setEditor] = useState<EditorState | null>(null);
  const [pending, setPending] = useState<PendingWrite | null>(null);
  const [plan, setPlan] = useState<SafeLinksPlan | null>(null);
  const [busy, setBusy] = useState(false);
  const [planError, setPlanError] = useState<string | null>(null);
  const [templateFor, setTemplateFor] = useState<SafeLinksPolicyItem | null>(null);
  const [templateName, setTemplateName] = useState("");

  const fetchList = useCallback(
    async (next: { search?: string; state?: string }): Promise<void> => {
      setLoading(true);
      setError(null);
      try {
        const page = await listSafeLinksPolicies(tenantId, next, fetcher);
        setItems(page.items);
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        setLoading(false);
      }
    },
    [tenantId, fetcher],
  );

  useEffect(() => {
    void fetchList(filter);
  }, [tenantId, fetchList, filter]);

  function resetPlan(): void {
    setPlan(null);
    setPlanError(null);
  }

  function openCreate(): void {
    setEditor({
      mode: "create",
      policy: null,
      name: "",
      enabled: true,
      urlRewriting: true,
      scanOnClick: true,
      detonation: false,
    });
    resetPlan();
  }

  function openEdit(policy: SafeLinksPolicyItem): void {
    setEditor({
      mode: "edit",
      policy,
      name: policy.name,
      enabled: policy.state === "enabled",
      urlRewriting: policy.urlRewriting,
      scanOnClick: policy.scanOnClick,
      detonation: policy.detonation,
    });
    resetPlan();
  }

  async function previewEditor(): Promise<void> {
    if (!editor) return;
    resetPlan();
    if (editor.mode === "create" && editor.name.trim().length === 0) {
      setPlanError("Name is required.");
      return;
    }
    const write = editorWrite(editor);
    setBusy(true);
    try {
      setPlan(await previewSafeLinksChange(tenantId, write.policyId, write.method, write.payload, fetcher));
    } catch (err) {
      setPlanError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function confirmEditor(): Promise<void> {
    if (!editor) return;
    const write = editorWrite(editor);
    setBusy(true);
    setPlanError(null);
    try {
      await applySafeLinksChange(tenantId, write.policyId, write.method, write.payload, fetcher);
      setNotice(`Safe Links policy ${editor.mode === "edit" ? "updated" : "created"}.`);
      setEditor(null);
      resetPlan();
      await fetchList(filter);
    } catch (err) {
      setPlanError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function runPreview(next: PendingWrite): Promise<void> {
    setPending(next);
    resetPlan();
    setBusy(true);
    try {
      setPlan(await previewSafeLinksChange(tenantId, next.policyId, next.method, next.payload, fetcher));
    } catch (err) {
      setPlanError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  function toggle(policy: SafeLinksPolicyItem): void {
    const enable = policy.state !== "enabled";
    void runPreview({
      label: enable ? "Enable" : "Disable",
      policyId: policy.id,
      method: "PATCH",
      payload: { action: enable ? "enable" : "disable", settings: { isEnabled: enable } },
    });
  }

  function removePolicy(policy: SafeLinksPolicyItem): void {
    void runPreview({
      label: "Delete",
      policyId: policy.id,
      method: "DELETE",
      payload: { confirmName: policy.name },
    });
  }

  async function confirmPending(): Promise<void> {
    if (!pending) return;
    setBusy(true);
    setPlanError(null);
    try {
      await applySafeLinksChange(tenantId, pending.policyId, pending.method, pending.payload, fetcher);
      setNotice(`${pending.label} applied${plan?.targetName ? ` to “${plan.targetName}”` : ""}.`);
      setPending(null);
      resetPlan();
      await fetchList(filter);
    } catch (err) {
      setPlanError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function saveTemplate(): Promise<void> {
    if (!templateFor) return;
    setBusy(true);
    setPlanError(null);
    try {
      await saveSafeLinksTemplate(
        templateName.trim() || `${templateFor.name} template`,
        {
          name: templateFor.name,
          enabled: templateFor.state === "enabled",
          urlRewriting: templateFor.urlRewriting,
          scanOnClick: templateFor.scanOnClick,
          detonation: templateFor.detonation,
        },
        fetcher,
      );
      setNotice(`Template saved from “${templateFor.name}”.`);
      setTemplateFor(null);
      setTemplateName("");
    } catch (err) {
      setPlanError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  const writeDisabled = !canWrite;
  const writeTitle = writeDisabled ? "Requires Purview.Compliance.ReadWrite permission" : "";
  const activePlan = plan;

  return (
    <div style={pageStyle} data-testid="compliance-safelinks-page">
      <div>
        <div style={{ fontSize: "12px", color: "var(--text-soft)" }}>Security &amp; Compliance &gt; Safe Links</div>
        <h1 style={{ fontSize: "24px", fontWeight: 700, margin: "4px 0 0", fontFamily: "var(--font-display, var(--font-sans))" }}>
          Safe Links Policies
        </h1>
        <p style={{ margin: "4px 0 0", color: "var(--text-soft)", fontSize: "14px" }}>
          Preview the worker plan before every apply. Disabling a policy is compliance-impacting.
        </p>
      </div>

      <div style={{ display: "flex", gap: "8px", flexWrap: "wrap", alignItems: "center" }} data-testid="compliance-safelinks-filters">
        <input
          type="text"
          placeholder="Search policy name..."
          value={filter.search ?? ""}
          onChange={(e) => setFilter((prev) => ({ ...prev, search: e.target.value || undefined }))}
          style={inputStyle}
          aria-label="Search Safe Links policies"
          data-testid="compliance-safelinks-search"
        />
        <select
          value={filter.state ?? ""}
          onChange={(e) => setFilter((prev) => ({ ...prev, state: e.target.value || undefined }))}
          style={inputStyle}
          aria-label="Filter by state"
          data-testid="compliance-safelinks-filter-state"
        >
          <option value="">All states</option>
          <option value="enabled">Enabled</option>
          <option value="disabled">Disabled</option>
        </select>
        <button
          type="button"
          style={{ ...primaryButtonStyle, ...(writeDisabled ? disabledStyle : {}) }}
          disabled={writeDisabled}
          title={writeTitle || "New policy"}
          onClick={openCreate}
          data-testid="compliance-safelinks-new"
        >
          New policy
        </button>
      </div>

      {notice && (
        <div style={{ padding: "12px 16px", borderRadius: "6px", background: "var(--success-soft)", border: "1px solid var(--success)", color: "var(--success-text)", fontSize: "14px" }} data-testid="compliance-safelinks-notice">
          {notice}
        </div>
      )}
      {error && (
        <div role="alert" style={{ padding: "12px 16px", borderRadius: "6px", background: "var(--danger-soft)", border: "1px solid var(--danger)", color: "var(--danger-text)", fontSize: "14px" }} data-testid="compliance-safelinks-error">
          {error}
        </div>
      )}

      <div style={{ overflowX: "auto" }}>
        <table style={tableStyle} data-testid="compliance-safelinks-table">
          <thead>
            <tr>
              <th style={thStyle}>Name</th>
              <th style={thStyle}>State</th>
              <th style={thStyle}>Key settings</th>
              <th style={thStyle}>Last modified</th>
              <th style={thStyle}>Actions</th>
            </tr>
          </thead>
          <tbody>
            {loading ? (
              <tr><td style={tdStyle} colSpan={5}>Loading Safe Links policies…</td></tr>
            ) : items.length === 0 ? (
              <tr><td style={tdStyle} colSpan={5}>No Safe Links policies found.</td></tr>
            ) : (
              items.map((policy) => {
                const enabled = policy.state === "enabled";
                return (
                  <tr key={policy.id} data-testid={`safelinks-row-${policy.id}`}>
                    <td style={tdStyle}>{policy.name}</td>
                    <td style={tdStyle}>{enabled ? "Enabled" : "Disabled"}</td>
                    <td style={tdStyle} data-testid={`safelinks-settings-${policy.id}`}>
                      {`URL rewriting: ${yesNo(policy.urlRewriting)}; Scan on click: ${yesNo(policy.scanOnClick)}; Detonation: ${yesNo(policy.detonation)}`}
                    </td>
                    <td style={tdStyle}>{policy.lastModified ?? "—"}</td>
                    <td style={tdStyle}>
                      <div style={{ display: "flex", gap: "6px", flexWrap: "wrap" }}>
                        <button type="button" style={buttonStyle} onClick={() => setSelected(policy)} data-testid={`safelinks-view-${policy.id}`}>View</button>
                        <button type="button" style={writeDisabled ? { ...buttonStyle, ...disabledStyle } : buttonStyle} disabled={writeDisabled} title={writeTitle} onClick={() => openEdit(policy)} data-testid={`safelinks-edit-${policy.id}`}>Edit</button>
                        <button type="button" style={writeDisabled ? { ...buttonStyle, ...disabledStyle } : buttonStyle} disabled={writeDisabled} title={writeTitle} onClick={() => toggle(policy)} data-testid={`safelinks-toggle-${policy.id}`}>{enabled ? "Disable" : "Enable"}</button>
                        <button type="button" style={writeDisabled ? { ...buttonStyle, ...disabledStyle } : buttonStyle} disabled={writeDisabled} title={writeTitle} onClick={() => { setTemplateFor(policy); setTemplateName(`${policy.name} template`); resetPlan(); }} data-testid={`safelinks-clone-template-${policy.id}`}>Clone to template</button>
                        <button type="button" style={writeDisabled ? { ...buttonStyle, ...disabledStyle } : buttonStyle} disabled={writeDisabled} title={writeTitle} onClick={() => removePolicy(policy)} data-testid={`safelinks-delete-${policy.id}`}>Delete</button>
                      </div>
                    </td>
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>

      {selected && (
        <aside style={drawerStyle} role="dialog" aria-modal="true" aria-label={`Safe Links policy ${selected.name}`} data-testid="safelinks-drawer">
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
            <h2 style={{ margin: 0, fontSize: "18px" }}>{selected.name}</h2>
            <button type="button" style={buttonStyle} onClick={() => setSelected(null)} data-testid="safelinks-drawer-close">Close</button>
          </div>
          <dl style={{ margin: 0, display: "grid", gridTemplateColumns: "160px 1fr", gap: "8px", fontSize: "14px" }}>
            <dt style={{ color: "var(--text-soft)" }}>State</dt><dd style={{ margin: 0 }}>{selected.state}</dd>
            <dt style={{ color: "var(--text-soft)" }}>URL rewriting</dt><dd style={{ margin: 0 }}>{yesNo(selected.urlRewriting)}</dd>
            <dt style={{ color: "var(--text-soft)" }}>Scan on click</dt><dd style={{ margin: 0 }}>{yesNo(selected.scanOnClick)}</dd>
            <dt style={{ color: "var(--text-soft)" }}>Detonation</dt><dd style={{ margin: 0 }}>{yesNo(selected.detonation)}</dd>
            <dt style={{ color: "var(--text-soft)" }}>Last modified</dt><dd style={{ margin: 0 }}>{selected.lastModified ?? "—"}</dd>
          </dl>
        </aside>
      )}

      {editor && (
        <div style={overlayStyle} role="dialog" aria-modal="true" aria-label={editor.mode === "edit" ? "Edit Safe Links policy" : "New Safe Links policy"} data-testid="safelinks-editor">
          <div style={dialogStyle}>
            <h3 style={{ margin: 0 }}>{editor.mode === "edit" ? `Edit Safe Links policy — ${editor.policy?.name}` : "New Safe Links policy"}</h3>
            <label style={{ display: "flex", flexDirection: "column", gap: "6px", fontSize: "14px" }}>
              Name
              <input type="text" value={editor.name} disabled={editor.mode === "edit"} onChange={(e) => setEditor({ ...editor, name: e.target.value })} style={inputStyle} aria-label="Policy name" data-testid="safelinks-name" />
            </label>
            <label style={{ display: "flex", flexDirection: "column", gap: "6px", fontSize: "14px" }}>
              State
              <select value={editor.enabled ? "enabled" : "disabled"} onChange={(e) => setEditor({ ...editor, enabled: e.target.value === "enabled" })} style={inputStyle} aria-label="Policy state" data-testid="safelinks-state">
                <option value="enabled">Enabled</option>
                <option value="disabled">Disabled</option>
              </select>
            </label>
            <div style={{ display: "flex", gap: "16px", flexWrap: "wrap", fontSize: "14px" }}>
              <label style={{ display: "flex", gap: "6px", alignItems: "center" }}>
                <input type="checkbox" checked={editor.urlRewriting} onChange={(e) => setEditor({ ...editor, urlRewriting: e.target.checked })} data-testid="safelinks-url-rewriting" />
                URL rewriting
              </label>
              <label style={{ display: "flex", gap: "6px", alignItems: "center" }}>
                <input type="checkbox" checked={editor.scanOnClick} onChange={(e) => setEditor({ ...editor, scanOnClick: e.target.checked })} data-testid="safelinks-scan-on-click" />
                Scan on click
              </label>
              <label style={{ display: "flex", gap: "6px", alignItems: "center" }}>
                <input type="checkbox" checked={editor.detonation} onChange={(e) => setEditor({ ...editor, detonation: e.target.checked })} data-testid="safelinks-detonation" />
                Detonation
              </label>
            </div>
            <div>
              <button type="button" style={buttonStyle} onClick={() => void previewEditor()} disabled={busy || (editor.mode === "create" && editor.name.trim().length === 0)} data-testid="safelinks-preview">Preview plan</button>
            </div>
            <SafeLinksPlanPreview plan={plan} busy={busy} error={planError} />
            <div style={{ display: "flex", gap: "8px", justifyContent: "flex-end" }}>
              <button type="button" style={buttonStyle} onClick={() => { setEditor(null); resetPlan(); }} data-testid="safelinks-editor-cancel">Cancel</button>
              <button type="button" style={{ ...primaryButtonStyle, ...(busy || !plan || !plan.valid ? disabledStyle : {}) }} disabled={busy || !plan || !plan.valid} onClick={() => void confirmEditor()} data-testid="safelinks-editor-confirm">Confirm and apply</button>
            </div>
          </div>
        </div>
      )}

      {pending && (
        <div style={overlayStyle} role="dialog" aria-modal="true" aria-label={`${pending.label} Safe Links policy`} data-testid="safelinks-action-dialog">
          <div style={dialogStyle}>
            <h3 style={{ margin: 0 }}>{pending.label}</h3>
            <SafeLinksPlanPreview plan={activePlan} busy={busy} error={planError} />
            <div style={{ display: "flex", gap: "8px", justifyContent: "flex-end" }}>
              <button type="button" style={buttonStyle} onClick={() => { setPending(null); resetPlan(); }} data-testid="safelinks-action-cancel">Cancel</button>
              <button type="button" style={{ ...primaryButtonStyle, ...(busy || !activePlan || !activePlan.valid ? disabledStyle : {}) }} disabled={busy || !activePlan || !activePlan.valid} onClick={() => void confirmPending()} data-testid="safelinks-action-confirm">Confirm and apply</button>
            </div>
          </div>
        </div>
      )}

      {templateFor && (
        <div style={overlayStyle} role="dialog" aria-modal="true" aria-label="Clone to template" data-testid="safelinks-template-dialog">
          <div style={dialogStyle}>
            <h3 style={{ margin: 0 }}>Clone to template — {templateFor.name}</h3>
            <p style={{ margin: 0, color: "var(--text-soft)", fontSize: "14px" }}>
              Saves the policy as a local compliance template. No tenant write is made.
            </p>
            <label style={{ display: "flex", flexDirection: "column", gap: "6px", fontSize: "14px" }}>
              Template name
              <input type="text" value={templateName} onChange={(e) => setTemplateName(e.target.value)} style={inputStyle} aria-label="Template name" data-testid="safelinks-template-name" />
            </label>
            {planError && <div role="alert" style={{ color: "var(--danger-text)", fontSize: "14px" }}>{planError}</div>}
            <div style={{ display: "flex", gap: "8px", justifyContent: "flex-end" }}>
              <button type="button" style={buttonStyle} onClick={() => { setTemplateFor(null); setTemplateName(""); resetPlan(); }} data-testid="safelinks-template-cancel">Cancel</button>
              <button type="button" style={{ ...primaryButtonStyle, ...(busy || templateName.trim().length === 0 ? disabledStyle : {}) }} disabled={busy || templateName.trim().length === 0} onClick={() => void saveTemplate()} data-testid="safelinks-template-save">Save template</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

interface SafeLinksPlanPreviewProps {
  readonly plan: SafeLinksPlan | null;
  readonly busy: boolean;
  readonly error: string | null;
}

function SafeLinksPlanPreview({ plan, busy, error }: SafeLinksPlanPreviewProps): ReactElement {
  return (
    <div data-testid="safelinks-plan-preview">
      {busy && <p style={{ margin: 0, fontSize: "14px" }}>Loading plan preview…</p>}
      {error && <div role="alert" style={{ color: "var(--danger-text)", fontSize: "14px" }}>{error}</div>}
      {plan && (
        <div style={{ display: "flex", flexDirection: "column", gap: "10px", fontSize: "14px" }}>
          <div data-testid="safelinks-plan-diff">
            {plan.diff.length === 0 ? "No changes." : plan.diff.map((line, index) => <div key={index}>{line}</div>)}
          </div>
          <div style={planGridStyle}>
            <div>
              <div style={{ color: "var(--text-soft)", fontSize: "12px", textTransform: "uppercase", letterSpacing: "0.07em" }}>Before</div>
              <pre data-testid="safelinks-plan-before" style={preStyle}>{plan.before ? JSON.stringify(plan.before, null, 2) : "—"}</pre>
            </div>
            <div>
              <div style={{ color: "var(--text-soft)", fontSize: "12px", textTransform: "uppercase", letterSpacing: "0.07em" }}>After</div>
              <pre data-testid="safelinks-plan-after" style={preStyle}>{plan.after ? JSON.stringify(plan.after, null, 2) : "—"}</pre>
            </div>
          </div>
          {plan.requiresConfirmation && (
            <div style={flagStyle} data-testid="safelinks-compliance-warning">⚠ {SAFELINKS_COMPLIANCE_WARNING}</div>
          )}
          {plan.requiresConfirmation && (
            <div style={{ color: "var(--text-soft)", fontSize: "13px" }}>Confirmation required before apply.</div>
          )}
        </div>
      )}
    </div>
  );
}

export default function SafeLinksPage(): ReactElement {
  const searchParams = useSearchParams();
  const tenantId = resolveTenantId(searchParams.get("tenantId"), useCurrentTenantId());
  return (
    <RequireTenant tenantId={tenantId}>
      <SafeLinksView tenantId={tenantId} />
    </RequireTenant>
  );
}
