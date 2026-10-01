"use client";

// Add-team wizard (EPIC-026 SPEC.md §2 US-2, §3.1, §4.1, §9; T-0506).
// Collects the §3.1 create fields — name, owners, members, template, and
// visibility — and posts them to the T-0504 create route
// (POST /v1/tenants/{id}/teams). A chosen local TeamTemplate (T-0501) is
// expanded server-side (SPEC §4.1); step 2 previews the expanded plan with no
// write and step 3 shows the applied result. Field-level validation runs before
// any request and the route's structured 400 details are mapped back onto the
// matching fields. Strictly uses report theme tokens with zero colour literals.

import React, { useState, type CSSProperties, type ReactElement } from "react";
import type { TeamVisibility } from "./TeamsTable";

export interface TeamTemplateOption {
  readonly id: string;
  readonly name: string;
  readonly owners?: readonly string[];
  readonly members?: readonly string[];
  readonly visibility?: TeamVisibility;
}

export interface TeamCreatePlan {
  readonly action: "create";
  readonly targetName: string;
  readonly diff: readonly string[];
  readonly valid: boolean;
  readonly dryRun: boolean;
}

export interface TeamCreateResult {
  readonly success: boolean;
  readonly plan?: TeamCreatePlan;
  readonly jobId?: string;
}

export interface AddTeamWizardProps {
  readonly tenantId: string;
  readonly templates?: readonly TeamTemplateOption[];
  readonly onClose?: () => void;
  readonly onCreated?: (teamName: string) => void;
  readonly fetcher?: typeof fetch;
}

type Step = 1 | 2 | 3;

export function teamsCreateUrl(tenantId: string): string {
  return `/v1/tenants/${encodeURIComponent(tenantId)}/teams`;
}

/** Owners/members are entered one per line or comma-separated; blanks dropped. */
export function parseTeamIdentities(input: string): string[] {
  return input
    .split(/[\n,;]+/)
    .map((value) => value.trim())
    .filter(Boolean);
}

const containerStyle: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: "20px",
  maxWidth: "720px",
  width: "100%",
  background: "var(--bg-elev)",
  border: "1px solid var(--border)",
  borderRadius: "var(--radius, 10px)",
  padding: "24px",
  fontFamily: "var(--font-sans, system-ui, sans-serif)",
  color: "var(--text)",
};

const stepNavStyle: CSSProperties = {
  display: "flex",
  gap: "12px",
  fontSize: "13px",
  fontWeight: 600,
  borderBottom: "1px solid var(--border)",
  paddingBottom: "12px",
  color: "var(--text-soft)",
};

const fieldStyle: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: "6px",
};

const labelStyle: CSSProperties = {
  fontSize: "13px",
  fontWeight: 600,
  color: "var(--text)",
};

const inputStyle: CSSProperties = {
  padding: "8px 12px",
  background: "var(--input-bg, var(--bg))",
  border: "1px solid var(--border)",
  borderRadius: "6px",
  color: "var(--text)",
  fontSize: "14px",
};

const fieldErrorStyle: CSSProperties = {
  fontSize: "12px",
  color: "var(--danger-text)",
};

const primaryButtonStyle: CSSProperties = {
  padding: "8px 16px",
  background: "var(--accent)",
  color: "var(--on-accent)",
  border: "1px solid var(--accent)",
  borderRadius: "6px",
  fontWeight: 600,
  fontSize: "14px",
  cursor: "pointer",
};

const secondaryButtonStyle: CSSProperties = {
  padding: "8px 16px",
  background: "var(--surface)",
  border: "1px solid var(--border)",
  borderRadius: "6px",
  fontWeight: 500,
  fontSize: "14px",
  cursor: "pointer",
  color: "var(--text)",
};

const disabledStyle: CSSProperties = {
  opacity: 0.55,
  cursor: "not-allowed",
};

const errorBannerStyle: CSSProperties = {
  padding: "12px 14px",
  borderRadius: "6px",
  background: "var(--danger-soft)",
  border: "1px solid var(--danger)",
  color: "var(--danger-text)",
  fontSize: "13px",
};

const infoBoxStyle: CSSProperties = {
  padding: "12px 14px",
  borderRadius: "8px",
  background: "var(--surface)",
  border: "1px solid var(--border)",
  fontSize: "13px",
};

const VISIBILITIES: readonly TeamVisibility[] = ["private", "public"];

async function postJson(fetcher: typeof fetch, url: string, body: unknown): Promise<unknown> {
  const response = await fetcher(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    let detail = response.statusText;
    let details: unknown;
    try {
      const payload = (await response.json()) as { message?: string; details?: unknown };
      if (payload?.message) detail = payload.message;
      details = payload?.details;
    } catch {
      // non-JSON error body; keep the status text
    }
    const error = new Error(`Team creation failed: ${response.status} ${detail}`) as Error & {
      details?: unknown;
    };
    error.details = details;
    throw error;
  }
  return response.json();
}

