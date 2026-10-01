"use client";

// Backups page (EPIC-035 SPEC.md §3.1, §3.2; T-0689). Nav: Tenant Administration
// -> Backup. Lists every backup through the T-0685 GET /v1/backups, wires the
// Download/Restore/Delete row actions and the primary New backup, and hosts the
// restore wizard (T-0686 preview, T-0687 apply). Report theme tokens only.

import React, { useCallback, useEffect, useState, type CSSProperties, type ReactElement } from "react";
import { BackupsTable, type BackupView } from "../../components/backup/BackupsTable";
import {
  NewBackupDialog,
  type NewBackupFormData,
} from "../../components/backup/NewBackupDialog";
import { RestoreWizard, type RestoreRequest } from "../../components/backup/RestoreWizard";

export const BACKUPS_API_PATH = "/v1/backups";

export type Fetcher = typeof fetch;

interface BackupsListResponse {
  readonly items?: readonly BackupView[];
}

async function errorMessage(response: Response, fallback: string): Promise<string> {
  try {
    const body = (await response.json()) as { message?: string };
    if (typeof body.message === "string" && body.message.length > 0) return body.message;
  } catch {
    // non-JSON error body; keep the fallback
  }
  return fallback;
}

export async function loadBackups(fetcher: Fetcher = fetch): Promise<readonly BackupView[]> {
  const response = await fetcher(BACKUPS_API_PATH);
  if (!response.ok) {
    throw new Error(await errorMessage(response, `Failed to load backups (HTTP ${response.status})`));
  }
  const body = (await response.json()) as BackupsListResponse;
  return body.items ?? [];
}

export async function createBackup(
  input: NewBackupFormData,
  fetcher: Fetcher = fetch,
): Promise<void> {
  const response = await fetcher(BACKUPS_API_PATH, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(
      input.type === "tenant" ? { type: input.type, tenantId: input.tenantId } : { type: input.type },
    ),
  });
  if (!response.ok) {
    throw new Error(await errorMessage(response, `Failed to create backup (HTTP ${response.status})`));
  }
}

export async function deleteBackup(backupId: string, fetcher: Fetcher = fetch): Promise<void> {
  const response = await fetcher(`${BACKUPS_API_PATH}/${encodeURIComponent(backupId)}`, {
    method: "DELETE",
  });
  if (!response.ok) {
    throw new Error(await errorMessage(response, `Failed to delete backup (HTTP ${response.status})`));
  }
}

export async function restoreBackup(
  request: RestoreRequest,
  fetcher: Fetcher = fetch,
): Promise<void> {
  const body: Record<string, unknown> = { confirm: true };
  if (request.tables !== undefined) body.tables = [...request.tables];
  const response = await fetcher(
    `${BACKUPS_API_PATH}/${encodeURIComponent(request.backupId)}/restore`,
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "Idempotency-Key": crypto.randomUUID(),
      },
      body: JSON.stringify(body),
    },
  );
  if (!response.ok) {
    throw new Error(await errorMessage(response, `Restore failed (HTTP ${response.status})`));
  }
}

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
  alignItems: "center",
  borderBottom: "1px solid var(--border)",
  paddingBottom: "16px",
};

const titleStyle: CSSProperties = {
  fontSize: "24px",
  fontWeight: 700,
  margin: 0,
  fontFamily: "var(--font-display, var(--font-sans))",
};

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
  padding: "22px",
  maxWidth: "420px",
  width: "100%",
  display: "flex",
  flexDirection: "column",
  gap: "16px",
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

const dangerButtonStyle: CSSProperties = {
  ...secondaryButtonStyle,
  background: "var(--danger)",
  color: "var(--on-accent)",
  borderColor: "var(--danger)",
  fontWeight: 600,
};

export interface BackupsViewProps {
  readonly fetcher?: Fetcher;
}

