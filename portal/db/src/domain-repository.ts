// Domain DNS analysis history (EPIC-034 SPEC.md §5) on top of the shared
// repository contract. DomainCheck is the append-only per-domain analysis
// row (id/tenantId/domain/at/records/health/recommendations): scheduled
// analyser runs (SPEC §3.4/§4.3) append one row per verified domain and
// change detection diffs consecutive rows, so only append/get/list are
// exposed, every append writes an AuditEvent in the same transaction, and
// the migration adds no-update and no-delete triggers so the invariant does
// not depend on callers (ADR-0015). Tenant scoping is enforced here, not
// left to callers. Domain add/remove audit events flow through the existing
// audit_events table via the shared append path. No DNS resolution and no
// Graph calls belong here.
import Database from "better-sqlite3";
import { randomUUID } from "node:crypto";
import {
  SchemaVersionError,
  type AuditEventInput,
  type DomainCheck,
  type DomainCheckInput,
  type DomainCheckRangeOptions,
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

function parseJsonObject(value: unknown): Record<string, unknown> {
  if (value === null || value === undefined) return {};
  try {
    const parsed: unknown = JSON.parse(String(value));
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

function parseJsonArray(value: unknown): string[] {
  if (value === null || value === undefined) return [];
  try {
    const parsed: unknown = JSON.parse(String(value));
    return Array.isArray(parsed) ? parsed.map((item) => String(item)) : [];
  } catch {
    return [];
  }
}

export interface DomainCheckChangePair {
  prior: DomainCheck | null;
  current: DomainCheck | null;
}

export interface DomainRepository {
  readonly schemaVersion: number;

  close(): void;

  appendDomainCheck(input: DomainCheckInput): Promise<DomainCheck>;
  getDomainCheck(tenantId: string, checkId: string): Promise<DomainCheck | undefined>;
  listDomainHistory(tenantId: string, domain: string): Promise<DomainCheck[]>;
  listLatestDomainChecks(tenantId: string): Promise<DomainCheck[]>;
  listDomainChecksInRange(
    tenantId: string,
    domain: string,
    options?: DomainCheckRangeOptions,
  ): Promise<DomainCheck[]>;
  getDomainCheckChangePair(
    tenantId: string,
    domain: string,
    at: string,
  ): Promise<DomainCheckChangePair>;
}

function snapshot(value: unknown): Record<string, unknown> | null {
  return value === null || value === undefined
    ? null
    : (JSON.parse(JSON.stringify(value)) as Record<string, unknown>);
}

export class SqliteDomainRepository implements DomainRepository {
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

  private mapDomainCheck(row: Row): DomainCheck {
    return {
      id: asString(row["id"]),
      tenantId: asString(row["tenantId"]),
      domain: asString(row["domain"]),
      at: asString(row["at"]),
      records: parseJsonObject(row["records"]),
      health: parseJsonObject(row["health"]),
      recommendations: parseJsonArray(row["recommendations"]),
    };
  }

  private writeAuditEvent(
    action: string,
    targetType: string,
    targetId: string,
    tenantId: string,
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

  async appendDomainCheck(input: DomainCheckInput): Promise<DomainCheck> {
    const check: DomainCheck = {
      id: input.id,
      tenantId: input.tenantId,
      domain: input.domain,
      at: input.at ?? nowIso(),
      records: input.records ?? {},
      health: input.health ?? {},
      recommendations: input.recommendations ?? [],
    };
    this.db.transaction(() => {
      this.db
        .prepare(
          `INSERT INTO domain_checks
             (id, tenantId, domain, "at", records, health, recommendations)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          check.id,
          check.tenantId,
          check.domain,
          check.at,
          JSON.stringify(check.records),
          JSON.stringify(check.health),
          JSON.stringify(check.recommendations),
        );
      this.writeAuditEvent(
        "domain.check.append",
        "domain_check",
        check.id,
        check.tenantId,
        null,
        check,
      );
    })();
    const persisted = await this.getDomainCheck(check.tenantId, check.id);
    if (!persisted) throw new Error(`domain check ${check.id} was not persisted`);
    return persisted;
  }

  async getDomainCheck(tenantId: string, checkId: string): Promise<DomainCheck | undefined> {
    const row = this.db
      .prepare("SELECT * FROM domain_checks WHERE id = ? AND tenantId = ?")
      .get(checkId, tenantId) as Row | undefined;
    return row ? this.mapDomainCheck(row) : undefined;
  }

  async listDomainHistory(tenantId: string, domain: string): Promise<DomainCheck[]> {
    return (
      this.db
        .prepare(
          'SELECT * FROM domain_checks WHERE tenantId = ? AND domain = ? ORDER BY "at", id',
        )
        .all(tenantId, domain) as Row[]
    ).map((row) => this.mapDomainCheck(row));
  }

  async listLatestDomainChecks(tenantId: string): Promise<DomainCheck[]> {
    return (
      this.db
        .prepare(
          `SELECT c.* FROM domain_checks c
           WHERE c.tenantId = ?
             AND NOT EXISTS (
               SELECT 1 FROM domain_checks newer
               WHERE newer.tenantId = c.tenantId
                 AND newer.domain = c.domain
                 AND (newer."at" > c."at" OR (newer."at" = c."at" AND newer.id > c.id))
             )
           ORDER BY c.domain`,
        )
        .all(tenantId) as Row[]
    ).map((row) => this.mapDomainCheck(row));
  }

  async listDomainChecksInRange(
    tenantId: string,
    domain: string,
    options: DomainCheckRangeOptions = {},
  ): Promise<DomainCheck[]> {
    const where: string[] = ["tenantId = ?", "domain = ?"];
    const params: unknown[] = [tenantId, domain];
    if (options.from !== undefined) {
      where.push('"at" >= ?');
      params.push(options.from);
    }
    if (options.to !== undefined) {
      where.push('"at" <= ?');
      params.push(options.to);
    }
    return (
      this.db
        .prepare(`SELECT * FROM domain_checks WHERE ${where.join(" AND ")} ORDER BY "at", id`)
        .all(...params) as Row[]
    ).map((row) => this.mapDomainCheck(row));
  }

  async getDomainCheckChangePair(
    tenantId: string,
    domain: string,
    at: string,
  ): Promise<DomainCheckChangePair> {
    const currentRow = this.db
      .prepare(
        `SELECT * FROM domain_checks
         WHERE tenantId = ? AND domain = ? AND "at" <= ?
         ORDER BY "at" DESC, id DESC LIMIT 1`,
      )
      .get(tenantId, domain, at) as Row | undefined;
    const current = currentRow ? this.mapDomainCheck(currentRow) : null;
    if (!current) return { prior: null, current: null };
    const priorRow = this.db
      .prepare(
        `SELECT * FROM domain_checks
         WHERE tenantId = ? AND domain = ?
           AND ("at" < ? OR ("at" = ? AND id < ?))
         ORDER BY "at" DESC, id DESC LIMIT 1`,
      )
      .get(tenantId, domain, current.at, current.at, current.id) as Row | undefined;
    return { prior: priorRow ? this.mapDomainCheck(priorRow) : null, current };
  }
}

export async function openSqliteDomainRepository(
  options: OpenSqliteRepositoryOptions,
): Promise<SqliteDomainRepository> {
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
    return new SqliteDomainRepository(db, applied);
  } catch (error) {
    db.close();
    throw error;
  }
}
