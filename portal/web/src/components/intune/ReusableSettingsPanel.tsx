"use client";

// Intune reusable settings (EPIC-016 SPEC.md §3.3, US-4; T-0885).
// Lists the reusable setting templates and the tenant's live settings, edits
// templates through the mounted /v1/intune-reusable-setting-templates routes,
// and previews/applies a sync through the tenant's reusable-settings route.
import React, { useCallback, useEffect, useMemo, useState, type CSSProperties, type ReactElement } from "react";
import {
  createReusableSettingTemplate,
  deleteReusableSettingTemplate,
  listLiveReusableSettings,
  listReusableSettingTemplates,
  syncReusableSettings,
  updateReusableSettingTemplate,
  type LiveReusableSetting,
  type ReusableSettingTemplate,
  type ReusableSettingsSyncResult,
} from "../../lib/intuneApi";

const SETTING_TYPES = [
  {
    key: "firewallRemoteAddresses",
    label: "Firewall remote IP address ranges",
    prefix: "vendor_msft_firewall_mdmstore_dynamickeywords_addresses_",
  },
  {
    key: "deviceControlGroups",
    label: "Defender device control groups",
    prefix: "device_vendor_msft_defender_configuration_devicecontrol_policygroups_",
  },
] as const;

type SettingTypeKey = (typeof SETTING_TYPES)[number]["key"];

const panelStyle: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: "18px",
  fontFamily: "var(--font-sans, system-ui, sans-serif)",
  color: "var(--text)",
};

const headerStyle: CSSProperties = {
  display: "flex",
  justifyContent: "space-between",
  alignItems: "flex-start",
  gap: "16px",
  flexWrap: "wrap",
};

const titleStyle: CSSProperties = {
  fontSize: "22px",
  fontWeight: 700,
  margin: 0,
  fontFamily: "var(--font-display, var(--font-sans))",
};

const subtitleStyle: CSSProperties = { margin: "4px 0 0", color: "var(--text-soft)", fontSize: "14px" };

const buttonStyle: CSSProperties = {
  padding: "8px 14px",
  background: "var(--surface)",
  border: "1px solid var(--border)",
  borderRadius: "6px",
  color: "var(--text)",
  fontSize: "14px",
  fontWeight: 500,
  cursor: "pointer",
};

const primaryButtonStyle: CSSProperties = {
  ...buttonStyle,
  background: "var(--accent)",
  color: "var(--on-accent)",
  borderColor: "var(--accent)",
};

const actionButtonStyle: CSSProperties = {
  padding: "4px 8px",
  background: "var(--surface)",
  border: "1px solid var(--border)",
  borderRadius: "4px",
  color: "var(--text)",
  fontSize: "12px",
  cursor: "pointer",
};

const cardStyle: CSSProperties = {
  padding: "16px",
  background: "var(--bg-elev)",
  border: "1px solid var(--border)",
  borderRadius: "var(--radius, 10px)",
  display: "flex",
  flexDirection: "column",
  gap: "12px",
};

const tableWrapStyle: CSSProperties = {
  overflowX: "auto",
  background: "var(--bg-elev)",
  border: "1px solid var(--border)",
  borderRadius: "var(--radius, 10px)",
};

const tableStyle: CSSProperties = { width: "100%", borderCollapse: "collapse", fontSize: "13px" };

const thStyle: CSSProperties = {
  textAlign: "left",
  padding: "10px 12px",
  borderBottom: "1px solid var(--border)",
  color: "var(--text-soft)",
  fontWeight: 600,
  whiteSpace: "nowrap",
};

const tdStyle: CSSProperties = {
  padding: "10px 12px",
  borderBottom: "1px solid var(--border)",
  verticalAlign: "top",
};

const labelStyle: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: "6px",
  fontSize: "13px",
  fontWeight: 600,
};

const inputStyle: CSSProperties = {
  padding: "8px 12px",
  background: "var(--input-bg, var(--bg))",
  border: "1px solid var(--border)",
  borderRadius: "6px",
  color: "var(--text)",
  fontSize: "14px",
};

