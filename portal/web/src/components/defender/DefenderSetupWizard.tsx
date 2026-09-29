"use client";

// DefenderSetupWizard (EPIC-019 SPEC.md §3.2, §4.2, §11.4, T-0365).
// Stepper that deploys recommended Defender policies through the T-0364
// deploy route (POST /v1/tenants/{id}/defender/deploy): area selection,
// target scope, plan preview, then apply. Saving as Intune templates is an
// optional toggle that defaults off (§11.4) and is passed through to the
// deploy call. Plans that report existing policies surface the overwrite
// option; results render per-area success/failure. Kit tokens only.

import React, { useState, type CSSProperties, type ReactElement } from "react";

export interface DefenderSetupAreaPlan {
  readonly area: string;
  readonly displayName?: string;
  readonly supported: boolean;
  readonly action: string;
  readonly policyName: string;
  readonly targetScope?: string;
  readonly overwrite: boolean;
  readonly conflict: boolean;
  readonly conflictMessage?: string | null;
  readonly diff: readonly string[];
  readonly valid: boolean;
}

export interface DefenderSetupPlan {
  readonly tenantId: string;
  readonly plans: readonly DefenderSetupAreaPlan[];
  readonly allValid: boolean;
  readonly overwrite: boolean;
}

export interface DefenderSetupAreaResult {
  readonly area: string;
  readonly policyId?: string | null;
  readonly action: string;
  readonly state: "succeeded" | "failed" | "skipped";
  readonly error?: string | null;
}

export interface DefenderSetupOutcome {
  readonly success: boolean;
  readonly state: string;
  readonly results: readonly DefenderSetupAreaResult[];
  readonly savedTemplate?: { id: string; name: string } | null;
  readonly error?: string | null;
}

export interface DefenderSetupRequest {
  readonly policyAreas: readonly string[];
  readonly targetScope: string;
  readonly overwrite: boolean;
  readonly saveAsTemplate: boolean;
  readonly templateName?: string;
}

export interface DefenderSetupWizardProps {
  readonly tenantId: string;
  readonly onPreviewPlan?: (request: DefenderSetupRequest) => Promise<DefenderSetupPlan>;
  readonly onExecuteDeploy?: (request: DefenderSetupRequest) => Promise<DefenderSetupOutcome>;
}

export const DEFENDER_SETUP_STEPS: readonly string[] = [
  "Policy areas",
  "Target scope",
  "Plan preview",
  "Apply",
];

export const DEFENDER_SETUP_AREAS: readonly { area: string; displayName: string }[] = [
  { area: "av", displayName: "Antivirus (AV)" },
  { area: "edr", displayName: "Endpoint Detection and Response (EDR)" },
  { area: "asr", displayName: "Attack Surface Reduction (ASR)" },
];

export const DEFENDER_SETUP_UNSUPPORTED_AREAS: readonly { area: string; displayName: string }[] = [
  { area: "compliance", displayName: "Device Compliance" },
  { area: "firewall", displayName: "Firewall" },
  { area: "exclusions", displayName: "Exclusions" },
];

export const DEFENDER_SETUP_DEFAULT_SCOPE = "allDevices";

export function defenderDeployUrl(tenantId: string): string {
  return `/v1/tenants/${encodeURIComponent(tenantId)}/defender/deploy`;
}

async function throwDeployError(res: Response, fallback: string): Promise<never> {
  const body = (await res.json().catch(() => ({}))) as { message?: string };
  throw new Error(body.message || `${fallback}: HTTP ${res.status}`);
}

export async function previewDefenderDeploy(
  tenantId: string,
  request: DefenderSetupRequest,
): Promise<DefenderSetupPlan> {
  const res = await fetch(defenderDeployUrl(tenantId), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ ...request, preview: true }),
  });
  if (!res.ok) await throwDeployError(res, "Failed to preview Defender deploy");
  return (await res.json()) as DefenderSetupPlan;
}

