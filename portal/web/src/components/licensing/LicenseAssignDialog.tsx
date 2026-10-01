"use client";

// Per-user licence assign/remove dialog (EPIC-033 SPEC.md §3.4, §4.3; T-0648).
// Shows the T-0645 plan preview (before/after per user), requires explicit
// confirmation, and applies through the T-0645 endpoints with an Idempotency-Key,
// echoing the preview's planHash for a removal. Bulk operations render per-row
// results. Report theme tokens only, zero colour literals.

import React, { useEffect, useState, type CSSProperties, type ReactElement } from "react";
import {
  applyLicenseChange,
  previewLicenseChange,
  type LicenseChangeAction,
  type LicenseChangeOutcome,
  type LicenseChangeRowState,
  type LicensePlanPreview,
} from "../../lib/licensingApi";

export interface LicenseAssignDialogProps {
  readonly tenantId: string;
  readonly skuId: string;
  readonly skuPartNumber?: string;
  readonly action: LicenseChangeAction;
  readonly userIds: readonly string[];
  readonly onClose?: () => void;
  readonly onCompleted?: (outcome: LicenseChangeOutcome) => void;
  readonly fetcher?: typeof fetch;
  /** Injected for deterministic tests; defaults to crypto.randomUUID. */
  readonly idempotencyKeyFactory?: () => string;
}

const overlayStyle: CSSProperties = {
  position: "fixed",
  inset: 0,
  background: "color-mix(in oklab, var(--bg) 72%, transparent)",
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  padding: "24px",
  zIndex: 60,
};

