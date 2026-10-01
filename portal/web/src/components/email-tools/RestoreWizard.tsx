"use client";

// Mailbox restore wizard (EPIC-024 SPEC.md §2 US-4, §3.4, §4.2, §5, §9; T-0468).
// Four steps — select mailbox → choose scope (mailbox/items/date) → target →
// confirm. The confirm step builds the plan preview (dry run) and renders what
// will be restored and where; the destructive start is gated behind an explicit
// confirmation and is disabled unless `canRestore` (RBAC) is set. The wizard
// never fetches — the page owns the BFF calls and passes preview/start
// callbacks. Strictly uses report theme tokens with zero colour literals.

import React, { useState, type CSSProperties, type ReactElement } from "react";

export type MailRestoreScope = "mailbox" | "items" | "date";
export type MailRestoreState = "planned" | "running" | "completed" | "failed";

export interface MailRestoreInput {
  readonly mailboxId: string;
  readonly scope: MailRestoreScope;
  readonly target?: string;
  readonly startDate?: string;
  readonly endDate?: string;
}

export interface MailRestorePlan {
  readonly action: "restore";
  readonly mailboxId: string;
  readonly scope: string;
  readonly target: string | null;
  readonly before?: Record<string, unknown> | null;
  readonly after?: Record<string, unknown> | null;
  readonly diff: readonly string[];
  readonly valid: boolean;
  readonly dryRun: boolean;
  readonly requiresConfirmation: boolean;
}

export interface MailRestoreJob {
  readonly id: string;
  readonly tenantId: string;
  readonly mailboxId: string;
  readonly scope: string;
  readonly target: string | null;
  readonly state: MailRestoreState;
  readonly result: Record<string, unknown> | null;
  readonly createdAt: string;
  readonly createdBy: string;
}

export interface MailRestoreResult {
  readonly success: boolean;
  readonly job: MailRestoreJob;
  readonly plan: MailRestorePlan;
  readonly result?: Record<string, unknown>;
}

export interface RestoreWizardProps {
  readonly canRestore?: boolean;
  readonly onPreview: (input: MailRestoreInput) => Promise<MailRestorePlan>;
  readonly onStart: (input: MailRestoreInput) => Promise<MailRestoreResult>;
  readonly onStarted?: (result: MailRestoreResult) => void;
}

const STEPS = ["mailbox", "scope", "target", "confirm"] as const;
type WizardStep = (typeof STEPS)[number];

const containerStyle: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: "12px",
  background: "var(--bg-elev)",
  border: "1px solid var(--border)",
  borderRadius: "var(--radius, 10px)",
  padding: "16px",
  fontFamily: "var(--font-sans, system-ui, sans-serif)",
  color: "var(--text)",
};

const stepBarStyle: CSSProperties = {
  display: "flex",
  gap: "8px",
  flexWrap: "wrap",
  margin: 0,
  padding: 0,
  listStyle: "none",
};

const stepChipStyle: CSSProperties = {
  padding: "4px 10px",
  borderRadius: "999px",
  border: "1px solid var(--border)",
  fontSize: "12px",
  color: "var(--text-soft)",
};

const stepChipActiveStyle: CSSProperties = {
  ...stepChipStyle,
  background: "var(--accent)",
  borderColor: "var(--accent)",
  color: "var(--on-accent)",
  fontWeight: 600,
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

const radioRowStyle: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: "6px",
  fontSize: "13px",
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

const dangerButtonStyle: CSSProperties = {
  ...buttonStyle,
  background: "var(--danger)",
  color: "var(--on-accent)",
  borderColor: "var(--danger)",
};

const disabledStyle: CSSProperties = { opacity: 0.45, cursor: "not-allowed" };

const planStyle: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: "8px",
  padding: "12px",
  background: "var(--surface)",
  border: "1px solid var(--border)",
  borderRadius: "6px",
};

