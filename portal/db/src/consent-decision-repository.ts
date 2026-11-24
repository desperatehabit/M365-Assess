// Consent decision store (EPIC-040 SPEC.md §3.3, §5, §6; T-0786, mounted by
// T-0870). Approve/deny decisions are persisted rather than held in a process
// array, so a restart keeps the audit trail. Pending consent requests are read
// from the tenant and are not stored here.
import Database from "better-sqlite3";
import { SchemaVersionError, type ConsentDecisionRecord } from "./repository.js";
import {
  SCHEMA_VERSIONS_TABLE,
  loadMigrations,
  runMigrations,
  type OpenSqliteRepositoryOptions,
} from "./sqlite-repository.js";

type Row = Record<string, unknown>;

function asNullableString(value: unknown): string | null {
  return value === null || value === undefined ? null : String(value);
}

export interface ConsentDecisionRepository {
  readonly schemaVersion: number;

  close(): void;

  listConsentDecisions(tenantId: string): Promise<ConsentDecisionRecord[]>;
  appendConsentDecision(input: ConsentDecisionRecord): Promise<ConsentDecisionRecord>;
}

function mapDecision(row: Row): ConsentDecisionRecord {
  return {
    id: String(row["id"]),
    tenantId: String(row["tenantId"]),
    appId: String(row["appId"]),
    decision: String(row["decision"]) as ConsentDecisionRecord["decision"],
    by: String(row["by"]),
    at: String(row["at"]),
    reason: asNullableString(row["reason"]),
  };
}

export class SqliteConsentDecisionRepository implements ConsentDecisionRepository {
  readonly schemaVersion: number;

  constructor(
    private readonly db: Database.Database,
    schemaVersion: number,
  ) {
    this.schemaVersion = schemaVersion;
  }

  close(): void {
    this.db.close();
  }

  async listConsentDecisions(tenantId: string): Promise<ConsentDecisionRecord[]> {
    return (
      this.db
        .prepare(
          'SELECT * FROM consent_decisions WHERE tenantId = ? ORDER BY "at", id',
        )
        .all(tenantId) as Row[]
    ).map((row) => mapDecision(row));
  }

  async appendConsentDecision(input: ConsentDecisionRecord): Promise<ConsentDecisionRecord> {
    this.db
      .prepare(
        `INSERT INTO consent_decisions (id, tenantId, appId, decision, "by", "at", reason)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.id,
        input.tenantId,
        input.appId,
        input.decision,
        input.by,
        input.at,
        input.reason,
      );
    const row = this.db
      .prepare("SELECT * FROM consent_decisions WHERE id = ?")
      .get(input.id) as Row | undefined;
    if (row === undefined) throw new Error(`consent decision ${input.id} was not persisted`);
    return mapDecision(row);
  }
}

export async function openSqliteConsentDecisionRepository(
  options: OpenSqliteRepositoryOptions,
): Promise<SqliteConsentDecisionRepository> {
  const migrations = options.migrations ?? loadMigrations(options.migrationsDir);
  const target = migrations.reduce((max, migration) => Math.max(max, migration.version), 0);
  const db = new Database(options.filename);
  try {
    db.pragma("journal_mode = WAL");
    db.pragma("foreign_keys = ON");
    db.exec(SCHEMA_VERSIONS_TABLE);
    const row = db
      .prepare("SELECT MAX(version) AS version FROM schema_versions")
      .get() as { version: number | null } | undefined;
    const existing =
      row?.version === null || row?.version === undefined ? 0 : Number(row.version);
    if (existing > target) {
      throw new SchemaVersionError(existing, target);
    }
    const applied = runMigrations(db, migrations);
    if (applied !== target) {
      throw new SchemaVersionError(applied, target);
    }
    return new SqliteConsentDecisionRepository(db, applied);
  } catch (error) {
    db.close();
    throw error;
  }
}
