"use client";

// Message viewer (EPIC-024 SPEC.md §2 US-3, §3.3, §4.1; T-0464).
// Read-only view over a trace/search result: delivery timeline (events,
// connectors, filters hit) plus headers. The body renders only when the
// payload carries it; a gated payload shows the gate notice instead — the
// component never fetches and never edits. Strictly uses report theme tokens
// with zero colour literals.

import React, { type CSSProperties, type ReactElement } from "react";

export interface MessageViewerEvent {
  readonly timestamp: string;
  readonly event: string;
  readonly detail: string;
}

export interface MessageViewerHeader {
  readonly name: string;
  readonly value: string;
}

export interface MessageViewerDetail {
  readonly messageId: string;
  readonly subject: string;
  readonly sender: string;
  readonly recipients: readonly string[];
  readonly receivedAt: string;
  readonly status: string;
  readonly size: string;
  readonly deliveryEvents: readonly MessageViewerEvent[];
  readonly connectors: readonly string[];
  readonly filtersHit: readonly string[];
  readonly headers: readonly MessageViewerHeader[];
  readonly body: string | null;
  readonly bodyGated: boolean;
  readonly bodyGateReason: string;
}

export interface MessageViewerProps {
  readonly detail?: MessageViewerDetail | null;
  readonly loading?: boolean;
  readonly error?: string | null;
}

const containerStyle: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: "12px",
  fontFamily: "var(--font-sans, system-ui, sans-serif)",
  color: "var(--text)",
};

const sectionStyle: CSSProperties = {
  background: "var(--bg-elev)",
  border: "1px solid var(--border)",
  borderRadius: "var(--radius, 10px)",
  padding: "16px",
  display: "flex",
  flexDirection: "column",
  gap: "8px",
};

const sectionTitleStyle: CSSProperties = {
  fontSize: "13px",
  fontWeight: 600,
  margin: 0,
};

const listStyle: CSSProperties = {
  margin: 0,
  paddingLeft: "18px",
  fontSize: "13px",
  display: "flex",
  flexDirection: "column",
  gap: "4px",
};

const monoStyle: CSSProperties = {
  fontFamily: "var(--font-mono, monospace)",
  fontSize: "12px",
  background: "var(--surface)",
  border: "1px solid var(--border)",
  borderRadius: "6px",
  padding: "8px 12px",
  overflowX: "auto",
  whiteSpace: "pre-wrap",
  wordBreak: "break-word",
};

const metaStyle: CSSProperties = {
  fontSize: "13px",
  margin: 0,
};

function Section({ title, testId, children }: { title: string; testId: string; children: React.ReactNode }): ReactElement {
  return (
    <section style={sectionStyle} data-testid={testId}>
      <h3 style={sectionTitleStyle}>{title}</h3>
      {children}
    </section>
  );
}

export function MessageViewer({ detail, loading, error }: MessageViewerProps): ReactElement {
  if (loading === true) {
    return (
      <div style={containerStyle} data-testid="message-viewer-loading">
        Loading message detail…
      </div>
    );
  }

  if (typeof error === "string" && error.length > 0) {
    return (
      <div style={containerStyle} data-testid="message-viewer-error">
        {error}
      </div>
    );
  }

  if (detail === undefined || detail === null) {
    return (
      <div style={containerStyle} data-testid="message-viewer-empty">
        Select a trace or search result to view the message.
      </div>
    );
  }

  return (
    <div style={containerStyle} data-testid="message-viewer">
      <Section title="Message" testId="message-summary">
        <p style={metaStyle} data-testid="message-subject">
          {detail.subject}
        </p>
        <p style={metaStyle} data-testid="message-meta">
          {detail.sender} → {detail.recipients.join(", ")} · {detail.status} · {detail.size} ·{" "}
          {detail.receivedAt}
        </p>
      </Section>

      <Section title="Delivery timeline" testId="delivery-timeline">
        {detail.deliveryEvents.length === 0 ? (
          <p style={metaStyle} data-testid="delivery-timeline-empty">
            No delivery events were returned for this message.
          </p>
        ) : (
          <ol style={listStyle} data-testid="delivery-events">
            {detail.deliveryEvents.map((item, index) => (
              <li key={`${item.event}-${index}`} data-testid={`delivery-event-${index}`}>
                <span data-testid={`delivery-event-name-${index}`}>{item.event}</span>{" "}
                <span data-testid={`delivery-event-time-${index}`}>{item.timestamp}</span>
                {item.detail.length > 0 ? <span> — {item.detail}</span> : null}
              </li>
            ))}
          </ol>
        )}
      </Section>

      <Section title="Connectors" testId="message-connectors">
        {detail.connectors.length === 0 ? (
          <p style={metaStyle} data-testid="message-connectors-empty">
            No connectors were recorded for this message.
          </p>
        ) : (
          <ul style={listStyle} data-testid="message-connectors-list">
            {detail.connectors.map((connector) => (
              <li key={connector} data-testid="message-connector">
                {connector}
              </li>
            ))}
          </ul>
        )}
      </Section>

      <Section title="Filters hit" testId="message-filters">
        {detail.filtersHit.length === 0 ? (
          <p style={metaStyle} data-testid="message-filters-empty">
            No transport or protection filters were hit.
          </p>
        ) : (
          <ul style={listStyle} data-testid="message-filters-list">
            {detail.filtersHit.map((filter) => (
              <li key={filter} data-testid="message-filter">
                {filter}
              </li>
            ))}
          </ul>
        )}
      </Section>

      <Section title="Headers" testId="message-headers">
        {detail.headers.length === 0 ? (
          <p style={metaStyle} data-testid="message-headers-empty">
            No headers were returned for this message.
          </p>
        ) : (
          <div style={monoStyle} data-testid="message-headers-list">
            {detail.headers.map((header) => (
              <div key={header.name} data-testid="message-header">
                {header.name}: {header.value}
              </div>
            ))}
          </div>
        )}
      </Section>

      <Section title="Body" testId="message-body-section">
        {detail.bodyGated || detail.body === null ? (
          <p style={metaStyle} data-testid="message-body-gated">
            {detail.bodyGateReason.length > 0
              ? detail.bodyGateReason
              : "The message body is gated for this caller."}
          </p>
        ) : (
          <div style={monoStyle} data-testid="message-body">
            {detail.body}
          </div>
        )}
      </Section>
    </div>
  );
}
