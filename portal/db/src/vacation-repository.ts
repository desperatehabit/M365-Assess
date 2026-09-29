// Vacation schedule store (EPIC-020 SPEC.md §5; T-0386).
//
// Persists VacationSchedule (id, tenantId, mailboxId, startsAt, endsAt,
// oooMessage, forwardTo, state) for the auto-reverting OoO/forwarding window.
// Mailbox objects are read live from EXO; only schedule records persist. The
// EPIC-007 scheduler enables a `scheduled` row at startsAt and reverts it at
// endsAt; `failed` records a revert that did not complete so it raises an
// alert instead of silently ending (SPEC §9). Every create and state change
// appends an AuditEvent in the same transaction, following the schedule
// repository, so apply and revert are both audited.
import Database from "better-sqlite3";
import { randomUUID } from "node:crypto";
import { SchemaVersionError } from "./repository.js";
import {
  SCHEMA_VERSIONS_TABLE,
  loadMigrations,
  runMigrations,
  type OpenSqliteRepositoryOptions,
} from "./sqlite-repository.js";

type Row = Record<string, unknown>;

export const VACATION_SCHEDULE_STATES = ["scheduled", "active", "ended", "failed"] as const;
export type VacationScheduleState = (typeof VACATION_SCHEDULE_STATES)[number];

export interface VacationSchedule {
  readonly id: string;
  readonly tenantId: string;
  readonly mailboxId: string;
  readonly startsAt: string;
  readonly endsAt: string;
  readonly oooMessage: string;
  readonly forwardTo: string | null;
  readonly state: VacationScheduleState;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface VacationScheduleInput {
  readonly id: string;
  readonly tenantId: string;
  readonly mailboxId: string;
  readonly startsAt: string;
  readonly endsAt: string;
  readonly oooMessage: string;
  readonly forwardTo?: string | null;
  readonly state?: VacationScheduleState;
  readonly createdAt?: string;
  readonly updatedAt?: string;
}

export interface VacationScheduleUpdate {
  readonly state?: VacationScheduleState;
}

export interface VacationScheduleListOptions {
  readonly state?: VacationScheduleState;
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

function auditSnapshot(value: VacationSchedule | null): Record<string, unknown> | null {
  return value === null ? null : (JSON.parse(JSON.stringify(value)) as Record<string, unknown>);
}

export interface VacationScheduleRepository {
  readonly schemaVersion: number;

  close(): void;

  createVacationSchedule(input: VacationScheduleInput): Promise<VacationSchedule>;
  getVacationSchedule(
    tenantId: string,
    scheduleId: string,
  ): Promise<VacationSchedule | undefined>;
  listVacationSchedules(
    tenantId: string,
    options?: VacationScheduleListOptions,
  ): Promise<VacationSchedule[]>;
  updateVacationSchedule(
    tenantId: string,
    scheduleId: string,
    update: VacationScheduleUpdate,
  ): Promise<VacationSchedule | undefined>;
}

export class SqliteVacationScheduleRepository implements VacationScheduleRepository {
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

  private mapSchedule(row: Row): VacationSchedule {
    return {
      id: asString(row["id"]),
      tenantId: asString(row["tenantId"]),
      mailboxId: asString(row["mailboxId"]),
      startsAt: asString(row["startsAt"]),
      endsAt: asString(row["endsAt"]),
      oooMessage: asString(row["oooMessage"]),
      forwardTo: asNullableString(row["forwardTo"]),
      state: asString(row["state"]) as VacationScheduleState,
      createdAt: asString(row["createdAt"]),
      updatedAt: asString(row["updatedAt"]),
    };
  }

