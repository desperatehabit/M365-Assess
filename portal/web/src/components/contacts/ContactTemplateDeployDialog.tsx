"use client";

// ContactTemplateDeployDialog — deploy a contact template with per-target
// variables (EPIC-023 SPEC.md §3.2, §4.2, §6, §8; T-0447). Collects a tenant
// and its variable values for each target, previews the resolved contacts
// before any write, then applies and renders the per-target outcomes so a
// partial failure is visible without hiding the successes. Posts to
// POST /v1/contact-templates/{id}/deploy. A `fetcher` seam keeps the dialog
// testable without a live BFF. Strictly uses report theme tokens.
import React, { useState, type CSSProperties, type ReactElement } from "react";
import type { ContactTemplate } from "./ContactTemplateEditor";

export interface ContactDeployTargetInput {
  readonly tenantId: string;
  readonly variables: Record<string, string>;
}

export interface ContactDeployPlan {
  readonly tenantId: string;
  readonly displayName: string | null;
  readonly externalAddress: string | null;
  readonly type: string;
  readonly diff: readonly string[];
  readonly valid: boolean;
  readonly error: string | null;
}

export interface ContactDeployPlanResponse {
  readonly templateId: string;
  readonly preview: true;
  readonly plans: readonly ContactDeployPlan[];
  readonly allValid: boolean;
}

export interface ContactDeployResult {
  readonly tenantId: string;
  readonly status: "created" | "failed";
  readonly displayName: string | null;
  readonly externalAddress: string | null;
  readonly contactId: string | null;
  readonly error: string | null;
}

export interface ContactDeployExecutionResponse {
  readonly templateId: string;
  readonly preview: false;
  readonly results: readonly ContactDeployResult[];
  readonly summary: { readonly total: number; readonly created: number; readonly failed: number };
}

export interface ContactTemplateDeployDialogProps {
  readonly template: ContactTemplate | null;
  readonly open: boolean;
  readonly onClose: () => void;
  readonly onDeployed?: (response: ContactDeployExecutionResponse) => void;
  readonly fetcher?: typeof fetch;
}

interface TargetRow {
  readonly tenantId: string;
  readonly variables: Record<string, string>;
}

/**
 * Builds the request targets from the edited rows. Rows without a tenant id are
 * dropped, and blank variable values are omitted so the template default wins.
 */
export function buildTargetPayload(rows: readonly TargetRow[]): ContactDeployTargetInput[] {
  return rows
    .filter((row) => row.tenantId.trim().length > 0)
    .map((row) => {
      const variables: Record<string, string> = {};
      for (const [key, value] of Object.entries(row.variables)) {
        const trimmed = value.trim();
        if (trimmed.length > 0) variables[key] = trimmed;
      }
      return { tenantId: row.tenantId.trim(), variables };
    });
}

function emptyVariables(template: ContactTemplate | null): Record<string, string> {
  const variables: Record<string, string> = {};
  for (const key of Object.keys(template?.variables ?? {})) {
    variables[key] = "";
  }
  return variables;
}

const overlayStyle: CSSProperties = {
  position: "fixed",
  inset: 0,
  background: "var(--overlay)",
  zIndex: 60,
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  padding: "24px",
};

const dialogStyle: CSSProperties = {
  background: "var(--bg-elev)",
  border: "1px solid var(--border)",
  borderRadius: "var(--radius, 10px)",
  padding: "24px",
  width: "min(760px, 94vw)",
  maxHeight: "90vh",
  overflowY: "auto",
  display: "flex",
  flexDirection: "column",
  gap: "16px",
  color: "var(--text)",
  fontFamily: "var(--font-sans, system-ui, sans-serif)",
};

const titleStyle: CSSProperties = { margin: 0, fontSize: "20px", fontWeight: 700 };

const guidanceStyle: CSSProperties = {
  margin: 0,
  fontSize: "13px",
  color: "var(--text-soft)",
  lineHeight: 1.5,
};

const sectionStyle: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: "10px",
  padding: "12px",
  border: "1px solid var(--border)",
  borderRadius: "6px",
};

