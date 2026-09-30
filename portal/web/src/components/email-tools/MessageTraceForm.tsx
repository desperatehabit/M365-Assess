"use client";

// Message trace filter form (EPIC-024 SPEC.md §2 US-1, §3.1; T-0463).
// The §3.1 filter fields (sender, recipient, subject, date range, status)
// over the T-0462 trace query. The form holds the field state and hands the
// assembled filter to the page on submit; it never fetches. Strictly uses
// report theme tokens with zero colour literals.

import React, { useState, type CSSProperties, type ReactElement } from "react";

export interface MessageTraceFilter {
  readonly sender?: string;
  readonly recipient?: string;
  readonly subject?: string;
  readonly status?: string;
  readonly startDate?: string;
  readonly endDate?: string;
}

export interface MessageTraceFormProps {
  readonly busy?: boolean;
  readonly onSubmit: (filter: MessageTraceFilter) => void;
}

const formStyle: CSSProperties = {
  display: "grid",
  gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))",
  gap: "10px",
  padding: "16px",
  background: "var(--bg-elev)",
  border: "1px solid var(--border)",
  borderRadius: "var(--radius, 10px)",
};

const fieldStyle: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: "4px",
};

const fieldLabelStyle: CSSProperties = {
  fontSize: "12px",
  fontWeight: 600,
  color: "var(--text-soft)",
};

const inputStyle: CSSProperties = {
  padding: "8px 10px",
  background: "var(--input-bg, var(--bg))",
  border: "1px solid var(--border)",
  borderRadius: "6px",
  color: "var(--text)",
  fontSize: "13px",
  fontFamily: "inherit",
};

const submitStyle: CSSProperties = {
  padding: "8px 14px",
  background: "var(--accent)",
  border: "1px solid var(--accent)",
  borderRadius: "6px",
  color: "var(--on-accent)",
  fontSize: "13px",
  fontWeight: 500,
  cursor: "pointer",
};

const disabledStyle: CSSProperties = { opacity: 0.45, cursor: "not-allowed" };

function optionalText(value: string): string | undefined {
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function optionalDate(value: string): string | undefined {
  const trimmed = value.trim();
  if (trimmed.length === 0) return undefined;
  const parsed = new Date(trimmed);
  return Number.isNaN(parsed.getTime()) ? undefined : parsed.toISOString();
}

export function MessageTraceForm({ busy = false, onSubmit }: MessageTraceFormProps): ReactElement {
  const [sender, setSender] = useState("");
  const [recipient, setRecipient] = useState("");
  const [subject, setSubject] = useState("");
  const [status, setStatus] = useState("");
  const [startDate, setStartDate] = useState("");
  const [endDate, setEndDate] = useState("");

  function handleSubmit(event: React.FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    onSubmit({
      sender: optionalText(sender),
      recipient: optionalText(recipient),
      subject: optionalText(subject),
      status: optionalText(status),
      startDate: optionalDate(startDate),
      endDate: optionalDate(endDate),
    });
  }

  return (
    <form style={formStyle} onSubmit={handleSubmit} data-testid="message-trace-form">
      <div style={fieldStyle}>
        <label htmlFor="message-trace-sender" style={fieldLabelStyle}>
          Sender
        </label>
        <input
          id="message-trace-sender"
          style={inputStyle}
          type="text"
          placeholder="sender@example.com"
          value={sender}
          onChange={(event) => setSender(event.target.value)}
          aria-label="Filter by sender"
          data-testid="message-trace-filter-sender"
        />
      </div>

      <div style={fieldStyle}>
        <label htmlFor="message-trace-recipient" style={fieldLabelStyle}>
          Recipient
        </label>
        <input
          id="message-trace-recipient"
          style={inputStyle}
          type="text"
          placeholder="recipient@example.com"
          value={recipient}
          onChange={(event) => setRecipient(event.target.value)}
          aria-label="Filter by recipient"
          data-testid="message-trace-filter-recipient"
        />
      </div>

      <div style={fieldStyle}>
        <label htmlFor="message-trace-subject" style={fieldLabelStyle}>
          Subject
        </label>
        <input
          id="message-trace-subject"
          style={inputStyle}
          type="text"
          placeholder="Subject contains…"
          value={subject}
          onChange={(event) => setSubject(event.target.value)}
          aria-label="Filter by subject"
          data-testid="message-trace-filter-subject"
        />
      </div>

      <div style={fieldStyle}>
        <label htmlFor="message-trace-status" style={fieldLabelStyle}>
          Status
        </label>
        <input
          id="message-trace-status"
          style={inputStyle}
          type="text"
          placeholder="Delivered, Failed, Pending…"
          value={status}
          onChange={(event) => setStatus(event.target.value)}
          aria-label="Filter by status"
          data-testid="message-trace-filter-status"
        />
      </div>

      <div style={fieldStyle}>
        <label htmlFor="message-trace-start-date" style={fieldLabelStyle}>
          Start date
        </label>
        <input
          id="message-trace-start-date"
          style={inputStyle}
          type="datetime-local"
          value={startDate}
          onChange={(event) => setStartDate(event.target.value)}
          aria-label="Trace window start"
          data-testid="message-trace-filter-start-date"
        />
      </div>

      <div style={fieldStyle}>
        <label htmlFor="message-trace-end-date" style={fieldLabelStyle}>
          End date
        </label>
        <input
          id="message-trace-end-date"
          style={inputStyle}
          type="datetime-local"
          value={endDate}
          onChange={(event) => setEndDate(event.target.value)}
          aria-label="Trace window end"
          data-testid="message-trace-filter-end-date"
        />
      </div>

      <div style={{ ...fieldStyle, justifyContent: "flex-end" }}>
        <button
          type="submit"
          style={busy ? { ...submitStyle, ...disabledStyle } : submitStyle}
          disabled={busy}
          data-testid="message-trace-submit"
        >
          Trace
        </button>
      </div>
    </form>
  );
}
