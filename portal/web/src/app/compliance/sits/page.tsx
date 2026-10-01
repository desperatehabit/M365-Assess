"use client";

// Sensitive information types (EPIC-030 SPEC.md §3.4; T-0589).
// Nav: Security & Compliance → Purview Compliance → Sensitive Info Types.
// Title "Sensitive Info Types". Table: Name · Type (built-in/custom) · Pattern
// confidence · Based on. Row actions: View, Edit (custom), Clone to template,
// Delete. Reads come from the T-0587 GET route; create/edit/delete apply through
// the T-0587 change routes on the EPIC-006 gated path. Built-in types are
// read-only: Edit and Delete are disabled in the UI (the route also returns 409).
// No browser call reaches a tenant directly.

import React, { useCallback, useEffect, useState, type CSSProperties, type ReactElement } from "react";
import { useSearchParams } from "next/navigation";
import { RequireTenant } from "../../../components/shell/RequireTenant";
import { resolveTenantId, useCurrentTenantId } from "../../../lib/useCurrentTenant";

export type Fetcher = typeof fetch;

export type SitAction = "create" | "edit" | "delete";

export interface SensitiveInfoTypeItem {
  readonly id: string;
  readonly name: string;
  readonly type: string;
  readonly patternConfidence: string | null;
  readonly basedOn: string | null;
}

export interface SitChangePlan {
  readonly action: SitAction;
  readonly sitId: string;
  readonly sitName: string;
  readonly before: Record<string, unknown> | null;
  readonly after: Record<string, unknown> | null;
  readonly diff: readonly string[];
  readonly valid: boolean;
  readonly requiresConfirmation: boolean;
  readonly complianceImpacting: boolean;
  readonly warning?: string;
}

export const SIT_DELETE_WARNING =
  "Deleting a custom sensitive information type may break the policies that reference it. Review the before/after plan, then confirm. The change is audited with before/after.";

export interface SitDraft {
  readonly name?: string;
  readonly patternConfidence?: string | null;
  readonly basedOn?: string | null;
}

/** Builds the BFF query string for GET /v1/tenants/:id/purview/sits. */
export function buildSitsQuery(
  filter: { readonly search?: string; readonly type?: string },
  limit = 100,
): string {
  const params = new URLSearchParams();
  if (filter.search) params.set("search", filter.search);
  if (filter.type) params.set("type", filter.type);
  params.set("limit", String(limit));
  return `?${params.toString()}`;
}

export function isBuiltinSit(sit: SensitiveInfoTypeItem): boolean {
  return sit.type !== "custom";
}

function sitState(sit: SensitiveInfoTypeItem): Record<string, unknown> {
  return {
    name: sit.name,
    type: sit.type,
    patternConfidence: sit.patternConfidence,
    basedOn: sit.basedOn,
  };
}

/** Builds the before/after plan preview the editor and dialog show before apply. */
export function buildSitChangePlan(
  action: SitAction,
  sit: SensitiveInfoTypeItem | null,
  draft: SitDraft | null,
): SitChangePlan {
  const before = sit ? sitState(sit) : null;
  const after = draft
    ? {
        name: (draft.name ?? sit?.name ?? "").trim(),
        type: sit?.type ?? "custom",
        patternConfidence: draft.patternConfidence ?? sit?.patternConfidence ?? null,
        basedOn: draft.basedOn ?? sit?.basedOn ?? null,
      }
    : null;

  const complianceImpacting = action === "delete";
  const name = String(before?.["name"] ?? after?.["name"] ?? "");
  const diff: string[] = [];
  if (action === "create") {
    diff.push(`Create sensitive information type '${name}'`);
  } else if (action === "delete") {
    diff.push(`Delete sensitive information type '${name}'`);
  } else {
    if (before?.["name"] !== after?.["name"]) {
      diff.push(`Rename sensitive information type from '${before?.["name"] ?? ""}' to '${after?.["name"] ?? ""}'`);
    }
    if (before?.["patternConfidence"] !== after?.["patternConfidence"]) {
      diff.push(`Change the pattern confidence of sensitive information type '${name}'`);
    }
    if (before?.["basedOn"] !== after?.["basedOn"]) {
      diff.push(`Change the base type of sensitive information type '${name}'`);
    }
  }

  return {
    action,
    sitId: sit?.id ?? "",
    sitName: name,
    before,
    after,
    diff,
    valid: action === "create" ? String(after?.["name"] ?? "").length > 0 : true,
    requiresConfirmation: complianceImpacting,
    complianceImpacting,
    ...(complianceImpacting ? { warning: SIT_DELETE_WARNING } : {}),
  };
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
  return `/v1/tenants/${encodeURIComponent(tenantId)}/purview/sits`;
}

