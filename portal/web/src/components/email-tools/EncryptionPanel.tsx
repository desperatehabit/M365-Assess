"use client";

// Message encryption panel (EPIC-024 SPEC.md §2 US-5, §3.5, §4.3; T-0469).
// Renders the IRM/OME configuration and OME template settings read from the
// BFF, plus the OME template editor: plan preview (dry run) then apply with
// confirmation. The panel never fetches on its own — the page owns the BFF
// calls and passes preview/apply callbacks. Write controls render only when
// `canWrite` (RBAC) is set. Strictly uses report theme tokens with zero
// colour literals.

import React, { type CSSProperties, type ReactElement } from "react";

export interface EncryptionIrmConfiguration {
  readonly identity: string;
  readonly azureRmsLicensingEnabled: boolean;
  readonly internalLicensingEnabled: boolean;
  readonly externalLicensingEnabled: boolean;
}

export interface EncryptionOmeTemplate {
  readonly identity: string;
  readonly externalMailExpiryInDays: number | null;
  readonly portalText: string;
  readonly disclaimerText: string;
  readonly emailText: string;
  readonly readButtonText: string;
  readonly introductionText: string;
}

export interface MessageEncryptionConfig {
  readonly tenantId: string;
  readonly irmConfiguration: EncryptionIrmConfiguration;
  readonly omeTemplates: readonly EncryptionOmeTemplate[];
  readonly retrievedAt: string;
}

export interface EncryptionTemplatePlan {
  readonly action: "ome-template-apply";
  readonly templateId: string;
  readonly targetName: string;
  readonly before?: Record<string, unknown> | null;
  readonly after?: Record<string, unknown> | null;
  readonly diff: readonly string[];
  readonly valid: boolean;
  readonly dryRun: boolean;
  readonly requiresConfirmation: boolean;
}

export interface EncryptionTemplateAuditEvent {
  readonly id: string;
  readonly tenantId: string;
  readonly action: string;
  readonly targetId: string;
  readonly targetName: string;
  readonly timestamp: string;
  readonly before?: Record<string, unknown> | null;
  readonly after?: Record<string, unknown> | null;
}

export interface EncryptionTemplateResult {
  readonly success: boolean;
  readonly plan: EncryptionTemplatePlan;
  readonly result?: Record<string, unknown>;
  readonly auditEvent?: EncryptionTemplateAuditEvent;
}

export type EncryptionTemplateOutcome = EncryptionTemplatePlan | EncryptionTemplateResult;

export interface EncryptionPanelProps {
  readonly config?: MessageEncryptionConfig | null;
  readonly loading?: boolean;
  readonly error?: string | null;
  readonly canWrite?: boolean;
  readonly onPreview?: (
    templateId: string,
    settings: Record<string, string>,
  ) => Promise<EncryptionTemplateOutcome>;
  readonly onApply?: (
    templateId: string,
    settings: Record<string, string>,
  ) => Promise<EncryptionTemplateOutcome>;
}

const containerStyle: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: "12px",
  fontFamily: "var(--font-sans, system-ui, sans-serif)",
  color: "var(--text)",
};

const sectionStyle: CSSProperties = {
  background: "var(--bg-elev)",
  border: "1px solid var(--border)",
  borderRadius: "var(--radius, 10px)",
  padding: "16px",
  display: "flex",
  flexDirection: "column",
  gap: "8px",
};

const sectionTitleStyle: CSSProperties = {
  fontSize: "13px",
  fontWeight: 600,
  margin: 0,
};

const metaStyle: CSSProperties = {
  fontSize: "13px",
  margin: 0,
};

const flagListStyle: CSSProperties = {
  margin: 0,
  paddingLeft: "18px",
  fontSize: "13px",
  display: "flex",
  flexDirection: "column",
  gap: "4px",
};

const tableStyle: CSSProperties = { width: "100%", borderCollapse: "collapse", fontSize: "13px" };

const thStyle: CSSProperties = {
  textAlign: "left",
  padding: "8px 10px",
  borderBottom: "1px solid var(--border-strong, var(--border))",
  color: "var(--text-soft)",
  fontSize: "12px",
  textTransform: "uppercase",
  letterSpacing: "0.07em",
};

