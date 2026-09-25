// The only file that names the storage engine (ADR-0015). All SQL lives here
// or in numbered migrations; no SQL string escapes this directory.
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import {
  SchemaVersionError,
  type AuditEvent,
  type AuditEventInput,
  type AuditResult,
  type AuditActorType,
  type AuditSource,
  type Finding,
  type FindingInput,
  type FindingStatus,
  type Job,
  type JobInput,
  type JobState,
  type JobStateUpdate,
  type ListOptions,
  type RemediationMode,
  type Repository,
  type Run,
  type RunInput,
  type RunSection,
  type RunSectionInput,
  type RunStatus,
  type RunTrigger,
  type Severity,
  type Tenant,
  type TenantCredential,
  type TenantCredentialInput,
  type TenantInput,
  type TenantSource,
  type TenantStatus,
} from "./repository.js";

type Row = Record<string, unknown>;

export interface Migration {
  version: number;
  name: string;
  sql: string;
}

export interface OpenSqliteRepositoryOptions {
  filename: string;
  migrations?: Migration[];
  migrationsDir?: string;
}

export const SCHEMA_VERSIONS_TABLE =
  "CREATE TABLE IF NOT EXISTS schema_versions (version INTEGER PRIMARY KEY, appliedAt TEXT NOT NULL)";

const DEFAULT_MIGRATIONS_DIR = fileURLToPath(new URL("../migrations/", import.meta.url));

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
    return typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
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

function stringifyJson(value: unknown): string | null {
  return value === null || value === undefined ? null : JSON.stringify(value);
}

export function loadMigrations(dir: string = DEFAULT_MIGRATIONS_DIR): Migration[] {
  const migrations: Migration[] = [];
  for (const name of readdirSync(dir)) {
    if (!name.endsWith(".sql")) continue;
    const version = Number.parseInt(/^(\d+)/.exec(name)?.[1] ?? "", 10);
    if (Number.isNaN(version)) {
      throw new Error(`migration filename must start with a number: ${name}`);
    }
    migrations.push({ version, name, sql: readFileSync(join(dir, name), "utf8") });
  }
  migrations.sort((a, b) => a.version - b.version);
  return migrations;
}

function readSchemaVersion(db: Database.Database): number {
  const row = db
    .prepare("SELECT MAX(version) AS version FROM schema_versions")
    .get() as { version: number | null } | undefined;
  return row?.version === null || row?.version === undefined ? 0 : asNumber(row.version);
}

/**
 * Applies pending migrations in one transaction each and returns the resulting
 * schema version. Already-applied versions are skipped, so it is re-runnable.
 */
export function runMigrations(db: Database.Database, migrations: Migration[]): number {
  db.exec(SCHEMA_VERSIONS_TABLE);
  const applied = new Set<number>(
    (db.prepare("SELECT version FROM schema_versions").all() as Array<{ version: number }>).map(
      (row) => asNumber(row.version),
    ),
  );
  for (const migration of migrations) {
    if (applied.has(migration.version)) continue;
    db.transaction(() => {
      db.exec(migration.sql);
      db.prepare("INSERT OR REPLACE INTO schema_versions (version, appliedAt) VALUES (?, ?)").run(
        migration.version,
        nowIso(),
      );
    })();
  }
  return readSchemaVersion(db);
}

export class SqliteRepository implements Repository {
  readonly schemaVersion: number;
  readonly journalMode: string;

  constructor(
    private readonly db: Database.Database,
    schemaVersion: number,
    journalMode: string,
  ) {
    this.schemaVersion = schemaVersion;
    this.journalMode = journalMode;
  }

  close(): void {
    this.db.close();
  }

  private mapTenant(row: Row): Tenant {
    return {
      id: asString(row["id"]),
      displayName: asNullableString(row["displayName"]),
      defaultDomain: asNullableString(row["defaultDomain"]),
      initialDomain: asNullableString(row["initialDomain"]),
      source: asString(row["source"]) as TenantSource,
      status: asString(row["status"]) as TenantStatus,
      excluded: asBool(row["excluded"]),
      lastRunAt: asNullableString(row["lastRunAt"]),
      errorCount: asNumber(row["errorCount"]),
      createdAt: asString(row["createdAt"]),
      updatedAt: asString(row["updatedAt"]),
      deletedAt: asNullableString(row["deletedAt"]),
    };
  }

