"use client";

// Retention Policy/Tag Management (EPIC-020 SPEC.md §3.6, §4.4; T-0389).
// Lists retention policies and tags from the BFF, creates/edits tags with a
// plan preview, and assigns tags to mailboxes (per-mailbox and bulk) with the
// affected-mailbox preview shown before apply. No browser call reaches a
// tenant directly.

import React, { useCallback, useEffect, useState, type CSSProperties, type ReactElement } from "react";
import { useSearchParams } from "next/navigation";
import { RequireTenant } from "../../../../components/shell/RequireTenant";
import { resolveTenantId, useCurrentTenantId } from "../../../../lib/useCurrentTenant";
import type { Fetcher } from "../page";

export interface RetentionPolicy {
  readonly id: string;
  readonly name: string;
}

export interface RetentionTag {
  readonly id: string;
  readonly name: string;
  readonly type?: string;
  readonly retentionDays?: number | null;
  readonly retentionAction?: string;
  readonly enabled?: boolean;
}

export interface RetentionAssignPlan {
  readonly diff: readonly string[];
  readonly valid: boolean;
  readonly dryRun: boolean;
  readonly requiresConfirmation: boolean;
  readonly affectedMailboxes?: readonly string[];
}

export interface RetentionListing {
  readonly policies: RetentionPolicy[];
  readonly tags: RetentionTag[];
  /** Set when the BFF answers 501 for the tag read: no worker backs it yet. Never an empty-list stand-in. */
  readonly tagsUnavailable?: string;
}

export async function listRetention(tenantId: string, fetcher: Fetcher = fetch): Promise<RetentionListing> {
  const [policiesResponse, tagsResponse] = await Promise.all([
    fetcher(`/v1/tenants/${encodeURIComponent(tenantId)}/retention/policies`),
    fetcher(`/v1/tenants/${encodeURIComponent(tenantId)}/retention/tags`),
  ]);
  if (!policiesResponse.ok) throw new Error(`List retention policies failed: HTTP ${policiesResponse.status}`);
  const policies = (await policiesResponse.json()) as { policies?: RetentionPolicy[] };
  if (tagsResponse.status === 501) {
    let message = "Retention tags are not available yet.";
    try {
      const body = (await tagsResponse.json()) as { message?: string };
      if (body?.message) message = body.message;
    } catch {
      // Keep the default message.
    }
    return { policies: [...(policies.policies ?? [])], tags: [], tagsUnavailable: message };
  }
  if (!tagsResponse.ok) throw new Error(`List retention tags failed: HTTP ${tagsResponse.status}`);
  const tags = (await tagsResponse.json()) as { tags?: RetentionTag[] };
  return { policies: [...(policies.policies ?? [])], tags: [...(tags.tags ?? [])] };
}

export async function previewRetentionTagWrite(
  tenantId: string,
  tagId: string | null,
  payload: Record<string, unknown>,
  fetcher: Fetcher = fetch,
): Promise<{ diff: readonly string[]; valid: boolean; dryRun: boolean; requiresConfirmation: boolean }> {
  const base = `/v1/tenants/${encodeURIComponent(tenantId)}/retention/tags`;
  const url = tagId ? `${base}/${encodeURIComponent(tagId)}` : base;
  // Create is POST /retention/tags; edit is PATCH /retention/tags/:tagId (SPEC §6 route table).
  const response = await fetcher(url, {
    method: tagId ? "PATCH" : "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ ...payload, preview: true }),
  });
  if (!response.ok) throw new Error(`Preview retention tag change failed: HTTP ${response.status}`);
  return (await response.json()) as { diff: readonly string[]; valid: boolean; dryRun: boolean; requiresConfirmation: boolean };
}

export async function applyRetentionTagWrite(
  tenantId: string,
  tagId: string | null,
  payload: Record<string, unknown>,
  fetcher: Fetcher = fetch,
): Promise<unknown> {
  const base = `/v1/tenants/${encodeURIComponent(tenantId)}/retention/tags`;
  const url = tagId ? `${base}/${encodeURIComponent(tagId)}` : base;
  const response = await fetcher(url, {
    method: tagId ? "PATCH" : "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ ...payload, preview: false, confirm: true }),
  });
  if (!response.ok) throw new Error(`Apply retention tag change failed: HTTP ${response.status}`);
  return response.json();
}

