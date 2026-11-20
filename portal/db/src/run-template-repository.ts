// Saved assessment run presets (T-0922).
//
// Operator-saved starting points for the New run wizard. The five built-in
// templates live in the BFF route module, never here, so an upgrade refreshes
// them and can never overwrite a copy an operator made. Rows are soft-deleted
// and every mutation appends an immutable audit event (03-database.md §5/§6).
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

/** The four assessment switches plus the baseline/drift flag a template can set. */
export interface RunTemplateOptions {
  quickScan: boolean;
  skipPurview: boolean;
  redact: boolean;
  evidence: boolean;
  autoBaseline: boolean;
}

export const DEFAULT_RUN_TEMPLATE_OPTIONS: Readonly<RunTemplateOptions> = Object.freeze({
  quickScan: false,
  skipPurview: false,
  redact: false,
  evidence: false,
  autoBaseline: false,
});

export interface RunTemplateRecord {
  id: string;
  name: string;
  description: string | null;
  sections: string[];
  options: RunTemplateOptions;
  framework: string | null;
  createdBy: string | null;
  updatedBy: string | null;
  createdAt: string;
  updatedAt: string;
  deletedAt: string | null;
}

export interface RunTemplateMutation {
  actorUserId?: string | null;
  actorType?: AuditActorType;
  source?: AuditSource;
  correlationId?: string | null;
  now?: string;
}

export interface RunTemplateCreateInput extends RunTemplateMutation {
  id?: string;
  name: string;
  description?: string | null;
  sections?: readonly string[];
  options?: Partial<RunTemplateOptions>;
  framework?: string | null;
  createdBy?: string | null;
}

export interface RunTemplateUpdateInput extends RunTemplateMutation {
  name?: string;
  description?: string | null;
  sections?: readonly string[];
  options?: Partial<RunTemplateOptions>;
  framework?: string | null;
  updatedBy?: string | null;
}

export interface RunTemplateListOptions {
  includeDeleted?: boolean;
}

export interface RunTemplateReadOptions {
  includeDeleted?: boolean;
}

export interface RunTemplateRepository {
  readonly schemaVersion: number;

  createRunTemplate(input: RunTemplateCreateInput): Promise<RunTemplateRecord>;
  getRunTemplate(
    id: string,
    options?: RunTemplateReadOptions,
  ): Promise<RunTemplateRecord | undefined>;
  listRunTemplates(options?: RunTemplateListOptions): Promise<RunTemplateRecord[]>;
  updateRunTemplate(
    id: string,
    input: RunTemplateUpdateInput,
  ): Promise<RunTemplateRecord | undefined>;
  softDeleteRunTemplate(id: string, options?: RunTemplateMutation): Promise<boolean>;
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

function parseSections(value: unknown): string[] {
  if (value === null || value === undefined) return [];
  try {
    const parsed: unknown = JSON.parse(String(value));
    return Array.isArray(parsed) ? parsed.map((item) => String(item)) : [];
  } catch {
    return [];
  }
}

function parseOptions(value: unknown): RunTemplateOptions {
  if (value === null || value === undefined) return { ...DEFAULT_RUN_TEMPLATE_OPTIONS };
  let parsed: unknown;
  try {
    parsed = JSON.parse(String(value));
  } catch {
    return { ...DEFAULT_RUN_TEMPLATE_OPTIONS };
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return { ...DEFAULT_RUN_TEMPLATE_OPTIONS };
  }
  const record = parsed as Record<string, unknown>;
  return {
    quickScan: record["quickScan"] === true,
    skipPurview: record["skipPurview"] === true,
    redact: record["redact"] === true,
    evidence: record["evidence"] === true,
    autoBaseline: record["autoBaseline"] === true,
  };
}

function stringifyJson(value: unknown): string {
  return JSON.stringify(value ?? null);
}

export class SqliteRunTemplateRepository implements RunTemplateRepository {
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

  private mapRunTemplate(row: Row): RunTemplateRecord {
    return {
      id: asString(row["id"]),
      name: asString(row["name"]),
      description: asNullableString(row["description"]),
      sections: parseSections(row["sections"]),
      options: parseOptions(row["options"]),
      framework: asNullableString(row["framework"]),
      createdBy: asNullableString(row["createdBy"]),
      updatedBy: asNullableString(row["updatedBy"]),
      createdAt: asString(row["createdAt"]),
      updatedAt: asString(row["updatedAt"]),
      deletedAt: asNullableString(row["deletedAt"]),
    };
  }

  private runTemplateById(id: string): RunTemplateRecord | undefined {
    const row = this.db
      .prepare("SELECT * FROM run_templates WHERE id = ?")
      .get(id) as Row | undefined;
    return row ? this.mapRunTemplate(row) : undefined;
  }

