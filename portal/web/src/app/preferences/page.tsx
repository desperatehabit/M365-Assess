"use client";

// Preferences page (EPIC-037 SPEC.md §3.4, §4.3, §6, §7; T-0728). Per-user
// preferences load from and save through the T-0726 GET/PUT /v1/preferences.
// Every successful load and save is mirrored to localStorage: the full record
// under PREFERENCES_STORAGE_KEY and the appearance mode/density/text-scale
// through the existing theme helpers, so the stored choice can paint before
// React hydrates (§4.3). Preferences are per-user; the BFF keys them by caller.

import { useCallback, useEffect, useState, type CSSProperties, type ReactElement } from "react";
import { applyTheme, getStoredTheme, type ThemeMode } from "../../lib/theme";

export const PREFERENCES_API_PATH = "/v1/preferences";
export const PREFERENCES_STORAGE_KEY = "m365_assess_preferences";

export interface PreferencesBookmark {
  id: string;
  label: string;
  path: string;
}

export interface PreferencesPortalLink {
  id: string;
  label: string;
  url: string;
}

export interface UserPreferences {
  schemaVersion: "v1";
  general: {
    usageLocation: string;
    tablePageSize: number;
    tableViewMode: "table" | "card";
    defaultTestSuite: string;
    persistFilters: boolean;
  };
  navigation: {
    bookmarks: PreferencesBookmark[];
    compactNav: boolean;
  };
  appearance: {
    theme: "light" | "dark" | "system";
    density: "compact" | "comfortable";
    textScale: number;
  };
  portalLinks: {
    links: PreferencesPortalLink[];
  };
}

export function defaultPreferences(): UserPreferences {
  return {
    schemaVersion: "v1",
    general: {
      usageLocation: "",
      tablePageSize: 25,
      tableViewMode: "table",
      defaultTestSuite: "",
      persistFilters: false,
    },
    navigation: { bookmarks: [], compactNav: false },
    appearance: { theme: "system", density: "comfortable", textScale: 1 },
    portalLinks: { links: [] },
  };
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

export async function loadPreferences(fetcher: Fetcher = fetch): Promise<UserPreferences> {
  const response = await fetcher(PREFERENCES_API_PATH);
  if (!response.ok) {
    throw new Error(await errorMessage(response, `Failed to load preferences (HTTP ${response.status})`));
  }
  const body = (await response.json()) as { prefs: UserPreferences };
  return body.prefs;
}

export async function savePreferences(
  prefs: UserPreferences,
  fetcher: Fetcher = fetch,
): Promise<UserPreferences> {
  const response = await fetcher(PREFERENCES_API_PATH, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(prefs),
  });
  if (!response.ok) {
    throw new Error(await errorMessage(response, `Save failed (HTTP ${response.status})`));
  }
  const body = (await response.json()) as { prefs: UserPreferences };
  return body.prefs;
}

function systemMode(): ThemeMode {
  if (typeof window !== "undefined" && typeof window.matchMedia === "function") {
    return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
  }
  return "dark";
}

/**
 * Mirror the saved preferences to localStorage and apply the appearance tokens
 * to <html> so the next first paint uses them. Storage may be unavailable in
 * private mode, so a failure only costs the mirror, never the save.
 */
export function mirrorPreferences(prefs: UserPreferences): void {
  try {
    window.localStorage.setItem(PREFERENCES_STORAGE_KEY, JSON.stringify(prefs));
  } catch {
    // ignore storage quota / restricted localStorage
  }
  const mode: ThemeMode = prefs.appearance.theme === "system" ? systemMode() : prefs.appearance.theme;
  applyTheme(getStoredTheme().theme, mode);
  document.documentElement.dataset["density"] = prefs.appearance.density;
  document.documentElement.dataset["textScale"] = String(prefs.appearance.textScale);
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

const groupStyle: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: "12px",
  padding: "16px",
  border: "1px solid var(--border)",
  borderRadius: "var(--radius, 10px)",
  background: "var(--bg-elev)",
  marginBottom: "20px",
  maxWidth: "720px",
};