export async function previewRetentionAssign(
  tenantId: string,
  payload: Record<string, unknown>,
  bulk: boolean,
  fetcher: Fetcher = fetch,
): Promise<RetentionAssignPlan> {
  const path = bulk ? "assign/bulk" : "assign";
  const response = await fetcher(`/v1/tenants/${encodeURIComponent(tenantId)}/retention/${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ ...payload, preview: true }),
  });
  if (!response.ok) throw new Error(`Preview retention assignment failed: HTTP ${response.status}`);
  return (await response.json()) as RetentionAssignPlan;
}

export async function applyRetentionAssign(
  tenantId: string,
  payload: Record<string, unknown>,
  bulk: boolean,
  fetcher: Fetcher = fetch,
): Promise<unknown> {
  const path = bulk ? "assign/bulk" : "assign";
  const response = await fetcher(`/v1/tenants/${encodeURIComponent(tenantId)}/retention/${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ ...payload, preview: false, confirm: true }),
  });
  if (!response.ok) throw new Error(`Apply retention assignment failed: HTTP ${response.status}`);
  return response.json();
}

const pageStyle: CSSProperties = {
  padding: "24px",
  maxWidth: "1200px",
  margin: "0 auto",
  display: "flex",
  flexDirection: "column",
  gap: "20px",
  fontFamily: "var(--font-sans, system-ui, sans-serif)",
  color: "var(--text)",
};

