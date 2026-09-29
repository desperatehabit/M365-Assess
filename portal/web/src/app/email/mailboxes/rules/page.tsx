"use client";

// Mailbox rules & forwarding (EPIC-020 SPEC.md §3.4; T-0389).
// Lists per-mailbox inbox rules and forwarding config from the BFF, with
// add/edit/remove running form → plan preview → apply. Forwarding changes are
// security-sensitive (BEC vector, T-0385): they carry a visible flag, require
// explicit confirmation, and apply is refused without it. No browser call
// reaches a tenant directly.

import React, { useCallback, useEffect, useState, type CSSProperties, type ReactElement } from "react";
import { useSearchParams } from "next/navigation";
import { RequireTenant } from "../../../../components/shell/RequireTenant";
import { resolveTenantId, useCurrentTenantId } from "../../../../lib/useCurrentTenant";
import type { Fetcher } from "../page";

export interface InboxRule {
  readonly identity: string;
  readonly name: string;
  readonly enabled: boolean;
  readonly priority: number | null;
  readonly forwardTo: unknown;
  readonly forwardAsAttachmentTo: unknown;
  readonly redirectTo: unknown;
  readonly deleteMessage: boolean;
}

export interface RulePlan {
  readonly action: string;
  readonly diff: readonly string[];
  readonly valid: boolean;
  readonly dryRun: boolean;
  readonly requiresConfirmation: boolean;
  readonly securitySensitive?: boolean;
  readonly warning?: string;
}

/** True when a rule payload enables external forwarding (BEC vector, T-0385). */
export function isForwardingRuleChange(payload: {
  readonly forwardTo?: unknown;
  readonly forwardAsAttachmentTo?: unknown;
  readonly redirectTo?: unknown;
}): boolean {
  return [payload.forwardTo, payload.forwardAsAttachmentTo, payload.redirectTo].some(
    (value) => value !== undefined && value !== null && value !== "",
  );
}

export async function listMailboxRules(
  tenantId: string,
  mailboxId: string,
  fetcher: Fetcher = fetch,
): Promise<{ rules: InboxRule[] }> {
  const response = await fetcher(
    `/v1/tenants/${encodeURIComponent(tenantId)}/mailboxes/${encodeURIComponent(mailboxId)}/rules`,
  );
  if (!response.ok) throw new Error(`List rules failed: HTTP ${response.status}`);
  const body = (await response.json()) as { rules?: InboxRule[] };
  return { rules: [...(body.rules ?? [])] };
}

export async function previewRuleWrite(
  tenantId: string,
  mailboxId: string,
  ruleId: string | null,
  method: "POST" | "PATCH" | "DELETE",
  payload: Record<string, unknown>,
  fetcher: Fetcher = fetch,
): Promise<RulePlan> {
  const base = `/v1/tenants/${encodeURIComponent(tenantId)}/mailboxes/${encodeURIComponent(mailboxId)}/rules`;
  const url = ruleId ? `${base}/${encodeURIComponent(ruleId)}` : base;
  const response = await fetcher(url, {
    method,
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ ...payload, preview: true }),
  });
  if (!response.ok) throw new Error(`Preview rule change failed: HTTP ${response.status}`);
  return (await response.json()) as RulePlan;
}

export async function applyRuleWrite(
  tenantId: string,
  mailboxId: string,
  ruleId: string | null,
  method: "POST" | "PATCH" | "DELETE",
  payload: Record<string, unknown>,
  fetcher: Fetcher = fetch,
): Promise<unknown> {
  const base = `/v1/tenants/${encodeURIComponent(tenantId)}/mailboxes/${encodeURIComponent(mailboxId)}/rules`;
  const url = ruleId ? `${base}/${encodeURIComponent(ruleId)}` : base;
  const response = await fetcher(url, {
    method,
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ ...payload, preview: false, confirm: true }),
  });
  if (!response.ok) throw new Error(`Apply rule change failed: HTTP ${response.status}`);
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

