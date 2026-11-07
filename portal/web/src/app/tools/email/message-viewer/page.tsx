"use client";

// Message viewer page (EPIC-024 SPEC.md §2 US-3, §3.3, §4.1; T-0464/T-0854).
// Nav: Tools → Email Tools → Message Viewer. Read-only detail over the
// T-0464 GET /v1/tenants/:id/mail/messages/:messageId endpoint: delivery
// timeline, connectors, filters hit, headers, and the gated-or-present body.
// The trace table links here with the row's message identity; when no identity
// is supplied the page asks for one instead of calling the BFF with a made-up
// message. Every read goes through the BFF; no browser call reaches EXO.

import React, { useCallback, useEffect, useState, type CSSProperties, type ReactElement } from "react";
import { useSearchParams } from "next/navigation";
import { RequireTenant } from "../../../../components/shell/RequireTenant";
import {
  MessageViewer,
  type MessageViewerDetail,
} from "../../../../components/email-tools/MessageViewer";
import { resolveTenantId, useCurrentTenantId } from "../../../../lib/useCurrentTenant";

export type Fetcher = typeof fetch;

export async function readMessageDetail(
  tenantId: string,
  messageId: string,
  fetcher: Fetcher = fetch,
): Promise<MessageViewerDetail> {
  const response = await fetcher(
    `/v1/tenants/${encodeURIComponent(tenantId)}/mail/messages/${encodeURIComponent(messageId)}`,
  );
  if (!response.ok) {
    let message = `Read message detail failed: HTTP ${response.status}`;
    try {
      const body = (await response.json()) as { message?: string };
      if (typeof body?.message === "string" && body.message.length > 0) {
        message = body.message;
      }
    } catch {
      // non-JSON error body; keep the status fallback
    }
    throw new Error(message);
  }
  return (await response.json()) as MessageViewerDetail;
}

export interface MessageViewerViewProps {
  readonly tenantId: string;
  readonly initialMessageId?: string;
  readonly fetcher?: Fetcher;
}

export function MessageViewerView({
  tenantId,
  initialMessageId = "",
  fetcher = fetch,
}: MessageViewerViewProps): ReactElement {
  const [messageId, setMessageId] = useState(initialMessageId);
  const [detail, setDetail] = useState<MessageViewerDetail | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(
    async (id: string): Promise<void> => {
      const trimmed = id.trim();
      if (trimmed.length === 0) {
        setError("Enter a message id to view a message.");
        return;
      }
      setLoading(true);
      setError(null);
      try {
        setDetail(await readMessageDetail(tenantId, trimmed, fetcher));
      } catch (err) {
        setDetail(null);
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        setLoading(false);
      }
    },
    [tenantId, fetcher],
  );

  useEffect(() => {
    if (initialMessageId.trim().length > 0) {
      void load(initialMessageId);
    }
  }, [initialMessageId, load]);

  return (
    <div style={viewStyle} data-testid="message-viewer-view">
      <form
        style={formStyle}
        onSubmit={(event) => {
          event.preventDefault();
          void load(messageId);
        }}
      >
        <label style={labelStyle} htmlFor="message-viewer-id">
          Message id
        </label>
        <input
          id="message-viewer-id"
          data-testid="message-viewer-id-input"
          style={inputStyle}
          value={messageId}
          onChange={(event) => setMessageId(event.target.value)}
          placeholder="MessageTraceId or InternetMessageId"
        />
        <button type="submit" style={buttonStyle} data-testid="message-viewer-load">
          Load message
        </button>
      </form>

      <MessageViewer detail={detail} loading={loading} error={error} />
    </div>
  );
}

const viewStyle: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: "16px",
};

const formStyle: CSSProperties = {
  display: "flex",
  flexWrap: "wrap",
  alignItems: "flex-end",
  gap: "10px",
  padding: "16px",
  background: "var(--bg-elev)",
  border: "1px solid var(--border)",
  borderRadius: "var(--radius, 10px)",
};

const labelStyle: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: "4px",
  fontSize: "13px",
  color: "var(--text-soft)",
  flex: "1 1 320px",
};

const inputStyle: CSSProperties = {
  padding: "8px 10px",
  border: "1px solid var(--border)",
  borderRadius: "6px",
  background: "var(--surface)",
  color: "var(--text)",
  fontSize: "13px",
  fontFamily: "var(--font-mono, monospace)",
};

const buttonStyle: CSSProperties = {
  padding: "8px 14px",
  background: "var(--accent)",
  border: "1px solid var(--accent)",
  borderRadius: "6px",
  color: "var(--on-accent)",
  fontSize: "13px",
  fontWeight: 500,
  cursor: "pointer",
};

const pageStyle: CSSProperties = {
  padding: "24px",
  maxWidth: "1200px",
  margin: "0 auto",
  display: "flex",
  flexDirection: "column",
  gap: "20px",
};

export default function MessageViewerPage(): ReactElement {
  const searchParams = useSearchParams();
  const currentTenantId = useCurrentTenantId();
  const tenantId = resolveTenantId(searchParams.get("tenantId"), currentTenantId);
  const messageId = searchParams.get("messageId") ?? "";

  return (
    <RequireTenant tenantId={tenantId}>
      <div style={pageStyle}>
        <div>
          <div style={{ fontSize: "12px", color: "var(--text-soft)" }}>
            Tools &gt; Email Tools &gt; Message Viewer
          </div>
          <h1
            style={{
              fontSize: "24px",
              fontWeight: 700,
              margin: "4px 0 0",
              fontFamily: "var(--font-display, var(--font-sans))",
            }}
          >
            Message Viewer
          </h1>
          <p style={{ margin: "4px 0 0", color: "var(--text-soft)", fontSize: "14px" }}>
            Inspect a message's delivery timeline, connectors, filters hit, and headers. The
            body is shown only when your role permits it.
          </p>
        </div>
        <MessageViewerView tenantId={tenantId} initialMessageId={messageId} />
      </div>
    </RequireTenant>
  );
}