const cardStyle: CSSProperties = {
  background: "var(--surface)",
  border: "1px solid var(--border)",
  borderRadius: "var(--radius, 10px)",
  padding: "20px",
  display: "flex",
  flexDirection: "column",
  gap: "12px",
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

const inputStyle: CSSProperties = {
  padding: "8px 12px",
  background: "var(--input-bg, var(--bg))",
  border: "1px solid var(--border)",
  borderRadius: "6px",
  color: "var(--text)",
  fontSize: "14px",
};

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
const tdStyle: CSSProperties = { padding: "10px 12px", borderBottom: "1px solid var(--border)" };

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
  maxWidth: "560px",
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

export interface RetentionViewProps {
  readonly tenantId: string;
  readonly canWrite?: boolean;
  readonly fetcher?: Fetcher;
}

export function RetentionView({ tenantId, canWrite = true, fetcher = fetch }: RetentionViewProps): ReactElement {
  const [policies, setPolicies] = useState<RetentionPolicy[]>([]);
  const [tags, setTags] = useState<RetentionTag[]>([]);
  const [tagsUnavailable, setTagsUnavailable] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [tagDialog, setTagDialog] = useState<null | { tag: RetentionTag | null }>(null);
  const [tagName, setTagName] = useState("");
  const [tagType, setTagType] = useState("");
  const [tagDays, setTagDays] = useState("");
  const [assignOpen, setAssignOpen] = useState(false);
  const [assignTagId, setAssignTagId] = useState("");
  const [assignMailboxIds, setAssignMailboxIds] = useState("");
  const [bulk, setBulk] = useState(false);
  const [plan, setPlan] = useState<RetentionAssignPlan | null>(null);
  const [tagPlan, setTagPlan] = useState<{ diff: readonly string[]; valid: boolean } | null>(null);
  const [busy, setBusy] = useState(false);
  const [dialogError, setDialogError] = useState<string | null>(null);

  const reload = useCallback(async (): Promise<void> => {
    setLoading(true);
    setError(null);
    try {
      const result = await listRetention(tenantId, fetcher);
      setPolicies(result.policies);
      setTags(result.tags);
      setTagsUnavailable(result.tagsUnavailable ?? null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [tenantId, fetcher]);

  useEffect(() => {
    void reload();
  }, [reload]);

  function openTagDialog(tag: RetentionTag | null): void {
    setTagName(tag?.name ?? "");
    setTagType(tag?.type ?? "");
    setTagDays(tag?.retentionDays !== undefined && tag?.retentionDays !== null ? String(tag.retentionDays) : "");
    setTagPlan(null);
    setDialogError(null);
    setTagDialog({ tag });
  }

  function tagPayload(): Record<string, unknown> {
    return {
      name: tagName.trim(),
      ...(tagType.trim() ? { type: tagType.trim() } : {}),
      ...(tagDays.trim() ? { retentionDays: Number(tagDays.trim()) } : {}),
    };
  }

  async function previewTag(): Promise<void> {
    setBusy(true);
    setDialogError(null);
    try {
      const result = await previewRetentionTagWrite(tenantId, tagDialog?.tag?.id ?? null, tagPayload(), fetcher);
      setTagPlan(result);
    } catch (err) {
      setDialogError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function confirmTag(): Promise<void> {
    setBusy(true);
    setDialogError(null);
    try {
      await applyRetentionTagWrite(tenantId, tagDialog?.tag?.id ?? null, tagPayload(), fetcher);
      setNotice(`Retention tag “${tagName.trim()}” saved.`);
      setTagDialog(null);
      setTagPlan(null);
      await reload();
    } catch (err) {
      setDialogError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  function assignPayload(): Record<string, unknown> {
    const ids = assignMailboxIds.split(/[\s,]+/).map((id) => id.trim()).filter((id) => id.length > 0);
    return bulk
      ? { mailboxIds: ids, tagId: assignTagId }
      : { mailboxId: ids[0] ?? "", tagId: assignTagId };
  }

  async function previewAssign(): Promise<void> {
    setBusy(true);
    setDialogError(null);
    try {
      setPlan(await previewRetentionAssign(tenantId, assignPayload(), bulk, fetcher));
    } catch (err) {
      setDialogError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function confirmAssign(): Promise<void> {
    setBusy(true);
    setDialogError(null);
    try {
      await applyRetentionAssign(tenantId, assignPayload(), bulk, fetcher);
      const count = assignMailboxIds.split(/[\s,]+/).filter((id) => id.trim()).length;
      setNotice(`Retention tag assigned to ${count} mailbox${count === 1 ? "" : "es"}.`);
      setAssignOpen(false);
      setPlan(null);
    } catch (err) {
      setDialogError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  const gated: CSSProperties = !canWrite ? { opacity: 0.45, cursor: "not-allowed" } : {};

  return (
    <div style={pageStyle} data-testid="retention-page">
      <div>
        <div style={{ fontSize: "12px", color: "var(--text-soft)" }}>Email &amp; Exchange &gt; Administration &gt; Retention Policy/Tag Management</div>
        <h1 style={{ fontSize: "24px", fontWeight: 700, margin: "4px 0 0" }}>Retention Policy/Tag Management</h1>
        <p style={{ margin: "4px 0 0", color: "var(--text-soft)", fontSize: "14px" }}>
          Assignment previews the affected mailboxes before apply.
        </p>
      </div>

      <div style={{ display: "flex", gap: "8px" }}>
        <button type="button" style={{ ...primaryButtonStyle, ...gated }} disabled={!canWrite} title={!canWrite ? "Requires mailboxes.write permission" : "Create tag"} onClick={() => openTagDialog(null)} data-testid="retention-add-tag">Create tag</button>
        <button type="button" style={{ ...buttonStyle, ...gated }} disabled={!canWrite || tags.length === 0} title={!canWrite ? "Requires mailboxes.write permission" : "Assign tag"} onClick={() => { setPlan(null); setDialogError(null); setAssignOpen(true); }} data-testid="retention-assign">Assign tag</button>
      </div>

      {notice && <div style={{ color: "var(--success-text)", fontSize: "14px" }} data-testid="retention-notice">{notice}</div>}
      {loading && <p data-testid="retention-loading">Loading retention data…</p>}
      {error && <div role="alert" style={{ color: "var(--danger-text)" }} data-testid="retention-error">{error}</div>}

      <section style={cardStyle} aria-label="Retention policies" data-testid="retention-policies-card">
        <h2 style={{ margin: 0, fontSize: "16px" }}>Policies ({policies.length})</h2>
        <div style={{ overflowX: "auto" }}>
          <table style={tableStyle} data-testid="retention-policies-table">
            <thead><tr><th style={thStyle}>Name</th><th style={thStyle}>Id</th></tr></thead>
            <tbody>
              {policies.length === 0 && !loading ? (
                <tr><td style={tdStyle} colSpan={2}>No retention policies.</td></tr>
              ) : (
                policies.map((policy) => (
                  <tr key={policy.id} data-testid={`retention-policy-${policy.id}`}>
                    <td style={tdStyle}>{policy.name}</td>
                    <td style={{ ...tdStyle, fontFamily: "var(--font-mono, monospace)", fontSize: "13px" }}>{policy.id}</td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </section>

      <section style={cardStyle} aria-label="Retention tags" data-testid="retention-tags-card">
        <h2 style={{ margin: 0, fontSize: "16px" }}>{tagsUnavailable ? "Tags" : `Tags (${tags.length})`}</h2>
        {tagsUnavailable && (
          <div role="status" style={{ color: "var(--text-soft)", fontSize: "14px" }} data-testid="retention-tags-unavailable">
            <strong>Not available.</strong> {tagsUnavailable}
          </div>
        )}
        <div style={{ overflowX: "auto", ...(tagsUnavailable ? { display: "none" } : {}) }}>
          <table style={tableStyle} data-testid="retention-tags-table">
            <thead><tr><th style={thStyle}>Name</th><th style={thStyle}>Type</th><th style={thStyle}>Days</th><th style={thStyle}>Actions</th></tr></thead>
            <tbody>
              {tags.length === 0 && !loading ? (
                <tr><td style={tdStyle} colSpan={4}>No retention tags.</td></tr>
              ) : (
                tags.map((tag) => (
                  <tr key={tag.id} data-testid={`retention-tag-${tag.id}`}>
                    <td style={tdStyle}>{tag.name}</td>
                    <td style={tdStyle}>{tag.type ?? "—"}</td>
                    <td style={tdStyle}>{tag.retentionDays ?? "—"}</td>
                    <td style={tdStyle}>
                      <button type="button" style={{ ...buttonStyle, ...gated }} disabled={!canWrite} title={!canWrite ? "Requires mailboxes.write permission" : "Edit tag"} onClick={() => openTagDialog(tag)} data-testid={`retention-edit-${tag.id}`}>Edit</button>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </section>

      {tagDialog && (
        <div style={overlayStyle} role="dialog" aria-modal="true" aria-label={tagDialog.tag ? "Edit retention tag" : "Create retention tag"} data-testid="retention-tag-dialog">
          <div style={dialogStyle}>
            <h3 style={{ margin: 0 }}>{tagDialog.tag ? "Edit retention tag" : "Create retention tag"}</h3>
            <label style={{ display: "flex", flexDirection: "column", gap: "6px", fontSize: "14px" }}>
              Name
              <input type="text" value={tagName} onChange={(e) => setTagName(e.target.value)} style={inputStyle} aria-label="Tag name" data-testid="retention-tag-name" />
            </label>
            <div style={{ display: "flex", gap: "8px" }}>
              <label style={{ display: "flex", flexDirection: "column", gap: "6px", fontSize: "14px", flex: 1 }}>
                Type
                <input type="text" value={tagType} onChange={(e) => setTagType(e.target.value)} style={inputStyle} aria-label="Tag type" data-testid="retention-tag-type" />
              </label>
              <label style={{ display: "flex", flexDirection: "column", gap: "6px", fontSize: "14px", flex: 1 }}>
                Retention days
                <input type="number" min={1} value={tagDays} onChange={(e) => setTagDays(e.target.value)} style={inputStyle} aria-label="Retention days" data-testid="retention-tag-days" />
              </label>
            </div>
            <div><button type="button" style={buttonStyle} onClick={() => void previewTag()} disabled={busy || !tagName.trim()} data-testid="retention-tag-preview">Preview plan</button></div>
            {dialogError && tagDialog && <div role="alert" style={{ color: "var(--danger-text)", fontSize: "14px" }}>{dialogError}</div>}
            {tagPlan && <div style={{ fontSize: "14px" }} data-testid="retention-tag-plan">{tagPlan.diff.length === 0 ? "No changes." : tagPlan.diff.join(" ")}</div>}
            <div style={{ display: "flex", gap: "8px", justifyContent: "flex-end" }}>
              <button type="button" style={buttonStyle} onClick={() => { setTagDialog(null); setTagPlan(null); }} data-testid="retention-tag-cancel">Cancel</button>
              <button type="button" style={{ ...primaryButtonStyle, ...(busy || !tagPlan || !tagPlan.valid ? { opacity: 0.45, cursor: "not-allowed" } : {}) }} disabled={busy || !tagPlan || !tagPlan.valid} onClick={() => void confirmTag()} data-testid="retention-tag-confirm">Confirm and apply</button>
            </div>
          </div>
        </div>
      )}

      {assignOpen && (
        <div style={overlayStyle} role="dialog" aria-modal="true" aria-label="Assign retention tag" data-testid="retention-assign-dialog">
          <div style={dialogStyle}>
            <h3 style={{ margin: 0 }}>Assign retention tag</h3>
            <label style={{ display: "flex", flexDirection: "column", gap: "6px", fontSize: "14px" }}>
              Tag
              <select value={assignTagId} onChange={(e) => setAssignTagId(e.target.value)} style={inputStyle} aria-label="Tag" data-testid="retention-assign-tag">
                <option value="">Select a tag…</option>
                {tags.map((tag) => <option key={tag.id} value={tag.id}>{tag.name}</option>)}
              </select>
            </label>
            <label style={{ display: "flex", flexDirection: "column", gap: "6px", fontSize: "14px" }}>
              Mailbox ids (comma or space separated)
              <textarea value={assignMailboxIds} onChange={(e) => setAssignMailboxIds(e.target.value)} rows={3} style={inputStyle} aria-label="Mailbox ids" data-testid="retention-assign-mailboxes" />
            </label>
            <label style={{ display: "flex", gap: "8px", alignItems: "center", fontSize: "14px" }}>
              <input type="checkbox" checked={bulk} onChange={(e) => setBulk(e.target.checked)} data-testid="retention-assign-bulk" />
              Bulk assignment (many mailboxes)
            </label>
            <div><button type="button" style={buttonStyle} onClick={() => void previewAssign()} disabled={busy || !assignTagId || !assignMailboxIds.trim()} data-testid="retention-assign-preview">Preview affected mailboxes</button></div>
            {dialogError && assignOpen && !tagDialog && <div role="alert" style={{ color: "var(--danger-text)", fontSize: "14px" }}>{dialogError}</div>}
            {plan && (
              <div style={{ fontSize: "14px", display: "flex", flexDirection: "column", gap: "6px" }} data-testid="retention-assign-plan">
                <div>{plan.diff.length === 0 ? "No changes." : plan.diff.join(" ")}</div>
                {plan.affectedMailboxes && plan.affectedMailboxes.length > 0 && (
                  <div data-testid="retention-affected">Affected mailboxes ({plan.affectedMailboxes.length}): {plan.affectedMailboxes.join(", ")}</div>
                )}
              </div>
            )}
            <div style={{ display: "flex", gap: "8px", justifyContent: "flex-end" }}>
              <button type="button" style={buttonStyle} onClick={() => { setAssignOpen(false); setPlan(null); }} data-testid="retention-assign-cancel">Cancel</button>
              <button type="button" style={{ ...primaryButtonStyle, ...(busy || !plan || !plan.valid ? { opacity: 0.45, cursor: "not-allowed" } : {}) }} disabled={busy || !plan || !plan.valid} onClick={() => void confirmAssign()} data-testid="retention-assign-confirm">Confirm and apply</button>
            </div>
          </div>
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