const flagStyle: CSSProperties = {
  display: "inline-block",
  padding: "2px 8px",
  borderRadius: "999px",
  fontSize: "12px",
  fontWeight: 600,
  background: "var(--danger-soft, var(--warn-soft))",
  border: "1px solid var(--danger, var(--warn))",
  color: "var(--danger-text, var(--warn-text))",
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

export interface RulesViewProps {
  readonly tenantId: string;
  readonly mailboxId: string;
  readonly canWrite?: boolean;
  readonly fetcher?: Fetcher;
}

function ruleForwards(rule: InboxRule): boolean {
  return isForwardingRuleChange({
    forwardTo: rule.forwardTo,
    forwardAsAttachmentTo: rule.forwardAsAttachmentTo,
    redirectTo: rule.redirectTo,
  });
}

export function RulesView({ tenantId, mailboxId, canWrite = true, fetcher = fetch }: RulesViewProps): ReactElement {
  const [rules, setRules] = useState<InboxRule[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [dialog, setDialog] = useState<null | { mode: "add" | "edit"; rule: InboxRule | null }>(null);
  const [removing, setRemoving] = useState<InboxRule | null>(null);
  const [name, setName] = useState("");
  const [forwardTo, setForwardTo] = useState("");
  const [plan, setPlan] = useState<RulePlan | null>(null);
  const [planBusy, setPlanBusy] = useState(false);
  const [planError, setPlanError] = useState<string | null>(null);

  const reload = useCallback(async (): Promise<void> => {
    if (!mailboxId) {
      setLoading(false);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const result = await listMailboxRules(tenantId, mailboxId, fetcher);
      setRules(result.rules);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [tenantId, mailboxId, fetcher]);

  useEffect(() => {
    void reload();
  }, [reload]);

  function openAdd(): void {
    setName("");
    setForwardTo("");
    setPlan(null);
    setPlanError(null);
    setDialog({ mode: "add", rule: null });
  }

  function openEdit(rule: InboxRule): void {
    setName(rule.name);
    setForwardTo(typeof rule.forwardTo === "string" ? rule.forwardTo : "");
    setPlan(null);
    setPlanError(null);
    setDialog({ mode: "edit", rule });
  }

  function dialogPayload(): Record<string, unknown> {
    return {
      name: name.trim(),
      forwardTo: forwardTo.trim() ? forwardTo.trim() : undefined,
    };
  }

  async function previewDialog(): Promise<void> {
    setPlanBusy(true);
    setPlanError(null);
    try {
      const method = dialog?.mode === "edit" ? "PATCH" : "POST";
      setPlan(await previewRuleWrite(tenantId, mailboxId, dialog?.rule?.identity ?? null, method, dialogPayload(), fetcher));
    } catch (err) {
      setPlanError(err instanceof Error ? err.message : String(err));
    } finally {
      setPlanBusy(false);
    }
  }

  async function confirmDialog(): Promise<void> {
    if (!dialog) return;
    setPlanBusy(true);
    setPlanError(null);
    try {
      const method = dialog.mode === "edit" ? "PATCH" : "POST";
      await applyRuleWrite(tenantId, mailboxId, dialog.rule?.identity ?? null, method, dialogPayload(), fetcher);
      setNotice(`Rule ${dialog.mode === "edit" ? "updated" : "created"}.`);
      setDialog(null);
      setPlan(null);
      await reload();
    } catch (err) {
      setPlanError(err instanceof Error ? err.message : String(err));
    } finally {
      setPlanBusy(false);
    }
  }

  async function openRemove(rule: InboxRule): Promise<void> {
    setRemoving(rule);
    setPlan(null);
    setPlanError(null);
    setPlanBusy(true);
    try {
      setPlan(await previewRuleWrite(tenantId, mailboxId, rule.identity, "DELETE", {}, fetcher));
    } catch (err) {
      setPlanError(err instanceof Error ? err.message : String(err));
    } finally {
      setPlanBusy(false);
    }
  }

  async function confirmRemove(): Promise<void> {
    if (!removing) return;
    setPlanBusy(true);
    setPlanError(null);
    try {
      await applyRuleWrite(tenantId, mailboxId, removing.identity, "DELETE", {}, fetcher);
      setNotice(`Rule “${removing.name}” removed.`);
      setRemoving(null);
      setPlan(null);
      await reload();
    } catch (err) {
      setPlanError(err instanceof Error ? err.message : String(err));
    } finally {
      setPlanBusy(false);
    }
  }

  const forwardingDraft = isForwardingRuleChange({ forwardTo: forwardTo.trim() || undefined });

  return (
    <div style={pageStyle} data-testid="mailbox-rules-page">
      <div>
        <div style={{ fontSize: "12px", color: "var(--text-soft)" }}>Email &amp; Exchange &gt; Administration &gt; Mailbox Rules</div>
        <h1 style={{ fontSize: "24px", fontWeight: 700, margin: "4px 0 0" }}>Mailbox rules &amp; forwarding</h1>
        <p style={{ margin: "4px 0 0", color: "var(--text-soft)", fontSize: "14px" }}>
          Forwarding changes are <span style={flagStyle} data-testid="forwarding-sensitive-legend">⚠ security-sensitive (BEC vector)</span> and need explicit confirmation.
        </p>
      </div>

      <div style={{ display: "flex", gap: "8px", alignItems: "center" }}>
        <span style={{ fontSize: "14px" }}>Mailbox: <span style={{ fontFamily: "var(--font-mono, monospace)" }}>{mailboxId || "—"}</span></span>
        <button
          type="button"
          style={{ ...primaryButtonStyle, ...(!canWrite || !mailboxId ? { opacity: 0.45, cursor: "not-allowed" } : {}) }}
          disabled={!canWrite || !mailboxId}
          title={!canWrite ? "Requires mailboxes.write permission" : "Add rule"}
          onClick={openAdd}
          data-testid="rules-add"
        >
          Add rule
        </button>
      </div>

      {notice && <div style={{ color: "var(--success-text)", fontSize: "14px" }} data-testid="rules-notice">{notice}</div>}
      {loading && <p data-testid="rules-loading">Loading rules…</p>}
      {error && <div role="alert" style={{ color: "var(--danger-text)" }} data-testid="rules-error">{error}</div>}

      <section style={cardStyle} aria-label="Inbox rules" data-testid="rules-table-card">
        <div style={{ overflowX: "auto" }}>
          <table style={tableStyle} data-testid="rules-table">
            <thead>
              <tr>
                <th style={thStyle}>Name</th>
                <th style={thStyle}>Enabled</th>
                <th style={thStyle}>Forwarding</th>
                <th style={thStyle}>Actions</th>
              </tr>
            </thead>
            <tbody>
              {rules.length === 0 && !loading ? (
                <tr><td style={tdStyle} colSpan={4}>No inbox rules.</td></tr>
              ) : (
                rules.map((rule) => (
                  <tr key={rule.identity} data-testid={`rule-row-${rule.identity}`}>
                    <td style={tdStyle}>{rule.name}</td>
                    <td style={tdStyle}>{rule.enabled ? "Yes" : "No"}</td>
                    <td style={tdStyle}>
                      {ruleForwards(rule) ? (
                        <span style={flagStyle} data-testid={`rule-forwarding-flag-${rule.identity}`}>⚠ Forwarding</span>
                      ) : (
                        "No"
                      )}
                    </td>
                    <td style={tdStyle}>
                      <div style={{ display: "flex", gap: "6px" }}>
                        <button type="button" style={{ ...buttonStyle, ...(!canWrite ? { opacity: 0.45, cursor: "not-allowed" } : {}) }} disabled={!canWrite} title={!canWrite ? "Requires mailboxes.write permission" : "Edit"} onClick={() => openEdit(rule)} data-testid={`rule-edit-${rule.identity}`}>Edit</button>
                        <button type="button" style={{ ...buttonStyle, ...(!canWrite ? { opacity: 0.45, cursor: "not-allowed" } : {}) }} disabled={!canWrite} title={!canWrite ? "Requires mailboxes.write permission" : "Remove"} onClick={() => void openRemove(rule)} data-testid={`rule-remove-${rule.identity}`}>Remove</button>
                      </div>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </section>

      {dialog && (
        <div style={overlayStyle} role="dialog" aria-modal="true" aria-label={dialog.mode === "edit" ? "Edit rule" : "Add rule"} data-testid="rule-dialog">
          <div style={dialogStyle}>
            <h3 style={{ margin: 0 }}>{dialog.mode === "edit" ? "Edit rule" : "Add rule"}</h3>
            {forwardingDraft && (
              <div><span style={flagStyle} data-testid="rule-dialog-forwarding-flag">⚠ Security-sensitive: this rule forwards mail (BEC vector). Confirmation required.</span></div>
            )}
            <label style={{ display: "flex", flexDirection: "column", gap: "6px", fontSize: "14px" }}>
              Name
              <input type="text" value={name} onChange={(e) => setName(e.target.value)} style={inputStyle} aria-label="Rule name" data-testid="rule-name" />
            </label>
            <label style={{ display: "flex", flexDirection: "column", gap: "6px", fontSize: "14px" }}>
              Forward to (leave empty for no forwarding)
              <input type="text" value={forwardTo} onChange={(e) => setForwardTo(e.target.value)} style={inputStyle} aria-label="Forward to" data-testid="rule-forward-to" />
            </label>
            <div>
              <button type="button" style={buttonStyle} onClick={() => void previewDialog()} disabled={planBusy || !name.trim()} data-testid="rule-preview">Preview plan</button>
            </div>
            <div data-testid="rule-plan">
              {planError && <div role="alert" style={{ color: "var(--danger-text)", fontSize: "14px" }}>{planError}</div>}
              {plan && (
                <div style={{ fontSize: "14px", display: "flex", flexDirection: "column", gap: "6px" }} data-testid="rule-plan-diff">
                  {plan.diff.length === 0 ? "No changes." : plan.diff.map((line, index) => <div key={index}>{line}</div>)}
                  {(plan.securitySensitive || plan.warning) && <div><span style={flagStyle}>⚠ {plan.warning ?? "Security-sensitive forwarding change"}</span></div>}
                </div>
              )}
            </div>
            <div style={{ display: "flex", gap: "8px", justifyContent: "flex-end" }}>
              <button type="button" style={buttonStyle} onClick={() => { setDialog(null); setPlan(null); }} data-testid="rule-cancel">Cancel</button>
              <button type="button" style={{ ...primaryButtonStyle, ...(planBusy || !plan || !plan.valid ? { opacity: 0.45, cursor: "not-allowed" } : {}) }} disabled={planBusy || !plan || !plan.valid} onClick={() => void confirmDialog()} data-testid="rule-confirm">
                Confirm and apply
              </button>
            </div>
          </div>
        </div>
      )}

      {removing && (
        <div style={overlayStyle} role="dialog" aria-modal="true" aria-label="Remove rule" data-testid="rule-remove-dialog">
          <div style={dialogStyle}>
            <h3 style={{ margin: 0 }}>Remove rule “{removing.name}”?</h3>
            {ruleForwards(removing) && <div><span style={flagStyle}>⚠ Security-sensitive: this rule forwards mail.</span></div>}
            <div data-testid="rule-remove-plan">
              {planBusy && <p style={{ margin: 0, fontSize: "14px" }}>Loading plan preview…</p>}
              {planError && <div role="alert" style={{ color: "var(--danger-text)", fontSize: "14px" }}>{planError}</div>}
              {plan && <div style={{ fontSize: "14px" }} data-testid="rule-remove-diff">{plan.diff.length === 0 ? "No changes." : plan.diff.join(" ")}</div>}
            </div>
            <div style={{ display: "flex", gap: "8px", justifyContent: "flex-end" }}>
              <button type="button" style={buttonStyle} onClick={() => { setRemoving(null); setPlan(null); }} data-testid="rule-remove-cancel">Cancel</button>
              <button type="button" style={{ ...primaryButtonStyle, ...(planBusy || !plan || !plan.valid ? { opacity: 0.45, cursor: "not-allowed" } : {}) }} disabled={planBusy || !plan || !plan.valid} onClick={() => void confirmRemove()} data-testid="rule-remove-confirm">
                Confirm and remove
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

export default function MailboxRulesPage(): ReactElement {
  const searchParams = useSearchParams();
  const tenantId = resolveTenantId(searchParams.get("tenantId"), useCurrentTenantId());
  const mailboxId = searchParams.get("mailboxId") ?? "";
  return (
    <RequireTenant tenantId={tenantId}>
      <RulesView tenantId={tenantId} mailboxId={mailboxId} />
    </RequireTenant>
  );
}