const labelStyle: CSSProperties = { fontSize: "13px", fontWeight: 600, color: "var(--text)" };

const inputStyle: CSSProperties = {
  padding: "8px 12px",
  background: "var(--input-bg, var(--bg))",
  border: "1px solid var(--border)",
  borderRadius: "6px",
  color: "var(--text)",
  fontSize: "14px",
};

const buttonStyle: CSSProperties = {
  padding: "8px 16px",
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

const disabledStyle: CSSProperties = { opacity: 0.55, cursor: "not-allowed" };

const errorBannerStyle: CSSProperties = {
  padding: "12px 14px",
  borderRadius: "6px",
  background: "var(--danger-soft)",
  border: "1px solid var(--danger)",
  color: "var(--danger-text)",
  fontSize: "13px",
};

const summaryStyle: CSSProperties = {
  padding: "12px 14px",
  borderRadius: "6px",
  background: "var(--surface)",
  border: "1px solid var(--border)",
  fontSize: "13px",
  lineHeight: 1.6,
};

function statusTone(status: "created" | "failed"): CSSProperties {
  return status === "failed"
    ? { color: "var(--danger-text)", fontWeight: 600 }
    : { color: "var(--success-text)", fontWeight: 600 };
}

export function ContactTemplateDeployDialog({
  template,
  open,
  onClose,
  onDeployed,
  fetcher,
}: ContactTemplateDeployDialogProps): ReactElement | null {
  const [rows, setRows] = useState<TargetRow[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [plan, setPlan] = useState<ContactDeployPlanResponse | null>(null);
  const [execution, setExecution] = useState<ContactDeployExecutionResponse | null>(null);

  if (!open || !template) {
    return null;
  }

  const runFetch = fetcher ?? fetch;
  const variableKeys = Object.keys(template.variables ?? {});

  function addRow(): void {
    setRows((current) => [...current, { tenantId: "", variables: emptyVariables(template) }]);
    setPlan(null);
    setExecution(null);
  }

  function updateRow(index: number, patch: Partial<TargetRow>): void {
    setRows((current) =>
      current.map((row, i) => (i === index ? { ...row, ...patch } : row)),
    );
    setPlan(null);
    setExecution(null);
  }

  function updateVariable(index: number, key: string, value: string): void {
    setRows((current) =>
      current.map((row, i) =>
        i === index ? { ...row, variables: { ...row.variables, [key]: value } } : row,
      ),
    );
    setPlan(null);
    setExecution(null);
  }

  function removeRow(index: number): void {
    setRows((current) => current.filter((_, i) => i !== index));
    setPlan(null);
    setExecution(null);
  }

  async function submit(preview: boolean): Promise<void> {
    const targets = buildTargetPayload(rows);
    if (targets.length === 0) {
      setError("Add at least one target tenant.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const response = await runFetch(
        `/v1/contact-templates/${encodeURIComponent(template!.id)}/deploy`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json", Accept: "application/json" },
          body: JSON.stringify({ targets, preview }),
        },
      );
      if (!response.ok && response.status !== 207) {
        let detail = response.statusText;
        try {
          const payload = (await response.json()) as { message?: string };
          if (payload?.message) detail = payload.message;
        } catch {
          // non-JSON error body; keep the status text
        }
        throw new Error(`Deploy failed: ${response.status} ${detail}`);
      }
      if (preview) {
        setPlan((await response.json()) as ContactDeployPlanResponse);
      } else {
        const body = (await response.json()) as ContactDeployExecutionResponse;
        setExecution(body);
        onDeployed?.(body);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  function handleClose(): void {
    setRows([]);
    setError(null);
    setPlan(null);
    setExecution(null);
    onClose();
  }

  return (
    <div
      style={overlayStyle}
      role="dialog"
      aria-modal="true"
      aria-label="Deploy contact template"
      data-testid="contact-template-deploy-dialog"
    >
      <div style={dialogStyle}>
        <h2 style={titleStyle}>Deploy template — {template.name}</h2>
        <p style={guidanceStyle}>
          Add a target tenant and its variable values. Preview resolves the contacts first;
          nothing is written until you deploy.
        </p>

        {rows.map((row, index) => (
          <div key={index} style={sectionStyle} data-testid={`contact-deploy-target-${index}`}>
            <div style={{ display: "flex", gap: "10px", alignItems: "flex-end" }}>
              <div style={{ display: "flex", flexDirection: "column", gap: "6px", flex: 1 }}>
                <label style={labelStyle} htmlFor={`contact-deploy-tenant-${index}`}>
                  Target tenant
                </label>
                <input
                  id={`contact-deploy-tenant-${index}`}
                  type="text"
                  value={row.tenantId}
                  onChange={(e) => updateRow(index, { tenantId: e.target.value })}
                  style={inputStyle}
                  data-testid={`contact-deploy-tenant-input-${index}`}
                />
              </div>
              <button
                type="button"
                style={buttonStyle}
                onClick={() => removeRow(index)}
                data-testid={`contact-deploy-remove-${index}`}
              >
                Remove
              </button>
            </div>

            {variableKeys.map((key) => (
              <div key={key} style={{ display: "flex", flexDirection: "column", gap: "6px" }}>
                <label style={labelStyle} htmlFor={`contact-deploy-var-${index}-${key}`}>
                  {key}
                </label>
                <input
                  id={`contact-deploy-var-${index}-${key}`}
                  type="text"
                  value={row.variables[key] ?? ""}
                  onChange={(e) => updateVariable(index, key, e.target.value)}
                  style={inputStyle}
                  data-testid={`contact-deploy-var-${index}-${key}`}
                />
              </div>
            ))}
          </div>
        ))}

        <div>
          <button type="button" style={buttonStyle} onClick={addRow} data-testid="contact-deploy-add">
            Add target
          </button>
        </div>

        {error && (
          <div style={errorBannerStyle} role="alert" data-testid="contact-deploy-error">
            {error}
          </div>
        )}

        {plan && (
          <div style={sectionStyle} data-testid="contact-deploy-plan">
            <span style={labelStyle}>Plan preview</span>
            {plan.plans.map((p) => (
              <div key={p.tenantId} data-testid={`contact-deploy-plan-${p.tenantId}`}>
                <strong>{p.tenantId}</strong>:{" "}
                {p.valid ? `${p.displayName} <${p.externalAddress}>` : (p.error ?? "invalid")}
              </div>
            ))}
          </div>
        )}

        {execution && (
          <div style={sectionStyle} data-testid="contact-deploy-results">
            <div style={summaryStyle} data-testid="contact-deploy-summary">
              <strong>{execution.summary.total}</strong> target
              {execution.summary.total === 1 ? "" : "s"}: {execution.summary.created} created,{" "}
              {execution.summary.failed} failed
            </div>
            {execution.results.map((r) => (
              <div key={r.tenantId} data-testid={`contact-deploy-result-${r.tenantId}`}>
                <strong>{r.tenantId}</strong>:{" "}
                <span style={statusTone(r.status)}>{r.status}</span>{" "}
                {r.error ? `(${r.error})` : r.contactId ? `(${r.contactId})` : ""}
              </div>
            ))}
          </div>
        )}

        <div style={{ display: "flex", gap: "10px", justifyContent: "flex-end" }}>
          <button type="button" style={buttonStyle} onClick={handleClose} data-testid="contact-deploy-close">
            Close
          </button>
          <button
            type="button"
            style={{ ...buttonStyle, ...(busy ? disabledStyle : {}) }}
            disabled={busy}
            onClick={() => void submit(true)}
            data-testid="contact-deploy-preview"
          >
            {busy ? "Working…" : "Preview"}
          </button>
          <button
            type="button"
            style={{ ...primaryButtonStyle, ...(busy || !plan?.allValid ? disabledStyle : {}) }}
            disabled={busy || !plan?.allValid}
            onClick={() => void submit(false)}
            data-testid="contact-deploy-apply"
          >
            {busy ? "Working…" : "Deploy"}
          </button>
        </div>
      </div>
    </div>
  );
}
