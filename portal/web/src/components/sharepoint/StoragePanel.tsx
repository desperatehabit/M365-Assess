"use client";

// Storage panel (EPIC-025 SPEC.md §3.3, §4.2; T-0487).
// Renders the site storage composition (documents/versions/recycle bin bytes
// and reclaimable total) and the version cleanup flow: age threshold + manual
// include/exclude override → plan preview → typed-count confirmation → apply.
// No removal happens on preview. Strictly uses report theme tokens with zero
// colour literals.

import React, { useState, type CSSProperties, type ReactElement } from "react";
import { formatBytes } from "./OneDriveTable";

export interface SiteStorageComposition {
  readonly tenantId: string;
  readonly siteId: string;
  readonly documentsBytes: number;
  readonly versionsBytes: number;
  readonly recycleBinBytes: number;
  readonly reclaimableBytes: number;
  readonly totalBytes: number;
  readonly generatedAt: string;
}

export interface VersionCleanupPlanEntry {
  readonly versionId: string;
  readonly itemId: string;
  readonly size: number;
  readonly lastModified: string;
  readonly isCurrent: boolean;
  readonly selected: boolean;
  readonly reason: string | null;
}

export interface VersionCleanupPlan {
  readonly jobId: string;
  readonly tenantId: string;
  readonly siteId: string;
  readonly mode: "plan";
  readonly state: "planned";
  readonly ageThresholdDays: number;
  readonly cutoffDate: string;
  readonly versions: readonly VersionCleanupPlanEntry[];
  readonly selectedCount: number;
  readonly reclaimableBytes: number;
  readonly writes: false;
}

export interface VersionCleanupResultRow {
  readonly versionId: string;
  readonly state: string;
  readonly before: unknown;
  readonly after: unknown;
  readonly appliedAt: string | null;
  readonly actor: string;
  readonly error: string | null;
}

export interface VersionCleanupApply {
  readonly jobId: string;
  readonly tenantId: string;
  readonly siteId: string;
  readonly mode: "apply";
  readonly state: string;
  readonly ageThresholdDays: number;
  readonly cutoffDate: string;
  readonly results: readonly VersionCleanupResultRow[];
  readonly auditEvents: readonly Record<string, unknown>[];
  readonly summary: {
    readonly total: number;
    readonly removed: number;
    readonly failed: number;
    readonly skipped: number;
  };
}

export interface StoragePanelProps {
  readonly storage: SiteStorageComposition | null;
  readonly loading?: boolean;
  readonly error?: string | null;
  readonly onPreviewCleanup: (input: {
    ageThresholdDays: number;
    includeVersions: string[];
    excludeVersions: string[];
  }) => Promise<VersionCleanupPlan>;
  readonly onApplyCleanup: (input: {
    ageThresholdDays: number;
    includeVersions: string[];
    excludeVersions: string[];
    confirmCount: number;
  }) => Promise<VersionCleanupApply>;
}

const containerStyle: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: "16px",
  width: "100%",
  fontFamily: "var(--font-sans, system-ui, sans-serif)",
  color: "var(--text)",
};

const cardRowStyle: CSSProperties = {
  display: "flex",
  flexWrap: "wrap",
  gap: "12px",
};

const cardStyle: CSSProperties = {
  flex: "1 1 180px",
  padding: "16px",
  background: "var(--bg-elev)",
  border: "1px solid var(--border)",
  borderRadius: "var(--radius, 10px)",
  display: "flex",
  flexDirection: "column",
  gap: "4px",
};

const cardLabelStyle: CSSProperties = {
  fontSize: "12px",
  color: "var(--text-soft)",
  textTransform: "uppercase",
  letterSpacing: "0.05em",
};

const cardValueStyle: CSSProperties = {
  fontSize: "20px",
  fontWeight: 700,
  fontFamily: "var(--font-mono, monospace)",
};

const cardSubStyle: CSSProperties = {
  fontSize: "12px",
  color: "var(--text-soft)",
};

const sectionStyle: CSSProperties = {
  padding: "16px",
  background: "var(--bg-elev)",
  border: "1px solid var(--border)",
  borderRadius: "var(--radius, 10px)",
  display: "flex",
  flexDirection: "column",
  gap: "12px",
};

