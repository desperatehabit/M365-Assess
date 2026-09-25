import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import type { ScheduleInput } from "./schedule-repository.js";
import {
  SystemScheduleError,
  openSqliteScheduleRepository,
} from "./schedule-repository.js";

const tempDirs: string[] = [];

function tempDbPath(): string {
  const dir = mkdtempSync(join(tmpdir(), "m365-schedules-"));
  tempDirs.push(dir);
  return join(dir, "portal.db");
}

afterEach(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
  tempDirs.length = 0;
});

function columns(filename: string, table: string): string[] {
  const raw = new Database(filename);
  try {
    return (
      raw.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>
    ).map((row) => row.name);
  } finally {
    raw.close();
  }
}

function userTask(id: string, extra: Partial<ScheduleInput> = {}): ScheduleInput {
  return {
    id,
    name: `Task ${id}`,
    type: "assessment",
    cron: "0 0 */12 * * *",
    timezone: "UTC",
    targetScope: { type: "tenant", id: "11111111-1111-1111-1111-111111111111" },
    command: "Invoke-M365Assessment",
    parameters: { sections: ["Identity"] },
    enabled: true,
    isSystem: false,
    lastRunAt: null,
    nextRunAt: null,
    ...extra,
  };
}

interface AuditRow {
  action: string;
  targetType: string;
  targetId: string;
  before: string | null;
  after: string | null;
}

function auditRows(filename: string): AuditRow[] {
  const raw = new Database(filename);
  try {
    return raw
      .prepare("SELECT action, targetType, targetId, before, after FROM audit_events ORDER BY rowid")
      .all() as AuditRow[];
  } finally {
    raw.close();
  }
}

describe("migration 0006", () => {
  it("creates the scheduled_tasks table with timestamps and soft delete", async () => {
    const filename = tempDbPath();
    const repo = await openSqliteScheduleRepository({ filename });
    expect(repo.schemaVersion).toBeGreaterThanOrEqual(6);
    repo.close();

    expect(columns(filename, "scheduled_tasks")).toEqual(
      expect.arrayContaining([
        "id",
        "name",
        "type",
        "cron",
        "timezone",
        "targetScope",
        "command",
        "parameters",
        "enabled",
        "isSystem",
        "lastRunAt",
        "nextRunAt",
        "createdAt",
        "updatedAt",
        "deletedAt",
      ]),
    );

    const raw = new Database(filename);
    try {
      expect(
        raw.prepare("SELECT COUNT(*) AS c FROM schema_versions WHERE version = 6").get(),
      ).toMatchObject({ c: 1 });
    } finally {
      raw.close();
    }
  });

  it("is re-runnable without duplicating the schema version row", async () => {
    const filename = tempDbPath();
    const first = await openSqliteScheduleRepository({ filename });
    first.close();
    const second = await openSqliteScheduleRepository({ filename });
    second.close();

    const raw = new Database(filename);
    try {
      expect(
        raw.prepare("SELECT COUNT(*) AS c FROM schema_versions WHERE version = 6").get(),
      ).toMatchObject({ c: 1 });
    } finally {
      raw.close();
    }
  });
});

