// Mailbox operation audit store (EPIC-020 SPEC.md §5; T-0382).
//
// Persists MailboxOperation (id, tenantId, mailboxId, operation, before,
// after, state, by, at) for shared-mailbox create/convert. Mailbox objects are
// read live from EXO; only operation records persist. State transitions are
// recorded in place, so the row is mutable but never deleted. Self-contained:
// types live here so no shared repository file is touched, and later
// mailbox-write tickets reuse this module.
import Database from "better-sqlite3";
import { SchemaVersionError } from "./repository.js";
import {
  SCHEMA_VERSIONS_TABLE,
  loadMigrations,
  runMigrations,
  type OpenSqliteRepositoryOptions,
} from "./sqlite-repository.js";

type Row = Record<string, unknown>;

export const MAILBOX_OPERATION_STATES = ["planned", "applied", "failed", "noop"] as const;
export type MailboxOperationState = (typeof MAILBOX_OPERATION_STATES)[number];

export interface MailboxOperation {
  readonly id: string;
  readonly tenantId: string;
  readonly mailboxId: string;
  readonly operation: string;
  readonly before: Record<string, unknown> | null;
  readonly after: Record<string, unknown> | null;
  readonly state: MailboxOperationState;
  readonly by: string | null;
  readonly at: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface MailboxOperationInput {
  readonly id: string;
  readonly tenantId: string;
  readonly mailboxId: string;
  readonly operation: string;
  readonly before?: Record<string, unknown> | null;
  readonly after?: Record<string, unknown> | null;
  readonly state?: MailboxOperationState;
  readonly by?: string | null;
  readonly at?: string;
  readonly createdAt?: string;
  readonly updatedAt?: string;
}

export interface MailboxOperationUpdate {
  readonly state?: MailboxOperationState;
  readonly after?: Record<string, unknown> | null;
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

function parseJsonObject(value: unknown): Record<string, unknown> | null {
  if (value === null || value === undefined) return null;
  try {
    const parsed: unknown = JSON.parse(String(value));
    return typeof parsed === "object" && parsed !== null
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function stringifyJson(value: Record<string, unknown> | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  return JSON.stringify(value);
}

export interface MailboxOperationRepository {
  readonly schemaVersion: number;

  close(): void;

  createMailboxOperation(input: MailboxOperationInput): Promise<MailboxOperation>;
  getMailboxOperation(
    tenantId: string,
    operationId: string,
  ): Promise<MailboxOperation | undefined>;
  listMailboxOperations(tenantId: string): Promise<MailboxOperation[]>;
  updateMailboxOperation(
    tenantId: string,
    operationId: string,
    update: MailboxOperationUpdate,
  ): Promise<MailboxOperation | undefined>;
}

export class SqliteMailboxOperationRepository implements MailboxOperationRepository {
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

  private mapOperation(row: Row): MailboxOperation {
    return {
      id: asString(row["id"]),
      tenantId: asString(row["tenantId"]),
      mailboxId: asString(row["mailboxId"]),
      operation: asString(row["operation"]),
      before: parseJsonObject(row["before"]),
      after: parseJsonObject(row["after"]),
      state: asString(row["state"]) as MailboxOperationState,
      by: asNullableString(row["by"]),
      at: asString(row["at"]),
      createdAt: asString(row["createdAt"]),
      updatedAt: asString(row["updatedAt"]),
    };
  }

  async createMailboxOperation(input: MailboxOperationInput): Promise<MailboxOperation> {
    const createdAt = input.createdAt ?? nowIso();
    const updatedAt = input.updatedAt ?? createdAt;
    this.db
      .prepare(
        `INSERT INTO mailbox_operations
           (id, tenantId, mailboxId, operation, "before", "after", state, "by", "at", createdAt, updatedAt)
         VALUES
           (@id, @tenantId, @mailboxId, @operation, @before, @after, @state, @by, @at, @createdAt, @updatedAt)`,
      )
      .run({
        id: input.id,
        tenantId: input.tenantId,
        mailboxId: input.mailboxId,
        operation: input.operation,
        before: stringifyJson(input.before),
        after: stringifyJson(input.after),
        state: input.state ?? "planned",
        by: input.by ?? null,
        at: input.at ?? createdAt,
        createdAt,
        updatedAt,
      });
    const operation = await this.getMailboxOperation(input.tenantId, input.id);
    if (!operation) throw new Error(`mailbox operation ${input.id} was not persisted`);
    return operation;
  }

  async getMailboxOperation(
    tenantId: string,
    operationId: string,
  ): Promise<MailboxOperation | undefined> {
    const row = this.db
      .prepare("SELECT * FROM mailbox_operations WHERE id = ? AND tenantId = ?")
      .get(operationId, tenantId) as Row | undefined;
    return row ? this.mapOperation(row) : undefined;
  }

  async listMailboxOperations(tenantId: string): Promise<MailboxOperation[]> {
    return (
      this.db
        .prepare('SELECT * FROM mailbox_operations WHERE tenantId = ? ORDER BY "at", id')
        .all(tenantId) as Row[]
    ).map((row) => this.mapOperation(row));
  }

  async updateMailboxOperation(
    tenantId: string,
    operationId: string,
    update: MailboxOperationUpdate,
  ): Promise<MailboxOperation | undefined> {
    const existing = await this.getMailboxOperation(tenantId, operationId);
    if (!existing) return undefined;
    const after = update.after === undefined ? existing.after : update.after;
    this.db
      .prepare(
        'UPDATE mailbox_operations SET state = ?, "after" = ?, updatedAt = ? WHERE id = ? AND tenantId = ?',
      )
      .run(
        update.state ?? existing.state,
        stringifyJson(after),
        nowIso(),
        operationId,
        tenantId,
      );
    return this.getMailboxOperation(tenantId, operationId);
  }
}

export async function openSqliteMailboxOperationRepository(
  options: OpenSqliteRepositoryOptions,
): Promise<SqliteMailboxOperationRepository> {
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
    return new SqliteMailboxOperationRepository(db, applied);
  } catch (error) {
    db.close();
    throw error;
  }
}
