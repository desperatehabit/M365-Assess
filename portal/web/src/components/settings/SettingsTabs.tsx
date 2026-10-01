"use client";

// Application settings tabs (EPIC-037 SPEC.md §3.1, §4.1; T-0728). The trimmed
// CIPP tab pattern: General, Branding, Permissions, Notifications, Features,
// Security, Integrations. General and Security edit the T-0721 typed keys and
// save through PUT /v1/settings; Branding links to the T-0729 page, Features to
// /settings/features, and Permissions/Notifications/Integrations are prose
// hand-offs to EPIC-038/EPIC-029/EPIC-041. Settings are instance writes, so the
// parent owns the GET/PUT calls and this component owns the draft + validation
// surfacing (§4.1 validate → apply).

import { useEffect, useMemo, useState, type CSSProperties, type ReactElement } from "react";

export type SettingValue = string | boolean | number;

export interface SettingEntry {
  readonly value: SettingValue | null;
  readonly masked: boolean;
  readonly scope: "global" | "tenant";
  readonly updatedAt: string | null;
  readonly updatedBy: string | null;
}

export type SettingsGroups = Readonly<
  Record<string, Readonly<Record<string, SettingEntry>>>
>;

export interface SettingsFieldError {
  readonly field: string;
  readonly reason: string;
}

/** Structured PUT failure carrying the BFF's per-field validation details. */
export class SettingsApiError extends Error {
  readonly details: readonly SettingsFieldError[];

  constructor(message: string, details: readonly SettingsFieldError[] = []) {
    super(message);
    this.name = "SettingsApiError";
    this.details = details;
  }
}

export type SettingsTabId =
  | "general"
  | "branding"
  | "permissions"
  | "notifications"
  | "features"
  | "security"
  | "integrations";

export interface SettingsTabDefinition {
  readonly id: SettingsTabId;
  readonly label: string;
  readonly kind: "settings" | "link" | "handoff";
  readonly href?: string;
  readonly note?: string;
}

export const SETTINGS_TABS: readonly SettingsTabDefinition[] = [
  { id: "general", label: "General", kind: "settings" },
  { id: "branding", label: "Branding", kind: "link", href: "/settings/branding" },
  {
    id: "permissions",
    label: "Permissions",
    kind: "handoff",
    note: "Roles and API client scopes are managed in RBAC & API clients (EPIC-038).",
  },
  {
    id: "notifications",
    label: "Notifications",
    kind: "handoff",
    note: "Alert delivery channels are configured in Alerting & notifications (EPIC-029).",
  },
  { id: "features", label: "Features", kind: "link", href: "/settings/features" },
  { id: "security", label: "Security", kind: "settings" },
  {
    id: "integrations",
    label: "Integrations",
    kind: "handoff",
    note: "Copilot and external integrations are configured in Integrations (EPIC-041).",
  },
];

export function flattenSettings(groups: SettingsGroups): Record<string, SettingValue> {
  const flat: Record<string, SettingValue> = {};
  for (const [tab, entries] of Object.entries(groups)) {
    for (const [name, entry] of Object.entries(entries)) {
      if (entry.value !== null) flat[`${tab}.${name}`] = entry.value;
    }
  }
  return flat;
}

export interface SettingsTabsProps {
  readonly groups: SettingsGroups;
  readonly onSave: (changes: Readonly<Record<string, SettingValue>>) => void;
  readonly saving?: boolean;
  readonly error?: string | null;
  readonly fieldErrors?: Readonly<Record<string, string>>;
  readonly status?: string | null;
}

const pageStyle: CSSProperties = {
  color: "var(--text)",
  fontFamily: "var(--font-sans, system-ui, -apple-system, sans-serif)",
};

const tabBarStyle: CSSProperties = {
  display: "flex",
  flexWrap: "wrap",
  gap: "4px",
  borderBottom: "1px solid var(--border)",
  marginBottom: "20px",
};

const tabStyle: CSSProperties = {
  background: "transparent",
  border: "none",
  borderBottom: "2px solid transparent",
  color: "var(--muted)",
  cursor: "pointer",
  fontFamily: "var(--font-sans, system-ui, -apple-system, sans-serif)",
  fontSize: "13px",
  fontWeight: 600,
  padding: "8px 12px",
};

const activeTabStyle: CSSProperties = {
  ...tabStyle,
  borderBottom: "2px solid var(--accent)",
  color: "var(--text)",
};

const panelStyle: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: "12px",
  padding: "16px",
  border: "1px solid var(--border)",
  borderRadius: "var(--radius, 10px)",
  background: "var(--bg-elev)",
  maxWidth: "720px",
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

const errorStyle: CSSProperties = {
  padding: "10px 12px",
  background: "var(--danger-soft)",
  border: "1px solid var(--border)",
  borderRadius: "6px",
  color: "var(--danger-text)",
  fontSize: "13px",
};

const fieldErrorStyle: CSSProperties = {
  color: "var(--danger-text)",
  fontSize: "12px",
  marginTop: "4px",
};

const buttonStyle: CSSProperties = {
  alignSelf: "flex-start",
  background: "var(--accent)",
  border: "1px solid var(--accent-border, var(--accent))",
  borderRadius: "6px",
  color: "var(--accent-text)",
  cursor: "pointer",
  fontSize: "13px",
  fontWeight: 600,
  padding: "8px 16px",
};