const tdStyle: CSSProperties = {
  padding: "8px 10px",
  borderBottom: "1px solid var(--border)",
  verticalAlign: "top",
};

const formStyle: CSSProperties = {
  display: "grid",
  gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))",
  gap: "10px",
};

const fieldStyle: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: "4px",
};

const fieldLabelStyle: CSSProperties = {
  fontSize: "12px",
  fontWeight: 600,
  color: "var(--text-soft)",
};

const inputStyle: CSSProperties = {
  padding: "8px 10px",
  background: "var(--input-bg, var(--bg))",
  border: "1px solid var(--border)",
  borderRadius: "6px",
  color: "var(--text)",
  fontSize: "13px",
  fontFamily: "inherit",
};

const buttonRowStyle: CSSProperties = {
  display: "flex",
  gap: "8px",
  flexWrap: "wrap",
};

const buttonStyle: CSSProperties = {
  padding: "8px 14px",
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

const diffListStyle: CSSProperties = {
  margin: 0,
  paddingLeft: "18px",
  fontSize: "13px",
  display: "flex",
  flexDirection: "column",
  gap: "4px",
};

const noticeStyle: CSSProperties = {
  fontSize: "13px",
  margin: 0,
  color: "var(--text-soft)",
};

function Section({ title, testId, children }: { title: string; testId: string; children: React.ReactNode }): ReactElement {
  return (
    <section style={sectionStyle} data-testid={testId}>
      <h3 style={sectionTitleStyle}>{title}</h3>
      {children}
    </section>
  );
}

function Flag({ label, enabled }: { label: string; enabled: boolean }): ReactElement {
  return (
    <li data-testid={enabled ? "encryption-irm-flag-enabled" : "encryption-irm-flag-disabled"}>
      {label}: {enabled ? "Enabled" : "Disabled"}
    </li>
  );
}

function textOrEmpty(value: string | null | undefined): string {
  return value && value.length > 0 ? value : "—";
}

export function EncryptionPanel({
  config,
  loading = false,
  error,
  canWrite = false,
  onPreview,
  onApply,
}: EncryptionPanelProps): ReactElement {
  const templates = config?.omeTemplates ?? [];
  const [selectedTemplateId, setSelectedTemplateId] = React.useState("");
  const [expiryDays, setExpiryDays] = React.useState("");
  const [portalText, setPortalText] = React.useState("");
  const [disclaimerText, setDisclaimerText] = React.useState("");
  const [emailText, setEmailText] = React.useState("");
  const [readButtonText, setReadButtonText] = React.useState("");
  const [introductionText, setIntroductionText] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  const [formError, setFormError] = React.useState<string | null>(null);
  const [notice, setNotice] = React.useState<string | null>(null);
  const [outcome, setOutcome] = React.useState<EncryptionTemplateOutcome | null>(null);

  const selectedTemplate = templates.find((template) => template.identity === selectedTemplateId) ?? null;

  function selectTemplate(identity: string): void {
    const template = templates.find((item) => item.identity === identity);
    setSelectedTemplateId(identity);
    setExpiryDays(template?.externalMailExpiryInDays != null ? String(template.externalMailExpiryInDays) : "");
    setPortalText(template?.portalText ?? "");
    setDisclaimerText(template?.disclaimerText ?? "");
    setEmailText(template?.emailText ?? "");
    setReadButtonText(template?.readButtonText ?? "");
    setIntroductionText(template?.introductionText ?? "");
    setOutcome(null);
    setFormError(null);
    setNotice(null);
  }

  function currentSettings(): Record<string, string> {
    return {
      externalMailExpiryInDays: expiryDays.trim(),
      portalText,
      disclaimerText,
      emailText,
      readButtonText,
      introductionText,
    };
  }

  async function handlePreview(): Promise<void> {
    if (!selectedTemplate || !onPreview) return;
    setBusy(true);
    setFormError(null);
    setNotice(null);
    try {
      const result = await onPreview(selectedTemplate.identity, currentSettings());
      setOutcome(result);
      setNotice(
        result.dryRun
          ? "Plan preview: no change was written to the tenant."
          : "The OME template change was applied.",
      );
    } catch (err) {
      setFormError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function handleApply(): Promise<void> {
    if (!selectedTemplate || !onApply) return;
    const confirmed = window.confirm(
      `Apply the OME template change to '${selectedTemplate.identity}'? The change is audited.`,
    );
    if (!confirmed) return;
    setBusy(true);
    setFormError(null);
    setNotice(null);
    try {
      const result = await onApply(selectedTemplate.identity, currentSettings());
      setOutcome(result);
      setNotice(
        result.dryRun
          ? "Plan preview: no change was written to the tenant."
          : "The OME template change was applied and audited.",
      );
    } catch (err) {
      setFormError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  if (loading === true) {
    return (
      <div style={containerStyle} data-testid="encryption-panel-loading">
        Loading message encryption configuration…
      </div>
    );
  }

  if (typeof error === "string" && error.length > 0) {
    return (
      <div style={containerStyle} data-testid="encryption-panel-error">
        {error}
      </div>
    );
  }

  if (config === undefined || config === null) {
    return (
      <div style={containerStyle} data-testid="encryption-panel-empty">
        No message encryption configuration was returned for this tenant.
      </div>
    );
  }

  const irm = config.irmConfiguration;

  return (
    <div style={containerStyle} data-testid="encryption-panel">
      <Section title="IRM configuration" testId="encryption-irm-configuration">
        <ul style={flagListStyle} data-testid="encryption-irm-flags">
          <Flag label="Azure RMS licensing" enabled={irm.azureRmsLicensingEnabled} />
          <Flag label="Internal licensing" enabled={irm.internalLicensingEnabled} />
          <Flag label="External licensing" enabled={irm.externalLicensingEnabled} />
        </ul>
      </Section>

      <Section title="OME templates" testId="encryption-ome-templates">
        {templates.length === 0 ? (
          <p style={metaStyle} data-testid="encryption-ome-templates-empty">
            No OME templates were returned for this tenant.
          </p>
        ) : (
          <table style={tableStyle} data-testid="encryption-ome-templates-table">
            <thead>
              <tr>
                <th style={thStyle}>Template</th>
                <th style={thStyle}>Expiry (days)</th>
                <th style={thStyle}>Portal text</th>
                <th style={thStyle}>Disclaimer text</th>
                <th style={thStyle}>Email text</th>
                <th style={thStyle}>Read button</th>
                <th style={thStyle}>Introduction</th>
              </tr>
            </thead>
            <tbody>
              {templates.map((template) => (
                <tr key={template.identity} data-testid={`encryption-ome-template-${template.identity}`}>
                  <td style={tdStyle}>{template.identity}</td>
                  <td style={tdStyle}>
                    {template.externalMailExpiryInDays != null ? String(template.externalMailExpiryInDays) : "—"}
                  </td>
                  <td style={tdStyle}>{textOrEmpty(template.portalText)}</td>
                  <td style={tdStyle}>{textOrEmpty(template.disclaimerText)}</td>
                  <td style={tdStyle}>{textOrEmpty(template.emailText)}</td>
                  <td style={tdStyle}>{textOrEmpty(template.readButtonText)}</td>
                  <td style={tdStyle}>{textOrEmpty(template.introductionText)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Section>

      <Section title="OME template editor" testId="encryption-template-editor">
        {templates.length === 0 ? (
          <p style={metaStyle} data-testid="encryption-editor-empty">
            No OME template is available to edit on this tenant.
          </p>
        ) : (
          <>
            <div style={fieldStyle}>
              <label htmlFor="encryption-template-select" style={fieldLabelStyle}>
                Template
              </label>
              <select
                id="encryption-template-select"
                style={inputStyle}
                value={selectedTemplateId}
                onChange={(event) => selectTemplate(event.target.value)}
                data-testid="encryption-template-select"
              >
                <option value="">Select a template…</option>
                {templates.map((template) => (
                  <option key={template.identity} value={template.identity}>
                    {template.identity}
                  </option>
                ))}
              </select>
            </div>

            {selectedTemplate !== null && (
              <>
                <div style={formStyle}>
                  <div style={fieldStyle}>
                    <label htmlFor="encryption-expiry-days" style={fieldLabelStyle}>
                      External mail expiry (days)
                    </label>
                    <input
                      id="encryption-expiry-days"
                      style={inputStyle}
                      type="number"
                      min={0}
                      value={expiryDays}
                      onChange={(event) => setExpiryDays(event.target.value)}
                      data-testid="encryption-expiry-days"
                    />
                  </div>
                  <div style={fieldStyle}>
                    <label htmlFor="encryption-portal-text" style={fieldLabelStyle}>
                      Portal text
                    </label>
                    <input
                      id="encryption-portal-text"
                      style={inputStyle}
                      type="text"
                      value={portalText}
                      onChange={(event) => setPortalText(event.target.value)}
                      data-testid="encryption-portal-text"
                    />
                  </div>
                  <div style={fieldStyle}>
                    <label htmlFor="encryption-disclaimer-text" style={fieldLabelStyle}>
                      Disclaimer text
                    </label>
                    <input
                      id="encryption-disclaimer-text"
                      style={inputStyle}
                      type="text"
                      value={disclaimerText}
                      onChange={(event) => setDisclaimerText(event.target.value)}
                      data-testid="encryption-disclaimer-text"
                    />
                  </div>
                  <div style={fieldStyle}>
                    <label htmlFor="encryption-email-text" style={fieldLabelStyle}>
                      Email text
                    </label>
                    <input
                      id="encryption-email-text"
                      style={inputStyle}
                      type="text"
                      value={emailText}
                      onChange={(event) => setEmailText(event.target.value)}
                      data-testid="encryption-email-text"
                    />
                  </div>
                  <div style={fieldStyle}>
                    <label htmlFor="encryption-read-button-text" style={fieldLabelStyle}>
                      Read button text
                    </label>
                    <input
                      id="encryption-read-button-text"
                      style={inputStyle}
                      type="text"
                      value={readButtonText}
                      onChange={(event) => setReadButtonText(event.target.value)}
                      data-testid="encryption-read-button-text"
                    />
                  </div>
                  <div style={fieldStyle}>
                    <label htmlFor="encryption-introduction-text" style={fieldLabelStyle}>
                      Introduction text
                    </label>
                    <input
                      id="encryption-introduction-text"
                      style={inputStyle}
                      type="text"
                      value={introductionText}
                      onChange={(event) => setIntroductionText(event.target.value)}
                      data-testid="encryption-introduction-text"
                    />
                  </div>
                </div>

                <div style={buttonRowStyle}>
                  <button
                    type="button"
                    style={{ ...buttonStyle, ...(busy ? { opacity: 0.45, cursor: "not-allowed" } : {}) }}
                    disabled={busy || !onPreview}
                    onClick={() => void handlePreview()}
                    data-testid="encryption-preview"
                  >
                    Preview change
                  </button>
                  <button
                    type="button"
                    style={{
                      ...primaryButtonStyle,
                      ...(!canWrite || busy ? { opacity: 0.45, cursor: "not-allowed" } : {}),
                    }}
                    disabled={!canWrite || busy || !onApply}
                    title={!canWrite ? "Requires mailtools.write or Remediation.Apply" : "Apply the OME template change"}
                    onClick={() => void handleApply()}
                    data-testid="encryption-apply"
                  >
                    Apply change
                  </button>
                </div>
              </>
            )}

            {formError !== null && (
              <p style={noticeStyle} data-testid="encryption-form-error">
                {formError}
              </p>
            )}
            {notice !== null && (
              <p style={noticeStyle} data-testid="encryption-notice">
                {notice}
              </p>
            )}
            {outcome !== null && (
              <div style={sectionStyle} data-testid="encryption-outcome">
                <h3 style={sectionTitleStyle}>
                  {outcome.dryRun ? "Plan preview" : "Applied change"}
                </h3>
                <ul style={diffListStyle} data-testid="encryption-outcome-diff">
                  {outcome.diff.map((line) => (
                    <li key={line}>{line}</li>
                  ))}
                </ul>
                {"auditEvent" in outcome && outcome.auditEvent !== undefined && (
                  <p style={metaStyle} data-testid="encryption-audit-event">
                    Audited as {outcome.auditEvent.action} ({outcome.auditEvent.id}).
                  </p>
                )}
              </div>
            )}
          </>
        )}
      </Section>
    </div>
  );
}
