// Retention tag assignment audit store (EPIC-020 SPEC.md §5; T-0387).
//
// Persists RetentionTagAssignment (id, tenantId, mailboxId, tagId, policyId,
// before, after, state, by, at) for per-mailbox and bulk tag assignment.
// Policies and tags are read live from EXO; only the assignment record
// persists. State transitions are recorded in place, so the row is mutable
// but never deleted. Self-contained: types live here so no shared
// repository file is touched.
import Database from "better-sqlite3";
import { SchemaVersionError } from "./repository.js";
import {
  SCHEMA_VERSIONS_TABLE,
  loadMigrations,
  runMigrations,
  type OpenSqliteRepositoryOptions,
} from "./sqlite-repository.js";

type Row = Record<string, unknown>;

export const RETENTION_ASSIGNMENT_STATES = ["planned", "applied", "failed", "noop"] as const;
export type RetentionAssignmentState = (typeof RETENTION_ASSIGNMENT_STATES)[number];

export interface RetentionTagAssignment {
  readonly id: string;
  readonly tenantId: string;
  readonly mailboxId: string;
  readonly tagId: string;
  readonly policyId: string | null;
  readonly before: Record<string, unknown> | null;
  readonly after: Record<string, unknown> | null;
  readonly state: RetentionAssignmentState;
  readonly by: string | null;
  readonly at: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface RetentionTagAssignmentInput {
  readonly id: string;
  readonly tenantId: string;
  readonly mailboxId: string;
  readonly tagId: string;
  readonly policyId?: string | null;
  readonly before?: Record<string, unknown> | null;
  readonly after?: Record<string, unknown> | null;
  readonly state?: RetentionAssignmentState;
  readonly by?: string | null;
  readonly at?: string;
  readonly createdAt?: string;
  readonly updatedAt?: string;
}

export interface RetentionTagAssignmentUpdate {
  readonly state?: RetentionAssignmentState;
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

export interface RetentionTagAssignmentRepository {
  readonly schemaVersion: number;

  close(): void;

  createRetentionTagAssignment(input: RetentionTagAssignmentInput): Promise<RetentionTagAssignment>;
  getRetentionTagAssignment(
    tenantId: string,
    assignmentId: string,
  ): Promise<RetentionTagAssignment | undefined>;
  listRetentionTagAssignments(tenantId: string): Promise<RetentionTagAssignment[]>;
  listRetentionTagAssignmentsForMailbox(
    tenantId: string,
    mailboxId: string,
  ): Promise<RetentionTagAssignment[]>;
  updateRetentionTagAssignment(
    tenantId: string,
    assignmentId: string,
    update: RetentionTagAssignmentUpdate,
  ): Promise<RetentionTagAssignment | undefined>;
}

export class SqliteRetentionTagAssignmentRepository implements RetentionTagAssignmentRepository {
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

  private mapAssignment(row: Row): RetentionTagAssignment {
    return {
      id: asString(row["id"]),
      tenantId: asString(row["tenantId"]),
      mailboxId: asString(row["mailboxId"]),
      tagId: asString(row["tagId"]),
      policyId: asNullableString(row["policyId"]),
      before: parseJsonObject(row["before"]),
      after: parseJsonObject(row["after"]),
      state: asString(row["state"]) as RetentionAssignmentState,
      by: asNullableString(row["by"]),
      at: asString(row["at"]),
      createdAt: asString(row["createdAt"]),
      updatedAt: asString(row["updatedAt"]),
    };
  }

  async createRetentionTagAssignment(
    input: RetentionTagAssignmentInput,
  ): Promise<RetentionTagAssignment> {
    const createdAt = input.createdAt ?? nowIso();
    const updatedAt = input.updatedAt ?? createdAt;
    this.db
      .prepare(
        `INSERT INTO retention_tag_assignments
           (id, tenantId, mailboxId, tagId, policyId, "before", "after", state, "by", "at", createdAt, updatedAt)
         VALUES
           (@id, @tenantId, @mailboxId, @tagId, @policyId, @before, @after, @state, @by, @at, @createdAt, @updatedAt)`,
      )
      .run({
        id: input.id,
        tenantId: input.tenantId,
        mailboxId: input.mailboxId,
        tagId: input.tagId,
        policyId: input.policyId ?? null,
        before: stringifyJson(input.before),
        after: stringifyJson(input.after),
        state: input.state ?? "planned",
        by: input.by ?? null,
        at: input.at ?? createdAt,
        createdAt,
        updatedAt,
      });
    const assignment = await this.getRetentionTagAssignment(input.tenantId, input.id);
    if (!assignment) throw new Error(`retention tag assignment ${input.id} was not persisted`);
    return assignment;
  }

  async getRetentionTagAssignment(
    tenantId: string,
    assignmentId: string,
  ): Promise<RetentionTagAssignment | undefined> {
    const row = this.db
      .prepare("SELECT * FROM retention_tag_assignments WHERE id = ? AND tenantId = ?")
      .get(assignmentId, tenantId) as Row | undefined;
    return row ? this.mapAssignment(row) : undefined;
  }

  async listRetentionTagAssignments(tenantId: string): Promise<RetentionTagAssignment[]> {
    return (
      this.db
        .prepare('SELECT * FROM retention_tag_assignments WHERE tenantId = ? ORDER BY "at", id')
        .all(tenantId) as Row[]
    ).map((row) => this.mapAssignment(row));
  }

  async listRetentionTagAssignmentsForMailbox(
    tenantId: string,
    mailboxId: string,
  ): Promise<RetentionTagAssignment[]> {
    return (
      this.db
        .prepare(
          'SELECT * FROM retention_tag_assignments WHERE tenantId = ? AND mailboxId = ? ORDER BY "at", id',
        )
        .all(tenantId, mailboxId) as Row[]
    ).map((row) => this.mapAssignment(row));
  }

  async updateRetentionTagAssignment(
    tenantId: string,
    assignmentId: string,
    update: RetentionTagAssignmentUpdate,
  ): Promise<RetentionTagAssignment | undefined> {
    const existing = await this.getRetentionTagAssignment(tenantId, assignmentId);
    if (!existing) return undefined;
    const after = update.after === undefined ? existing.after : update.after;
    this.db
      .prepare(
        'UPDATE retention_tag_assignments SET state = ?, "after" = ?, updatedAt = ? WHERE id = ? AND tenantId = ?',
      )
      .run(
        update.state ?? existing.state,
        stringifyJson(after),
        nowIso(),
        assignmentId,
        tenantId,
      );
    return this.getRetentionTagAssignment(tenantId, assignmentId);
  }
}

export async function openSqliteRetentionTagAssignmentRepository(
  options: OpenSqliteRepositoryOptions,
): Promise<SqliteRetentionTagAssignmentRepository> {
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
    return new SqliteRetentionTagAssignmentRepository(db, applied);
  } catch (error) {
    db.close();
    throw error;
  }
}

export const openSqliteRetentionRepository = openSqliteRetentionTagAssignmentRepository;
