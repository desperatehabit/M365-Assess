"use client";

// Vacation Mode (EPIC-020 SPEC.md §3.5, §4.3; T-0389).
// Schedules OoO and forwarding for a window: the BFF lists active/upcoming
// schedules, creates a schedule (enable + auto-revert jobs), and supports
// manual "End now". Every read and write goes through the BFF; no browser
// call reaches a tenant directly.

import React, { useCallback, useEffect, useState, type CSSProperties, type ReactElement } from "react";
import { useSearchParams } from "next/navigation";
import { RequireTenant } from "../../../../components/shell/RequireTenant";
import { resolveTenantId, useCurrentTenantId } from "../../../../lib/useCurrentTenant";
import type { Fetcher } from "../page";

export interface VacationSchedule {
  readonly id: string;
  readonly tenantId: string;
  readonly mailboxId: string;
  readonly startsAt: string;
  readonly endsAt: string;
  readonly oooMessage: string;
  readonly forwardTo: string | null;
  readonly state: "active" | "upcoming" | "ended" | "reverted";
}

/** Active/upcoming schedules sort first so the operator sees what is live. */
export function sortVacationSchedules(schedules: readonly VacationSchedule[]): VacationSchedule[] {
  const rank = (state: VacationSchedule["state"]): number =>
    state === "active" ? 0 : state === "upcoming" ? 1 : 2;
  return [...schedules].sort((a, b) => rank(a.state) - rank(b.state) || a.startsAt.localeCompare(b.startsAt));
}

export async function listVacationSchedules(
  tenantId: string,
  mailboxId: string | undefined,
  fetcher: Fetcher = fetch,
): Promise<{ schedules: VacationSchedule[] }> {
  const query = mailboxId ? `?mailboxId=${encodeURIComponent(mailboxId)}` : "";
  const response = await fetcher(`/v1/tenants/${encodeURIComponent(tenantId)}/vacation-schedules${query}`);
  if (!response.ok) throw new Error(`List vacation schedules failed: HTTP ${response.status}`);
  const body = (await response.json()) as { schedules?: VacationSchedule[] };
  return { schedules: [...(body.schedules ?? [])] };
}

export async function createVacationSchedule(
  tenantId: string,
  input: { mailboxId: string; startsAt: string; endsAt: string; oooMessage: string; forwardTo?: string },
  fetcher: Fetcher = fetch,
): Promise<unknown> {
  const response = await fetcher(`/v1/tenants/${encodeURIComponent(tenantId)}/vacation-schedules`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input),
  });
  if (!response.ok) throw new Error(`Create vacation schedule failed: HTTP ${response.status}`);
  return response.json();
}

export async function endVacationScheduleNow(
  tenantId: string,
  scheduleId: string,
  fetcher: Fetcher = fetch,
): Promise<unknown> {
  const response = await fetcher(
    `/v1/tenants/${encodeURIComponent(tenantId)}/vacation-schedules/${encodeURIComponent(scheduleId)}/end`,
    { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ confirm: true }) },
  );
  if (!response.ok) throw new Error(`End vacation schedule failed: HTTP ${response.status}`);
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

export interface VacationViewProps {
  readonly tenantId: string;
  readonly mailboxId?: string;
  readonly canWrite?: boolean;
  readonly fetcher?: Fetcher;
}