const textareaStyle: CSSProperties = {
  ...inputStyle,
  minHeight: "180px",
  fontFamily: "monospace",
  fontSize: "12px",
};

const errorStyle: CSSProperties = {
  padding: "10px 14px",
  background: "var(--danger-soft)",
  border: "1px solid var(--danger)",
  borderRadius: "6px",
  color: "var(--danger-text)",
  fontSize: "13px",
};

const noticeStyle: CSSProperties = {
  padding: "10px 14px",
  background: "var(--accent-soft)",
  border: "1px solid var(--accent)",
  borderRadius: "6px",
  color: "var(--accent-text)",
  fontSize: "13px",
  display: "flex",
  gap: "12px",
  alignItems: "center",
  flexWrap: "wrap",
};

export interface ReusableSettingsPanelProps {
  readonly tenantId: string;
}

export function defaultSettingsJson(name: string, type: SettingTypeKey): string {
  const entry = SETTING_TYPES.find((candidate) => candidate.key === type) ?? SETTING_TYPES[0];
  return JSON.stringify(
    {
      "@odata.type": "#microsoft.graph.deviceManagementReusablePolicySetting",
      displayName: name || "Reusable setting",
      settingInstance: {
        "@odata.type": "#microsoft.graph.deviceManagementConfigurationSimpleSettingInstance",
        settingDefinitionId: `${entry.prefix}value`,
        simpleSettingValue: { value: "" },
      },
    },
    null,
    2,
  );
}

function typeLabel(template: ReusableSettingTemplate): string {
  const instance = template.settingsJson["settingInstance"];
  const definition =
    typeof instance === "object" && instance !== null
      ? (instance as Record<string, unknown>)["settingDefinitionId"]
      : undefined;
  const match = SETTING_TYPES.find(
    (candidate) => typeof definition === "string" && definition.startsWith(candidate.prefix),
  );
  return match?.label ?? "Unsupported";
}

