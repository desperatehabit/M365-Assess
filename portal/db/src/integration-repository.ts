// Integration config store (EPIC-041 SPEC §5, §6, §9) on top of the shared
// repository contract (T-0009). One row per integration `kind`, keyed by kind
// (SPEC §6: GET/PUT /v1/integrations/{kind}). Secrets are stored by reference
// only: IntegrationConfigInput carries secretRef and no secret field, so a
// secret value cannot be persisted even by a caller that holds one, and the
// audit snapshot records the reference, never material. Every upsert appends
// an AuditEvent in the same transaction (ADR-0015). No route code and no
// vendor calls belong here.
import Database from "better-sqlite3";
import { randomUUID } from "node:crypto";
import {
  SchemaVersionError,
  type AuditEventInput,
  type IntegrationConfig,
  type IntegrationConfigInput,
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
    return typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

export interface IntegrationRepository {
  readonly schemaVersion: number;

  close(): void;

  getIntegrationConfig(kind: string): Promise<IntegrationConfig | undefined>;
  listIntegrationConfigs(): Promise<IntegrationConfig[]>;
  upsertIntegrationConfig(input: IntegrationConfigInput): Promise<IntegrationConfig>;
}

function snapshot(value: unknown): Record<string, unknown> | null {
  return value === null || value === undefined
    ? null
    : (JSON.parse(JSON.stringify(value)) as Record<string, unknown>);
}

export class SqliteIntegrationRepository implements IntegrationRepository {
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

  private mapConfig(row: Row): IntegrationConfig {
    return {
      id: asString(row["id"]),
      kind: asString(row["kind"]),
      enabled: asBool(row["enabled"]),
      secretRef: asString(row["secretRef"]),
      mapping: parseJson(row["mapping"]) ?? {},
      createdAt: asString(row["createdAt"]),
      updatedAt: asString(row["updatedAt"]),
    };
  }

  private writeAuditEvent(
    action: string,
    targetType: string,
    targetId: string,
    tenantId: string | null,
    before: unknown,
    after: unknown,
  ): void {
    const input: AuditEventInput = {
      id: randomUUID(),
      timestamp: nowIso(),
      actorUserId: null,
      actorType: "system",
      tenantId,
      action,
      targetType,
      targetId,
      before: snapshot(before),
      after: snapshot(after),
      result: "success",
      error: null,
      source: "request",
      correlationId: null,
    };
    this.db
      .prepare(
        `INSERT INTO audit_events
           (id, timestamp, actorUserId, actorType, tenantId, action, targetType, targetId, before, after, result, error, source, correlationId, createdAt)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.id,
        input.timestamp,
        input.actorUserId,
        input.actorType,
        input.tenantId,
        input.action,
        input.targetType,
        input.targetId,
        input.before === null ? null : JSON.stringify(input.before),
        input.after === null ? null : JSON.stringify(input.after),
        input.result,
        input.error,
        input.source,
        input.correlationId,
        input.timestamp,
      );
  }

  async getIntegrationConfig(kind: string): Promise<IntegrationConfig | undefined> {
    const row = this.db
      .prepare("SELECT * FROM integration_configs WHERE kind = ?")
      .get(kind) as Row | undefined;
    return row ? this.mapConfig(row) : undefined;
  }

  async listIntegrationConfigs(): Promise<IntegrationConfig[]> {
    return (
      this.db.prepare("SELECT * FROM integration_configs ORDER BY kind").all() as Row[]
    ).map((row) => this.mapConfig(row));
  }

  async upsertIntegrationConfig(input: IntegrationConfigInput): Promise<IntegrationConfig> {
    const createdAt = input.createdAt ?? nowIso();
    const updatedAt = input.updatedAt ?? nowIso();
    this.db.transaction(() => {
      const before = this.db
        .prepare("SELECT * FROM integration_configs WHERE kind = ?")
        .get(input.kind) as Row | undefined;
      const id = before === undefined ? (input.id ?? randomUUID()) : asString(before["id"]);
      const config: IntegrationConfig = {
        id,
        kind: input.kind,
        enabled: input.enabled,
        secretRef: input.secretRef,
        mapping: input.mapping ?? {},
        createdAt,
        updatedAt,
      };
      const updated = this.db
        .prepare(
          `UPDATE integration_configs
              SET enabled = ?, secretRef = ?, mapping = ?, updatedAt = ?
            WHERE kind = ?`,
        )
        .run(
          config.enabled ? 1 : 0,
          config.secretRef,
          JSON.stringify(config.mapping),
          updatedAt,
          config.kind,
        );
      if (updated.changes === 0) {
        this.db
          .prepare(
            `INSERT INTO integration_configs (id, kind, enabled, secretRef, mapping, createdAt, updatedAt)
             VALUES (?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            config.id,
            config.kind,
            config.enabled ? 1 : 0,
            config.secretRef,
            JSON.stringify(config.mapping),
            createdAt,
            updatedAt,
          );
      }
      this.writeAuditEvent(
        "integration.config.upsert",
        "integration_config",
        config.kind,
        null,
        before === undefined ? null : this.mapConfig(before),
        config,
      );
    })();
    const persisted = await this.getIntegrationConfig(input.kind);
    if (!persisted) throw new Error(`integration config ${input.kind} was not persisted`);
    return persisted;
  }
}

export async function openSqliteIntegrationRepository(
  options: OpenSqliteRepositoryOptions,
): Promise<SqliteIntegrationRepository> {
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
    return new SqliteIntegrationRepository(db, applied);
  } catch (error) {
    db.close();
    throw error;
  }
}