  private mapCredential(row: Row): TenantCredential {
    return {
      id: asString(row["id"]),
      tenantId: asString(row["tenantId"]),
      authMethod: asString(row["authMethod"]),
      clientId: asString(row["clientId"]),
      secretRef: asString(row["secretRef"]),
      thumbprint: asNullableString(row["thumbprint"]),
      environment: asString(row["environment"]),
      expiresOn: asNullableString(row["expiresOn"]),
      lastValidated: asNullableString(row["lastValidated"]),
      createdAt: asString(row["createdAt"]),
      updatedAt: asString(row["updatedAt"]),
    };
  }

  private mapRun(row: Row): Run {
    return {
      id: asString(row["id"]),
      tenantId: asString(row["tenantId"]),
      trigger: asString(row["trigger"]) as RunTrigger,
      sections: parseJsonArray(row["sections"]),
      startedAt: asNullableString(row["startedAt"]),
      finishedAt: asNullableString(row["finishedAt"]),
      status: asString(row["status"]) as RunStatus,
      artifactPath: asNullableString(row["artifactPath"]),
      summaryCounts: parseJson(row["summaryCounts"]),
      provenance: parseJson(row["provenance"]),
      createdAt: asString(row["createdAt"]),
      updatedAt: asString(row["updatedAt"]),
    };
  }

  private mapRunSection(row: Row): RunSection {
    return {
      id: asString(row["id"]),
      runId: asString(row["runId"]),
      tenantId: asString(row["tenantId"]),
      section: asString(row["section"]),
      collector: asNullableString(row["collector"]),
      status: asString(row["status"]),
      startedAt: asNullableString(row["startedAt"]),
      finishedAt: asNullableString(row["finishedAt"]),
      createdAt: asString(row["createdAt"]),
      updatedAt: asString(row["updatedAt"]),
    };
  }

  private mapFinding(row: Row): Finding {
    return {
      id: asString(row["id"]),
      runId: asString(row["runId"]),
      tenantId: asString(row["tenantId"]),
      checkId: asString(row["checkId"]),
      controlName: asNullableString(row["controlName"]),
      category: asNullableString(row["category"]),
      collector: asNullableString(row["collector"]),
      status: asString(row["status"]) as FindingStatus,
      severity: asNullableString(row["severity"]) as Severity | null,
      currentValue: asNullableString(row["currentValue"]),
      recommendedValue: asNullableString(row["recommendedValue"]),
      evidence: parseJson(row["evidence"]),
      frameworkRefs: parseJsonArray(row["frameworkRefs"]),
      remediationMode: asNullableString(row["remediationMode"]) as RemediationMode | null,
      createdAt: asString(row["createdAt"]),
      updatedAt: asString(row["updatedAt"]),
    };
  }

  private mapJob(row: Row): Job {
    return {
      id: asString(row["id"]),
      type: asString(row["type"]),
      tenantId: asNullableString(row["tenantId"]),
      payload: parseJson(row["payload"]),
      state: asString(row["state"]) as JobState,
      attempts: asNumber(row["attempts"]),
      progress: parseJson(row["progress"]),
      createdAt: asString(row["createdAt"]),
      updatedAt: asString(row["updatedAt"]),
    };
  }

  private mapAuditEvent(row: Row): AuditEvent {
    return {
      id: asString(row["id"]),
      timestamp: asString(row["timestamp"]),
      actorUserId: asNullableString(row["actorUserId"]),
      actorType: asString(row["actorType"]) as AuditActorType,
      tenantId: asNullableString(row["tenantId"]),
      action: asString(row["action"]),
      targetType: asNullableString(row["targetType"]),
      targetId: asNullableString(row["targetId"]),
      before: parseJson(row["before"]),
      after: parseJson(row["after"]),
      result: asString(row["result"]) as AuditResult,
      error: asNullableString(row["error"]),
      source: asString(row["source"]) as AuditSource,
      correlationId: asNullableString(row["correlationId"]),
      createdAt: asString(row["createdAt"]),
    };
  }

  async getTenant(tenantId: string, options: ListOptions = {}): Promise<Tenant | undefined> {
    const sql = options.includeDeleted
      ? "SELECT * FROM tenants WHERE id = ?"
      : "SELECT * FROM tenants WHERE id = ? AND deletedAt IS NULL";
    const row = this.db.prepare(sql).get(tenantId) as Row | undefined;
    return row ? this.mapTenant(row) : undefined;
  }