const groupTitleStyle: CSSProperties = {
  fontSize: "13px",
  fontWeight: 700,
  margin: 0,
  color: "var(--text)",
};

const labelStyle: CSSProperties = {
  display: "block",
  fontSize: "12px",
  fontWeight: 600,
  letterSpacing: "0.07em",
  textTransform: "uppercase",
  color: "var(--muted)",
  marginBottom: "4px",
  fontFamily: "var(--font-mono, monospace)",
};

const fieldStyle: CSSProperties = {
  background: "var(--input-bg)",
  border: "1px solid var(--border)",
  borderRadius: "6px",
  color: "var(--text)",
  padding: "6px 8px",
  width: "100%",
  fontFamily: "var(--font-sans, system-ui, -apple-system, sans-serif)",
};

const rowStyle: CSSProperties = {
  display: "grid",
  gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))",
  gap: "8px",
  alignItems: "end",
};

const buttonStyle: CSSProperties = {
  background: "var(--accent)",
  border: "1px solid var(--accent-border, var(--accent))",
  borderRadius: "6px",
  color: "var(--accent-text)",
  cursor: "pointer",
  fontSize: "13px",
  fontWeight: 600,
  padding: "8px 16px",
};

const subtleButtonStyle: CSSProperties = {
  ...buttonStyle,
  background: "var(--subtle)",
  border: "1px solid var(--border)",
  color: "var(--text-soft)",
};

const errorStyle: CSSProperties = {
  padding: "10px 12px",
  background: "var(--danger-soft)",
  border: "1px solid var(--border)",
  borderRadius: "6px",
  color: "var(--danger-text)",
  fontSize: "13px",
  marginBottom: "12px",
};

function BookmarkEditor({
  entries,
  onChange,
}: {
  readonly entries: readonly PreferencesBookmark[];
  readonly onChange: (next: PreferencesBookmark[]) => void;
}): ReactElement {
  const update = (index: number, patch: Partial<PreferencesBookmark>): void => {
    onChange(entries.map((entry, current) => (current === index ? { ...entry, ...patch } : entry)));
  };
  return (
    <div data-testid="preferences-bookmarks">
      {entries.map((entry, index) => (
        <div key={index} style={rowStyle}>
          <input
            data-testid={`bookmark-${index}-label`}
            style={fieldStyle}
            placeholder="Label"
            value={entry.label}
            onChange={(event) => update(index, { label: event.target.value })}
          />
          <input
            data-testid={`bookmark-${index}-path`}
            style={fieldStyle}
            placeholder="/dashboard"
            value={entry.path}
            onChange={(event) => update(index, { path: event.target.value })}
          />
          <button
            type="button"
            data-testid={`bookmark-${index}-remove`}
            style={subtleButtonStyle}
            onClick={() => onChange(entries.filter((_, current) => current !== index))}
          >
            Remove
          </button>
        </div>
      ))}
      <button
        type="button"
        data-testid="bookmark-add"
        style={subtleButtonStyle}
        onClick={() =>
          onChange([
            ...entries,
            { id: `bookmark-${entries.length + 1}`, label: "", path: "/" },
          ])
        }
      >
        Add bookmark
      </button>
    </div>
  );
}

function PortalLinkEditor({
  entries,
  onChange,
}: {
  readonly entries: readonly PreferencesPortalLink[];
  readonly onChange: (next: PreferencesPortalLink[]) => void;
}): ReactElement {
  const update = (index: number, patch: Partial<PreferencesPortalLink>): void => {
    onChange(entries.map((entry, current) => (current === index ? { ...entry, ...patch } : entry)));
  };
  return (
    <div data-testid="preferences-portal-links">
      {entries.map((entry, index) => (
        <div key={index} style={rowStyle}>
          <input
            data-testid={`portal-link-${index}-label`}
            style={fieldStyle}
            placeholder="Label"
            value={entry.label}
            onChange={(event) => update(index, { label: event.target.value })}
          />
          <input
            data-testid={`portal-link-${index}-url`}
            style={fieldStyle}
            placeholder="https://example.com"
            value={entry.url}
            onChange={(event) => update(index, { url: event.target.value })}
          />
          <button
            type="button"
            data-testid={`portal-link-${index}-remove`}
            style={subtleButtonStyle}
            onClick={() => onChange(entries.filter((_, current) => current !== index))}
          >
            Remove
          </button>
        </div>
      ))}
      <button
        type="button"
        data-testid="portal-link-add"
        style={subtleButtonStyle}
        onClick={() =>
          onChange([...entries, { id: `link-${entries.length + 1}`, label: "", url: "" }])
        }
      >
        Add link
      </button>
    </div>
  );
}