export function VacationView({ tenantId, mailboxId = "", canWrite = true, fetcher = fetch }: VacationViewProps): ReactElement {
  const [schedules, setSchedules] = useState<VacationSchedule[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [formOpen, setFormOpen] = useState(false);
  const [formMailboxId, setFormMailboxId] = useState(mailboxId);
  const [startsAt, setStartsAt] = useState("");
  const [endsAt, setEndsAt] = useState("");
  const [oooMessage, setOooMessage] = useState("");
  const [forwardTo, setForwardTo] = useState("");
  const [busy, setBusy] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [endingId, setEndingId] = useState<string | null>(null);

  const reload = useCallback(async (): Promise<void> => {
    setLoading(true);
    setError(null);
    try {
      const result = await listVacationSchedules(tenantId, mailboxId || undefined, fetcher);
      setSchedules(sortVacationSchedules(result.schedules));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [tenantId, mailboxId, fetcher]);

  useEffect(() => {
    void reload();
  }, [reload]);

  async function handleCreate(): Promise<void> {
    setBusy(true);
    setFormError(null);
    try {
      await createVacationSchedule(
        tenantId,
        {
          mailboxId: formMailboxId.trim(),
          startsAt,
          endsAt,
          oooMessage: oooMessage.trim(),
          ...(forwardTo.trim() ? { forwardTo: forwardTo.trim() } : {}),
        },
        fetcher,
      );
      setNotice(`Vacation schedule created for ${formMailboxId.trim()}.`);
      setFormOpen(false);
      setStartsAt("");
      setEndsAt("");
      setOooMessage("");
      setForwardTo("");
      await reload();
    } catch (err) {
      setFormError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function handleEndNow(schedule: VacationSchedule): Promise<void> {
    const confirmed = window.confirm(`End the vacation schedule for ${schedule.mailboxId} now? OoO and forwarding revert immediately.`);
    if (!confirmed) return;
    setEndingId(schedule.id);
    setError(null);
    try {
      await endVacationScheduleNow(tenantId, schedule.id, fetcher);
      setNotice(`Vacation schedule for ${schedule.mailboxId} ended; OoO and forwarding reverted.`);
      await reload();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setEndingId(null);
    }
  }

  return (
    <div style={pageStyle} data-testid="vacation-page">
      <div>
        <div style={{ fontSize: "12px", color: "var(--text-soft)" }}>Email &amp; Exchange &gt; Administration &gt; Vacation Mode</div>
        <h1 style={{ fontSize: "24px", fontWeight: 700, margin: "4px 0 0" }}>Vacation Mode</h1>
        <p style={{ margin: "4px 0 0", color: "var(--text-soft)", fontSize: "14px" }}>
          Active and upcoming schedules auto-revert at end; an active schedule can be ended now.
        </p>
      </div>

      <div>
        <button
          type="button"
          style={{ ...primaryButtonStyle, ...(!canWrite ? { opacity: 0.45, cursor: "not-allowed" } : {}) }}
          disabled={!canWrite}
          title={!canWrite ? "Requires mailboxes.vacation permission" : "Schedule vacation"}
          onClick={() => { setFormMailboxId(mailboxId); setFormOpen(true); }}
          data-testid="vacation-add"
        >
          Schedule vacation
        </button>
      </div>

      {notice && <div style={{ color: "var(--success-text)", fontSize: "14px" }} data-testid="vacation-notice">{notice}</div>}
      {loading && <p data-testid="vacation-loading">Loading vacation schedules…</p>}
      {error && <div role="alert" style={{ color: "var(--danger-text)" }} data-testid="vacation-error">{error}</div>}

      <section style={cardStyle} aria-label="Vacation schedules" data-testid="vacation-table-card">
        <div style={{ overflowX: "auto" }}>
          <table style={tableStyle} data-testid="vacation-table">
            <thead>
              <tr>
                <th style={thStyle}>Mailbox</th>
                <th style={thStyle}>Starts</th>
                <th style={thStyle}>Ends</th>
                <th style={thStyle}>Forward to</th>
                <th style={thStyle}>State</th>
                <th style={thStyle}>Actions</th>
              </tr>
            </thead>
            <tbody>
              {schedules.length === 0 && !loading ? (
                <tr><td style={tdStyle} colSpan={6}>No vacation schedules.</td></tr>
              ) : (
                schedules.map((schedule) => (
                  <tr key={schedule.id} data-testid={`vacation-row-${schedule.id}`}>
                    <td style={{ ...tdStyle, fontFamily: "var(--font-mono, monospace)", fontSize: "13px" }}>{schedule.mailboxId}</td>
                    <td style={tdStyle}>{schedule.startsAt}</td>
                    <td style={tdStyle}>{schedule.endsAt}</td>
                    <td style={tdStyle}>{schedule.forwardTo ?? "—"}</td>
                    <td style={tdStyle}>{schedule.state}</td>
                    <td style={tdStyle}>
                      {(schedule.state === "active" || schedule.state === "upcoming") && (
                        <button
                          type="button"
                          style={{ ...buttonStyle, ...(!canWrite || endingId === schedule.id ? { opacity: 0.45, cursor: "not-allowed" } : {}) }}
                          disabled={!canWrite || endingId === schedule.id}
                          title={!canWrite ? "Requires mailboxes.vacation permission" : "End now"}
                          onClick={() => void handleEndNow(schedule)}
                          data-testid={`vacation-end-${schedule.id}`}
                        >
                          {endingId === schedule.id ? "Ending…" : "End now"}
                        </button>
                      )}
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </section>

      {formOpen && (
        <div style={overlayStyle} role="dialog" aria-modal="true" aria-label="Schedule vacation" data-testid="vacation-dialog">
          <div style={dialogStyle}>
            <h3 style={{ margin: 0 }}>Schedule vacation</h3>
            <label style={{ display: "flex", flexDirection: "column", gap: "6px", fontSize: "14px" }}>
              Mailbox id
              <input type="text" value={formMailboxId} onChange={(e) => setFormMailboxId(e.target.value)} style={inputStyle} aria-label="Mailbox id" data-testid="vacation-mailbox" />
            </label>
            <div style={{ display: "flex", gap: "8px" }}>
              <label style={{ display: "flex", flexDirection: "column", gap: "6px", fontSize: "14px", flex: 1 }}>
                Starts at
                <input type="datetime-local" value={startsAt} onChange={(e) => setStartsAt(e.target.value)} style={inputStyle} aria-label="Starts at" data-testid="vacation-starts" />
              </label>
              <label style={{ display: "flex", flexDirection: "column", gap: "6px", fontSize: "14px", flex: 1 }}>
                Ends at
                <input type="datetime-local" value={endsAt} onChange={(e) => setEndsAt(e.target.value)} style={inputStyle} aria-label="Ends at" data-testid="vacation-ends" />
              </label>
            </div>
            <label style={{ display: "flex", flexDirection: "column", gap: "6px", fontSize: "14px" }}>
              Out-of-office message
              <textarea value={oooMessage} onChange={(e) => setOooMessage(e.target.value)} rows={3} style={inputStyle} aria-label="Out-of-office message" data-testid="vacation-message" />
            </label>
            <label style={{ display: "flex", flexDirection: "column", gap: "6px", fontSize: "14px" }}>
              Forward to (optional cover)
              <input type="text" value={forwardTo} onChange={(e) => setForwardTo(e.target.value)} style={inputStyle} aria-label="Forward to" data-testid="vacation-forward" />
            </label>
            {formError && <div role="alert" style={{ color: "var(--danger-text)", fontSize: "14px" }}>{formError}</div>}
            <div style={{ display: "flex", gap: "8px", justifyContent: "flex-end" }}>
              <button type="button" style={buttonStyle} onClick={() => setFormOpen(false)} data-testid="vacation-cancel">Cancel</button>
              <button
                type="button"
                style={{ ...primaryButtonStyle, ...(busy ? { opacity: 0.45, cursor: "not-allowed" } : {}) }}
                disabled={busy || !formMailboxId.trim() || !startsAt || !endsAt || !oooMessage.trim()}
                onClick={() => void handleCreate()}
                data-testid="vacation-confirm"
              >
                {busy ? "Scheduling…" : "Schedule"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

export default function VacationPage(): ReactElement {
  const searchParams = useSearchParams();
  const tenantId = resolveTenantId(searchParams.get("tenantId"), useCurrentTenantId());
  const mailboxId = searchParams.get("mailboxId") ?? "";
  return (
    <RequireTenant tenantId={tenantId}>
      <VacationView tenantId={tenantId} mailboxId={mailboxId} />
    </RequireTenant>
  );
}