export async function listSits(
  tenantId: string,
  filter: { readonly search?: string; readonly type?: string },
  fetcher: Fetcher = fetch,
): Promise<{ items: SensitiveInfoTypeItem[]; nextCursor: string | null }> {
  const response = await fetcher(`${basePath(tenantId)}${buildSitsQuery(filter)}`);
  if (!response.ok) throw await readError(response, "List sensitive information types");
  const body = (await response.json()) as { items?: SensitiveInfoTypeItem[]; nextCursor?: string | null };
  return { items: [...(body.items ?? [])], nextCursor: body.nextCursor ?? null };
}

/** Applies a plan through the T-0587 change routes (EPIC-006 gated path). */
export async function applySitChange(
  tenantId: string,
  plan: SitChangePlan,
  payload: Record<string, unknown>,
  fetcher: Fetcher = fetch,
): Promise<unknown> {
  const url =
    plan.action === "create" ? basePath(tenantId) : `${basePath(tenantId)}/${encodeURIComponent(plan.sitId)}`;
  const method = plan.action === "create" ? "POST" : plan.action === "delete" ? "DELETE" : "PATCH";
  const body = { ...payload, ...(plan.requiresConfirmation ? { confirm: true } : {}) };
  const response = await fetcher(url, {
    method,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!response.ok) throw await readError(response, "Apply sensitive information type change");
  return response.json();
}

/** Saves the SIT as a local compliance template (SPEC §5/§6; T-0586 route). */
export async function saveSitTemplate(
  name: string,
  payload: Record<string, unknown>,
  fetcher: Fetcher = fetch,
): Promise<unknown> {
  const response = await fetcher("/v1/compliance-templates", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ area: "sit", name, payload, variables: {}, source: "local" }),
  });
  if (!response.ok) throw await readError(response, "Save SIT template");
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

export interface SitsViewProps {
  readonly tenantId: string;
  /** False disables write controls the caller lacks RBAC for. */
  readonly canWrite?: boolean;
  readonly fetcher?: Fetcher;
}

interface EditorState {
  readonly mode: "create" | "edit";
  readonly sit: SensitiveInfoTypeItem | null;
  readonly name: string;
  readonly patternConfidence: string;
  readonly basedOn: string;
}

interface PendingWrite {
  readonly plan: SitChangePlan;
  readonly label: string;
}

function draftFromEditor(draft: EditorState): SitDraft {
  return {
    name: draft.name,
    patternConfidence: draft.patternConfidence.trim() || null,
    basedOn: draft.basedOn.trim() || null,
  };
}