export default function PreferencesPage(): ReactElement {
  const [draft, setDraft] = useState<UserPreferences>(defaultPreferences);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    void (async () => {
      try {
        const loaded = await loadPreferences();
        if (!active) return;
        setDraft(loaded);
        mirrorPreferences(loaded);
      } catch (cause) {
        if (active) setError(cause instanceof Error ? cause.message : "Failed to load preferences.");
      } finally {
        if (active) setLoading(false);
      }
    })();
    return () => {
      active = false;
    };
  }, []);

  const handleSave = useCallback(async () => {
    setSaving(true);
    setError(null);
    setStatus(null);
    try {
      const saved = await savePreferences(draft);
      setDraft(saved);
      mirrorPreferences(saved);
      setStatus("Preferences saved.");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Save failed.");
    } finally {
      setSaving(false);
    }
  }, [draft]);

  return (
    <div style={pageStyle} data-testid="preferences-page">
      <div style={breadcrumbStyle}>Preferences</div>
      <h1 style={headingStyle}>Preferences</h1>
      {loading ? (
        <p data-testid="preferences-loading" style={{ color: "var(--muted)" }}>
          Loading preferences...
        </p>
      ) : (
        <>
          {error !== null ? (
            <div data-testid="preferences-error" style={errorStyle}>
              {error}
            </div>
          ) : null}

          <section style={groupStyle} data-testid="preferences-general">
            <h2 style={groupTitleStyle}>General</h2>
            <div>
              <label style={labelStyle} htmlFor="preferences-usage-location">
                Usage location
              </label>
              <input
                id="preferences-usage-location"
                data-testid="preferences-usage-location"
                style={fieldStyle}
                value={draft.general.usageLocation}
                onChange={(event) =>
                  setDraft((current) => ({
                    ...current,
                    general: { ...current.general, usageLocation: event.target.value },
                  }))
                }
              />
            </div>
            <div style={rowStyle}>
              <div>
                <label style={labelStyle} htmlFor="preferences-page-size">
                  Table page size
                </label>
                <input
                  id="preferences-page-size"
                  data-testid="preferences-page-size"
                  type="number"
                  min={1}
                  max={500}
                  style={fieldStyle}
                  value={draft.general.tablePageSize}
                  onChange={(event) =>
                    setDraft((current) => ({
                      ...current,
                      general: { ...current.general, tablePageSize: Number(event.target.value) },
                    }))
                  }
                />
              </div>
              <div>
                <label style={labelStyle} htmlFor="preferences-view-mode">
                  Table view mode
                </label>
                <select
                  id="preferences-view-mode"
                  data-testid="preferences-view-mode"
                  style={fieldStyle}
                  value={draft.general.tableViewMode}
                  onChange={(event) =>
                    setDraft((current) => ({
                      ...current,
                      general: {
                        ...current.general,
                        tableViewMode: event.target.value as "table" | "card",
                      },
                    }))
                  }
                >
                  <option value="table">Table</option>
                  <option value="card">Card</option>
                </select>
              </div>
            </div>
            <div>
              <label style={labelStyle} htmlFor="preferences-test-suite">
                Default test suite
              </label>
              <input
                id="preferences-test-suite"
                data-testid="preferences-test-suite"
                style={fieldStyle}
                value={draft.general.defaultTestSuite}
                onChange={(event) =>
                  setDraft((current) => ({
                    ...current,
                    general: { ...current.general, defaultTestSuite: event.target.value },
                  }))
                }
              />
            </div>
            <label style={{ ...labelStyle, display: "flex", gap: "8px", alignItems: "center" }}>
              <input
                type="checkbox"
                data-testid="preferences-persist-filters"
                checked={draft.general.persistFilters}
                onChange={(event) =>
                  setDraft((current) => ({
                    ...current,
                    general: { ...current.general, persistFilters: event.target.checked },
                  }))
                }
              />
              Persist filters
            </label>
          </section>

          <section style={groupStyle} data-testid="preferences-navigation">
            <h2 style={groupTitleStyle}>Navigation</h2>
            <label style={{ ...labelStyle, display: "flex", gap: "8px", alignItems: "center" }}>
              <input
                type="checkbox"
                data-testid="preferences-compact-nav"
                checked={draft.navigation.compactNav}
                onChange={(event) =>
                  setDraft((current) => ({
                    ...current,
                    navigation: { ...current.navigation, compactNav: event.target.checked },
                  }))
                }
              />
              Compact nav
            </label>
            <BookmarkEditor
              entries={draft.navigation.bookmarks}
              onChange={(bookmarks) =>
                setDraft((current) => ({ ...current, navigation: { ...current.navigation, bookmarks } }))
              }
            />
          </section>

          <section style={groupStyle} data-testid="preferences-appearance">
            <h2 style={groupTitleStyle}>Theme &amp; density</h2>
            <div style={rowStyle}>
              <div>
                <label style={labelStyle} htmlFor="preferences-theme">
                  Theme
                </label>
                <select
                  id="preferences-theme"
                  data-testid="preferences-theme"
                  style={fieldStyle}
                  value={draft.appearance.theme}
                  onChange={(event) =>
                    setDraft((current) => ({
                      ...current,
                      appearance: {
                        ...current.appearance,
                        theme: event.target.value as "light" | "dark" | "system",
                      },
                    }))
                  }
                >
                  <option value="system">System</option>
                  <option value="light">Light</option>
                  <option value="dark">Dark</option>
                </select>
              </div>
              <div>
                <label style={labelStyle} htmlFor="preferences-density">
                  Density
                </label>
                <select
                  id="preferences-density"
                  data-testid="preferences-density"
                  style={fieldStyle}
                  value={draft.appearance.density}
                  onChange={(event) =>
                    setDraft((current) => ({
                      ...current,
                      appearance: {
                        ...current.appearance,
                        density: event.target.value as "compact" | "comfortable",
                      },
                    }))
                  }
                >
                  <option value="comfortable">Comfortable</option>
                  <option value="compact">Compact</option>
                </select>
              </div>
              <div>
                <label style={labelStyle} htmlFor="preferences-text-scale">
                  Text scale
                </label>
                <input
                  id="preferences-text-scale"
                  data-testid="preferences-text-scale"
                  type="number"
                  min={0.75}
                  max={1.5}
                  step={0.05}
                  style={fieldStyle}
                  value={draft.appearance.textScale}
                  onChange={(event) =>
                    setDraft((current) => ({
                      ...current,
                      appearance: { ...current.appearance, textScale: Number(event.target.value) },
                    }))
                  }
                />
              </div>
            </div>
          </section>

          <section style={groupStyle} data-testid="preferences-portal-links">
            <h2 style={groupTitleStyle}>Portal links</h2>
            <PortalLinkEditor
              entries={draft.portalLinks.links}
              onChange={(links) => setDraft((current) => ({ ...current, portalLinks: { links } }))}
            />
          </section>

          <div style={{ display: "flex", alignItems: "center", gap: "12px" }}>
            <button
              type="button"
              data-testid="preferences-save"
              style={{ ...buttonStyle, opacity: saving ? 0.6 : 1 }}
              disabled={saving}
              onClick={() => void handleSave()}
            >
              {saving ? "Saving..." : "Save preferences"}
            </button>
            {status !== null ? (
              <span data-testid="preferences-status" style={{ color: "var(--success-text)", fontSize: "13px" }}>
                {status}
              </span>
            ) : null}
          </div>
        </>
      )}
    </div>
  );
}
