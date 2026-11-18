// EPIC-035 Backup & Restore persistence, artifact-tier, and maintenance adapter
// (T-0865).
//
// Bridges the EPIC-035 route and domain seams (backup collection, restore
// preview/apply, retention pruning, same-tier replication, and settings) to
// `@m365-assess/db`'s `SqliteRepository`, the shared SQLite handle, and the
// filesystem artifact root.
import { AsyncLocalStorage } from "node:async_hooks";
import { promises as fs } from "node:fs";
import path from "node:path";
import type { JobEnvelope } from "@m365-assess/contracts";
import type {
  Backup,
  BackupConfig,
  BackupConfigInput,
  BackupInput,
  BackupListOptions,
  BackupScopeOptions,
  SqliteRepository,
} from "@m365-assess/db";
import type Database from "better-sqlite3";
import type { BackupRow } from "../backup/archive.js";
import type { BackupTableFilter } from "../backup/collect.js";
import {
  replicateLatestBackup,
  type BackupReplicationStore,
  type ReplicationArtifactStore,
  type ReplicationResult,
} from "../backup/replication.js";
import {
  pruneExpiredBackups,
  type BackupRetentionStore,
  type RetentionArtifactStore,
  type RetentionPruneResult,
} from "../backup/retention.js";
import { AppError, ErrorCodes } from "../errors.js";
import {
  DEFAULT_BACKUP_RETENTION_DAYS,
  type BackupSettingsStore,
} from "../routes/backup-settings.js";
import type { BackupsRestoreArtifactStore, BackupsRestoreStore } from "../routes/backups-restore.js";
import {
  createFileBackupsArtifactStore,
  type BackupsArtifactStore,
  type BackupsStore,
} from "../routes/backups.js";
import type { MaintenanceCommandHandler, MaintenanceOutcome } from "../scheduler/maintenance.js";
import type { SystemTimer } from "../scheduler/system-timers.js";
import type { RecordAudit } from "./audit.js";

export const BACKUP_MAINTENANCE_COMMAND = "Invoke-BackupMaintenance";

/** Daily backup pruning and replication system timer (03:00 UTC). */
export const BACKUP_MAINTENANCE_TIMER = Object.freeze({
  name: "backup-maintenance",
  cron: "0 0 3 * * *",
  type: "report" as const,
  jobType: "maintenance" as const,
  timezone: "UTC",
  command: BACKUP_MAINTENANCE_COMMAND,
} satisfies SystemTimer);

/** Explicit allow-list mapping logical backup table names to SQLite tables. */
export const BACKUP_TABLE_MAP: Readonly<Record<string, string>> = Object.freeze({
  tenants: "tenants",
  roles: "roles",
  templates: "template_library_items",
  alerts: "alert_rules",
  settings: "app_settings",
  template_assignments: "template_assignments",
  drift_deviations: "drift_deviations",
  scheduled_tasks: "scheduled_tasks",
});

export interface BackupsAdapterStore
  extends BackupsStore,
    BackupSettingsStore,
    BackupsRestoreStore {
  transaction<T>(work: () => Promise<T>): Promise<T>;
}

export interface BackupsArtifactTier
  extends BackupsArtifactStore,
    BackupsRestoreArtifactStore,
    RetentionArtifactStore,
    ReplicationArtifactStore {}

export type BackupMaintenanceOutcome = MaintenanceOutcome & {
  readonly prune: RetentionPruneResult;
  readonly replication: ReplicationResult;
};

export type BackupMaintenanceHandler = ((
  envelope?: JobEnvelope,
  signal?: AbortSignal,
) => Promise<BackupMaintenanceOutcome>) &
  MaintenanceCommandHandler;

export interface BackupMaintenanceCommandOptions {
  readonly store: BackupRetentionStore &
    BackupReplicationStore &
    Pick<BackupSettingsStore, "getBackupConfig">;
  readonly artifacts: RetentionArtifactStore & ReplicationArtifactStore;
  readonly audit?: RecordAudit;
  readonly now?: () => Date;
  readonly newId?: () => string;
  readonly actor?: string;
  readonly correlationId?: string;
}

