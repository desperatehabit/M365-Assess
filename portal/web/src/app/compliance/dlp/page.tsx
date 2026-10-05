"use client";

// DLP policies (EPIC-030 SPEC.md §3.1, §4.1, §8; T-0588).
// Nav: Security & Compliance → Purview Compliance → DLP. Title "DLP Policies".
// Table: Name · State · Locations · Rules · Last modified. Row actions: View,
// Edit, Enable/Disable, Clone, Clone to template, Delete. Reads come from the
// T-0582 GET route; create/edit/enable/disable/delete apply through the T-0583
// change routes on the EPIC-006 gated path. The editor and the action dialog
// show a before/after plan preview, and disabling or deleting is
// compliance-impacting: the warning is shown and apply requires confirmation
// (SPEC §8). No browser call reaches a tenant directly.

import React, { useCallback, useEffect, useState, type CSSProperties, type ReactElement } from "react";
import { useSearchParams } from "next/navigation";
import { RequireTenant } from "../../../components/shell/RequireTenant";
import { resolveTenantId, useCurrentTenantId } from "../../../lib/useCurrentTenant";

export type Fetcher = typeof fetch;

export type DlpPolicyAction = "create" | "edit" | "enable" | "disable" | "delete";

export interface DlpPolicyItem {
  readonly id: string;
  readonly name: string;
  readonly state: string;
  readonly locations: readonly string[];
  readonly rules: number;
  readonly lastModified: string | null;
}

export interface ComplianceChangePlan {
  readonly action: DlpPolicyAction;
  readonly policyId: string;
  readonly targetName: string;
  readonly before: Record<string, unknown> | null;
  readonly after: Record<string, unknown> | null;
  readonly diff: readonly string[];
  readonly valid: boolean;
  readonly requiresConfirmation: boolean;
  readonly complianceImpacting: boolean;
  readonly warning?: string;
}

export const DLP_COMPLIANCE_WARNING =
  "Disabling or deleting a DLP policy weakens information protection. Review the before/after plan, then confirm. The change is audited with before/after.";

export interface DlpDraft {
  readonly name?: string;
  readonly enabled?: boolean;
  readonly locations?: readonly string[];
}

/** Builds the BFF query string for GET /v1/tenants/:id/purview/dlp. */
export function buildDlpQuery(filter: { readonly search?: string; readonly state?: string }, limit = 100): string {
  const params = new URLSearchParams();
  if (filter.search) params.set("search", filter.search);
  if (filter.state) params.set("state", filter.state);
  params.set("limit", String(limit));
  return `?${params.toString()}`;
}

function stateRecord(policy: DlpPolicyItem): Record<string, unknown> {
  return { name: policy.name, enabled: policy.state === "enabled", locations: [...policy.locations] };
}

