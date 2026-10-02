"use client";

// Tenant allow/block lists (EPIC-022 SPEC.md §3.4; T-0427). Nav:
// Administration → Allow/Block Lists. Title "Tenant Allow/Block Lists" with
// the §3.4 table (type sender/domain/URL/file, value, action allow/block,
// expires, notes) and row actions (Add, Edit, Remove) with optional expiry.
// Entries read live from EXO through the BFF; every write opens a plan
// preview / confirmation dialog and applies with confirm:true. Adding an
// allow entry or removing a block entry is flagged security-impacting before
// apply (SPEC §4.3, §8, §9). No browser call reaches a tenant directly —
// everything goes through the BFF.

import React, { useCallback, useEffect, useMemo, useState, type CSSProperties, type ReactElement } from "react";
import { useSearchParams } from "next/navigation";
import { RequireTenant } from "../../../components/shell/RequireTenant";
import { resolveTenantId, useCurrentTenantId } from "../../../lib/useCurrentTenant";

export const ALLOW_BLOCK_TYPES = ["sender", "domain", "url", "file"] as const;
export type AllowBlockType = (typeof ALLOW_BLOCK_TYPES)[number];

export const ALLOW_BLOCK_ACTIONS = ["allow", "block"] as const;
export type AllowBlockEntryAction = (typeof ALLOW_BLOCK_ACTIONS)[number];

export interface AllowBlockEntry {
  readonly type: AllowBlockType;
  readonly value: string;
  readonly action: AllowBlockEntryAction;
  readonly expiresOn: string | null;
  readonly notes: string;
}

export interface AllowBlockPlan {
  readonly action: "create" | "edit" | "delete";
  readonly type: AllowBlockType;
  readonly value: string;
  readonly entryAction: AllowBlockEntryAction;
  readonly before: AllowBlockEntry | null;
  readonly after: AllowBlockEntry | null;
  readonly diff: readonly string[];
  readonly valid: boolean;
  readonly dryRun: boolean;
  readonly requiresConfirmation: boolean;
  readonly securityImpacting: boolean;
  readonly affectedEntries: readonly { readonly type: string; readonly value: string; readonly action: string; readonly state: string }[];
  readonly warning?: string;
}

export type Fetcher = typeof fetch;

export const ALLOW_BLOCK_SECURITY_WARNING =
  "Allowing a sender, domain, URL, or file bypasses spam and phishing protection. Prefer an expiry, review the plan preview before applying, and note this change is audited with before/after.";

function allowBlockBasePath(tenantId: string): string {
  return `/v1/tenants/${encodeURIComponent(tenantId)}/allow-block`;
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

export async function listAllowBlockEntries(
  tenantId: string,
  fetcher: Fetcher = fetch,
): Promise<AllowBlockEntry[]> {
  const response = await fetcher(allowBlockBasePath(tenantId));
  if (!response.ok) throw await readError(response, "List allow/block entries");
  const body = (await response.json()) as { items?: AllowBlockEntry[] };
  return [...(body.items ?? [])];
}

export async function previewAllowBlockWrite(
  tenantId: string,
  method: "POST" | "PATCH" | "DELETE",
  payload: Record<string, unknown>,
  fetcher: Fetcher = fetch,
): Promise<AllowBlockPlan> {
  const response = await fetcher(allowBlockBasePath(tenantId), {
    method,
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ ...payload, preview: true }),
  });
  if (!response.ok) throw await readError(response, "Preview allow/block change");
  return (await response.json()) as AllowBlockPlan;
}

export async function applyAllowBlockWrite(
  tenantId: string,
  method: "POST" | "PATCH" | "DELETE",
  payload: Record<string, unknown>,
  fetcher: Fetcher = fetch,
): Promise<unknown> {
  const response = await fetcher(allowBlockBasePath(tenantId), {
    method,
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ ...payload, preview: false, confirm: true }),
  });
  if (!response.ok) throw await readError(response, "Apply allow/block change");
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
  maxWidth: "620px",
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

export interface AllowBlockViewProps {
  readonly tenantId: string;
  /** False hides write controls the caller lacks RBAC for. */
  readonly canWrite?: boolean;
  readonly fetcher?: Fetcher;
}

interface EntryEditor {
  readonly mode: "create" | "edit";
  readonly entry: AllowBlockEntry | null;
  readonly type: AllowBlockType;
  readonly value: string;
  readonly action: AllowBlockEntryAction;
  readonly expiresOn: string;
  readonly notes: string;
}

interface PendingWrite {
  readonly action: "create" | "edit" | "delete";
  readonly label: string;
  readonly entry: AllowBlockEntry | null;
  readonly method: "POST" | "PATCH" | "DELETE";
  readonly payload: Record<string, unknown>;
}

