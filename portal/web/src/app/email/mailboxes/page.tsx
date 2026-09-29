"use client";

// Mailboxes list (EPIC-020 SPEC.md §3.1; T-0389).
// Nav: Email & Exchange → Administration → Mailboxes. Title "Mailboxes" with
// the §3.1 table (display name, primary SMTP, type, quota used, archive, hold,
// forwarding, last activity), the §3.1 filters (type, hold, forwarding,
// archive, quota %, last activity), row actions, and an off-canvas detail.
// Every read and write goes through the BFF; no browser call reaches a tenant
// directly. Each write runs form → plan preview → apply with confirmation, and
// forwarding changes are flagged security-sensitive (T-0385). Write controls
// are disabled unless `canWrite` (RBAC) is set.

import React, { useCallback, useEffect, useState, type CSSProperties, type ReactElement } from "react";
import { useSearchParams } from "next/navigation";
import { RequireTenant } from "../../../components/shell/RequireTenant";
import { resolveTenantId, useCurrentTenantId } from "../../../lib/useCurrentTenant";

export type MailboxType = "user" | "shared" | "room" | "equipment";

export interface MailboxItem {
  readonly id: string;
  readonly displayName: string | null;
  readonly primarySmtpAddress: string;
  readonly type: MailboxType;
  readonly quotaUsed: string | null;
  readonly quotaPercent: number | null;
  readonly archive: boolean;
  readonly hold: boolean;
  readonly forwarding: boolean;
  readonly forwardingTo: string | null;
  readonly lastActivity: string | null;
}

export interface MailboxesFilter {
  readonly search?: string;
  readonly type?: MailboxType | "";
  readonly hold?: boolean;
  readonly forwarding?: boolean;
  readonly archive?: boolean;
  readonly quotaPercent?: number;
  readonly inactiveDays?: number;
}

export interface MailboxPlan {
  readonly action: string;
  readonly targetName?: string;
  readonly diff: readonly string[];
  readonly valid: boolean;
  readonly dryRun: boolean;
  readonly requiresConfirmation: boolean;
  readonly securitySensitive?: boolean;
  readonly warning?: string;
}

export type Fetcher = typeof fetch;

/** Builds the BFF query string for GET /v1/tenants/:id/mailboxes (§3.1 filters). */
export function buildMailboxesQuery(filter: MailboxesFilter, limit = 100): string {
  const params = new URLSearchParams();
  if (filter.search) params.set("search", filter.search);
  if (filter.type) params.set("type", filter.type);
  if (filter.hold !== undefined) params.set("hold", String(filter.hold));
  if (filter.forwarding !== undefined) params.set("forwarding", String(filter.forwarding));
  if (filter.archive !== undefined) params.set("archive", String(filter.archive));
  if (filter.quotaPercent !== undefined) params.set("quotaPercent", String(filter.quotaPercent));
  if (filter.inactiveDays !== undefined) params.set("inactiveDays", String(filter.inactiveDays));
  params.set("limit", String(limit));
  return `?${params.toString()}`;
}

