"use client";

// Quarantine (EPIC-022 SPEC.md §3.3; T-0424, T-0425). Nav: Administration →
// Quarantine. Title "Quarantine" with the Email / Files / Teams Messages
// tabs — the User Reported tab is deferred (SPEC §11.4) and is not shipped in
// v1. The §3.3 table (Received, Subject, Sender, Recipient, Reason, Policy,
// Expires, State) with the §3.3 filters (reason, direction, date, recipient,
// state) and row actions (Preview, Release, Release to all, Download, Block
// sender, Delete, Submit for review). Release/delete are security actions:
// the plan preview shows the affected message and the release warning
// before apply, and bulk release/delete is capped with an explicit
// confirmation count (resolved §11.2). Reads come from the T-0424 list API
// and writes from the T-0424/T-0425 routes; every write applies with
// confirm:true. No browser call reaches a tenant directly — everything goes
// through the BFF.

import React, { useCallback, useEffect, useMemo, useState, type CSSProperties, type ReactElement } from "react";
import { useSearchParams } from "next/navigation";
import { RequireTenant } from "../../../components/shell/RequireTenant";
import { resolveTenantId, useCurrentTenantId } from "../../../lib/useCurrentTenant";

export const QUARANTINE_TABS = ["email", "files", "teams"] as const;
export type QuarantineTab = (typeof QUARANTINE_TABS)[number];

export const QUARANTINE_TAB_TITLES: Readonly<Record<QuarantineTab, string>> = {
  email: "Email",
  files: "Files",
  teams: "Teams Messages",
};

export interface QuarantineMessage {
  readonly messageId: string;
  readonly tab: QuarantineTab;
  readonly received: string;
  readonly subject: string;
  readonly sender: string;
  readonly recipient: string;
  readonly reason: string;
  readonly policy: string;
  readonly expires: string | null;
  readonly state: string;
  readonly direction: string;
}

export interface QuarantineMessagePreview {
  readonly source: "exo" | "graph";
  readonly available: boolean;
  readonly body?: string | null;
}

export interface QuarantineMessageDetail extends QuarantineMessage {
  readonly preview: QuarantineMessagePreview;
}

export interface QuarantineFilter {
  readonly reason?: string;
  readonly direction?: string;
  readonly recipient?: string;
  readonly state?: string;
  readonly dateFrom?: string;
  readonly dateTo?: string;
}

export interface QuarantineActionPlan {
  readonly action: string;
  readonly messageId: string;
  readonly tab: string;
  readonly recipient: string | null;
  readonly sender: string;
  readonly diff: readonly string[];
  readonly valid: boolean;
  readonly dryRun: boolean;
  readonly requiresConfirmation: boolean;
  readonly securityImpacting: boolean;
  readonly warning?: string;
}

export interface QuarantineBulkConfirmation {
  readonly action: string;
  readonly count: number;
  readonly cap: number;
  readonly remaining: number;
  readonly requiresConfirmation: boolean;
  readonly confirmed: boolean;
  readonly warning: string;
}

export interface QuarantineBulkPlan {
  readonly action: string;
  readonly messageIds: readonly string[];
  readonly count: number;
  readonly cap: number;
  readonly items: readonly { readonly messageId: string; readonly recipient: string | null; readonly sender: string; readonly tab: string }[];
  readonly dryRun: boolean;
  readonly requiresConfirmation: boolean;
  readonly securityImpacting: boolean;
  readonly warning: string;
  readonly confirmation: QuarantineBulkConfirmation;
  readonly diff?: readonly string[];
  readonly valid?: boolean;
}

export type Fetcher = typeof fetch;

export const QUARANTINE_RELEASE_WARNING =
  "Releasing quarantined mail can deliver malicious content to a mailbox. Preview the message first; this release is audited with actor, message, and recipient.";

export const QUARANTINE_BULK_WARNING =
  "Bulk quarantine release/delete is security-impacting: it can deliver malicious content or destroy quarantined evidence. Each item is audited with actor, message, and recipient; a failure on one message does not stop the rest.";

/** Per-action bulk cap; the BFF defaults to the same value (T-0425). */
export const QUARANTINE_BULK_CAP = 100;

function quarantineBasePath(tenantId: string, messageId?: string | null): string {
  const base = `/v1/tenants/${encodeURIComponent(tenantId)}/quarantine`;
  return messageId ? `${base}/${encodeURIComponent(messageId)}` : base;
}