export async function applyDefenderDeploy(
  tenantId: string,
  request: DefenderSetupRequest,
): Promise<DefenderSetupOutcome> {
  const res = await fetch(defenderDeployUrl(tenantId), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(request),
  });
  if (!res.ok) await throwDeployError(res, "Failed to deploy Defender policies");
  return (await res.json()) as DefenderSetupOutcome;
}

const wizardStyle: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: "16px",
  padding: "20px",
  background: "var(--bg-elev)",
  border: "1px solid var(--border)",
  borderRadius: "var(--radius, 10px)",
  color: "var(--text)",
  fontFamily: "var(--font-sans, system-ui, sans-serif)",
};

const stepsStyle: CSSProperties = {
  display: "flex",
  gap: "8px",
  margin: 0,
  padding: 0,
  listStyle: "none",
};

const inputStyle: CSSProperties = {
  padding: "8px 12px",
  background: "var(--input-bg, var(--bg))",
  border: "1px solid var(--border)",
  borderRadius: "6px",
  color: "var(--text)",
  fontSize: "14px",
  width: "100%",
  boxSizing: "border-box",
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

const errorStyle: CSSProperties = {
  margin: 0,
  padding: "12px",
  borderRadius: "6px",
  background: "var(--danger-soft)",
  border: "1px solid var(--danger)",
  color: "var(--danger-text)",
  fontSize: "13px",
};

const conflictStyle: CSSProperties = {
  margin: 0,
  padding: "12px",
  borderRadius: "6px",
  background: "var(--warning-soft)",
  border: "1px solid var(--warning)",
  color: "var(--warning-text)",
  fontSize: "13px",
};

const rowStyle: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: "8px",
  fontSize: "14px",
  padding: "8px 0",
};

