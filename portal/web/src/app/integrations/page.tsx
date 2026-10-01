"use client";

// Integrations page (EPIC-041 SPEC §3.1; T-0808). Title "Integrations": the
// page asks the T-0801 registry surface (`GET /v1/integrations`) which connector
// kinds are registered and renders one IntegrationCard per kind, so a newly
// registered adapter appears without a page change. Each card owns its config,
// Test, Sync, and mapping; this route is the thin shell.

import React, { useCallback, useEffect, useState, type CSSProperties, type ReactElement } from "react";
import {
  INTEGRATIONS_PATH,
  IntegrationCard,
  parseIntegrationList,
  type IntegrationConfig,
} from "../../components/IntegrationCard";

const pageStyle: CSSProperties = {
  padding: "32px",
  maxWidth: "1400px",
  margin: "0 auto",
  display: "flex",
  flexDirection: "column",
  gap: "20px",
  color: "var(--text)",
  fontFamily: "var(--font-sans, system-ui, sans-serif)",
};

const headerStyle: CSSProperties = {
  borderBottom: "1px solid var(--border)",
  paddingBottom: "16px",
};

const titleStyle: CSSProperties = {
  margin: 0,
  fontSize: "24px",
  fontWeight: 700,
  fontFamily: "var(--font-display, var(--font-sans))",
};

const subtitleStyle: CSSProperties = {
  margin: "4px 0 0",
  color: "var(--text-soft)",
  fontSize: "14px",
};

const gridStyle: CSSProperties = {
  display: "grid",
  gridTemplateColumns: "repeat(auto-fill, minmax(340px, 1fr))",
  gap: "16px",
};

const errorStyle: CSSProperties = {
  padding: "10px 14px",
  background: "var(--danger-soft)",
  border: "1px solid var(--danger-text)",
  borderRadius: "6px",
  color: "var(--danger-text)",
  fontSize: "13px",
};

async function readErrorMessage(response: Response, fallback: string): Promise<string> {
  try {
    const body = (await response.json()) as { message?: unknown };
    return typeof body.message === "string" ? body.message : `${fallback} (HTTP ${response.status}).`;
  } catch {
    return `${fallback} (HTTP ${response.status}).`;
  }
}

export interface IntegrationsPageProps {
  readonly fetcher?: typeof fetch;
}

export default function IntegrationsPage({ fetcher }: IntegrationsPageProps): ReactElement {
  const doFetch = fetcher ?? fetch;
  const [kinds, setKinds] = useState<string[]>([]);
  const [configs, setConfigs] = useState<ReadonlyMap<string, IntegrationConfig>>(new Map());
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async (): Promise<void> => {
    setLoading(true);
    setError(null);
    try {
      const response = await doFetch(INTEGRATIONS_PATH);
      if (!response.ok) {
        throw new Error(await readErrorMessage(response, "Loading integrations failed"));
      }
      const parsed = parseIntegrationList(await response.json());
      setKinds(parsed.kinds);
      setConfigs(parsed.configs);
    } catch (err: unknown) {
      setKinds([]);
      setConfigs(new Map());
      setError(err instanceof Error ? err.message : "Loading integrations failed.");
    } finally {
      setLoading(false);
    }
  }, [doFetch]);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <main style={pageStyle} data-testid="integrations-page">
      <div style={headerStyle}>
        <h1 style={titleStyle}>Integrations</h1>
        <p style={subtitleStyle}>
          Connectors registered with the portal. Configure, test, and sync each one; no connector is
          enabled by default.
        </p>
      </div>

      {error !== null && (
        <div role="alert" style={errorStyle} data-testid="integrations-error">
          {error}
        </div>
      )}

      {loading ? (
        <p style={{ margin: 0, color: "var(--muted)" }} data-testid="integrations-loading">
          Loading integrations…
        </p>
      ) : kinds.length === 0 ? (
        <p style={{ margin: 0, color: "var(--muted)" }} data-testid="integrations-empty">
          No integrations are registered.
        </p>
      ) : (
        <div style={gridStyle} data-testid="integrations-grid">
          {kinds.map((kind) => (
            <IntegrationCard
              key={kind}
              kind={kind}
              fetcher={doFetch}
              initialConfig={configs.has(kind) ? configs.get(kind) : undefined}
            />
          ))}
        </div>
      )}
    </main>
  );
}