  async listTenants(options: ListOptions = {}): Promise<Tenant[]> {
    const sql = options.includeDeleted
      ? "SELECT * FROM tenants ORDER BY createdAt"
      : "SELECT * FROM tenants WHERE deletedAt IS NULL ORDER BY createdAt";
    return (this.db.prepare(sql).all() as Row[]).map((row) => this.mapTenant(row));
  }

  async upsertTenant(input: TenantInput): Promise<Tenant> {
    const createdAt = input.createdAt ?? nowIso();
    const updatedAt = input.updatedAt ?? nowIso();
    this.db
      .prepare(
        `INSERT INTO tenants
           (id, displayName, defaultDomain, initialDomain, source, status, excluded, lastRunAt, errorCount, createdAt, updatedAt, deletedAt)
         VALUES
           (@id, @displayName, @defaultDomain, @initialDomain, @source, @status, @excludedFlag, @lastRunAt, @errorCount, @createdAt, @updatedAt, @deletedAt)
         ON CONFLICT(id) DO UPDATE SET
           displayName = excluded.displayName,
           defaultDomain = excluded.defaultDomain,
           initialDomain = excluded.initialDomain,
           source = excluded.source,
           status = excluded.status,
           excluded = excluded.excluded,
           lastRunAt = excluded.lastRunAt,
           errorCount = excluded.errorCount,
           updatedAt = excluded.updatedAt,
           deletedAt = excluded.deletedAt`,
      )
      .run({
        id: input.id,
        displayName: input.displayName ?? null,
        defaultDomain: input.defaultDomain ?? null,
        initialDomain: input.initialDomain ?? null,
        source: input.source,
        status: input.status,
        excludedFlag: input.excluded ? 1 : 0,
        lastRunAt: input.lastRunAt ?? null,
        errorCount: input.errorCount,
        createdAt,
        updatedAt,
        deletedAt: input.deletedAt ?? null,
      });
    const tenant = await this.getTenant(input.id, { includeDeleted: true });
    if (!tenant) throw new Error(`tenant ${input.id} was not persisted`);
    return tenant;
  }

  async softDeleteTenant(tenantId: string, options: { now?: string } = {}): Promise<boolean> {
    const at = options.now ?? nowIso();
    const result = this.db
      .prepare("UPDATE tenants SET deletedAt = ?, updatedAt = ? WHERE id = ? AND deletedAt IS NULL")
      .run(at, at, tenantId);
    return result.changes > 0;
  }

  private credentialById(id: string): TenantCredential | undefined {
    const row = this.db
      .prepare("SELECT * FROM tenant_credentials WHERE id = ?")
      .get(id) as Row | undefined;
    return row ? this.mapCredential(row) : undefined;
  }

  async getTenantCredential(tenantId: string): Promise<TenantCredential | undefined> {
    const row = this.db
      .prepare("SELECT * FROM tenant_credentials WHERE tenantId = ? ORDER BY createdAt LIMIT 1")
      .get(tenantId) as Row | undefined;
    return row ? this.mapCredential(row) : undefined;
  }

  async listTenantCredentials(tenantId: string): Promise<TenantCredential[]> {
    return (
      this.db
        .prepare("SELECT * FROM tenant_credentials WHERE tenantId = ? ORDER BY createdAt")
        .all(tenantId) as Row[]
    ).map((row) => this.mapCredential(row));
  }

  async upsertTenantCredential(input: TenantCredentialInput): Promise<TenantCredential> {
    const createdAt = input.createdAt ?? nowIso();
    const updatedAt = input.updatedAt ?? nowIso();
    this.db
      .prepare(
        `INSERT INTO tenant_credentials
           (id, tenantId, authMethod, clientId, secretRef, thumbprint, environment, expiresOn, lastValidated, createdAt, updatedAt)
         VALUES
           (@id, @tenantId, @authMethod, @clientId, @secretRef, @thumbprint, @environment, @expiresOn, @lastValidated, @createdAt, @updatedAt)
         ON CONFLICT(id) DO UPDATE SET
           tenantId = excluded.tenantId,
           authMethod = excluded.authMethod,
           clientId = excluded.clientId,
           secretRef = excluded.secretRef,
           thumbprint = excluded.thumbprint,
           environment = excluded.environment,
           expiresOn = excluded.expiresOn,
           lastValidated = excluded.lastValidated,
           updatedAt = excluded.updatedAt`,
      )
      .run({
        id: input.id,
        tenantId: input.tenantId,
        authMethod: input.authMethod,
        clientId: input.clientId,
        secretRef: input.secretRef,
        thumbprint: input.thumbprint ?? null,
        environment: input.environment,
        expiresOn: input.expiresOn ?? null,
        lastValidated: input.lastValidated ?? null,
        createdAt,
        updatedAt,
      });
    const credential = this.credentialById(input.id);
    if (!credential) throw new Error(`credential ${input.id} was not persisted`);
    return credential;
  }

