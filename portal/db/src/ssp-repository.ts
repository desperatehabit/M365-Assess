// CMMC Level 2 System Security Plan store (migration 0127_ssp.sql).
//
// Persists the system profile (one row per tenant) and the consultant's answer
// for each NIST SP 800-171 practice. Values are validated by the BFF; this layer
// stores them as given. Each write records an audit_events row with the
// before/after snapshot so SSP edits are attributable.
import { randomUUID } from "node:crypto";
import Database from "better-sqlite3";
import { SchemaVersionError } from "./repository.js";
import {
  SCHEMA_VERSIONS_TABLE,
  loadMigrations,
  runMigrations,
  type OpenSqliteRepositoryOptions,
} from "./sqlite-repository.js";

type Row = Record<string, unknown>;

export interface SspProfileRecord {
  tenantId: string;
  organizationName: string;
  systemName: string;
  systemOwner: string;
  securityContact: string;
  description: string;
  boundary: string;
  environment: string;
  interconnections: string;
  cuiCategories: string;
  updatedBy: string;
  updatedAt: string;
}

export interface SspPracticeResponseRecord {
  tenantId: string;
  practiceId: string;
  implementationStatus: string;
  responsibility: string;
  narrative: string;
  evidence: string[];
  owner: string | null;
  plannedCompletion: string | null;
  updatedBy: string;
  updatedAt: string;
}

export type SspProfileUpsert = Omit<SspProfileRecord, "updatedAt"> & { updatedAt?: string };
export type SspPracticeResponseUpsert = Omit<SspPracticeResponseRecord, "updatedAt"> & { updatedAt?: string };

export interface SspRepository {
  readonly schemaVersion: number;
  close(): void;
  getProfile(tenantId: string): Promise<SspProfileRecord | undefined>;
  upsertProfile(input: SspProfileUpsert): Promise<SspProfileRecord>;
  listPracticeResponses(tenantId: string): Promise<SspPracticeResponseRecord[]>;
  getPracticeResponse(tenantId: string, practiceId: string): Promise<SspPracticeResponseRecord | undefined>;
  upsertPracticeResponse(input: SspPracticeResponseUpsert): Promise<SspPracticeResponseRecord>;
  deletePracticeResponse(tenantId: string, practiceId: string, actor: string): Promise<boolean>;
}

const PROFILE_FIELDS = [
  "organizationName",
  "systemName",
  "systemOwner",
  "securityContact",
  "description",
  "boundary",
  "environment",
  "interconnections",
  "cuiCategories",
] as const;

function nowIso(): string {
  return new Date().toISOString();
}

function asString(value: unknown): string {
  return value === null || value === undefined ? "" : String(value);
}

function asNullableString(value: unknown): string | null {
  return value === null || value === undefined ? null : String(value);
}

function parseStringArray(value: unknown): string[] {
  if (value === null || value === undefined) return [];
  try {
    const parsed: unknown = JSON.parse(String(value));
    return Array.isArray(parsed) ? parsed.map((item) => String(item)) : [];
  } catch {
    return [];
  }
}

export class SqliteSspRepository implements SspRepository {
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

  private mapProfile(row: Row): SspProfileRecord {
    const record = { tenantId: asString(row["tenantId"]) } as SspProfileRecord;
    for (const field of PROFILE_FIELDS) record[field] = asString(row[field]);
    record.updatedBy = asString(row["updatedBy"]);
    record.updatedAt = asString(row["updatedAt"]);
    return record;
  }

  private mapResponse(row: Row): SspPracticeResponseRecord {
    return {
      tenantId: asString(row["tenantId"]),
      practiceId: asString(row["practiceId"]),
      implementationStatus: asString(row["implementationStatus"]),
      responsibility: asString(row["responsibility"]),
      narrative: asString(row["narrative"]),
      evidence: parseStringArray(row["evidence"]),
      owner: asNullableString(row["owner"]),
      plannedCompletion: asNullableString(row["plannedCompletion"]),
      updatedBy: asString(row["updatedBy"]),
      updatedAt: asString(row["updatedAt"]),
    };
  }

  private writeAudit(
    action: string,
    tenantId: string,
    actor: string,
    targetType: string,
    targetId: string,
    before: unknown,
    after: unknown,
  ): void {
    const timestamp = nowIso();
    this.db
      .prepare(
        `INSERT INTO audit_events
           (id, timestamp, actorUserId, actorType, tenantId, action, targetType, targetId, before, after, result, error, source, correlationId, createdAt)
         VALUES (?, ?, ?, 'user', ?, ?, ?, ?, ?, ?, 'success', NULL, 'request', NULL, ?)`,
      )
      .run(
        randomUUID(),
        timestamp,
        actor,
        tenantId,
        action,
        targetType,
        targetId,
        before === undefined || before === null ? null : JSON.stringify(before),
        after === undefined || after === null ? null : JSON.stringify(after),
        timestamp,
      );
  }

  async getProfile(tenantId: string): Promise<SspProfileRecord | undefined> {
    const row = this.db.prepare("SELECT * FROM ssp_profiles WHERE tenantId = ?").get(tenantId) as Row | undefined;
    return row ? this.mapProfile(row) : undefined;
  }

