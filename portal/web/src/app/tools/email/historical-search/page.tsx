"use client";

// Historical search page (EPIC-024 SPEC.md §2 US-2, §3.2, §4.1, §6, §7, §9;
// T-0466). Nav: Tools → Email Tools → Historical Search. Title
// "Historical Search" with the §3.2 scoped search form and results surface,
// rendered against the T-0465 API: POST /v1/tenants/:id/mail/historical-search
// to start a job, GET .../:jobId to poll progress and collect the ephemeral
// matches, and POST .../:jobId/cancel to stop a long-running search. Every
// query goes through the BFF; no browser call reaches a tenant directly.

import React, { useEffect, useRef, useState, type CSSProperties, type ReactElement } from "react";
import { useSearchParams } from "next/navigation";
import { RequireTenant } from "../../../../components/shell/RequireTenant";
import {
  HistoricalSearchForm,
  type HistoricalSearchInput,
} from "../../../../components/email-tools/HistoricalSearchForm";
import {
  HistoricalSearchResults,
  type HistoricalSearchJob,
  type HistoricalSearchResult,
} from "../../../../components/email-tools/HistoricalSearchResults";
import { resolveTenantId, useCurrentTenantId } from "../../../../lib/useCurrentTenant";

export type Fetcher = typeof fetch;

const POLL_INTERVAL_MS = 1000;

export async function startHistoricalSearch(
  tenantId: string,
  input: HistoricalSearchInput,
  fetcher: Fetcher = fetch,
): Promise<HistoricalSearchJob> {
  const response = await fetcher(`/v1/tenants/${encodeURIComponent(tenantId)}/mail/historical-search`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input),
  });
  if (!response.ok) {
    throw await readHistoricalSearchFailure(response);
  }
  return (await response.json()) as HistoricalSearchJob;
}

export async function getHistoricalSearch(
  tenantId: string,
  jobId: string,
  fetcher: Fetcher = fetch,
): Promise<HistoricalSearchResult> {
  const response = await fetcher(
    `/v1/tenants/${encodeURIComponent(tenantId)}/mail/historical-search/${encodeURIComponent(jobId)}`,
  );
  if (!response.ok) {
    throw await readHistoricalSearchFailure(response);
  }
  return (await response.json()) as HistoricalSearchResult;
}

export async function cancelHistoricalSearch(
  tenantId: string,
  jobId: string,
  fetcher: Fetcher = fetch,
): Promise<HistoricalSearchJob> {
  const response = await fetcher(
    `/v1/tenants/${encodeURIComponent(tenantId)}/mail/historical-search/${encodeURIComponent(jobId)}/cancel`,
    { method: "POST" },
  );
  if (!response.ok) {
    throw await readHistoricalSearchFailure(response);
  }
  return (await response.json()) as HistoricalSearchJob;
}

async function readHistoricalSearchFailure(response: Response): Promise<Error> {
  let message = `Historical search failed: HTTP ${response.status}`;
  try {
    const body = (await response.json()) as { code?: string; message?: string };
    if (typeof body?.message === "string" && body.message.length > 0) {
      message = body.message;
    }
  } catch {
    // non-JSON error body; keep the status fallback
  }
  return new Error(message);
}

function isTerminalState(state: HistoricalSearchJob["state"]): boolean {
  return state === "succeeded" || state === "failed" || state === "cancelled";
}

export interface HistoricalSearchViewProps {
  readonly tenantId: string;
  readonly fetcher?: Fetcher;
}

export function HistoricalSearchView({
  tenantId,
  fetcher = fetch,
}: HistoricalSearchViewProps): ReactElement {
  const [result, setResult] = useState<HistoricalSearchResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [jobId, setJobId] = useState<string | null>(null);
  const cancelRequestedRef = useRef(false);

  useEffect(() => {
    if (loading === false || jobId === null) return;
    let active = true;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const poll = async (): Promise<void> => {
      if (!active || cancelRequestedRef.current) return;
      try {
        const next = await getHistoricalSearch(tenantId, jobId, fetcher);
        if (!active) return;
        setResult(next);
        if (isTerminalState(next.job.state)) {
          setLoading(false);
          return;
        }
        timer = setTimeout(() => void poll(), POLL_INTERVAL_MS);
      } catch (err) {
        if (!active) return;
        setError(err instanceof Error ? err.message : String(err));
        setLoading(false);
      }
    };

    void poll();
    return () => {
      active = false;
      if (timer !== undefined) clearTimeout(timer);
    };
  }, [loading, jobId, tenantId, fetcher]);

  async function runSearch(input: HistoricalSearchInput): Promise<void> {
    cancelRequestedRef.current = false;
    setError(null);
    setResult(null);
    setLoading(true);
    try {
      const job = await startHistoricalSearch(tenantId, input, fetcher);
      setJobId(job.id);
    } catch (err) {
      setLoading(false);
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  async function cancelSearch(): Promise<void> {
    if (jobId === null) return;
    cancelRequestedRef.current = true;
    setLoading(false);
    try {
      const job = await cancelHistoricalSearch(tenantId, jobId, fetcher);
      setResult({ job, matches: [], totalCount: 0 });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  return (
    <div style={viewStyle} data-testid="historical-search-view">
      <HistoricalSearchForm busy={loading} onSubmit={(input) => void runSearch(input)} />

      {error !== null && (
        <div role="alert" style={errorStyle} data-testid="historical-search-error">
          {error}
        </div>
      )}

      {loading === false && error === null && result === null && (
        <div style={emptyStyle} data-testid="historical-search-empty">
          Set the scoped parameters and run a search to see matching messages across mailboxes.
        </div>
      )}

      {(loading === true || result !== null) && (
        <HistoricalSearchResults result={result} loading={loading} onCancel={() => void cancelSearch()} />
      )}
    </div>
  );
}

const viewStyle: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: "16px",
};

const emptyStyle: CSSProperties = {
  padding: "16px",
  background: "var(--bg-elev)",
  border: "1px solid var(--border)",
  borderRadius: "var(--radius, 10px)",
  color: "var(--text-soft)",
  fontSize: "14px",
};

const errorStyle: CSSProperties = {
  padding: "12px 16px",
  borderRadius: "6px",
  background: "var(--danger-soft)",
  border: "1px solid var(--danger)",
  color: "var(--danger-text)",
  fontSize: "14px",
};

const pageStyle: CSSProperties = {
  padding: "24px",
  maxWidth: "1200px",
  margin: "0 auto",
  display: "flex",
  flexDirection: "column",
  gap: "20px",
};

export default function HistoricalSearchPage(): ReactElement {
  const searchParams = useSearchParams();
  const currentTenantId = useCurrentTenantId();
  const tenantId = resolveTenantId(searchParams.get("tenantId"), currentTenantId);

  return (
    <RequireTenant tenantId={tenantId}>
      <div style={pageStyle}>
        <div>
          <div style={{ fontSize: "12px", color: "var(--text-soft)" }}>
            Tools &gt; Email Tools &gt; Historical Search
          </div>
          <h1
            style={{
              fontSize: "24px",
              fontWeight: 700,
              margin: "4px 0 0",
              fontFamily: "var(--font-display, var(--font-sans))",
            }}
          >
            Historical Search
          </h1>
          <p style={{ margin: "4px 0 0", color: "var(--text-soft)", fontSize: "14px" }}>
            Search across mailboxes with scoped parameters. Long-running searches show progress and can
            be cancelled.
          </p>
        </div>
        <HistoricalSearchView tenantId={tenantId} />
      </div>
    </RequireTenant>
  );
}