interface TableInfoColumn {
  readonly name: string;
}

type TenantScopeKind =
  | "tenantId"
  | "tenantsId"
  | "templateAssignment"
  | "scheduledTask"
  | "none";

function resolvePhysicalTable(db: Database.Database, logicalName: string): string | undefined {
  if (!Object.hasOwn(BACKUP_TABLE_MAP, logicalName)) {
    return undefined;
  }
  const tableName = BACKUP_TABLE_MAP[logicalName]!;
  const exists = db
    .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?")
    .get(tableName);
  return exists === undefined ? undefined : tableName;
}

function getTableColumns(db: Database.Database, tableName: string): string[] {
  const columns = db.pragma(`table_info("${tableName}")`) as TableInfoColumn[];
  return columns.map((col) => col.name);
}

function resolveTenantScopeKind(
  logicalName: string,
  columnNames: readonly string[],
): TenantScopeKind {
  const cols = new Set(columnNames);
  if (cols.has("tenantId")) {
    return "tenantId";
  }
  if (logicalName === "tenants" && cols.has("id")) {
    return "tenantsId";
  }
  if (logicalName === "template_assignments" && cols.has("targetType") && cols.has("targetId")) {
    return "templateAssignment";
  }
  if (logicalName === "scheduled_tasks" && cols.has("targetScope")) {
    return "scheduledTask";
  }
  return "none";
}

function isTenantScopedScheduleRow(row: BackupRow, tenantId: string): boolean {
  const raw = row["targetScope"];
  if (typeof raw !== "string") {
    return false;
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    return (
      typeof parsed === "object" &&
      parsed !== null &&
      !Array.isArray(parsed) &&
      (parsed as Record<string, unknown>)["type"] === "tenant" &&
      (parsed as Record<string, unknown>)["id"] === tenantId
    );
  } catch {
    return false;
  }
}

function selectTableRows(
  db: Database.Database,
  tableName: string,
  scopeKind: TenantScopeKind,
  tenantId: string | undefined,
): BackupRow[] {
  if (tenantId === undefined) {
    return db.prepare(`SELECT * FROM "${tableName}"`).all() as BackupRow[];
  }
  switch (scopeKind) {
    case "tenantId":
      return db
        .prepare(`SELECT * FROM "${tableName}" WHERE "tenantId" = ?`)
        .all(tenantId) as BackupRow[];
    case "tenantsId":
      return db
        .prepare(`SELECT * FROM "${tableName}" WHERE "id" = ?`)
        .all(tenantId) as BackupRow[];
    case "templateAssignment":
      return db
        .prepare(
          `SELECT * FROM "${tableName}" WHERE "targetType" = 'tenant' AND "targetId" = ?`,
        )
        .all(tenantId) as BackupRow[];
    case "scheduledTask": {
      const rows = db.prepare(`SELECT * FROM "${tableName}"`).all() as BackupRow[];
      return rows.filter((row) => isTenantScopedScheduleRow(row, tenantId));
    }
    case "none":
      return db.prepare(`SELECT * FROM "${tableName}"`).all() as BackupRow[];
  }
}

function deleteTableRows(
  db: Database.Database,
  tableName: string,
  scopeKind: TenantScopeKind,
  tenantId: string | undefined,
): void {
  if (tenantId === undefined) {
    db.prepare(`DELETE FROM "${tableName}"`).run();
    return;
  }
  switch (scopeKind) {
    case "tenantId":
      db.prepare(`DELETE FROM "${tableName}" WHERE "tenantId" = ?`).run(tenantId);
      return;
    case "tenantsId":
      db.prepare(`DELETE FROM "${tableName}" WHERE "id" = ?`).run(tenantId);
      return;
    case "templateAssignment":
      db.prepare(
        `DELETE FROM "${tableName}" WHERE "targetType" = 'tenant' AND "targetId" = ?`,
      ).run(tenantId);
      return;
    case "scheduledTask": {
      const existing = db.prepare(`SELECT "id", "targetScope" FROM "${tableName}"`).all() as BackupRow[];
      const del = db.prepare(`DELETE FROM "${tableName}" WHERE "id" = ?`);
      for (const row of existing) {
        if (isTenantScopedScheduleRow(row, tenantId)) {
          del.run(row["id"]);
        }
      }
      return;
    }
    case "none":
      db.prepare(`DELETE FROM "${tableName}"`).run();
  }
}