export function DefenderSetupWizard({
  tenantId,
  onPreviewPlan,
  onExecuteDeploy,
}: DefenderSetupWizardProps): ReactElement {
  const [step, setStep] = useState(0);
  const [areas, setAreas] = useState<string[]>([]);
  const [targetScope, setTargetScope] = useState(DEFENDER_SETUP_DEFAULT_SCOPE);
  const [overwrite, setOverwrite] = useState(false);
  const [saveAsTemplate, setSaveAsTemplate] = useState(false);
  const [templateName, setTemplateName] = useState("");
  const [plan, setPlan] = useState<DefenderSetupPlan | null>(null);
  const [outcome, setOutcome] = useState<DefenderSetupOutcome | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Every input change invalidates the plan: apply must match what was previewed.
  function invalidatePlan(): void {
    setPlan(null);
    setOutcome(null);
    setError(null);
  }

  function toggleArea(area: string): void {
    setAreas((prev) => (prev.includes(area) ? prev.filter((a) => a !== area) : [...prev, area]));
    invalidatePlan();
  }

  function buildRequest(): DefenderSetupRequest | null {
    if (areas.length === 0) {
      setError("Select at least one policy area.");
      return null;
    }
    if (targetScope.trim().length === 0) {
      setError("Target scope is required.");
      return null;
    }
    if (saveAsTemplate && templateName.trim().length === 0) {
      setError("Template name is required when saving as Intune templates.");
      return null;
    }
    return {
      policyAreas: [...areas],
      targetScope: targetScope.trim(),
      overwrite,
      saveAsTemplate,
      ...(saveAsTemplate ? { templateName: templateName.trim() } : {}),
    };
  }

  async function handlePreview(): Promise<void> {
    const request = buildRequest();
    if (!request) return;
    setBusy(true);
    setError(null);
    try {
      const preview = onPreviewPlan
        ? await onPreviewPlan(request)
        : await previewDefenderDeploy(tenantId, request);
      setPlan(preview);
      setOutcome(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to preview the deploy plan.");
    } finally {
      setBusy(false);
    }
  }

  async function handleApply(): Promise<void> {
    const request = buildRequest();
    if (!request || !plan) return;
    setBusy(true);
    setError(null);
    try {
      const result = onExecuteDeploy
        ? await onExecuteDeploy(request)
        : await applyDefenderDeploy(tenantId, request);
      setOutcome(result);
      setStep(3);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to deploy Defender policies.");
    } finally {
      setBusy(false);
    }
  }

  const conflicts = plan?.plans.filter((entry) => entry.conflict) ?? [];

  return (
    <div style={wizardStyle} data-testid="defender-setup-wizard">
      <ol style={stepsStyle} data-testid="defender-setup-steps">
        {DEFENDER_SETUP_STEPS.map((label, index) => (
          <li
            key={label}
            data-testid={`defender-setup-step-${index}`}
            aria-current={index === step ? "step" : undefined}
            style={{
              fontSize: "13px",
              fontWeight: index === step ? 700 : 400,
              color: index === step ? "var(--text)" : "var(--text-soft)",
            }}
          >
            {`${index + 1}. ${label}`}
          </li>
        ))}
      </ol>

      {error && (
        <p style={errorStyle} role="alert" data-testid="wizard-error">
          {error}
        </p>
      )}

      {step === 0 && (
        <section data-testid="wizard-step-areas">
          <h3 style={{ margin: "0 0 8px", fontSize: "16px" }}>Select policy areas</h3>
          {DEFENDER_SETUP_AREAS.map((entry) => (
            <label key={entry.area} style={rowStyle}>
              <input
                type="checkbox"
                checked={areas.includes(entry.area)}
                onChange={() => toggleArea(entry.area)}
                data-testid={`wizard-area-${entry.area}`}
              />
              {entry.displayName}
            </label>
          ))}
          {DEFENDER_SETUP_UNSUPPORTED_AREAS.map((entry) => (
            <label key={entry.area} style={{ ...rowStyle, color: "var(--text-soft)" }}>
              <input
                type="checkbox"
                checked={false}
                disabled
                aria-label={`${entry.displayName} (not yet supported)`}
                data-testid={`wizard-area-unsupported-${entry.area}`}
              />
              {`${entry.displayName} (not yet supported)`}
            </label>
          ))}
        </section>
      )}

      {step === 1 && (
        <section data-testid="wizard-step-scope">
          <h3 style={{ margin: "0 0 8px", fontSize: "16px" }}>Choose the target scope</h3>
          <label style={{ display: "flex", flexDirection: "column", gap: "6px", fontSize: "13px" }}>
            Target scope
            <input
              type="text"
              value={targetScope}
              onChange={(e) => {
                setTargetScope(e.target.value);
                invalidatePlan();
              }}
              aria-label="Target scope"
              data-testid="wizard-scope-input"
              style={inputStyle}
            />
          </label>
          <label style={{ ...rowStyle, marginTop: "8px" }}>
            <input
              type="checkbox"
              checked={saveAsTemplate}
              onChange={(e) => {
                setSaveAsTemplate(e.target.checked);
                invalidatePlan();
              }}
              data-testid="wizard-save-template-toggle"
            />
            Save as Intune templates
          </label>
          {saveAsTemplate && (
            <label style={{ display: "flex", flexDirection: "column", gap: "6px", fontSize: "13px" }}>
              Template name
              <input
                type="text"
                value={templateName}
                onChange={(e) => {
                  setTemplateName(e.target.value);
                  setError(null);
                }}
                placeholder="Pilot baseline"
                aria-label="Template name"
                data-testid="wizard-template-name-input"
                style={inputStyle}
              />
            </label>
          )}
        </section>
      )}

      {step === 2 && (
        <section data-testid="wizard-step-plan">
          <h3 style={{ margin: "0 0 8px", fontSize: "16px" }}>Review the plan</h3>
          <p style={{ margin: "0 0 8px", fontSize: "13px", color: "var(--text-soft)" }}>
            {`Deploying ${areas.length > 0 ? areas.join(", ") : "no areas"} to ${targetScope.trim() || DEFENDER_SETUP_DEFAULT_SCOPE}.`}
          </p>
          <button
            type="button"
            style={buttonStyle}
            onClick={() => void handlePreview()}
            disabled={busy}
            data-testid="wizard-preview-button"
          >
            {busy ? "Loading plan..." : "Generate plan"}
          </button>

          {plan && (
            <div style={{ marginTop: "12px" }} data-testid="wizard-plan">
              <ul style={{ margin: 0, paddingLeft: "18px", display: "flex", flexDirection: "column", gap: "4px" }}>
                {plan.plans.map((entry) => (
                  <li key={entry.area} style={{ fontSize: "13px" }} data-testid={`wizard-plan-row-${entry.area}`}>
                    {`${entry.displayName || entry.area}: ${entry.policyName} (${entry.action})`}
                    {entry.conflict && entry.conflictMessage && (
                      <span data-testid={`wizard-conflict-${entry.area}`}>{` — ${entry.conflictMessage}`}</span>
                    )}
                  </li>
                ))}
              </ul>

              {conflicts.length > 0 && (
                <p style={{ ...conflictStyle, marginTop: "12px" }} data-testid="wizard-conflict-callout">
                  {`${conflicts.length} polic${conflicts.length === 1 ? "y" : "ies"} already exist. Enable overwrite to update them, then generate the plan again.`}
                </p>
              )}

              <label style={rowStyle}>
                <input
                  type="checkbox"
                  checked={overwrite}
                  onChange={(e) => {
                    setOverwrite(e.target.checked);
                    invalidatePlan();
                  }}
                  data-testid="wizard-overwrite-toggle"
                />
                Overwrite existing policies
              </label>
            </div>
          )}
        </section>
      )}

      {step === 3 && (
        <section data-testid="wizard-step-result">
          <h3 style={{ margin: "0 0 8px", fontSize: "16px" }}>Apply result</h3>
          {!outcome ? (
            <p style={{ margin: 0, fontSize: "13px", color: "var(--text-soft)" }}>
              No deploy has run yet. Generate a plan first, then apply.
            </p>
          ) : (
            <div data-testid="wizard-results">
              <p style={{ margin: "0 0 8px", fontSize: "13px" }} data-testid="wizard-result-summary">
                {outcome.success ? "Deploy succeeded." : "Deploy did not fully succeed."}
              </p>
              <ul style={{ margin: 0, paddingLeft: "18px", display: "flex", flexDirection: "column", gap: "4px" }}>
                {outcome.results.map((result) => (
                  <li key={result.area} style={{ fontSize: "13px" }} data-testid={`wizard-result-${result.area}`}>
                    {`${result.area}: ${result.state}`}
                    {result.error ? ` — ${result.error}` : ""}
                  </li>
                ))}
              </ul>
              {outcome.savedTemplate && (
                <p style={{ margin: "8px 0 0", fontSize: "13px" }} data-testid="wizard-saved-template">
                  {`Saved as template ${outcome.savedTemplate.name}.`}
                </p>
              )}
              {outcome.error && (
                <p style={errorStyle} data-testid="wizard-result-error">
                  {outcome.error}
                </p>
              )}
            </div>
          )}
        </section>
      )}

      <div style={{ display: "flex", gap: "8px", justifyContent: "flex-end" }}>
        {step > 0 && (
          <button
            type="button"
            style={buttonStyle}
            onClick={() => setStep((prev) => Math.max(0, prev - 1))}
            disabled={busy}
            data-testid="wizard-back"
          >
            Back
          </button>
        )}
        {step < 2 && (
          <button
            type="button"
            style={primaryButtonStyle}
            onClick={() => {
              setError(null);
              setStep((prev) => Math.min(3, prev + 1));
            }}
            disabled={step === 0 && areas.length === 0}
            data-testid="wizard-next"
          >
            Next
          </button>
        )}
        {step === 2 && (
          <button
            type="button"
            style={primaryButtonStyle}
            onClick={() => void handleApply()}
            disabled={busy || !plan}
            data-testid="wizard-apply-button"
          >
            {busy && plan ? "Applying..." : "Apply"}
          </button>
        )}
      </div>
    </div>
  );
}
