"use client";

// Deleted Mailboxes (EPIC-020 SPEC.md §3 nav, §11.4; T-0388, T-0850).
// Nav: Email & Exchange → Administration → Deleted Mailboxes. Lists soft-deleted
// mailboxes from GET /v1/tenants/:id/deleted-mailboxes (live EXO) and restores
// one through POST .../deleted-mailboxes/:id/restore with a plan preview before
// apply; apply is sent with confirm:true. No sample data, and no browser call
// reaches a tenant directly. Restore is disabled unless `canWrite` (RBAC) is set.

import React, { useCallback, useEffect, useRef, useState, type CSSProperties, type ReactElement } from "react";
import { useSearchParams } from "next/navigation";
import { RequireTenant } from "../../../../components/shell/RequireTenant";
import { resolveTenantId, useCurrentTenantId } from "../../../../lib/useCurrentTenant";
import type { Fetcher } from "../page";

export interface DeletedMailboxItem {
  readonly id: string;
  readonly displayName: string | null;
  readonly primarySmtpAddress: string;
  readonly mailboxType: string;
  readonly deletedAt: string | null;
  readonly daysUntilPurge: number | null;
}

export interface DeletedMailboxesPage {
  readonly items: DeletedMailboxItem[];
  readonly nextCursor: string | null;
  readonly totalCount: number;
}

export interface RestorePlan {
  readonly diff: readonly string[];
  readonly valid: boolean;
  readonly dryRun: boolean;
  readonly requiresConfirmation: boolean;
  readonly targetName?: string;
}

async function readError(response: Response, fallback: string): Promise<Error> {
  let detail = `${fallback}: HTTP ${response.status}`;
  try {
    const body = (await response.json()) as { message?: string };
    if (body?.message) detail = body.message;
  } catch {
    // Keep the status-only message.
  }
  return new Error(detail);
}

export function buildDeletedMailboxesQuery(search: string, cursor: string | null, limit = 100): string {
  const params = new URLSearchParams();
  if (search) params.set("search", search);
  if (cursor) params.set("cursor", cursor);
  params.set("limit", String(limit));
  return `?${params.toString()}`;
}

export async function listDeletedMailboxes(
  tenantId: string,
  search: string,
  cursor: string | null,
  fetcher: Fetcher = fetch,
): Promise<DeletedMailboxesPage> {
  const response = await fetcher(
    `/v1/tenants/${encodeURIComponent(tenantId)}/deleted-mailboxes${buildDeletedMailboxesQuery(search, cursor)}`,
  );
  if (!response.ok) throw await readError(response, "List deleted mailboxes");
  const body = (await response.json()) as Partial<DeletedMailboxesPage>;
  return { items: [...(body.items ?? [])], nextCursor: body.nextCursor ?? null, totalCount: body.totalCount ?? 0 };
}

export async function previewRestoreMailbox(
  tenantId: string,
  mailboxId: string,
  fetcher: Fetcher = fetch,
): Promise<RestorePlan> {
  const response = await fetcher(
    `/v1/tenants/${encodeURIComponent(tenantId)}/deleted-mailboxes/${encodeURIComponent(mailboxId)}/restore`,
    { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ preview: true }) },
  );
  if (!response.ok) throw await readError(response, "Preview restore");
  return (await response.json()) as RestorePlan;
}

export async function applyRestoreMailbox(
  tenantId: string,
  mailboxId: string,
  fetcher: Fetcher = fetch,
): Promise<unknown> {
  const response = await fetcher(
    `/v1/tenants/${encodeURIComponent(tenantId)}/deleted-mailboxes/${encodeURIComponent(mailboxId)}/restore`,
    { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ preview: false, confirm: true }) },
  );
  if (!response.ok) throw await readError(response, "Restore mailbox");
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

const disabledStyle: CSSProperties = { opacity: 0.45, cursor: "not-allowed" };

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

export interface DeletedMailboxesViewProps {
  readonly tenantId: string;
  readonly canWrite?: boolean;
  readonly fetcher?: Fetcher;
}

