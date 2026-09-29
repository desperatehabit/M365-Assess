"use client";

// Domain Check page (EPIC-040 SPEC.md §3.5; T-0787).
// Runs an individual DNS check for a domain. The check is served by the
// shared EPIC-034 domain-check service; until that service is wired, the BFF
// answers 501 and this page reports the check as not yet available rather
// than shipping a second DNS resolver. Strictly uses report theme tokens
// with zero colour literals.

import React, { useState, type CSSProperties, type ReactElement } from "react";

export const DOMAIN_CHECK_API_PATH = "/v1/domain-check";
export const DOMAIN_CHECK_UNAVAILABLE_CODE = "domain_check.unavailable";

const pageContainerStyle: CSSProperties = {
  padding: "28px 40px",
  maxWidth: "1200px",
  color: "var(--text)",
  fontFamily: "var(--font-sans, system-ui, -apple-system, sans-serif)",
  display: "flex",
  flexDirection: "column",
  gap: "20px",
};

const breadcrumbStyle: CSSProperties = {
  fontSize: "12px",
  fontWeight: 600,
  letterSpacing: "0.08em",
  textTransform: "uppercase",
  color: "var(--muted)",
  fontFamily: "var(--font-mono, monospace)",
};

const headingStyle: CSSProperties = {
  fontSize: "24px",
  fontWeight: 700,
  margin: 0,
  fontFamily: "var(--font-display, var(--font-sans))",
};

const subtitleStyle: CSSProperties = {
  margin: "4px 0 0",
  color: "var(--muted)",
  fontSize: "14px",
};

const formStyle: CSSProperties = {
  display: "flex",
  gap: "10px",
  alignItems: "center",
  flexWrap: "wrap",
};

const inputStyle: CSSProperties = {
  padding: "8px 12px",
  background: "var(--input-bg, var(--bg))",
  border: "1px solid var(--border)",
  borderRadius: "6px",
  color: "var(--text)",
  fontSize: "14px",
  fontFamily: "var(--font-mono, monospace)",
  minWidth: "260px",
};

const buttonStyle: CSSProperties = {
  padding: "8px 16px",
  background: "var(--surface)",
  border: "1px solid var(--border)",
  borderRadius: "6px",
  color: "var(--text)",
  fontSize: "14px",
  fontWeight: 600,
  cursor: "pointer",
};

const panelStyle: CSSProperties = {
  background: "var(--bg-elev)",
  border: "1px solid var(--border)",
  borderRadius: "var(--radius, 10px)",
  padding: "24px",
  boxShadow: "var(--shadow-card)",
};

const panelTitleStyle: CSSProperties = {
  fontSize: "16px",
  fontWeight: 600,
  margin: "0 0 12px",
  color: "var(--text)",
};

const panelBodyStyle: CSSProperties = {
  fontSize: "14px",
  color: "var(--muted)",
  fontFamily: "var(--font-mono, monospace)",
  overflowWrap: "anywhere",
  whiteSpace: "pre-wrap",
};

const errorStyle: CSSProperties = {
  padding: "16px",
  background: "var(--danger-soft)",
  border: "1px solid var(--border)",
  borderRadius: "6px",
  color: "var(--danger-text)",
  fontSize: "14px",
  fontFamily: "var(--font-mono, monospace)",
  overflowWrap: "anywhere",
};

const loadingStyle: CSSProperties = {
  padding: "16px",
  color: "var(--muted)",
  fontSize: "14px",
  fontFamily: "var(--font-mono, monospace)",
};

type CheckState =
  | { readonly kind: "idle" }
  | { readonly kind: "loading" }
  | { readonly kind: "unavailable"; readonly message: string }
  | { readonly kind: "results"; readonly payload: Record<string, unknown> }
  | { readonly kind: "error"; readonly message: string };

export default function DomainCheckPage(): ReactElement {
  const [domain, setDomain] = useState("");
  const [state, setState] = useState<CheckState>({ kind: "idle" });

  const handleCheck = async (): Promise<void> => {
    const trimmed = domain.trim();
    if (trimmed.length === 0) {
      setState({ kind: "error", message: "Enter a domain to check." });
      return;
    }
    setState({ kind: "loading" });
    try {
      const response = await fetch(
        `${DOMAIN_CHECK_API_PATH}?domain=${encodeURIComponent(trimmed)}`,
      );
      if (response.status === 501) {
        const body = (await response.json().catch(() => null)) as {
          code?: string;
          message?: string;
        } | null;
        if (body?.code === DOMAIN_CHECK_UNAVAILABLE_CODE) {
          setState({
            kind: "unavailable",
            message: body.message ?? "Domain check is not yet available.",
          });
          return;
        }
      }
      if (!response.ok) {
        const body = (await response.json().catch(() => null)) as { message?: string } | null;
        throw new Error(body?.message || `Domain check failed (HTTP ${response.status})`);
      }
      const payload = (await response.json()) as Record<string, unknown>;
      setState({ kind: "results", payload });
    } catch (err) {
      setState({
        kind: "error",
        message: err instanceof Error ? err.message : "Domain check failed",
      });
    }
  };

  return (
    <div style={pageContainerStyle} data-testid="domain-check-page">
      <div style={breadcrumbStyle}>CIPP &rarr; Tools &rarr; Tenant Tools &rarr; Domain Check</div>
      <h1 style={headingStyle}>Domain Check</h1>
      <p style={subtitleStyle}>
        Run an individual DNS check for a domain (MX, SPF, DKIM, DMARC, MTA-STS, TLS-RPT).
      </p>

      <div style={formStyle}>
        <input
          type="text"
          placeholder="Domain (e.g. example.com)"
          value={domain}
          onChange={(e) => setDomain(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") void handleCheck();
          }}
          style={inputStyle}
          aria-label="Domain"
          data-testid="domain-check-input"
        />
        <button
          type="button"
          style={buttonStyle}
          onClick={() => void handleCheck()}
          disabled={state.kind === "loading"}
          data-testid="domain-check-button"
        >
          {state.kind === "loading" ? "Checking…" : "Check"}
        </button>
      </div>

      {state.kind === "loading" && (
        <div style={loadingStyle} data-testid="domain-check-loading">
          Checking…
        </div>
      )}

      {state.kind === "unavailable" && (
        <div style={panelStyle} data-testid="domain-check-unavailable">
          <h2 style={panelTitleStyle}>Not yet available</h2>
          <div style={panelBodyStyle}>{state.message}</div>
        </div>
      )}

      {state.kind === "results" && (
        <div style={panelStyle} data-testid="domain-check-results">
          <h2 style={panelTitleStyle}>Results</h2>
          <div style={panelBodyStyle}>{JSON.stringify(state.payload, null, 2)}</div>
        </div>
      )}

      {state.kind === "error" && (
        <div style={errorStyle} data-testid="domain-check-error" role="alert">
          {state.message}
        </div>
      )}
    </div>
  );
}
