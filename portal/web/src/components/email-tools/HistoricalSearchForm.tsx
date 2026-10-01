"use client";

// Historical search filter form (EPIC-024 SPEC.md §2 US-2, §3.2; T-0466).
// The §3.2 scoped search parameters (KQL query, mailboxes, date range, top)
// over the T-0465 POST /v1/tenants/:id/mail/historical-search input. The
// form holds the field state and hands the assembled input to the page on
// submit; it never fetches. The query is required by the API, so the submit
// button stays disabled until one is entered. Strictly uses report theme
// tokens with zero colour literals.

import React, { useState, type CSSProperties, type ReactElement } from "react";

export interface HistoricalSearchInput {
  readonly query: string;
  readonly mailboxes?: readonly string[];
  readonly startDate?: string;
  readonly endDate?: string;
  readonly top?: number;
}

export interface HistoricalSearchFormProps {
  readonly busy?: boolean;
  readonly onSubmit: (input: HistoricalSearchInput) => void;
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

function optionalMailboxes(value: string): readonly string[] | undefined {
  const mailboxes = value
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
  return mailboxes.length > 0 ? mailboxes : undefined;
}

function optionalDate(value: string): string | undefined {
  const trimmed = value.trim();
  if (trimmed.length === 0) return undefined;
  const parsed = new Date(trimmed);
  return Number.isNaN(parsed.getTime()) ? undefined : parsed.toISOString();
}

function optionalTop(value: string): number | undefined {
  const trimmed = value.trim();
  if (trimmed.length === 0) return undefined;
  const parsed = Number(trimmed);
  return Number.isFinite(parsed) && parsed >= 1 ? Math.floor(parsed) : undefined;
}

export function HistoricalSearchForm({
  busy = false,
  onSubmit,
}: HistoricalSearchFormProps): ReactElement {
  const [query, setQuery] = useState("");
  const [mailboxes, setMailboxes] = useState("");
  const [startDate, setStartDate] = useState("");
  const [endDate, setEndDate] = useState("");
  const [top, setTop] = useState("");

  const canSubmit = query.trim().length > 0;

  function handleSubmit(event: React.FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    onSubmit({
      query: query.trim(),
      mailboxes: optionalMailboxes(mailboxes),
      startDate: optionalDate(startDate),
      endDate: optionalDate(endDate),
      top: optionalTop(top),
    });
  }

  return (
    <form style={formStyle} onSubmit={handleSubmit} data-testid="historical-search-form">
      <div style={fieldStyle}>
        <label htmlFor="historical-search-query" style={fieldLabelStyle}>
          Query (KQL)
        </label>
        <input
          id="historical-search-query"
          style={inputStyle}
          type="text"
          placeholder="subject:invoice AND from:vendor@example.com"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          aria-label="KQL query"
          data-testid="historical-search-filter-query"
        />
      </div>

      <div style={fieldStyle}>
        <label htmlFor="historical-search-mailboxes" style={fieldLabelStyle}>
          Mailboxes
        </label>
        <input
          id="historical-search-mailboxes"
          style={inputStyle}
          type="text"
          placeholder="mailbox-a@example.com, mailbox-b@example.com"
          value={mailboxes}
          onChange={(event) => setMailboxes(event.target.value)}
          aria-label="Mailboxes (comma separated)"
          data-testid="historical-search-filter-mailboxes"
        />
      </div>

      <div style={fieldStyle}>
        <label htmlFor="historical-search-start-date" style={fieldLabelStyle}>
          Start date
        </label>
        <input
          id="historical-search-start-date"
          style={inputStyle}
          type="datetime-local"
          value={startDate}
          onChange={(event) => setStartDate(event.target.value)}
          aria-label="Search window start"
          data-testid="historical-search-filter-start-date"
        />
      </div>

      <div style={fieldStyle}>
        <label htmlFor="historical-search-end-date" style={fieldLabelStyle}>
          End date
        </label>
        <input
          id="historical-search-end-date"
          style={inputStyle}
          type="datetime-local"
          value={endDate}
          onChange={(event) => setEndDate(event.target.value)}
          aria-label="Search window end"
          data-testid="historical-search-filter-end-date"
        />
      </div>

      <div style={fieldStyle}>
        <label htmlFor="historical-search-top" style={fieldLabelStyle}>
          Top results
        </label>
        <input
          id="historical-search-top"
          style={inputStyle}
          type="number"
          min={1}
          max={1000}
          placeholder="100"
          value={top}
          onChange={(event) => setTop(event.target.value)}
          aria-label="Maximum matches to return"
          data-testid="historical-search-filter-top"
        />
      </div>

      <div style={{ ...fieldStyle, justifyContent: "flex-end" }}>
        <button
          type="submit"
          style={busy || !canSubmit ? { ...submitStyle, ...disabledStyle } : submitStyle}
          disabled={busy || !canSubmit}
          data-testid="historical-search-submit"
        >
          Search
        </button>
      </div>
    </form>
  );
}
