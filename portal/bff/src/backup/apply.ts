// Restore apply (EPIC-035 SPEC.md §4.2 steps 3-4, §6, §7, §8, §9, §11.4; T-0687).
//
// The apply half of a restore: validate the archive and compute the confirmed
// per-table diff (T-0686), take an automatic pre-restore backup (SPEC §9), then
// apply each selected table inside a transaction where the store allows one,
// rolling the whole restore back on a mid-apply failure (SPEC §4.2 step 3).
// Restore is destructive and audited with before/after (SPEC §8). Selective
// restore is per-table first; per-record granularity is deferred (SPEC §11.4).
// A confirming Idempotency-Key is required and a replay returns the prior
// outcome without applying a second time.
import { randomUUID } from "node:crypto";
import type { RecordAudit } from "../adapters/audit.js";
import { AppError } from "../errors.js";
import { readBackupArchive, type BackupArchiveContents, type BackupRow } from "./archive.js";
import type { BackupTableFilter } from "./collect.js";
import { previewRestore, type RestorePreview, type RestorePreviewStore } from "./restore.js";

export const BACKUP_RESTORE_IDEMPOTENCY_REQUIRED = "backup.restore.idempotency_key_required";
export const BACKUP_RESTORE_INVALID_IDEMPOTENCY_KEY = "backup.restore.invalid_idempotency_key";

export const MAX_RESTORE_IDEMPOTENCY_KEY_LENGTH = 256;

/**
 * Parses a restore Idempotency-Key. Required on restore: a missing or blank key
 * is an error, not a silent pass.
 */
export function parseRestoreIdempotencyKey(value: unknown): string {
  const header = Array.isArray(value) ? value[0] : value;
  if (header === undefined || header === null) {
    throw new AppError(
      BACKUP_RESTORE_IDEMPOTENCY_REQUIRED,
      "Idempotency-Key header is required for restore",
      400,
      [{ field: "Idempotency-Key", reason: "required" }],
    );
  }
  if (typeof header !== "string") {
    throw new AppError(
      BACKUP_RESTORE_INVALID_IDEMPOTENCY_KEY,
      "Idempotency-Key must be a string",
      400,
      [{ field: "Idempotency-Key", reason: "invalid" }],
    );
  }
  const key = header.trim();
  if (key.length === 0) {
    throw new AppError(
      BACKUP_RESTORE_IDEMPOTENCY_REQUIRED,
      "Idempotency-Key header is required for restore",
      400,
      [{ field: "Idempotency-Key", reason: "required" }],
    );
  }
  if (key.length > MAX_RESTORE_IDEMPOTENCY_KEY_LENGTH) {
    throw new AppError(
      BACKUP_RESTORE_INVALID_IDEMPOTENCY_KEY,
      `Idempotency-Key exceeds ${MAX_RESTORE_IDEMPOTENCY_KEY_LENGTH} characters`,
      400,
      [{ field: "Idempotency-Key", reason: "invalid" }],
    );
  }
  return key;
}

/**
 * The persistence seam for a restore apply. `replaceTable` writes the archive's
 * rows for one table; `transaction` wraps the whole apply so a failure rolls
 * every table back. A store that cannot offer atomicity omits `transaction`,
 * and the apply still runs — but without rollback.
 */
export interface RestoreApplyStore extends RestorePreviewStore {
  replaceTable(
    name: string,
    rows: readonly BackupRow[],
    filter?: BackupTableFilter,
  ): Promise<void>;
  transaction?<T>(work: () => Promise<T>): Promise<T>;
}

/** The identity of the automatic pre-restore backup, recorded in the audit. */
export interface PreRestoreBackupResult {
  readonly backupId: string;
  readonly artifactRef: string;
  readonly checksum: string;
  readonly schemaVersion: number;
}

export interface RestoreTableOutcome {
  readonly table: string;
  readonly added: number;
  readonly changed: number;
  readonly removed: number;
}

export interface RestoreApplyResult {
  readonly backupId: string;
  readonly schemaVersion: number;
  readonly preRestoreBackupId: string;
  readonly tables: readonly string[];
  readonly applied: readonly RestoreTableOutcome[];
  /** True when the Idempotency-Key had already been applied. */
  readonly replayed: boolean;
}

/** The replay store: scoped by backup so the same key under two backups never collides. */
export interface RestoreIdempotencyStore {
  find(backupId: string, key: string): Promise<RestoreApplyResult | undefined>;
  save(backupId: string, key: string, result: RestoreApplyResult): Promise<void>;
}

export function createMemoryRestoreIdempotencyStore(): RestoreIdempotencyStore {
  const results = new Map<string, RestoreApplyResult>();
  const scope = (backupId: string, key: string): string => `${backupId}\n${key}`;
  return {
    async find(backupId: string, key: string): Promise<RestoreApplyResult | undefined> {
      return results.get(scope(backupId, key));
    },
    async save(backupId: string, key: string, result: RestoreApplyResult): Promise<void> {
      results.set(scope(backupId, key), result);
    },
  };
}