const dialogStyle: CSSProperties = {
  width: "100%",
  maxWidth: "640px",
  maxHeight: "85vh",
  overflowY: "auto",
  background: "var(--bg-elev)",
  border: "1px solid var(--border)",
  borderRadius: "var(--radius, 10px)",
  boxShadow: "var(--shadow-card)",
  padding: "20px",
  display: "flex",
  flexDirection: "column",
  gap: "16px",
  fontFamily: "var(--font-sans, system-ui, sans-serif)",
  color: "var(--text)",
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

const dangerButtonStyle: CSSProperties = {
  ...buttonStyle,
  background: "var(--danger)",
  color: "var(--danger-text)",
  borderColor: "var(--danger)",
};

const disabledButtonStyle: CSSProperties = {
  ...primaryButtonStyle,
  opacity: 0.4,
  cursor: "not-allowed",
};

const planRowStyle: CSSProperties = {
  display: "flex",
  justifyContent: "space-between",
  alignItems: "center",
  gap: "12px",
  padding: "6px 0",
  borderTop: "1px solid var(--border)",
  fontSize: "13px",
};

const stateColor: Record<LicenseChangeRowState, string> = {
  applied: "var(--success-text)",
  planned: "var(--text-soft)",
  failed: "var(--danger-text)",
  skipped: "var(--muted)",
};

function defaultKey(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `license-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function planLabel(change: "assign" | "remove" | "unchanged"): string {
  if (change === "unchanged") return "no change";
  return change;
}

export function LicenseAssignDialog({
  tenantId,
  skuId,
  skuPartNumber,
  action,
  userIds,
  onClose,
  onCompleted,
  fetcher,
  idempotencyKeyFactory,
}: LicenseAssignDialogProps): ReactElement {
  const [preview, setPreview] = useState<LicensePlanPreview | null>(null);
  const [outcome, setOutcome] = useState<LicenseChangeOutcome | null>(null);
  const [confirmed, setConfirmed] = useState(false);
  const [reason, setReason] = useState("");
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const isBulk = userIds.length > 1;
  const title = action === "assign" ? "Assign licence" : "Remove licence";
  const sku = skuPartNumber ?? skuId;

  useEffect(() => {
    let active = true;
    setLoading(true);
    setError(null);
    previewLicenseChange(
      {
        tenantId,
        skuId,
        action,
        userIds,
        idempotencyKey: (idempotencyKeyFactory ?? defaultKey)(),
      },
      fetcher,
    )
      .then((result) => {
        if (active) setPreview(result);
      })
      .catch((err: unknown) => {
        if (active) setError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
    // The plan is computed once for the given target set.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tenantId, skuId, action, userIds.join(",")]);

  const canConfirm = confirmed && !submitting && preview !== null;

  const handleConfirm = async (): Promise<void> => {
    setSubmitting(true);
    setError(null);
    try {
      const result = await applyLicenseChange(
        {
          tenantId,
          skuId,
          action,
          userIds,
          confirm: true,
          confirmPlan: action === "remove" ? preview?.planHash ?? null : null,
          reason: reason.trim().length > 0 ? reason.trim() : null,
          idempotencyKey: (idempotencyKeyFactory ?? defaultKey)(),
        },
        fetcher,
      );
      setOutcome(result);
      onCompleted?.(result);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div style={overlayStyle} data-testid="license-assign-dialog">
      <div style={dialogStyle} role="dialog" aria-modal="true" aria-label={title}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <h2 style={{ margin: 0, fontSize: "18px" }}>
            {title}: {sku}
          </h2>
          <button type="button" style={buttonStyle} onClick={onClose} data-testid="license-dialog-close">
            Close
          </button>
        </div>

        <div style={{ fontSize: "13px", color: "var(--text-soft)" }} data-testid="license-dialog-target">
          {isBulk ? `Bulk ${action} for ${userIds.length} users` : `Single ${action} for ${userIds.length} user`}
        </div>

        {loading && (
          <div style={{ fontSize: "13px", color: "var(--text-soft)" }} data-testid="license-dialog-loading">
            Computing plan preview…
          </div>
        )}

        {preview && (
          <div data-testid="license-plan-preview">
            <div style={{ fontSize: "12px", color: "var(--text-soft)", textTransform: "uppercase", letterSpacing: "0.05em" }}>
              Plan preview
            </div>
            <div style={{ display: "flex", flexDirection: "column" }}>
              {preview.rows.map((row) => (
                <div key={row.userId} style={planRowStyle} data-testid={`license-plan-row-${row.userId}`}>
                  <span style={{ fontFamily: "var(--font-mono, monospace)" }}>
                    {row.displayName || row.userPrincipalName || row.userId}
                  </span>
                  <span style={{ color: "var(--text-soft)" }}>
                    {row.before.assigned ? "assigned" : "not assigned"} → {row.after.assigned ? "assigned" : "not assigned"} ({planLabel(row.change)})
                  </span>
                </div>
              ))}
            </div>
            {preview.requiresConfirmation && (
              <div
                style={{ marginTop: "8px", padding: "10px", background: "var(--warn-soft)", border: "1px solid var(--warn)", borderRadius: "6px", color: "var(--warn-text)", fontSize: "13px" }}
                data-testid="license-plan-confirmation-notice"
              >
                This removes a licence a user currently has. Review the preview before confirming.
              </div>
            )}
          </div>
        )}

        {outcome ? (
          <div data-testid="license-change-results">
            <div style={{ fontSize: "12px", color: "var(--text-soft)", textTransform: "uppercase", letterSpacing: "0.05em", marginBottom: "6px" }}>
              Results ({outcome.summary?.total ?? outcome.rows.length})
            </div>
            {outcome.rows.map((row) => (
              <div key={`${row.userId}-${row.skuId}`} style={planRowStyle} data-testid={`license-result-row-${row.userId}`}>
                <span style={{ fontFamily: "var(--font-mono, monospace)" }}>{row.userId}</span>
                <span style={{ color: stateColor[row.state] ?? "var(--text)" }} data-testid={`license-result-state-${row.userId}`}>
                  {row.state}
                  {row.error ? `: ${row.error}` : ""}
                </span>
              </div>
            ))}
            <div style={{ display: "flex", justifyContent: "flex-end", marginTop: "12px" }}>
              <button type="button" style={primaryButtonStyle} onClick={onClose} data-testid="license-dialog-done">
                Done
              </button>
            </div>
          </div>
        ) : (
          <>
            <label style={{ display: "flex", flexDirection: "column", gap: "6px" }}>
              <span style={{ fontSize: "13px", fontWeight: 600 }}>Reason (optional)</span>
              <input
                type="text"
                value={reason}
                onChange={(event) => setReason(event.target.value)}
                placeholder="Why is this changing?"
                style={{ padding: "8px 12px", background: "var(--input-bg, var(--bg))", border: "1px solid var(--border)", borderRadius: "6px", color: "var(--text)", fontSize: "14px" }}
                data-testid="license-dialog-reason"
              />
            </label>

            <label style={{ display: "flex", alignItems: "center", gap: "8px", fontSize: "13px" }}>
              <input
                type="checkbox"
                checked={confirmed}
                onChange={(event) => setConfirmed(event.target.checked)}
                data-testid="license-dialog-confirm-checkbox"
              />
              I have reviewed the plan preview and confirm this {action}.
            </label>

            {error && (
              <div
                style={{ padding: "10px", background: "var(--danger-soft)", border: "1px solid var(--danger)", borderRadius: "6px", color: "var(--danger-text)" }}
                role="alert"
                data-testid="license-dialog-error"
              >
                {error}
              </div>
            )}

            <div style={{ display: "flex", justifyContent: "flex-end", gap: "8px" }}>
              <button type="button" style={buttonStyle} onClick={onClose} data-testid="license-dialog-cancel">
                Cancel
              </button>
              <button
                type="button"
                style={canConfirm ? (action === "remove" ? dangerButtonStyle : primaryButtonStyle) : disabledButtonStyle}
                disabled={!canConfirm}
                onClick={() => void handleConfirm()}
                data-testid="license-dialog-confirm"
              >
                {submitting ? "Applying…" : isBulk ? `Confirm ${action} (${userIds.length})` : `Confirm ${action}`}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
