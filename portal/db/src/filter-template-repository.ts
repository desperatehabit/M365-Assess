// Filter template storage (EPIC-022 SPEC.md §3.2, §5; T-0423).
// Persists reusable filter policy templates (SPEC §5 FilterTemplate): name,
// filterType, policyJson, the deploy-required %name% variables, and a local
// source marker. Filter policies themselves are read live from EXO and never
// persisted; only templates persist. Deletion is a soft delete (03-database.md
// §5) and every mutation appends an immutable audit event (03-database.md §6).
import { randomUUID } from "node:crypto";
import Database from "better-sqlite3";
import {
  SchemaVersionError,
  type AuditActorType,
  type AuditSource,
} from "./repository.js";
import {
  SCHEMA_VERSIONS_TABLE,
  loadMigrations,
  runMigrations,
  type OpenSqliteRepositoryOptions,
} from "./sqlite-repository.js";

type Row = Record<string, unknown>;

// Migration 0029 creates this table for the shared database; the DDL stays here
// (idempotent) for databases opened through openSqliteFilterTemplateRepository.
const FILTER_TEMPLATES_DDL = `
CREATE TABLE IF NOT EXISTS filter_templates (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  filterType  TEXT NOT NULL CHECK (filterType IN ('spam', 'antiphish', 'malware', 'connection')),
  policyJson  TEXT NOT NULL,
  variables   TEXT NOT NULL DEFAULT '[]',
  source      TEXT NOT NULL DEFAULT 'local',
  createdBy   TEXT,
  updatedBy   TEXT,
  createdAt   TEXT NOT NULL,
  updatedAt   TEXT NOT NULL,
  deletedAt   TEXT
);
CREATE INDEX IF NOT EXISTS idx_filter_templates_deletedAt ON filter_templates (deletedAt);
`;

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

