"use client";

// Features page (EPIC-037 SPEC.md §3.3, §4.1, §6; T-0728). Loads the instance
// flags from the T-0725 GET /v1/feature-flags and toggles them through PUT
// /v1/feature-flags. Toggles update the local flag source immediately and the
// nav gate recomputes from that same source, so the rendered nav matches what
// the API enforces. The toggle is optimistic and reverts if the write fails.

import { useCallback, useEffect, useMemo, useState, type CSSProperties, type ReactElement } from "react";
import { NAV_GROUPS } from "../../../components/shell/AppNav";
import {
  FeatureFlagsTable,
  featureDefinition,
  gateNavGroups,
  type FeatureFlag,
} from "../../../components/settings/FeatureFlagsTable";

export const FEATURE_FLAGS_API_PATH = "/v1/feature-flags";

export interface FeatureFlagInput {
  readonly key: string;
  readonly enabled: boolean;
  readonly scope: "global";
  readonly description: string;
}

export type Fetcher = typeof fetch;

async function errorMessage(response: Response, fallback: string): Promise<string> {
  try {
    const body = (await response.json()) as { message?: string };
    if (typeof body.message === "string" && body.message.length > 0) return body.message;
  } catch {
    // non-JSON error body; keep the fallback
  }
  return fallback;
}

export async function loadFeatureFlags(fetcher: Fetcher = fetch): Promise<FeatureFlag[]> {
  const response = await fetcher(FEATURE_FLAGS_API_PATH);
  if (!response.ok) {
    throw new Error(await errorMessage(response, `Failed to load feature flags (HTTP ${response.status})`));
  }
  const body = (await response.json()) as { flags: FeatureFlag[] };
  return body.flags;
}

export async function saveFeatureFlag(
  input: FeatureFlagInput,
  fetcher: Fetcher = fetch,
): Promise<FeatureFlag> {
  const response = await fetcher(FEATURE_FLAGS_API_PATH, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input),
  });
  if (!response.ok) {
    throw new Error(await errorMessage(response, `Save failed (HTTP ${response.status})`));
  }
  const body = (await response.json()) as { flag: FeatureFlag };
  return body.flag;
}

const pageStyle: CSSProperties = {
  padding: "28px 40px",
  maxWidth: "1800px",
  color: "var(--text)",
  fontFamily: "var(--font-sans, system-ui, -apple-system, sans-serif)",
};

const breadcrumbStyle: CSSProperties = {
  fontSize: "12px",
  fontWeight: 600,
  letterSpacing: "0.08em",
  textTransform: "uppercase",
  color: "var(--muted)",
  marginBottom: "12px",
  fontFamily: "var(--font-mono, monospace)",
};

const headingStyle: CSSProperties = {
  fontSize: "24px",
  fontWeight: 700,
  marginBottom: "8px",
  color: "var(--text)",
};

const noteStyle: CSSProperties = {
  color: "var(--text-soft)",
  fontSize: "13px",
  marginBottom: "20px",
  maxWidth: "760px",
};

const previewStyle: CSSProperties = {
  marginTop: "28px",
  padding: "16px",
  border: "1px solid var(--border)",
  borderRadius: "var(--radius, 10px)",
  background: "var(--bg-elev)",
};

const previewGroupStyle: CSSProperties = {
  marginTop: "12px",
};

const previewLabelStyle: CSSProperties = {
  fontSize: "11px",
  fontWeight: 600,
  letterSpacing: "0.07em",
  textTransform: "uppercase",
  color: "var(--muted)",
  fontFamily: "var(--font-mono, monospace)",
};

export default function FeaturesPage(): ReactElement {
  const [flags, setFlags] = useState<FeatureFlag[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    void (async () => {
      try {
        const loaded = await loadFeatureFlags();
        if (active) setFlags(loaded);
      } catch (cause) {
        if (active) setError(cause instanceof Error ? cause.message : "Failed to load feature flags.");
      } finally {
        if (active) setLoading(false);
      }
    })();
    return () => {
      active = false;
    };
  }, []);

  const gatedNav = useMemo(() => gateNavGroups(NAV_GROUPS, flags), [flags]);

  const handleToggle = useCallback(
    async (key: string, enabled: boolean) => {
      const previous = flags;
      const existing = flags.find((flag) => flag.key === key);
      const description = existing?.description ?? featureDefinition(key)?.description ?? "";

      setFlags((current) => [
        ...current.filter((flag) => flag.key !== key),
        {
          key,
          enabled,
          scope: existing?.scope ?? "global",
          description,
          updatedAt: existing?.updatedAt ?? null,
          updatedBy: existing?.updatedBy ?? null,
        },
      ]);
      setSaving(key);
      setError(null);
      setStatus(null);
      try {
        const saved = await saveFeatureFlag({ key, enabled, scope: "global", description });
        setFlags((current) => [...current.filter((flag) => flag.key !== key), saved]);
        setStatus(`${key} ${enabled ? "enabled" : "disabled"}.`);
      } catch (cause) {
        setFlags(previous);
        setError(cause instanceof Error ? cause.message : "Save failed.");
      } finally {
        setSaving(null);
      }
    },
    [flags],
  );

  return (
    <div style={pageStyle} data-testid="features-page">
      <div style={breadcrumbStyle}>Application Settings &rarr; Features</div>
      <h1 style={headingStyle}>Features</h1>
      <p style={noteStyle}>
        Feature flags are enforced by the API. The navigation below is gated by this same flag
        source, so a disabled feature cannot appear in the nav.
      </p>
      {status !== null ? (
        <p data-testid="feature-flags-status" style={{ color: "var(--success-text)", fontSize: "13px" }}>
          {status}
        </p>
      ) : null}
      {loading ? (
        <p data-testid="feature-flags-loading" style={{ color: "var(--muted)" }}>
          Loading feature flags...
        </p>
      ) : (
        <FeatureFlagsTable flags={flags} onToggle={(key, enabled) => void handleToggle(key, enabled)} saving={saving} error={error} />
      )}

      <section style={previewStyle} data-testid="feature-nav-preview">
        <div style={previewLabelStyle}>Navigation impact</div>
        {gatedNav.map((group) => (
          <div key={group.label} style={previewGroupStyle}>
            <div style={{ fontSize: "13px", fontWeight: 600 }}>{group.label}</div>
            <ul style={{ margin: "4px 0 0", paddingLeft: "18px", color: "var(--text-soft)" }}>
              {group.items.map((item) => (
                <li key={item.href} data-testid={`nav-preview-${item.href}`}>
                  {item.label}
                </li>
              ))}
            </ul>
          </div>
        ))}
      </section>
    </div>
  );
}
