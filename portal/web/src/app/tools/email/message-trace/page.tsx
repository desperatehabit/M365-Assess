"use client";

// Message trace page (EPIC-024 SPEC.md §2 US-1, §3.1, §4.1, §6, §9; T-0463).
// Nav: Tools → Email Tools → Message Trace. Title "Message Trace" with the
// §3.1 filter form over the §3.1 results table, rendered against the T-0462
// POST /v1/tenants/:id/mail/message-trace API. A date range beyond the EXO
// trace window surfaces as a clear message naming the limit and pointing at
// historical search (§9). Every query goes through the BFF; no browser call
// reaches a tenant directly.

import React, { useState, type CSSProperties, type ReactElement } from "react";
import { useSearchParams } from "next/navigation";
import { RequireTenant } from "../../../../components/shell/RequireTenant";
import {
  MessageTraceForm,
  type MessageTraceFilter,
} from "../../../../components/email-tools/MessageTraceForm";
import {
  MessageTraceTable,
  type MessageTraceRow,
} from "../../../../components/email-tools/MessageTraceTable";
import { resolveTenantId, useCurrentTenantId } from "../../../../lib/useCurrentTenant";

export const MESSAGE_TRACE_WINDOW_EXCEEDED = "message-trace.window_exceeded";

export type Fetcher = typeof fetch;

export interface MessageTracePageData {
  readonly tenantId: string;
  readonly items: readonly MessageTraceRow[];
  readonly nextCursor: string | null;
  readonly totalCount: number;
  readonly retrievedAt: string;
}

export interface MessageTraceFailure {
  readonly message: string;
  readonly windowExceeded: boolean;
}

async function readMessageTraceFailure(response: Response): Promise<MessageTraceFailure> {
  let message = `Message trace failed: HTTP ${response.status}`;
  let windowExceeded = false;
  try {
    const body = (await response.json()) as { code?: string; message?: string };
    if (typeof body?.message === "string" && body.message.length > 0) {
      message = body.message;
    }
    if (body?.code === MESSAGE_TRACE_WINDOW_EXCEEDED) {
      windowExceeded = true;
    }
  } catch {
    // non-JSON error body; keep the status fallback
  }
  return { message, windowExceeded };
}

export async function readMessageTrace(
  tenantId: string,
  filter: MessageTraceFilter,
  fetcher: Fetcher = fetch,
): Promise<MessageTracePageData> {
  const response = await fetcher(`/v1/tenants/${encodeURIComponent(tenantId)}/mail/message-trace`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(filter),
  });
  if (!response.ok) {
    throw await readMessageTraceFailure(response);
  }
  return (await response.json()) as MessageTracePageData;
}

export interface MessageTraceViewProps {
  readonly tenantId: string;
  readonly fetcher?: Fetcher;
}

export function MessageTraceView({ tenantId, fetcher = fetch }: MessageTraceViewProps): ReactElement {
  const [page, setPage] = useState<MessageTracePageData | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<MessageTraceFailure | null>(null);

  async function runTrace(filter: MessageTraceFilter): Promise<void> {
    setLoading(true);
    setError(null);
    try {
      setPage(await readMessageTrace(tenantId, filter, fetcher));
    } catch (err) {
      setError(err as MessageTraceFailure);
    } finally {
      setLoading(false);
    }
  }

  return (
    <div style={viewStyle} data-testid="message-trace-view">
      <MessageTraceForm busy={loading} onSubmit={(filter) => void runTrace(filter)} />

      {error !== null && (
        <div
          role="alert"
          style={error.windowExceeded ? windowErrorStyle : errorStyle}
          data-testid={error.windowExceeded ? "message-trace-window-error" : "message-trace-error"}
        >
          {error.message}
        </div>
      )}

      {loading === false && error === null && page === null && (
        <div style={emptyStyle} data-testid="message-trace-empty">
          Set the filters and run a trace to see messages within the EXO trace window.
        </div>
      )}

      {(loading === true || page !== null) && (
        <MessageTraceTable items={page?.items ?? []} loading={loading} tenantId={tenantId} />
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

const windowErrorStyle: CSSProperties = {
  padding: "12px 16px",
  borderRadius: "6px",
  background: "var(--warn-soft)",
  border: "1px solid var(--warn)",
  color: "var(--warn-text)",
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

export default function MessageTracePage(): ReactElement {
  const searchParams = useSearchParams();
  const currentTenantId = useCurrentTenantId();
  const tenantId = resolveTenantId(searchParams.get("tenantId"), currentTenantId);

  return (
    <RequireTenant tenantId={tenantId}>
      <div style={pageStyle}>
        <div>
          <div style={{ fontSize: "12px", color: "var(--text-soft)" }}>
            Tools &gt; Email Tools &gt; Message Trace
          </div>
          <h1
            style={{
              fontSize: "24px",
              fontWeight: 700,
              margin: "4px 0 0",
              fontFamily: "var(--font-display, var(--font-sans))",
            }}
          >
            Message Trace
          </h1>
          <p style={{ margin: "4px 0 0", color: "var(--text-soft)", fontSize: "14px" }}>
            Trace messages by sender, recipient, subject, date range, and status within the EXO trace
            window.
          </p>
        </div>
        <MessageTraceView tenantId={tenantId} />
      </div>
    </RequireTenant>
  );
}
