"use client";

// Mailbox restores page (EPIC-024 SPEC.md §2 US-4, §3.4, §4.2, §5, §6, §9;
// T-0468). Nav: Tools → Email Tools → Mailbox Restores. Title "Mailbox
// Restores" with the restore wizard (select mailbox → scope → target →
// confirm) over the recent restores list. The page owns the BFF calls that
// drive the T-0467 API: POST /v1/tenants/:id/mail/restores for the plan
// preview (preview:true) and the gated start (confirm:true), and GET
// /v1/tenants/:id/mail/restores/:jobId polled for live progress. No browser
// call reaches a tenant directly.

import React, { useCallback, useEffect, useState, type CSSProperties, type ReactElement } from "react";
import { useSearchParams } from "next/navigation";
import { RequireTenant } from "../../../../components/shell/RequireTenant";
import {
  RestoreWizard,
  type MailRestoreInput,
  type MailRestoreJob,
  type MailRestorePlan,
  type MailRestoreResult,
} from "../../../../components/email-tools/RestoreWizard";
import { resolveTenantId, useCurrentTenantId } from "../../../../lib/useCurrentTenant";

export type Fetcher = typeof fetch;

async function readError(response: Response, fallback: string): Promise<Error> {
  let detail = fallback;
  try {
    const body = (await response.json()) as { message?: string };
    if (typeof body?.message === "string" && body.message.length > 0) detail = body.message;
  } catch {
    detail = `${fallback}: HTTP ${response.status}`;
  }
  return new Error(detail);
}

/** POST /v1/tenants/:id/mail/restores with preview:true — builds the plan, restores nothing. */
export async function previewMailRestore(
  tenantId: string,
  input: MailRestoreInput,
  fetcher: Fetcher = fetch,
): Promise<MailRestorePlan> {
  const response = await fetcher(`/v1/tenants/${encodeURIComponent(tenantId)}/mail/restores`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ ...input, preview: true }),
  });
  if (!response.ok) throw await readError(response, "Preview restore");
  return (await response.json()) as MailRestorePlan;
}

/** POST /v1/tenants/:id/mail/restores with confirm:true — starts the audited restore. */
export async function startMailRestore(
  tenantId: string,
  input: MailRestoreInput,
  fetcher: Fetcher = fetch,
): Promise<MailRestoreResult> {
  const response = await fetcher(`/v1/tenants/${encodeURIComponent(tenantId)}/mail/restores`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ ...input, confirm: true }),
  });
  if (!response.ok) throw await readError(response, "Start restore");
  return (await response.json()) as MailRestoreResult;
}

/** GET /v1/tenants/:id/mail/restores/:jobId — progress from the persisted RestoreJob. */
export async function readMailRestoreJob(
  tenantId: string,
  jobId: string,
  fetcher: Fetcher = fetch,
): Promise<MailRestoreJob> {
  const response = await fetcher(
    `/v1/tenants/${encodeURIComponent(tenantId)}/mail/restores/${encodeURIComponent(jobId)}`,
  );
  if (!response.ok) throw await readError(response, `Read restore job ${jobId}`);
  return (await response.json()) as MailRestoreJob;
}

function isActive(job: MailRestoreJob): boolean {
  return job.state === "planned" || job.state === "running";
}

function countIn(result: Record<string, unknown> | null, key: "before" | "after"): number | null {
  const section = result?.[key];
  if (section !== undefined && section !== null && typeof section === "object") {
    const value = (section as Record<string, unknown>)["itemCount"];
    if (typeof value === "number") return value;
  }
  return null;
}

export function restoreProgress(job: MailRestoreJob): string {
  const before = countIn(job.result, "before");
  const after = countIn(job.result, "after");
  if (before !== null || after !== null) {
    return `${before ?? "—"} → ${after ?? "—"} items`;
  }
  return job.state;
}

export interface RecentRestoresProps {
  readonly jobs: readonly MailRestoreJob[];
  readonly error?: string | null;
}