function parseJsonValue(value: unknown): unknown {
  if (value === null || value === undefined) return null;
  try {
    return JSON.parse(String(value));
  } catch {
    return null;
  }
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

function stringifyJson(value: unknown): string {
  return JSON.stringify(value ?? null);
}

export interface FilterTemplateRecord {
  id: string;
  name: string;
  filterType: string;
  policyJson: unknown;
  variables: string[];
  source: string;
  createdBy: string | null;
  updatedBy: string | null;
  createdAt: string;
  updatedAt: string;
  deletedAt: string | null;
}

export interface FilterTemplateMutation {
  actorUserId?: string | null;
  actorType?: AuditActorType;
  source?: AuditSource;
  correlationId?: string | null;
  now?: string;
}

export interface FilterTemplateCreateInput extends FilterTemplateMutation {
  id?: string;
  name: string;
  filterType: string;
  policyJson: unknown;
  variables?: string[];
  createdBy?: string | null;
  createdAt?: string;
  updatedAt?: string;
}

export interface FilterTemplateUpdateInput extends FilterTemplateMutation {
  name?: string;
  filterType?: string;
  policyJson?: unknown;
  variables?: string[];
  updatedBy?: string | null;
  updatedAt?: string;
}

export interface FilterTemplateCloneInput extends FilterTemplateMutation {
  id?: string;
  name: string;
  createdBy?: string | null;
  createdAt?: string;
}

export interface FilterTemplateListOptions {
  includeDeleted?: boolean;
}

export interface FilterTemplateReadOptions {
  includeDeleted?: boolean;
}

export interface FilterTemplateRepository {
  readonly schemaVersion: number;

  close(): void;

  createTemplate(input: FilterTemplateCreateInput): Promise<FilterTemplateRecord>;
  getTemplate(
    id: string,
    options?: FilterTemplateReadOptions,
  ): Promise<FilterTemplateRecord | undefined>;
  listTemplates(options?: FilterTemplateListOptions): Promise<FilterTemplateRecord[]>;
  updateTemplate(
    id: string,
    input: FilterTemplateUpdateInput,
  ): Promise<FilterTemplateRecord | undefined>;
  softDeleteTemplate(id: string, options?: FilterTemplateMutation): Promise<boolean>;
  cloneTemplate(
    sourceId: string,
    input: FilterTemplateCloneInput,
  ): Promise<FilterTemplateRecord | undefined>;
}

export class SqliteFilterTemplateRepository implements FilterTemplateRepository {
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

  private mapTemplate(row: Row): FilterTemplateRecord {
    return {
      id: asString(row["id"]),
      name: asString(row["name"]),
      filterType: asString(row["filterType"]),
      policyJson: parseJsonValue(row["policyJson"]),
      variables: parseStringArray(row["variables"]),
      source: asString(row["source"]),
      createdBy: asNullableString(row["createdBy"]),
      updatedBy: asNullableString(row["updatedBy"]),
      createdAt: asString(row["createdAt"]),
      updatedAt: asString(row["updatedAt"]),
      deletedAt: asNullableString(row["deletedAt"]),
    };
  }

  private templateById(id: string): FilterTemplateRecord | undefined {
    const row = this.db
      .prepare("SELECT * FROM filter_templates WHERE id = ?")
      .get(id) as Row | undefined;
    return row ? this.mapTemplate(row) : undefined;
  }

  async createTemplate(input: FilterTemplateCreateInput): Promise<FilterTemplateRecord> {
    const id = input.id ?? randomUUID();
    const createdAt = input.createdAt ?? input.now ?? nowIso();
    const updatedAt = input.updatedAt ?? createdAt;
    const createdBy = input.createdBy ?? null;
    const after: FilterTemplateRecord = {
      id,
      name: input.name,
      filterType: input.filterType,
      policyJson: input.policyJson ?? null,
      variables: input.variables ?? [],
      source: "local",
      createdBy,
      updatedBy: createdBy,
      createdAt,
      updatedAt,
      deletedAt: null,
    };
    this.db.transaction(() => {
      this.db
        .prepare(
          `INSERT INTO filter_templates
             (id, name, filterType, policyJson, variables, source, createdBy, updatedBy, createdAt, updatedAt, deletedAt)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)`,
        )
        .run(
          after.id,
          after.name,
          after.filterType,
          stringifyJson(after.policyJson),
          stringifyJson(after.variables),
          after.source,
          after.createdBy,
          after.updatedBy,
          after.createdAt,
          after.updatedAt,
        );
      this.insertAudit("filter_template.create", after, null, after, input);
    })();
    return after;
  }

  async getTemplate(
    id: string,
    options: FilterTemplateReadOptions = {},
  ): Promise<FilterTemplateRecord | undefined> {
    const row = this.db
      .prepare(
        options.includeDeleted
          ? "SELECT * FROM filter_templates WHERE id = ?"
          : "SELECT * FROM filter_templates WHERE id = ? AND deletedAt IS NULL",
      )
      .get(id) as Row | undefined;
    return row ? this.mapTemplate(row) : undefined;
  }

  async listTemplates(options: FilterTemplateListOptions = {}): Promise<FilterTemplateRecord[]> {
    return (
      this.db
        .prepare(
          options.includeDeleted
            ? "SELECT * FROM filter_templates ORDER BY createdAt, id"
            : "SELECT * FROM filter_templates WHERE deletedAt IS NULL ORDER BY createdAt, id",
        )
        .all() as Row[]
    ).map((row) => this.mapTemplate(row));
  }

  async updateTemplate(
    id: string,
    input: FilterTemplateUpdateInput,
  ): Promise<FilterTemplateRecord | undefined> {
    const existing = this.templateById(id);
    if (!existing || existing.deletedAt !== null) return undefined;
    const updatedAt = input.updatedAt ?? input.now ?? nowIso();
    const after: FilterTemplateRecord = {
      ...existing,
      name: input.name ?? existing.name,
      filterType: input.filterType ?? existing.filterType,
      policyJson: input.policyJson === undefined ? existing.policyJson : input.policyJson,
      variables: input.variables ?? existing.variables,
      updatedBy: input.updatedBy ?? input.actorUserId ?? existing.updatedBy,
      updatedAt,
    };
    this.db.transaction(() => {
      this.db
        .prepare(
          "UPDATE filter_templates SET name = ?, filterType = ?, policyJson = ?, variables = ?, updatedBy = ?, updatedAt = ? WHERE id = ? AND deletedAt IS NULL",
        )
        .run(
          after.name,
          after.filterType,
          stringifyJson(after.policyJson),
          stringifyJson(after.variables),
          after.updatedBy,
          after.updatedAt,
          id,
        );
      this.insertAudit("filter_template.update", after, existing, after, input);
    })();
    return after;
  }

  async softDeleteTemplate(id: string, options: FilterTemplateMutation = {}): Promise<boolean> {
    const existing = this.templateById(id);
    if (!existing || existing.deletedAt !== null) return false;
    const at = options.now ?? nowIso();
    const after: FilterTemplateRecord = { ...existing, deletedAt: at, updatedAt: at };
    return this.db.transaction(() => {
      const result = this.db
        .prepare(
          "UPDATE filter_templates SET deletedAt = ?, updatedAt = ?, updatedBy = ? WHERE id = ? AND deletedAt IS NULL",
        )
        .run(at, at, options.actorUserId ?? existing.updatedBy, id);
      if (result.changes === 0) return false;
      this.insertAudit("filter_template.delete", after, existing, after, options);
      return true;
    })();
  }

  async cloneTemplate(
    sourceId: string,
    input: FilterTemplateCloneInput,
  ): Promise<FilterTemplateRecord | undefined> {
    const source = this.templateById(sourceId);
    if (!source || source.deletedAt !== null) return undefined;
    const id = input.id ?? randomUUID();
    const createdAt = input.createdAt ?? input.now ?? nowIso();
    const createdBy = input.createdBy ?? null;
    const after: FilterTemplateRecord = {
      id,
      name: input.name,
      filterType: source.filterType,
      policyJson: source.policyJson,
      variables: [...source.variables],
      source: "local",
      createdBy,
      updatedBy: createdBy,
      createdAt,
      updatedAt: createdAt,
      deletedAt: null,
    };
    this.db.transaction(() => {
      this.db
        .prepare(
          `INSERT INTO filter_templates
             (id, name, filterType, policyJson, variables, source, createdBy, updatedBy, createdAt, updatedAt, deletedAt)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)`,
        )
        .run(
          after.id,
          after.name,
          after.filterType,
          stringifyJson(after.policyJson),
          stringifyJson(after.variables),
          after.source,
          after.createdBy,
          after.updatedBy,
          after.createdAt,
          after.updatedAt,
        );
      this.insertAudit("filter_template.clone", after, source, after, input);
    })();
    return after;
  }

  private insertAudit(
    action: string,
    template: FilterTemplateRecord,
    before: unknown,
    after: unknown,
    context: FilterTemplateMutation,
  ): void {
    const timestamp = context.now ?? nowIso();
    this.db
      .prepare(
        `INSERT INTO audit_events
           (id, timestamp, actorUserId, actorType, tenantId, action, targetType, targetId, before, after, result, error, source, correlationId, createdAt)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        randomUUID(),
        timestamp,
        context.actorUserId ?? null,
        context.actorType ?? (context.actorUserId ? "user" : "system"),
        null,
        action,
        "filter-template",
        template.id,
        stringifyJson(before),
        stringifyJson(after),
        "success",
        null,
        context.source ?? "request",
        context.correlationId ?? null,
        timestamp,
      );
  }
}

export async function openSqliteFilterTemplateRepository(
  options: OpenSqliteRepositoryOptions,
): Promise<SqliteFilterTemplateRepository> {
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
    db.exec(FILTER_TEMPLATES_DDL);
    return new SqliteFilterTemplateRepository(db, applied);
  } catch (error) {
    db.close();
    throw error;
  }
}
