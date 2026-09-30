// Quarantine action audit store (EPIC-022 SPEC.md §5, §8; T-0424).
//
// Persists QuarantineAction (id, tenantId, messageId, action, recipient, by,
// at, result) for quarantine release/delete/block. Quarantine messages are
// read live from EXO/Graph and never mirrored; only action records persist.
// State transitions are recorded in place, so the row is mutable but never
// deleted. Self-contained: types live here so no shared repository file is
// touched, and the submit-for-review ticket (T-0426) reuses this module.
import Database from "better-sqlite3";
import { SchemaVersionError } from "./repository.js";
import {
  SCHEMA_VERSIONS_TABLE,
  loadMigrations,
  runMigrations,
  type OpenSqliteRepositoryOptions,
} from "./sqlite-repository.js";

type Row = Record<string, unknown>;

export const QUARANTINE_ACTION_RESULTS = ["pending", "success", "failure"] as const;
export type QuarantineActionResult = (typeof QUARANTINE_ACTION_RESULTS)[number];

export interface QuarantineAction {
  readonly id: string;
  readonly tenantId: string;
  readonly messageId: string;
  readonly action: string;
  readonly recipient: string | null;
  readonly by: string | null;
  readonly at: string;
  readonly result: QuarantineActionResult;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface QuarantineActionInput {
  readonly id: string;
  readonly tenantId: string;
  readonly messageId: string;
  readonly action: string;
  readonly recipient?: string | null;
  readonly by?: string | null;
  readonly at?: string;
  readonly result?: QuarantineActionResult;
  readonly createdAt?: string;
  readonly updatedAt?: string;
}

export interface QuarantineActionUpdate {
  readonly result?: QuarantineActionResult;
}

function nowIso(): string {
  return new Date().toISOString();
}

function asString(value: unknown): string {
  return String(value);
}

function asNullableString(value: unknown): string | null {
  return value === null || value === undefined ? null : String(value);
}

function asNumber(value: unknown): number {
  return typeof value === "number" ? value : Number(value);
}

function asResult(value: unknown): QuarantineActionResult {
  const result = String(value);
  return (QUARANTINE_ACTION_RESULTS as readonly string[]).includes(result)
    ? (result as QuarantineActionResult)
    : "pending";
}

export interface QuarantineActionRepository {
  readonly schemaVersion: number;

  close(): void;

  createQuarantineAction(input: QuarantineActionInput): Promise<QuarantineAction>;
  getQuarantineAction(tenantId: string, actionId: string): Promise<QuarantineAction | undefined>;
  listQuarantineActions(tenantId: string): Promise<QuarantineAction[]>;
  updateQuarantineAction(
    tenantId: string,
    actionId: string,
    update: QuarantineActionUpdate,
  ): Promise<QuarantineAction | undefined>;
}

export class SqliteQuarantineActionRepository implements QuarantineActionRepository {
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

  private mapAction(row: Row): QuarantineAction {
    return {
      id: asString(row["id"]),
      tenantId: asString(row["tenantId"]),
      messageId: asString(row["messageId"]),
      action: asString(row["action"]),
      recipient: asNullableString(row["recipient"]),
      by: asNullableString(row["by"]),
      at: asString(row["at"]),
      result: asResult(row["result"]),
      createdAt: asString(row["createdAt"]),
      updatedAt: asString(row["updatedAt"]),
    };
  }

  async createQuarantineAction(input: QuarantineActionInput): Promise<QuarantineAction> {
    const createdAt = input.createdAt ?? nowIso();
    const updatedAt = input.updatedAt ?? createdAt;
    this.db
      .prepare(
        `INSERT INTO quarantine_actions
           (id, tenantId, messageId, action, recipient, "by", "at", result, createdAt, updatedAt)
         VALUES
           (@id, @tenantId, @messageId, @action, @recipient, @by, @at, @result, @createdAt, @updatedAt)`,
      )
      .run({
        id: input.id,
        tenantId: input.tenantId,
        messageId: input.messageId,
        action: input.action,
        recipient: input.recipient ?? null,
        by: input.by ?? null,
        at: input.at ?? createdAt,
        result: input.result ?? "pending",
        createdAt,
        updatedAt,
      });
    const action = await this.getQuarantineAction(input.tenantId, input.id);
    if (!action) throw new Error(`quarantine action ${input.id} was not persisted`);
    return action;
  }

  async getQuarantineAction(
    tenantId: string,
    actionId: string,
  ): Promise<QuarantineAction | undefined> {
    const row = this.db
      .prepare("SELECT * FROM quarantine_actions WHERE id = ? AND tenantId = ?")
      .get(actionId, tenantId) as Row | undefined;
    return row ? this.mapAction(row) : undefined;
  }

  async listQuarantineActions(tenantId: string): Promise<QuarantineAction[]> {
    return (
      this.db
        .prepare('SELECT * FROM quarantine_actions WHERE tenantId = ? ORDER BY "at", id')
        .all(tenantId) as Row[]
    ).map((row) => this.mapAction(row));
  }

  async updateQuarantineAction(
    tenantId: string,
    actionId: string,
    update: QuarantineActionUpdate,
  ): Promise<QuarantineAction | undefined> {
    const existing = await this.getQuarantineAction(tenantId, actionId);
    if (!existing) return undefined;
    this.db
      .prepare(
        'UPDATE quarantine_actions SET result = ?, updatedAt = ? WHERE id = ? AND tenantId = ?',
      )
      .run(update.result ?? existing.result, nowIso(), actionId, tenantId);
    return this.getQuarantineAction(tenantId, actionId);
  }
}

export async function openSqliteQuarantineActionRepository(
  options: OpenSqliteRepositoryOptions,
): Promise<SqliteQuarantineActionRepository> {
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
    const existing = row?.version === null || row?.version === undefined ? 0 : asNumber(row.version);
    if (existing > target) {
      throw new SchemaVersionError(existing, target);
    }
    const applied = runMigrations(db, migrations);
    if (applied !== target) {
      throw new SchemaVersionError(applied, target);
    }
    return new SqliteQuarantineActionRepository(db, applied);
  } catch (error) {
    db.close();
    throw error;
  }
}