const planTitleStyle: CSSProperties = { fontSize: "13px", fontWeight: 600, margin: 0 };

const metaStyle: CSSProperties = { fontSize: "13px", margin: 0 };

const diffListStyle: CSSProperties = {
  margin: 0,
  paddingLeft: "18px",
  fontSize: "13px",
  display: "flex",
  flexDirection: "column",
  gap: "4px",
};

const warningStyle: CSSProperties = {
  margin: 0,
  padding: "10px 12px",
  fontSize: "13px",
  background: "var(--danger-soft, var(--warn-soft))",
  border: "1px solid var(--danger, var(--warn))",
  borderRadius: "6px",
  color: "var(--danger-text, var(--warn-text))",
};

const confirmRowStyle: CSSProperties = {
  display: "flex",
  alignItems: "flex-start",
  gap: "8px",
  fontSize: "13px",
};

const noticeStyle: CSSProperties = { fontSize: "13px", margin: 0, color: "var(--text-soft)" };

const errorStyle: CSSProperties = {
  fontSize: "13px",
  margin: 0,
  color: "var(--danger-text, var(--danger))",
};

function optionalIso(value: string): string | undefined {
  const trimmed = value.trim();
  if (trimmed.length === 0) return undefined;
  const parsed = new Date(trimmed);
  return Number.isNaN(parsed.getTime()) ? undefined : parsed.toISOString();
}

function planTargetLabel(plan: MailRestorePlan): string {
  return plan.target && plan.target.length > 0 ? `target '${plan.target}'` : "restored in place";
}

function itemCount(value: Record<string, unknown> | null | undefined): number | null {
  if (value === undefined || value === null) return null;
  const count = value["itemCount"];
  return typeof count === "number" ? count : null;
}

