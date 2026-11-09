"use client";

// Shared breach-lookup view (EPIC-040 SPEC.md §3.4, §4.3, §9; T-0870).
// The BFF fails closed with `breach.integration_not_configured` until EPIC-041
// registers a provider, so the view renders that state clearly rather than a
// generic failure. Untrusted breach text is rendered as text only.

import React, { useState, type CSSProperties, type FormEvent, type ReactElement } from "react";

export const BREACH_LOOKUP_API_PATH = "/v1/breach-lookup";

export interface BreachMatch {
  readonly name: string;
  readonly title: string;
  readonly domain: string;
  readonly breachDate: string;
  readonly pwnCount: number;
  readonly dataClasses: readonly string[];
  readonly isVerified: boolean;
  readonly isSensitive: boolean;
}

export interface BreachLookupResult {
  readonly found: boolean;
  readonly breaches: readonly BreachMatch[];
  readonly source: string;
}

export interface BreachLookupViewProps {
  readonly fetcher?: typeof fetch;
  readonly tenantId?: string;
  readonly tenantOnly?: boolean;
}

const pageStyle: CSSProperties = {
  padding: "28px 40px",
  maxWidth: "1200px",
  color: "var(--text)",
  fontFamily: "var(--font-sans, system-ui, -apple-system, sans-serif)",
  display: "flex",
  flexDirection: "column",
  gap: "20px",
};

const headingStyle: CSSProperties = {
  fontSize: "24px",
  fontWeight: 700,
  margin: 0,
};

const subtitleStyle: CSSProperties = {
  margin: "4px 0 0",
  color: "var(--text-soft)",
  fontSize: "14px",
};

const formStyle: CSSProperties = {
  display: "flex",
  gap: "8px",
  flexWrap: "wrap",
  alignItems: "flex-end",
};

const fieldStyle: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: "4px",
};

const labelStyle: CSSProperties = {
  fontSize: "12px",
  fontWeight: 600,
  textTransform: "uppercase",
  letterSpacing: "0.06em",
  color: "var(--text-soft)",
};

const inputStyle: CSSProperties = {
  padding: "8px 12px",
  background: "var(--input-bg, var(--bg))",
  border: "1px solid var(--border)",
  borderRadius: "6px",
  color: "var(--text)",
  fontSize: "14px",
  minWidth: "260px",
};

const buttonStyle: CSSProperties = {
  padding: "8px 16px",
  background: "var(--accent)",
  color: "var(--on-accent)",
  border: "1px solid var(--accent)",
  borderRadius: "6px",
  fontSize: "14px",
  fontWeight: 500,
  cursor: "pointer",
};

const noticeStyle: CSSProperties = {
  padding: "12px 16px",
  background: "var(--accent-soft)",
  border: "1px solid var(--accent)",
  borderRadius: "6px",
  color: "var(--accent-text)",
  fontSize: "14px",
};

const errorStyle: CSSProperties = {
  ...noticeStyle,
  background: "var(--danger-soft)",
  borderColor: "var(--danger)",
  color: "var(--danger-text)",
};

const cardStyle: CSSProperties = {
  padding: "20px",
  background: "var(--bg-elev)",
  border: "1px solid var(--border)",
  borderRadius: "var(--radius, 10px)",
  boxShadow: "var(--shadow-card)",
};

const breachStyle: CSSProperties = {
  padding: "12px 0",
  borderBottom: "1px solid var(--border)",
};

export function BreachLookupView({
  fetcher,
  tenantId,
  tenantOnly = false,
}: BreachLookupViewProps): ReactElement {
  const doFetch = fetcher ?? fetch;
  const [account, setAccount] = useState("");
  const [tenant, setTenant] = useState(tenantId ?? "");
  const [result, setResult] = useState<BreachLookupResult | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const handleSubmit = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    const trimmedAccount = account.trim();
    const trimmedTenant = tenant.trim();
    if (!tenantOnly && trimmedAccount.length === 0 && trimmedTenant.length === 0) {
      setError("Enter an account or a tenant ID to query.");
      return;
    }
    if (tenantOnly && trimmedTenant.length === 0) {
      setError("Enter a tenant ID to query.");
      return;
    }
    setLoading(true);
    setError(null);
    setNotice(null);
    setResult(null);
    try {
      const response = await doFetch(BREACH_LOOKUP_API_PATH, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...(trimmedAccount.length > 0 ? { account: trimmedAccount } : {}),
          ...(trimmedTenant.length > 0 ? { tenantId: trimmedTenant } : {}),
        }),
      });
      const body = (await response.json().catch(() => null)) as
        | (BreachLookupResult & { code?: string; message?: string })
        | null;
      if (response.status === 501 || body?.code === "breach.integration_not_configured") {
        setNotice(
          "Breach lookup is not configured yet. The breach data source is deferred to the integrations epic.",
        );
        return;
      }
      if (!response.ok) {
        throw new Error(body?.message ?? `Breach lookup failed: HTTP ${response.status}`);
      }
      setResult(body as BreachLookupResult);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Breach lookup failed");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div style={pageStyle} data-testid="breach-lookup-page">
      <div>
        <h1 style={headingStyle}>{tenantOnly ? "Tenant Breach Lookup" : "Breach Lookup"}</h1>
        <p style={subtitleStyle}>
          Query an account or tenant against the configured breach data source. Every query is
          admin-gated and audited; the subject is pseudonymised in the audit trail.
        </p>
      </div>

      <form onSubmit={handleSubmit} style={formStyle}>
        {!tenantOnly && (
          <div style={fieldStyle}>
            <label style={labelStyle} htmlFor="breach-account">
              Account
            </label>
            <input
              id="breach-account"
              type="text"
              value={account}
              onChange={(event) => setAccount(event.target.value)}
              placeholder="user@example.com"
              style={inputStyle}
              data-testid="breach-account"
            />
          </div>
        )}
        <div style={fieldStyle}>
          <label style={labelStyle} htmlFor="breach-tenant">
            Tenant ID
          </label>
          <input
            id="breach-tenant"
            type="text"
            value={tenant}
            onChange={(event) => setTenant(event.target.value)}
            placeholder="00000000-0000-0000-0000-000000000000"
            style={inputStyle}
            data-testid="breach-tenant"
          />
        </div>
        <button type="submit" style={buttonStyle} disabled={loading} data-testid="breach-submit">
          {loading ? "Querying…" : "Query"}
        </button>
      </form>

      {notice && (
        <div style={noticeStyle} role="status" data-testid="breach-notice">
          {notice}
        </div>
      )}
      {error && (
        <div style={errorStyle} role="alert" data-testid="breach-error">
          {error}
        </div>
      )}

      {result && (
        <div style={cardStyle} data-testid="breach-result">
          {result.found ? (
            <div>
              <p style={{ margin: "0 0 8px", fontWeight: 600 }}>
                {result.breaches.length} breach match(es) from {result.source}
              </p>
              {result.breaches.map((breach) => (
                <div key={breach.name} style={breachStyle} data-testid={`breach-${breach.name}`}>
                  <strong>{breach.title}</strong>
                  <div style={{ color: "var(--text-soft)", fontSize: "13px" }}>
                    {breach.breachDate} · {breach.domain} · {breach.pwnCount} accounts
                  </div>
                  <div style={{ color: "var(--text-soft)", fontSize: "13px" }}>
                    {breach.dataClasses.join(", ")}
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <p style={{ margin: 0 }}>No breaches were reported for this query.</p>
          )}
        </div>
      )}
    </div>
  );
}