/** Builds the BFF query string for GET /v1/tenants/:id/quarantine. */
export function buildQuarantineQuery(tab: QuarantineTab, filter: QuarantineFilter, cursor: string | null = null, limit = 100): string {
  const params = new URLSearchParams();
  params.set("tab", tab);
  if (filter.reason) params.set("reason", filter.reason);
  if (filter.direction) params.set("direction", filter.direction);
  if (filter.recipient) params.set("recipient", filter.recipient);
  if (filter.state) params.set("state", filter.state);
  if (filter.dateFrom) params.set("dateFrom", filter.dateFrom);
  if (filter.dateTo) params.set("dateTo", filter.dateTo);
  if (cursor) params.set("cursor", cursor);
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

export async function listQuarantineMessages(
  tenantId: string,
  tab: QuarantineTab,
  filter: QuarantineFilter,
  fetcher: Fetcher = fetch,
): Promise<{ items: QuarantineMessage[]; nextCursor: string | null }> {
  const response = await fetcher(`${quarantineBasePath(tenantId)}${buildQuarantineQuery(tab, filter)}`);
  if (!response.ok) throw await readError(response, "List quarantine messages");
  const body = (await response.json()) as { items?: QuarantineMessage[]; nextCursor?: string | null };
  return { items: [...(body.items ?? [])], nextCursor: body.nextCursor ?? null };
}

export async function getQuarantineMessage(
  tenantId: string,
  messageId: string,
  fetcher: Fetcher = fetch,
): Promise<QuarantineMessageDetail> {
  const response = await fetcher(quarantineBasePath(tenantId, messageId));
  if (!response.ok) throw await readError(response, "Preview quarantine message");
  return (await response.json()) as QuarantineMessageDetail;
}

export async function previewQuarantineAction(
  tenantId: string,
  messageId: string,
  action: string,
  payload: Record<string, unknown>,
  fetcher: Fetcher = fetch,
): Promise<QuarantineActionPlan> {
  const response = await fetcher(`${quarantineBasePath(tenantId, messageId)}/${encodeURIComponent(action)}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ ...payload, preview: true }),
  });
  if (!response.ok) throw await readError(response, "Preview quarantine action");
  return (await response.json()) as QuarantineActionPlan;
}

export async function applyQuarantineAction(
  tenantId: string,
  messageId: string,
  action: string,
  payload: Record<string, unknown>,
  fetcher: Fetcher = fetch,
): Promise<unknown> {
  const response = await fetcher(`${quarantineBasePath(tenantId, messageId)}/${encodeURIComponent(action)}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ ...payload, preview: false, confirm: true }),
  });
  if (!response.ok) throw await readError(response, "Apply quarantine action");
  return response.json();
}

export async function previewQuarantineBulk(
  tenantId: string,
  action: string,
  messageIds: readonly string[],
  fetcher: Fetcher = fetch,
): Promise<QuarantineBulkPlan> {
  const response = await fetcher(`${quarantineBasePath(tenantId)}/bulk`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ action, messageIds, preview: true }),
  });
  if (!response.ok) throw await readError(response, "Preview quarantine bulk action");
  return (await response.json()) as QuarantineBulkPlan;
}

export async function applyQuarantineBulk(
  tenantId: string,
  action: string,
  messageIds: readonly string[],
  fetcher: Fetcher = fetch,
): Promise<unknown> {
  const response = await fetcher(`${quarantineBasePath(tenantId)}/bulk`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ action, messageIds, preview: false, confirm: true }),
  });
  if (!response.ok) throw await readError(response, "Apply quarantine bulk action");
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

const tabStyle: CSSProperties = {
  padding: "8px 14px",
  background: "transparent",
  border: "1px solid var(--border)",
  borderRadius: "6px",
  color: "var(--text-soft)",
  fontSize: "14px",
  fontWeight: 500,
  cursor: "pointer",
};

