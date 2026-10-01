// Generic table-dump collector for portal configuration backups (EPIC-035
// SPEC.md §4.1 step 1, §9; T-0683).
//
// The collector is driven by the repository: the caller names the tables to back
// up and the repository supplies their rows by name. Secret-bearing columns are
// dropped before a dump is produced, so a backup can only ever carry credential
// references (SPEC §9), and a table the repository does not have is skipped
// rather than failing the whole backup. The collector never writes anything —
// serialization (T-0682) and the artifact write happen above it.
import { isSecretColumn, type BackupRow, type BackupTableDump } from "./archive.js";

export interface BackupTableFilter {
  readonly tenantId?: string;
}

/**
 * The repository seam for collection. Implementations are expected to apply the
 * filter (a tenant backup must never leak another tenant's rows); the collector
 * only names tables and strips secret columns.
 */
export interface BackupTableRepository {
  /**
   * Every row of the named table, or `undefined` when the table does not exist.
   * A table that exists but is empty returns an empty array.
   */
  readTable(
    name: string,
    filter?: BackupTableFilter,
  ): Promise<readonly BackupRow[] | undefined>;
}

export interface CollectBackupTablesOptions {
  readonly repository: BackupTableRepository;
  readonly tables: readonly string[];
  readonly filter?: BackupTableFilter;
}

export interface CollectedBackup {
  /** Table dumps ready for the T-0682 archive; secret columns already stripped. */
  readonly tables: readonly BackupTableDump[];
  /** Tables the repository supplied, including empty ones. */
  readonly included: readonly string[];
  /** Tables the repository does not have; recorded so the backup notes them. */
  readonly skipped: readonly string[];
  /** Columns dropped per table because they could carry secret material. */
  readonly excludedColumns: Readonly<Record<string, readonly string[]>>;
}

function stripSecretColumns(rows: readonly BackupRow[], excluded: Set<string>): BackupRow[] {
  const clean: BackupRow[] = [];
  for (const row of rows) {
    const projected: BackupRow = {};
    for (const [column, value] of Object.entries(row)) {
      if (isSecretColumn(column)) {
        excluded.add(column);
        continue;
      }
      projected[column] = value;
    }
    clean.push(projected);
  }
  return clean;
}

/** Dumps each named table, excluding secret columns and skipping absent tables. */
export async function collectBackupTables(
  options: CollectBackupTablesOptions,
): Promise<CollectedBackup> {
  const tables: BackupTableDump[] = [];
  const included: string[] = [];
  const skipped: string[] = [];
  const excludedColumns: Record<string, readonly string[]> = {};

  for (const name of options.tables) {
    const rows = await options.repository.readTable(name, options.filter);
    if (rows === undefined) {
      skipped.push(name);
      continue;
    }
    const excluded = new Set<string>();
    tables.push({ name, rows: stripSecretColumns(rows, excluded) });
    included.push(name);
    if (excluded.size > 0) {
      excludedColumns[name] = [...excluded].sort();
    }
  }

  return { tables, included, skipped, excludedColumns };
}
