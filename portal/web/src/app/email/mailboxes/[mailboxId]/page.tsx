"use client";

// Mailbox detail (EPIC-020 SPEC.md §3.1 off-canvas detail, §3.2; T-0389).
// Reads GET /v1/tenants/:id/mailboxes/:mailboxId from the BFF (settings,
// permissions, rules) and offers the §3.2 settings/convert ActionDialogs with
// plan preview and confirmation. No browser call reaches a tenant directly.

import React, { useCallback, useEffect, useState, type CSSProperties, type ReactElement } from "react";
import { useParams, useSearchParams } from "next/navigation";
import { RequireTenant } from "../../../../components/shell/RequireTenant";
import { resolveTenantId, useCurrentTenantId } from "../../../../lib/useCurrentTenant";
import type { Fetcher, MailboxItem, MailboxPlan } from "../page";
import { applyMailboxWrite, isSecuritySensitiveAction, previewMailboxWrite } from "../page";

export interface MailboxDetail {
  readonly tenantId: string;
  readonly mailboxId: string;
  readonly settings: MailboxItem;
  readonly permissions: readonly { readonly grantedTo: string; readonly accessRights: readonly string[]; readonly automap: boolean; readonly inherited: boolean }[];
  readonly rules: readonly { readonly name: string; readonly enabled: boolean }[];
  readonly retrievedAt: string;
}

export async function getMailboxDetail(
  tenantId: string,
  mailboxId: string,
  fetcher: Fetcher = fetch,
): Promise<MailboxDetail> {
  const response = await fetcher(
    `/v1/tenants/${encodeURIComponent(tenantId)}/mailboxes/${encodeURIComponent(mailboxId)}`,
  );
  if (!response.ok) {
    throw new Error(`Load mailbox detail failed: HTTP ${response.status}`);
  }
  return (await response.json()) as MailboxDetail;
}