function assertTenantScopedRow(
  logicalName: string,
  row: BackupRow,
  scopeKind: TenantScopeKind,
  tenantId: string,
): BackupRow {
  switch (scopeKind) {
    case "tenantId": {
      const rowTenantId = row["tenantId"];
      if (rowTenantId === undefined) {
        return { ...row, tenantId };
      }
      if (rowTenantId !== tenantId) {
        throw new AppError(
          ErrorCodes.validationFailed,
          `backup row for '${logicalName}' belongs to tenant '${String(rowTenantId)}' instead of '${tenantId}'`,
          400,
          [{ field: "tenantId", reason: "mismatch" }],
        );
      }
      return row;
    }
    case "tenantsId":
      if (row["id"] !== tenantId) {
        throw new AppError(
          ErrorCodes.validationFailed,
          `backup row for 'tenants' belongs to '${String(row["id"])}' instead of '${tenantId}'`,
          400,
          [{ field: "id", reason: "mismatch" }],
        );
      }
      return row;
    case "templateAssignment":
      if (row["targetType"] !== "tenant" || row["targetId"] !== tenantId) {
        throw new AppError(
          ErrorCodes.validationFailed,
          `backup row for 'template_assignments' is outside tenant '${tenantId}'`,
          400,
          [{ field: "targetId", reason: "mismatch" }],
        );
      }
      return row;
    case "scheduledTask":
      if (!isTenantScopedScheduleRow(row, tenantId)) {
        throw new AppError(
          ErrorCodes.validationFailed,
          `backup row for 'scheduled_tasks' is outside tenant '${tenantId}'`,
          400,
          [{ field: "targetScope", reason: "mismatch" }],
        );
      }
      return row;
    case "none":
      return row;
  }
}

function toSqliteParam(value: unknown): string | number | bigint | Buffer | null {
  if (value === null || value === undefined) {
    return null;
  }
  if (typeof value === "boolean") {
    return value ? 1 : 0;
  }
  if (
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "bigint" ||
    Buffer.isBuffer(value)
  ) {
    return value;
  }
  if (value instanceof Uint8Array) {
    return Buffer.from(value);
  }
  return JSON.stringify(value);
}

function insertTableRows(
  db: Database.Database,
  tableName: string,
  columnNames: readonly string[],
  rows: readonly BackupRow[],
): void {
  const statements = new Map<string, Database.Statement>();
  for (const row of rows) {
    const colsToInsert = columnNames.filter(
      (col) => Object.hasOwn(row, col) && row[col] !== undefined,
    );
    if (colsToInsert.length === 0) {
      db.prepare(`INSERT INTO "${tableName}" DEFAULT VALUES`).run();
      continue;
    }
    const key = colsToInsert.join("\0");
    let stmt = statements.get(key);
    if (stmt === undefined) {
      const quotedCols = colsToInsert.map((col) => `"${col}"`).join(", ");
      const placeholders = colsToInsert.map(() => "?").join(", ");
      stmt = db.prepare(`INSERT INTO "${tableName}" (${quotedCols}) VALUES (${placeholders})`);
      statements.set(key, stmt);
    }
    stmt.run(...colsToInsert.map((col) => toSqliteParam(row[col])));
  }
}

/**
 * Builds the concrete EPIC-035 persistence adapter over the shared SQLite
 * database handle and `SqliteRepository`.
 */
