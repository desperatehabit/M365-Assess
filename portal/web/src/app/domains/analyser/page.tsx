"use client";

// Domain Analyser page (EPIC-034 SPEC.md §3.2, §3.3, §3.4; T-0669).
// Per-domain DNS panel (MX/SPF/DKIM/DMARC/MTA-STS/TLS-RPT), the ranked
// recommendations list, and the stored-check history chart. Reads the T-0665
// check/history and T-0666 recommendations endpoints; "Run analysis" posts to
// check-dns. The T-0668 domainsApi client is not in this ticket's scope, so the
// typed calls live here. Report theme tokens only (zero colour literals).

import React, { useCallback, useEffect, useState, type CSSProperties, type ReactElement } from "react";
import { useSearchParams } from "next/navigation";
import { DnsPanel } from "../../../components/domains/DnsPanel";
import {
  DnsRecommendations,
  type DnsRecommendation,
} from "../../../components/domains/DnsRecommendations";
import { DnsHistoryChart, type DnsHistoryCheck } from "../../../components/domains/DnsHistoryChart";

interface DomainCheckPayload {
  readonly id: string;
  readonly at: string;
  readonly records: Record<string, unknown>;
  readonly health: Record<string, unknown>;
}

async function readJson<T>(response: Response, what: string): Promise<T> {
  if (!response.ok) {
    let detail = response.statusText;
    try {
      const body = (await response.json()) as { message?: string };
      if (body?.message) detail = body.message;
    } catch {
      // non-JSON error body; keep the status text
    }
    throw new Error(`${what} failed: ${response.status} ${detail}`);
  }
  return (await response.json()) as T;
}

export async function fetchDomainHistory(
  tenantId: string,
  domain: string,
  fetcher: typeof fetch = fetch,
): Promise<readonly DomainCheckPayload[]> {
  const response = await fetcher(
    `/v1/tenants/${encodeURIComponent(tenantId)}/domains/${encodeURIComponent(domain)}/history`,
  );
  const body = await readJson<{ items?: DomainCheckPayload[] }>(response, "Load DNS history");
  return body.items ?? [];
}

export async function fetchDomainRecommendations(
  tenantId: string,
  domain: string,
  fetcher: typeof fetch = fetch,
): Promise<readonly DnsRecommendation[]> {
  const response = await fetcher(
    `/v1/tenants/${encodeURIComponent(tenantId)}/domains/${encodeURIComponent(domain)}/recommendations`,
  );
  const body = await readJson<{ recommendations?: DnsRecommendation[] }>(
    response,
    "Load DNS recommendations",
  );
  return body.recommendations ?? [];
}

export async function runDomainAnalysis(
  tenantId: string,
  domain: string,
  fetcher: typeof fetch = fetch,
): Promise<DomainCheckPayload> {
  const response = await fetcher(
    `/v1/tenants/${encodeURIComponent(tenantId)}/domains/${encodeURIComponent(domain)}/check-dns`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    },
  );
  const body = await readJson<{ check: DomainCheckPayload }>(response, "Run DNS analysis");
  return body.check;
}

const pageStyle: CSSProperties = {
  padding: "32px",
  maxWidth: "1400px",
  margin: "0 auto",
  fontFamily: "var(--font-sans, system-ui, sans-serif)",
  color: "var(--text)",
  display: "flex",
  flexDirection: "column",
  gap: "24px",
};

const headerStyle: CSSProperties = {
  display: "flex",
  justifyContent: "space-between",
  alignItems: "center",
  gap: "16px",
  borderBottom: "1px solid var(--border)",
  paddingBottom: "16px",
};

const titleStyle: CSSProperties = {
  fontSize: "24px",
  fontWeight: 700,
  margin: 0,
  fontFamily: "var(--font-display, var(--font-sans))",
};

const subtitleStyle: CSSProperties = {
  margin: "4px 0 0",
  color: "var(--text-soft)",
  fontSize: "14px",
};

const buttonStyle: CSSProperties = {
  padding: "10px 18px",
  background: "var(--accent)",
  color: "var(--on-accent)",
  border: "1px solid var(--accent)",
  borderRadius: "6px",
  fontWeight: 600,
  fontSize: "14px",
  cursor: "pointer",
};

const errorStyle: CSSProperties = {
  padding: "12px 16px",
  background: "var(--danger-soft)",
  border: "1px solid var(--danger)",
  borderRadius: "6px",
  color: "var(--danger-text)",
  fontSize: "14px",
};

const emptyStyle: CSSProperties = {
  padding: "48px 16px",
  textAlign: "center",
  color: "var(--text-soft)",
};

export default function DomainAnalyserPage(): ReactElement {
  const searchParams = useSearchParams();
  const domain = (searchParams.get("domain") ?? "").trim();
  const tenantId = (searchParams.get("tenantId") ?? "current").trim();

  const [history, setHistory] = useState<readonly DnsHistoryCheck[]>([]);
  const [recommendations, setRecommendations] = useState<readonly DnsRecommendation[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [running, setRunning] = useState(false);

  const load = useCallback(async (): Promise<void> => {
    if (!domain) {
      setLoading(false);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const [checks, recs] = await Promise.all([
        fetchDomainHistory(tenantId, domain),
        fetchDomainRecommendations(tenantId, domain),
      ]);
      setHistory(checks);
      setRecommendations(recs);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [tenantId, domain]);

  useEffect(() => {
    void load();
  }, [load]);

  const handleRun = async (): Promise<void> => {
    if (!domain) return;
    setRunning(true);
    setError(null);
    try {
      await runDomainAnalysis(tenantId, domain);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setRunning(false);
    }
  };

  if (!domain) {
    return (
      <div style={pageStyle} data-testid="domain-analyser-page">
        <h1 style={titleStyle}>Domain Analyser</h1>
        <p style={emptyStyle} data-testid="domain-analyser-no-domain">
          Select a domain from the Domains page to analyse its DNS records.
        </p>
      </div>
    );
  }

  const latest = history.length > 0 ? history[history.length - 1] : undefined;

  return (
    <div style={pageStyle} data-testid="domain-analyser-page">
      <div style={headerStyle}>
        <div>
          <h1 style={titleStyle}>Domain Analyser</h1>
          <p style={subtitleStyle}>{domain}</p>
        </div>
        <button
          type="button"
          style={buttonStyle}
          onClick={() => void handleRun()}
          disabled={running}
          data-testid="domain-analyser-run"
        >
          {running ? "Analysing…" : "Run analysis"}
        </button>
      </div>

      {error && (
        <div style={errorStyle} data-testid="domain-analyser-error" role="alert">
          {error}
        </div>
      )}

      {latest || loading ? (
        <DnsPanel
          domain={domain}
          records={latest?.records}
          health={latest?.health}
          loading={loading}
        />
      ) : (
        <div style={emptyStyle} data-testid="domain-analyser-empty">
          No DNS analysis is stored for this domain yet — run the analyser to see
          the record families.
        </div>
      )}

      <DnsRecommendations recommendations={recommendations} loading={loading} />

      <DnsHistoryChart checks={history} loading={loading} />
    </div>
  );
}