export function SitsView({ tenantId, canWrite = true, fetcher = fetch }: SitsViewProps): ReactElement {
  const [filter, setFilter] = useState<{ search?: string; type?: string }>({});
  const [items, setItems] = useState<SensitiveInfoTypeItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [selected, setSelected] = useState<SensitiveInfoTypeItem | null>(null);
  const [editor, setEditor] = useState<EditorState | null>(null);
  const [pending, setPending] = useState<PendingWrite | null>(null);
  const [plan, setPlan] = useState<SitChangePlan | null>(null);
  const [busy, setBusy] = useState(false);
  const [planError, setPlanError] = useState<string | null>(null);
  const [templateFor, setTemplateFor] = useState<SensitiveInfoTypeItem | null>(null);
  const [templateName, setTemplateName] = useState("");

  const fetchList = useCallback(
    async (next: { search?: string; type?: string }): Promise<void> => {
      setLoading(true);
      setError(null);
      try {
        const page = await listSits(tenantId, next, fetcher);
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
    setEditor({ mode: "create", sit: null, name: "", patternConfidence: "", basedOn: "" });
    resetPlan();
  }

  function openEdit(sit: SensitiveInfoTypeItem): void {
    setEditor({
      mode: "edit",
      sit,
      name: sit.name,
      patternConfidence: sit.patternConfidence ?? "",
      basedOn: sit.basedOn ?? "",
    });
    resetPlan();
  }

  function planForEditor(draft: EditorState): SitChangePlan {
    return buildSitChangePlan(draft.mode === "create" ? "create" : "edit", draft.sit, draftFromEditor(draft));
  }

  function previewEditor(): void {
    if (!editor) return;
    resetPlan();
    if (editor.name.trim().length === 0) {
      setPlanError("Name is required.");
      return;
    }
    setPlan(planForEditor(editor));
  }

  async function confirmEditor(): Promise<void> {
    if (!editor) return;
    const current = planForEditor(editor);
    setBusy(true);
    setPlanError(null);
    try {
      await applySitChange(
        tenantId,
        current,
        {
          name: current.after?.["name"],
          patternConfidence: current.after?.["patternConfidence"],
          basedOn: current.after?.["basedOn"],
        },
        fetcher,
      );
      setNotice(`Sensitive information type ${editor.mode === "edit" ? "updated" : "created"}.`);
      setEditor(null);
      resetPlan();
      await fetchList(filter);
    } catch (err) {
      setPlanError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  function removeSit(sit: SensitiveInfoTypeItem): void {
    resetPlan();
    setPending({ plan: buildSitChangePlan("delete", sit, null), label: "Delete" });
  }

  async function confirmPending(): Promise<void> {
    if (!pending) return;
    setBusy(true);
    setPlanError(null);
    try {
      await applySitChange(tenantId, pending.plan, {}, fetcher);
      setNotice(`${pending.label} applied${pending.plan.sitName ? ` to “${pending.plan.sitName}”` : ""}.`);
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
      await saveSitTemplate(
        templateName.trim() || `${templateFor.name} template`,
        {
          name: templateFor.name,
          type: templateFor.type,
          patternConfidence: templateFor.patternConfidence,
          basedOn: templateFor.basedOn,
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
  const writeTitle = writeDisabled ? "Requires purview.write permission" : "";
  const builtinTitle = "Built-in sensitive information types are read-only";

  return (
    <div style={pageStyle} data-testid="compliance-sits-page">
      <div>
        <div style={{ fontSize: "12px", color: "var(--text-soft)" }}>Security &amp; Compliance &gt; Purview Compliance &gt; Sensitive Info Types</div>
        <h1 style={{ fontSize: "24px", fontWeight: 700, margin: "4px 0 0", fontFamily: "var(--font-display, var(--font-sans))" }}>
          Sensitive Info Types
        </h1>
        <p style={{ margin: "4px 0 0", color: "var(--text-soft)", fontSize: "14px" }}>
          Built-in types are read-only; clone one to a custom type before editing.
        </p>
      </div>

      <div style={{ display: "flex", gap: "8px", flexWrap: "wrap", alignItems: "center" }} data-testid="compliance-sits-filters">
        <input
          type="text"
          placeholder="Search type name..."
          value={filter.search ?? ""}
          onChange={(e) => setFilter((prev) => ({ ...prev, search: e.target.value || undefined }))}
          style={inputStyle}
          aria-label="Search sensitive information types"
          data-testid="compliance-sits-search"
        />
        <select
          value={filter.type ?? ""}
          onChange={(e) => setFilter((prev) => ({ ...prev, type: e.target.value || undefined }))}
          style={inputStyle}
          aria-label="Filter by type"
          data-testid="compliance-sits-filter-type"
        >
          <option value="">All types</option>
          <option value="builtin">Built-in</option>
          <option value="custom">Custom</option>
        </select>
        <button
          type="button"
          style={{ ...primaryButtonStyle, ...(writeDisabled ? disabledStyle : {}) }}
          disabled={writeDisabled}
          title={writeTitle || "New custom type"}
          onClick={openCreate}
          data-testid="compliance-sits-new"
        >
          New custom type
        </button>
      </div>

      {notice && (
        <div style={{ padding: "12px 16px", borderRadius: "6px", background: "var(--success-soft)", border: "1px solid var(--success)", color: "var(--success-text)", fontSize: "14px" }} data-testid="compliance-sits-notice">
          {notice}
        </div>
      )}
      {error && (
        <div role="alert" style={{ padding: "12px 16px", borderRadius: "6px", background: "var(--danger-soft)", border: "1px solid var(--danger)", color: "var(--danger-text)", fontSize: "14px" }} data-testid="compliance-sits-error">
          {error}
        </div>
      )}

      <div style={{ overflowX: "auto" }}>
        <table style={tableStyle} data-testid="compliance-sits-table">
          <thead>
            <tr>
              <th style={thStyle}>Name</th>
              <th style={thStyle}>Type</th>
              <th style={thStyle}>Pattern confidence</th>
              <th style={thStyle}>Based on</th>
              <th style={thStyle}>Actions</th>
            </tr>
          </thead>
          <tbody>
            {loading ? (
              <tr><td style={tdStyle} colSpan={5}>Loading sensitive information types…</td></tr>
            ) : items.length === 0 ? (
              <tr><td style={tdStyle} colSpan={5}>No sensitive information types found.</td></tr>
            ) : (
              items.map((sit) => {
                const builtin = isBuiltinSit(sit);
                return (
                  <tr key={sit.id} data-testid={`sits-row-${sit.id}`}>
                    <td style={tdStyle}>{sit.name}</td>
                    <td style={tdStyle} data-testid={`sits-type-${sit.id}`}>{builtin ? "Built-in" : "Custom"}</td>
                    <td style={tdStyle}>{sit.patternConfidence ?? "—"}</td>
                    <td style={tdStyle}>{sit.basedOn ?? "—"}</td>
                    <td style={tdStyle}>
                      <div style={{ display: "flex", gap: "6px", flexWrap: "wrap" }}>
                        <button type="button" style={buttonStyle} onClick={() => setSelected(sit)} data-testid={`sits-view-${sit.id}`}>View</button>
                        <button
                          type="button"
                          style={writeDisabled || builtin ? { ...buttonStyle, ...disabledStyle } : buttonStyle}
                          disabled={writeDisabled || builtin}
                          title={builtin ? builtinTitle : writeTitle || "Edit"}
                          onClick={() => openEdit(sit)}
                          data-testid={`sits-edit-${sit.id}`}
                        >
                          Edit
                        </button>
                        <button type="button" style={writeDisabled ? { ...buttonStyle, ...disabledStyle } : buttonStyle} disabled={writeDisabled} title={writeTitle} onClick={() => { setTemplateFor(sit); setTemplateName(`${sit.name} template`); resetPlan(); }} data-testid={`sits-clone-template-${sit.id}`}>Clone to template</button>
                        <button
                          type="button"
                          style={writeDisabled || builtin ? { ...buttonStyle, ...disabledStyle } : buttonStyle}
                          disabled={writeDisabled || builtin}
                          title={builtin ? builtinTitle : writeTitle || "Delete"}
                          onClick={() => removeSit(sit)}
                          data-testid={`sits-delete-${sit.id}`}
                        >
                          Delete
                        </button>
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
        <aside style={drawerStyle} role="dialog" aria-modal="true" aria-label={`Sensitive information type ${selected.name}`} data-testid="sits-drawer">
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
            <h2 style={{ margin: 0, fontSize: "18px" }}>{selected.name}</h2>
            <button type="button" style={buttonStyle} onClick={() => setSelected(null)} data-testid="sits-drawer-close">Close</button>
          </div>
          <dl style={{ margin: 0, display: "grid", gridTemplateColumns: "160px 1fr", gap: "8px", fontSize: "14px" }}>
            <dt style={{ color: "var(--text-soft)" }}>Type</dt><dd style={{ margin: 0 }}>{isBuiltinSit(selected) ? "Built-in" : "Custom"}</dd>
            <dt style={{ color: "var(--text-soft)" }}>Pattern confidence</dt><dd style={{ margin: 0 }}>{selected.patternConfidence ?? "—"}</dd>
            <dt style={{ color: "var(--text-soft)" }}>Based on</dt><dd style={{ margin: 0 }}>{selected.basedOn ?? "—"}</dd>
          </dl>
        </aside>
      )}

      {editor && (
        <div style={overlayStyle} role="dialog" aria-modal="true" aria-label={editor.mode === "edit" ? "Edit sensitive information type" : "New sensitive information type"} data-testid="sits-editor">
          <div style={dialogStyle}>
            <h3 style={{ margin: 0 }}>{editor.mode === "edit" ? `Edit sensitive information type — ${editor.sit?.name}` : "New custom sensitive information type"}</h3>
            <label style={{ display: "flex", flexDirection: "column", gap: "6px", fontSize: "14px" }}>
              Name
              <input type="text" value={editor.name} onChange={(e) => setEditor({ ...editor, name: e.target.value })} style={inputStyle} aria-label="Type name" data-testid="sits-name" />
            </label>
            <label style={{ display: "flex", flexDirection: "column", gap: "6px", fontSize: "14px" }}>
              Pattern confidence
              <input type="text" value={editor.patternConfidence} onChange={(e) => setEditor({ ...editor, patternConfidence: e.target.value })} style={inputStyle} aria-label="Pattern confidence" data-testid="sits-pattern-confidence" />
            </label>
            <label style={{ display: "flex", flexDirection: "column", gap: "6px", fontSize: "14px" }}>
              Based on
              <input type="text" value={editor.basedOn} onChange={(e) => setEditor({ ...editor, basedOn: e.target.value })} style={inputStyle} aria-label="Based on" data-testid="sits-based-on" />
            </label>
            <div>
              <button type="button" style={buttonStyle} onClick={previewEditor} disabled={busy || editor.name.trim().length === 0} data-testid="sits-preview">Preview plan</button>
            </div>
            <SitPlanPreview plan={plan} busy={busy} error={planError} />
            <div style={{ display: "flex", gap: "8px", justifyContent: "flex-end" }}>
              <button type="button" style={buttonStyle} onClick={() => { setEditor(null); resetPlan(); }} data-testid="sits-editor-cancel">Cancel</button>
              <button type="button" style={{ ...primaryButtonStyle, ...(busy || !plan || !plan.valid ? disabledStyle : {}) }} disabled={busy || !plan || !plan.valid} onClick={() => void confirmEditor()} data-testid="sits-editor-confirm">Confirm and apply</button>
            </div>
          </div>
        </div>
      )}

      {pending && (
        <div style={overlayStyle} role="dialog" aria-modal="true" aria-label={`${pending.label} sensitive information type`} data-testid="sits-action-dialog">
          <div style={dialogStyle}>
            <h3 style={{ margin: 0 }}>{pending.label}{pending.plan.sitName ? ` — ${pending.plan.sitName}` : ""}</h3>
            <SitPlanPreview plan={plan ?? pending.plan} busy={busy} error={planError} />
            <div style={{ display: "flex", gap: "8px", justifyContent: "flex-end" }}>
              <button type="button" style={buttonStyle} onClick={() => { setPending(null); resetPlan(); }} data-testid="sits-action-cancel">Cancel</button>
              <button type="button" style={{ ...primaryButtonStyle, ...(busy || !(plan ?? pending.plan).valid ? disabledStyle : {}) }} disabled={busy || !(plan ?? pending.plan).valid} onClick={() => void confirmPending()} data-testid="sits-action-confirm">Confirm and apply</button>
            </div>
          </div>
        </div>
      )}

      {templateFor && (
        <div style={overlayStyle} role="dialog" aria-modal="true" aria-label="Clone to template" data-testid="sits-template-dialog">
          <div style={dialogStyle}>
            <h3 style={{ margin: 0 }}>Clone to template — {templateFor.name}</h3>
            <p style={{ margin: 0, color: "var(--text-soft)", fontSize: "14px" }}>
              Saves the type as a local compliance template. No tenant write is made.
            </p>
            <label style={{ display: "flex", flexDirection: "column", gap: "6px", fontSize: "14px" }}>
              Template name
              <input type="text" value={templateName} onChange={(e) => setTemplateName(e.target.value)} style={inputStyle} aria-label="Template name" data-testid="sits-template-name" />
            </label>
            {planError && <div role="alert" style={{ color: "var(--danger-text)", fontSize: "14px" }}>{planError}</div>}
            <div style={{ display: "flex", gap: "8px", justifyContent: "flex-end" }}>
              <button type="button" style={buttonStyle} onClick={() => { setTemplateFor(null); setTemplateName(""); resetPlan(); }} data-testid="sits-template-cancel">Cancel</button>
              <button type="button" style={{ ...primaryButtonStyle, ...(busy || templateName.trim().length === 0 ? disabledStyle : {}) }} disabled={busy || templateName.trim().length === 0} onClick={() => void saveTemplate()} data-testid="sits-template-save">Save template</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

interface SitPlanPreviewProps {
  readonly plan: SitChangePlan | null;
  readonly busy: boolean;
  readonly error: string | null;
}

function SitPlanPreview({ plan, busy, error }: SitPlanPreviewProps): ReactElement {
  return (
    <div data-testid="sits-plan-preview">
      {busy && <p style={{ margin: 0, fontSize: "14px" }}>Loading plan preview…</p>}
      {error && <div role="alert" style={{ color: "var(--danger-text)", fontSize: "14px" }}>{error}</div>}
      {plan && (
        <div style={{ display: "flex", flexDirection: "column", gap: "10px", fontSize: "14px" }}>
          <div data-testid="sits-plan-diff">
            {plan.diff.length === 0 ? "No changes." : plan.diff.map((line, index) => <div key={index}>{line}</div>)}
          </div>
          <div style={planGridStyle}>
            <div>
              <div style={{ color: "var(--text-soft)", fontSize: "12px", textTransform: "uppercase", letterSpacing: "0.07em" }}>Before</div>
              <pre data-testid="sits-plan-before" style={preStyle}>{plan.before ? JSON.stringify(plan.before, null, 2) : "—"}</pre>
            </div>
            <div>
              <div style={{ color: "var(--text-soft)", fontSize: "12px", textTransform: "uppercase", letterSpacing: "0.07em" }}>After</div>
              <pre data-testid="sits-plan-after" style={preStyle}>{plan.after ? JSON.stringify(plan.after, null, 2) : "—"}</pre>
            </div>
          </div>
          {plan.complianceImpacting && (
            <div style={flagStyle} data-testid="sits-compliance-warning">⚠ {plan.warning ?? SIT_DELETE_WARNING}</div>
          )}
        </div>
      )}
    </div>
  );
}

export default function SitsPage(): ReactElement {
  const searchParams = useSearchParams();
  const tenantId = resolveTenantId(searchParams.get("tenantId"), useCurrentTenantId());
  return (
    <RequireTenant tenantId={tenantId}>
      <SitsView tenantId={tenantId} />
    </RequireTenant>
  );
}
