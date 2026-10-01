"use client";

// Application Settings page (EPIC-037 SPEC.md §3.1, §4.1, §6; T-0728). Loads the
// typed settings grouped by the T-0722 GET /v1/settings tab schema and saves the
// changed keys through PUT /v1/settings. The BFF validates every key before it
// writes, so an unknown or ill-typed key is surfaced here as a per-field error
// and nothing is partially applied. Branding lives in T-0729; Features has its
// own page; Permissions/Notifications/Integrations are prose hand-offs.

import { useCallback, useEffect, useState, type CSSProperties, type ReactElement } from "react";
import {
  SettingsApiError,
  SettingsTabs,
  type SettingValue,
  type SettingsFieldError,
  type SettingsGroups,
} from "../../components/settings/SettingsTabs";

export const SETTINGS_API_PATH = "/v1/settings";

export interface SettingsSnapshot {
  readonly schemaVersion: string;
  readonly settings: SettingsGroups;
}

export type Fetcher = typeof fetch;

interface ErrorBody {
  readonly message?: string;
  readonly details?: readonly SettingsFieldError[];
}

async function errorBody(response: Response): Promise<ErrorBody> {
  try {
    return (await response.json()) as ErrorBody;
  } catch {
    return {};
  }
}

export async function loadSettings(fetcher: Fetcher = fetch): Promise<SettingsSnapshot> {
  const response = await fetcher(SETTINGS_API_PATH);
  if (!response.ok) {
    const body = await errorBody(response);
    throw new SettingsApiError(
      body.message ?? `Failed to load settings (HTTP ${response.status})`,
      body.details ?? [],
    );
  }
  return (await response.json()) as SettingsSnapshot;
}

export async function saveSettings(
  changes: Readonly<Record<string, SettingValue>>,
  fetcher: Fetcher = fetch,
): Promise<SettingsSnapshot> {
  const response = await fetcher(SETTINGS_API_PATH, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(changes),
  });
  if (!response.ok) {
    const body = await errorBody(response);
    throw new SettingsApiError(
      body.message ?? `Save failed (HTTP ${response.status})`,
      body.details ?? [],
    );
  }
  return (await response.json()) as SettingsSnapshot;
}

function fieldErrorText(reason: string): string {
  if (reason === "settings.unknown_key") return "Unknown setting key.";
  if (reason === "settings.invalid_value") return "Invalid value for this setting.";
  return reason;
}

function fieldErrorsFrom(details: readonly SettingsFieldError[]): Record<string, string> {
  const map: Record<string, string> = {};
  for (const detail of details) map[detail.field] = fieldErrorText(detail.reason);
  return map;
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
  marginBottom: "20px",
  color: "var(--text)",
};

export default function SettingsPage(): ReactElement {
  const [snapshot, setSnapshot] = useState<SettingsSnapshot | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [status, setStatus] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    void (async () => {
      try {
        const loaded = await loadSettings();
        if (active) setSnapshot(loaded);
      } catch (cause) {
        if (active) setError(cause instanceof Error ? cause.message : "Failed to load settings.");
      } finally {
        if (active) setLoading(false);
      }
    })();
    return () => {
      active = false;
    };
  }, []);

  const handleSave = useCallback(async (changes: Readonly<Record<string, SettingValue>>) => {
    setSaving(true);
    setError(null);
    setFieldErrors({});
    setStatus(null);
    try {
      const saved = await saveSettings(changes);
      setSnapshot(saved);
      setStatus("Settings saved.");
    } catch (cause) {
      if (cause instanceof SettingsApiError) {
        setError(cause.message);
        setFieldErrors(fieldErrorsFrom(cause.details));
      } else {
        setError(cause instanceof Error ? cause.message : "Save failed.");
      }
    } finally {
      setSaving(false);
    }
  }, []);

  return (
    <div style={pageStyle} data-testid="settings-page">
      <div style={breadcrumbStyle}>Application Settings</div>
      <h1 style={headingStyle}>Application Settings</h1>
      {loading || snapshot === null ? (
        <p data-testid="settings-loading" style={{ color: "var(--muted)" }}>
          Loading settings...
        </p>
      ) : (
        <SettingsTabs
          groups={snapshot.settings}
          onSave={(changes) => void handleSave(changes)}
          saving={saving}
          error={error}
          fieldErrors={fieldErrors}
          status={status}
        />
      )}
    </div>
  );
}
