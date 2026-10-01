"use client";

// Restore wizard (EPIC-035 SPEC.md §3.2, §4.2; T-0686 preview, T-0687 apply,
// T-0689 UI). Four steps: pick a backup -> choose full or selective scope ->
// render the T-0686 added/changed/removed preview -> explicit destructive
// confirmation. The Restore button stays disabled until the preview has loaded
// and the operator has acknowledged that the restore overwrites current
// configuration (SPEC §3.2, §9). Report theme tokens only.

import React, { useEffect, useMemo, useState, type CSSProperties, type ReactElement } from "react";
import { backupName, formatDateTime, type BackupView } from "./BackupsTable";

export type RestoreScope = "full" | "selective";

export interface RestoreDiffEntry {
  readonly kind: "added" | "changed" | "removed";
  readonly id?: string | null;
  readonly row?: Record<string, unknown>;
  readonly before?: Record<string, unknown>;
  readonly after?: Record<string, unknown>;
}

export interface RestoreTableDiff {
  readonly table: string;
  readonly added?: readonly RestoreDiffEntry[];
  readonly changed?: readonly RestoreDiffEntry[];
  readonly removed?: readonly RestoreDiffEntry[];
}

export interface RestorePreview {
  readonly schemaVersion: number;
  readonly tables: readonly RestoreTableDiff[];
}

export interface RestoreRequest {
  readonly backupId: string;
  readonly tables?: readonly string[];
  readonly confirm: true;
}

export interface RestoreWizardProps {
  readonly open: boolean;
  readonly backups?: readonly BackupView[];
  readonly backup?: BackupView | null;
  readonly loadPreview?: (backupId: string, tables?: readonly string[]) => Promise<RestorePreview>;
  readonly onClose?: () => void;
  readonly onConfirm?: (request: RestoreRequest) => void | Promise<void>;
  readonly submitting?: boolean;
  readonly error?: string | null;
}

export const RESTORE_PREVIEW_PATH = (backupId: string): string =>
  `/v1/backups/${encodeURIComponent(backupId)}/restore/preview`;

export async function fetchRestorePreview(
  backupId: string,
  tables?: readonly string[],
  fetcher: typeof fetch = fetch,
): Promise<RestorePreview> {
  const response = await fetcher(RESTORE_PREVIEW_PATH(backupId), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(tables === undefined ? {} : { tables }),
  });
  if (!response.ok) {
    let detail = response.statusText;
    try {
      const body = (await response.json()) as { message?: string };
      if (body?.message) detail = body.message;
    } catch {
      // non-JSON error body; keep the status text
    }
    throw new Error(`Preview failed: ${response.status} ${detail}`);
  }
  return (await response.json()) as RestorePreview;
}

const STEP_LABELS = ["Backup", "Scope", "Preview", "Confirm"] as const;

const overlayStyle: CSSProperties = {
  position: "fixed",
  inset: 0,
  background: "var(--overlay-bg, var(--subtle))",
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  zIndex: 1000,
  padding: "16px",
};

const dialogStyle: CSSProperties = {
  background: "var(--bg-elev)",
  border: "1px solid var(--border)",
  borderRadius: "var(--radius, 10px)",
  boxShadow: "var(--shadow-card)",
  width: "100%",
  maxWidth: "720px",
  maxHeight: "90vh",
  display: "flex",
  flexDirection: "column",
  fontFamily: "var(--font-sans, system-ui, sans-serif)",
  color: "var(--text)",
  overflow: "hidden",
};

const headerStyle: CSSProperties = {
  padding: "18px 22px",
  borderBottom: "1px solid var(--border)",
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
};

const stepperStyle: CSSProperties = {
  display: "flex",
  gap: "8px",
  padding: "12px 22px",
  borderBottom: "1px solid var(--border)",
  background: "var(--surface)",
};

const stepPillStyle = (active: boolean, done: boolean): CSSProperties => ({
  padding: "4px 10px",
  borderRadius: "999px",
  fontSize: "12px",
  fontWeight: 600,
  background: active ? "var(--accent-soft)" : "var(--chip)",
  color: active ? "var(--accent-text)" : "var(--text-soft)",
  border: `1px solid ${done || active ? "var(--accent-border)" : "var(--border)"}`,
});

