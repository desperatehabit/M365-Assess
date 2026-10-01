"use client";

// Copilot Settings page (EPIC-041 SPEC.md §3.3, §4, §8; T-0806). Renders the
// tenant's current Copilot settings read from the tenant, previews a plan
// (current-vs-proposed diff), and applies through the standards-style flow:
// explicit confirmation with a reason; the apply is admin-gated and audited
// server-side. Report theme tokens only, zero colour literals.

import React, { useCallback, useEffect, useState, type CSSProperties, type ReactElement } from "react";
import { useCurrentTenantId } from "../../../lib/useCurrentTenant";

// ─── API client (kept in-page; the seam is the route module) ─────────────────

type Fetcher = typeof fetch;

export interface CopilotSettings {
  readonly meetingCopilot: boolean;
  readonly meetingSummary: boolean;
  readonly peopleGrounding: boolean;
  readonly webGrounding: boolean;
  readonly enterpriseSearch: boolean;
}

export interface CopilotSettingsChange {
  readonly setting: keyof CopilotSettings;
  readonly before: boolean;
  readonly after: boolean;
}

export interface CopilotSettingsPlan {
  readonly changes: readonly CopilotSettingsChange[];
  readonly hasChanges: boolean;
  readonly proposed: CopilotSettings;
}

export interface CopilotSettingsPreview {
  readonly tenantId: string;
  readonly dryRun: true;
  readonly current: CopilotSettings;
  readonly proposed: CopilotSettings;
  readonly changes: readonly CopilotSettingsChange[];
  readonly hasChanges: boolean;
  readonly applied: null;
}

export interface CopilotSettingsApplyResult {
  readonly tenantId: string;
  readonly dryRun: false;
  readonly reason: string;
  readonly before: CopilotSettings;
  readonly proposed: CopilotSettings;
  readonly changes: readonly CopilotSettingsChange[];
  readonly hasChanges: boolean;
  readonly after: CopilotSettings | null;
}

export const COPILOT_SETTING_LABELS: Readonly<Record<keyof CopilotSettings, string>> = Object.freeze({
  meetingCopilot: "Copilot in Teams meetings",
  meetingSummary: "Meeting summaries and recaps",
  peopleGrounding: "People grounding",
  webGrounding: "Web grounding",
  enterpriseSearch: "Enterprise search grounding",
});

export const COPILOT_SETTING_ORDER: readonly (keyof CopilotSettings)[] = Object.freeze([
  "meetingCopilot",
  "meetingSummary",
  "peopleGrounding",
  "webGrounding",
  "enterpriseSearch",
]);

function asFetcher(fetcher?: Fetcher): Fetcher {
  return fetcher ?? fetch;
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
  return response.json() as Promise<T>;
}

export async function fetchCopilotSettings(
  tenantId: string,
  fetcher?: Fetcher,
): Promise<CopilotSettings> {
  const body = await readJson<{ settings: CopilotSettings }>(
    await asFetcher(fetcher)(`/v1/tenants/${encodeURIComponent(tenantId)}/copilot/settings`),
    "Loading Copilot settings",
  );
  return body.settings;
}

export async function previewCopilotSettings(
  tenantId: string,
  settings: Partial<CopilotSettings>,
  fetcher?: Fetcher,
): Promise<CopilotSettingsPreview> {
  return readJson<CopilotSettingsPreview>(
    await asFetcher(fetcher)(`/v1/tenants/${encodeURIComponent(tenantId)}/copilot/settings/apply`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ settings, preview: true }),
    }),
    "Previewing Copilot settings",
  );
}

export async function applyCopilotSettings(
  tenantId: string,
  settings: Partial<CopilotSettings>,
  reason: string,
  fetcher?: Fetcher,
): Promise<CopilotSettingsApplyResult> {
  return readJson<CopilotSettingsApplyResult>(
    await asFetcher(fetcher)(`/v1/tenants/${encodeURIComponent(tenantId)}/copilot/settings/apply`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ settings, confirm: true, reason }),
    }),
    "Applying Copilot settings",
  );
}

// ─── Page ─────────────────────────────────────────────────────────────────────

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
  alignItems: "flex-start",
  gap: "16px",
  borderBottom: "1px solid var(--border)",
  paddingBottom: "16px",
  flexWrap: "wrap",
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

const inputStyle: CSSProperties = {
  padding: "8px 12px",
  background: "var(--input-bg, var(--bg))",
  border: "1px solid var(--border)",
  borderRadius: "6px",
  color: "var(--text)",
  fontSize: "14px",
};

const panelStyle: CSSProperties = {
  padding: "16px",
  background: "var(--bg-elev)",
  border: "1px solid var(--border)",
  borderRadius: "var(--radius, 10px)",
  boxShadow: "var(--shadow-card)",
};