const inputStyle: CSSProperties = {
  padding: "8px 12px",
  background: "var(--input-bg, var(--bg))",
  border: "1px solid var(--border)",
  borderRadius: "6px",
  color: "var(--text)",
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

const dangerButtonStyle: CSSProperties = {
  ...buttonStyle,
  background: "var(--danger)",
  color: "var(--danger-text, var(--text))",
  borderColor: "var(--danger)",
};

const warningBannerStyle: CSSProperties = {
  padding: "12px 14px",
  borderRadius: "6px",
  background: "var(--warning-soft)",
  border: "1px solid var(--warning)",
  color: "var(--warning-text)",
  fontSize: "13px",
  lineHeight: "1.4",
};

const errorBannerStyle: CSSProperties = {
  padding: "12px 14px",
  borderRadius: "6px",
  background: "var(--danger-soft)",
  border: "1px solid var(--danger)",
  color: "var(--danger-text)",
  fontSize: "13px",
};

const listStyle: CSSProperties = {
  margin: 0,
  padding: "8px 12px",
  listStyle: "none",
  background: "var(--surface)",
  border: "1px solid var(--border)",
  borderRadius: "6px",
  fontFamily: "var(--font-mono, monospace)",
  fontSize: "13px",
  maxHeight: "220px",
  overflowY: "auto",
  display: "flex",
  flexDirection: "column",
  gap: "6px",
};

const labelStyle: CSSProperties = {
  display: "block",
  fontSize: "13px",
  fontWeight: 600,
  marginBottom: "4px",
};

function isCountConfirmed(input: string, total: number): boolean {
  return total > 0 && input.trim() === String(total);
}

export function StoragePanel({
  storage,
  loading = false,
  error = null,
  onPreviewCleanup,
  onApplyCleanup,
}: StoragePanelProps): ReactElement {
  const [ageThresholdDays, setAgeThresholdDays] = useState(90);
  const [includeInput, setIncludeInput] = useState("");
  const [excludeInput, setExcludeInput] = useState("");
  const [plan, setPlan] = useState<VersionCleanupPlan | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [countInput, setCountInput] = useState("");
  const [applying, setApplying] = useState(false);
  const [applyError, setApplyError] = useState<string | null>(null);
  const [outcome, setOutcome] = useState<VersionCleanupApply | null>(null);

  const parseList = (value: string): string[] =>
    value
      .split(",")
      .map((entry) => entry.trim())
      .filter(Boolean);

  const canPreview = !previewLoading && !loading && storage !== null && plan === null;
  const countConfirmed = plan !== null && isCountConfirmed(countInput, plan.selectedCount);
  const canApply = plan !== null && countConfirmed && !applying && outcome === null;

  const handlePreview = async (): Promise<void> => {
    if (!canPreview) return;
    setPreviewLoading(true);
    setPreviewError(null);
    try {
      const result = await onPreviewCleanup({
        ageThresholdDays,
        includeVersions: parseList(includeInput),
        excludeVersions: parseList(excludeInput),
      });
      setPlan(result);
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
      const result = await onApplyCleanup({
        ageThresholdDays,
        includeVersions: parseList(includeInput),
        excludeVersions: parseList(excludeInput),
        confirmCount: plan.selectedCount,
      });
      setOutcome(result);
    } catch (err) {
      setApplyError(err instanceof Error ? err.message : String(err));
    } finally {
      setApplying(false);
    }
  };

  return (
    <div style={containerStyle} data-testid="storage-panel">
      <div style={cardRowStyle} data-testid="storage-composition">
        <div style={cardStyle}>
          <span style={cardLabelStyle}>Documents</span>
          <span style={cardValueStyle}>{storage ? formatBytes(storage.documentsBytes) : "—"}</span>
          <span style={cardSubStyle}>current files</span>
        </div>
        <div style={cardStyle}>
          <span style={cardLabelStyle}>Versions</span>
          <span style={cardValueStyle}>{storage ? formatBytes(storage.versionsBytes) : "—"}</span>
          <span style={cardSubStyle}>all item versions</span>
        </div>
        <div style={cardStyle}>
          <span style={cardLabelStyle}>Recycle bin</span>
          <span style={cardValueStyle}>{storage ? formatBytes(storage.recycleBinBytes) : "—"}</span>
          <span style={cardSubStyle}>deleted items</span>
        </div>
        <div style={cardStyle}>
          <span style={cardLabelStyle}>Reclaimable</span>
          <span style={cardValueStyle}>{storage ? formatBytes(storage.reclaimableBytes) : "—"}</span>
          <span style={cardSubStyle}>versions + recycle bin</span>
        </div>
      </div>

      {error && (
        <div style={errorBannerStyle} role="alert" data-testid="storage-error">
          {error}
        </div>
      )}

      <div style={sectionStyle} data-testid="version-cleanup-section">
        <h3 style={{ margin: 0, fontSize: "16px", fontWeight: 600 }}>Version cleanup</h3>

        <div style={warningBannerStyle} data-testid="cleanup-warning">
          Version cleanup is irreversible for old versions. Preview shows exactly what will be removed
          before apply. The current version is always protected.
        </div>

        {previewError && (
          <div style={errorBannerStyle} role="alert" data-testid="cleanup-preview-error">
            {previewError}
          </div>
        )}

        {applyError && (
          <div style={errorBannerStyle} role="alert" data-testid="cleanup-apply-error">
            {applyError}
          </div>
        )}

        <div style={{ display: "flex", flexWrap: "wrap", gap: "12px", alignItems: "flex-end" }}>
          <div>
            <label htmlFor="cleanup-age-threshold" style={labelStyle}>
              Age threshold (days):
            </label>
            <input
              id="cleanup-age-threshold"
              type="number"
              min={0}
              max={3650}
              value={ageThresholdDays}
              onChange={(e) => setAgeThresholdDays(Number(e.target.value))}
              style={inputStyle}
              data-testid="cleanup-age-threshold"
            />
          </div>
          <div>
            <label htmlFor="cleanup-include" style={labelStyle}>
              Include versions (comma-separated):
            </label>
            <input
              id="cleanup-include"
              type="text"
              placeholder="v1,v2"
              value={includeInput}
              onChange={(e) => setIncludeInput(e.target.value)}
              style={inputStyle}
              data-testid="cleanup-include"
            />
          </div>
          <div>
            <label htmlFor="cleanup-exclude" style={labelStyle}>
              Exclude versions (comma-separated):
            </label>
            <input
              id="cleanup-exclude"
              type="text"
              placeholder="v3,v4"
              value={excludeInput}
              onChange={(e) => setExcludeInput(e.target.value)}
              style={inputStyle}
              data-testid="cleanup-exclude"
            />
          </div>
        </div>

        {plan === null ? (
          <div style={{ display: "flex", gap: "10px" }}>
            <button
              type="button"
              disabled={!canPreview}
              onClick={() => void handlePreview()}
              style={{ ...buttonStyle, ...(!canPreview ? { opacity: 0.6, cursor: "not-allowed" } : {}) }}
              data-testid="cleanup-preview-button"
            >
              {previewLoading ? "Loading plan…" : "Preview cleanup"}
            </button>
          </div>
        ) : (
          <>
            <div data-testid="cleanup-plan">
              <div style={{ fontSize: "13px", color: "var(--text-soft)" }} data-testid="cleanup-plan-count">
                Plan: {plan.selectedCount} version{plan.selectedCount === 1 ? "" : "s"} will be removed (
                {formatBytes(plan.reclaimableBytes)})
              </div>
              <ul style={listStyle}>
                {plan.versions
                  .filter((v) => v.selected)
                  .map((v) => (
                    <li key={v.versionId} data-testid={`cleanup-plan-version-${v.versionId}`}>
                      {v.versionId} · {v.itemId} · {formatBytes(v.size)} · {v.lastModified}
                    </li>
                  ))}
              </ul>
            </div>

            {outcome === null ? (
              <>
                <div>
                  <label htmlFor="cleanup-confirm-count" style={labelStyle}>
                    Confirm removal (type <strong>{plan.selectedCount}</strong> to confirm):
                  </label>
                  <input
                    id="cleanup-confirm-count"
                    type="text"
                    placeholder={String(plan.selectedCount)}
                    value={countInput}
                    onChange={(e) => setCountInput(e.target.value)}
                    style={inputStyle}
                    data-testid="cleanup-confirm-count"
                  />
                </div>

                <div style={{ display: "flex", gap: "10px" }}>
                  <button
                    type="button"
                    disabled={!canApply}
                    onClick={() => void handleApply()}
                    style={{ ...dangerButtonStyle, ...(!canApply ? { opacity: 0.6, cursor: "not-allowed" } : {}) }}
                    data-testid="cleanup-apply-button"
                  >
                    {applying ? "Removing…" : `Remove ${plan.selectedCount} version${plan.selectedCount === 1 ? "" : "s"}`}
                  </button>
                </div>
              </>
            ) : (
              <div data-testid="cleanup-results">
                <div data-testid="cleanup-results-summary">
                  Removed {outcome.summary.removed} of {outcome.summary.total} versions
                  {outcome.summary.failed > 0 ? ` — ${outcome.summary.failed} failed` : ""}
                  {outcome.summary.skipped > 0 ? ` — ${outcome.summary.skipped} skipped` : ""}
                </div>
                <ul style={{ listStyle: "none", margin: "8px 0 0", padding: 0 }}>
                  {outcome.results.map((row) => (
                    <li key={row.versionId} data-testid={`cleanup-result-${row.versionId}`}>
                      <span data-testid={`cleanup-result-status-${row.versionId}`}>{row.state}</span>
                      {" · "}
                      <span>{row.versionId}</span>
                      {row.state === "failed" && (
                        <span role="alert" data-testid={`cleanup-result-error-${row.versionId}`}>
                          {" "}
                          — {row.error ?? "removal failed without detail"}
                        </span>
                      )}
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