describe("user task CRUD", () => {
  it("creates, reads, updates, and soft-deletes a user schedule", async () => {
    const filename = tempDbPath();
    const repo = await openSqliteScheduleRepository({ filename });

    const created = await repo.createSchedule(userTask("sched-1"));
    expect(created.isSystem).toBe(false);
    expect(created.targetScope).toEqual({
      type: "tenant",
      id: "11111111-1111-1111-1111-111111111111",
    });
    expect(created.parameters).toEqual({ sections: ["Identity"] });
    expect(created.createdAt).toBeTruthy();

    expect((await repo.getSchedule("sched-1"))?.name).toBe("Task sched-1");
    expect(await repo.listSchedules()).toHaveLength(1);

    const updated = await repo.updateSchedule("sched-1", {
      name: "Renamed task",
      cron: "0 30 2 * * *",
      enabled: false,
      nextRunAt: "2026-06-01T02:30:00.000Z",
    });
    expect(updated?.name).toBe("Renamed task");
    expect(updated?.cron).toBe("0 30 2 * * *");
    expect(updated?.enabled).toBe(false);
    expect(updated?.nextRunAt).toBe("2026-06-01T02:30:00.000Z");

    expect(await repo.softDeleteSchedule("sched-1", { now: "2026-06-02T00:00:00.000Z" })).toBe(
      true,
    );
    expect(await repo.getSchedule("sched-1")).toBeUndefined();
    expect(await repo.listSchedules()).toHaveLength(0);
    expect((await repo.getSchedule("sched-1", { includeDeleted: true }))?.deletedAt).toBe(
      "2026-06-02T00:00:00.000Z",
    );
    expect(await repo.listSchedules({ includeDeleted: true })).toHaveLength(1);
    expect(await repo.softDeleteSchedule("sched-1")).toBe(false);

    repo.close();
  });

  it("returns undefined when updating a schedule that does not exist", async () => {
    const repo = await openSqliteScheduleRepository({ filename: tempDbPath() });
    expect(await repo.updateSchedule("missing", { name: "nope" })).toBeUndefined();
    repo.close();
  });
});

describe("system timers are read-only", () => {
  it("rejects update and delete of an isSystem row at the repository layer", async () => {
    const repo = await openSqliteScheduleRepository({ filename: tempDbPath() });
    const system = await repo.createSchedule(
      userTask("std-timer", {
        name: "Standards every 12h",
        isSystem: true,
        targetScope: { type: "all" },
      }),
    );
    expect(system.isSystem).toBe(true);

    await expect(repo.updateSchedule("std-timer", { enabled: false })).rejects.toBeInstanceOf(
      SystemScheduleError,
    );
    await expect(repo.softDeleteSchedule("std-timer")).rejects.toBeInstanceOf(SystemScheduleError);

    const unchanged = await repo.getSchedule("std-timer");
    expect(unchanged?.enabled).toBe(true);
    expect(unchanged?.deletedAt).toBeNull();
    repo.close();
  });
});

describe("audit emission", () => {
  it("writes an audit event for each mutation with before/after", async () => {
    const filename = tempDbPath();
    const repo = await openSqliteScheduleRepository({ filename });
    const audit = { actorUserId: "user-1", actorType: "user" as const, correlationId: "corr-1" };

    await repo.createSchedule(userTask("sched-1"), audit);
    await repo.updateSchedule("sched-1", { enabled: false }, audit);
    await repo.softDeleteSchedule("sched-1", { audit });
    repo.close();

    const events = auditRows(filename);
    expect(events.map((event) => event.action)).toEqual([
      "schedule.create",
      "schedule.update",
      "schedule.delete",
    ]);
    for (const event of events) {
      expect(event.targetType).toBe("schedule");
      expect(event.targetId).toBe("sched-1");
    }
    expect(events[0]?.before).toBeNull();
    expect(JSON.parse(events[0]?.after ?? "{}")).toMatchObject({ enabled: true });
    expect(JSON.parse(events[1]?.after ?? "{}")).toMatchObject({ enabled: false });
    expect(JSON.parse(events[2]?.after ?? "{}")).toMatchObject({
      deletedAt: expect.any(String),
    });
  });

  it("does not audit a rejected system-timer mutation", async () => {
    const filename = tempDbPath();
    const repo = await openSqliteScheduleRepository({ filename });
    await repo.createSchedule(userTask("std-timer", { isSystem: true }));

    await expect(repo.updateSchedule("std-timer", { enabled: false })).rejects.toThrow();
    repo.close();

    expect(auditRows(filename).map((event) => event.action)).toEqual(["schedule.create"]);
  });
});