const settingRowStyle: CSSProperties = {
  display: "flex",
  justifyContent: "space-between",
  alignItems: "center",
  gap: "16px",
  padding: "10px 12px",
  borderBottom: "1px solid var(--border)",
};

const badgeStyle = (on: boolean): CSSProperties => ({
  padding: "2px 10px",
  borderRadius: "999px",
  fontSize: "12px",
  fontWeight: 600,
  background: on ? "var(--accent-soft)" : "var(--surface)",
  color: on ? "var(--accent-text)" : "var(--text-soft)",
  border: `1px solid ${on ? "var(--accent)" : "var(--border)"}`,
});

const dialogStyle: CSSProperties = {
  position: "fixed",
  inset: 0,
  background: "var(--overlay, rgba(0,0,0,0.5))",
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  zIndex: 50,
};

export interface CopilotSettingsPageProps {
  readonly fetcher?: Fetcher;
  readonly tenantId?: string;
}

export default function CopilotSettingsPage({
  fetcher,
  tenantId = "",
}: CopilotSettingsPageProps): ReactElement {
  const doFetch = fetcher ?? fetch;
  const [tenantInput, setTenantInput] = useState(tenantId);
  const [activeTenant, setActiveTenant] = useState("");
  const currentTenant = useCurrentTenantId();
  useEffect(() => {
    if (currentTenant) {
      setTenantInput(currentTenant);
      setActiveTenant(currentTenant);
    }
  }, [currentTenant]);

  const [settings, setSettings] = useState<CopilotSettings | null>(null);
  const [proposed, setProposed] = useState<Partial<CopilotSettings>>({});
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const [preview, setPreview] = useState<CopilotSettingsPreview | null>(null);
  const [previewing, setPreviewing] = useState(false);
  const [result, setResult] = useState<CopilotSettingsApplyResult | null>(null);

  const [showApplyDialog, setShowApplyDialog] = useState(false);
  const [reason, setReason] = useState("");
  const [confirmed, setConfirmed] = useState(false);
  const [applying, setApplying] = useState(false);

  const load = useCallback(
    async (tenant: string): Promise<void> => {
      if (!tenant) return;
      setLoading(true);
      setError(null);
      setNotice(null);
      setPreview(null);
      setResult(null);
      setProposed({});
      try {
        const current = await fetchCopilotSettings(tenant, doFetch);
        setSettings(current);
        setActiveTenant(tenant);
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
        setSettings(null);
      } finally {
        setLoading(false);
      }
    },
    [doFetch],
  );

  useEffect(() => {
    if (activeTenant) void load(activeTenant);
  }, [activeTenant, load]);

  const handlePreview = async (): Promise<void> => {
    if (!activeTenant) return;
    setPreviewing(true);
    setError(null);
    setNotice(null);
    try {
      setPreview(await previewCopilotSettings(activeTenant, proposed, doFetch));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setPreview(null);
    } finally {
      setPreviewing(false);
    }
  };

  const handleApply = async (): Promise<void> => {
    if (!activeTenant || !reason.trim() || !confirmed) return;
    setApplying(true);
    setError(null);
    setNotice(null);
    try {
      const applied = await applyCopilotSettings(activeTenant, proposed, reason.trim(), doFetch);
      setResult(applied);
      setShowApplyDialog(false);
      setNotice("Copilot settings applied.");
      if (applied.after) setSettings(applied.after);
      setPreview(null);
      setProposed({});
      setReason("");
      setConfirmed(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setApplying(false);
    }
  };

  // The Apply button opens the confirmation dialog; it needs a plan with
  // changes. The dialog's own Apply button additionally needs a reason and
  // the confirmation tick.
  const openApplyDisabled = !activeTenant || previewing || applying || !preview || !preview.hasChanges;

  return (
    <div style={pageStyle} data-testid="copilot-settings-page">
      <div style={headerStyle}>
        <div>
          <h1 style={titleStyle}>Copilot Settings</h1>
          <p style={subtitleStyle}>
            Tenant Copilot configuration with a plan preview and a confirmation-gated, audited apply.
          </p>
        </div>
        <div style={{ display: "flex", gap: "8px", alignItems: "center", flexWrap: "wrap" }}>
          <input
            type="text"
            placeholder="Tenant id"
            value={tenantInput}
            onChange={(e) => setTenantInput(e.target.value)}
            style={inputStyle}
            aria-label="Tenant id"
            data-testid="copilot-settings-tenant"
          />
          <button
            type="button"
            style={buttonStyle}
            onClick={() => void load(tenantInput.trim())}
            data-testid="copilot-settings-load"
          >
            Load
          </button>
        </div>
      </div>

      {notice && (
        <div
          style={{
            padding: "10px 14px",
            background: "var(--accent-soft)",
            border: "1px solid var(--accent)",
            borderRadius: "6px",
            color: "var(--accent-text)",
            fontSize: "13px",
          }}
          data-testid="copilot-settings-notice"
        >
          {notice}
        </div>
      )}
      {error && (
        <div
          style={{
            padding: "12px",
            background: "var(--danger-soft)",
            border: "1px solid var(--danger)",
            borderRadius: "6px",
            color: "var(--danger-text)",
          }}
          role="alert"
          data-testid="copilot-settings-error"
        >
          {error}
        </div>
      )}

      <div style={panelStyle} data-testid="copilot-settings-panel">
        {loading && <div style={{ color: "var(--text-soft)" }}>Loading settings...</div>}
        {!loading && !settings && (
          <div style={{ color: "var(--text-soft)" }} data-testid="copilot-settings-empty">
            Load a tenant to see its current Copilot settings.
          </div>
        )}
        {!loading && settings && (
          <>
            <div style={{ display: "flex", justifyContent: "flex-end", gap: "8px", marginBottom: "8px" }}>
              <button
                type="button"
                style={buttonStyle}
                onClick={() => void handlePreview()}
                disabled={previewing}
                data-testid="copilot-settings-preview"
              >
                {previewing ? "Previewing..." : "Preview changes"}
              </button>
              <button
                type="button"
                style={openApplyDisabled ? buttonStyle : primaryButtonStyle}
                onClick={() => setShowApplyDialog(true)}
                disabled={openApplyDisabled}
                data-testid="copilot-settings-apply"
              >
                Apply
              </button>
            </div>
            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "14px" }} aria-label="Copilot settings">
              <thead>
                <tr>
                  <th
                    style={{
                      padding: "10px 12px",
                      borderBottom: "1px solid var(--border)",
                      color: "var(--text-soft)",
                      fontSize: "12px",
                      textTransform: "uppercase",
                      textAlign: "left",
                    }}
                  >
                    Setting
                  </th>
                  <th
                    style={{
                      padding: "10px 12px",
                      borderBottom: "1px solid var(--border)",
                      color: "var(--text-soft)",
                      fontSize: "12px",
                      textTransform: "uppercase",
                      textAlign: "left",
                    }}
                  >
                    Current
                  </th>
                  <th
                    style={{
                      padding: "10px 12px",
                      borderBottom: "1px solid var(--border)",
                      color: "var(--text-soft)",
                      fontSize: "12px",
                      textTransform: "uppercase",
                      textAlign: "left",
                    }}
                  >
                    Proposed
                  </th>
                </tr>
              </thead>
              <tbody>
                {COPILOT_SETTING_ORDER.map((key) => {
                  const currentValue = settings[key];
                  const proposedValue = proposed[key];
                  const draft = proposedValue ?? currentValue;
                  return (
                    <tr key={key} data-testid={`copilot-setting-${key}`}>
                      <td style={{ padding: "10px 12px", borderBottom: "1px solid var(--border)" }}>
                        {COPILOT_SETTING_LABELS[key]}
                      </td>
                      <td style={{ padding: "10px 12px", borderBottom: "1px solid var(--border)" }}>
                        <span style={badgeStyle(currentValue)} data-testid={`copilot-current-${key}`}>
                          {currentValue ? "On" : "Off"}
                        </span>
                      </td>
                      <td style={{ padding: "10px 12px", borderBottom: "1px solid var(--border)" }}>
                        <label
                          style={{ display: "inline-flex", alignItems: "center", gap: "8px", cursor: "pointer" }}
                        >
                          <input
                            type="checkbox"
                            checked={draft}
                            onChange={(e) => setProposed((prev) => ({ ...prev, [key]: e.target.checked }))}
                            data-testid={`copilot-proposed-${key}`}
                            aria-label={`Proposed ${COPILOT_SETTING_LABELS[key]}`}
                          />
                          <span style={badgeStyle(draft)}>{draft ? "On" : "Off"}</span>
                        </label>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </>
        )}
      </div>

      {preview && (
        <div style={panelStyle} data-testid="copilot-settings-preview-panel">
          <div style={{ fontSize: "16px", fontWeight: 600, marginBottom: "8px" }}>
            Plan preview{preview.hasChanges ? "" : " — no changes"}
          </div>
          {preview.changes.length === 0 ? (
            <div style={{ color: "var(--text-soft)" }} data-testid="copilot-preview-empty">
              The proposed settings match the current tenant configuration.
            </div>
          ) : (
            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "14px" }} aria-label="Plan preview">
              <thead>
                <tr>
                  <th
                    style={{
                      padding: "10px 12px",
                      borderBottom: "1px solid var(--border)",
                      color: "var(--text-soft)",
                      fontSize: "12px",
                      textTransform: "uppercase",
                      textAlign: "left",
                    }}
                  >
                    Setting
                  </th>
                  <th
                    style={{
                      padding: "10px 12px",
                      borderBottom: "1px solid var(--border)",
                      color: "var(--text-soft)",
                      fontSize: "12px",
                      textTransform: "uppercase",
                      textAlign: "left",
                    }}
                  >
                    Before
                  </th>
                  <th
                    style={{
                      padding: "10px 12px",
                      borderBottom: "1px solid var(--border)",
                      color: "var(--text-soft)",
                      fontSize: "12px",
                      textTransform: "uppercase",
                      textAlign: "left",
                    }}
                  >
                    After
                  </th>
                </tr>
              </thead>
              <tbody>
                {preview.changes.map((change) => (
                  <tr key={change.setting} data-testid={`copilot-change-${change.setting}`}>
                    <td style={{ padding: "10px 12px", borderBottom: "1px solid var(--border)" }}>
                      {COPILOT_SETTING_LABELS[change.setting]}
                    </td>
                    <td style={{ padding: "10px 12px", borderBottom: "1px solid var(--border)" }}>
                      {change.before ? "On" : "Off"}
                    </td>
                    <td style={{ padding: "10px 12px", borderBottom: "1px solid var(--border)" }}>
                      {change.after ? "On" : "Off"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      )}

      {result && (
        <div style={panelStyle} data-testid="copilot-settings-result">
          <div style={{ fontSize: "16px", fontWeight: 600, marginBottom: "8px" }}>
            Applied — {result.changes.length} setting{result.changes.length === 1 ? "" : "s"} changed
          </div>
          {result.after && (
            <div style={{ display: "flex", gap: "24px", flexWrap: "wrap" }}>
              <div>
                <div style={{ fontSize: "12px", color: "var(--text-soft)", textTransform: "uppercase" }}>Before</div>
                <pre
                  style={{
                    fontFamily: "var(--font-mono, monospace)",
                    fontSize: "12px",
                    whiteSpace: "pre-wrap",
                    wordBreak: "break-word",
                    margin: "4px 0 0",
                  }}
                >
                  {JSON.stringify(result.before, null, 2)}
                </pre>
              </div>
              <div>
                <div style={{ fontSize: "12px", color: "var(--text-soft)", textTransform: "uppercase" }}>After</div>
                <pre
                  style={{
                    fontFamily: "var(--font-mono, monospace)",
                    fontSize: "12px",
                    whiteSpace: "pre-wrap",
                    wordBreak: "break-word",
                    margin: "4px 0 0",
                  }}
                >
                  {JSON.stringify(result.after, null, 2)}
                </pre>
              </div>
            </div>
          )}
        </div>
      )}

      {showApplyDialog && (
        <div style={dialogStyle} data-testid="copilot-settings-apply-dialog">
          <div style={{ ...panelStyle, width: "min(420px, 100%)", display: "flex", flexDirection: "column", gap: "12px" }}>
            <h2 style={{ margin: 0, fontSize: "16px" }}>Apply Copilot settings</h2>
            <div style={{ fontSize: "13px", color: "var(--text-soft)" }}>
              Tenant: {activeTenant}. This is a tenant write; it requires the admin role and is audited.
            </div>
            <label style={{ display: "flex", flexDirection: "column", gap: "6px", fontSize: "13px" }}>
              Reason (required)
              <input
                type="text"
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                style={inputStyle}
                data-testid="copilot-settings-reason"
              />
            </label>
            <label style={{ display: "flex", alignItems: "center", gap: "8px", fontSize: "13px" }}>
              <input
                type="checkbox"
                checked={confirmed}
                onChange={(e) => setConfirmed(e.target.checked)}
                data-testid="copilot-settings-confirm"
              />
              I confirm these Copilot settings changes
            </label>
            <div style={{ display: "flex", justifyContent: "flex-end", gap: "8px" }}>
              <button
                type="button"
                style={buttonStyle}
                onClick={() => setShowApplyDialog(false)}
                data-testid="copilot-settings-apply-cancel"
              >
                Cancel
              </button>
              <button
                type="button"
                style={applying ? primaryButtonStyle : buttonStyle}
                onClick={() => void handleApply()}
                disabled={applying || !reason.trim() || !confirmed}
                data-testid="copilot-settings-apply-confirm"
              >
                {applying ? "Applying..." : "Apply"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
