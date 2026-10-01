// Backup replication (EPIC-035 SPEC.md §2 US-4, §4.3, §11.3; T-0688).
//
// Replication copies the latest backup archive to a configured secondary
// location on the **same storage tier** (SPEC §11.3 resolves the target that
// way; an external/regional target is a later cut). The copy is written through
// the same artifact seam as the primary, under the configured target prefix, so
// no cross-tier transfer is involved. Replication is idempotent: when the
// target already holds the copy it is left alone, so a re-run never duplicates
// work. A blank target disables replication. The EPIC-007 scheduler (T-0124)
// invokes this unit; it does not parse the cron expression here.
import { randomUUID } from "node:crypto";
import path from "node:path";
import type { Backup } from "@m365-assess/db";
import type { RecordAudit } from "../adapters/audit.js";
import { AppError } from "../errors.js";

export const BACKUP_REPLICATION_INVALID = "backup.replication_invalid";

/** The persistence seam: the backup rows replication selects from. */
export interface BackupReplicationStore {
  listBackups(): Promise<Backup[]>;
}

/**
 * The artifact-tier seam: reads the primary archive, tests whether the
 * secondary already holds it, and writes the copy. All three refs live on the
 * same tier, so the target is a prefix within this store, not another store.
 */
export interface ReplicationArtifactStore {
  read(ref: string): Promise<Buffer>;
  write(ref: string, bytes: Buffer): Promise<void>;
  exists(ref: string): Promise<boolean>;
}

export interface ReplicateLatestBackupOptions {
  readonly store: BackupReplicationStore;
  readonly artifacts: ReplicationArtifactStore;
  /** Secondary prefix on the same tier; `null`/blank disables replication. */
  readonly replicationTarget: string | null;
  readonly audit?: RecordAudit;
  readonly now?: () => Date;
  readonly newId?: () => string;
  readonly actor?: string;
  readonly correlationId?: string;
}

export interface ReplicationResult {
  /** True when this run wrote a new copy. */
  readonly replicated: boolean;
  /** True when the copy already existed and was left in place. */
  readonly alreadyReplicated: boolean;
  readonly sourceBackupId: string | null;
  readonly sourceRef: string | null;
  readonly targetRef: string | null;
}

function idle(): ReplicationResult {
  return {
    replicated: false,
    alreadyReplicated: false,
    sourceBackupId: null,
    sourceRef: null,
    targetRef: null,
  };
}

/** The same-tier reference for the copy: target prefix + the archive's name. */
export function replicationRef(target: string, sourceRef: string): string {
  const normalized = target.trim().replace(/[\\/]+$/, "");
  if (normalized.length === 0) {
    throw new AppError(
      BACKUP_REPLICATION_INVALID,
      "replicationTarget must be a non-empty same-tier prefix",
      400,
      [{ field: "replicationTarget", reason: "invalid" }],
    );
  }
  return `${normalized}/${path.posix.basename(sourceRef)}`;
}

/**
 * The latest backup by `createdAt`, with `id` as a stable tie-break. Every
 * recorded backup is a successful archive; a backup still being written is not
 * visible here, so "latest successful" is simply the newest row.
 */
export function latestBackup(backups: readonly Backup[]): Backup | undefined {
  let latest: Backup | undefined;
  for (const backup of backups) {
    if (latest === undefined || isNewer(backup, latest)) {
      latest = backup;
    }
  }
  return latest;
}

function isNewer(candidate: Backup, current: Backup): boolean {
  if (candidate.createdAt !== current.createdAt) {
    return candidate.createdAt > current.createdAt;
  }
  return candidate.id > current.id;
}

/**
 * Copies the latest archive to the secondary same-tier location. Returns
 * `alreadyReplicated` without writing when the target already holds it, so
 * repeated invocations are idempotent. A blank target or an empty backup set is
 * a no-op rather than an error.
 */
export async function replicateLatestBackup(
  options: ReplicateLatestBackupOptions,
): Promise<ReplicationResult> {
  const target = options.replicationTarget?.trim() ?? "";
  if (target.length === 0) {
    return idle();
  }

  const latest = latestBackup(await options.store.listBackups());
  if (latest === undefined) {
    return idle();
  }

  const targetRef = replicationRef(target, latest.artifactRef);
  if (await options.artifacts.exists(targetRef)) {
    return {
      replicated: false,
      alreadyReplicated: true,
      sourceBackupId: latest.id,
      sourceRef: latest.artifactRef,
      targetRef,
    };
  }

  const bytes = await options.artifacts.read(latest.artifactRef);
  await options.artifacts.write(targetRef, bytes);

  if (options.audit) {
    const now = options.now ?? (() => new Date());
    const newId = options.newId ?? randomUUID;
    const timestamp = now().toISOString();
    await options.audit({
      id: newId(),
      timestamp,
      actorUserId: options.actor ?? null,
      actorType: options.actor === undefined ? "system" : "user",
      tenantId: latest.tenantId,
      action: "backup.replicate",
      targetType: "backup",
      targetId: latest.id,
      before: null,
      after: {
        backupId: latest.id,
        sourceRef: latest.artifactRef,
        targetRef,
        checksum: latest.checksum,
      },
      result: "success",
      error: null,
      source: "schedule",
      correlationId: options.correlationId ?? null,
      createdAt: timestamp,
    });
  }

  return {
    replicated: true,
    alreadyReplicated: false,
    sourceBackupId: latest.id,
    sourceRef: latest.artifactRef,
    targetRef,
  };
}