  async createRun(input: RunInput): Promise<Run> {
    const createdAt = input.createdAt ?? nowIso();
    const updatedAt = input.updatedAt ?? nowIso();
    this.db
      .prepare(
        `INSERT INTO runs
           (id, tenantId, trigger, sections, startedAt, finishedAt, status, artifactPath, summaryCounts, provenance, createdAt, updatedAt)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.id,
        input.tenantId,
        input.trigger,
        JSON.stringify(input.sections ?? []),
        input.startedAt ?? null,
        input.finishedAt ?? null,
        input.status,
        input.artifactPath ?? null,
        stringifyJson(input.summaryCounts),
        stringifyJson(input.provenance),
        createdAt,
        updatedAt,
      );
    const run = await this.getRun(input.tenantId, input.id);
    if (!run) throw new Error(`run ${input.id} was not persisted`);
    return run;
  }

  async getRun(tenantId: string, runId: string): Promise<Run | undefined> {
    const row = this.db
      .prepare("SELECT * FROM runs WHERE id = ? AND tenantId = ?")
      .get(runId, tenantId) as Row | undefined;
    return row ? this.mapRun(row) : undefined;
  }

  async listRuns(tenantId: string): Promise<Run[]> {
    return (
      this.db
        .prepare("SELECT * FROM runs WHERE tenantId = ? ORDER BY createdAt")
        .all(tenantId) as Row[]
    ).map((row) => this.mapRun(row));
  }

  async createRunSection(input: RunSectionInput): Promise<RunSection> {
    const createdAt = input.createdAt ?? nowIso();
    const updatedAt = input.updatedAt ?? nowIso();
    this.db
      .prepare(
        `INSERT INTO run_sections
           (id, runId, tenantId, section, collector, status, startedAt, finishedAt, createdAt, updatedAt)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.id,
        input.runId,
        input.tenantId,
        input.section,
        input.collector ?? null,
        input.status,
        input.startedAt ?? null,
        input.finishedAt ?? null,
        createdAt,
        updatedAt,
      );
    const sections = await this.listRunSections(input.tenantId, input.runId);
    const section = sections.find((candidate) => candidate.id === input.id);
    if (!section) throw new Error(`run section ${input.id} was not persisted`);
    return section;
  }

  async listRunSections(tenantId: string, runId: string): Promise<RunSection[]> {
    return (
      this.db
        .prepare("SELECT * FROM run_sections WHERE tenantId = ? AND runId = ? ORDER BY createdAt")
        .all(tenantId, runId) as Row[]
    ).map((row) => this.mapRunSection(row));
  }

  async createFinding(input: FindingInput): Promise<Finding> {
    const createdAt = input.createdAt ?? nowIso();
    const updatedAt = input.updatedAt ?? nowIso();
    this.db
      .prepare(
        `INSERT INTO findings
           (id, runId, tenantId, checkId, controlName, category, collector, status, severity, currentValue, recommendedValue, evidence, frameworkRefs, remediationMode, createdAt, updatedAt)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.id,
        input.runId,
        input.tenantId,
        input.checkId,
        input.controlName ?? null,
        input.category ?? null,
        input.collector ?? null,
        input.status,
        input.severity ?? null,
        input.currentValue ?? null,
        input.recommendedValue ?? null,
        stringifyJson(input.evidence),
        JSON.stringify(input.frameworkRefs ?? []),
        input.remediationMode ?? null,
        createdAt,
        updatedAt,
      );
    const findings = await this.listFindings(input.tenantId, input.runId);
    const finding = findings.find((candidate) => candidate.id === input.id);
    if (!finding) throw new Error(`finding ${input.id} was not persisted`);
    return finding;
  }

  async listFindings(tenantId: string, runId: string): Promise<Finding[]> {
    return (
      this.db
        .prepare("SELECT * FROM findings WHERE tenantId = ? AND runId = ? ORDER BY createdAt")
        .all(tenantId, runId) as Row[]
    ).map((row) => this.mapFinding(row));
  }

  async createJob(input: JobInput): Promise<Job> {
    const createdAt = input.createdAt ?? nowIso();
    const updatedAt = input.updatedAt ?? nowIso();
    this.db
      .prepare(
        `INSERT INTO jobs
           (id, type, tenantId, payload, state, attempts, progress, createdAt, updatedAt)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.id,
        input.type,
        input.tenantId ?? null,
        stringifyJson(input.payload),
        input.state,
        input.attempts,
        stringifyJson(input.progress),
        createdAt,
        updatedAt,
      );
    const job = await this.getJob(input.id);
    if (!job) throw new Error(`job ${input.id} was not persisted`);
    return job;
  }

