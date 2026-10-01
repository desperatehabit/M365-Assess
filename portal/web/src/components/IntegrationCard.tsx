"use client";

// IntegrationCard (EPIC-041 SPEC §3.1, §6, §7; T-0808). One card per connector
// registered with the T-0801 registry: config, a Test action, sync status, and
// the entity-sync mapping. The page discovers the kinds from
// `GET /v1/integrations`, so a newly registered adapter appears without a page
// change. Test and Sync go through `POST /v1/integrations/{kind}/test|sync` and
// render the result inline; config writes go through `PUT` and are gated on
// `integrations.manage` through PermissionGate (T-0743/T-0752). A kind with no
// stored config renders disabled — no connector is enabled by default.

import React, { useCallback, useEffect, useState, type CSSProperties, type ReactElement } from "react";
import { PermissionGate } from "./PermissionGate";

export const INTEGRATIONS_PATH = "/v1/integrations";
export const INTEGRATIONS_MANAGE_PERMISSION = "integrations.manage";

export interface IntegrationConfig {
  readonly id?: string;
  readonly kind: string;
  readonly enabled: boolean;
  readonly secretRef: string;
  readonly mapping: Record<string, unknown>;
  readonly createdAt?: string;
  readonly updatedAt?: string;
}

export interface IntegrationConfigInput {
  readonly enabled: boolean;
  readonly secretRef: string;
  readonly mapping: Record<string, unknown>;
}

export interface IntegrationTestResult {
  readonly ok: boolean;
  readonly message: string;
}

export interface IntegrationSyncResult {
  readonly ok: boolean;
  readonly synced: number;
  readonly message: string;
}

export interface IntegrationList {
  readonly kinds: string[];
  readonly configs: ReadonlyMap<string, IntegrationConfig>;
}