const activeTabStyle: CSSProperties = {
  ...tabStyle,
  background: "var(--accent-soft, var(--surface))",
  borderColor: "var(--accent-border, var(--accent))",
  color: "var(--accent-text, var(--accent))",
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
  maxWidth: "640px",
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

export interface QuarantineViewProps {
  readonly tenantId: string;
  /** False hides write controls the caller lacks RBAC for. */
  readonly canAct?: boolean;
  readonly fetcher?: Fetcher;
}

interface PendingAction {
  readonly action: string;
  readonly label: string;
  readonly message: QuarantineMessage;
}

interface PendingBulk {
  readonly action: string;
  readonly label: string;
  readonly messageIds: readonly string[];
}

export function QuarantineView({
  tenantId,
  canAct = true,
  fetcher = fetch,
}: QuarantineViewProps): ReactElement {
  const [tab, setTab] = useState<QuarantineTab>("email");
  const [filter, setFilter] = useState<QuarantineFilter>({});
  const [items, setItems] = useState<QuarantineMessage[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [selected, setSelected] = useState<QuarantineMessageDetail | null>(null);
  const [selectedIds, setSelectedIds] = useState<ReadonlySet<string>>(new Set());
  const [pending, setPending] = useState<PendingAction | null>(null);
  const [pendingBulk, setPendingBulk] = useState<PendingBulk | null>(null);
  const [plan, setPlan] = useState<QuarantineActionPlan | QuarantineBulkPlan | null>(null);
  const [planBusy, setPlanBusy] = useState(false);
  const [planError, setPlanError] = useState<string | null>(null);

  const fetchList = useCallback(
    async (nextTab: QuarantineTab, nextFilter: QuarantineFilter): Promise<void> => {
      setLoading(true);
      setError(null);
      try {
        const page = await listQuarantineMessages(tenantId, nextTab, nextFilter, fetcher);
        setItems(page.items);
        setSelectedIds(new Set());
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        setLoading(false);
      }
    },
    [tenantId, fetcher],
  );

  useEffect(() => {
    void fetchList(tab, filter);
  }, [tenantId, tab, filter, fetchList]);

  function resetPlan(): void {
    setPlan(null);
    setPlanError(null);
  }

  function toggleSelected(messageId: string): void {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(messageId)) next.delete(messageId);
      else next.add(messageId);
      return next;
    });
  }

  async function openPreview(message: QuarantineMessage): Promise<void> {
    setError(null);
    try {
      setSelected(await getQuarantineMessage(tenantId, message.messageId, fetcher));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  function downloadMessage(detail: QuarantineMessageDetail): void {
    if (!detail.preview.available || !detail.preview.body) {
      setError("Preview is not available for this message.");
      return;
    }
    const blob = new Blob([detail.preview.body], { type: "text/plain" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `${detail.messageId}.txt`;
    anchor.click();
    URL.revokeObjectURL(url);
  }

  async function downloadRow(message: QuarantineMessage): Promise<void> {
    setError(null);
    try {
      downloadMessage(await getQuarantineMessage(tenantId, message.messageId, fetcher));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  async function runActionPreview(next: PendingAction): Promise<void> {
    setPending(next);
    resetPlan();
    setPlanBusy(true);
    try {
      const preview = await previewQuarantineAction(tenantId, next.message.messageId, next.action, {}, fetcher);
      setPlan(preview);
    } catch (err) {
      setPlanError(err instanceof Error ? err.message : String(err));
    } finally {
      setPlanBusy(false);
    }
  }

  async function confirmPendingAction(): Promise<void> {
    if (!pending) return;
    setPlanBusy(true);
    setPlanError(null);
    try {
      await applyQuarantineAction(tenantId, pending.message.messageId, pending.action, {}, fetcher);
      setNotice(`${pending.label} applied to “${pending.message.subject}”.`);
      setPending(null);
      resetPlan();
      await fetchList(tab, filter);
    } catch (err) {
      setPlanError(err instanceof Error ? err.message : String(err));
    } finally {
      setPlanBusy(false);
    }
  }

  function openBulk(action: "release" | "delete"): void {
    if (selectedIds.size === 0) return;
    setPendingBulk({ action, label: action === "release" ? "Release selected" : "Delete selected", messageIds: [...selectedIds] });
    resetPlan();
  }

  async function runBulkPreview(): Promise<void> {
    if (!pendingBulk) return;
    setPlanBusy(true);
    resetPlan();
    try {
      const preview = await previewQuarantineBulk(tenantId, pendingBulk.action, pendingBulk.messageIds, fetcher);
      setPlan(preview);
    } catch (err) {
      setPlanError(err instanceof Error ? err.message : String(err));
    } finally {
      setPlanBusy(false);
    }
  }

  async function confirmPendingBulk(): Promise<void> {
    if (!pendingBulk) return;
    setPlanBusy(true);
    setPlanError(null);
    try {
      await applyQuarantineBulk(tenantId, pendingBulk.action, pendingBulk.messageIds, fetcher);
      setNotice(`${pendingBulk.label} applied to ${pendingBulk.messageIds.length} message(s).`);
      setPendingBulk(null);
      resetPlan();
      await fetchList(tab, filter);
    } catch (err) {
      setPlanError(err instanceof Error ? err.message : String(err));
    } finally {
      setPlanBusy(false);
    }
  }

  const writeDisabled = !canAct;
  const actionWarning =
    pending && plan && "warning" in plan && plan.warning
      ? plan.warning
      : pending && (pending.action === "release" || pending.action === "releaseAll" || pending.action === "delete")
        ? QUARANTINE_RELEASE_WARNING
        : undefined;
  const bulkWarning =
    pendingBulk && plan && "warning" in plan && plan.warning
      ? plan.warning
      : pendingBulk
        ? QUARANTINE_BULK_WARNING
        : undefined;

  const dialogTitle = useMemo(() => {
    if (pending) return `${pending.label} — ${pending.message.subject}`;
    if (pendingBulk) return `${pendingBulk.label} (${pendingBulk.messageIds.length})`;
    return "";
  }, [pending, pendingBulk]);

  const bulkCount = pendingBulk?.messageIds.length ?? 0;

  return (
    <div style={pageStyle} data-testid="quarantine-page">
      <div>
        <div style={{ fontSize: "12px", color: "var(--text-soft)" }}>Administration &gt; Quarantine</div>
        <h1 style={{ fontSize: "24px", fontWeight: 700, margin: "4px 0 0", fontFamily: "var(--font-display, var(--font-sans))" }}>
          Quarantine
        </h1>
        <p style={{ margin: "4px 0 0", color: "var(--text-soft)", fontSize: "14px" }}>
          Review quarantined messages, preview before release, and release or delete with confirmation. Bulk actions are capped at {QUARANTINE_BULK_CAP} messages.
        </p>
      </div>

      <div style={{ display: "flex", gap: "8px", flexWrap: "wrap", alignItems: "center" }} data-testid="quarantine-tabs" role="tablist">
        {QUARANTINE_TABS.map((next) => (
          <button
            key={next}
            type="button"
            role="tab"
            aria-selected={tab === next}
            style={tab === next ? activeTabStyle : tabStyle}
            onClick={() => { setTab(next); setSelected(null); resetPlan(); }}
            data-testid={`quarantine-tab-${next}`}
          >
            {QUARANTINE_TAB_TITLES[next]}
          </button>
        ))}
      </div>

      <div style={{ display: "flex", gap: "8px", flexWrap: "wrap", alignItems: "center" }} data-testid="quarantine-filters">
        <input
          type="text"
          placeholder="Reason..."
          value={filter.reason ?? ""}
          onChange={(e) => setFilter((prev) => ({ ...prev, reason: e.target.value || undefined }))}
          style={inputStyle}
          aria-label="Filter by reason"
          data-testid="quarantine-filter-reason"
        />
        <input
          type="text"
          placeholder="Direction..."
          value={filter.direction ?? ""}
          onChange={(e) => setFilter((prev) => ({ ...prev, direction: e.target.value || undefined }))}
          style={inputStyle}
          aria-label="Filter by direction"
          data-testid="quarantine-filter-direction"
        />
        <input
          type="text"
          placeholder="Recipient..."
          value={filter.recipient ?? ""}
          onChange={(e) => setFilter((prev) => ({ ...prev, recipient: e.target.value || undefined }))}
          style={inputStyle}
          aria-label="Filter by recipient"
          data-testid="quarantine-filter-recipient"
        />
        <input
          type="text"
          placeholder="State..."
          value={filter.state ?? ""}
          onChange={(e) => setFilter((prev) => ({ ...prev, state: e.target.value || undefined }))}
          style={inputStyle}
          aria-label="Filter by state"
          data-testid="quarantine-filter-state"
        />
        <input
          type="datetime-local"
          value={filter.dateFrom ?? ""}
          onChange={(e) => setFilter((prev) => ({ ...prev, dateFrom: e.target.value || undefined }))}
          style={inputStyle}
          aria-label="Received after"
          data-testid="quarantine-filter-date-from"
        />
        <input
          type="datetime-local"
          value={filter.dateTo ?? ""}
          onChange={(e) => setFilter((prev) => ({ ...prev, dateTo: e.target.value || undefined }))}
          style={inputStyle}
          aria-label="Received before"
          data-testid="quarantine-filter-date-to"
        />
      </div>

      {notice && (
        <div style={{ padding: "12px 16px", borderRadius: "6px", background: "var(--success-soft)", border: "1px solid var(--success)", color: "var(--success-text)", fontSize: "14px" }} data-testid="quarantine-notice">
          {notice}
        </div>
      )}
      {error && (
        <div role="alert" style={{ padding: "12px 16px", borderRadius: "6px", background: "var(--danger-soft)", border: "1px solid var(--danger)", color: "var(--danger-text)", fontSize: "14px" }} data-testid="quarantine-error">
          {error}
        </div>
      )}

      <div style={{ display: "flex", gap: "8px", flexWrap: "wrap", alignItems: "center" }} data-testid="quarantine-bulk-bar">
        <button
          type="button"
          style={{ ...buttonStyle, ...(writeDisabled || selectedIds.size === 0 ? disabledStyle : {}) }}
          disabled={writeDisabled || selectedIds.size === 0}
          title={writeDisabled ? "Requires quarantine.act permission" : "Release the selected messages"}
          onClick={() => openBulk("release")}
          data-testid="quarantine-bulk-release"
        >
          Release selected ({selectedIds.size})
        </button>
        <button
          type="button"
          style={{ ...buttonStyle, ...(writeDisabled || selectedIds.size === 0 ? disabledStyle : {}) }}
          disabled={writeDisabled || selectedIds.size === 0}
          title={writeDisabled ? "Requires quarantine.act permission" : "Delete the selected messages"}
          onClick={() => openBulk("delete")}
          data-testid="quarantine-bulk-delete"
        >
          Delete selected ({selectedIds.size})
        </button>
      </div>

      <div style={{ overflowX: "auto" }}>
        <table style={tableStyle} data-testid="quarantine-table">
          <thead>
            <tr>
              <th style={thStyle}><input
                type="checkbox"
                checked={items.length > 0 && selectedIds.size === items.length}
                onChange={(e) => setSelectedIds(e.target.checked ? new Set(items.map((message) => message.messageId)) : new Set())}
                aria-label="Select all messages"
                data-testid="quarantine-select-all"
              /></th>
              <th style={thStyle}>Received</th>
              <th style={thStyle}>Subject</th>
              <th style={thStyle}>Sender</th>
              <th style={thStyle}>Recipient</th>
              <th style={thStyle}>Reason</th>
              <th style={thStyle}>Policy</th>
              <th style={thStyle}>Expires</th>
              <th style={thStyle}>State</th>
              <th style={thStyle}>Actions</th>
            </tr>
          </thead>
          <tbody>
            {loading ? (
              <tr><td style={tdStyle} colSpan={10}>Loading quarantined messages…</td></tr>
            ) : items.length === 0 ? (
              <tr><td style={tdStyle} colSpan={10}>No quarantined messages found.</td></tr>
            ) : (
              items.map((message) => (
                <tr key={message.messageId} data-testid={`quarantine-row-${message.messageId}`}>
                  <td style={tdStyle}><input
                    type="checkbox"
                    checked={selectedIds.has(message.messageId)}
                    onChange={() => toggleSelected(message.messageId)}
                    aria-label={`Select message ${message.subject}`}
                    data-testid={`quarantine-select-${message.messageId}`}
                  /></td>
                  <td style={tdStyle}>{message.received}</td>
                  <td style={tdStyle}>{message.subject}</td>
                  <td style={tdStyle}>{message.sender}</td>
                  <td style={tdStyle}>{message.recipient}</td>
                  <td style={tdStyle}>{message.reason}</td>
                  <td style={tdStyle}>{message.policy}</td>
                  <td style={tdStyle}>{message.expires ?? "—"}</td>
                  <td style={tdStyle}>{message.state}</td>
                  <td style={tdStyle}>
                    <div style={{ display: "flex", gap: "6px", flexWrap: "wrap" }}>
                      <button type="button" style={buttonStyle} onClick={() => void openPreview(message)} data-testid={`quarantine-preview-${message.messageId}`}>Preview</button>
                      <button type="button" style={writeDisabled ? { ...buttonStyle, ...disabledStyle } : buttonStyle} disabled={writeDisabled} title={writeDisabled ? "Requires quarantine.act permission" : "Release"} onClick={() => void runActionPreview({ action: "release", label: "Release", message })} data-testid={`quarantine-release-${message.messageId}`}>Release</button>
                      <button type="button" style={writeDisabled ? { ...buttonStyle, ...disabledStyle } : buttonStyle} disabled={writeDisabled} title={writeDisabled ? "Requires quarantine.act permission" : "Release to all"} onClick={() => void runActionPreview({ action: "releaseAll", label: "Release to all", message })} data-testid={`quarantine-release-all-${message.messageId}`}>Release to all</button>
                      <button type="button" style={buttonStyle} onClick={() => void downloadRow(message)} data-testid={`quarantine-download-${message.messageId}`}>Download</button>
                      <button type="button" style={writeDisabled ? { ...buttonStyle, ...disabledStyle } : buttonStyle} disabled={writeDisabled} title={writeDisabled ? "Requires quarantine.act permission" : "Block sender"} onClick={() => void runActionPreview({ action: "block", label: "Block sender", message })} data-testid={`quarantine-block-${message.messageId}`}>Block sender</button>
                      <button type="button" style={writeDisabled ? { ...buttonStyle, ...disabledStyle } : buttonStyle} disabled={writeDisabled} title={writeDisabled ? "Requires quarantine.act permission" : "Delete"} onClick={() => void runActionPreview({ action: "delete", label: "Delete", message })} data-testid={`quarantine-delete-${message.messageId}`}>Delete</button>
                      <button type="button" style={{ ...buttonStyle, ...disabledStyle }} disabled title="Submit for review is not yet available" data-testid={`quarantine-submit-${message.messageId}`}>Submit for review</button>
                    </div>
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      {selected && (
        <aside style={drawerStyle} role="dialog" aria-modal="true" aria-label={`Quarantined message ${selected.subject}`} data-testid="quarantine-drawer">
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
            <h2 style={{ margin: 0, fontSize: "18px" }}>{selected.subject}</h2>
            <button type="button" style={buttonStyle} onClick={() => setSelected(null)} data-testid="quarantine-drawer-close">Close</button>
          </div>
          <dl style={{ margin: 0, display: "grid", gridTemplateColumns: "140px 1fr", gap: "8px", fontSize: "14px" }}>
            <dt style={{ color: "var(--text-soft)" }}>Received</dt><dd style={{ margin: 0 }}>{selected.received}</dd>
            <dt style={{ color: "var(--text-soft)" }}>Sender</dt><dd style={{ margin: 0 }}>{selected.sender}</dd>
            <dt style={{ color: "var(--text-soft)" }}>Recipient</dt><dd style={{ margin: 0 }}>{selected.recipient}</dd>
            <dt style={{ color: "var(--text-soft)" }}>Reason</dt><dd style={{ margin: 0 }}>{selected.reason}</dd>
            <dt style={{ color: "var(--text-soft)" }}>Policy</dt><dd style={{ margin: 0 }}>{selected.policy}</dd>
            <dt style={{ color: "var(--text-soft)" }}>Expires</dt><dd style={{ margin: 0 }}>{selected.expires ?? "—"}</dd>
            <dt style={{ color: "var(--text-soft)" }}>State</dt><dd style={{ margin: 0 }}>{selected.state}</dd>
            <dt style={{ color: "var(--text-soft)" }}>Direction</dt><dd style={{ margin: 0 }}>{selected.direction}</dd>
          </dl>
          <div>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "6px" }}>
              <div style={{ fontSize: "12px", textTransform: "uppercase", letterSpacing: "0.07em", color: "var(--text-soft)" }}>
                Preview ({selected.preview.source}{selected.preview.available ? "" : ", unavailable"})
              </div>
              <button type="button" style={buttonStyle} onClick={() => downloadMessage(selected)} disabled={!selected.preview.available || !selected.preview.body} data-testid="quarantine-drawer-download">Download</button>
            </div>
            {selected.preview.available && selected.preview.body ? (
              <pre style={{ margin: 0, padding: "12px", borderRadius: "6px", background: "var(--bg)", border: "1px solid var(--border)", fontSize: "13px", whiteSpace: "pre-wrap", wordBreak: "break-word", maxHeight: "320px", overflowY: "auto" }} data-testid="quarantine-preview-body">{selected.preview.body}</pre>
            ) : (
              <p style={{ margin: 0, color: "var(--text-soft)", fontSize: "14px" }}>No preview body is available for this message.</p>
            )}
          </div>
        </aside>
      )}

      {pending && (
        <div style={overlayStyle} role="dialog" aria-modal="true" aria-label={dialogTitle} data-testid="quarantine-action-dialog">
          <div style={dialogStyle}>
            <h3 style={{ margin: 0 }}>{dialogTitle}</h3>
            {actionWarning && (
              <div style={flagStyle} data-testid="quarantine-action-warning">⚠ {actionWarning}</div>
            )}
            <QuarantinePlanPreview plan={plan} planBusy={planBusy} planError={planError} />
            <div style={{ display: "flex", gap: "8px", justifyContent: "flex-end" }}>
              <button type="button" style={buttonStyle} onClick={() => { setPending(null); resetPlan(); }} data-testid="quarantine-action-cancel">Cancel</button>
              <button type="button" style={{ ...primaryButtonStyle, ...(planBusy || !plan || plan.valid === false ? disabledStyle : {}) }} disabled={planBusy || !plan || plan.valid === false} onClick={() => void confirmPendingAction()} data-testid="quarantine-action-confirm">Confirm and apply</button>
            </div>
          </div>
        </div>
      )}

      {pendingBulk && (
        <div style={overlayStyle} role="dialog" aria-modal="true" aria-label={dialogTitle} data-testid="quarantine-bulk-dialog">
          <div style={dialogStyle}>
            <h3 style={{ margin: 0 }}>{dialogTitle}</h3>
            {bulkWarning && (
              <div style={flagStyle} data-testid="quarantine-bulk-warning">⚠ {bulkWarning}</div>
            )}
            <div style={{ fontSize: "14px" }} data-testid="quarantine-bulk-count">
              {bulkCount} of {QUARANTINE_BULK_CAP} messages selected — the batch is rejected if it exceeds the cap.
            </div>
            <QuarantinePlanPreview plan={plan} planBusy={planBusy} planError={planError} />
            <div style={{ display: "flex", gap: "8px", justifyContent: "flex-end" }}>
              <button type="button" style={buttonStyle} onClick={() => { setPendingBulk(null); resetPlan(); }} data-testid="quarantine-bulk-cancel">Cancel</button>
              <button type="button" style={buttonStyle} onClick={() => void runBulkPreview()} disabled={planBusy} data-testid="quarantine-bulk-preview">Preview plan</button>
              <button type="button" style={{ ...primaryButtonStyle, ...(planBusy || !plan ? disabledStyle : {}) }} disabled={planBusy || !plan} onClick={() => void confirmPendingBulk()} data-testid="quarantine-bulk-confirm">Confirm and apply</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

interface QuarantinePlanPreviewProps {
  readonly plan: QuarantineActionPlan | QuarantineBulkPlan | null;
  readonly planBusy: boolean;
  readonly planError: string | null;
}

function QuarantinePlanPreview({ plan, planBusy, planError }: QuarantinePlanPreviewProps): ReactElement {
  return (
    <div data-testid="quarantine-plan-preview">
      {planBusy && <p style={{ margin: 0, fontSize: "14px" }}>Loading plan preview…</p>}
      {planError && <div role="alert" style={{ color: "var(--danger-text)", fontSize: "14px" }}>{planError}</div>}
      {plan && (
        <div style={{ display: "flex", flexDirection: "column", gap: "8px", fontSize: "14px" }}>
          <div data-testid="quarantine-plan-diff">
            {plan.diff && plan.diff.length > 0 ? plan.diff.map((line: string, index: number) => <div key={index}>{line}</div>) : "No changes."}
          </div>
          {plan.requiresConfirmation && <div style={{ color: "var(--text-soft)", fontSize: "13px" }}>Confirmation required before apply.</div>}
        </div>
      )}
    </div>
  );
}

export default function QuarantinePage(): ReactElement {
  const searchParams = useSearchParams();
  const tenantId = resolveTenantId(searchParams.get("tenantId"), useCurrentTenantId());
  return (
    <RequireTenant tenantId={tenantId}>
      <QuarantineView tenantId={tenantId} />
    </RequireTenant>
  );
}
