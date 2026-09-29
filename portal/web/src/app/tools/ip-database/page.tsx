"use client";

// IP Database page (EPIC-040 SPEC.md §3.5; T-0787).
// Looks an IP up in the offline GeoIP database via GET /v1/geoip/{ip} and
// renders the returned fields. Strictly uses report theme tokens with zero
// colour literals.

import React, { useState, type CSSProperties, type ReactElement } from "react";

export const GEOIP_API_PATH = "/v1/geoip";

export interface GeoIpLookupResult {
  readonly ip: string;
  readonly version: number;
  readonly country: string;
  readonly countryName: string;
  readonly region: string;
  readonly city: string;
  readonly latitude: number;
  readonly longitude: number;
  readonly isp: string;
  readonly organization: string;
  readonly source: "database" | "cache";
}

interface GeoIpErrorBody {
  readonly code?: string;
  readonly message?: string;
}

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

const cardStyle: CSSProperties = {
  background: "var(--bg-elev)",
  border: "1px solid var(--border)",
  borderRadius: "var(--radius, 10px)",
  padding: "24px",
  boxShadow: "var(--shadow-card)",
};

const gridStyle: CSSProperties = {
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
  fontVariantNumeric: "tabular-nums",
  overflowWrap: "anywhere",
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

function displayValue(value: string | number | undefined): string {
  if (value === undefined || value === "") return "—";
  return String(value);
}

export default function IpDatabasePage(): ReactElement {
  const [ip, setIp] = useState("");
  const [result, setResult] = useState<GeoIpLookupResult | null>(null);
  const [loading, setLoading] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);

  const handleLookup = async (): Promise<void> => {
    const trimmed = ip.trim();
    if (trimmed.length === 0) {
      setError("Enter an IP address to look up.");
      return;
    }
    setLoading(true);
    setError(null);
    setResult(null);
    try {
      const response = await fetch(`${GEOIP_API_PATH}/${encodeURIComponent(trimmed)}`);
      const body = (await response.json()) as GeoIpLookupResult | GeoIpErrorBody;
      if (!response.ok) {
        const errorBody = body as GeoIpErrorBody;
        throw new Error(errorBody.message || `Lookup failed (HTTP ${response.status})`);
      }
      setResult(body as GeoIpLookupResult);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Lookup failed");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div style={pageContainerStyle} data-testid="ip-database-page">
      <div style={breadcrumbStyle}>CIPP &rarr; Tools &rarr; Tenant Tools &rarr; IP Database</div>
      <h1 style={headingStyle}>IP Database</h1>
      <p style={subtitleStyle}>
        Look up GeoIP details for an IP address from the offline database.
      </p>

      <div style={formStyle}>
        <input
          type="text"
          placeholder="IP address (e.g. 8.8.8.8)"
          value={ip}
          onChange={(e) => setIp(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") void handleLookup();
          }}
          style={inputStyle}
          aria-label="IP address"
          data-testid="ip-database-input"
        />
        <button
          type="button"
          style={buttonStyle}
          onClick={() => void handleLookup()}
          disabled={loading}
          data-testid="ip-database-lookup-button"
        >
          {loading ? "Looking up…" : "Lookup"}
        </button>
      </div>

      {error !== null && (
        <div style={errorStyle} data-testid="ip-database-error" role="alert">
          {error}
        </div>
      )}

      {loading && <div style={loadingStyle} data-testid="ip-database-loading">Looking up…</div>}

      {result !== null && (
        <div style={cardStyle} data-testid="ip-database-results">
          <div style={gridStyle}>
            <div style={fieldItemStyle} data-testid="field-ip">
              <span style={labelStyle}>IP</span>
              <span style={valueStyle}>{result.ip}</span>
            </div>
            <div style={fieldItemStyle} data-testid="field-version">
              <span style={labelStyle}>Version</span>
              <span style={valueStyle}>IPv{result.version}</span>
            </div>
            <div style={fieldItemStyle} data-testid="field-country">
              <span style={labelStyle}>Country</span>
              <span style={valueStyle}>
                {result.country} — {result.countryName}
              </span>
            </div>
            <div style={fieldItemStyle} data-testid="field-region">
              <span style={labelStyle}>Region</span>
              <span style={valueStyle}>{displayValue(result.region)}</span>
            </div>
            <div style={fieldItemStyle} data-testid="field-city">
              <span style={labelStyle}>City</span>
              <span style={valueStyle}>{displayValue(result.city)}</span>
            </div>
            <div style={fieldItemStyle} data-testid="field-coordinates">
              <span style={labelStyle}>Coordinates</span>
              <span style={valueStyle}>
                {result.latitude}, {result.longitude}
              </span>
            </div>
            <div style={fieldItemStyle} data-testid="field-isp">
              <span style={labelStyle}>ISP</span>
              <span style={valueStyle}>{displayValue(result.isp)}</span>
            </div>
            <div style={fieldItemStyle} data-testid="field-organization">
              <span style={labelStyle}>Organization</span>
              <span style={valueStyle}>{displayValue(result.organization)}</span>
            </div>
            <div style={fieldItemStyle} data-testid="field-source">
              <span style={labelStyle}>Source</span>
              <span style={valueStyle}>{result.source}</span>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