export function integrationConfigPath(kind: string): string {
  return `${INTEGRATIONS_PATH}/${encodeURIComponent(kind)}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Reads the registered kinds from either `{ kinds }` or `{ items }`, and any configs the list carries. */
export function parseIntegrationList(body: unknown): IntegrationList {
  const kinds = new Set<string>();
  const configs = new Map<string, IntegrationConfig>();
  if (!isRecord(body)) {
    return { kinds: [], configs };
  }
  if (Array.isArray(body.kinds)) {
    for (const kind of body.kinds) {
      if (typeof kind === "string") kinds.add(kind);
    }
  }
  if (Array.isArray(body.items)) {
    for (const item of body.items) {
      if (!isRecord(item) || typeof item.kind !== "string") continue;
      kinds.add(item.kind);
      configs.set(item.kind, item as unknown as IntegrationConfig);
    }
  }
  return { kinds: [...kinds].sort(), configs };
}

async function readErrorMessage(response: Response, fallback: string): Promise<string> {
  try {
    const body = (await response.json()) as { message?: unknown };
    return typeof body.message === "string" ? body.message : `${fallback} (HTTP ${response.status}).`;
  } catch {
    return `${fallback} (HTTP ${response.status}).`;
  }
}

function parseMapping(text: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(text);
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

const cardStyle: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: "12px",
  padding: "16px",
  background: "var(--bg-elev)",
  border: "1px solid var(--border)",
  borderRadius: "var(--radius, 10px)",
  boxShadow: "var(--shadow-card)",
};

const headerStyle: CSSProperties = {
  display: "flex",
  justifyContent: "space-between",
  alignItems: "center",
  gap: "12px",
};

const titleStyle: CSSProperties = {
  margin: 0,
  fontSize: "16px",
  fontWeight: 700,
  fontFamily: "var(--font-display, var(--font-sans))",
};

const chipStyle: CSSProperties = {
  padding: "2px 8px",
  borderRadius: "999px",
  fontSize: "12px",
  fontWeight: 600,
  background: "var(--chip, var(--bg))",
  border: "1px solid var(--border)",
};

const fieldRowStyle: CSSProperties = {
  display: "grid",
  gridTemplateColumns: "max-content 1fr",
  gap: "4px 16px",
  margin: 0,
  fontSize: "13px",
};

const termStyle: CSSProperties = {
  color: "var(--text-soft)",
};

const valueStyle: CSSProperties = {
  margin: 0,
  wordBreak: "break-word",
};

const mappingViewStyle: CSSProperties = {
  margin: 0,
  padding: "8px 10px",
  background: "var(--surface)",
  border: "1px solid var(--border)",
  borderRadius: "6px",
  fontFamily: "var(--font-mono, monospace)",
  fontSize: "12px",
  whiteSpace: "pre-wrap",
  wordBreak: "break-word",
  color: "var(--text)",
};

const textareaStyle: CSSProperties = {
  width: "100%",
  minHeight: "64px",
  padding: "8px 10px",
  background: "var(--input-bg, var(--bg))",
  border: "1px solid var(--border)",
  borderRadius: "6px",
  color: "var(--text)",
  fontFamily: "var(--font-mono, monospace)",
  fontSize: "12px",
};

const actionRowStyle: CSSProperties = {
  display: "flex",
  flexWrap: "wrap",
  gap: "8px",
  alignItems: "center",
};

const buttonStyle: CSSProperties = {
  padding: "6px 12px",
  background: "var(--surface)",
  border: "1px solid var(--border)",
  borderRadius: "6px",
  color: "var(--text)",
  fontSize: "13px",
  fontWeight: 500,
  cursor: "pointer",
};

const primaryButtonStyle: CSSProperties = {
  ...buttonStyle,
  background: "var(--accent)",
  color: "var(--on-accent)",
  borderColor: "var(--accent)",
};

const errorStyle: CSSProperties = {
  padding: "8px 12px",
  background: "var(--danger-soft)",
  border: "1px solid var(--danger-text)",
  borderRadius: "6px",
  color: "var(--danger-text)",
  fontSize: "13px",
};

const resultStyle: CSSProperties = {
  padding: "8px 12px",
  background: "var(--surface)",
  border: "1px solid var(--border)",
  borderRadius: "6px",
  fontSize: "13px",
  color: "var(--text)",
};

export interface IntegrationCardProps {
  readonly kind: string;
  readonly fetcher?: typeof fetch;
  /** A known config from the list response; `undefined` loads it, `null` means not configured. */
  readonly initialConfig?: IntegrationConfig | null;
}

export function IntegrationCard({
  kind,
  fetcher,
  initialConfig,
}: IntegrationCardProps): ReactElement {
  const doFetch = fetcher ?? fetch;
  const [config, setConfig] = useState<IntegrationConfig | null | undefined>(initialConfig);
  const [loading, setLoading] = useState(initialConfig === undefined);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [testResult, setTestResult] = useState<IntegrationTestResult | null>(null);
  const [syncResult, setSyncResult] = useState<IntegrationSyncResult | null>(null);
  const [enabled, setEnabled] = useState(initialConfig?.enabled ?? false);
  const [secretRef, setSecretRef] = useState(initialConfig?.secretRef ?? "");
  const [mappingText, setMappingText] = useState(() =>
    JSON.stringify(initialConfig?.mapping ?? {}, null, 2),
  );

  const applyConfig = useCallback((next: IntegrationConfig): void => {
    setConfig(next);
    setEnabled(next.enabled);
    setSecretRef(next.secretRef);
    setMappingText(JSON.stringify(next.mapping ?? {}, null, 2));
  }, []);

  const load = useCallback(async (): Promise<void> => {
    setLoading(true);
    setError(null);
    try {
      const response = await doFetch(integrationConfigPath(kind));
      if (response.status === 404) {
        setConfig(null);
        setEnabled(false);
        setSecretRef("");
        setMappingText("{}");
        return;
      }
      if (!response.ok) {
        throw new Error(await readErrorMessage(response, "Loading the integration failed"));
      }
      applyConfig((await response.json()) as IntegrationConfig);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Loading the integration failed.");
    } finally {
      setLoading(false);
    }
  }, [applyConfig, doFetch, kind]);

  useEffect(() => {
    if (initialConfig !== undefined) return;
    void load();
  }, [initialConfig, load]);

  async function save(): Promise<void> {
    const mapping = parseMapping(mappingText);
    if (mapping === null) {
      setError("The entity-sync mapping must be a JSON object.");
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const body: IntegrationConfigInput = { enabled, secretRef, mapping };
      const response = await doFetch(integrationConfigPath(kind), {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!response.ok) {
        throw new Error(await readErrorMessage(response, "Saving the integration failed"));
      }
      applyConfig((await response.json()) as IntegrationConfig);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Saving the integration failed.");
    } finally {
      setSaving(false);
    }
  }

  async function runTest(): Promise<void> {
    setTesting(true);
    setError(null);
    try {
      const response = await doFetch(`${integrationConfigPath(kind)}/test`, { method: "POST" });
      if (!response.ok) {
        throw new Error(await readErrorMessage(response, "The integration test failed"));
      }
      setTestResult((await response.json()) as IntegrationTestResult);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "The integration test failed.");
    } finally {
      setTesting(false);
    }
  }

  async function runSync(): Promise<void> {
    setSyncing(true);
    setError(null);
    try {
      const response = await doFetch(`${integrationConfigPath(kind)}/sync`, { method: "POST" });
      if (!response.ok) {
        throw new Error(await readErrorMessage(response, "The integration sync failed"));
      }
      setSyncResult((await response.json()) as IntegrationSyncResult);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "The integration sync failed.");
    } finally {
      setSyncing(false);
    }
  }

  const statusLabel = config === null ? "Not configured" : enabled ? "Enabled" : "Disabled";

  return (
    <section
      style={cardStyle}
      data-testid={`integration-card-${kind}`}
      aria-busy={loading}
      aria-label={`Integration ${kind}`}
    >
      <div style={headerStyle}>
        <h2 style={titleStyle}>{kind}</h2>
        <span
          style={chipStyle}
          data-testid={`integration-status-${kind}`}
          data-state={enabled ? "enabled" : "disabled"}
        >
          {statusLabel}
        </span>
      </div>

      {error !== null && (
        <div role="alert" style={errorStyle} data-testid={`integration-error-${kind}`}>
          {error}
        </div>
      )}

      {loading ? (
        <p style={{ margin: 0, color: "var(--muted)" }} data-testid={`integration-loading-${kind}`}>
          Loading configuration…
        </p>
      ) : (
        <>
          <dl style={fieldRowStyle}>
            <dt style={termStyle}>Secret reference</dt>
            <dd
              style={{ ...valueStyle, fontFamily: "var(--font-mono, monospace)" }}
              data-testid={`integration-secret-${kind}`}
            >
              {secretRef || "—"}
            </dd>
            <dt style={termStyle}>Sync status</dt>
            <dd style={valueStyle} data-testid={`integration-sync-status-${kind}`}>
              {syncResult === null
                ? "Never synced"
                : `${syncResult.ok ? "Synced" : "Sync failed"} ${syncResult.synced} — ${syncResult.message}`}
            </dd>
          </dl>

          <div>
            <div style={termStyle}>Entity-sync mapping</div>
            <pre style={mappingViewStyle} data-testid={`integration-mapping-view-${kind}`}>
              {JSON.stringify(config?.mapping ?? {}, null, 2)}
            </pre>
          </div>

          <PermissionGate permission={INTEGRATIONS_MANAGE_PERMISSION}>
            <div style={{ display: "flex", flexDirection: "column", gap: "10px" }}>
              <label style={{ display: "flex", gap: "8px", alignItems: "center", fontSize: "13px" }}>
                <input
                  type="checkbox"
                  checked={enabled}
                  disabled={saving}
                  onChange={(event) => setEnabled(event.target.checked)}
                  data-testid={`integration-enabled-${kind}`}
                />
                Enabled
              </label>
              <textarea
                style={textareaStyle}
                aria-label="Entity-sync mapping"
                value={mappingText}
                disabled={saving}
                onChange={(event) => setMappingText(event.target.value)}
                data-testid={`integration-mapping-${kind}`}
              />
              <div style={actionRowStyle}>
                <button
                  type="button"
                  style={primaryButtonStyle}
                  disabled={saving}
                  onClick={() => void save()}
                  data-testid={`integration-save-${kind}`}
                >
                  {saving ? "Saving…" : "Save"}
                </button>
                <button
                  type="button"
                  style={buttonStyle}
                  disabled={testing}
                  onClick={() => void runTest()}
                  data-testid={`integration-test-${kind}`}
                >
                  {testing ? "Testing…" : "Test"}
                </button>
                <button
                  type="button"
                  style={buttonStyle}
                  disabled={syncing}
                  onClick={() => void runSync()}
                  data-testid={`integration-sync-${kind}`}
                >
                  {syncing ? "Syncing…" : "Sync"}
                </button>
              </div>
            </div>
          </PermissionGate>

          {testResult !== null && (
            <div role="status" style={resultStyle} data-testid={`integration-test-result-${kind}`}>
              {testResult.ok ? "Test passed" : "Test failed"} — {testResult.message}
            </div>
          )}
        </>
      )}
    </section>
  );
}
