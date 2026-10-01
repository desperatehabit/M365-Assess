"use client";

// Backups table (EPIC-035 SPEC.md §3.1; T-0689). Renders every §3.1 column
// (Name, Type, Scope, Created, Size, Location) and the row actions
// (Download, Restore, Delete) plus the primary New backup button. The BFF view
// (T-0685 toBackupView) carries id/type/tenantId/createdAt/artifactRef; name,
// size and location are optional display fields the page may enrich, so the
// table derives a readable default for each. Report theme tokens only.

import React, { type CSSProperties, type ReactElement } from "react";

export type BackupType = "instance" | "tenant";

export interface BackupView {
  readonly id: string;
  readonly name?: string | null;
  readonly type: BackupType | string;
  readonly tenantId?: string | null;
  readonly scope?: string | null;
  readonly createdAt: string;
  readonly createdBy?: string | null;
  readonly schemaVersion?: number;
  readonly artifactRef?: string | null;
  readonly checksum?: string | null;
  readonly sizeBytes?: number | null;
  readonly size?: number | null;
  readonly location?: string | null;
}

export interface BackupsTableProps {
  readonly backups?: readonly BackupView[];
  readonly loading?: boolean;
  readonly error?: string | null;
  readonly onDownload?: (backup: BackupView) => void;
  readonly onRestore?: (backup: BackupView) => void;
  readonly onDelete?: (backup: BackupView) => void;
  readonly onNewBackup?: () => void;
}