function formatExpires(expiresOn: string | null): string {
  if (!expiresOn) return "—";
  const parsed = new Date(expiresOn);
  return Number.isNaN(parsed.getTime()) ? expiresOn : parsed.toLocaleString();
}

export function AllowBlockView({
  tenantId,
  canWrite = true,
  fetcher = fetch,
}: AllowBlockViewProps): ReactElement {
  const [items, setItems] = useState<AllowBlockEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [editor, setEditor] = useState<EntryEditor | null>(null);
  const [pending, setPending] = useState<PendingWrite | null>(null);
  const [plan, setPlan] = useState<AllowBlockPlan | null>(null);
  const [planBusy, setPlanBusy] = useState(false);
  const [planError, setPlanError] = useState<string | null>(null);

  const fetchList = useCallback(async (): Promise<void> => {
    setLoading(true);
    setError(null);
    try {
      setItems(await listAllowBlockEntries(tenantId, fetcher));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [tenantId, fetcher]);

  useEffect(() => {
    void fetchList();
  }, [fetchList]);

  function resetPlan(): void {
    setPlan(null);
    setPlanError(null);
  }

  function openCreate(): void {
    setEditor({ mode: "create", entry: null, type: "sender", value: "", action: "block", expiresOn: "", notes: "" });
    resetPlan();
  }

  function openEdit(entry: AllowBlockEntry): void {
    setEditor({
      mode: "edit",
      entry,
      type: entry.type,
      value: entry.value,
      action: entry.action,
      expiresOn: entry.expiresOn ? entry.expiresOn.slice(0, 16) : "",
      notes: entry.notes,
    });
    resetPlan();
  }

  function editorPayload(draft: EntryEditor): Record<string, unknown> {
    const payload: Record<string, unknown> = {
      type: draft.type,
      value: draft.value.trim(),
      action: draft.action,
      notes: draft.notes.trim(),
    };
    if (draft.expiresOn.trim() !== "") payload.expiresOn = new Date(draft.expiresOn).toISOString();
    return payload;
  }

  async function previewEditor(): Promise<void> {
    if (!editor) return;
    setPlanBusy(true);
    resetPlan();
    try {
      const preview = await previewAllowBlockWrite(
        tenantId,
        editor.mode === "edit" ? "PATCH" : "POST",
        editorPayload(editor),
        fetcher,
      );
      setPlan(preview);
    } catch (err) {
      setPlanError(err instanceof Error ? err.message : String(err));
    } finally {
      setPlanBusy(false);
    }
  }

  async function confirmEditor(): Promise<void> {
    if (!editor) return;
    setPlanBusy(true);
    setPlanError(null);
    try {
      await applyAllowBlockWrite(tenantId, editor.mode === "edit" ? "PATCH" : "POST", editorPayload(editor), fetcher);
      setNotice(`Entry ${editor.mode === "edit" ? "updated" : "added"}.`);
      setEditor(null);
      resetPlan();
      await fetchList();
    } catch (err) {
      setPlanError(err instanceof Error ? err.message : String(err));
    } finally {
      setPlanBusy(false);
    }
  }

  function removeEntry(entry: AllowBlockEntry): void {
    void runPreview({
      action: "delete",
      label: "Remove",
      entry,
      method: "DELETE",
      payload: { type: entry.type, value: entry.value, action: entry.action },
    });
  }

  async function runPreview(next: PendingWrite): Promise<void> {
    setPending(next);
    resetPlan();
    setPlanBusy(true);
    try {
      const preview = await previewAllowBlockWrite(tenantId, next.method, next.payload, fetcher);
      setPlan(preview);
    } catch (err) {
      setPlanError(err instanceof Error ? err.message : String(err));
    } finally {
      setPlanBusy(false);
    }
  }

  async function confirmPending(): Promise<void> {
    if (!pending) return;
    setPlanBusy(true);
    setPlanError(null);
    try {
      await applyAllowBlockWrite(tenantId, pending.method, pending.payload, fetcher);
      setNotice(`${pending.label} applied${pending.entry ? ` to “${pending.entry.value}”` : ""}.`);
      setPending(null);
      resetPlan();
      await fetchList();
    } catch (err) {
      setPlanError(err instanceof Error ? err.message : String(err));
    } finally {
      setPlanBusy(false);
    }
  }

  const writeDisabled = !canWrite;
  const securityWarning =
    pending && plan && "warning" in plan && plan.warning
      ? plan.warning
      : pending && (pending.action === "create" || pending.action === "delete")
        ? ALLOW_BLOCK_SECURITY_WARNING
        : undefined;

  const dialogTitle = useMemo(() => {
    if (!pending) return "";
    if (pending.entry) return `${pending.label} — ${pending.entry.value}`;
    return pending.label;
  }, [pending]);

  return (
    <div style={pageStyle} data-testid="allow-block-page">
      <div>
        <div style={{ fontSize: "12px", color: "var(--text-soft)" }}>Administration &gt; Allow/Block Lists</div>
        <h1 style={{ fontSize: "24px", fontWeight: 700, margin: "4px 0 0", fontFamily: "var(--font-display, var(--font-sans))" }}>
          Tenant Allow/Block Lists
        </h1>
        <p style={{ margin: "4px 0 0", color: "var(--text-soft)", fontSize: "14px" }}>
          Add senders, domains, URLs, or files to the tenant allow/block list with an optional expiry. Allow entries warn before apply.
        </p>
      </div>

      <div style={{ display: "flex", gap: "8px", flexWrap: "wrap", alignItems: "center" }}>
        <button
          type="button"
          style={{ ...primaryButtonStyle, ...(writeDisabled ? disabledStyle : {}) }}
          disabled={writeDisabled}
          title={writeDisabled ? "Requires spam.write permission" : "Add entry"}
          onClick={openCreate}
          data-testid="allow-block-add"
        >
          Add entry
        </button>
      </div>

      {notice && (
        <div style={{ padding: "12px 16px", borderRadius: "6px", background: "var(--success-soft)", border: "1px solid var(--success)", color: "var(--success-text)", fontSize: "14px" }} data-testid="allow-block-notice">
          {notice}
        </div>
      )}
      {error && (
        <div role="alert" style={{ padding: "12px 16px", borderRadius: "6px", background: "var(--danger-soft)", border: "1px solid var(--danger)", color: "var(--danger-text)", fontSize: "14px" }} data-testid="allow-block-error">
          {error}
        </div>
      )}

      <div style={{ overflowX: "auto" }}>
        <table style={tableStyle} data-testid="allow-block-table">
          <thead>
            <tr>
              <th style={thStyle}>Type</th>
              <th style={thStyle}>Value</th>
              <th style={thStyle}>Action</th>
              <th style={thStyle}>Expires</th>
              <th style={thStyle}>Notes</th>
              <th style={thStyle}>Actions</th>
            </tr>
          </thead>
          <tbody>
            {loading ? (
              <tr><td style={tdStyle} colSpan={6}>Loading allow/block entries…</td></tr>
            ) : items.length === 0 ? (
              <tr><td style={tdStyle} colSpan={6}>No allow/block entries found.</td></tr>
            ) : (
              items.map((entry) => (
                <tr key={`${entry.type}:${entry.value}:${entry.action}`} data-testid={`allow-block-row-${entry.type}-${entry.value}`}>
                  <td style={tdStyle}>{entry.type}</td>
                  <td style={tdStyle}>{entry.value}</td>
                  <td style={tdStyle}>{entry.action}</td>
                  <td style={tdStyle}>{formatExpires(entry.expiresOn)}</td>
                  <td style={tdStyle}>{entry.notes || "—"}</td>
                  <td style={tdStyle}>
                    <div style={{ display: "flex", gap: "6px", flexWrap: "wrap" }}>
                      <button type="button" style={writeDisabled ? { ...buttonStyle, ...disabledStyle } : buttonStyle} disabled={writeDisabled} title={writeDisabled ? "Requires spam.write permission" : "Edit"} onClick={() => openEdit(entry)} data-testid={`allow-block-edit-${entry.type}-${entry.value}`}>Edit</button>
                      <button type="button" style={writeDisabled ? { ...buttonStyle, ...disabledStyle } : buttonStyle} disabled={writeDisabled} title={writeDisabled ? "Requires spam.write permission" : "Remove"} onClick={() => removeEntry(entry)} data-testid={`allow-block-remove-${entry.type}-${entry.value}`}>Remove</button>
                    </div>
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      {editor && (
        <div style={overlayStyle} role="dialog" aria-modal="true" aria-label={editor.mode === "edit" ? "Edit entry" : "Add entry"} data-testid="allow-block-editor">
          <div style={dialogStyle}>
            <h3 style={{ margin: 0 }}>{editor.mode === "edit" ? `Edit ${editor.entry?.type} entry` : "Add allow/block entry"}</h3>
            <div style={{ display: "flex", gap: "12px", flexWrap: "wrap" }}>
              <label style={{ display: "flex", flexDirection: "column", gap: "6px", fontSize: "14px" }}>
                Type
                <select value={editor.type} onChange={(e) => setEditor({ ...editor, type: e.target.value as AllowBlockType })} style={inputStyle} aria-label="Entry type" data-testid="allow-block-type" disabled={editor.mode === "edit"}>
                  {ALLOW_BLOCK_TYPES.map((type) => (
                    <option key={type} value={type}>{type}</option>
                  ))}
                </select>
              </label>
              <label style={{ display: "flex", flexDirection: "column", gap: "6px", fontSize: "14px" }}>
                Action
                <select value={editor.action} onChange={(e) => setEditor({ ...editor, action: e.target.value as AllowBlockEntryAction })} style={inputStyle} aria-label="Entry action" data-testid="allow-block-action">
                  {ALLOW_BLOCK_ACTIONS.map((action) => (
                    <option key={action} value={action}>{action}</option>
                  ))}
                </select>
              </label>
            </div>
            <label style={{ display: "flex", flexDirection: "column", gap: "6px", fontSize: "14px" }}>
              Value
              <input type="text" value={editor.value} onChange={(e) => setEditor({ ...editor, value: e.target.value })} style={inputStyle} aria-label="Entry value" data-testid="allow-block-value" disabled={editor.mode === "edit"} />
            </label>
            <label style={{ display: "flex", flexDirection: "column", gap: "6px", fontSize: "14px" }}>
              Expires (optional)
              <input type="datetime-local" value={editor.expiresOn} onChange={(e) => setEditor({ ...editor, expiresOn: e.target.value })} style={inputStyle} aria-label="Entry expiry" data-testid="allow-block-expiry" />
            </label>
            <label style={{ display: "flex", flexDirection: "column", gap: "6px", fontSize: "14px" }}>
              Notes
              <input type="text" value={editor.notes} onChange={(e) => setEditor({ ...editor, notes: e.target.value })} style={inputStyle} aria-label="Entry notes" data-testid="allow-block-notes" />
            </label>
            <div>
              <button type="button" style={buttonStyle} onClick={() => void previewEditor()} disabled={planBusy || editor.value.trim().length === 0} data-testid="allow-block-preview">Preview plan</button>
            </div>
            <AllowBlockPlanPreview plan={plan} planBusy={planBusy} planError={planError} />
            <div style={{ display: "flex", gap: "8px", justifyContent: "flex-end" }}>
              <button type="button" style={buttonStyle} onClick={() => { setEditor(null); resetPlan(); }} data-testid="allow-block-editor-cancel">Cancel</button>
              <button type="button" style={{ ...primaryButtonStyle, ...(planBusy || !plan || !plan.valid ? disabledStyle : {}) }} disabled={planBusy || !plan || !plan.valid} onClick={() => void confirmEditor()} data-testid="allow-block-editor-confirm">Confirm and apply</button>
            </div>
          </div>
        </div>
      )}

      {pending && (
        <div style={overlayStyle} role="dialog" aria-modal="true" aria-label={dialogTitle} data-testid="allow-block-action-dialog">
          <div style={dialogStyle}>
            <h3 style={{ margin: 0 }}>{dialogTitle}</h3>
            {securityWarning && (
              <div style={flagStyle} data-testid="allow-block-security-warning">⚠ {securityWarning}</div>
            )}
            <AllowBlockPlanPreview plan={plan} planBusy={planBusy} planError={planError} />
            <div style={{ display: "flex", gap: "8px", justifyContent: "flex-end" }}>
              <button type="button" style={buttonStyle} onClick={() => { setPending(null); resetPlan(); }} data-testid="allow-block-action-cancel">Cancel</button>
              <button type="button" style={{ ...primaryButtonStyle, ...(planBusy || !plan || !plan.valid ? disabledStyle : {}) }} disabled={planBusy || !plan || !plan.valid} onClick={() => void confirmPending()} data-testid="allow-block-action-confirm">Confirm and apply</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

interface AllowBlockPlanPreviewProps {
  readonly plan: AllowBlockPlan | null;
  readonly planBusy: boolean;
  readonly planError: string | null;
}

function AllowBlockPlanPreview({ plan, planBusy, planError }: AllowBlockPlanPreviewProps): ReactElement {
  return (
    <div data-testid="allow-block-plan-preview">
      {planBusy && <p style={{ margin: 0, fontSize: "14px" }}>Loading plan preview…</p>}
      {planError && <div role="alert" style={{ color: "var(--danger-text)", fontSize: "14px" }}>{planError}</div>}
      {plan && (
        <div style={{ display: "flex", flexDirection: "column", gap: "8px", fontSize: "14px" }}>
          <div data-testid="allow-block-plan-diff">
            {plan.diff.length === 0 ? "No changes." : plan.diff.map((line, index) => <div key={index}>{line}</div>)}
          </div>
          {plan.requiresConfirmation && <div style={{ color: "var(--text-soft)", fontSize: "13px" }}>Confirmation required before apply.</div>}
        </div>
      )}
    </div>
  );
}

export default function AllowBlockPage(): ReactElement {
  const searchParams = useSearchParams();
  const tenantId = resolveTenantId(searchParams.get("tenantId"), useCurrentTenantId());
  return (
    <RequireTenant tenantId={tenantId}>
      <AllowBlockView tenantId={tenantId} />
    </RequireTenant>
  );
}
