// Backup retention pruning (EPIC-035 SPEC.md §2 US-4, §4.3, §10; T-0688).
//
// Retention removes backups older than the configured `retentionDays` window
// and, with each row, its archive on the artifact tier, so pruning never leaves
// an orphaned artifact or a dangling row. Backups at or inside the window are
// left untouched. Pruning is audited with the removed backup's before-image
// (SPEC §8). The retention window comes from `BackupConfig`; the EPIC-007
// scheduler (T-0124) is the seam that invokes this unit — the cron parser and
// the schedule link are owned there, not here.
import { randomUUID } from "node:crypto";
import type { Backup } from "@m365-assess/db";
import type { RecordAudit } from "../adapters/audit.js";
import { AppError } from "../errors.js";

export const BACKUP_RETENTION_INVALID = "backup.retention_invalid";

const DAY_MS = 24 * 60 * 60 * 1000;

/** The persistence seam: the backup rows retention reads and deletes. */
export interface BackupRetentionStore {
  listBackups(): Promise<Backup[]>;
  deleteBackup(backupId: string): Promise<boolean>;
}

/** The artifact-tier seam: removes an archive by its relative reference. */
export interface RetentionArtifactStore {
  remove(ref: string): Promise<void>;
}

export interface PruneBackupsOptions {
  readonly store: BackupRetentionStore;
  readonly artifacts: RetentionArtifactStore;
  /** The retention window in days; a backup strictly older than this is pruned. */
  readonly retentionDays: number;
  readonly audit?: RecordAudit;
  readonly now?: () => Date;
  readonly newId?: () => string;
  /** Audit actor; defaults to the scheduler identity. */
  readonly actor?: string;
  readonly correlationId?: string;
}

export interface RetentionPruneResult {
  /** The ISO instant before which a backup is expired. */
  readonly cutoff: string;
  /** Ids of the backups that were pruned, oldest first. */
  readonly pruned: readonly string[];
  /** Ids of the backups left in place. */
  readonly retained: readonly string[];
}

function invalid(retentionDays: unknown): AppError {
  return new AppError(
    BACKUP_RETENTION_INVALID,
    "retentionDays must be a non-negative integer",
    400,
    [{ field: "retentionDays", reason: "invalid", actual: retentionDays }],
  );
}

export function requireRetentionDays(value: unknown): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    throw invalid(value);
  }
  return value;
}

/**
 * The instant before which a backup is expired. A backup created exactly at the
 * cutoff is inside the window and is retained (the window is "older than").
 */
export function retentionCutoff(retentionDays: number, now: Date): Date {
  return new Date(now.getTime() - requireRetentionDays(retentionDays) * DAY_MS);
}

function auditEvent(
  backup: Backup,
  options: PruneBackupsOptions,
  timestamp: string,
  id: string,
): Record<string, unknown> {
  return {
    id,
    timestamp,
    actorUserId: options.actor ?? null,
    actorType: options.actor === undefined ? "system" : "user",
    tenantId: backup.tenantId,
    action: "backup.prune",
    targetType: "backup",
    targetId: backup.id,
    before: {
      id: backup.id,
      type: backup.type,
      tenantId: backup.tenantId,
      createdAt: backup.createdAt,
      artifactRef: backup.artifactRef,
      checksum: backup.checksum,
    },
    after: null,
    result: "success",
    error: null,
    source: "schedule",
    correlationId: options.correlationId ?? null,
    createdAt: timestamp,
  };
}

/**
 * Prunes every backup older than `retentionDays`: removes the archive first,
 * then the row, and audits the removal. A backup whose `createdAt` is not a
 * parseable instant is retained rather than guessed at. Removing an artifact
 * that is already gone is a no-op, so a re-run is safe.
 */
export async function pruneExpiredBackups(
  options: PruneBackupsOptions,
): Promise<RetentionPruneResult> {
  const days = requireRetentionDays(options.retentionDays);
  const now = options.now ?? (() => new Date());
  const newId = options.newId ?? randomUUID;
  const at = now();
  const cutoff = retentionCutoff(days, at);
  const cutoffMs = cutoff.getTime();
  const timestamp = at.toISOString();

  const backups = await options.store.listBackups();
  const pruned: string[] = [];
  const retained: string[] = [];

  for (const backup of backups) {
    const createdAt = Date.parse(backup.createdAt);
    if (Number.isNaN(createdAt) || createdAt >= cutoffMs) {
      retained.push(backup.id);
      continue;
    }
    await options.artifacts.remove(backup.artifactRef);
    const deleted = await options.store.deleteBackup(backup.id);
    if (!deleted) {
      retained.push(backup.id);
      continue;
    }
    pruned.push(backup.id);
    if (options.audit) {
      await options.audit(auditEvent(backup, options, timestamp, newId()));
    }
  }

  return { cutoff: cutoff.toISOString(), pruned, retained };
}