export function RestoreWizard({
  canRestore = true,
  onPreview,
  onStart,
  onStarted,
}: RestoreWizardProps): ReactElement {
  const [stepIndex, setStepIndex] = useState(0);
  const [mailboxId, setMailboxId] = useState("");
  const [scope, setScope] = useState<MailRestoreScope>("mailbox");
  const [target, setTarget] = useState("");
  const [startDate, setStartDate] = useState("");
  const [endDate, setEndDate] = useState("");
  const [plan, setPlan] = useState<MailRestorePlan | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [startError, setStartError] = useState<string | null>(null);
  const [result, setResult] = useState<MailRestoreResult | null>(null);

  const step: WizardStep = STEPS[stepIndex] ?? "mailbox";
  const startIso = optionalIso(startDate);
  const endIso = optionalIso(endDate);
  const dateReady = startIso !== undefined && endIso !== undefined;

  const canAdvance =
    step === "mailbox"
      ? mailboxId.trim().length > 0
      : step === "scope"
        ? scope !== "date" || dateReady
        : step === "target"
          ? scope === "mailbox" || target.trim().length > 0
          : true;

  function buildInput(): MailRestoreInput {
    const input: MailRestoreInput = { mailboxId: mailboxId.trim(), scope };
    if (scope !== "mailbox") {
      return {
        ...input,
        target: target.trim(),
        ...(scope === "date" ? { startDate: startIso, endDate: endIso } : {}),
      };
    }
    return input;
  }

  async function handleReview(): Promise<void> {
    setStepIndex(3);
    setPreviewLoading(true);
    setPreviewError(null);
    setPlan(null);
    setConfirmed(false);
    try {
      setPlan(await onPreview(buildInput()));
    } catch (err) {
      setPreviewError(err instanceof Error ? err.message : String(err));
    } finally {
      setPreviewLoading(false);
    }
  }

  function goNext(): void {
    if (step === "target") {
      void handleReview();
      return;
    }
    if (!canAdvance) return;
    setStepIndex((index) => Math.min(STEPS.length - 1, index + 1));
  }

  function goBack(): void {
    setConfirmed(false);
    setPlan(null);
    setPreviewError(null);
    setStartError(null);
    setStepIndex((index) => Math.max(0, index - 1));
  }

  async function handleStart(): Promise<void> {
    if (canRestore === false || confirmed === false || plan === null || plan.valid === false || busy) {
      return;
    }
    setBusy(true);
    setStartError(null);
    try {
      const started = await onStart(buildInput());
      setResult(started);
      onStarted?.(started);
    } catch (err) {
      setStartError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  function reset(): void {
    setStepIndex(0);
    setMailboxId("");
    setScope("mailbox");
    setTarget("");
    setStartDate("");
    setEndDate("");
    setPlan(null);
    setPreviewError(null);
    setConfirmed(false);
    setStartError(null);
    setResult(null);
  }

  const startDisabled =
    canRestore === false || confirmed === false || plan === null || plan.valid === false || busy;

  return (
    <div style={containerStyle} data-testid="restore-wizard">
      <ol style={stepBarStyle} data-testid="restore-wizard-steps">
        {STEPS.map((name, index) => (
          <li
            key={name}
            style={index === stepIndex ? stepChipActiveStyle : stepChipStyle}
            data-testid={`restore-wizard-step-indicator-${name}`}
            data-active={index === stepIndex ? "true" : "false"}
          >
            {index + 1}. {name}
          </li>
        ))}
      </ol>

      {step === "mailbox" && (
        <div style={fieldStyle} data-testid="restore-wizard-step-mailbox">
          <label htmlFor="restore-wizard-mailbox" style={fieldLabelStyle}>
            Mailbox
          </label>
          <input
            id="restore-wizard-mailbox"
            style={inputStyle}
            type="text"
            placeholder="mailbox id or primary SMTP address"
            value={mailboxId}
            onChange={(event) => setMailboxId(event.target.value)}
            aria-label="Mailbox to restore"
            data-testid="restore-wizard-mailbox"
          />
          <p style={noticeStyle}>Select the soft-deleted mailbox or mailbox to restore.</p>
        </div>
      )}

      {step === "scope" && (
        <div style={radioRowStyle} data-testid="restore-wizard-step-scope">
          <span style={fieldLabelStyle}>Restore scope</span>
          {(
            [
              ["mailbox", "Entire mailbox"],
              ["items", "Specific items"],
              ["date", "Date range"],
            ] as const
          ).map(([value, label]) => (
            <label key={value} style={confirmRowStyle}>
              <input
                type="radio"
                name="restore-wizard-scope"
                value={value}
                checked={scope === value}
                onChange={() => setScope(value)}
                data-testid={`restore-wizard-scope-${value}`}
              />
              <span>{label}</span>
            </label>
          ))}

          {scope === "date" && (
            <div style={fieldStyle}>
              <label htmlFor="restore-wizard-start-date" style={fieldLabelStyle}>
                Start date
              </label>
              <input
                id="restore-wizard-start-date"
                style={inputStyle}
                type="datetime-local"
                value={startDate}
                onChange={(event) => setStartDate(event.target.value)}
                aria-label="Restore window start"
                data-testid="restore-wizard-start-date"
              />
              <label htmlFor="restore-wizard-end-date" style={fieldLabelStyle}>
                End date
              </label>
              <input
                id="restore-wizard-end-date"
                style={inputStyle}
                type="datetime-local"
                value={endDate}
                onChange={(event) => setEndDate(event.target.value)}
                aria-label="Restore window end"
                data-testid="restore-wizard-end-date"
              />
            </div>
          )}
        </div>
      )}

      {step === "target" && (
        <div style={fieldStyle} data-testid="restore-wizard-step-target">
          {scope === "mailbox" ? (
            <p style={metaStyle} data-testid="restore-wizard-target-inplace">
              A mailbox-scope restore runs in place; no target is required.
            </p>
          ) : (
            <>
              <label htmlFor="restore-wizard-target" style={fieldLabelStyle}>
                Target
              </label>
              <input
                id="restore-wizard-target"
                style={inputStyle}
                type="text"
                placeholder="restore target"
                value={target}
                onChange={(event) => setTarget(event.target.value)}
                aria-label="Restore target"
                data-testid="restore-wizard-target"
              />
            </>
          )}
        </div>
      )}

      {step === "confirm" && (
        <div style={fieldStyle} data-testid="restore-wizard-step-confirm">
          {previewLoading === true && (
            <p style={noticeStyle} data-testid="restore-wizard-preview-loading">
              Building the restore plan…
            </p>
          )}

          {previewError !== null && (
            <p style={errorStyle} data-testid="restore-wizard-preview-error">
              {previewError}
            </p>
          )}

          {plan !== null && (
            <div style={planStyle} data-testid="restore-wizard-plan">
              <h3 style={planTitleStyle}>Plan preview</h3>
              <p style={metaStyle} data-testid="restore-wizard-plan-summary">
                {`${plan.scope} scope · mailbox '${plan.mailboxId}' · ${planTargetLabel(plan)}`}
              </p>
              <ul style={diffListStyle} data-testid="restore-wizard-plan-diff">
                {plan.diff.map((line, index) => (
                  <li key={`${line}-${index}`} data-testid={`restore-wizard-plan-diff-${index}`}>
                    {line}
                  </li>
                ))}
              </ul>
              {(itemCount(plan.before) !== null || itemCount(plan.after) !== null) && (
                <p style={metaStyle} data-testid="restore-wizard-plan-counts">
                  Items before: {itemCount(plan.before) ?? "—"} · after: {itemCount(plan.after) ?? "—"}
                </p>
              )}
              <p style={warningStyle} data-testid="restore-wizard-destructive-warning">
                A restore is destructive-adjacent and is audited with before/after item counts.
              </p>
              <label style={confirmRowStyle}>
                <input
                  type="checkbox"
                  id="restore-wizard-confirm-checkbox"
                  checked={confirmed}
                  onChange={(event) => setConfirmed(event.target.checked)}
                  data-testid="restore-wizard-confirm-checkbox"
                />
                <span>I understand this restore will change mailbox data and will be audited.</span>
              </label>
              {canRestore === false && (
                <p style={noticeStyle} data-testid="restore-wizard-rbac-note">
                  Starting a restore requires mailtools.restore and Remediation.Apply.
                </p>
              )}
            </div>
          )}

          {result !== null && (
            <p style={noticeStyle} data-testid="restore-wizard-result">
              Restore {result.job.id} is {result.job.state} and was audited.
            </p>
          )}

          {startError !== null && (
            <p style={errorStyle} data-testid="restore-wizard-start-error">
              {startError}
            </p>
          )}
        </div>
      )}

      <div style={buttonRowStyle}>
        {stepIndex > 0 && (
          <button
            type="button"
            style={buttonStyle}
            onClick={goBack}
            disabled={busy}
            data-testid="restore-wizard-back"
          >
            Back
          </button>
        )}

        {step !== "confirm" && (
          <button
            type="button"
            style={
              canAdvance
                ? primaryButtonStyle
                : { ...primaryButtonStyle, ...disabledStyle }
            }
            onClick={goNext}
            disabled={!canAdvance}
            data-testid="restore-wizard-next"
          >
            {step === "target" ? "Review plan" : "Next"}
          </button>
        )}

        {step === "confirm" && (
          <>
            <button
              type="button"
              style={
                startDisabled ? { ...dangerButtonStyle, ...disabledStyle } : dangerButtonStyle
              }
              onClick={() => void handleStart()}
              disabled={startDisabled}
              data-testid="restore-wizard-start"
            >
              Start restore
            </button>
            <button type="button" style={buttonStyle} onClick={reset} disabled={busy} data-testid="restore-wizard-reset">
              Start another restore
            </button>
          </>
        )}
      </div>
    </div>
  );
}