export function formatDateTime(isoString?: string | null): string {
  if (!isoString) return "—";
  const date = new Date(isoString);
  if (isNaN(date.getTime())) return isoString;
  return date.toLocaleString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export function formatBytes(bytes?: number | null): string {
  if (bytes === undefined || bytes === null || !Number.isFinite(bytes) || bytes < 0) {
    return "—";
  }
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(1)} ${units[unit]}`;
}

export function backupName(backup: BackupView): string {
  return backup.name?.trim() || backup.id;
}

export function backupScope(backup: BackupView): string {
  if (backup.scope?.trim()) return backup.scope.trim();
  if (backup.type === "instance") return "Instance";
  return backup.tenantId?.trim() || "Tenant";
}

export function backupSize(backup: BackupView): string {
  const bytes = backup.sizeBytes ?? backup.size;
  return formatBytes(bytes);
}

export function backupLocation(backup: BackupView): string {
  return backup.location?.trim() || backup.artifactRef?.trim() || "—";
}

export function getTypeBadgeStyle(type: string): CSSProperties {
  const base: CSSProperties = {
    display: "inline-flex",
    alignItems: "center",
    gap: "6px",
    padding: "2px 8px",
    borderRadius: "999px",
    fontSize: "12px",
    fontWeight: 600,
    textTransform: "capitalize",
    fontFamily: "var(--font-sans, system-ui, sans-serif)",
  };
  if (type === "instance") {
    return {
      ...base,
      background: "var(--accent-soft)",
      color: "var(--accent-text)",
      border: "1px solid var(--accent-border)",
    };
  }
  return {
    ...base,
    background: "var(--chip)",
    color: "var(--text-soft)",
    border: "1px solid var(--border)",
  };
}

const containerStyle: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: "16px",
  width: "100%",
  fontFamily: "var(--font-sans, system-ui, sans-serif)",
  color: "var(--text)",
};

const headerBarStyle: CSSProperties = {
  display: "flex",
  flexWrap: "wrap",
  gap: "12px",
  alignItems: "center",
  justifyContent: "space-between",
  padding: "16px",
  background: "var(--bg-elev)",
  border: "1px solid var(--border)",
  borderRadius: "var(--radius, 10px)",
};

const primaryButtonStyle: CSSProperties = {
  padding: "8px 14px",
  background: "var(--accent)",
  border: "1px solid var(--accent)",
  borderRadius: "6px",
  color: "var(--on-accent)",
  fontSize: "14px",
  fontWeight: 600,
  cursor: "pointer",
};

const tableWrapperStyle: CSSProperties = {
  overflowX: "auto",
  background: "var(--bg-elev)",
  border: "1px solid var(--border)",
  borderRadius: "var(--radius, 10px)",
  boxShadow: "var(--shadow-card)",
};

const tableStyle: CSSProperties = {
  width: "100%",
  borderCollapse: "collapse",
  fontSize: "14px",
  textAlign: "left",
};

const thStyle: CSSProperties = {
  padding: "12px 16px",
  borderBottom: "1px solid var(--border)",
  background: "var(--surface)",
  color: "var(--text-soft)",
  fontWeight: 600,
  fontSize: "12px",
  textTransform: "uppercase",
  letterSpacing: "0.05em",
  whiteSpace: "nowrap",
};

const tdStyle: CSSProperties = {
  padding: "12px 16px",
  borderBottom: "1px solid var(--border)",
  color: "var(--text)",
  verticalAlign: "middle",
};

const monoStyle: CSSProperties = {
  fontFamily: "var(--font-mono, monospace)",
  fontSize: "13px",
  color: "var(--text)",
};

const actionBtnStyle: CSSProperties = {
  padding: "4px 8px",
  background: "var(--surface)",
  border: "1px solid var(--border)",
  borderRadius: "4px",
  color: "var(--text)",
  fontSize: "12px",
  cursor: "pointer",
  whiteSpace: "nowrap",
};

const dangerActionBtnStyle: CSSProperties = {
  ...actionBtnStyle,
  color: "var(--danger-text)",
  borderColor: "var(--danger-border)",
};

export function BackupsTable({
  backups = [],
  loading = false,
  error = null,
  onDownload,
  onRestore,
  onDelete,
  onNewBackup,
}: BackupsTableProps): ReactElement {
  return (
    <div style={containerStyle} data-testid="backups-table-container">
      <div style={headerBarStyle}>
        <div style={{ display: "flex", alignItems: "center", gap: "12px" }}>
          <h2 style={{ margin: 0, fontSize: "20px", fontWeight: 600 }}>Backups</h2>
          <span
            style={{
              padding: "2px 8px",
              background: "var(--surface)",
              border: "1px solid var(--border)",
              borderRadius: "999px",
              fontSize: "12px",
              color: "var(--text-soft)",
            }}
          >
            {backups.length} {backups.length === 1 ? "backup" : "backups"}
          </span>
        </div>
        {onNewBackup && (
          <button
            type="button"
            style={primaryButtonStyle}
            onClick={onNewBackup}
            data-testid="new-backup-button"
          >
            New backup
          </button>
        )}
      </div>

      {loading && (
        <div style={{ padding: "32px", textAlign: "center", color: "var(--text-soft)" }}>
          Loading backups...
        </div>
      )}

      {error && (
        <div
          style={{
            padding: "16px",
            borderRadius: "6px",
            background: "var(--danger-soft)",
            border: "1px solid var(--danger)",
            color: "var(--danger-text)",
          }}
          role="alert"
        >
          {error}
        </div>
      )}

      {!loading && !error && backups.length === 0 && (
        <div
          style={{
            padding: "48px 16px",
            textAlign: "center",
            background: "var(--bg-elev)",
            borderRadius: "var(--radius, 10px)",
            border: "1px solid var(--border)",
            color: "var(--text-soft)",
          }}
          data-testid="empty-backups-state"
        >
          No backups found.
        </div>
      )}

      {!loading && !error && backups.length > 0 && (
        <div style={tableWrapperStyle}>
          <table style={tableStyle} aria-label="Backups">
            <thead>
              <tr>
                <th style={thStyle}>Name</th>
                <th style={thStyle}>Type</th>
                <th style={thStyle}>Scope</th>
                <th style={thStyle}>Created</th>
                <th style={thStyle}>Size</th>
                <th style={thStyle}>Location</th>
                <th style={{ ...thStyle, textAlign: "right" }}>Actions</th>
              </tr>
            </thead>
            <tbody>
              {backups.map((backup) => (
                <tr key={backup.id} data-testid={`backup-row-${backup.id}`}>
                  <td style={tdStyle}>
                    <span style={monoStyle} title={backup.id}>
                      {backupName(backup)}
                    </span>
                  </td>
                  <td style={tdStyle}>
                    <span
                      className="status-badge"
                      style={getTypeBadgeStyle(backup.type)}
                      data-testid={`backup-type-${backup.id}`}
                    >
                      {backup.type}
                    </span>
                  </td>
                  <td style={tdStyle}>{backupScope(backup)}</td>
                  <td style={tdStyle}>{formatDateTime(backup.createdAt)}</td>
                  <td style={tdStyle}>{backupSize(backup)}</td>
                  <td style={tdStyle}>
                    <span style={monoStyle}>{backupLocation(backup)}</span>
                  </td>
                  <td style={{ ...tdStyle, textAlign: "right" }}>
                    <div
                      style={{
                        display: "inline-flex",
                        gap: "6px",
                        justifyContent: "flex-end",
                      }}
                    >
                      {onDownload && (
                        <button
                          type="button"
                          style={actionBtnStyle}
                          onClick={() => onDownload(backup)}
                          aria-label={`Download backup ${backup.id}`}
                          data-testid={`action-download-${backup.id}`}
                        >
                          Download
                        </button>
                      )}
                      {onRestore && (
                        <button
                          type="button"
                          style={actionBtnStyle}
                          onClick={() => onRestore(backup)}
                          aria-label={`Restore backup ${backup.id}`}
                          data-testid={`action-restore-${backup.id}`}
                        >
                          Restore
                        </button>
                      )}
                      {onDelete && (
                        <button
                          type="button"
                          style={dangerActionBtnStyle}
                          onClick={() => onDelete(backup)}
                          aria-label={`Delete backup ${backup.id}`}
                          data-testid={`action-delete-${backup.id}`}
                        >
                          Delete
                        </button>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