export function DeletedMailboxesView({
  tenantId,
  canWrite = true,
  fetcher = fetch,
}: DeletedMailboxesViewProps): ReactElement {
  const [search, setSearch] = useState("");
  const [items, setItems] = useState<DeletedMailboxItem[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [target, setTarget] = useState<DeletedMailboxItem | null>(null);
  const [plan, setPlan] = useState<RestorePlan | null>(null);
  const [dialogError, setDialogError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const latest = useRef(0);

  const load = useCallback(
    async (cursor: string | null): Promise<void> => {
      const request = ++latest.current;
      setLoading(true);
      setError(null);
      try {
        const page = await listDeletedMailboxes(tenantId, search.trim(), cursor, fetcher);
        if (request !== latest.current) return;
        setItems((previous) => (cursor === null ? page.items : [...previous, ...page.items]));
        setNextCursor(page.nextCursor);
      } catch (err) {
        if (request !== latest.current) return;
        if (cursor === null) {
          setItems([]);
          setNextCursor(null);
        }
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        if (request === latest.current) setLoading(false);
      }
    },
    [tenantId, search, fetcher],
  );

  useEffect(() => {
    void load(null);
  }, [load]);

  async function openRestore(item: DeletedMailboxItem): Promise<void> {
    setTarget(item);
    setPlan(null);
    setDialogError(null);
    setBusy(true);
    try {
      setPlan(await previewRestoreMailbox(tenantId, item.id, fetcher));
    } catch (err) {
      setDialogError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function confirmRestore(): Promise<void> {
    if (!target) return;
    setBusy(true);
    setDialogError(null);
    try {
      await applyRestoreMailbox(tenantId, target.id, fetcher);
      setNotice(`Restored ${target.displayName ?? target.primarySmtpAddress}.`);
      setTarget(null);
      setPlan(null);
      await load(null);
    } catch (err) {
      setDialogError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  const gated: CSSProperties = !canWrite ? disabledStyle : {};

  return (
    <div style={pageStyle} data-testid="deleted-mailboxes-page">
      <div>
        <div style={{ fontSize: "12px", color: "var(--text-soft)" }}>Email &amp; Exchange &gt; Administration &gt; Deleted Mailboxes</div>
        <h1 style={{ fontSize: "24px", fontWeight: 700, margin: "4px 0 0" }}>Deleted Mailboxes</h1>
        <p style={{ margin: "4px 0 0", color: "var(--text-soft)", fontSize: "14px" }}>
          Soft-deleted mailboxes that can still be restored. Restore previews the change before it is applied.
        </p>
      </div>

      {notice && <div style={{ color: "var(--success-text)", fontSize: "14px" }} data-testid="deleted-mailboxes-notice">{notice}</div>}

      <section style={cardStyle} aria-label="Deleted mailboxes">
        <input
          type="search"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search by name or address"
          aria-label="Search deleted mailboxes"
          style={inputStyle}
          data-testid="deleted-mailboxes-search"
        />
        {loading && <p data-testid="deleted-mailboxes-loading">Loading deleted mailboxes…</p>}
        {error && <div role="alert" style={{ color: "var(--danger-text)" }} data-testid="deleted-mailboxes-error">{error}</div>}
        {!error && (
          <div style={{ overflowX: "auto" }}>
            <table style={tableStyle} data-testid="deleted-mailboxes-table">
              <thead>
                <tr>
                  <th style={thStyle}>Display name</th>
                  <th style={thStyle}>Primary SMTP</th>
                  <th style={thStyle}>Type</th>
                  <th style={thStyle}>Deleted</th>
                  <th style={thStyle}>Days until purge</th>
                  <th style={thStyle}>Actions</th>
                </tr>
              </thead>
              <tbody>
                {items.length === 0 && !loading ? (
                  <tr><td style={tdStyle} colSpan={6} data-testid="deleted-mailboxes-empty">No soft-deleted mailboxes.</td></tr>
                ) : (
                  items.map((item) => (
                    <tr key={item.id} data-testid={`deleted-mailbox-row-${item.id}`}>
                      <td style={tdStyle}>{item.displayName ?? "—"}</td>
                      <td style={{ ...tdStyle, fontFamily: "var(--font-mono, monospace)", fontSize: "13px" }}>{item.primarySmtpAddress}</td>
                      <td style={tdStyle}>{item.mailboxType}</td>
                      <td style={tdStyle}>{item.deletedAt ?? "—"}</td>
                      <td style={tdStyle}>{item.daysUntilPurge ?? "—"}</td>
                      <td style={tdStyle}>
                        <button
                          type="button"
                          style={{ ...buttonStyle, ...gated }}
                          disabled={!canWrite}
                          title={!canWrite ? "Requires mailboxes.write permission" : "Restore mailbox"}
                          onClick={() => void openRestore(item)}
                          data-testid={`deleted-mailbox-restore-${item.id}`}
                        >
                          Restore
                        </button>
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        )}
        {nextCursor && (
          <div>
            <button type="button" style={buttonStyle} disabled={loading} onClick={() => void load(nextCursor)} data-testid="deleted-mailboxes-more">
              Load more
            </button>
          </div>
        )}
      </section>

      {target && (
        <div style={overlayStyle} role="dialog" aria-modal="true" aria-label="Restore deleted mailbox" data-testid="deleted-mailbox-dialog">
          <div style={dialogStyle}>
            <h3 style={{ margin: 0 }}>Restore {target.displayName ?? target.primarySmtpAddress}</h3>
            {busy && !plan && <p data-testid="deleted-mailbox-plan-loading">Building plan…</p>}
            {dialogError && <div role="alert" style={{ color: "var(--danger-text)", fontSize: "14px" }} data-testid="deleted-mailbox-dialog-error">{dialogError}</div>}
            {plan && (
              <div style={{ fontSize: "14px" }} data-testid="deleted-mailbox-plan">
                {plan.diff.length === 0 ? "No changes." : plan.diff.join(" ")}
              </div>
            )}
            <div style={{ display: "flex", gap: "8px", justifyContent: "flex-end" }}>
              <button type="button" style={buttonStyle} onClick={() => { setTarget(null); setPlan(null); setDialogError(null); }} data-testid="deleted-mailbox-cancel">Cancel</button>
              <button
                type="button"
                style={{ ...primaryButtonStyle, ...(busy || !plan || !plan.valid ? disabledStyle : {}) }}
                disabled={busy || !plan || !plan.valid}
                onClick={() => void confirmRestore()}
                data-testid="deleted-mailbox-confirm"
              >
                Confirm and restore
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

export default function DeletedMailboxesPage(): ReactElement {
  const searchParams = useSearchParams();
  const tenantId = resolveTenantId(searchParams.get("tenantId"), useCurrentTenantId());
  return (
    <RequireTenant tenantId={tenantId}>
      <DeletedMailboxesView tenantId={tenantId} />
    </RequireTenant>
  );
}
