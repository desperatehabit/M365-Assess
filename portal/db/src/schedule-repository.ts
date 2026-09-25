// Schedule storage for operator-created tasks (EPIC-007 SPEC.md §4.1/§5). System
// timers are code-deployed, so this repository only serves user tasks; a row that
// carries isSystem = 1 is immutable here so the §9 "system-timer editability" risk
// is closed at the repository layer rather than in the UI alone.
//
// The Schedule shape mirrors the shared contract in portal/contracts/src/schedules.ts;
// that module is not an exported subpath of @m365-assess/contracts, so the shape is
// restated here instead of importing across the workspace boundary.
import Database from "better-sqlite3";
import { randomUUID } from "node:crypto";
import {
  SchemaVersionError,
  type AuditActorType,
  type AuditEventInput,
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

function asBool(value: unknown): boolean {
  return Number(value) === 1;
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

export const SCHEDULE_TYPES = [
  "assessment",
  "standards",
  "drift",
  "baseline",
  "backup",
  "custom-script",
  "report",
] as const;

export type ScheduleType = (typeof SCHEDULE_TYPES)[number];
export type ScheduleTargetType = "tenant" | "group" | "all";

// `id` is the tenant/group id and is absent for an `all` target.
export interface ScheduleTargetScope {
  type: ScheduleTargetType;
  id?: string;
}

export interface Schedule {
  id: string;
  name: string;
  type: ScheduleType;
  cron: string;
  timezone: string;
  targetScope: ScheduleTargetScope;
  command: string;
  parameters: Record<string, unknown>;
  enabled: boolean;
  isSystem: boolean;
  lastRunAt: string | null;
  nextRunAt: string | null;
  createdAt: string;
  updatedAt: string;
  deletedAt: string | null;
}

export type ScheduleInput = Omit<Schedule, "createdAt" | "updatedAt" | "deletedAt"> &
  Partial<Pick<Schedule, "createdAt" | "updatedAt" | "deletedAt">>;

// A mutation may not move a row between system and user, change its id, or
// rewrite its timestamps by hand — those are repository-owned.
export type SchedulePatch = Partial<
  Omit<Schedule, "id" | "isSystem" | "createdAt" | "updatedAt" | "deletedAt">
>;

export interface ScheduleAuditContext {
  actorUserId?: string | null;
  actorType?: AuditActorType;
  source?: AuditSource;
  correlationId?: string | null;
}

export interface ScheduleListOptions {
  includeDeleted?: boolean;
}

/** Raised when a caller tries to mutate a code-deployed system timer (SPEC §9). */
export class SystemScheduleError extends Error {
  readonly code = "schedule.system_immutable";

  constructor(scheduleId: string) {
    super(`schedule ${scheduleId} is a system timer and is read-only`);
    this.name = "SystemScheduleError";
  }
}

export interface ScheduleRepository {
  readonly schemaVersion: number;

  close(): void;

  listSchedules(options?: ScheduleListOptions): Promise<Schedule[]>;
  getSchedule(scheduleId: string, options?: ScheduleListOptions): Promise<Schedule | undefined>;
  createSchedule(input: ScheduleInput, audit?: ScheduleAuditContext): Promise<Schedule>;
  updateSchedule(
    scheduleId: string,
    patch: SchedulePatch,
    audit?: ScheduleAuditContext,
  ): Promise<Schedule | undefined>;
  softDeleteSchedule(
    scheduleId: string,
    options?: { now?: string; audit?: ScheduleAuditContext },
  ): Promise<boolean>;
}

function parseTargetScope(value: unknown): ScheduleTargetScope {
  const parsed = parseJson(value);
  if (parsed === null) return { type: "all" };
  const type = parsed["type"];
  if (type !== "tenant" && type !== "group" && type !== "all") {
    throw new Error(`scheduled task has an invalid targetScope type: ${String(type)}`);
  }
  const id = parsed["id"];
  return id === undefined || id === null ? { type } : { type, id: String(id) };
}

function auditSnapshot(value: Schedule | null): Record<string, unknown> | null {
  return value === null ? null : (JSON.parse(JSON.stringify(value)) as Record<string, unknown>);
}

export class SqliteScheduleRepository implements ScheduleRepository {
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

  private mapSchedule(row: Row): Schedule {
    return {
      id: asString(row["id"]),
      name: asString(row["name"]),
      type: asString(row["type"]) as ScheduleType,
      cron: asString(row["cron"]),
      timezone: asString(row["timezone"]),
      targetScope: parseTargetScope(row["targetScope"]),
      command: asString(row["command"]),
      parameters: parseJson(row["parameters"]) ?? {},
      enabled: asBool(row["enabled"]),
      isSystem: asBool(row["isSystem"]),
      lastRunAt: asNullableString(row["lastRunAt"]),
      nextRunAt: asNullableString(row["nextRunAt"]),
      createdAt: asString(row["createdAt"]),
      updatedAt: asString(row["updatedAt"]),
      deletedAt: asNullableString(row["deletedAt"]),
    };
  }

  private scheduleRow(scheduleId: string, includeDeleted: boolean): Row | undefined {
    const sql = includeDeleted
      ? "SELECT * FROM scheduled_tasks WHERE id = ?"
      : "SELECT * FROM scheduled_tasks WHERE id = ? AND deletedAt IS NULL";
    return this.db.prepare(sql).get(scheduleId) as Row | undefined;
  }

  private scheduleById(scheduleId: string, includeDeleted: boolean): Schedule | undefined {
    const row = this.scheduleRow(scheduleId, includeDeleted);
    return row ? this.mapSchedule(row) : undefined;
  }

  private writeAuditEvent(
    action: string,
    targetId: string,
    audit: ScheduleAuditContext,
    before: Schedule | null,
    after: Schedule | null,
  ): void {
    const input: AuditEventInput = {
      id: randomUUID(),
      timestamp: nowIso(),
      actorUserId: audit.actorUserId ?? null,
      actorType: audit.actorType ?? "user",
      tenantId: null,
      action,
      targetType: "schedule",
      targetId,
      before: auditSnapshot(before),
      after: auditSnapshot(after),
      result: "success",
      error: null,
      source: audit.source ?? "request",
      correlationId: audit.correlationId ?? null,
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
        input.createdAt ?? input.timestamp,
      );
  }

  async listSchedules(options: ScheduleListOptions = {}): Promise<Schedule[]> {
    const sql = options.includeDeleted
      ? "SELECT * FROM scheduled_tasks ORDER BY createdAt, id"
      : "SELECT * FROM scheduled_tasks WHERE deletedAt IS NULL ORDER BY createdAt, id";
    return (this.db.prepare(sql).all() as Row[]).map((row) => this.mapSchedule(row));
  }

  async getSchedule(
    scheduleId: string,
    options: ScheduleListOptions = {},
  ): Promise<Schedule | undefined> {
    return this.scheduleById(scheduleId, options.includeDeleted ?? false);
  }

  async createSchedule(input: ScheduleInput, audit: ScheduleAuditContext = {}): Promise<Schedule> {
    const schedule: Schedule = {
      id: input.id,
      name: input.name,
      type: input.type,
      cron: input.cron,
      timezone: input.timezone,
      targetScope: input.targetScope,
      command: input.command,
      parameters: input.parameters,
      enabled: input.enabled,
      isSystem: input.isSystem,
      lastRunAt: input.lastRunAt,
      nextRunAt: input.nextRunAt,
      createdAt: input.createdAt ?? nowIso(),
      updatedAt: input.updatedAt ?? nowIso(),
      deletedAt: input.deletedAt ?? null,
    };
    this.db.transaction(() => {
      this.db
        .prepare(
          `INSERT INTO scheduled_tasks
             (id, name, type, cron, timezone, targetScope, command, parameters, enabled, isSystem, lastRunAt, nextRunAt, createdAt, updatedAt, deletedAt)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          schedule.id,
          schedule.name,
          schedule.type,
          schedule.cron,
          schedule.timezone,
          JSON.stringify(schedule.targetScope),
          schedule.command,
          JSON.stringify(schedule.parameters),
          schedule.enabled ? 1 : 0,
          schedule.isSystem ? 1 : 0,
          schedule.lastRunAt,
          schedule.nextRunAt,
          schedule.createdAt,
          schedule.updatedAt,
          schedule.deletedAt,
        );
      this.writeAuditEvent("schedule.create", schedule.id, audit, null, schedule);
    })();
    return schedule;
  }

  async updateSchedule(
    scheduleId: string,
    patch: SchedulePatch,
    audit: ScheduleAuditContext = {},
  ): Promise<Schedule | undefined> {
    const existing = this.scheduleById(scheduleId, true);
    if (!existing) return undefined;
    if (existing.isSystem) throw new SystemScheduleError(scheduleId);

    const updated: Schedule = {
      ...existing,
      name: patch.name ?? existing.name,
      type: patch.type ?? existing.type,
      cron: patch.cron ?? existing.cron,
      timezone: patch.timezone ?? existing.timezone,
      targetScope: patch.targetScope ?? existing.targetScope,
      command: patch.command ?? existing.command,
      parameters: patch.parameters ?? existing.parameters,
      enabled: patch.enabled ?? existing.enabled,
      lastRunAt: patch.lastRunAt === undefined ? existing.lastRunAt : patch.lastRunAt,
      nextRunAt: patch.nextRunAt === undefined ? existing.nextRunAt : patch.nextRunAt,
      updatedAt: nowIso(),
    };
    this.db.transaction(() => {
      this.db
        .prepare(
          `UPDATE scheduled_tasks
             SET name = ?, type = ?, cron = ?, timezone = ?, targetScope = ?, command = ?,
                 parameters = ?, enabled = ?, lastRunAt = ?, nextRunAt = ?, updatedAt = ?
           WHERE id = ?`,
        )
        .run(
          updated.name,
          updated.type,
          updated.cron,
          updated.timezone,
          JSON.stringify(updated.targetScope),
          updated.command,
          JSON.stringify(updated.parameters),
          updated.enabled ? 1 : 0,
          updated.lastRunAt,
          updated.nextRunAt,
          updated.updatedAt,
          scheduleId,
        );
      this.writeAuditEvent("schedule.update", scheduleId, audit, existing, updated);
    })();
    return updated;
  }

  async softDeleteSchedule(
    scheduleId: string,
    options: { now?: string; audit?: ScheduleAuditContext } = {},
  ): Promise<boolean> {
    const existing = this.scheduleById(scheduleId, false);
    if (!existing) return false;
    if (existing.isSystem) throw new SystemScheduleError(scheduleId);

    const at = options.now ?? nowIso();
    const after: Schedule = { ...existing, deletedAt: at, updatedAt: at };
    this.db.transaction(() => {
      this.db
        .prepare(
          "UPDATE scheduled_tasks SET deletedAt = ?, updatedAt = ? WHERE id = ? AND deletedAt IS NULL",
        )
        .run(at, at, scheduleId);
      this.writeAuditEvent("schedule.delete", scheduleId, options.audit ?? {}, existing, after);
    })();
    return true;
  }
}

export async function openSqliteScheduleRepository(
  options: OpenSqliteRepositoryOptions,
): Promise<SqliteScheduleRepository> {
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
    return new SqliteScheduleRepository(db, applied);
  } catch (error) {
    db.close();
    throw error;
  }
}