function settingInputType(value: SettingValue): "text" | "number" | "checkbox" {
  if (typeof value === "boolean") return "checkbox";
  if (typeof value === "number") return "number";
  return "text";
}

function SettingsField({
  settingKey,
  value,
  error,
  onChange,
}: {
  readonly settingKey: string;
  readonly value: SettingValue;
  readonly error?: string;
  readonly onChange: (value: SettingValue) => void;
}): ReactElement {
  const inputType = settingInputType(value);
  return (
    <div>
      <label style={labelStyle} htmlFor={`setting-${settingKey}`}>
        {settingKey}
      </label>
      <input
        id={`setting-${settingKey}`}
        data-testid={`setting-${settingKey}`}
        type={inputType}
        style={inputType === "checkbox" ? undefined : fieldStyle}
        checked={inputType === "checkbox" ? (value as boolean) : undefined}
        value={inputType === "checkbox" ? undefined : (value as string | number)}
        onChange={(event) => {
          if (inputType === "checkbox") onChange(event.target.checked);
          else if (inputType === "number") onChange(Number(event.target.value));
          else onChange(event.target.value);
        }}
      />
      {error !== undefined ? (
        <div data-testid={`setting-error-${settingKey}`} style={fieldErrorStyle}>
          {error}
        </div>
      ) : null}
    </div>
  );
}

export function SettingsTabs({
  groups,
  onSave,
  saving = false,
  error = null,
  fieldErrors = {},
  status = null,
}: SettingsTabsProps): ReactElement {
  const initial = useMemo(() => flattenSettings(groups), [groups]);
  const [draft, setDraft] = useState<Record<string, SettingValue>>(initial);
  const [activeTab, setActiveTab] = useState<SettingsTabId>("general");

  useEffect(() => {
    setDraft(initial);
  }, [initial]);

  const dirty = useMemo(
    () => Object.keys(draft).filter((key) => draft[key] !== initial[key]),
    [draft, initial],
  );

  const active = SETTINGS_TABS.find((tab) => tab.id === activeTab) ?? SETTINGS_TABS[0];

  return (
    <div style={pageStyle} data-testid="settings-tabs">
      <div style={tabBarStyle} role="tablist" aria-label="Application settings">
        {SETTINGS_TABS.map((tab) => (
          <button
            key={tab.id}
            type="button"
            role="tab"
            aria-selected={tab.id === activeTab}
            data-testid={`settings-tab-${tab.id}`}
            style={tab.id === activeTab ? activeTabStyle : tabStyle}
            onClick={() => setActiveTab(tab.id)}
          >
            {tab.label}
          </button>
        ))}
      </div>

      {error !== null ? (
        <div data-testid="settings-error" style={{ ...errorStyle, marginBottom: "12px" }}>
          {error}
        </div>
      ) : null}

      {active.kind === "settings" ? (
        <div style={panelStyle} data-testid={`settings-panel-${active.id}`}>
          {Object.entries(groups[active.id] ?? {}).map(([name, entry]) => {
            const settingKey = `${active.id}.${name}`;
            if (entry.masked) {
              return (
                <div key={settingKey} data-testid={`setting-masked-${settingKey}`} style={labelStyle}>
                  {settingKey} (masked)
                </div>
              );
            }
            return (
              <SettingsField
                key={settingKey}
                settingKey={settingKey}
                value={draft[settingKey] ?? (entry.value as SettingValue)}
                error={fieldErrors[settingKey]}
                onChange={(value) => setDraft((current) => ({ ...current, [settingKey]: value }))}
              />
            );
          })}

          <button
            type="button"
            data-testid="settings-save"
            style={{ ...buttonStyle, opacity: saving || dirty.length === 0 ? 0.6 : 1 }}
            disabled={saving || dirty.length === 0}
            onClick={() => {
              const changes: Record<string, SettingValue> = {};
              for (const key of dirty) changes[key] = draft[key];
              onSave(changes);
            }}
          >
            {saving ? "Saving..." : "Save changes"}
          </button>
          {status !== null ? (
            <span data-testid="settings-status" style={{ color: "var(--success-text)", fontSize: "13px" }}>
              {status}
            </span>
          ) : null}
        </div>
      ) : null}

      {active.kind === "link" && active.href !== undefined ? (
        <div style={panelStyle} data-testid={`settings-panel-${active.id}`}>
          <p style={{ color: "var(--text-soft)", margin: 0 }}>
            {active.id === "branding"
              ? "Colours, logo, watermark, footer, and per-report defaults have their own page."
              : "Feature flags gate nav items and endpoints; they have their own page."}
          </p>
          <a data-testid={`settings-link-${active.id}`} href={active.href} style={buttonStyle}>
            Open {active.label}
          </a>
        </div>
      ) : null}

      {active.kind === "handoff" ? (
        <div style={panelStyle} data-testid={`settings-panel-${active.id}`}>
          <p data-testid={`settings-handoff-${active.id}`} style={{ color: "var(--text-soft)", margin: 0 }}>
            {active.note}
          </p>
        </div>
      ) : null}
    </div>
  );
}