  private writeAuditEvent(
    action: string,
    targetId: string,
    tenantId: string,
    before: VacationSchedule | null,
    after: VacationSchedule | null,
  ): void {
    const timestamp = nowIso();
    this.db
      .prepare(
        `INSERT INTO audit_events
           (id, timestamp, actorUserId, actorType, tenantId, action, targetType, targetId, before, after, result, error, source, correlationId, createdAt)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        randomUUID(),
        timestamp,
        null,
        "system",
        tenantId,
        action,
        "vacation_schedule",
        targetId,
        before === null ? null : JSON.stringify(auditSnapshot(before)),
        after === null ? null : JSON.stringify(auditSnapshot(after)),
        "success",
        null,
        "request",
        null,
        timestamp,
      );
  }

  async createVacationSchedule(input: VacationScheduleInput): Promise<VacationSchedule> {
    const createdAt = input.createdAt ?? nowIso();
    const updatedAt = input.updatedAt ?? createdAt;
    const schedule: VacationSchedule = {
      id: input.id,
      tenantId: input.tenantId,
      mailboxId: input.mailboxId,
      startsAt: input.startsAt,
      endsAt: input.endsAt,
      oooMessage: input.oooMessage,
      forwardTo: input.forwardTo ?? null,
      state: input.state ?? "scheduled",
      createdAt,
      updatedAt,
    };
    this.db.transaction(() => {
      this.db
        .prepare(
          `INSERT INTO vacation_schedules
             (id, tenantId, mailboxId, startsAt, endsAt, oooMessage, forwardTo, state, createdAt, updatedAt)
           VALUES
             (@id, @tenantId, @mailboxId, @startsAt, @endsAt, @oooMessage, @forwardTo, @state, @createdAt, @updatedAt)`,
        )
        .run({
          id: schedule.id,
          tenantId: schedule.tenantId,
          mailboxId: schedule.mailboxId,
          startsAt: schedule.startsAt,
          endsAt: schedule.endsAt,
          oooMessage: schedule.oooMessage,
          forwardTo: schedule.forwardTo,
          state: schedule.state,
          createdAt: schedule.createdAt,
          updatedAt: schedule.updatedAt,
        });
      this.writeAuditEvent(
        "vacation.schedule.create",
        schedule.id,
        schedule.tenantId,
        null,
        schedule,
      );
    })();
    const persisted = await this.getVacationSchedule(schedule.tenantId, schedule.id);
    if (!persisted) throw new Error(`vacation schedule ${schedule.id} was not persisted`);
    return persisted;
  }

  async getVacationSchedule(
    tenantId: string,
    scheduleId: string,
  ): Promise<VacationSchedule | undefined> {
    const row = this.db
      .prepare("SELECT * FROM vacation_schedules WHERE id = ? AND tenantId = ?")
      .get(scheduleId, tenantId) as Row | undefined;
    return row ? this.mapSchedule(row) : undefined;
  }

  async listVacationSchedules(
    tenantId: string,
    options: VacationScheduleListOptions = {},
  ): Promise<VacationSchedule[]> {
    const sql =
      options.state === undefined
        ? "SELECT * FROM vacation_schedules WHERE tenantId = ? ORDER BY startsAt, id"
        : "SELECT * FROM vacation_schedules WHERE tenantId = ? AND state = ? ORDER BY startsAt, id";
    const params = options.state === undefined ? [tenantId] : [tenantId, options.state];
    return (this.db.prepare(sql).all(...params) as Row[]).map((row) => this.mapSchedule(row));
  }

  async updateVacationSchedule(
    tenantId: string,
    scheduleId: string,
    update: VacationScheduleUpdate,
  ): Promise<VacationSchedule | undefined> {
    const existing = await this.getVacationSchedule(tenantId, scheduleId);
    if (!existing) return undefined;
    const updated: VacationSchedule = {
      ...existing,
      state: update.state ?? existing.state,
      updatedAt: nowIso(),
    };
    this.db.transaction(() => {
      this.db
        .prepare("UPDATE vacation_schedules SET state = ?, updatedAt = ? WHERE id = ? AND tenantId = ?")
        .run(updated.state, updated.updatedAt, scheduleId, tenantId);
      this.writeAuditEvent(
        "vacation.schedule.update",
        scheduleId,
        tenantId,
        existing,
        updated,
      );
    })();
    return this.getVacationSchedule(tenantId, scheduleId);
  }
}

export async function openSqliteVacationScheduleRepository(
  options: OpenSqliteRepositoryOptions,
): Promise<SqliteVacationScheduleRepository> {
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
    return new SqliteVacationScheduleRepository(db, applied);
  } catch (error) {
    db.close();
    throw error;
  }
}
