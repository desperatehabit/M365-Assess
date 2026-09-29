"use client";

// Remove-links dialog (EPIC-027 SPEC.md §3.4, §4.2; T-0528).
// Bulk-removal flow fed by the Sharing Report row/bulk actions: reason → plan
// preview (T-0527 preview mode, exactly the links that will be removed) → typed
// count confirmation → apply → per-link results. The count gate mirrors the
// server's confirmCount check, so apply can never fire without naming the count.

import { useState, type CSSProperties, type ReactElement } from "react";
import {
  RemovalPlanPreview,
  type SharingLinkPlanEntry,
  type SharingLinkRef,
} from "./RemovalPlanPreview";

export type SharingLinkRemovalStatus = "removed" | "failed" | "skipped";

export interface SharingLinkRemovalRow extends SharingLinkRef {
  readonly status: SharingLinkRemovalStatus;
  readonly error: string | null;
}

export interface SharingLinkRemovalSummary {
  readonly total: number;
  readonly removed: number;
  readonly failed: number;
  readonly skipped: number;
}

export interface SharingLinkRemovalOutcome {
  readonly jobId: string;
  readonly rows: readonly SharingLinkRemovalRow[];
  readonly summary: SharingLinkRemovalSummary;
}

export interface RemoveLinksDialogProps {
  readonly isOpen: boolean;
  readonly onClose: () => void;
  readonly tenantId: string;
  readonly links: readonly SharingLinkRef[];
  readonly onRemoved?: (outcome: SharingLinkRemovalOutcome) => void;
  readonly fetcher?: typeof fetch;
}

export function removeSharingLinksUrl(tenantId: string): string {
  return `/v1/tenants/${encodeURIComponent(tenantId)}/sharing/links/remove`;
}

/** The typed-count gate: apply is enabled only when the operator names the count. */
export function isCountConfirmed(input: string, total: number): boolean {
  return total > 0 && input.trim() === String(total);
}

interface RemovalPlan {
  readonly links: readonly SharingLinkPlanEntry[];
  readonly total: number;
}

const overlayStyle: CSSProperties = {
  position: "fixed",
  inset: 0,
  background: "var(--overlay)",
  zIndex: 60,
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
};

const dialogStyle: CSSProperties = {
  background: "var(--bg-elev)",
  border: "1px solid var(--border)",
  borderRadius: "var(--radius, 10px)",
  padding: "24px",
  width: "min(600px, 92vw)",
  maxHeight: "90vh",
  overflowY: "auto",
  display: "flex",
  flexDirection: "column",
  gap: "16px",
  color: "var(--text)",
  fontFamily: "var(--font-sans, system-ui, sans-serif)",
};

const titleStyle: CSSProperties = {
  margin: 0,
  fontSize: "20px",
  fontWeight: 700,
};

const warningBannerStyle: CSSProperties = {
  padding: "12px 14px",
  borderRadius: "6px",
  background: "var(--warning-soft)",
  border: "1px solid var(--warning)",
  color: "var(--warning-text)",
  fontSize: "13px",
  lineHeight: 1.4,
};

const errorBannerStyle: CSSProperties = {
  padding: "12px 14px",
  borderRadius: "6px",
  background: "var(--danger-soft)",
  border: "1px solid var(--danger)",
  color: "var(--danger-text)",
  fontSize: "13px",
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
  padding: "8px 16px",
  background: "var(--surface)",
  border: "1px solid var(--border)",
  borderRadius: "6px",
  color: "var(--text)",
  fontSize: "14px",
  fontWeight: 500,
  cursor: "pointer",
};

const dangerButtonStyle: CSSProperties = {
  ...buttonStyle,
  background: "var(--danger)",
  color: "var(--danger-text, var(--text))",
  borderColor: "var(--danger)",
};

async function postJson(fetcher: typeof fetch, url: string, body: unknown): Promise<unknown> {
  const response = await fetcher(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    let detail = response.statusText;
    try {
      const payload = (await response.json()) as { message?: string };
      if (payload?.message) detail = payload.message;
    } catch {
      // non-JSON error body; keep the status text
    }
    throw new Error(`Sharing-link removal failed: ${response.status} ${detail}`);
  }
  return response.json();
}

