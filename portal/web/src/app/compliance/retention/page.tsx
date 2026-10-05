"use client";

// Retention policies (EPIC-030 SPEC.md §3.2, §4.1, §8; T-0588).
// Nav: Security & Compliance → Purview Compliance → Retention. Title "Retention
// Policies". Table: Name · State · Locations · Retention period · Disposition.
// Row actions: View, Edit, Enable/Disable, Clone to template, Delete. Reads
// come from the T-0584 GET route; create/edit/enable/disable/delete apply
// through the T-0584 change routes on the EPIC-006 gated path. The editor and
// the action dialog show a before/after plan preview, and disabling or deleting
// is compliance-impacting: the warning is shown and apply requires confirmation
// (SPEC §8). No browser call reaches a tenant directly.

import React, { useCallback, useEffect, useState, type CSSProperties, type ReactElement } from "react";
import { useSearchParams } from "next/navigation";
import { RequireTenant } from "../../../components/shell/RequireTenant";
import { resolveTenantId, useCurrentTenantId } from "../../../lib/useCurrentTenant";

export type Fetcher = typeof fetch;

export type RetentionPolicyAction = "create" | "edit" | "enable" | "disable" | "delete";

export interface RetentionPolicyItem {
  readonly id: string;
  readonly name: string;
  readonly state: string;
  readonly locations: readonly string[];
  readonly retentionPeriod: string | null;
  readonly disposition: string | null;
}

export interface RetentionChangePlan {
  readonly action: RetentionPolicyAction;
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

export const RETENTION_COMPLIANCE_WARNING =
  "Disabling or deleting a retention policy weakens the records-retention control. Review the before/after plan, then confirm. The change is audited with before/after.";

export interface RetentionDraft {
  readonly name?: string;
  readonly enabled?: boolean;
  readonly locations?: readonly string[];
  readonly retentionPeriod?: string;
  readonly disposition?: string;
}

/** Builds the BFF query string for GET /v1/tenants/:id/purview/retention. */
export function buildRetentionQuery(filter: { readonly search?: string; readonly state?: string }, limit = 100): string {
  const params = new URLSearchParams();
  if (filter.search) params.set("search", filter.search);
  if (filter.state) params.set("state", filter.state);
  params.set("limit", String(limit));
  return `?${params.toString()}`;
}

function stateRecord(policy: RetentionPolicyItem): Record<string, unknown> {
  return {
    name: policy.name,
    enabled: policy.state === "enabled",
    locations: [...policy.locations],
    retentionPeriod: policy.retentionPeriod,
    disposition: policy.disposition,
  };
}

/** Builds the before/after plan preview the editor and dialog show before apply. */
export function buildRetentionChangePlan(
  action: RetentionPolicyAction,
  policy: RetentionPolicyItem | null,
  draft: RetentionDraft | null,
): RetentionChangePlan {
  const before = policy ? stateRecord(policy) : null;
  const after = draft
    ? {
        name: (draft.name ?? policy?.name ?? "").trim(),
        enabled: draft.enabled ?? (policy ? policy.state === "enabled" : true),
        locations: [...(draft.locations ?? policy?.locations ?? [])],
        retentionPeriod: draft.retentionPeriod ?? policy?.retentionPeriod ?? null,
        disposition: draft.disposition ?? policy?.disposition ?? null,
      }
    : null;

  const complianceImpacting = action === "disable" || action === "delete";
  const diff: string[] = [];
  if (action === "create") {
    diff.push(`Create retention policy '${after?.name ?? ""}'`);
  } else if (action === "delete") {
    diff.push(`Delete retention policy '${before?.name ?? ""}'`);
  } else if (action === "disable") {
    diff.push(`Disable retention policy '${before?.name ?? ""}'`);
  } else if (action === "enable") {
    diff.push(`Enable retention policy '${before?.name ?? ""}'`);
  } else {
    if (before?.name !== after?.name) {
      diff.push(`Rename retention policy from '${before?.name ?? ""}' to '${after?.name ?? ""}'`);
    }
    if (before?.retentionPeriod !== after?.retentionPeriod) {
      diff.push(`Change retention period from '${before?.retentionPeriod ?? ""}' to '${after?.retentionPeriod ?? ""}'`);
    }
    if (before?.disposition !== after?.disposition) {
      diff.push(`Change disposition from '${before?.disposition ?? ""}' to '${after?.disposition ?? ""}'`);
    }
    if (JSON.stringify(before?.locations ?? []) !== JSON.stringify(after?.locations ?? [])) {
      diff.push(`Change the locations of retention policy '${after?.name ?? ""}'`);
    }
    if (before?.enabled !== after?.enabled) {
      diff.push(`Change the state of retention policy '${after?.name ?? ""}'`);
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
    ...(complianceImpacting ? { warning: RETENTION_COMPLIANCE_WARNING } : {}),
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
  return `/v1/tenants/${encodeURIComponent(tenantId)}/purview/retention`;
}

export async function listRetentionPolicies(
  tenantId: string,
  filter: { readonly search?: string; readonly state?: string },
  fetcher: Fetcher = fetch,
): Promise<{ items: RetentionPolicyItem[]; nextCursor: string | null }> {
  const response = await fetcher(`${basePath(tenantId)}${buildRetentionQuery(filter)}`);
  if (!response.ok) throw await readError(response, "List retention policies");
  const body = (await response.json()) as { items?: RetentionPolicyItem[]; nextCursor?: string | null };
  return { items: [...(body.items ?? [])], nextCursor: body.nextCursor ?? null };
}

/** Applies a plan through the T-0584 change routes (EPIC-006 gated path). */
export async function applyRetentionChange(
  tenantId: string,
  plan: RetentionChangePlan,
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
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!response.ok) throw await readError(response, "Apply retention change");
  return response.json();
}

/** Saves the policy as a local compliance template (SPEC §5/§6; T-0586 route). */
export async function saveRetentionTemplate(
  name: string,
  payload: Record<string, unknown>,
  fetcher: Fetcher = fetch,
): Promise<unknown> {
  const response = await fetcher("/v1/compliance-templates", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ area: "retention", name, payload, variables: {}, source: "local" }),
  });
  if (!response.ok) throw await readError(response, "Save retention template");
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