export function createBackupsStore(
  db: Database.Database,
  repo: SqliteRepository,
): BackupsAdapterStore {
  const txContext = new AsyncLocalStorage<boolean>();
  let txQueue: Promise<void> = Promise.resolve();
  let inStoreTx = false;
  let savepointSeq = 0;

  async function runSavepoint<T>(work: () => Promise<T>): Promise<T> {
    savepointSeq += 1;
    const sp = `sp_backup_${savepointSeq}`;
    db.exec(`SAVEPOINT ${sp}`);
    try {
      const result = await work();
      db.exec(`RELEASE SAVEPOINT ${sp}`);
      return result;
    } catch (error) {
      if (db.inTransaction) {
        try {
          db.exec(`ROLLBACK TO SAVEPOINT ${sp}`);
          db.exec(`RELEASE SAVEPOINT ${sp}`);
        } catch {
          // Preserve the original failure when SQLite already aborted the transaction.
        }
      }
      throw error;
    }
  }

  async function runTopLevel<T>(work: () => Promise<T>): Promise<T> {
    if (db.inTransaction) {
      db.pragma("defer_foreign_keys = ON");
      return runSavepoint(work);
    }
    db.exec("BEGIN IMMEDIATE");
    inStoreTx = true;
    try {
      db.pragma("defer_foreign_keys = ON");
      const result = await work();
      db.exec("COMMIT");
      return result;
    } catch (error) {
      if (db.inTransaction) {
        try {
          db.exec("ROLLBACK");
        } catch {
          // Preserve the original failure when SQLite already rolled back.
        }
      }
      throw error;
    } finally {
      inStoreTx = false;
    }
  }

  async function transaction<T>(work: () => Promise<T>): Promise<T> {
    if (txContext.getStore() === true) {
      return runSavepoint(work);
    }
    let release!: () => void;
    const previous = txQueue;
    txQueue = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      return await txContext.run(true, () => runTopLevel(work));
    } finally {
      release();
    }
  }

  return {
    get schemaVersion(): number {
      return repo.schemaVersion;
    },
    listBackups: (options?: BackupListOptions): Promise<Backup[]> => repo.listBackups(options),
    getBackup: (backupId: string, options?: BackupScopeOptions): Promise<Backup | undefined> =>
      repo.getBackup(backupId, options),
    createBackup: (input: BackupInput): Promise<Backup> => repo.createBackup(input),
    deleteBackup: (backupId: string): Promise<boolean> => repo.deleteBackup(backupId),
    getBackupConfig: (): Promise<BackupConfig | undefined> => repo.getBackupConfig(),
    upsertBackupConfig: (input: BackupConfigInput): Promise<BackupConfig> =>
      repo.upsertBackupConfig(input),

    async readTable(
      name: string,
      filter?: BackupTableFilter,
    ): Promise<readonly BackupRow[] | undefined> {
      const tableName = resolvePhysicalTable(db, name);
      if (tableName === undefined) {
        return undefined;
      }
      const columns = getTableColumns(db, tableName);
      const scopeKind = resolveTenantScopeKind(name, columns);
      return selectTableRows(db, tableName, scopeKind, filter?.tenantId);
    },

    async replaceTable(
      name: string,
      rows: readonly BackupRow[],
      filter?: BackupTableFilter,
    ): Promise<void> {
      const tableName = resolvePhysicalTable(db, name);
      if (tableName === undefined) {
        throw new AppError(
          ErrorCodes.validationFailed,
          `unknown or missing backup table '${name}'`,
          400,
          [{ field: "table", reason: "unknown", table: name }],
        );
      }
      const columnNames = getTableColumns(db, tableName);
      const scopeKind = resolveTenantScopeKind(name, columnNames);
      const tenantId = filter?.tenantId;
      const preparedRows =
        tenantId === undefined
          ? rows
          : rows.map((row) => assertTenantScopedRow(name, row, scopeKind, tenantId));

      const applyWrite = (): void => {
        deleteTableRows(db, tableName, scopeKind, tenantId);
        insertTableRows(db, tableName, columnNames, preparedRows);
      };

      if (txContext.getStore() === true || (db.inTransaction && !inStoreTx)) {
        db.pragma("defer_foreign_keys = ON");
        applyWrite();
        return;
      }

      await transaction(async () => {
        applyWrite();
      });
    },

    transaction,
  };
}