export function RecentRestores({ jobs, error }: RecentRestoresProps): ReactElement {
  return (
    <section style={sectionStyle} data-testid="recent-restores">
      <h2 style={sectionTitleStyle}>Recent restores</h2>

      {error !== undefined && error !== null && (
        <p style={errorStyle} data-testid="recent-restores-error">
          {error}
        </p>
      )}

      {jobs.length === 0 ? (
        <p style={noticeStyle} data-testid="recent-restores-empty">
          No restores have been started in this session.
        </p>
      ) : (
        <table style={tableStyle} data-testid="recent-restores-table">
          <thead>
            <tr>
              <th style={thStyle}>Job</th>
              <th style={thStyle}>Mailbox</th>
              <th style={thStyle}>Scope</th>
              <th style={thStyle}>Target</th>
              <th style={thStyle}>State</th>
              <th style={thStyle}>Progress</th>
            </tr>
          </thead>
          <tbody>
            {jobs.map((job) => (
              <tr key={job.id} data-testid={`recent-restore-${job.id}`}>
                <td style={tdStyle}>{job.id}</td>
                <td style={tdStyle}>{job.mailboxId}</td>
                <td style={tdStyle}>{job.scope}</td>
                <td style={tdStyle}>{job.target ?? "—"}</td>
                <td style={tdStyle} data-testid={`recent-restore-state-${job.id}`}>
                  {job.state}
                </td>
                <td style={tdStyle} data-testid={`recent-restore-progress-${job.id}`}>
                  {restoreProgress(job)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}

export interface RestoreViewProps {
  readonly tenantId: string;
  readonly fetcher?: Fetcher;
  readonly canRestore?: boolean;
  readonly pollIntervalMs?: number;
}

export function RestoreView({
  tenantId,
  fetcher = fetch,
  canRestore = true,
  pollIntervalMs = 3000,
}: RestoreViewProps): ReactElement {
  const [jobs, setJobs] = useState<MailRestoreJob[]>([]);
  const [pollError, setPollError] = useState<string | null>(null);

  const handleStarted = useCallback((result: MailRestoreResult): void => {
    setJobs((previous) => [result.job, ...previous.filter((job) => job.id !== result.job.id)]);
  }, []);

  const activeIds = jobs
    .filter(isActive)
    .map((job) => job.id)
    .sort()
    .join(",");

  useEffect(() => {
    if (activeIds === "") return;
    const ids = activeIds.split(",");
    let cancelled = false;

    async function tick(): Promise<void> {
      try {
        const updated = await Promise.all(ids.map((id) => readMailRestoreJob(tenantId, id, fetcher)));
        if (cancelled) return;
        setJobs((previous) =>
          previous.map((job) => updated.find((item) => item.id === job.id) ?? job),
        );
        setPollError(null);
      } catch (err) {
        if (!cancelled) setPollError(err instanceof Error ? err.message : String(err));
      }
    }

    void tick();
    const timer = setInterval(() => void tick(), pollIntervalMs);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [activeIds, tenantId, fetcher, pollIntervalMs]);

  return (
    <div style={viewStyle} data-testid="mailbox-restores-view">
      <RestoreWizard
        canRestore={canRestore}
        onPreview={(input) => previewMailRestore(tenantId, input, fetcher)}
        onStart={(input) => startMailRestore(tenantId, input, fetcher)}
        onStarted={handleStarted}
      />
      <RecentRestores jobs={jobs} error={pollError} />
    </div>
  );
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

const viewStyle: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: "20px",
};

const sectionStyle: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: "10px",
  background: "var(--bg-elev)",
  border: "1px solid var(--border)",
  borderRadius: "var(--radius, 10px)",
  padding: "16px",
};

const sectionTitleStyle: CSSProperties = { fontSize: "15px", fontWeight: 600, margin: 0 };

const noticeStyle: CSSProperties = { fontSize: "13px", margin: 0, color: "var(--text-soft)" };

const errorStyle: CSSProperties = {
  fontSize: "13px",
  margin: 0,
  color: "var(--danger-text, var(--danger))",
};

const tableStyle: CSSProperties = { width: "100%", borderCollapse: "collapse", fontSize: "13px" };

const thStyle: CSSProperties = {
  textAlign: "left",
  padding: "8px 10px",
  borderBottom: "1px solid var(--border-strong, var(--border))",
  color: "var(--text-soft)",
  fontSize: "12px",
  textTransform: "uppercase",
  letterSpacing: "0.07em",
};

const tdStyle: CSSProperties = {
  padding: "8px 10px",
  borderBottom: "1px solid var(--border)",
  verticalAlign: "top",
};

export default function MailboxRestoresPage(): ReactElement {
  const searchParams = useSearchParams();
  const currentTenantId = useCurrentTenantId();
  const tenantId = resolveTenantId(searchParams.get("tenantId"), currentTenantId);

  return (
    <RequireTenant tenantId={tenantId}>
      <div style={pageStyle}>
        <div>
          <div style={{ fontSize: "12px", color: "var(--text-soft)" }}>
            Tools &gt; Email Tools &gt; Mailbox Restores
          </div>
          <h1
            style={{
              fontSize: "24px",
              fontWeight: 700,
              margin: "4px 0 0",
              fontFamily: "var(--font-display, var(--font-sans))",
            }}
          >
            Mailbox Restores
          </h1>
          <p style={{ margin: "4px 0 0", color: "var(--text-soft)", fontSize: "14px" }}>
            Restore a deleted mailbox or specific items within the recovery window. A plan preview is
            shown before any destructive change.
          </p>
        </div>
        <RestoreView tenantId={tenantId} />
      </div>
    </RequireTenant>
  );
}