  async getJob(jobId: string): Promise<Job | undefined> {
    const row = this.db.prepare("SELECT * FROM jobs WHERE id = ?").get(jobId) as Row | undefined;
    return row ? this.mapJob(row) : undefined;
  }

  async listJobs(tenantId: string): Promise<Job[]> {
    return (
      this.db
        .prepare("SELECT * FROM jobs WHERE tenantId = ? ORDER BY createdAt")
        .all(tenantId) as Row[]
    ).map((row) => this.mapJob(row));
  }

  async updateJobState(
    jobId: string,
    state: JobState,
    update: JobStateUpdate = {},
  ): Promise<Job | undefined> {
    const existing = await this.getJob(jobId);
    if (!existing) return undefined;
    const progress = update.progress === undefined ? existing.progress : update.progress;
    const attempts = update.attempts ?? existing.attempts;
    this.db
      .prepare("UPDATE jobs SET state = ?, progress = ?, attempts = ?, updatedAt = ? WHERE id = ?")
      .run(state, stringifyJson(progress), attempts, nowIso(), jobId);
    return this.getJob(jobId);
  }

  async appendAuditEvent(input: AuditEventInput): Promise<AuditEvent> {
    const createdAt = input.createdAt ?? nowIso();
    this.db
      .prepare(
        `INSERT INTO audit_events
           (id, timestamp, actorUserId, actorType, tenantId, action, targetType, targetId, before, after, result, error, source, correlationId, createdAt)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.id,
        input.timestamp,
        input.actorUserId ?? null,
        input.actorType,
        input.tenantId ?? null,
        input.action,
        input.targetType ?? null,
        input.targetId ?? null,
        stringifyJson(input.before),
        stringifyJson(input.after),
        input.result,
        input.error ?? null,
        input.source,
        input.correlationId ?? null,
        createdAt,
      );
    const events = await this.listAuditEvents(input.tenantId ?? undefined);
    const event = events.find((candidate) => candidate.id === input.id);
    if (!event) throw new Error(`audit event ${input.id} was not persisted`);
    return event;
  }

  async listAuditEvents(tenantId?: string): Promise<AuditEvent[]> {
    const sql =
      tenantId === undefined
        ? "SELECT * FROM audit_events ORDER BY timestamp, id"
        : "SELECT * FROM audit_events WHERE tenantId = ? ORDER BY timestamp, id";
    const rows = (tenantId === undefined
      ? this.db.prepare(sql).all()
      : this.db.prepare(sql).all(tenantId)) as Row[];
    return rows.map((row) => this.mapAuditEvent(row));
  }
}

export async function openSqliteRepository(
  options: OpenSqliteRepositoryOptions,
): Promise<SqliteRepository> {
  const migrations = options.migrations ?? loadMigrations(options.migrationsDir);
  const target = migrations.reduce((max, migration) => Math.max(max, migration.version), 0);
  const db = new Database(options.filename);
  try {
    const journalMode = String(db.pragma("journal_mode = WAL", { simple: true }) ?? "memory");
    db.pragma("foreign_keys = ON");
    db.exec(SCHEMA_VERSIONS_TABLE);
    const existing = readSchemaVersion(db);
    if (existing > target) {
      throw new SchemaVersionError(existing, target);
    }
    const applied = runMigrations(db, migrations);
    if (applied !== target) {
      throw new SchemaVersionError(applied, target);
    }
    return new SqliteRepository(db, applied, journalMode);
  } catch (error) {
    db.close();
    throw error;
  }
}