export interface ApplyRestoreOptions {
  readonly store: RestoreApplyStore;
  readonly archive: Buffer | Uint8Array;
  readonly backupId: string;
  readonly createdBy: string;
  /** Raw header value; required and parsed here so every caller is gated alike. */
  readonly idempotencyKey: unknown;
  /** Tables to restore. Defaults to every table the archive carries (SPEC §3.2 full). */
  readonly tables?: readonly string[];
  /** Tenant scope for a tenant restore; a restore must never touch another tenant's rows. */
  readonly filter?: BackupTableFilter;
  /**
   * Creates the automatic pre-restore backup. Called before any mutation and
   * outside the apply transaction so it survives a failed restore (SPEC §9).
   */
  readonly preRestoreBackup: () => Promise<PreRestoreBackupResult>;
  /** Shared across calls so a replayed key sees the prior result (never per-call). */
  readonly idempotency: RestoreIdempotencyStore;
  readonly audit?: RecordAudit;
  readonly correlationId?: string;
  readonly now?: () => Date;
  readonly newId?: () => string;
}

interface RestoreAuditContext {
  readonly preview: RestorePreview;
  readonly contents: BackupArchiveContents;
  readonly preRestoreBackupId: string;
  readonly timestamp: string;
  readonly result: "success" | "failure";
  readonly error: string | null;
}

function restoreAuditEvent(
  options: ApplyRestoreOptions,
  context: RestoreAuditContext,
  id: string,
): Record<string, unknown> {
  return {
    id,
    timestamp: context.timestamp,
    actorUserId: options.createdBy,
    actorType: "user",
    tenantId: options.filter?.tenantId ?? null,
    action: "backup.restore",
    targetType: "backup",
    targetId: options.backupId,
    before: {
      preRestoreBackupId: context.preRestoreBackupId,
      tables: context.preview.tables.map((diff) => ({
        table: diff.table,
        added: diff.added,
        changed: diff.changed,
        removed: diff.removed,
      })),
    },
    after: {
      tables: context.preview.tables.map((diff) => ({
        table: diff.table,
        rows: context.contents.tables[diff.table] ?? [],
      })),
    },
    result: context.result,
    error: context.error,
    source: "request",
    correlationId: options.correlationId ?? null,
    createdAt: context.timestamp,
  };
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Applies a confirmed restore. The diff is recomputed server-side (never taken
 * from the caller), the pre-restore backup is written first, and every selected
 * table is replaced inside one transaction so a mid-apply failure rolls the
 * whole restore back. A replayed Idempotency-Key returns the prior result
 * without touching the store again.
 */
export async function applyRestore(options: ApplyRestoreOptions): Promise<RestoreApplyResult> {
  const key = parseRestoreIdempotencyKey(options.idempotencyKey);

  const prior = await options.idempotency.find(options.backupId, key);
  if (prior !== undefined) {
    return { ...prior, replayed: true };
  }

  const preview = await previewRestore({
    store: options.store,
    archive: options.archive,
    tables: options.tables,
    filter: options.filter,
  });
  const contents = readBackupArchive(options.archive, {
    instanceSchemaVersion: options.store.schemaVersion,
  });

  const now = options.now ?? (() => new Date());
  const newId = options.newId ?? randomUUID;
  const timestamp = now().toISOString();

  const preRestore = await options.preRestoreBackup();

  const applied: RestoreTableOutcome[] = [];
  const applyTables = async (): Promise<void> => {
    for (const diff of preview.tables) {
      await options.store.replaceTable(diff.table, contents.tables[diff.table] ?? [], options.filter);
      applied.push({
        table: diff.table,
        added: diff.added.length,
        changed: diff.changed.length,
        removed: diff.removed.length,
      });
    }
  };

  try {
    if (options.store.transaction) {
      await options.store.transaction(applyTables);
    } else {
      await applyTables();
    }
  } catch (error) {
    if (options.audit) {
      await options.audit(
        restoreAuditEvent(
          options,
          {
            preview,
            contents,
            preRestoreBackupId: preRestore.backupId,
            timestamp,
            result: "failure",
            error: messageOf(error),
          },
          newId(),
        ),
      );
    }
    throw error;
  }

  const result: RestoreApplyResult = {
    backupId: options.backupId,
    schemaVersion: preview.schemaVersion,
    preRestoreBackupId: preRestore.backupId,
    tables: preview.tables.map((diff) => diff.table),
    applied,
    replayed: false,
  };

  if (options.audit) {
    await options.audit(
      restoreAuditEvent(
        options,
        {
          preview,
          contents,
          preRestoreBackupId: preRestore.backupId,
          timestamp,
          result: "success",
          error: null,
        },
        newId(),
      ),
    );
  }
  await options.idempotency.save(options.backupId, key, result);
  return result;
}