export function BackupsView({ fetcher = fetch }: BackupsViewProps): ReactElement {
  const [backups, setBackups] = useState<readonly BackupView[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [dialogError, setDialogError] = useState<string | null>(null);
  const [wizardBackup, setWizardBackup] = useState<BackupView | null>(null);
  const [restoring, setRestoring] = useState(false);
  const [restoreError, setRestoreError] = useState<string | null>(null);
  const [pendingDelete, setPendingDelete] = useState<BackupView | null>(null);

  const refresh = useCallback(async (): Promise<void> => {
    setLoading(true);
    setError(null);
    try {
      setBackups(await loadBackups(fetcher));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [fetcher]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const handleDownload = (backup: BackupView): void => {
    window.location.assign(`${BACKUPS_API_PATH}/${encodeURIComponent(backup.id)}/download`);
  };

  const handleNewBackup = async (data: NewBackupFormData): Promise<void> => {
    setSubmitting(true);
    setDialogError(null);
    try {
      await createBackup(data, fetcher);
      setDialogOpen(false);
      await refresh();
    } catch (err) {
      setDialogError(err instanceof Error ? err.message : String(err));
    } finally {
      setSubmitting(false);
    }
  };

  const handleConfirmRestore = async (request: RestoreRequest): Promise<void> => {
    setRestoring(true);
    setRestoreError(null);
    try {
      await restoreBackup(request, fetcher);
      setWizardBackup(null);
      await refresh();
    } catch (err) {
      setRestoreError(err instanceof Error ? err.message : String(err));
    } finally {
      setRestoring(false);
    }
  };

  const handleConfirmDelete = async (): Promise<void> => {
    if (pendingDelete === null) return;
    const target = pendingDelete;
    setPendingDelete(null);
    try {
      await deleteBackup(target.id, fetcher);
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  return (
    <div style={pageStyle} data-testid="backups-page">
      <div style={headerStyle}>
        <div>
          <h1 style={titleStyle}>Backups</h1>
          <p style={{ margin: "4px 0 0", color: "var(--text-soft)", fontSize: "14px" }}>
            Back up and restore the portal configuration. Restoring overwrites current state.
          </p>
        </div>
      </div>

      <BackupsTable
        backups={backups}
        loading={loading}
        error={error}
        onDownload={handleDownload}
        onRestore={(backup) => {
          setRestoreError(null);
          setWizardBackup(backup);
        }}
        onDelete={(backup) => setPendingDelete(backup)}
        onNewBackup={() => {
          setDialogError(null);
          setDialogOpen(true);
        }}
      />

      <NewBackupDialog
        open={dialogOpen}
        onClose={() => setDialogOpen(false)}
        onSubmit={handleNewBackup}
        submitting={submitting}
        error={dialogError}
      />

      <RestoreWizard
        open={wizardBackup !== null}
        backups={backups}
        backup={wizardBackup}
        onClose={() => setWizardBackup(null)}
        onConfirm={handleConfirmRestore}
        submitting={restoring}
        error={restoreError}
      />

      {pendingDelete && (
        <div style={overlayStyle} data-testid="delete-confirm" role="dialog" aria-modal="true">
          <div style={dialogStyle}>
            <h2 style={{ margin: 0, fontSize: "18px", fontWeight: 600 }}>Delete backup</h2>
            <p style={{ margin: 0, color: "var(--text-soft)", fontSize: "14px" }}>
              Delete this backup and its archive? This cannot be undone.
            </p>
            <div style={{ display: "flex", justifyContent: "flex-end", gap: "10px" }}>
              <button
                type="button"
                style={secondaryButtonStyle}
                onClick={() => setPendingDelete(null)}
                data-testid="delete-cancel"
              >
                Cancel
              </button>
              <button
                type="button"
                style={dangerButtonStyle}
                onClick={handleConfirmDelete}
                data-testid="delete-confirm-button"
              >
                Delete
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

export default function BackupsPage(): ReactElement {
  return <BackupsView />;
}
