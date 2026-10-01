// Restore preview (EPIC-035 SPEC.md §3.2, §4.2 steps 1-2, §9, §11.4; T-0686).
//
// The preview half of a restore: read the archive (T-0682), validate its
// schema version against the current instance, and compute what a restore
// would change — added/changed/removed records per table — for the requested
// table scope. Selective restore is per-table first; per-record granularity
// is deferred (SPEC §11.4). The store seam exposes `readTable` only, so a
// preview can never write to the repository or the artifact tier, and a
// schema mismatch throws before any diff is computed (SPEC §9).
import { AppError } from "../errors.js";
import { readBackupArchive, type BackupRow } from "./archive.js";
import type { BackupTableFilter, BackupTableRepository } from "./collect.js";

export const BACKUP_RESTORE_TABLE_MISSING = "backup.restore.table_missing";

/**
 * The persistence seam for a restore preview: the current rows plus the
 * instance schema version. Read-only by construction — the interface exposes
 * no write method to call.
 */
export interface RestorePreviewStore extends BackupTableRepository {
  readonly schemaVersion: number;
}

export interface PreviewRestoreOptions {
  readonly store: RestorePreviewStore;
  readonly archive: Buffer | Uint8Array;
  /**
   * The tables to diff. Defaults to every table the archive carries (SPEC
   * §3.2 "full" scope); a selective scope naming a table the archive does not
   * carry is refused rather than silently previewed as empty.
   */
  readonly tables?: readonly string[];
  /** Tenant scope for a tenant restore; a preview must never diff another tenant's rows. */
  readonly filter?: BackupTableFilter;
}

export type RestoreDiffEntry =
  | { readonly kind: "added"; readonly id: string | null; readonly row: BackupRow }
  | {
      readonly kind: "changed";
      readonly id: string | null;
      readonly before: BackupRow;
      readonly after: BackupRow;
    }
  | { readonly kind: "removed"; readonly id: string | null; readonly row: BackupRow };

export interface RestoreTableDiff {
  readonly table: string;
  readonly added: readonly RestoreDiffEntry[];
  readonly changed: readonly RestoreDiffEntry[];
  readonly removed: readonly RestoreDiffEntry[];
}

export interface RestorePreview {
  /** The archive's schema version, already validated against the instance. */
  readonly schemaVersion: number;
  readonly tables: readonly RestoreTableDiff[];
}

function recordId(row: BackupRow): string | null {
  const id = row["id"];
  if (typeof id === "string" && id.length > 0) return id;
  if (typeof id === "number" && Number.isFinite(id)) return String(id);
  return null;
}

// Key order is not significant, so rows compare equal regardless of the order
// their keys were parsed in.
function stableStringify(value: unknown): string {
  if (value === undefined) return "null";
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value) ?? "null";
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableStringify(item)).join(",")}]`;
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`).join(",")}}`;
}

function diffTable(
  name: string,
  backupRows: readonly BackupRow[],
  currentRows: readonly BackupRow[],
): RestoreTableDiff {
  const added: RestoreDiffEntry[] = [];
  const changed: RestoreDiffEntry[] = [];
  const removed: RestoreDiffEntry[] = [];

  const currentById = new Map<string, BackupRow>();
  const currentWithoutId: BackupRow[] = [];
  for (const row of currentRows) {
    const id = recordId(row);
    if (id === null) currentWithoutId.push(row);
    else currentById.set(id, row);
  }

  // Rows without an id cannot be tracked across time, so they match by value:
  // a backup row equal to a current row is unchanged, otherwise it is an add
  // and the unmatched current row is a removal.
  const matched = new Array<boolean>(currentWithoutId.length).fill(false);
  for (const row of backupRows) {
    const id = recordId(row);
    if (id !== null) {
      const current = currentById.get(id);
      if (current === undefined) {
        added.push({ kind: "added", id, row });
      } else {
        if (stableStringify(current) !== stableStringify(row)) {
          changed.push({ kind: "changed", id, before: current, after: row });
        }
        currentById.delete(id);
      }
      continue;
    }
    const index = currentWithoutId.findIndex(
      (candidate, i) => matched[i] !== true && stableStringify(candidate) === stableStringify(row),
    );
    if (index === -1) {
      added.push({ kind: "added", id: null, row });
    } else {
      matched[index] = true;
    }
  }

  for (const [id, row] of currentById) {
    removed.push({ kind: "removed", id, row });
  }
  currentWithoutId.forEach((row, index) => {
    if (matched[index] !== true) {
      removed.push({ kind: "removed", id: null, row });
    }
  });

  return { table: name, added, changed, removed };
}

/**
 * Previews a restore: validates the archive's schema version against the
 * instance and diffs the requested tables. Read-only — it performs no writes
 * and throws before computing anything when the schema is incompatible.
 */
export async function previewRestore(options: PreviewRestoreOptions): Promise<RestorePreview> {
  const contents = readBackupArchive(options.archive, {
    instanceSchemaVersion: options.store.schemaVersion,
  });

  const scope = options.tables ?? contents.manifest.tables.map((table) => table.name);
  const tables: RestoreTableDiff[] = [];
  for (const name of new Set(scope)) {
    const backupRows = contents.tables[name];
    if (backupRows === undefined) {
      throw new AppError(
        BACKUP_RESTORE_TABLE_MISSING,
        `backup does not carry table '${name}'; restore only tables the archive includes`,
        400,
        [{ field: `tables.${name}`, reason: "missing", table: name }],
      );
    }
    const currentRows = (await options.store.readTable(name, options.filter)) ?? [];
    tables.push(diffTable(name, backupRows, currentRows));
  }

  return { schemaVersion: contents.manifest.schemaVersion, tables };
}