export interface RetentionViewProps {
  readonly tenantId: string;
  /** False disables write controls the caller lacks RBAC for. */
  readonly canWrite?: boolean;
  readonly fetcher?: Fetcher;
}

interface EditorState {
  readonly mode: "create" | "edit";
  readonly policy: RetentionPolicyItem | null;
  readonly name: string;
  readonly enabled: boolean;
  readonly locations: string;
  readonly retentionPeriod: string;
  readonly disposition: string;
}

interface PendingWrite {
  readonly plan: RetentionChangePlan;
  readonly payload: Record<string, unknown>;
  readonly label: string;
}

function parseLocations(value: string): string[] {
  return value
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

function editorAction(draft: EditorState): RetentionPolicyAction {
  if (draft.mode === "create") return "create";
  const wasEnabled = draft.policy?.state === "enabled";
  if (!draft.enabled && wasEnabled) return "disable";
  if (draft.enabled && !wasEnabled) return "enable";
  return "edit";
}

export function RetentionView({ tenantId, canWrite = true, fetcher = fetch }: RetentionViewProps): ReactElement {
  const [filter, setFilter] = useState<{ search?: string; state?: string }>({});
  const [items, setItems] = useState<RetentionPolicyItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [selected, setSelected] = useState<RetentionPolicyItem | null>(null);
  const [editor, setEditor] = useState<EditorState | null>(null);
  const [pending, setPending] = useState<PendingWrite | null>(null);
  const [plan, setPlan] = useState<RetentionChangePlan | null>(null);
  const [busy, setBusy] = useState(false);
  const [planError, setPlanError] = useState<string | null>(null);
  const [templateFor, setTemplateFor] = useState<RetentionPolicyItem | null>(null);
  const [templateName, setTemplateName] = useState("");

  const fetchList = useCallback(
    async (next: { search?: string; state?: string }): Promise<void> => {
      setLoading(true);
      setError(null);
      try {
        const page = await listRetentionPolicies(tenantId, next, fetcher);
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
      locations: "Exchange, SharePoint, Teams",
      retentionPeriod: "",
      disposition: "",
    });
    resetPlan();
  }

  function openEdit(policy: RetentionPolicyItem): void {
    setEditor({
      mode: "edit",
      policy,
      name: policy.name,
      enabled: policy.state === "enabled",
      locations: policy.locations.join(", "),
      retentionPeriod: policy.retentionPeriod ?? "",
      disposition: policy.disposition ?? "",
    });
    resetPlan();
  }

  function draftFromEditor(draft: EditorState): RetentionDraft {
    return {
      name: draft.name,
      enabled: draft.enabled,
      locations: parseLocations(draft.locations),
      retentionPeriod: draft.retentionPeriod.trim(),
      disposition: draft.disposition.trim(),
    };
  }

  function planForEditor(draft: EditorState): RetentionChangePlan {
    return buildRetentionChangePlan(editorAction(draft), draft.policy, draftFromEditor(draft));
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
      await applyRetentionChange(
        tenantId,
        current,
        {
          name: current.after?.name,
          enabled: current.after?.enabled,
          locations: current.after?.locations,
          retentionPeriod: current.after?.retentionPeriod,
          disposition: current.after?.disposition,
        },
        fetcher,
      );
      setNotice(`Retention policy ${editor.mode === "edit" ? "updated" : "created"}.`);
      setEditor(null);
      resetPlan();
      await fetchList(filter);
    } catch (err) {
      setPlanError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  function toggle(policy: RetentionPolicyItem): void {
    const enable = policy.state !== "enabled";
    const action: RetentionPolicyAction = enable ? "enable" : "disable";
    resetPlan();
    setPending({
      plan: buildRetentionChangePlan(action, policy, { enabled: enable }),
      payload: { enabled: enable },
      label: enable ? "Enable" : "Disable",
    });
  }

  function removePolicy(policy: RetentionPolicyItem): void {
    resetPlan();
    setPending({ plan: buildRetentionChangePlan("delete", policy, null), payload: {}, label: "Delete" });
  }

  async function confirmPending(): Promise<void> {
    if (!pending) return;
    setBusy(true);
    setPlanError(null);
    try {
      await applyRetentionChange(tenantId, pending.plan, pending.payload, fetcher);
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
      await saveRetentionTemplate(
        templateName.trim() || `${templateFor.name} template`,
        {
          name: templateFor.name,
          enabled: templateFor.state === "enabled",
          locations: templateFor.locations,
          retentionPeriod: templateFor.retentionPeriod,
          disposition: templateFor.disposition,
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
    <div style={pageStyle} data-testid="compliance-retention-page">
      <div>
        <div style={{ fontSize: "12px", color: "var(--text-soft)" }}>Security &amp; Compliance &gt; Purview Compliance &gt; Retention</div>
        <h1 style={{ fontSize: "24px", fontWeight: 700, margin: "4px 0 0", fontFamily: "var(--font-display, var(--font-sans))" }}>
          Retention Policies
        </h1>
        <p style={{ margin: "4px 0 0", color: "var(--text-soft)", fontSize: "14px" }}>
          Preview every change before it is applied. Disabling a policy is compliance-impacting.
        </p>
      </div>

      <div style={{ display: "flex", gap: "8px", flexWrap: "wrap", alignItems: "center" }} data-testid="compliance-retention-filters">
        <input
          type="text"
          placeholder="Search policy name..."
          value={filter.search ?? ""}
          onChange={(e) => setFilter((prev) => ({ ...prev, search: e.target.value || undefined }))}
          style={inputStyle}
          aria-label="Search retention policies"
          data-testid="compliance-retention-search"
        />
        <select
          value={filter.state ?? ""}
          onChange={(e) => setFilter((prev) => ({ ...prev, state: e.target.value || undefined }))}
          style={inputStyle}
          aria-label="Filter by state"
          data-testid="compliance-retention-filter-state"
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
          data-testid="compliance-retention-new"
        >
          New policy
        </button>
      </div>

      {notice && (
        <div style={{ padding: "12px 16px", borderRadius: "6px", background: "var(--success-soft)", border: "1px solid var(--success)", color: "var(--success-text)", fontSize: "14px" }} data-testid="compliance-retention-notice">
          {notice}
        </div>
      )}
      {error && (
        <div role="alert" style={{ padding: "12px 16px", borderRadius: "6px", background: "var(--danger-soft)", border: "1px solid var(--danger)", color: "var(--danger-text)", fontSize: "14px" }} data-testid="compliance-retention-error">
          {error}
        </div>
      )}

      <div style={{ overflowX: "auto" }}>
        <table style={tableStyle} data-testid="compliance-retention-table">
          <thead>
            <tr>
              <th style={thStyle}>Name</th>
              <th style={thStyle}>State</th>
              <th style={thStyle}>Locations</th>
              <th style={thStyle}>Retention period</th>
              <th style={thStyle}>Disposition</th>
              <th style={thStyle}>Actions</th>
            </tr>
          </thead>
          <tbody>
            {loading ? (
              <tr><td style={tdStyle} colSpan={6}>Loading retention policies…</td></tr>
            ) : items.length === 0 ? (
              <tr><td style={tdStyle} colSpan={6}>No retention policies found.</td></tr>
            ) : (
              items.map((policy) => {
                const enabled = policy.state === "enabled";
                return (
                  <tr key={policy.id} data-testid={`retention-row-${policy.id}`}>
                    <td style={tdStyle}>{policy.name}</td>
                    <td style={tdStyle}>{enabled ? "Enabled" : "Disabled"}</td>
                    <td style={tdStyle}>{policy.locations.length === 0 ? "—" : policy.locations.join(", ")}</td>
                    <td style={tdStyle}>{policy.retentionPeriod ?? "—"}</td>
                    <td style={tdStyle}>{policy.disposition ?? "—"}</td>
                    <td style={tdStyle}>
                      <div style={{ display: "flex", gap: "6px", flexWrap: "wrap" }}>
                        <button type="button" style={buttonStyle} onClick={() => setSelected(policy)} data-testid={`retention-view-${policy.id}`}>View</button>
                        <button type="button" style={writeDisabled ? { ...buttonStyle, ...disabledStyle } : buttonStyle} disabled={writeDisabled} title={writeTitle} onClick={() => openEdit(policy)} data-testid={`retention-edit-${policy.id}`}>Edit</button>
                        <button type="button" style={writeDisabled ? { ...buttonStyle, ...disabledStyle } : buttonStyle} disabled={writeDisabled} title={writeTitle} onClick={() => toggle(policy)} data-testid={`retention-toggle-${policy.id}`}>{enabled ? "Disable" : "Enable"}</button>
                        <button type="button" style={writeDisabled ? { ...buttonStyle, ...disabledStyle } : buttonStyle} disabled={writeDisabled} title={writeTitle} onClick={() => { setTemplateFor(policy); setTemplateName(`${policy.name} template`); resetPlan(); }} data-testid={`retention-clone-template-${policy.id}`}>Clone to template</button>
                        <button type="button" style={writeDisabled ? { ...buttonStyle, ...disabledStyle } : buttonStyle} disabled={writeDisabled} title={writeTitle} onClick={() => removePolicy(policy)} data-testid={`retention-delete-${policy.id}`}>Delete</button>
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
        <aside style={drawerStyle} role="dialog" aria-modal="true" aria-label={`Retention policy ${selected.name}`} data-testid="retention-drawer">
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
            <h2 style={{ margin: 0, fontSize: "18px" }}>{selected.name}</h2>
            <button type="button" style={buttonStyle} onClick={() => setSelected(null)} data-testid="retention-drawer-close">Close</button>
          </div>
          <dl style={{ margin: 0, display: "grid", gridTemplateColumns: "140px 1fr", gap: "8px", fontSize: "14px" }}>
            <dt style={{ color: "var(--text-soft)" }}>State</dt><dd style={{ margin: 0 }}>{selected.state}</dd>
            <dt style={{ color: "var(--text-soft)" }}>Locations</dt><dd style={{ margin: 0 }}>{selected.locations.length === 0 ? "—" : selected.locations.join(", ")}</dd>
            <dt style={{ color: "var(--text-soft)" }}>Retention period</dt><dd style={{ margin: 0 }}>{selected.retentionPeriod ?? "—"}</dd>
            <dt style={{ color: "var(--text-soft)" }}>Disposition</dt><dd style={{ margin: 0 }}>{selected.disposition ?? "—"}</dd>
          </dl>
        </aside>
      )}

      {editor && (
        <div style={overlayStyle} role="dialog" aria-modal="true" aria-label={editor.mode === "edit" ? "Edit retention policy" : "New retention policy"} data-testid="retention-editor">
          <div style={dialogStyle}>
            <h3 style={{ margin: 0 }}>{editor.mode === "edit" ? `Edit retention policy — ${editor.policy?.name}` : "New retention policy"}</h3>
            <label style={{ display: "flex", flexDirection: "column", gap: "6px", fontSize: "14px" }}>
              Name
              <input type="text" value={editor.name} onChange={(e) => setEditor({ ...editor, name: e.target.value })} style={inputStyle} aria-label="Policy name" data-testid="retention-name" />
            </label>
            <div style={{ display: "flex", gap: "12px", flexWrap: "wrap" }}>
              <label style={{ display: "flex", flexDirection: "column", gap: "6px", fontSize: "14px" }}>
                State
                <select value={editor.enabled ? "enabled" : "disabled"} onChange={(e) => setEditor({ ...editor, enabled: e.target.value === "enabled" })} style={inputStyle} aria-label="Policy state" data-testid="retention-state">
                  <option value="enabled">Enabled</option>
                  <option value="disabled">Disabled</option>
                </select>
              </label>
              <label style={{ display: "flex", flexDirection: "column", gap: "6px", fontSize: "14px" }}>
                Retention period
                <input type="text" value={editor.retentionPeriod} onChange={(e) => setEditor({ ...editor, retentionPeriod: e.target.value })} style={inputStyle} aria-label="Retention period" data-testid="retention-period" />
              </label>
              <label style={{ display: "flex", flexDirection: "column", gap: "6px", fontSize: "14px" }}>
                Disposition
                <input type="text" value={editor.disposition} onChange={(e) => setEditor({ ...editor, disposition: e.target.value })} style={inputStyle} aria-label="Disposition" data-testid="retention-disposition" />
              </label>
            </div>
            <label style={{ display: "flex", flexDirection: "column", gap: "6px", fontSize: "14px" }}>
              Locations
              <input type="text" value={editor.locations} onChange={(e) => setEditor({ ...editor, locations: e.target.value })} style={inputStyle} aria-label="Policy locations" data-testid="retention-locations" />
            </label>
            <div>
              <button type="button" style={buttonStyle} onClick={previewEditor} disabled={busy || editor.name.trim().length === 0} data-testid="retention-preview">Preview plan</button>
            </div>
            <RetentionPlanPreview prefix="retention" plan={plan} busy={busy} error={planError} warning={RETENTION_COMPLIANCE_WARNING} />
            <div style={{ display: "flex", gap: "8px", justifyContent: "flex-end" }}>
              <button type="button" style={buttonStyle} onClick={() => { setEditor(null); resetPlan(); }} data-testid="retention-editor-cancel">Cancel</button>
              <button type="button" style={{ ...primaryButtonStyle, ...(busy || !plan || !plan.valid ? disabledStyle : {}) }} disabled={busy || !plan || !plan.valid} onClick={() => void confirmEditor()} data-testid="retention-editor-confirm">Confirm and apply</button>
            </div>
          </div>
        </div>
      )}

      {pending && (
        <div style={overlayStyle} role="dialog" aria-modal="true" aria-label={`${pending.label} retention policy`} data-testid="retention-action-dialog">
          <div style={dialogStyle}>
            <h3 style={{ margin: 0 }}>{pending.label}{pending.plan.targetName ? ` — ${pending.plan.targetName}` : ""}</h3>
            <RetentionPlanPreview prefix="retention" plan={plan ?? pending.plan} busy={busy} error={planError} warning={RETENTION_COMPLIANCE_WARNING} />
            <div style={{ display: "flex", gap: "8px", justifyContent: "flex-end" }}>
              <button type="button" style={buttonStyle} onClick={() => { setPending(null); resetPlan(); }} data-testid="retention-action-cancel">Cancel</button>
              <button type="button" style={{ ...primaryButtonStyle, ...(busy || !(plan ?? pending.plan).valid ? disabledStyle : {}) }} disabled={busy || !(plan ?? pending.plan).valid} onClick={() => void confirmPending()} data-testid="retention-action-confirm">Confirm and apply</button>
            </div>
          </div>
        </div>
      )}

      {templateFor && (
        <div style={overlayStyle} role="dialog" aria-modal="true" aria-label="Clone to template" data-testid="retention-template-dialog">
          <div style={dialogStyle}>
            <h3 style={{ margin: 0 }}>Clone to template — {templateFor.name}</h3>
            <p style={{ margin: 0, color: "var(--text-soft)", fontSize: "14px" }}>
              Saves the policy as a local compliance template. No tenant write is made.
            </p>
            <label style={{ display: "flex", flexDirection: "column", gap: "6px", fontSize: "14px" }}>
              Template name
              <input type="text" value={templateName} onChange={(e) => setTemplateName(e.target.value)} style={inputStyle} aria-label="Template name" data-testid="retention-template-name" />
            </label>
            {planError && <div role="alert" style={{ color: "var(--danger-text)", fontSize: "14px" }}>{planError}</div>}
            <div style={{ display: "flex", gap: "8px", justifyContent: "flex-end" }}>
              <button type="button" style={buttonStyle} onClick={() => { setTemplateFor(null); setTemplateName(""); resetPlan(); }} data-testid="retention-template-cancel">Cancel</button>
              <button type="button" style={{ ...primaryButtonStyle, ...(busy || templateName.trim().length === 0 ? disabledStyle : {}) }} disabled={busy || templateName.trim().length === 0} onClick={() => void saveTemplate()} data-testid="retention-template-save">Save template</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

interface RetentionPlanPreviewProps {
  readonly prefix: string;
  readonly plan: RetentionChangePlan | null;
  readonly busy: boolean;
  readonly error: string | null;
  readonly warning: string;
}

function RetentionPlanPreview({ prefix, plan, busy, error, warning }: RetentionPlanPreviewProps): ReactElement {
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

export default function RetentionPage(): ReactElement {
  const searchParams = useSearchParams();
  const tenantId = resolveTenantId(searchParams.get("tenantId"), useCurrentTenantId());
  return (
    <RequireTenant tenantId={tenantId}>
      <RetentionView tenantId={tenantId} />
    </RequireTenant>
  );
}