  async upsertProfile(input: SspProfileUpsert): Promise<SspProfileRecord> {
    const updatedAt = input.updatedAt ?? nowIso();
    const before = await this.getProfile(input.tenantId);
    const write = this.db.transaction(() => {
      this.db
        .prepare(
          `INSERT INTO ssp_profiles
             (tenantId, ${PROFILE_FIELDS.join(", ")}, updatedBy, updatedAt)
           VALUES (?, ${PROFILE_FIELDS.map(() => "?").join(", ")}, ?, ?)
           ON CONFLICT(tenantId) DO UPDATE SET
             ${PROFILE_FIELDS.map((field) => `${field} = excluded.${field}`).join(", ")},
             updatedBy = excluded.updatedBy,
             updatedAt = excluded.updatedAt`,
        )
        .run(input.tenantId, ...PROFILE_FIELDS.map((field) => input[field]), input.updatedBy, updatedAt);
      const after = this.mapProfile(
        this.db.prepare("SELECT * FROM ssp_profiles WHERE tenantId = ?").get(input.tenantId) as Row,
      );
      this.writeAudit("ssp.profile.update", input.tenantId, input.updatedBy, "ssp_profile", input.tenantId, before, after);
      return after;
    });
    return write();
  }

  async listPracticeResponses(tenantId: string): Promise<SspPracticeResponseRecord[]> {
    const rows = this.db
      .prepare("SELECT * FROM ssp_practice_responses WHERE tenantId = ? ORDER BY practiceId")
      .all(tenantId) as Row[];
    return rows.map((row) => this.mapResponse(row));
  }

  async getPracticeResponse(tenantId: string, practiceId: string): Promise<SspPracticeResponseRecord | undefined> {
    const row = this.db
      .prepare("SELECT * FROM ssp_practice_responses WHERE tenantId = ? AND practiceId = ?")
      .get(tenantId, practiceId) as Row | undefined;
    return row ? this.mapResponse(row) : undefined;
  }

  async upsertPracticeResponse(input: SspPracticeResponseUpsert): Promise<SspPracticeResponseRecord> {
    const updatedAt = input.updatedAt ?? nowIso();
    const before = await this.getPracticeResponse(input.tenantId, input.practiceId);
    const write = this.db.transaction(() => {
      this.db
        .prepare(
          `INSERT INTO ssp_practice_responses
             (tenantId, practiceId, implementationStatus, responsibility, narrative, evidence, owner, plannedCompletion, updatedBy, updatedAt)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(tenantId, practiceId) DO UPDATE SET
             implementationStatus = excluded.implementationStatus,
             responsibility = excluded.responsibility,
             narrative = excluded.narrative,
             evidence = excluded.evidence,
             owner = excluded.owner,
             plannedCompletion = excluded.plannedCompletion,
             updatedBy = excluded.updatedBy,
             updatedAt = excluded.updatedAt`,
        )
        .run(
          input.tenantId,
          input.practiceId,
          input.implementationStatus,
          input.responsibility,
          input.narrative,
          JSON.stringify(input.evidence),
          input.owner,
          input.plannedCompletion,
          input.updatedBy,
          updatedAt,
        );
      const after = this.mapResponse(
        this.db
          .prepare("SELECT * FROM ssp_practice_responses WHERE tenantId = ? AND practiceId = ?")
          .get(input.tenantId, input.practiceId) as Row,
      );
      this.writeAudit("ssp.practice.update", input.tenantId, input.updatedBy, "ssp_practice", input.practiceId, before, after);
      return after;
    });
    return write();
  }

  async deletePracticeResponse(tenantId: string, practiceId: string, actor: string): Promise<boolean> {
    const before = await this.getPracticeResponse(tenantId, practiceId);
    if (before === undefined) return false;
    const write = this.db.transaction(() => {
      this.db.prepare("DELETE FROM ssp_practice_responses WHERE tenantId = ? AND practiceId = ?").run(tenantId, practiceId);
      this.writeAudit("ssp.practice.clear", tenantId, actor, "ssp_practice", practiceId, before, null);
    });
    write();
    return true;
  }
}

export async function openSqliteSspRepository(options: OpenSqliteRepositoryOptions): Promise<SqliteSspRepository> {
  const migrations = options.migrations ?? loadMigrations(options.migrationsDir);
  const target = migrations.reduce((max, migration) => Math.max(max, migration.version), 0);
  const db = new Database(options.filename);
  try {
    db.pragma("journal_mode = WAL");
    db.pragma("foreign_keys = ON");
    db.exec(SCHEMA_VERSIONS_TABLE);
    const row = db.prepare("SELECT MAX(version) AS version FROM schema_versions").get() as
      | { version: number | null }
      | undefined;
    const existing = row?.version === null || row?.version === undefined ? 0 : Number(row.version);
    if (existing > target) {
      throw new SchemaVersionError(existing, target);
    }
    const applied = runMigrations(db, migrations);
    if (applied !== target) {
      throw new SchemaVersionError(applied, target);
    }
    return new SqliteSspRepository(db, applied);
  } catch (error) {
    db.close();
    throw error;
  }
}