export function ReusableSettingsPanel({ tenantId }: ReusableSettingsPanelProps): ReactElement {
  const [templates, setTemplates] = useState<readonly ReusableSettingTemplate[]>([]);
  const [live, setLive] = useState<readonly LiveReusableSetting[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [editing, setEditing] = useState<ReusableSettingTemplate | null>(null);
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState("");
  const [type, setType] = useState<SettingTypeKey>("firewallRemoteAddresses");
  const [settingsJson, setSettingsJson] = useState(defaultSettingsJson("", "firewallRemoteAddresses"));
  const [saving, setSaving] = useState(false);
  const [preview, setPreview] = useState<ReusableSettingsSyncResult | null>(null);
  const [syncing, setSyncing] = useState(false);

  const load = useCallback(async (): Promise<void> => {
    setLoading(true);
    setError(null);
    try {
      const [templateItems, liveItems] = await Promise.all([
        listReusableSettingTemplates(),
        listLiveReusableSettings(tenantId),
      ]);
      setTemplates(templateItems);
      setLive(liveItems);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setTemplates([]);
      setLive([]);
    } finally {
      setLoading(false);
    }
  }, [tenantId]);

  useEffect(() => {
    void load();
  }, [load]);

  const openCreate = (): void => {
    setCreating(true);
    setEditing(null);
    setName("");
    setType("firewallRemoteAddresses");
    setSettingsJson(defaultSettingsJson("", "firewallRemoteAddresses"));
    setNotice(null);
  };

  const openEdit = (template: ReusableSettingTemplate): void => {
    setCreating(false);
    setEditing(template);
    setName(template.name);
    setSettingsJson(JSON.stringify(template.settingsJson, null, 2));
    setNotice(null);
  };

  const closeEditor = (): void => {
    setCreating(false);
    setEditing(null);
    setError(null);
  };

  const parsedSettings = useMemo((): { value: Record<string, unknown> | null; error: string | null } => {
    try {
      const parsed = JSON.parse(settingsJson) as unknown;
      if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
        return { value: null, error: "Settings JSON must be an object." };
      }
      return { value: parsed as Record<string, unknown>, error: null };
    } catch (err) {
      return { value: null, error: err instanceof Error ? err.message : "Invalid JSON" };
    }
  }, [settingsJson]);

  const handleSave = async (): Promise<void> => {
    if (!name.trim() || parsedSettings.value === null) {
      setError(parsedSettings.error ?? "Name is required.");
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const payload = {
        name: name.trim(),
        settingsJson: { ...parsedSettings.value, displayName: name.trim() },
      };
      if (editing) {
        await updateReusableSettingTemplate(editing.id, payload);
      } else {
        await createReusableSettingTemplate(payload);
      }
      closeEditor();
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async (template: ReusableSettingTemplate): Promise<void> => {
    if (!window.confirm(`Delete reusable setting template “${template.name}”?`)) return;
    setError(null);
    try {
      await deleteReusableSettingTemplate(template.id);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const runSync = async (previewOnly: boolean, templateId?: string): Promise<void> => {
    setSyncing(true);
    setError(null);
    setNotice(null);
    try {
      const result = await syncReusableSettings(
        tenantId,
        templateId ? [templateId] : templates.map((template) => template.id),
        previewOnly,
      );
      if (previewOnly) {
        setPreview(result);
        const count = result.changes.filter((change) => change.action !== "none").length;
        setNotice(`Preview: ${count} setting change(s) across ${result.changes.length} template(s).`);
      } else {
        setPreview(null);
        const written = result.results.filter((row) => row.status === "succeeded").length;
        setNotice(`Synced ${written} template(s) to ${tenantId}.`);
        await load();
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSyncing(false);
    }
  };

  if (creating || editing) {
    return (
      <div style={panelStyle} data-testid="reusable-settings-panel">
        <div style={cardStyle} data-testid="reusable-template-editor">
          <h2 style={{ ...titleStyle, fontSize: "18px" }}>
            {editing ? `Edit “${editing.name}”` : "New reusable setting template"}
          </h2>
          <label style={labelStyle}>
            Name
            <input
              style={inputStyle}
              data-testid="reusable-template-name"
              value={name}
              onChange={(event) => setName(event.target.value)}
            />
          </label>
          {creating && (
            <label style={labelStyle}>
              Type
              <select
                style={inputStyle}
                data-testid="reusable-template-type"
                value={type}
                onChange={(event) => {
                  const next = event.target.value as SettingTypeKey;
                  setType(next);
                  setSettingsJson(defaultSettingsJson(name, next));
                }}
              >
                {SETTING_TYPES.map((entry) => (
                  <option key={entry.key} value={entry.key}>
                    {entry.label}
                  </option>
                ))}
              </select>
            </label>
          )}
          <label style={labelStyle}>
            Settings JSON
            <textarea
              style={textareaStyle}
              data-testid="reusable-template-json"
              value={settingsJson}
              onChange={(event) => setSettingsJson(event.target.value)}
            />
          </label>
          {parsedSettings.error && (
            <div style={errorStyle} data-testid="reusable-template-json-error">
              {parsedSettings.error}
            </div>
          )}
          {error && (
            <div style={errorStyle} role="alert" data-testid="reusable-settings-error">
              {error}
            </div>
          )}
          <div style={{ display: "flex", gap: "10px" }}>
            <button
              type="button"
              style={primaryButtonStyle}
              data-testid="reusable-template-save"
              disabled={saving || parsedSettings.value === null}
              onClick={() => void handleSave()}
            >
              {saving ? "Saving…" : "Save template"}
            </button>
            <button type="button" style={buttonStyle} onClick={closeEditor}>
              Cancel
            </button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div style={panelStyle} data-testid="reusable-settings-panel">
      <div style={headerStyle}>
        <div>
          <h1 style={titleStyle}>Reusable Settings</h1>
          <p style={subtitleStyle}>
            Shared Intune settings that policies reference. Sync templates into the tenant to create
            or update the live setting.
          </p>
        </div>
        <div style={{ display: "flex", gap: "10px", flexWrap: "wrap" }}>
          <button
            type="button"
            style={buttonStyle}
            data-testid="reusable-sync-all"
            disabled={syncing || templates.length === 0}
            onClick={() => void runSync(true)}
          >
            {syncing ? "Syncing…" : "Preview sync all"}
          </button>
          <button type="button" style={primaryButtonStyle} data-testid="reusable-add" onClick={openCreate}>
            Add template
          </button>
        </div>
      </div>

      {error && (
        <div style={errorStyle} role="alert" data-testid="reusable-settings-error">
          {error}
        </div>
      )}

      {notice && (
        <div style={noticeStyle} data-testid="reusable-settings-notice">
          <span>{notice}</span>
          {preview && (
            <button
              type="button"
              style={actionButtonStyle}
              data-testid="reusable-sync-apply"
              disabled={syncing}
              onClick={() => void runSync(false)}
            >
              Apply sync
            </button>
          )}
        </div>
      )}

      <section style={cardStyle} aria-label="Reusable setting templates">
        <h2 style={{ ...titleStyle, fontSize: "16px" }}>Templates</h2>
        <div style={tableWrapStyle}>
          <table style={tableStyle} data-testid="reusable-template-table">
            <thead>
              <tr>
                <th style={thStyle}>Name</th>
                <th style={thStyle}>Type</th>
                <th style={thStyle}>Updated</th>
                <th style={thStyle}>Actions</th>
              </tr>
            </thead>
            <tbody>
              {templates.map((template) => (
                <tr key={template.id} data-testid={`reusable-template-row-${template.id}`}>
                  <td style={tdStyle}>{template.name}</td>
                  <td style={tdStyle}>{typeLabel(template)}</td>
                  <td style={tdStyle}>{template.updatedAt}</td>
                  <td style={tdStyle}>
                    <div style={{ display: "flex", gap: "6px", flexWrap: "wrap" }}>
                      <button
                        type="button"
                        style={actionButtonStyle}
                        data-testid={`reusable-template-edit-${template.id}`}
                        onClick={() => openEdit(template)}
                      >
                        Edit
                      </button>
                      <button
                        type="button"
                        style={actionButtonStyle}
                        data-testid={`reusable-template-sync-${template.id}`}
                        disabled={syncing}
                        onClick={() => void runSync(true, template.id)}
                      >
                        Preview sync
                      </button>
                      <button
                        type="button"
                        style={actionButtonStyle}
                        data-testid={`reusable-template-delete-${template.id}`}
                        onClick={() => void handleDelete(template)}
                      >
                        Delete
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
              {!loading && templates.length === 0 && (
                <tr>
                  <td colSpan={4} style={{ ...tdStyle, textAlign: "center", color: "var(--text-soft)" }} data-testid="reusable-template-empty">
                    No reusable setting templates yet. Add one to sync it into the tenant.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </section>

      <section style={cardStyle} aria-label="Live reusable settings">
        <h2 style={{ ...titleStyle, fontSize: "16px" }}>Live settings in {tenantId}</h2>
        <div style={tableWrapStyle}>
          <table style={tableStyle} data-testid="reusable-live-table">
            <thead>
              <tr>
                <th style={thStyle}>Name</th>
                <th style={thStyle}>Type</th>
                <th style={thStyle}>In scope</th>
                <th style={thStyle}>Referencing policies</th>
              </tr>
            </thead>
            <tbody>
              {live.map((setting) => (
                <tr key={setting.id} data-testid={`reusable-live-row-${setting.id}`}>
                  <td style={tdStyle}>{setting.displayName}</td>
                  <td style={tdStyle}>{setting.type ?? "—"}</td>
                  <td style={tdStyle}>{setting.inScope ? "Yes" : "No"}</td>
                  <td style={tdStyle}>{setting.referencingPolicyCount}</td>
                </tr>
              ))}
              {!loading && live.length === 0 && (
                <tr>
                  <td colSpan={4} style={{ ...tdStyle, textAlign: "center", color: "var(--text-soft)" }} data-testid="reusable-live-empty">
                    No reusable settings are live in this tenant.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}