/** Row actions that change forwarding or access are security-sensitive (§9 BEC risk). */
export function isSecuritySensitiveAction(action: string): boolean {
  return action === "forwarding" || action === "convert" || action === "delete";
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

export async function listMailboxes(
  tenantId: string,
  filter: MailboxesFilter,
  fetcher: Fetcher = fetch,
): Promise<{ items: MailboxItem[]; nextCursor: string | null }> {
  const response = await fetcher(
    `/v1/tenants/${encodeURIComponent(tenantId)}/mailboxes${buildMailboxesQuery(filter)}`,
  );
  if (!response.ok) throw await readError(response, "List mailboxes");
  const body = (await response.json()) as { items?: MailboxItem[]; nextCursor?: string | null };
  return { items: [...(body.items ?? [])], nextCursor: body.nextCursor ?? null };
}

export async function previewMailboxWrite(
  tenantId: string,
  mailboxId: string,
  action: "convert" | "settings",
  payload: Record<string, unknown>,
  fetcher: Fetcher = fetch,
): Promise<MailboxPlan> {
  const path =
    action === "convert"
      ? `/v1/tenants/${encodeURIComponent(tenantId)}/mailboxes/${encodeURIComponent(mailboxId)}/convert`
      : `/v1/tenants/${encodeURIComponent(tenantId)}/mailboxes/${encodeURIComponent(mailboxId)}`;
  const response = await fetcher(path, {
    method: action === "convert" ? "POST" : "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ ...payload, preview: true }),
  });
  if (!response.ok) throw await readError(response, `Preview ${action}`);
  return (await response.json()) as MailboxPlan;
}

export async function applyMailboxWrite(
  tenantId: string,
  mailboxId: string,
  action: "convert" | "settings",
  payload: Record<string, unknown>,
  fetcher: Fetcher = fetch,
): Promise<unknown> {
  const path =
    action === "convert"
      ? `/v1/tenants/${encodeURIComponent(tenantId)}/mailboxes/${encodeURIComponent(mailboxId)}/convert`
      : `/v1/tenants/${encodeURIComponent(tenantId)}/mailboxes/${encodeURIComponent(mailboxId)}`;
  const response = await fetcher(path, {
    method: action === "convert" ? "POST" : "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ ...payload, preview: false, confirm: true }),
  });
  if (!response.ok) throw await readError(response, `Apply ${action}`);
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

const tableStyle: CSSProperties = {
  width: "100%",
  borderCollapse: "collapse",
  fontSize: "14px",
};

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
  background: "var(--danger-soft, var(--warn-soft))",
  border: "1px solid var(--danger, var(--warn))",
  color: "var(--danger-text, var(--warn-text))",
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

export type MailboxRowAction =
  | "view"
  | "convert"
  | "quota"
  | "archive"
  | "hold"
  | "permissions"
  | "rules"
  | "forwarding"
  | "ooo";

export interface MailboxesViewProps {
  readonly tenantId: string;
  /** False hides write controls the caller lacks RBAC for. */
  readonly canWrite?: boolean;
  readonly fetcher?: Fetcher;
}

interface PendingWrite {
  readonly action: "convert" | "settings";
  readonly label: string;
  readonly mailbox: MailboxItem;
  readonly payload: Record<string, unknown>;
}

const SETTINGS_PRESETS: Record<Exclude<MailboxRowAction, "view" | "permissions" | "rules" | "forwarding" | "ooo">, { label: string; action: "convert" | "settings"; payload: Record<string, unknown> }> = {
  convert: { label: "Convert to shared", action: "convert", payload: {} },
  quota: { label: "Set quota", action: "settings", payload: { prohibitSendQuota: "50 GB", issueWarningQuota: "45 GB" } },
  archive: { label: "Enable archive", action: "settings", payload: { archiveEnabled: true } },
  hold: { label: "Litigation hold", action: "settings", payload: { litigationHoldEnabled: true } },
};

export function MailboxesView({ tenantId, canWrite = true, fetcher = fetch }: MailboxesViewProps): ReactElement {
  const [filter, setFilter] = useState<MailboxesFilter>({});
  const [items, setItems] = useState<MailboxItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [selected, setSelected] = useState<MailboxItem | null>(null);
  const [pending, setPending] = useState<PendingWrite | null>(null);
  const [plan, setPlan] = useState<MailboxPlan | null>(null);
  const [planBusy, setPlanBusy] = useState(false);
  const [planError, setPlanError] = useState<string | null>(null);

  const fetchList = useCallback(
    async (next: MailboxesFilter): Promise<void> => {
      setLoading(true);
      setError(null);
      try {
        const page = await listMailboxes(tenantId, next, fetcher);
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

  function setFilterField<K extends keyof MailboxesFilter>(key: K, value: MailboxesFilter[K]): void {
    setFilter((prev) => ({ ...prev, [key]: value }));
  }

  async function openWriteDialog(actionKey: keyof typeof SETTINGS_PRESETS, mailbox: MailboxItem): Promise<void> {
    const preset = SETTINGS_PRESETS[actionKey];
    setPending({ action: preset.action, label: preset.label, mailbox, payload: preset.payload });
    setPlan(null);
    setPlanError(null);
    setPlanBusy(true);
    try {
      setPlan(await previewMailboxWrite(tenantId, mailbox.id, preset.action, preset.payload, fetcher));
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
      await applyMailboxWrite(tenantId, pending.mailbox.id, pending.action, pending.payload, fetcher);
      setNotice(`${pending.label} applied to ${pending.mailbox.primarySmtpAddress}.`);
      setPending(null);
      setPlan(null);
      await fetchList(filter);
    } catch (err) {
      setPlanError(err instanceof Error ? err.message : String(err));
    } finally {
      setPlanBusy(false);
    }
  }

  function rowAction(action: MailboxRowAction, mailbox: MailboxItem): void {
    if (action === "view") {
      setSelected(mailbox);
      return;
    }
    if (action === "permissions") {
      window.location.href = `/email/mailboxes/permissions?tenantId=${encodeURIComponent(tenantId)}&mailboxId=${encodeURIComponent(mailbox.id)}`;
      return;
    }
    if (action === "rules" || action === "forwarding") {
      window.location.href = `/email/mailboxes/rules?tenantId=${encodeURIComponent(tenantId)}&mailboxId=${encodeURIComponent(mailbox.id)}`;
      return;
    }
    if (action === "ooo") {
      window.location.href = `/email/mailboxes/vacation?tenantId=${encodeURIComponent(tenantId)}&mailboxId=${encodeURIComponent(mailbox.id)}`;
      return;
    }
    void openWriteDialog(action, mailbox);
  }

  const writeDisabled = !canWrite;

  return (
    <div style={pageStyle} data-testid="mailboxes-page">
      <div>
        <div style={{ fontSize: "12px", color: "var(--text-soft)" }}>Email &amp; Exchange &gt; Administration &gt; Mailboxes</div>
        <h1 style={{ fontSize: "24px", fontWeight: 700, margin: "4px 0 0", fontFamily: "var(--font-display, var(--font-sans))" }}>
          Mailboxes
        </h1>
        <p style={{ margin: "4px 0 0", color: "var(--text-soft)", fontSize: "14px" }}>
          List, search, and filter mailboxes, then act on rows. Writes preview a plan before apply.
        </p>
      </div>

      <div style={{ display: "flex", gap: "8px", flexWrap: "wrap" }} data-testid="mailboxes-filters">
        <input
          type="text"
          placeholder="Search name or address..."
          value={filter.search ?? ""}
          onChange={(e) => setFilterField("search", e.target.value || undefined)}
          style={inputStyle}
          aria-label="Search mailboxes"
          data-testid="mailboxes-search"
        />
        <select
          value={filter.type ?? ""}
          onChange={(e) => setFilterField("type", (e.target.value || undefined) as MailboxesFilter["type"])}
          style={inputStyle}
          aria-label="Filter by type"
          data-testid="mailboxes-filter-type"
        >
          <option value="">All types</option>
          <option value="user">User</option>
          <option value="shared">Shared</option>
          <option value="room">Room</option>
          <option value="equipment">Equipment</option>
        </select>
        <select
          value={filter.hold === undefined ? "" : String(filter.hold)}
          onChange={(e) => setFilterField("hold", e.target.value === "" ? undefined : e.target.value === "true")}
          style={inputStyle}
          aria-label="Filter by hold"
          data-testid="mailboxes-filter-hold"
        >
          <option value="">Hold: any</option>
          <option value="true">On hold</option>
          <option value="false">Not on hold</option>
        </select>
        <select
          value={filter.forwarding === undefined ? "" : String(filter.forwarding)}
          onChange={(e) => setFilterField("forwarding", e.target.value === "" ? undefined : e.target.value === "true")}
          style={inputStyle}
          aria-label="Filter by forwarding"
          data-testid="mailboxes-filter-forwarding"
        >
          <option value="">Forwarding: any</option>
          <option value="true">Forwarding on</option>
          <option value="false">Forwarding off</option>
        </select>
        <select
          value={filter.archive === undefined ? "" : String(filter.archive)}
          onChange={(e) => setFilterField("archive", e.target.value === "" ? undefined : e.target.value === "true")}
          style={inputStyle}
          aria-label="Filter by archive"
          data-testid="mailboxes-filter-archive"
        >
          <option value="">Archive: any</option>
          <option value="true">Archived</option>
          <option value="false">Not archived</option>
        </select>
        <input
          type="number"
          min={0}
          max={100}
          placeholder="Quota % ≥"
          value={filter.quotaPercent ?? ""}
          onChange={(e) => setFilterField("quotaPercent", e.target.value === "" ? undefined : Number(e.target.value))}
          style={{ ...inputStyle, width: "110px" }}
          aria-label="Filter by quota percent"
          data-testid="mailboxes-filter-quota"
        />
        <input
          type="number"
          min={1}
          placeholder="Inactive days ≥"
          value={filter.inactiveDays ?? ""}
          onChange={(e) => setFilterField("inactiveDays", e.target.value === "" ? undefined : Number(e.target.value))}
          style={{ ...inputStyle, width: "130px" }}
          aria-label="Filter by last activity"
          data-testid="mailboxes-filter-inactive"
        />
      </div>

      {notice && (
        <div style={{ padding: "12px 16px", borderRadius: "6px", background: "var(--success-soft)", border: "1px solid var(--success)", color: "var(--success-text)", fontSize: "14px" }} data-testid="mailboxes-notice">
          {notice}
        </div>
      )}
      {error && (
        <div role="alert" style={{ padding: "12px 16px", borderRadius: "6px", background: "var(--danger-soft)", border: "1px solid var(--danger)", color: "var(--danger-text)", fontSize: "14px" }} data-testid="mailboxes-error">
          {error}
        </div>
      )}

      <div style={{ overflowX: "auto" }}>
        <table style={tableStyle} data-testid="mailboxes-table">
          <thead>
            <tr>
              <th style={thStyle}>Display name</th>
              <th style={thStyle}>Primary SMTP</th>
              <th style={thStyle}>Type</th>
              <th style={thStyle}>Quota used</th>
              <th style={thStyle}>Archive</th>
              <th style={thStyle}>Hold</th>
              <th style={thStyle}>Forwarding</th>
              <th style={thStyle}>Last activity</th>
              <th style={thStyle}>Actions</th>
            </tr>
          </thead>
          <tbody>
            {loading ? (
              <tr><td style={tdStyle} colSpan={9}>Loading mailboxes…</td></tr>
            ) : items.length === 0 ? (
              <tr><td style={tdStyle} colSpan={9}>No mailboxes found.</td></tr>
            ) : (
              items.map((mailbox) => (
                <tr key={mailbox.id} data-testid={`mailbox-row-${mailbox.id}`}>
                  <td style={tdStyle}>{mailbox.displayName ?? "—"}</td>
                  <td style={{ ...tdStyle, fontFamily: "var(--font-mono, monospace)", fontSize: "13px" }}>{mailbox.primarySmtpAddress}</td>
                  <td style={tdStyle}>{mailbox.type}</td>
                  <td style={tdStyle}>{mailbox.quotaUsed ?? "—"}{mailbox.quotaPercent !== null && mailbox.quotaPercent !== undefined ? ` (${mailbox.quotaPercent}%)` : ""}</td>
                  <td style={tdStyle}>{mailbox.archive ? "Yes" : "No"}</td>
                  <td style={tdStyle}>{mailbox.hold ? "Yes" : "No"}</td>
                  <td style={tdStyle}>
                    {mailbox.forwarding ? (
                      <span><span style={flagStyle} data-testid={`forwarding-flag-${mailbox.id}`}>Forwarding</span>{mailbox.forwardingTo ? ` → ${mailbox.forwardingTo}` : ""}</span>
                    ) : (
                      "No"
                    )}
                  </td>
                  <td style={tdStyle}>{mailbox.lastActivity ?? "—"}</td>
                  <td style={tdStyle}>
                    <div style={{ display: "flex", gap: "6px", flexWrap: "wrap" }}>
                      <button type="button" style={buttonStyle} onClick={() => rowAction("view", mailbox)} data-testid={`mailbox-view-${mailbox.id}`}>View</button>
                      {(["convert", "quota", "archive", "hold"] as const).map((action) => (
                        <button
                          key={action}
                          type="button"
                          style={writeDisabled ? { ...buttonStyle, ...disabledStyle } : buttonStyle}
                          disabled={writeDisabled}
                          title={writeDisabled ? "Requires mailboxes.write permission" : SETTINGS_PRESETS[action].label}
                          onClick={() => rowAction(action, mailbox)}
                          data-testid={`mailbox-${action}-${mailbox.id}`}
                        >
                          {SETTINGS_PRESETS[action].label}
                          {isSecuritySensitiveAction(action) ? " ⚠" : ""}
                        </button>
                      ))}
                      <button type="button" style={buttonStyle} onClick={() => rowAction("permissions", mailbox)} data-testid={`mailbox-permissions-${mailbox.id}`}>Permissions</button>
                      <button type="button" style={buttonStyle} onClick={() => rowAction("rules", mailbox)} data-testid={`mailbox-rules-${mailbox.id}`}>Rules</button>
                      <button type="button" style={buttonStyle} onClick={() => rowAction("ooo", mailbox)} data-testid={`mailbox-ooo-${mailbox.id}`}>OoO</button>
                    </div>
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      {selected && (
        <>
          <div style={{ ...overlayStyle, background: "transparent", pointerEvents: "none" }} />
          <aside style={drawerStyle} role="dialog" aria-modal="true" aria-label={`Mailbox ${selected.primarySmtpAddress}`} data-testid="mailbox-drawer">
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
              <h2 style={{ margin: 0, fontSize: "18px" }}>{selected.displayName ?? selected.primarySmtpAddress}</h2>
              <button type="button" style={buttonStyle} onClick={() => setSelected(null)} data-testid="mailbox-drawer-close">Close</button>
            </div>
            <dl style={{ margin: 0, display: "grid", gridTemplateColumns: "160px 1fr", gap: "8px", fontSize: "14px" }}>
              <dt style={{ color: "var(--text-soft)" }}>Primary SMTP</dt><dd style={{ margin: 0, fontFamily: "var(--font-mono, monospace)" }}>{selected.primarySmtpAddress}</dd>
              <dt style={{ color: "var(--text-soft)" }}>Type</dt><dd style={{ margin: 0 }}>{selected.type}</dd>
              <dt style={{ color: "var(--text-soft)" }}>Quota used</dt><dd style={{ margin: 0 }}>{selected.quotaUsed ?? "—"}</dd>
              <dt style={{ color: "var(--text-soft)" }}>Archive</dt><dd style={{ margin: 0 }}>{selected.archive ? "Yes" : "No"}</dd>
              <dt style={{ color: "var(--text-soft)" }}>Hold</dt><dd style={{ margin: 0 }}>{selected.hold ? "Yes" : "No"}</dd>
              <dt style={{ color: "var(--text-soft)" }}>Forwarding</dt>
              <dd style={{ margin: 0 }}>
                {selected.forwarding ? (<span style={flagStyle}>Security-sensitive: forwarding on{selected.forwardingTo ? ` → ${selected.forwardingTo}` : ""}</span>) : "No"}
              </dd>
              <dt style={{ color: "var(--text-soft)" }}>Last activity</dt><dd style={{ margin: 0 }}>{selected.lastActivity ?? "—"}</dd>
            </dl>
            <div style={{ display: "flex", gap: "8px", flexWrap: "wrap" }}>
              <a style={buttonStyle} href={`/email/mailboxes/${encodeURIComponent(selected.id)}?tenantId=${encodeURIComponent(tenantId)}`} data-testid="mailbox-drawer-detail">Open full detail</a>
              <a style={buttonStyle} href={`/email/mailboxes/permissions?tenantId=${encodeURIComponent(tenantId)}&mailboxId=${encodeURIComponent(selected.id)}`} data-testid="mailbox-drawer-permissions">Permissions</a>
              <a style={buttonStyle} href={`/email/mailboxes/rules?tenantId=${encodeURIComponent(tenantId)}&mailboxId=${encodeURIComponent(selected.id)}`} data-testid="mailbox-drawer-rules">Rules</a>
            </div>
          </aside>
        </>
      )}

      {pending && (
        <div style={overlayStyle} data-testid="mailbox-action-dialog" role="dialog" aria-modal="true" aria-label={pending.label}>
          <div style={dialogStyle}>
            <h3 style={{ margin: 0 }}>{pending.label} — {pending.mailbox.primarySmtpAddress}</h3>
            {isSecuritySensitiveAction(pending.action === "convert" ? "convert" : "quota") && pending.action === "convert" && (
              <div style={{ ...flagStyle, alignSelf: "flex-start" }} data-testid="mailbox-dialog-sensitive">⚠ Security-sensitive: mailbox type change is audited</div>
            )}
            <div data-testid="mailbox-plan-preview">
              {planBusy && <p style={{ margin: 0, fontSize: "14px" }}>Loading plan preview…</p>}
              {planError && <div role="alert" style={{ color: "var(--danger-text)", fontSize: "14px" }}>{planError}</div>}
              {plan && (
                <div style={{ display: "flex", flexDirection: "column", gap: "8px", fontSize: "14px" }}>
                  <div data-testid="mailbox-plan-diff">
                    {plan.diff.length === 0 ? "No changes." : plan.diff.map((line, index) => <div key={index}>{line}</div>)}
                  </div>
                  {(plan.securitySensitive || plan.warning) && (
                    <div style={flagStyle} data-testid="mailbox-plan-warning">⚠ {plan.warning ?? "Security-sensitive change"}</div>
                  )}
                  {plan.requiresConfirmation && <div style={{ color: "var(--text-soft)", fontSize: "13px" }}>Confirmation required before apply.</div>}
                </div>
              )}
            </div>
            <div style={{ display: "flex", gap: "8px", justifyContent: "flex-end" }}>
              <button type="button" style={buttonStyle} onClick={() => { setPending(null); setPlan(null); }} data-testid="mailbox-dialog-cancel">Cancel</button>
              <button
                type="button"
                style={{ ...primaryButtonStyle, ...(planBusy || !plan || !plan.valid ? disabledStyle : {}) }}
                disabled={planBusy || !plan || !plan.valid}
                onClick={() => void confirmPending()}
                data-testid="mailbox-dialog-confirm"
              >
                Confirm and apply
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

export default function MailboxesPage(): ReactElement {
  const searchParams = useSearchParams();
  const tenantId = resolveTenantId(searchParams.get("tenantId"), useCurrentTenantId());
  return (
    <RequireTenant tenantId={tenantId}>
      <MailboxesView tenantId={tenantId} />
    </RequireTenant>
  );
}