/**
 * Filesystem-backed artifact tier extending `createFileBackupsArtifactStore`
 * with path-safe `read` and `exists` for restore and same-tier replication.
 */
export function createBackupsArtifactTier(artifactRoot: string): BackupsArtifactTier {
  const base = createFileBackupsArtifactStore(artifactRoot);
  const root = path.resolve(artifactRoot);
  const rootPrefix = root.endsWith(path.sep) ? root : `${root}${path.sep}`;

  const resolveSafeRef = (ref: string): string => {
    if (ref.includes("\0")) {
      throw new Error(`backup artifact ref '${ref}' escapes the artifact root`);
    }
    const target = path.resolve(root, ref);
    if (target !== root && !target.startsWith(rootPrefix)) {
      throw new Error(`backup artifact ref '${ref}' escapes the artifact root`);
    }
    return target;
  };

  const resolveFileRef = (ref: string): string => {
    const target = resolveSafeRef(ref);
    if (target === root) {
      throw new Error(`backup artifact ref '${ref}' escapes the artifact root`);
    }
    return target;
  };

  return {
    async write(ref: string, bytes: Buffer): Promise<void> {
      resolveFileRef(ref);
      return base.write(ref, bytes);
    },
    readStream(ref: string) {
      resolveFileRef(ref);
      return base.readStream(ref);
    },
    async stat(ref: string): Promise<{ readonly size: number }> {
      resolveFileRef(ref);
      return base.stat(ref);
    },
    async remove(ref: string): Promise<void> {
      resolveFileRef(ref);
      return base.remove(ref);
    },
    async read(ref: string): Promise<Buffer> {
      return fs.readFile(resolveFileRef(ref));
    },
    async exists(ref: string): Promise<boolean> {
      const target = resolveSafeRef(ref);
      if (target === root) {
        return false;
      }
      try {
        const info = await fs.stat(target);
        return info.isFile();
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") {
          return false;
        }
        throw error;
      }
    },
  };
}

/**
 * The `Invoke-BackupMaintenance` timer handler. Reads `BackupConfig`, prunes
 * backups past `retentionDays`, and replicates the latest remaining archive to
 * the configured same-tier target prefix.
 */
export function createBackupMaintenanceCommand(
  options: BackupMaintenanceCommandOptions,
): BackupMaintenanceHandler {
  return async (envelope?: JobEnvelope): Promise<BackupMaintenanceOutcome> => {
    const config = await options.store.getBackupConfig();
    const correlationId = options.correlationId ?? envelope?.correlationId;

    const prune = await pruneExpiredBackups({
      store: options.store,
      artifacts: options.artifacts,
      retentionDays: config?.retentionDays ?? DEFAULT_BACKUP_RETENTION_DAYS,
      audit: options.audit,
      now: options.now,
      newId: options.newId,
      actor: options.actor,
      correlationId,
    });

    const replication = await replicateLatestBackup({
      store: options.store,
      artifacts: options.artifacts,
      replicationTarget: config?.replicationTarget ?? null,
      audit: options.audit,
      now: options.now,
      newId: options.newId,
      actor: options.actor,
      correlationId,
    });

    const replicationSummary = replication.replicated
      ? `replicated to ${replication.targetRef}`
      : replication.alreadyReplicated
        ? "already replicated"
        : "replication skipped";

    return {
      status: "succeeded",
      exitCode: 0,
      message: `pruned ${prune.pruned.length} backup(s), ${replicationSummary}`,
      prune,
      replication,
    };
  };
}
