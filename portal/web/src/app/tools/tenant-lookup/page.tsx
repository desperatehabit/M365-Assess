"use client";

// Tenant Lookup page (EPIC-040 SPEC.md §3.2; T-0785).
// Enter a domain or tenant ID → show tenant ID, name, default domain, verified
// domains, region, and an "in portal" chip. Zero colour literals: report theme
// tokens only.

import { useState, type CSSProperties, type FormEvent, type ReactElement } from "react";

export const TENANT_LOOKUP_API_PATH = "/v1/tenant-lookup";

export interface TenantLookupResult {
  readonly tenantId: string;
  readonly name: string;
  readonly defaultDomain: string;
  readonly verifiedDomains: readonly string[];
  readonly region: string;
  readonly inPortal: boolean;
}

export interface TenantLookupPageProps {
  readonly fetcher?: typeof fetch;
}

const pageContainerStyle: CSSProperties = {
  padding: "28px 40px",
  maxWidth: "1800px",
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
  color: "var(--text)",
};

const formStyle: CSSProperties = {
  display: "flex",
  gap: "8px",
  flexWrap: "wrap",
  alignItems: "center",
};

const inputStyle: CSSProperties = {
  padding: "8px 12px",
  background: "var(--input-bg, var(--bg))",
  border: "1px solid var(--border)",
  borderRadius: "6px",
  color: "var(--text)",
  fontSize: "14px",
  minWidth: "320px",
  fontFamily: "var(--font-mono, monospace)",
};

const primaryButtonStyle: CSSProperties = {
  padding: "8px 16px",
  background: "var(--accent)",
  color: "var(--on-accent)",
  border: "1px solid var(--accent)",
  borderRadius: "6px",
  fontSize: "14px",
  fontWeight: 500,
  cursor: "pointer",
};

const disabledButtonStyle: CSSProperties = {
  ...primaryButtonStyle,
  opacity: 0.5,
  cursor: "wait",
};

const errorStyle: CSSProperties = {
  padding: "12px 16px",
  background: "var(--danger-soft)",
  border: "1px solid var(--danger-border)",
  borderRadius: "6px",
  color: "var(--danger-text)",
  fontSize: "14px",
};

const cardStyle: CSSProperties = {
  background: "var(--bg-elev)",
  border: "1px solid var(--border)",
  borderRadius: "var(--radius, 10px)",
  boxShadow: "var(--shadow-card)",
  padding: "24px",
  maxWidth: "860px",
  display: "flex",
  flexDirection: "column",
  gap: "20px",
};

const fieldGridStyle: CSSProperties = {
  display: "grid",
  gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))",
  gap: "16px",
};

const fieldItemStyle: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: "4px",
};

const labelStyle: CSSProperties = {
  fontSize: "12px",
  fontWeight: 600,
  textTransform: "uppercase",
  letterSpacing: "0.08em",
  color: "var(--muted)",
  fontFamily: "var(--font-mono, monospace)",
};

const valueStyle: CSSProperties = {
  fontSize: "15px",
  fontWeight: 500,
  color: "var(--text)",
  fontFamily: "var(--font-mono, monospace)",
  overflowWrap: "anywhere",
};

const chipStyle: CSSProperties = {
  alignSelf: "flex-start",
  padding: "4px 12px",
  borderRadius: "999px",
  fontSize: "12px",
  fontWeight: 600,
  fontFamily: "var(--font-mono, monospace)",
  border: "1px solid",
};

function chipColors(inPortal: boolean): CSSProperties {
  return inPortal
    ? { color: "var(--success-text)", borderColor: "var(--success)", background: "var(--success-soft)" }
    : { color: "var(--muted)", borderColor: "var(--border)", background: "var(--chip)" };
}

export default function TenantLookupPage({ fetcher }: TenantLookupPageProps): ReactElement {
  const doFetch = fetcher ?? fetch;
  const [query, setQuery] = useState("");
  const [result, setResult] = useState<TenantLookupResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSubmit = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    const trimmed = query.trim();
    if (trimmed.length === 0) {
      setError("Enter a domain or tenant ID to look up.");
      return;
    }
    setLoading(true);
    setError(null);
    setResult(null);
    try {
      const response = await doFetch(
        `${TENANT_LOOKUP_API_PATH}?query=${encodeURIComponent(trimmed)}`,
      );
      if (!response.ok) {
        const body = (await response.json().catch(() => null)) as { message?: string } | null;
        throw new Error(body?.message ?? `Lookup failed: HTTP ${response.status}`);
      }
      setResult((await response.json()) as TenantLookupResult);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Lookup failed");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div style={pageContainerStyle} data-testid="tenant-lookup-page">
      <div style={breadcrumbStyle}>CIPP &rarr; Tools &rarr; Tenant Lookup</div>
      <h1 style={headingStyle}>Tenant Lookup</h1>

      <form onSubmit={handleSubmit} style={formStyle}>
        <input
          type="text"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Domain or tenant ID"
          aria-label="Domain or tenant ID"
          data-testid="tenant-lookup-input"
          style={inputStyle}
        />
        <button
          type="submit"
          style={loading ? disabledButtonStyle : primaryButtonStyle}
          disabled={loading}
          data-testid="tenant-lookup-submit"
        >
          {loading ? "Looking up…" : "Look up"}
        </button>
      </form>

      {error && (
        <div style={errorStyle} role="alert" data-testid="tenant-lookup-error">
          {error}
        </div>
      )}

      {result && (
        <div style={cardStyle} data-testid="tenant-lookup-result">
          <div style={fieldGridStyle}>
            <div style={fieldItemStyle} data-testid="field-tenant-id">
              <span style={labelStyle}>Tenant ID</span>
              <span style={valueStyle}>{result.tenantId}</span>
            </div>
            <div style={fieldItemStyle} data-testid="field-name">
              <span style={labelStyle}>Name</span>
              <span style={valueStyle}>{result.name}</span>
            </div>
            <div style={fieldItemStyle} data-testid="field-default-domain">
              <span style={labelStyle}>Default domain</span>
              <span style={valueStyle}>{result.defaultDomain}</span>
            </div>
            <div style={fieldItemStyle} data-testid="field-region">
              <span style={labelStyle}>Region</span>
              <span style={valueStyle}>{result.region}</span>
            </div>
            <div style={fieldItemStyle} data-testid="field-verified-domains">
              <span style={labelStyle}>Verified domains</span>
              <span style={valueStyle}>{result.verifiedDomains.join(", ")}</span>
            </div>
          </div>
          <span
            style={{ ...chipStyle, ...chipColors(result.inPortal) }}
            data-testid="tenant-lookup-in-portal"
          >
            {result.inPortal ? "In portal" : "Not in portal"}
          </span>
        </div>
      )}
    </div>
  );
}
