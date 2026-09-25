// Custom-script entities (EPIC-007 SPEC §5, §3.3) on top of the shared
// repository contract. Saving a script appends a new immutable version and
// advances `currentVersionId`; no update or delete path exists for a version.
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

function asBool(value: unknown): boolean {
  return asNumber(value) === 1;
}

function parseJson(value: unknown): Record<string, unknown> | null {
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

function stringifyJson(value: unknown): string | null {
  return value === null || value === undefined ? null : JSON.stringify(value);
}

/** Who performed a mutation, for the append-only audit log (03-database.md §6). */
export interface AuditActor {
  actorUserId?: string | null;
  actorType?: AuditActorType;
  source?: AuditSource;
  correlationId?: string | null;
}

export interface CustomScript {
  id: string;
  name: string;
  author: string;
  enabled: boolean;
  alertsEnabled: boolean;
  currentVersionId: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface CustomScriptVersion {
  id: string;
  scriptId: string;
  content: string;
  markdownTemplate: string | null;
  parameters: Record<string, unknown> | null;
  createdAt: string;
  createdBy: string;
}

export interface RegisterCustomScriptInput {
  id: string;
  name: string;
  author: string;
  enabled?: boolean;
  alertsEnabled?: boolean;
  createdAt?: string;
  updatedAt?: string;
  actor?: AuditActor;
}

export interface AppendCustomScriptVersionInput {
  id: string;
  scriptId: string;
  content: string;
  markdownTemplate?: string | null;
  parameters?: Record<string, unknown> | null;
  createdBy: string;
  createdAt?: string;
  actor?: AuditActor;
}

export interface SetCustomScriptFlagsInput {
  scriptId: string;
  enabled?: boolean;
  alertsEnabled?: boolean;
  actor?: AuditActor;
}

/** Raised when a version is appended to a script that does not exist. */
export class CustomScriptNotFoundError extends Error {
  readonly code = "customScript.not_found";

  constructor(scriptId: string) {
    super(`custom script ${scriptId} was not found`);
    this.name = "CustomScriptNotFoundError";
  }
}

/**
 * The custom-script surface. Versions are append-only: there is deliberately
 * no update or delete method for a `CustomScriptVersion` (SPEC §3.3, §5).
 */
export interface CustomScriptRepository {
  readonly schemaVersion: number;

  close(): void;

  registerScript(input: RegisterCustomScriptInput): Promise<CustomScript>;
  getScript(scriptId: string): Promise<CustomScript | undefined>;
  listScripts(): Promise<CustomScript[]>;
  setScriptFlags(input: SetCustomScriptFlagsInput): Promise<CustomScript | undefined>;

  appendVersion(input: AppendCustomScriptVersionInput): Promise<CustomScriptVersion>;
  getVersion(versionId: string): Promise<CustomScriptVersion | undefined>;
  listVersions(scriptId: string): Promise<CustomScriptVersion[]>;
}

export class SqliteCustomScriptRepository implements CustomScriptRepository {
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

  private mapScript(row: Row): CustomScript {
    return {
      id: asString(row["id"]),
      name: asString(row["name"]),
      author: asString(row["author"]),
      enabled: asBool(row["enabled"]),
      alertsEnabled: asBool(row["alertsEnabled"]),
      currentVersionId: asNullableString(row["currentVersionId"]),
      createdAt: asString(row["createdAt"]),
      updatedAt: asString(row["updatedAt"]),
    };
  }

  private mapVersion(row: Row): CustomScriptVersion {
    return {
      id: asString(row["id"]),
      scriptId: asString(row["scriptId"]),
      content: asString(row["content"]),
      markdownTemplate: asNullableString(row["markdownTemplate"]),
      parameters: parseJson(row["parameters"]),
      createdAt: asString(row["createdAt"]),
      createdBy: asString(row["createdBy"]),
    };
  }

  private writeAudit(event: {
    action: string;
    targetType: string;
    targetId: string;
    before?: unknown;
    after?: unknown;
    actor?: AuditActor;
    at: string;
  }): void {
    const actor = event.actor ?? {};
    this.db
      .prepare(
        `INSERT INTO audit_events
           (id, timestamp, actorUserId, actorType, tenantId, action, targetType, targetId, before, after, result, error, source, correlationId, createdAt)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        randomUUID(),
        event.at,
        actor.actorUserId ?? null,
        actor.actorType ?? "user",
        null,
        event.action,
        event.targetType,
        event.targetId,
        stringifyJson(event.before ?? null),
        stringifyJson(event.after ?? null),
        "success",
        null,
        actor.source ?? "request",
        actor.correlationId ?? null,
        nowIso(),
      );
  }

  async registerScript(input: RegisterCustomScriptInput): Promise<CustomScript> {
    const createdAt = input.createdAt ?? nowIso();
    const updatedAt = input.updatedAt ?? createdAt;
    this.db.transaction(() => {
      this.db
        .prepare(
          `INSERT INTO custom_scripts
             (id, name, author, enabled, alertsEnabled, currentVersionId, createdAt, updatedAt)
           VALUES (?, ?, ?, ?, ?, NULL, ?, ?)`,
        )
        .run(
          input.id,
          input.name,
          input.author,
          input.enabled ? 1 : 0,
          input.alertsEnabled ? 1 : 0,
          createdAt,
          updatedAt,
        );
      this.writeAudit({
        action: "script.create",
        targetType: "customScript",
        targetId: input.id,
        after: {
          id: input.id,
          name: input.name,
          author: input.author,
          enabled: input.enabled ?? false,
          alertsEnabled: input.alertsEnabled ?? false,
          currentVersionId: null,
        },
        actor: input.actor,
        at: updatedAt,
      });
    })();
    const script = await this.getScript(input.id);
    if (!script) throw new Error(`custom script ${input.id} was not persisted`);
    return script;
  }

  async getScript(scriptId: string): Promise<CustomScript | undefined> {
    const row = this.db
      .prepare("SELECT * FROM custom_scripts WHERE id = ?")
      .get(scriptId) as Row | undefined;
    return row ? this.mapScript(row) : undefined;
  }

  async listScripts(): Promise<CustomScript[]> {
    return (
      this.db.prepare("SELECT * FROM custom_scripts ORDER BY name, id").all() as Row[]
    ).map((row) => this.mapScript(row));
  }

  async setScriptFlags(input: SetCustomScriptFlagsInput): Promise<CustomScript | undefined> {
    const existing = await this.getScript(input.scriptId);
    if (!existing) return undefined;
    const enabled = input.enabled ?? existing.enabled;
    const alertsEnabled = input.alertsEnabled ?? existing.alertsEnabled;
    if (enabled === existing.enabled && alertsEnabled === existing.alertsEnabled) {
      return existing;
    }
    const updatedAt = nowIso();
    this.db.transaction(() => {
      this.db
        .prepare(
          "UPDATE custom_scripts SET enabled = ?, alertsEnabled = ?, updatedAt = ? WHERE id = ?",
        )
        .run(enabled ? 1 : 0, alertsEnabled ? 1 : 0, updatedAt, input.scriptId);
      this.writeAudit({
        action: "script.update",
        targetType: "customScript",
        targetId: input.scriptId,
        before: { enabled: existing.enabled, alertsEnabled: existing.alertsEnabled },
        after: { enabled, alertsEnabled },
        actor: input.actor,
        at: updatedAt,
      });
    })();
    return this.getScript(input.scriptId);
  }

  async appendVersion(input: AppendCustomScriptVersionInput): Promise<CustomScriptVersion> {
    const script = await this.getScript(input.scriptId);
    if (!script) throw new CustomScriptNotFoundError(input.scriptId);
    const createdAt = input.createdAt ?? nowIso();
    const version: CustomScriptVersion = {
      id: input.id,
      scriptId: input.scriptId,
      content: input.content,
      markdownTemplate: input.markdownTemplate ?? null,
      parameters: input.parameters ?? null,
      createdAt,
      createdBy: input.createdBy,
    };
    this.db.transaction(() => {
      this.db
        .prepare(
          `INSERT INTO custom_script_versions
             (id, scriptId, content, markdownTemplate, parameters, createdAt, createdBy)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          version.id,
          version.scriptId,
          version.content,
          version.markdownTemplate,
          stringifyJson(version.parameters),
          version.createdAt,
          version.createdBy,
        );
      this.db
        .prepare("UPDATE custom_scripts SET currentVersionId = ?, updatedAt = ? WHERE id = ?")
        .run(version.id, createdAt, input.scriptId);
      this.writeAudit({
        action: "script.version.create",
        targetType: "customScriptVersion",
        targetId: version.id,
        before: { currentVersionId: script.currentVersionId },
        after: { scriptId: input.scriptId, currentVersionId: version.id },
        actor: input.actor,
        at: createdAt,
      });
    })();
    return version;
  }

  async getVersion(versionId: string): Promise<CustomScriptVersion | undefined> {
    const row = this.db
      .prepare("SELECT * FROM custom_script_versions WHERE id = ?")
      .get(versionId) as Row | undefined;
    return row ? this.mapVersion(row) : undefined;
  }

  async listVersions(scriptId: string): Promise<CustomScriptVersion[]> {
    return (
      this.db
        .prepare(
          "SELECT * FROM custom_script_versions WHERE scriptId = ? ORDER BY createdAt, id",
        )
        .all(scriptId) as Row[]
    ).map((row) => this.mapVersion(row));
  }
}

export async function openSqliteCustomScriptRepository(
  options: OpenSqliteRepositoryOptions,
): Promise<SqliteCustomScriptRepository> {
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
    return new SqliteCustomScriptRepository(db, applied);
  } catch (error) {
    db.close();
    throw error;
  }
}