/** Builds the before/after plan preview the editor and dialog show before apply. */
export function buildDlpChangePlan(
  action: DlpPolicyAction,
  policy: DlpPolicyItem | null,
  draft: DlpDraft | null,
): ComplianceChangePlan {
  const before = policy ? stateRecord(policy) : null;
  const after = draft
    ? {
        name: (draft.name ?? policy?.name ?? "").trim(),
        enabled: draft.enabled ?? (policy ? policy.state === "enabled" : true),
        locations: [...(draft.locations ?? policy?.locations ?? [])],
      }
    : null;

  const complianceImpacting = action === "disable" || action === "delete";
  const diff: string[] = [];
  if (action === "create") {
    diff.push(`Create DLP policy '${after?.name ?? ""}'`);
  } else if (action === "delete") {
    diff.push(`Delete DLP policy '${before?.name ?? ""}'`);
  } else if (action === "disable") {
    diff.push(`Disable DLP policy '${before?.name ?? ""}'`);
  } else if (action === "enable") {
    diff.push(`Enable DLP policy '${before?.name ?? ""}'`);
  } else {
    if (before?.name !== after?.name) {
      diff.push(`Rename DLP policy from '${before?.name ?? ""}' to '${after?.name ?? ""}'`);
    }
    if (JSON.stringify(before?.locations ?? []) !== JSON.stringify(after?.locations ?? [])) {
      diff.push(`Change the locations of DLP policy '${after?.name ?? ""}'`);
    }
    if (before?.enabled !== after?.enabled) {
      diff.push(`Change the state of DLP policy '${after?.name ?? ""}'`);
    }
  }

  return {
    action,
    policyId: policy?.id ?? "",
    targetName: String(before?.name ?? after?.name ?? ""),
    before,
    after,
    diff,
    valid: action === "create" ? String(after?.name ?? "").length > 0 : String(before?.name ?? "").length > 0,
    requiresConfirmation: complianceImpacting,
    complianceImpacting,
    ...(complianceImpacting ? { warning: DLP_COMPLIANCE_WARNING } : {}),
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
  return `/v1/tenants/${encodeURIComponent(tenantId)}/purview/dlp`;
}

export async function listDlpPolicies(
  tenantId: string,
  filter: { readonly search?: string; readonly state?: string },
  fetcher: Fetcher = fetch,
): Promise<{ items: DlpPolicyItem[]; nextCursor: string | null }> {
  const response = await fetcher(`${basePath(tenantId)}${buildDlpQuery(filter)}`);
  if (!response.ok) throw await readError(response, "List DLP policies");
  const body = (await response.json()) as { items?: DlpPolicyItem[]; nextCursor?: string | null };
  return { items: [...(body.items ?? [])], nextCursor: body.nextCursor ?? null };
}

function defaultIdempotencyKey(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `dlp-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

/** Applies a plan through the T-0583 change routes (EPIC-006 gated path). */
export async function applyDlpChange(
  tenantId: string,
  plan: ComplianceChangePlan,
  payload: Record<string, unknown>,
  fetcher: Fetcher = fetch,
): Promise<unknown> {
  const url =
    plan.action === "create"
      ? basePath(tenantId)
      : `${basePath(tenantId)}/${encodeURIComponent(plan.policyId)}`;
  const method = plan.action === "create" ? "POST" : plan.action === "delete" ? "DELETE" : "PATCH";
  const body = { ...payload, ...(plan.requiresConfirmation ? { confirm: true } : {}) };
  const response = await fetcher(url, {
    method,
    headers: { "content-type": "application/json", "Idempotency-Key": defaultIdempotencyKey() },
    body: JSON.stringify(body),
  });
  if (!response.ok) throw await readError(response, "Apply DLP change");
  return response.json();
}

/** Saves the policy as a local compliance template (SPEC §5/§6; T-0586 route). */
export async function saveDlpTemplate(
  name: string,
  payload: Record<string, unknown>,
  fetcher: Fetcher = fetch,
): Promise<unknown> {
  const response = await fetcher("/v1/compliance-templates", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ area: "dlp", name, payload, variables: {}, source: "local" }),
  });
  if (!response.ok) throw await readError(response, "Save DLP template");
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

export interface DlpViewProps {
  readonly tenantId: string;
  /** False disables write controls the caller lacks RBAC for. */
  readonly canWrite?: boolean;
  readonly fetcher?: Fetcher;
}

interface EditorState {
  readonly mode: "create" | "edit";
  readonly policy: DlpPolicyItem | null;
  readonly name: string;
  readonly enabled: boolean;
  readonly locations: string;
}

interface PendingWrite {
  readonly plan: ComplianceChangePlan;
  readonly payload: Record<string, unknown>;
  readonly label: string;
}

function parseLocations(value: string): string[] {
  return value
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

function editorAction(draft: EditorState): DlpPolicyAction {
  if (draft.mode === "create") return "create";
  const wasEnabled = draft.policy?.state === "enabled";
  if (!draft.enabled && wasEnabled) return "disable";
  if (draft.enabled && !wasEnabled) return "enable";
  return "edit";
}

export function DlpView({ tenantId, canWrite = true, fetcher = fetch }: DlpViewProps): ReactElement {
  const [filter, setFilter] = useState<{ search?: string; state?: string }>({});
  const [items, setItems] = useState<DlpPolicyItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [selected, setSelected] = useState<DlpPolicyItem | null>(null);
  const [editor, setEditor] = useState<EditorState | null>(null);
  const [pending, setPending] = useState<PendingWrite | null>(null);
  const [plan, setPlan] = useState<ComplianceChangePlan | null>(null);
  const [busy, setBusy] = useState(false);
  const [planError, setPlanError] = useState<string | null>(null);
  const [templateFor, setTemplateFor] = useState<DlpPolicyItem | null>(null);
  const [templateName, setTemplateName] = useState("");

  const fetchList = useCallback(
    async (next: { search?: string; state?: string }): Promise<void> => {
      setLoading(true);
      setError(null);
      try {
        const page = await listDlpPolicies(tenantId, next, fetcher);
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
    setEditor({ mode: "create", policy: null, name: "", enabled: true, locations: "Exchange, SharePoint, Teams" });
    resetPlan();
  }

  function openEdit(policy: DlpPolicyItem): void {
    setEditor({
      mode: "edit",
      policy,
      name: policy.name,
      enabled: policy.state === "enabled",
      locations: policy.locations.join(", "),
    });
    resetPlan();
  }

  function planForEditor(draft: EditorState): ComplianceChangePlan {
    return buildDlpChangePlan(editorAction(draft), draft.policy, {
      name: draft.name,
      enabled: draft.enabled,
      locations: parseLocations(draft.locations),
    });
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
      await applyDlpChange(
        tenantId,
        current,
        { name: current.after?.name, enabled: current.after?.enabled, locations: current.after?.locations },
        fetcher,
      );
      setNotice(`DLP policy ${editor.mode === "edit" ? "updated" : "created"}.`);
      setEditor(null);
      resetPlan();
      await fetchList(filter);
    } catch (err) {
      setPlanError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  function toggle(policy: DlpPolicyItem): void {
    const enable = policy.state !== "enabled";
    const action: DlpPolicyAction = enable ? "enable" : "disable";
    resetPlan();
    setPending({
      plan: buildDlpChangePlan(action, policy, { enabled: enable }),
      payload: { enabled: enable },
      label: enable ? "Enable" : "Disable",
    });
  }

  function clonePolicy(policy: DlpPolicyItem): void {
    const copyName = `${policy.name} (copy)`;
    resetPlan();
    setPending({
      plan: buildDlpChangePlan("create", null, {
        name: copyName,
        enabled: policy.state === "enabled",
        locations: policy.locations,
      }),
      payload: { name: copyName, enabled: policy.state === "enabled", locations: policy.locations },
      label: "Clone",
    });
  }

  function removePolicy(policy: DlpPolicyItem): void {
    resetPlan();
    setPending({ plan: buildDlpChangePlan("delete", policy, null), payload: {}, label: "Delete" });
  }

  async function confirmPending(): Promise<void> {
    if (!pending) return;
    setBusy(true);
    setPlanError(null);
    try {
      await applyDlpChange(tenantId, pending.plan, pending.payload, fetcher);
      setNotice(`${pending.label} applied${pending.plan.targetName ? ` to “${pending.plan.targetName}”` : ""}.`);
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
      await saveDlpTemplate(
        templateName.trim() || `${templateFor.name} template`,
        {
          name: templateFor.name,
          enabled: templateFor.state === "enabled",
          locations: templateFor.locations,
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

  return (
    <div style={pageStyle} data-testid="compliance-dlp-page">
      <div>
        <div style={{ fontSize: "12px", color: "var(--text-soft)" }}>Security &amp; Compliance &gt; Purview Compliance &gt; DLP</div>
        <h1 style={{ fontSize: "24px", fontWeight: 700, margin: "4px 0 0", fontFamily: "var(--font-display, var(--font-sans))" }}>
          DLP Policies
        </h1>
        <p style={{ margin: "4px 0 0", color: "var(--text-soft)", fontSize: "14px" }}>
          Preview every change before it is applied. Disabling a policy is compliance-impacting.
        </p>
      </div>

      <div style={{ display: "flex", gap: "8px", flexWrap: "wrap", alignItems: "center" }} data-testid="compliance-dlp-filters">
        <input
          type="text"
          placeholder="Search policy name..."
          value={filter.search ?? ""}
          onChange={(e) => setFilter((prev) => ({ ...prev, search: e.target.value || undefined }))}
          style={inputStyle}
          aria-label="Search DLP policies"
          data-testid="compliance-dlp-search"
        />
        <select
          value={filter.state ?? ""}
          onChange={(e) => setFilter((prev) => ({ ...prev, state: e.target.value || undefined }))}
          style={inputStyle}
          aria-label="Filter by state"
          data-testid="compliance-dlp-filter-state"
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
          data-testid="compliance-dlp-new"
        >
          New policy
        </button>
      </div>

      {notice && (
        <div style={{ padding: "12px 16px", borderRadius: "6px", background: "var(--success-soft)", border: "1px solid var(--success)", color: "var(--success-text)", fontSize: "14px" }} data-testid="compliance-dlp-notice">
          {notice}
        </div>
      )}
      {error && (
        <div role="alert" style={{ padding: "12px 16px", borderRadius: "6px", background: "var(--danger-soft)", border: "1px solid var(--danger)", color: "var(--danger-text)", fontSize: "14px" }} data-testid="compliance-dlp-error">
          {error}
        </div>
      )}

      <div style={{ overflowX: "auto" }}>
        <table style={tableStyle} data-testid="compliance-dlp-table">
          <thead>
            <tr>
              <th style={thStyle}>Name</th>
              <th style={thStyle}>State</th>
              <th style={thStyle}>Locations</th>
              <th style={thStyle}>Rules</th>
              <th style={thStyle}>Last modified</th>
              <th style={thStyle}>Actions</th>
            </tr>
          </thead>
          <tbody>
            {loading ? (
              <tr><td style={tdStyle} colSpan={6}>Loading DLP policies…</td></tr>
            ) : items.length === 0 ? (
              <tr><td style={tdStyle} colSpan={6}>No DLP policies found.</td></tr>
            ) : (
              items.map((policy) => {
                const enabled = policy.state === "enabled";
                return (
                  <tr key={policy.id} data-testid={`dlp-row-${policy.id}`}>
                    <td style={tdStyle}>{policy.name}</td>
                    <td style={tdStyle}>{enabled ? "Enabled" : "Disabled"}</td>
                    <td style={tdStyle}>{policy.locations.length === 0 ? "—" : policy.locations.join(", ")}</td>
                    <td style={tdStyle}>{policy.rules}</td>
                    <td style={tdStyle}>{policy.lastModified ?? "—"}</td>
                    <td style={tdStyle}>
                      <div style={{ display: "flex", gap: "6px", flexWrap: "wrap" }}>
                        <button type="button" style={buttonStyle} onClick={() => setSelected(policy)} data-testid={`dlp-view-${policy.id}`}>View</button>
                        <button type="button" style={writeDisabled ? { ...buttonStyle, ...disabledStyle } : buttonStyle} disabled={writeDisabled} title={writeTitle} onClick={() => openEdit(policy)} data-testid={`dlp-edit-${policy.id}`}>Edit</button>
                        <button type="button" style={writeDisabled ? { ...buttonStyle, ...disabledStyle } : buttonStyle} disabled={writeDisabled} title={writeTitle} onClick={() => toggle(policy)} data-testid={`dlp-toggle-${policy.id}`}>{enabled ? "Disable" : "Enable"}</button>
                        <button type="button" style={writeDisabled ? { ...buttonStyle, ...disabledStyle } : buttonStyle} disabled={writeDisabled} title={writeTitle} onClick={() => clonePolicy(policy)} data-testid={`dlp-clone-${policy.id}`}>Clone</button>
                        <button type="button" style={writeDisabled ? { ...buttonStyle, ...disabledStyle } : buttonStyle} disabled={writeDisabled} title={writeTitle} onClick={() => { setTemplateFor(policy); setTemplateName(`${policy.name} template`); resetPlan(); }} data-testid={`dlp-clone-template-${policy.id}`}>Clone to template</button>
                        <button type="button" style={writeDisabled ? { ...buttonStyle, ...disabledStyle } : buttonStyle} disabled={writeDisabled} title={writeTitle} onClick={() => removePolicy(policy)} data-testid={`dlp-delete-${policy.id}`}>Delete</button>
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
        <aside style={drawerStyle} role="dialog" aria-modal="true" aria-label={`DLP policy ${selected.name}`} data-testid="dlp-drawer">
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
            <h2 style={{ margin: 0, fontSize: "18px" }}>{selected.name}</h2>
            <button type="button" style={buttonStyle} onClick={() => setSelected(null)} data-testid="dlp-drawer-close">Close</button>
          </div>
          <dl style={{ margin: 0, display: "grid", gridTemplateColumns: "140px 1fr", gap: "8px", fontSize: "14px" }}>
            <dt style={{ color: "var(--text-soft)" }}>State</dt><dd style={{ margin: 0 }}>{selected.state}</dd>
            <dt style={{ color: "var(--text-soft)" }}>Locations</dt><dd style={{ margin: 0 }}>{selected.locations.length === 0 ? "—" : selected.locations.join(", ")}</dd>
            <dt style={{ color: "var(--text-soft)" }}>Rules</dt><dd style={{ margin: 0 }}>{selected.rules}</dd>
            <dt style={{ color: "var(--text-soft)" }}>Last modified</dt><dd style={{ margin: 0 }}>{selected.lastModified ?? "—"}</dd>
          </dl>
        </aside>
      )}

      {editor && (
        <div style={overlayStyle} role="dialog" aria-modal="true" aria-label={editor.mode === "edit" ? "Edit DLP policy" : "New DLP policy"} data-testid="dlp-editor">
          <div style={dialogStyle}>
            <h3 style={{ margin: 0 }}>{editor.mode === "edit" ? `Edit DLP policy — ${editor.policy?.name}` : "New DLP policy"}</h3>
            <label style={{ display: "flex", flexDirection: "column", gap: "6px", fontSize: "14px" }}>
              Name
              <input type="text" value={editor.name} onChange={(e) => setEditor({ ...editor, name: e.target.value })} style={inputStyle} aria-label="Policy name" data-testid="dlp-name" />
            </label>
            <label style={{ display: "flex", flexDirection: "column", gap: "6px", fontSize: "14px" }}>
              State
              <select value={editor.enabled ? "enabled" : "disabled"} onChange={(e) => setEditor({ ...editor, enabled: e.target.value === "enabled" })} style={inputStyle} aria-label="Policy state" data-testid="dlp-state">
                <option value="enabled">Enabled</option>
                <option value="disabled">Disabled</option>
              </select>
            </label>
            <label style={{ display: "flex", flexDirection: "column", gap: "6px", fontSize: "14px" }}>
              Locations
              <input type="text" value={editor.locations} onChange={(e) => setEditor({ ...editor, locations: e.target.value })} style={inputStyle} aria-label="Policy locations" data-testid="dlp-locations" />
            </label>
            <div>
              <button type="button" style={buttonStyle} onClick={previewEditor} disabled={busy || editor.name.trim().length === 0} data-testid="dlp-preview">Preview plan</button>
            </div>
            <PlanPreview prefix="dlp" plan={plan} busy={busy} error={planError} warning={DLP_COMPLIANCE_WARNING} />
            <div style={{ display: "flex", gap: "8px", justifyContent: "flex-end" }}>
              <button type="button" style={buttonStyle} onClick={() => { setEditor(null); resetPlan(); }} data-testid="dlp-editor-cancel">Cancel</button>
              <button type="button" style={{ ...primaryButtonStyle, ...(busy || !plan || !plan.valid ? disabledStyle : {}) }} disabled={busy || !plan || !plan.valid} onClick={() => void confirmEditor()} data-testid="dlp-editor-confirm">Confirm and apply</button>
            </div>
          </div>
        </div>
      )}

      {pending && (
        <div style={overlayStyle} role="dialog" aria-modal="true" aria-label={`${pending.label} DLP policy`} data-testid="dlp-action-dialog">
          <div style={dialogStyle}>
            <h3 style={{ margin: 0 }}>{pending.label}{pending.plan.targetName ? ` — ${pending.plan.targetName}` : ""}</h3>
            <PlanPreview prefix="dlp" plan={plan ?? pending.plan} busy={busy} error={planError} warning={DLP_COMPLIANCE_WARNING} />
            <div style={{ display: "flex", gap: "8px", justifyContent: "flex-end" }}>
              <button type="button" style={buttonStyle} onClick={() => { setPending(null); resetPlan(); }} data-testid="dlp-action-cancel">Cancel</button>
              <button type="button" style={{ ...primaryButtonStyle, ...(busy || !(plan ?? pending.plan).valid ? disabledStyle : {}) }} disabled={busy || !(plan ?? pending.plan).valid} onClick={() => void confirmPending()} data-testid="dlp-action-confirm">Confirm and apply</button>
            </div>
          </div>
        </div>
      )}

      {templateFor && (
        <div style={overlayStyle} role="dialog" aria-modal="true" aria-label="Clone to template" data-testid="dlp-template-dialog">
          <div style={dialogStyle}>
            <h3 style={{ margin: 0 }}>Clone to template — {templateFor.name}</h3>
            <p style={{ margin: 0, color: "var(--text-soft)", fontSize: "14px" }}>
              Saves the policy as a local compliance template. No tenant write is made.
            </p>
            <label style={{ display: "flex", flexDirection: "column", gap: "6px", fontSize: "14px" }}>
              Template name
              <input type="text" value={templateName} onChange={(e) => setTemplateName(e.target.value)} style={inputStyle} aria-label="Template name" data-testid="dlp-template-name" />
            </label>
            {planError && <div role="alert" style={{ color: "var(--danger-text)", fontSize: "14px" }}>{planError}</div>}
            <div style={{ display: "flex", gap: "8px", justifyContent: "flex-end" }}>
              <button type="button" style={buttonStyle} onClick={() => { setTemplateFor(null); setTemplateName(""); resetPlan(); }} data-testid="dlp-template-cancel">Cancel</button>
              <button type="button" style={{ ...primaryButtonStyle, ...(busy || templateName.trim().length === 0 ? disabledStyle : {}) }} disabled={busy || templateName.trim().length === 0} onClick={() => void saveTemplate()} data-testid="dlp-template-save">Save template</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

interface PlanPreviewProps {
  readonly prefix: string;
  readonly plan: ComplianceChangePlan | null;
  readonly busy: boolean;
  readonly error: string | null;
  readonly warning: string;
}

function PlanPreview({ prefix, plan, busy, error, warning }: PlanPreviewProps): ReactElement {
  return (
    <div data-testid={`${prefix}-plan-preview`}>
      {busy && <p style={{ margin: 0, fontSize: "14px" }}>Loading plan preview…</p>}
      {error && <div role="alert" style={{ color: "var(--danger-text)", fontSize: "14px" }}>{error}</div>}
      {plan && (
        <div style={{ display: "flex", flexDirection: "column", gap: "10px", fontSize: "14px" }}>
          <div data-testid={`${prefix}-plan-diff`}>
            {plan.diff.length === 0 ? "No changes." : plan.diff.map((line, index) => <div key={index}>{line}</div>)}
          </div>
          <div style={planGridStyle}>
            <div>
              <div style={{ color: "var(--text-soft)", fontSize: "12px", textTransform: "uppercase", letterSpacing: "0.07em" }}>Before</div>
              <pre data-testid={`${prefix}-plan-before`} style={preStyle}>{plan.before ? JSON.stringify(plan.before, null, 2) : "—"}</pre>
            </div>
            <div>
              <div style={{ color: "var(--text-soft)", fontSize: "12px", textTransform: "uppercase", letterSpacing: "0.07em" }}>After</div>
              <pre data-testid={`${prefix}-plan-after`} style={preStyle}>{plan.after ? JSON.stringify(plan.after, null, 2) : "—"}</pre>
            </div>
          </div>
          {plan.complianceImpacting && (
            <div style={flagStyle} data-testid={`${prefix}-compliance-warning`}>⚠ {plan.warning ?? warning}</div>
          )}
          {plan.requiresConfirmation && (
            <div style={{ color: "var(--text-soft)", fontSize: "13px" }}>Confirmation required before apply.</div>
          )}
        </div>
      )}
    </div>
  );
}

export default function DlpPage(): ReactElement {
  const searchParams = useSearchParams();
  const tenantId = resolveTenantId(searchParams.get("tenantId"), useCurrentTenantId());
  return (
    <RequireTenant tenantId={tenantId}>
      <DlpView tenantId={tenantId} />
    </RequireTenant>
  );
}