const bodyStyle: CSSProperties = {
  padding: "22px",
  overflowY: "auto",
  display: "flex",
  flexDirection: "column",
  gap: "16px",
  flex: 1,
};

const footerStyle: CSSProperties = {
  padding: "16px 22px",
  borderTop: "1px solid var(--border)",
  display: "flex",
  justifyContent: "space-between",
  gap: "10px",
};

const secondaryButtonStyle: CSSProperties = {
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
  ...secondaryButtonStyle,
  background: "var(--accent)",
  color: "var(--on-accent)",
  borderColor: "var(--accent)",
  fontWeight: 600,
};

const dangerButtonStyle: CSSProperties = {
  ...secondaryButtonStyle,
  background: "var(--danger)",
  color: "var(--on-accent)",
  borderColor: "var(--danger)",
  fontWeight: 600,
};

const disabledButtonStyle: CSSProperties = {
  ...secondaryButtonStyle,
  opacity: 0.5,
  cursor: "not-allowed",
};

const cardStyle: CSSProperties = {
  padding: "14px 16px",
  background: "var(--bg-elev)",
  border: "1px solid var(--border)",
  borderRadius: "var(--radius, 10px)",
};

const tableDiffStyle: CSSProperties = {
  padding: "12px 14px",
  background: "var(--surface)",
  border: "1px solid var(--border)",
  borderRadius: "8px",
};

function countEntries(entries?: readonly RestoreDiffEntry[]): number {
  return entries?.length ?? 0;
}