const pageStyle: CSSProperties = {
  padding: "24px",
  maxWidth: "1100px",
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

export interface MailboxDetailViewProps {
  readonly tenantId: string;
  readonly mailboxId: string;
  readonly canWrite?: boolean;
  readonly fetcher?: Fetcher;
}

export function MailboxDetailView({ tenantId, mailboxId, canWrite = true, fetcher = fetch }: MailboxDetailViewProps): ReactElement {
  const [detail, setDetail] = useState<MailboxDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [dialog, setDialog] = useState<null | { kind: "convert" | "quota" | "archive" | "hold" }>(null);
  const [quota, setQuota] = useState("50 GB");
  const [plan, setPlan] = useState<MailboxPlan | null>(null);
  const [planBusy, setPlanBusy] = useState(false);
  const [planError, setPlanError] = useState<string | null>(null);

  const reload = useCallback(async (): Promise<void> => {
    setLoading(true);
    setError(null);
    try {
      setDetail(await getMailboxDetail(tenantId, mailboxId, fetcher));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [tenantId, mailboxId, fetcher]);

  useEffect(() => {
    void reload();
  }, [reload]);

  function dialogPayload(kind: NonNullable<typeof dialog>["kind"]): { action: "convert" | "settings"; payload: Record<string, unknown> } {
    if (kind === "convert") return { action: "convert", payload: {} };
    if (kind === "quota") return { action: "settings", payload: { prohibitSendQuota: quota, issueWarningQuota: quota } };
    if (kind === "archive") return { action: "settings", payload: { archiveEnabled: true } };
    return { action: "settings", payload: { litigationHoldEnabled: true } };
  }

  async function openDialog(kind: NonNullable<typeof dialog>["kind"]): Promise<void> {
    setDialog({ kind });
    setPlan(null);
    setPlanError(null);
    setPlanBusy(true);
    try {
      const { action, payload } = dialogPayload(kind);
      setPlan(await previewMailboxWrite(tenantId, mailboxId, action, payload, fetcher));
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
      const { action, payload } = dialogPayload(dialog.kind);
      await applyMailboxWrite(tenantId, mailboxId, action, payload, fetcher);
      setNotice(`${dialog.kind} applied.`);
      setDialog(null);
      setPlan(null);
      await reload();
    } catch (err) {
      setPlanError(err instanceof Error ? err.message : String(err));
    } finally {
      setPlanBusy(false);
    }
  }

  const writeDisabled = !canWrite;

  return (
    <div style={pageStyle} data-testid="mailbox-detail-page">
      <div>
        <div style={{ fontSize: "12px", color: "var(--text-soft)" }}>Email &amp; Exchange &gt; Administration &gt; Mailboxes &gt; Detail</div>
        <h1 style={{ fontSize: "24px", fontWeight: 700, margin: "4px 0 0" }}>Mailbox detail</h1>
      </div>
      {loading && <p data-testid="mailbox-detail-loading">Loading mailbox…</p>}
      {error && <div role="alert" style={{ color: "var(--danger-text)" }} data-testid="mailbox-detail-error">{error}</div>}
      {notice && <div style={{ color: "var(--success-text)" }} data-testid="mailbox-detail-notice">{notice}</div>}
      {detail && (
        <>
          <section style={cardStyle} aria-label="Settings" data-testid="mailbox-detail-settings">
            <h2 style={{ margin: 0, fontSize: "16px" }}>Settings</h2>
            <div style={{ fontSize: "14px" }}>{detail.settings.displayName ?? "—"} · <span style={{ fontFamily: "var(--font-mono, monospace)" }}>{detail.settings.primarySmtpAddress}</span> · {detail.settings.type}</div>
            {detail.settings.forwarding && (
              <div><span style={flagStyle} data-testid="mailbox-detail-forwarding-flag">⚠ Security-sensitive: forwarding on{detail.settings.forwardingTo ? ` → ${detail.settings.forwardingTo}` : ""}</span></div>
            )}
            <div style={{ display: "flex", gap: "8px", flexWrap: "wrap" }}>
              {(["convert", "quota", "archive", "hold"] as const).map((kind) => (
                <button
                  key={kind}
                  type="button"
                  style={{ ...buttonStyle, ...(writeDisabled ? { opacity: 0.45, cursor: "not-allowed" } : {}) }}
                  disabled={writeDisabled}
                  title={writeDisabled ? "Requires mailboxes.write permission" : kind}
                  onClick={() => void openDialog(kind)}
                  data-testid={`mailbox-detail-${kind}`}
                >
                  {kind === "convert" ? "Convert to shared ⚠" : kind === "quota" ? "Set quota" : kind === "archive" ? "Enable archive" : "Litigation hold"}
                </button>
              ))}
            </div>
          </section>
          <section style={cardStyle} aria-label="Permissions" data-testid="mailbox-detail-permissions">
            <h2 style={{ margin: 0, fontSize: "16px" }}>Permissions ({detail.permissions.length})</h2>
            {detail.permissions.length === 0 ? <p style={{ margin: 0, fontSize: "14px" }}>No explicit permissions.</p> : (
              <ul style={{ margin: 0, paddingLeft: "20px", fontSize: "14px" }}>
                {detail.permissions.slice(0, 10).map((entry, index) => (
                  <li key={index}>{entry.grantedTo} — {entry.accessRights.join(", ")}{entry.automap ? " · automap" : ""}{entry.inherited ? " · inherited" : ""}</li>
                ))}
              </ul>
            )}
            <a style={{ ...buttonStyle, textDecoration: "none", alignSelf: "flex-start" }} href={`/email/mailboxes/permissions?tenantId=${encodeURIComponent(tenantId)}&mailboxId=${encodeURIComponent(mailboxId)}`}>Manage permissions</a>
          </section>
          <section style={cardStyle} aria-label="Rules" data-testid="mailbox-detail-rules">
            <h2 style={{ margin: 0, fontSize: "16px" }}>Inbox rules ({detail.rules.length})</h2>
            {detail.rules.length === 0 ? <p style={{ margin: 0, fontSize: "14px" }}>No inbox rules.</p> : (
              <ul style={{ margin: 0, paddingLeft: "20px", fontSize: "14px" }}>
                {detail.rules.slice(0, 10).map((rule, index) => (
                  <li key={index}>{rule.name}{rule.enabled ? "" : " (disabled)"}</li>
                ))}
              </ul>
            )}
            <a style={{ ...buttonStyle, textDecoration: "none", alignSelf: "flex-start" }} href={`/email/mailboxes/rules?tenantId=${encodeURIComponent(tenantId)}&mailboxId=${encodeURIComponent(mailboxId)}`}>Manage rules &amp; forwarding</a>
          </section>
        </>
      )}

      {dialog && (
        <div style={overlayStyle} role="dialog" aria-modal="true" aria-label={`${dialog.kind} dialog`} data-testid="mailbox-detail-dialog">
          <div style={dialogStyle}>
            <h3 style={{ margin: 0 }}>{dialog.kind === "convert" ? "Convert to shared ⚠" : dialog.kind === "quota" ? "Set quota" : dialog.kind === "archive" ? "Enable archive" : "Litigation hold"}</h3>
            {dialog.kind === "convert" && isSecuritySensitiveAction("convert") && (
              <div><span style={flagStyle} data-testid="mailbox-detail-sensitive">⚠ Security-sensitive: audited mailbox change</span></div>
            )}
            {dialog.kind === "quota" && (
              <label style={{ display: "flex", flexDirection: "column", gap: "6px", fontSize: "14px" }}>
                Quota (e.g. 50 GB or Unlimited)
                <input type="text" value={quota} onChange={(e) => setQuota(e.target.value)} style={inputStyle} aria-label="Quota" data-testid="mailbox-detail-quota-input" />
              </label>
            )}
            <div data-testid="mailbox-detail-plan">
              {planBusy && <p style={{ margin: 0, fontSize: "14px" }}>Loading plan preview…</p>}
              {planError && <div role="alert" style={{ color: "var(--danger-text)", fontSize: "14px" }}>{planError}</div>}
              {plan && (
                <div style={{ fontSize: "14px" }} data-testid="mailbox-detail-plan-diff">
                  {plan.diff.length === 0 ? "No changes." : plan.diff.map((line, index) => <div key={index}>{line}</div>)}
                  {(plan.securitySensitive || plan.warning) && <div><span style={flagStyle}>⚠ {plan.warning ?? "Security-sensitive change"}</span></div>}
                </div>
              )}
            </div>
            <div style={{ display: "flex", gap: "8px", justifyContent: "flex-end" }}>
              <button type="button" style={buttonStyle} onClick={() => { setDialog(null); setPlan(null); }} data-testid="mailbox-detail-cancel">Cancel</button>
              <button type="button" style={{ ...primaryButtonStyle, ...(planBusy || !plan || !plan.valid ? { opacity: 0.45, cursor: "not-allowed" } : {}) }} disabled={planBusy || !plan || !plan.valid} onClick={() => void confirmDialog()} data-testid="mailbox-detail-confirm">
                Confirm and apply
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

export default function MailboxDetailPage(): ReactElement {
  const params = useParams<{ mailboxId?: string }>();
  const searchParams = useSearchParams();
  const tenantId = resolveTenantId(searchParams.get("tenantId"), useCurrentTenantId());
  const mailboxId = typeof params?.mailboxId === "string" ? params.mailboxId : "";
  return (
    <RequireTenant tenantId={tenantId}>
      <MailboxDetailView tenantId={tenantId} mailboxId={mailboxId} />
    </RequireTenant>
  );
}
