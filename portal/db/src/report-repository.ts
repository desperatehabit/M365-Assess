// Generated-report metadata (EPIC-005 SPEC.md §5). Rendered bytes live on the
// artifact tier; the database holds only `artifactRef` (SPEC §11.5), so no
// method here accepts or returns file content. Every read is tenant-scoped and
// soft delete is enforced here, not left to callers (03-database.md §5).
import { randomUUID } from "node:crypto";
import Database from "better-sqlite3";
import {
  SchemaVersionError,
  type AuditActorType,
  type AuditEvent,
  type AuditEventInput,
  type AuditSource,
  type ListOptions,
} from "./repository.js";
import {
  SCHEMA_VERSIONS_TABLE,
  SqliteRepository,
  loadMigrations,
  runMigrations,
  type OpenSqliteRepositoryOptions,
} from "./sqlite-repository.js";

type Row = Record<string, unknown>;

export const REPORT_STATUSES = ["queued", "rendering", "ready", "failed"] as const;

export type ReportStatus = (typeof REPORT_STATUSES)[number];

export function isReportStatus(value: unknown): value is ReportStatus {
  return typeof value === "string" && (REPORT_STATUSES as readonly string[]).includes(value);
}

export interface GeneratedReport {
  id: string;
  templateId: string | null;
  tenantId: string;
  status: ReportStatus;
  artifactRef: string | null;
  createdBy: string;
  scheduleId: string | null;
  createdAt: string;
  updatedAt: string;
  deletedAt: string | null;
}

export type GeneratedReportInput = Omit<GeneratedReport, "createdAt" | "updatedAt" | "deletedAt"> &
  Partial<Pick<GeneratedReport, "createdAt" | "updatedAt" | "deletedAt">>;

/** The slice of the base repository this module needs to write its audit trail. */
export interface AuditEventSink {
  appendAuditEvent(input: AuditEventInput): Promise<AuditEvent>;
}

export interface ReportRepository {
  readonly schemaVersion: number;

  close(): void;

  createGeneratedReport(input: GeneratedReportInput): Promise<GeneratedReport>;
  getGeneratedReport(
    tenantId: string,
    reportId: string,
    options?: ListOptions,
  ): Promise<GeneratedReport | undefined>;
  listGeneratedReports(tenantId: string, options?: ListOptions): Promise<GeneratedReport[]>;
  updateGeneratedReportStatus(
    tenantId: string,
    reportId: string,
    status: ReportStatus,
    options?: { now?: string },
  ): Promise<GeneratedReport | undefined>;
  softDeleteGeneratedReport(
    tenantId: string,
    reportId: string,
    options?: { now?: string },
  ): Promise<boolean>;
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

function mapGeneratedReport(row: Row): GeneratedReport {
  return {
    id: asString(row["id"]),
    templateId: asNullableString(row["templateId"]),
    tenantId: asString(row["tenantId"]),
    status: asString(row["status"]) as ReportStatus,
    artifactRef: asNullableString(row["artifactRef"]),
    createdBy: asString(row["createdBy"]),
    scheduleId: asNullableString(row["scheduleId"]),
    createdAt: asString(row["createdAt"]),
    updatedAt: asString(row["updatedAt"]),
    deletedAt: asNullableString(row["deletedAt"]),
  };
}

export class SqliteReportRepository implements ReportRepository {
  readonly schemaVersion: number;

  constructor(
    private readonly db: Database.Database,
    schemaVersion: number,
    private readonly audit: AuditEventSink,
  ) {
    this.schemaVersion = schemaVersion;
  }

  close(): void {
    this.db.close();
  }

  private async recordAudit(params: {
    action: string;
    report: GeneratedReport;
    actorUserId: string;
    actorType: AuditActorType;
    source: AuditSource;
    before: Record<string, unknown> | null;
    after: Record<string, unknown> | null;
    timestamp: string;
  }): Promise<void> {
    await this.audit.appendAuditEvent({
      id: randomUUID(),
      timestamp: params.timestamp,
      actorUserId: params.actorUserId,
      actorType: params.actorType,
      tenantId: params.report.tenantId,
      action: params.action,
      targetType: "generatedReport",
      targetId: params.report.id,
      before: params.before,
      after: params.after,
      result: "success",
      error: null,
      source: params.source,
      correlationId: null,
    });
  }