export function RestoreWizard({
  open,
  backups = [],
  backup = null,
  loadPreview = fetchRestorePreview,
  onClose,
  onConfirm,
  submitting = false,
  error = null,
}: RestoreWizardProps): ReactElement | null {
  const [step, setStep] = useState(0);
  const [selectedBackupId, setSelectedBackupId] = useState<string | null>(backup?.id ?? null);
  const [scope, setScope] = useState<RestoreScope>("full");
  const [selectedTables, setSelectedTables] = useState<readonly string[]>([]);
  const [preview, setPreview] = useState<RestorePreview | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [acknowledged, setAcknowledged] = useState(false);

  useEffect(() => {
    if (!open) return;
    setStep(0);
    setSelectedBackupId(backup?.id ?? null);
    setScope("full");
    setSelectedTables([]);
    setPreview(null);
    setPreviewError(null);
    setAcknowledged(false);
  }, [open, backup?.id]);

  useEffect(() => {
    if (!open || selectedBackupId === null) return;
    let cancelled = false;
    setPreviewLoading(true);
    setPreviewError(null);
    loadPreview(selectedBackupId)
      .then((result) => {
        if (!cancelled) setPreview(result);
      })
      .catch((err: unknown) => {
        if (!cancelled) {
          setPreviewError(err instanceof Error ? err.message : String(err));
        }
      })
      .finally(() => {
        if (!cancelled) setPreviewLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [open, selectedBackupId, loadPreview]);

  const availableTables = useMemo(
    () => preview?.tables.map((table) => table.table) ?? [],
    [preview],
  );

  const displayedTables = useMemo(() => {
    if (preview === null) return [];
    if (scope === "full") return preview.tables;
    return preview.tables.filter((table) => selectedTables.includes(table.table));
  }, [preview, scope, selectedTables]);

  if (!open) return null;

  const selectedBackup =
    backups.find((candidate) => candidate.id === selectedBackupId) ??
    (backup?.id === selectedBackupId ? backup : null);

  const toggleTable = (table: string): void => {
    setSelectedTables((current) =>
      current.includes(table) ? current.filter((name) => name !== table) : [...current, table],
    );
  };

  const canContinue =
    step === 0
      ? selectedBackupId !== null
      : step === 1
        ? scope === "full" || selectedTables.length > 0
        : step === 2
          ? preview !== null && previewError === null
          : true;

  const confirm = (): void => {
    if (selectedBackupId === null || !acknowledged || preview === null) return;
    const request: RestoreRequest =
      scope === "full"
        ? { backupId: selectedBackupId, confirm: true }
        : { backupId: selectedBackupId, tables: [...selectedTables], confirm: true };
    void onConfirm?.(request);
  };

  return (
    <div style={overlayStyle} data-testid="restore-wizard" role="dialog" aria-modal="true">
      <div style={dialogStyle}>
        <div style={headerStyle}>
          <h2 style={{ margin: 0, fontSize: "18px", fontWeight: 600 }}>Restore backup</h2>
          <button
            type="button"
            onClick={onClose}
            style={secondaryButtonStyle}
            aria-label="Close"
            data-testid="wizard-close"
          >
            Close
          </button>
        </div>

        <div style={stepperStyle} data-testid="wizard-stepper">
          {STEP_LABELS.map((label, index) => (
            <span
              key={label}
              style={stepPillStyle(index === step, index < step)}
              data-testid={`wizard-step-${label.toLowerCase()}`}
            >
              {index + 1}. {label}
            </span>
          ))}
        </div>

        <div style={bodyStyle}>
          {step === 0 && (
            <div data-testid="wizard-panel-backup" style={{ display: "flex", flexDirection: "column", gap: "10px" }}>
              <p style={{ margin: 0, color: "var(--text-soft)", fontSize: "13px" }}>
                Pick the backup to restore. Restoring overwrites the current configuration.
              </p>
              {backups.length === 0 && (
                <div style={{ color: "var(--text-soft)" }}>No backups available.</div>
              )}
              {backups.map((candidate) => (
                <button
                  key={candidate.id}
                  type="button"
                  onClick={() => setSelectedBackupId(candidate.id)}
                  style={{
                    ...cardStyle,
                    textAlign: "left",
                    cursor: "pointer",
                    borderColor:
                      candidate.id === selectedBackupId ? "var(--accent)" : "var(--border)",
                  }}
                  data-testid={`backup-option-${candidate.id}`}
                >
                  <div style={{ fontWeight: 600 }}>{backupName(candidate)}</div>
                  <div style={{ fontSize: "12px", color: "var(--text-soft)" }}>
                    {candidate.type} · {formatDateTime(candidate.createdAt)}
                  </div>
                </button>
              ))}
            </div>
          )}

          {step === 1 && (
            <div data-testid="wizard-panel-scope" style={{ display: "flex", flexDirection: "column", gap: "12px" }}>
              <p style={{ margin: 0, color: "var(--text-soft)", fontSize: "13px" }}>
                Choose whether to restore every table or a selective set.
              </p>
              <label style={{ display: "flex", gap: "8px", alignItems: "center" }}>
                <input
                  type="radio"
                  name="restore-scope"
                  checked={scope === "full"}
                  onChange={() => setScope("full")}
                  data-testid="scope-full"
                />
                Full restore
              </label>
              <label style={{ display: "flex", gap: "8px", alignItems: "center" }}>
                <input
                  type="radio"
                  name="restore-scope"
                  checked={scope === "selective"}
                  onChange={() => setScope("selective")}
                  data-testid="scope-selective"
                />
                Selective restore
              </label>

              {scope === "selective" && (
                <div style={cardStyle} data-testid="selective-tables">
                  {previewLoading && (
                    <div style={{ color: "var(--text-soft)" }}>Loading tables...</div>
                  )}
                  {!previewLoading && availableTables.length === 0 && (
                    <div style={{ color: "var(--text-soft)" }}>No tables available.</div>
                  )}
                  {availableTables.map((table) => (
                    <label
                      key={table}
                      style={{ display: "flex", gap: "8px", alignItems: "center", padding: "4px 0" }}
                    >
                      <input
                        type="checkbox"
                        checked={selectedTables.includes(table)}
                        onChange={() => toggleTable(table)}
                        data-testid={`table-checkbox-${table}`}
                      />
                      <span style={{ fontFamily: "var(--font-mono, monospace)", fontSize: "13px" }}>
                        {table}
                      </span>
                    </label>
                  ))}
                </div>
              )}
            </div>
          )}

          {step === 2 && (
            <div data-testid="wizard-panel-preview" style={{ display: "flex", flexDirection: "column", gap: "12px" }}>
              <p style={{ margin: 0, color: "var(--text-soft)", fontSize: "13px" }}>
                Review what this restore will change before confirming.
              </p>
              {previewLoading && (
                <div style={{ color: "var(--text-soft)" }}>Computing preview...</div>
              )}
              {previewError && (
                <div
                  role="alert"
                  data-testid="preview-error"
                  style={{
                    padding: "10px 12px",
                    borderRadius: "6px",
                    background: "var(--danger-soft)",
                    border: "1px solid var(--danger)",
                    color: "var(--danger-text)",
                  }}
                >
                  {previewError}
                </div>
              )}
              {!previewLoading && !previewError && preview !== null && displayedTables.length === 0 && (
                <div style={{ color: "var(--text-soft)" }} data-testid="preview-empty">
                  No changes to preview.
                </div>
              )}
              {!previewLoading &&
                !previewError &&
                displayedTables.map((table) => (
                  <div
                    key={table.table}
                    style={tableDiffStyle}
                    data-testid={`preview-table-${table.table}`}
                  >
                    <div
                      style={{
                        fontFamily: "var(--font-mono, monospace)",
                        fontWeight: 600,
                        marginBottom: "6px",
                      }}
                    >
                      {table.table}
                    </div>
                    <div style={{ display: "flex", gap: "12px", fontSize: "13px" }}>
                      <span style={{ color: "var(--success)" }} data-testid={`preview-added-${table.table}`}>
                        {countEntries(table.added)} added
                      </span>
                      <span style={{ color: "var(--warn)" }} data-testid={`preview-changed-${table.table}`}>
                        {countEntries(table.changed)} changed
                      </span>
                      <span style={{ color: "var(--danger)" }} data-testid={`preview-removed-${table.table}`}>
                        {countEntries(table.removed)} removed
                      </span>
                    </div>
                  </div>
                ))}
            </div>
          )}

          {step === 3 && (
            <div data-testid="wizard-panel-confirm" style={{ display: "flex", flexDirection: "column", gap: "14px" }}>
              <div
                style={{
                  padding: "12px 14px",
                  borderRadius: "8px",
                  background: "var(--danger-soft)",
                  border: "1px solid var(--danger)",
                  color: "var(--danger-text)",
                }}
                data-testid="destructive-warning"
              >
                Restoring is destructive to the current configuration. A pre-restore backup is
                taken automatically, but the current state will be overwritten.
              </div>
              <div style={{ fontSize: "13px", color: "var(--text-soft)" }}>
                Backup: {selectedBackup ? backupName(selectedBackup) : selectedBackupId} · Scope:{" "}
                {scope === "full" ? "full" : `${selectedTables.length} table(s)`}
              </div>
              <label style={{ display: "flex", gap: "8px", alignItems: "center" }}>
                <input
                  type="checkbox"
                  checked={acknowledged}
                  onChange={(event) => setAcknowledged(event.target.checked)}
                  data-testid="confirm-ack"
                />
                I understand this restore overwrites the current configuration.
              </label>
            </div>
          )}

          {error && (
            <div
              role="alert"
              style={{
                padding: "10px 12px",
                borderRadius: "6px",
                background: "var(--danger-soft)",
                border: "1px solid var(--danger)",
                color: "var(--danger-text)",
              }}
            >
              {error}
            </div>
          )}
        </div>

        <div style={footerStyle}>
          <button
            type="button"
            style={step === 0 ? disabledButtonStyle : secondaryButtonStyle}
            onClick={() => setStep((current) => Math.max(0, current - 1))}
            disabled={step === 0}
            data-testid="wizard-back"
          >
            Back
          </button>
          {step < 3 ? (
            <button
              type="button"
              style={canContinue ? primaryButtonStyle : disabledButtonStyle}
              onClick={() => canContinue && setStep((current) => current + 1)}
              disabled={!canContinue}
              data-testid="wizard-next"
            >
              Continue
            </button>
          ) : (
            <button
              type="button"
              style={acknowledged && preview !== null && !submitting ? dangerButtonStyle : disabledButtonStyle}
              onClick={confirm}
              disabled={!acknowledged || preview === null || submitting}
              data-testid="wizard-confirm"
            >
              {submitting ? "Restoring..." : "Restore"}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