export function RemoveLinksDialog({
  isOpen,
  onClose,
  tenantId,
  links,
  onRemoved,
  fetcher,
}: RemoveLinksDialogProps): ReactElement | null {
  const [reason, setReason] = useState("");
  const [plan, setPlan] = useState<RemovalPlan | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [countInput, setCountInput] = useState("");
  const [applying, setApplying] = useState(false);
  const [applyError, setApplyError] = useState<string | null>(null);
  const [outcome, setOutcome] = useState<SharingLinkRemovalOutcome | null>(null);

  if (!isOpen) {
    return null;
  }

  const runFetch = fetcher ?? fetch;
  const canPreview =
    reason.trim().length > 0 && links.length > 0 && !previewLoading && plan === null;
  const countConfirmed = plan !== null && isCountConfirmed(countInput, plan.total);
  const canApply =
    plan !== null && countConfirmed && !applying && outcome === null && reason.trim().length > 0;

  const handlePreview = async (): Promise<void> => {
    if (!canPreview) return;
    setPreviewLoading(true);
    setPreviewError(null);
    try {
      const body = (await postJson(runFetch, removeSharingLinksUrl(tenantId), {
        links,
        reason: reason.trim(),
        preview: true,
      })) as { links: SharingLinkPlanEntry[]; total: number };
      setPlan({ links: body.links, total: body.total });
    } catch (err) {
      setPreviewError(err instanceof Error ? err.message : String(err));
    } finally {
      setPreviewLoading(false);
    }
  };

  const handleApply = async (): Promise<void> => {
    if (!canApply || plan === null) return;
    setApplying(true);
    setApplyError(null);
    try {
      const body = (await postJson(runFetch, removeSharingLinksUrl(tenantId), {
        links,
        reason: reason.trim(),
        confirm: true,
        confirmCount: plan.total,
      })) as { jobId: string; rows: SharingLinkRemovalRow[]; summary: SharingLinkRemovalSummary };
      const result: SharingLinkRemovalOutcome = {
        jobId: body.jobId,
        rows: body.rows,
        summary: body.summary,
      };
      setOutcome(result);
      onRemoved?.(result);
    } catch (err) {
      setApplyError(err instanceof Error ? err.message : String(err));
    } finally {
      setApplying(false);
    }
  };

  return (
    <div
      style={overlayStyle}
      role="dialog"
      aria-modal="true"
      aria-label="Remove sharing links"
      data-testid="remove-links-dialog"
    >
      <div style={dialogStyle}>
        <h2 style={titleStyle}>Remove sharing links</h2>

        <div style={warningBannerStyle} data-testid="remove-links-warning">
          <strong>High blast radius:</strong> removing {links.length} sharing link
          {links.length === 1 ? "" : "s"} revokes access immediately and cannot be undone.
          Review the plan preview, then type the link count to confirm. Each removal is
          audited.
        </div>

        {previewError && (
          <div style={errorBannerStyle} role="alert" data-testid="remove-preview-error">
            {previewError}
          </div>
        )}

        {applyError && (
          <div style={errorBannerStyle} role="alert" data-testid="remove-apply-error">
            {applyError}
          </div>
        )}

        <div>
          <label
            htmlFor="remove-reason"
            style={{ display: "block", fontSize: "13px", fontWeight: 600, marginBottom: "4px" }}
          >
            Reason for removal (required):
          </label>
          <input
            id="remove-reason"
            type="text"
            placeholder="e.g. Anonymous links on sensitive site"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            style={inputStyle}
            aria-label="Reason for removal"
            data-testid="remove-reason-input"
          />
        </div>

        {plan === null ? (
          <div style={{ display: "flex", gap: "10px", justifyContent: "flex-end" }}>
            <button type="button" style={buttonStyle} onClick={onClose} data-testid="remove-cancel-button">
              Cancel
            </button>
            <button
              type="button"
              disabled={!canPreview}
              onClick={() => void handlePreview()}
              style={{
                ...buttonStyle,
                ...(!canPreview ? { opacity: 0.6, cursor: "not-allowed" } : {}),
              }}
              data-testid="remove-load-preview"
            >
              {previewLoading ? "Loading plan preview…" : "Show plan preview"}
            </button>
          </div>
        ) : (
          <>
            <RemovalPlanPreview links={plan.links} total={plan.total} />

            {outcome === null ? (
              <>
                <div>
                  <label
                    htmlFor="remove-confirm-count"
                    style={{ display: "block", fontSize: "13px", fontWeight: 600, marginBottom: "4px" }}
                  >
                    Confirm removal (type <strong>{plan.total}</strong> to confirm):
                  </label>
                  <input
                    id="remove-confirm-count"
                    type="text"
                    placeholder={String(plan.total)}
                    value={countInput}
                    onChange={(e) => setCountInput(e.target.value)}
                    style={inputStyle}
                    aria-label="Confirm link count"
                    data-testid="remove-confirm-count-input"
                  />
                </div>

                <div style={{ display: "flex", gap: "10px", justifyContent: "flex-end" }}>
                  <button
                    type="button"
                    style={buttonStyle}
                    onClick={onClose}
                    data-testid="remove-cancel-button"
                  >
                    Cancel
                  </button>
                  <button
                    type="button"
                    disabled={!canApply}
                    onClick={() => void handleApply()}
                    style={{
                      ...dangerButtonStyle,
                      ...(!canApply ? { opacity: 0.6, cursor: "not-allowed" } : {}),
                    }}
                    data-testid="remove-apply-button"
                  >
                    {applying ? "Removing…" : `Remove ${plan.total} link${plan.total === 1 ? "" : "s"}`}
                  </button>
                </div>
              </>
            ) : (
              <div data-testid="remove-results">
                <div data-testid="remove-results-summary">
                  Removed {outcome.summary.removed} of {outcome.summary.total} links
                  {outcome.summary.failed > 0 ? ` — ${outcome.summary.failed} failed` : ""}
                  {outcome.summary.skipped > 0 ? ` — ${outcome.summary.skipped} skipped` : ""}
                </div>
                <ul style={{ listStyle: "none", margin: "8px 0 0", padding: 0 }}>
                  {outcome.rows.map((row) => (
                    <li key={row.linkId} data-testid={`remove-result-${row.linkId}`}>
                      <span data-testid={`remove-result-status-${row.linkId}`}>{row.status}</span>
                      {" · "}
                      <span>{row.linkId}</span>
                      {row.status === "failed" && (
                        <span role="alert" data-testid={`remove-result-error-${row.linkId}`}>
                          {" "}
                          — {row.error ?? "removal failed without detail"}
                        </span>
                      )}
                      {row.status === "skipped" && row.error && (
                        <span data-testid={`remove-result-error-${row.linkId}`}> — {row.error}</span>
                      )}
                    </li>
                  ))}
                </ul>
                <div style={{ display: "flex", gap: "10px", justifyContent: "flex-end", marginTop: "12px" }}>
                  <button type="button" style={buttonStyle} onClick={onClose} data-testid="remove-done-button">
                    Done
                  </button>
                </div>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