  async createRunTemplate(input: RunTemplateCreateInput): Promise<RunTemplateRecord> {
    const id = input.id ?? randomUUID();
    const createdAt = input.now ?? nowIso();
    const createdBy = input.createdBy ?? null;
    const after: RunTemplateRecord = {
      id,
      name: input.name,
      description: input.description ?? null,
      sections: [...(input.sections ?? [])],
      options: { ...DEFAULT_RUN_TEMPLATE_OPTIONS, ...(input.options ?? {}) },
      framework: input.framework ?? null,
      createdBy,
      updatedBy: createdBy,
      createdAt,
      updatedAt: createdAt,
      deletedAt: null,
    };
    this.db.transaction(() => {
      this.db
        .prepare(
          `INSERT INTO run_templates
             (id, name, description, sections, options, framework, createdBy, updatedBy, createdAt, updatedAt, deletedAt)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)`,
        )
        .run(
          after.id,
          after.name,
          after.description,
          stringifyJson(after.sections),
          stringifyJson(after.options),
          after.framework,
          after.createdBy,
          after.updatedBy,
          after.createdAt,
          after.updatedAt,
        );
      this.insertAudit("run_template.create", after, null, after, input);
    })();
    return after;
  }

  async getRunTemplate(
    id: string,
    options: RunTemplateReadOptions = {},
  ): Promise<RunTemplateRecord | undefined> {
    const row = this.db
      .prepare(
        options.includeDeleted
          ? "SELECT * FROM run_templates WHERE id = ?"
          : "SELECT * FROM run_templates WHERE id = ? AND deletedAt IS NULL",
      )
      .get(id) as Row | undefined;
    return row ? this.mapRunTemplate(row) : undefined;
  }

  async listRunTemplates(options: RunTemplateListOptions = {}): Promise<RunTemplateRecord[]> {
    return (
      this.db
        .prepare(
          options.includeDeleted
            ? "SELECT * FROM run_templates ORDER BY createdAt, id"
            : "SELECT * FROM run_templates WHERE deletedAt IS NULL ORDER BY createdAt, id",
        )
        .all() as Row[]
    ).map((row) => this.mapRunTemplate(row));
  }

  async updateRunTemplate(
    id: string,
    input: RunTemplateUpdateInput,
  ): Promise<RunTemplateRecord | undefined> {
    const existing = this.runTemplateById(id);
    if (!existing || existing.deletedAt !== null) return undefined;
    const updatedAt = input.now ?? nowIso();
    const after: RunTemplateRecord = {
      ...existing,
      name: input.name ?? existing.name,
      description:
        input.description === undefined ? existing.description : input.description,
      sections: input.sections === undefined ? existing.sections : [...input.sections],
      options:
        input.options === undefined
          ? existing.options
          : { ...existing.options, ...input.options },
      framework: input.framework === undefined ? existing.framework : input.framework,
      updatedBy: input.updatedBy ?? input.actorUserId ?? existing.updatedBy,
      updatedAt,
    };
    this.db.transaction(() => {
      this.db
        .prepare(
          `UPDATE run_templates
              SET name = ?, description = ?, sections = ?, options = ?, framework = ?, updatedBy = ?, updatedAt = ?
            WHERE id = ? AND deletedAt IS NULL`,
        )
        .run(
          after.name,
          after.description,
          stringifyJson(after.sections),
          stringifyJson(after.options),
          after.framework,
          after.updatedBy,
          after.updatedAt,
          id,
        );
      this.insertAudit("run_template.update", after, existing, after, input);
    })();
    return after;
  }

  async softDeleteRunTemplate(id: string, options: RunTemplateMutation = {}): Promise<boolean> {
    const existing = this.runTemplateById(id);
    if (!existing || existing.deletedAt !== null) return false;
    const at = options.now ?? nowIso();
    const after: RunTemplateRecord = { ...existing, deletedAt: at, updatedAt: at };
    return this.db.transaction(() => {
      const result = this.db
        .prepare(
          "UPDATE run_templates SET deletedAt = ?, updatedAt = ?, updatedBy = ? WHERE id = ? AND deletedAt IS NULL",
        )
        .run(at, at, options.actorUserId ?? existing.updatedBy, id);
      if (result.changes === 0) return false;
      this.insertAudit("run_template.delete", after, existing, after, options);
      return true;
    })();
  }

  private insertAudit(
    action: string,
    template: RunTemplateRecord,
    before: unknown,
    after: unknown,
    context: RunTemplateMutation,
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
        "run-template",
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

export async function openSqliteRunTemplateRepository(
  options: OpenSqliteRepositoryOptions,
): Promise<SqliteRunTemplateRepository> {
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
    const existing = row?.version === null || row?.version === undefined ? 0 : Number(row.version);
    if (existing > target) {
      throw new SchemaVersionError(existing, target);
    }
    const applied = runMigrations(db, migrations);
    if (applied !== target) {
      throw new SchemaVersionError(applied, target);
    }
    return new SqliteRunTemplateRepository(db, applied);
  } catch (error) {
    db.close();
    throw error;
  }
}