/** Maps the route's structured 400 `details` onto field names. */
export function readFieldErrors(error: unknown): Record<string, string> {
  const errors: Record<string, string> = {};
  const details = (error as { details?: unknown } | undefined)?.details;
  if (!Array.isArray(details)) return errors;
  for (const entry of details) {
    if (typeof entry !== "object" || entry === null) continue;
    const record = entry as { field?: unknown; reason?: unknown };
    if (typeof record.field !== "string" || record.field.length === 0) continue;
    const reason = typeof record.reason === "string" && record.reason.length > 0 ? record.reason : "invalid";
    errors[record.field] = `${record.field} is ${reason}`;
  }
  return errors;
}

export function AddTeamWizard({
  tenantId,
  templates = [],
  onClose,
  onCreated,
  fetcher,
}: AddTeamWizardProps): ReactElement {
  const runFetch = fetcher ?? fetch;

  const [step, setStep] = useState<Step>(1);
  const [name, setName] = useState("");
  const [ownersInput, setOwnersInput] = useState("");
  const [membersInput, setMembersInput] = useState("");
  const [template, setTemplate] = useState("");
  const [visibility, setVisibility] = useState<TeamVisibility>("private");
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [plan, setPlan] = useState<TeamCreatePlan | null>(null);
  const [applied, setApplied] = useState<TeamCreateResult | null>(null);

  const owners = parseTeamIdentities(ownersInput);
  const members = parseTeamIdentities(membersInput);
  const selectedTemplate = templates.find((option) => option.id === template);

  function validate(): Record<string, string> {
    const errors: Record<string, string> = {};
    if (name.trim().length === 0) errors["name"] = "name is required";
    if (owners.length === 0) errors["owners"] = "at least one owner is required";
    return errors;
  }

  function buildBody(previewFlag: boolean): Record<string, unknown> {
    return {
      name: name.trim(),
      owners,
      members,
      ...(template ? { template } : {}),
      visibility,
      preview: previewFlag,
    };
  }

  async function submit(previewFlag: boolean): Promise<void> {
    if (loading) return;
    const errors = validate();
    setFieldErrors(errors);
    if (Object.keys(errors).length > 0) {
      setError(null);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const body = await postJson(runFetch, teamsCreateUrl(tenantId), buildBody(previewFlag));
      if (previewFlag) {
        setPlan(body as TeamCreatePlan);
        setStep(2);
      } else {
        const result = body as TeamCreateResult;
        setApplied(result);
        setStep(3);
        onCreated?.(result.plan?.targetName ?? name.trim());
      }
    } catch (err) {
      const mapped = readFieldErrors(err);
      setFieldErrors(mapped);
      if (!previewFlag && Object.keys(mapped).length > 0) {
        setStep(1);
      }
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }

  function reset(): void {
    setStep(1);
    setPlan(null);
    setApplied(null);
    setError(null);
    setFieldErrors({});
    setName("");
    setOwnersInput("");
    setMembersInput("");
    setTemplate("");
    setVisibility("private");
  }

  return (
    <div
      style={containerStyle}
      role="dialog"
      aria-modal="true"
      aria-label="Add team"
      data-testid="add-team-wizard"
    >
      <div>
        <h2 style={{ margin: 0, fontSize: "20px", fontWeight: 700 }}>Add team</h2>
        <div style={{ fontSize: "13px", color: "var(--text-soft)", marginTop: "4px" }}>
          Create a Microsoft 365 team. A local template expands its owners and members; every create is
          previewed before it is applied.
        </div>
      </div>

      <div style={stepNavStyle}>
        <span style={step === 1 ? { color: "var(--accent)" } : undefined}>1. Configure</span>
        <span>&gt;</span>
        <span style={step === 2 ? { color: "var(--accent)" } : undefined}>2. Review</span>
        <span>&gt;</span>
        <span style={step === 3 ? { color: "var(--accent)" } : undefined}>3. Results</span>
      </div>

      {error && (
        <div style={errorBannerStyle} role="alert" data-testid="add-team-error">
          {error}
        </div>
      )}

      {step === 1 && (
        <div style={{ display: "flex", flexDirection: "column", gap: "12px" }} data-testid="add-team-step-1">
          <div style={fieldStyle}>
            <label style={labelStyle} htmlFor="add-team-name">
              Team name
            </label>
            <input
              id="add-team-name"
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              style={inputStyle}
              data-testid="add-team-name-input"
            />
            {fieldErrors["name"] && (
              <span style={fieldErrorStyle} role="alert" data-testid="add-team-error-name">
                {fieldErrors["name"]}
              </span>
            )}
          </div>

          <div style={fieldStyle}>
            <label style={labelStyle} htmlFor="add-team-owners">
              Owners (one per line or comma-separated UPNs)
            </label>
            <textarea
              id="add-team-owners"
              value={ownersInput}
              onChange={(e) => setOwnersInput(e.target.value)}
              rows={3}
              style={{ ...inputStyle, resize: "vertical", fontFamily: "var(--font-mono, monospace)" }}
              data-testid="add-team-owners-input"
            />
            {fieldErrors["owners"] && (
              <span style={fieldErrorStyle} role="alert" data-testid="add-team-error-owners">
                {fieldErrors["owners"]}
              </span>
            )}
          </div>

          <div style={fieldStyle}>
            <label style={labelStyle} htmlFor="add-team-members">
              Members (one per line or comma-separated UPNs)
            </label>
            <textarea
              id="add-team-members"
              value={membersInput}
              onChange={(e) => setMembersInput(e.target.value)}
              rows={3}
              style={{ ...inputStyle, resize: "vertical", fontFamily: "var(--font-mono, monospace)" }}
              data-testid="add-team-members-input"
            />
            {fieldErrors["members"] && (
              <span style={fieldErrorStyle} role="alert" data-testid="add-team-error-members">
                {fieldErrors["members"]}
              </span>
            )}
          </div>

          <div style={fieldStyle}>
            <label style={labelStyle} htmlFor="add-team-template">
              Template (optional)
            </label>
            <select
              id="add-team-template"
              value={template}
              onChange={(e) => setTemplate(e.target.value)}
              style={inputStyle}
              data-testid="add-team-template-select"
            >
              <option value="">No template</option>
              {templates.map((option) => (
                <option key={option.id} value={option.id}>
                  {option.name}
                </option>
              ))}
            </select>
            {fieldErrors["template"] && (
              <span style={fieldErrorStyle} role="alert" data-testid="add-team-error-template">
                {fieldErrors["template"]}
              </span>
            )}
            {selectedTemplate && (
              <div style={infoBoxStyle} data-testid="add-team-template-summary">
                Template <strong>{selectedTemplate.name}</strong> expands{" "}
                {selectedTemplate.owners?.length ?? 0} owner(s) and{" "}
                {selectedTemplate.members?.length ?? 0} member(s).
              </div>
            )}
          </div>

          <div style={fieldStyle}>
            <label style={labelStyle} htmlFor="add-team-visibility">
              Visibility
            </label>
            <select
              id="add-team-visibility"
              value={visibility}
              onChange={(e) => setVisibility(e.target.value as TeamVisibility)}
              style={inputStyle}
              data-testid="add-team-visibility-select"
            >
              {VISIBILITIES.map((value) => (
                <option key={value} value={value}>
                  {value}
                </option>
              ))}
            </select>
            {fieldErrors["visibility"] && (
              <span style={fieldErrorStyle} role="alert" data-testid="add-team-error-visibility">
                {fieldErrors["visibility"]}
              </span>
            )}
          </div>

          <div style={{ display: "flex", justifyContent: "flex-end", gap: "10px" }}>
            {onClose && (
              <button type="button" style={secondaryButtonStyle} onClick={onClose} data-testid="add-team-cancel">
                Cancel
              </button>
            )}
            <button
              type="button"
              style={{ ...primaryButtonStyle, ...(loading ? disabledStyle : {}) }}
              disabled={loading}
              onClick={() => void submit(true)}
              data-testid="add-team-preview"
            >
              {loading ? "Previewing…" : "Preview"}
            </button>
          </div>
        </div>
      )}

      {step === 2 && plan && (
        <div style={{ display: "flex", flexDirection: "column", gap: "16px" }} data-testid="add-team-step-2">
          <div style={infoBoxStyle}>
            <div style={{ fontWeight: 600, fontSize: "14px", marginBottom: "8px" }}>
              Plan: create {plan.targetName}
            </div>
            <ul style={{ margin: 0, paddingLeft: "20px", fontSize: "13px" }} data-testid="add-team-plan-diff">
              {plan.diff.length === 0 ? (
                <li>No changes listed.</li>
              ) : (
                plan.diff.map((entry) => <li key={entry}>{entry}</li>)
              )}
            </ul>
          </div>

          <div style={{ display: "flex", justifyContent: "space-between", gap: "10px" }}>
            <button
              type="button"
              style={secondaryButtonStyle}
              onClick={() => {
                setPlan(null);
                setStep(1);
              }}
              data-testid="add-team-back"
            >
              Back
            </button>
            <button
              type="button"
              style={{ ...primaryButtonStyle, ...(loading ? disabledStyle : {}) }}
              disabled={loading}
              onClick={() => void submit(false)}
              data-testid="add-team-apply"
            >
              {loading ? "Creating…" : "Create team"}
            </button>
          </div>
        </div>
      )}

      {step === 3 && applied && (
        <div style={{ display: "flex", flexDirection: "column", gap: "16px" }} data-testid="add-team-step-3">
          <div data-testid="add-team-result">
            <div style={{ fontWeight: 600, fontSize: "15px", color: "var(--success-text)" }}>
              {applied.success ? "Team creation queued" : "Team creation failed"}
            </div>
            <div style={{ fontSize: "13px", color: "var(--text-soft)", marginTop: "4px" }}>
              {applied.plan?.targetName ?? name.trim()}
              {applied.jobId ? ` — job ${applied.jobId}` : ""}
            </div>
          </div>

          <div style={{ display: "flex", justifyContent: "flex-end", gap: "10px" }}>
            <button type="button" style={secondaryButtonStyle} onClick={reset} data-testid="add-team-add-more">
              Add another
            </button>
            {onClose && (
              <button type="button" style={primaryButtonStyle} onClick={onClose} data-testid="add-team-done">
                Done
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