  async createGeneratedReport(input: GeneratedReportInput): Promise<GeneratedReport> {
    const createdAt = input.createdAt ?? nowIso();
    const updatedAt = input.updatedAt ?? createdAt;
    this.db
      .prepare(
        `INSERT INTO generated_reports
           (id, templateId, tenantId, status, artifactRef, createdBy, scheduleId, createdAt, updatedAt, deletedAt)
         VALUES
           (@id, @templateId, @tenantId, @status, @artifactRef, @createdBy, @scheduleId, @createdAt, @updatedAt, @deletedAt)`,
      )
      .run({
        id: input.id,
        templateId: input.templateId ?? null,
        tenantId: input.tenantId,
        status: input.status,
        artifactRef: input.artifactRef ?? null,
        createdBy: input.createdBy,
        scheduleId: input.scheduleId ?? null,
        createdAt,
        updatedAt,
        deletedAt: input.deletedAt ?? null,
      });
    const report = await this.getGeneratedReport(input.tenantId, input.id, {
      includeDeleted: true,
    });
    if (!report) throw new Error(`generated report ${input.id} was not persisted`);
    await this.recordAudit({
      action: "report.generate",
      report,
      actorUserId: input.createdBy,
      actorType: "user",
      source: input.scheduleId ? "schedule" : "request",
      before: null,
      after: {
        status: report.status,
        artifactRef: report.artifactRef,
        templateId: report.templateId,
        scheduleId: report.scheduleId,
      },
      timestamp: createdAt,
    });
    return report;
  }

  async getGeneratedReport(
    tenantId: string,
    reportId: string,
    options: ListOptions = {},
  ): Promise<GeneratedReport | undefined> {
    const sql = options.includeDeleted
      ? "SELECT * FROM generated_reports WHERE id = ? AND tenantId = ?"
      : "SELECT * FROM generated_reports WHERE id = ? AND tenantId = ? AND deletedAt IS NULL";
    const row = this.db.prepare(sql).get(reportId, tenantId) as Row | undefined;
    return row ? mapGeneratedReport(row) : undefined;
  }

  async listGeneratedReports(
    tenantId: string,
    options: ListOptions = {},
  ): Promise<GeneratedReport[]> {
    const sql = options.includeDeleted
      ? "SELECT * FROM generated_reports WHERE tenantId = ? ORDER BY createdAt"
      : "SELECT * FROM generated_reports WHERE tenantId = ? AND deletedAt IS NULL ORDER BY createdAt";
    return (this.db.prepare(sql).all(tenantId) as Row[]).map((row) => mapGeneratedReport(row));
  }

  async updateGeneratedReportStatus(
    tenantId: string,
    reportId: string,
    status: ReportStatus,
    options: { now?: string } = {},
  ): Promise<GeneratedReport | undefined> {
    const existing = await this.getGeneratedReport(tenantId, reportId);
    if (!existing) return undefined;
    if (existing.status === status) return existing;
    const at = options.now ?? nowIso();
    const result = this.db
      .prepare(
        "UPDATE generated_reports SET status = ?, updatedAt = ? WHERE id = ? AND tenantId = ? AND deletedAt IS NULL",
      )
      .run(status, at, reportId, tenantId);
    if (result.changes === 0) return undefined;
    const updated = await this.getGeneratedReport(tenantId, reportId);
    if (!updated) throw new Error(`generated report ${reportId} was not updated`);
    await this.recordAudit({
      action: "report.status",
      report: updated,
      actorUserId: updated.createdBy,
      actorType: "user",
      source: updated.scheduleId ? "schedule" : "request",
      before: { status: existing.status },
      after: { status: updated.status },
      timestamp: at,
    });
    return updated;
  }

  async softDeleteGeneratedReport(
    tenantId: string,
    reportId: string,
    options: { now?: string } = {},
  ): Promise<boolean> {
    const at = options.now ?? nowIso();
    const result = this.db
      .prepare(
        "UPDATE generated_reports SET deletedAt = ?, updatedAt = ? WHERE id = ? AND tenantId = ? AND deletedAt IS NULL",
      )
      .run(at, at, reportId, tenantId);
    return result.changes > 0;
  }
}

export async function openSqliteReportRepository(
  options: OpenSqliteRepositoryOptions,
): Promise<SqliteReportRepository> {
  const migrations = options.migrations ?? loadMigrations(options.migrationsDir);
  const target = migrations.reduce((max, migration) => Math.max(max, migration.version), 0);
  const db = new Database(options.filename);
  try {
    const journalMode = String(db.pragma("journal_mode = WAL", { simple: true }) ?? "memory");
    db.pragma("foreign_keys = ON");
    db.exec(SCHEMA_VERSIONS_TABLE);
    const row = db
      .prepare("SELECT MAX(version) AS version FROM schema_versions")
      .get() as { version: number | null } | undefined;
    const existing =
      row?.version === null || row?.version === undefined ? 0 : Number(row.version);
    if (existing > target) {
      throw new SchemaVersionError(existing, target);
    }
    const applied = runMigrations(db, migrations);
    if (applied !== target) {
      throw new SchemaVersionError(applied, target);
    }
    return new SqliteReportRepository(db, applied, new SqliteRepository(db, applied, journalMode));
  } catch (error) {
    db.close();
    throw error;
  }
}
