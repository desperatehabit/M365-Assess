"use client";

// QueuedApplications — Intune → Applications → Queued Applications (EPIC-017 SPEC.md §3.2, §4.1, §9; T-0326).
// Reads GET /v1/tenants/{id}/apps/queue (T-0323): one row per upload with its queue state and
// the worker's per-step results. Progress is the count of finished steps against the plan
// the upload route returns for the app type. While any item is still moving the page polls;
// failed items offer Re-run (POST .../apps/queue/{deploymentId}/rerun), and succeeded items
// with a Graph app id offer Assign (T-0324's flow, page in T-0843).
// Styling: kit tokens only.
import React, { useCallback, useEffect, useRef, useState, type CSSProperties } from "react";

export type QueueState = "queued" | "uploading" | "committing" | "succeeded" | "failed" | "cancelled";

export interface QueueStep {
  readonly step: string;
  readonly status: "succeeded" | "failed" | "skipped";
  readonly error?: string;
}

export interface QueueItem {
  readonly deploymentId: string;
  readonly appType: string;
  readonly displayName: string;
  readonly state: QueueState;
  readonly rerunnable: boolean;
  readonly appId: string | null;
  readonly steps: readonly QueueStep[];
  readonly error: string | null;
  readonly createdBy: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface QueueApi {
  list(tenantId: string): Promise<{ items: readonly QueueItem[] }>;
  rerun(tenantId: string, deploymentId: string): Promise<unknown>;
}

async function readError(res: Response, fallback: string): Promise<never> {
  const body = (await res.json().catch(() => ({}))) as { message?: string };
  throw new Error(body.message || `${fallback}: HTTP ${res.status}`);
}

export function createQueueApi(baseUrl = ""): QueueApi {
  const base = (tenantId: string) => `${baseUrl}/v1/tenants/${encodeURIComponent(tenantId)}/apps/queue`;
  return {
    async list(tenantId) {
      const res = await fetch(base(tenantId));
      if (!res.ok) await readError(res, "Failed to load the upload queue");
      return (await res.json()) as { items: readonly QueueItem[] };
    },
    async rerun(tenantId, deploymentId) {
      const res = await fetch(`${base(tenantId)}/${encodeURIComponent(deploymentId)}/rerun`, { method: "POST" });
      if (!res.ok) await readError(res, "Re-run failed");
      return res.json();
    },
  };
}

/** Steps the upload worker runs per type (T-0323 planAppUpload). */
const PLANNED_STEPS: Record<string, number> = { win32: 7, store: 1 };
const ACTIVE: readonly QueueState[] = ["queued", "uploading", "committing"];
export const QUEUE_POLL_MS = 5000;

const STATE_LABELS: Record<QueueState, string> = {
  queued: "Queued",
  uploading: "Uploading",
  committing: "Committing",
  succeeded: "Succeeded",
  failed: "Failed",
  cancelled: "Cancelled",
};

function stateTone(state: QueueState): CSSProperties {
  if (state === "succeeded") return { background: "var(--success-soft)", color: "var(--success-text)" };
  if (state === "failed") return { background: "var(--danger-soft)", color: "var(--danger-text)" };
  if (state === "cancelled") return { background: "var(--chip)", color: "var(--muted)" };
  return { background: "var(--accent-soft)", color: "var(--accent-text)" };
}

/** Finished steps against the plan; a succeeded item is always complete. */
export function queueProgress(item: QueueItem): { done: number; total: number } {
  const total = PLANNED_STEPS[item.appType] ?? Math.max(item.steps.length, 1);
  if (item.state === "succeeded") return { done: total, total };
  const done = item.steps.filter((s) => s.status === "succeeded").length;
  return { done: Math.min(done, total), total };
}

const cellStyle: CSSProperties = {
  padding: "10px 14px",
  borderBottom: "1px solid var(--border)",
  textAlign: "left",
  verticalAlign: "top",
  fontSize: "13px",
};

const headStyle: CSSProperties = {
  ...cellStyle,
  background: "var(--bg-elev)",
  fontSize: "12px",
  textTransform: "uppercase",
  letterSpacing: "0.05em",
  color: "var(--muted)",
};

const buttonStyle: CSSProperties = {
  padding: "3px 8px",
  fontSize: "12px",
  border: "1px solid var(--border)",
  borderRadius: "4px",
  background: "var(--bg)",
  color: "var(--text)",
  cursor: "pointer",
  marginRight: "4px",
};

function formatTime(value: string): string {
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? value : new Date(parsed).toLocaleString();
}

export interface QueuedApplicationsProps {
  readonly tenantId: string;
  readonly api?: QueueApi;
  readonly navigate?: (href: string) => void;
  /** Whether the caller may re-run and assign (write permission); read-only callers see state only. */
  readonly canWrite?: boolean;
  readonly pollMs?: number;
  /** Deployment to highlight, e.g. the one the wizard just queued. */
  readonly highlight?: string;
}

export function QueuedApplications({
  tenantId,
  api,
  navigate,
  canWrite = true,
  pollMs = QUEUE_POLL_MS,
  highlight,
}: QueuedApplicationsProps) {
  const client = useRef(api ?? createQueueApi()).current;
  const [items, setItems] = useState<readonly QueueItem[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const page = await client.list(tenantId);
      setItems(page.items);
      setError(null);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Failed to load the upload queue.");
    }
  }, [client, tenantId]);

  useEffect(() => {
    void load();
  }, [load]);

  const moving = (items ?? []).some((i) => ACTIVE.includes(i.state));
  useEffect(() => {
    if (!moving) return;
    const timer = setInterval(() => void load(), pollMs);
    return () => clearInterval(timer);
  }, [moving, load, pollMs]);

  async function rerun(item: QueueItem) {
    setNotice(null);
    try {
      await client.rerun(tenantId, item.deploymentId);
      setNotice(`Re-queued ${item.displayName}.`);
      await load();
    } catch (err: unknown) {
      setNotice(err instanceof Error ? err.message : "Re-run failed.");
    }
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "12px", color: "var(--text)" }}>
      {notice && (
        <div role="status" style={{ padding: "10px 14px", background: "var(--bg-elev)", border: "1px solid var(--border)", borderRadius: "8px" }}>
          {notice}
        </div>
      )}
      {error && (
        <div role="alert" style={{ padding: "10px 14px", background: "var(--danger-soft)", color: "var(--danger-text)", borderRadius: "8px" }}>
          {error}
        </div>
      )}
      {items === null && !error && <div style={{ color: "var(--muted)" }}>Loading the upload queue…</div>}
      {items !== null && (
        <table style={{ width: "100%", borderCollapse: "collapse", background: "var(--bg)", border: "1px solid var(--border)" }} aria-label="Queued applications">
          <thead>
            <tr>
              <th style={headStyle}>App</th>
              <th style={headStyle}>State</th>
              <th style={headStyle}>Progress</th>
              <th style={headStyle}>Queued</th>
              <th style={headStyle}>Actions</th>
            </tr>
          </thead>
          <tbody>
            {items.length === 0 ? (
              <tr>
                <td colSpan={5} style={{ ...cellStyle, textAlign: "center", color: "var(--muted)" }}>
                  No uploads in the queue.
                </td>
              </tr>
            ) : (
              items.flatMap((item) => {
                const { done, total } = queueProgress(item);
                const rows = [
                  <tr
                    key={item.deploymentId}
                    data-testid={`queue-row-${item.deploymentId}`}
                    style={item.deploymentId === highlight ? { background: "var(--hover)" } : undefined}
                  >
                    <td style={cellStyle}>
                      <div style={{ fontWeight: 500 }}>{item.displayName}</div>
                      <div style={{ fontSize: "12px", color: "var(--muted)" }}>{item.appType === "win32" ? "Win32" : "Store"}</div>
                    </td>
                    <td style={cellStyle}>
                      <span style={{ ...stateTone(item.state), padding: "2px 8px", borderRadius: "999px", fontSize: "12px", fontWeight: 600 }}>
                        {STATE_LABELS[item.state] ?? item.state}
                      </span>
                      {item.error && <div style={{ marginTop: "4px", fontSize: "12px", color: "var(--danger-text)" }}>{item.error}</div>}
                    </td>
                    <td style={cellStyle}>
                      <div
                        role="progressbar"
                        aria-label={`${item.displayName} progress`}
                        aria-valuemin={0}
                        aria-valuemax={total}
                        aria-valuenow={done}
                        style={{ width: "120px", height: "6px", background: "var(--track)", borderRadius: "999px", overflow: "hidden" }}
                      >
                        <div style={{ width: `${(done / total) * 100}%`, height: "100%", background: item.state === "failed" ? "var(--danger)" : "var(--accent)" }} />
                      </div>
                      <div style={{ fontSize: "12px", color: "var(--muted)", marginTop: "4px" }}>
                        {done} of {total} steps
                      </div>
                    </td>
                    <td style={cellStyle}>
                      <div>{formatTime(item.createdAt)}</div>
                      <div style={{ fontSize: "12px", color: "var(--muted)" }}>{item.createdBy}</div>
                    </td>
                    <td style={cellStyle}>
                      {item.steps.length > 0 && (
                        <button
                          type="button"
                          style={buttonStyle}
                          aria-expanded={expanded === item.deploymentId}
                          aria-label={`Steps for ${item.displayName}`}
                          onClick={() => setExpanded((e) => (e === item.deploymentId ? null : item.deploymentId))}
                        >
                          Steps
                        </button>
                      )}
                      {canWrite && item.rerunnable && (
                        <button type="button" style={buttonStyle} aria-label={`Re-run ${item.displayName}`} onClick={() => void rerun(item)}>
                          Re-run
                        </button>
                      )}
                      {canWrite && item.state === "succeeded" && item.appId && navigate && (
                        <button
                          type="button"
                          style={buttonStyle}
                          aria-label={`Assign ${item.displayName}`}
                          onClick={() =>
                            navigate(`/intune/applications/assign?tenantId=${encodeURIComponent(tenantId)}&appId=${encodeURIComponent(item.appId!)}`)
                          }
                        >
                          Assign
                        </button>
                      )}
                    </td>
                  </tr>,
                ];
                if (expanded === item.deploymentId) {
                  rows.push(
                    <tr key={`${item.deploymentId}-steps`}>
                      <td colSpan={5} style={{ ...cellStyle, background: "var(--bg-elev)" }}>
                        <ol aria-label={`${item.displayName} steps`} style={{ margin: 0, paddingLeft: "20px" }}>
                          {item.steps.map((s, i) => (
                            <li key={`${s.step}-${i}`}>
                              {s.step}: {s.status}
                              {s.error ? ` (${s.error})` : ""}
                            </li>
                          ))}
                        </ol>
                      </td>
                    </tr>,
                  );
                }
                return rows;
              })
            )}
          </tbody>
        </table>
      )}
    </div>
  );
}
