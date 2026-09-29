import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import {
  openSqliteVacationScheduleRepository,
  type VacationScheduleInput,
} from "./vacation-repository.js";
import { loadMigrations } from "./sqlite-repository.js";

const TENANT_A = "11111111-1111-1111-1111-111111111111";
const TENANT_B = "22222222-2222-2222-2222-222222222222";
const SCHEDULE_A = "aaaaaaaa-5555-5555-5555-555555555555";

const tempDirs: string[] = [];

function tempDbPath(): string {
  const dir = mkdtempSync(join(tmpdir(), "m365-vacation-"));
  tempDirs.push(dir);
  return join(dir, "portal.db");
}

afterEach(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
  tempDirs.length = 0;
});

function seedTenant(filename: string, id: string): void {
  const raw = new Database(filename);
  try {
    raw
      .prepare(
        "INSERT OR IGNORE INTO tenants (id, displayName, source, status, excluded, errorCount, createdAt, updatedAt) VALUES (?, ?, 'direct', 'active', 0, 0, ?, ?)",
      )
      .run(id, `Tenant ${id.slice(0, 4)}`, "2026-09-01T00:00:00.000Z", "2026-09-01T00:00:00.000Z");
  } finally {
    raw.close();
  }
}

function schedule(
  id: string,
  tenantId: string,
  extra: Partial<VacationScheduleInput> = {},
): VacationScheduleInput {
  return {
    id,
    tenantId,
    mailboxId: `mailbox-${id.slice(0, 4)}`,
    startsAt: "2026-10-01T00:00:00.000Z",
    endsAt: "2026-10-08T00:00:00.000Z",
    oooMessage: "Out of office until October 8.",
    forwardTo: "cover@example.invalid",
    state: "scheduled",
    ...extra,
  };
}

describe("migration 0025", () => {
  it("applies after the base migrations, is re-runnable, and advances SchemaVersion", async () => {
    const filename = tempDbPath();
    const expected = loadMigrations().reduce((max, migration) => Math.max(max, migration.version), 0);
    expect(expected).toBeGreaterThanOrEqual(25);

    const first = await openSqliteVacationScheduleRepository({ filename });
    expect(first.schemaVersion).toBe(expected);
    first.close();

    const raw = new Database(filename);
    expect(
      raw.prepare("SELECT COUNT(*) AS c FROM schema_versions WHERE version = 25").get(),
    ).toMatchObject({ c: 1 });
    const tables = (
      raw.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{
        name: string;
      }>
    ).map((row) => row.name);
    expect(tables).toContain("vacation_schedules");
    raw.close();

    const second = await openSqliteVacationScheduleRepository({ filename });
    expect(second.schemaVersion).toBe(expected);
    second.close();

    const rawAgain = new Database(filename);
    expect(
      rawAgain.prepare("SELECT COUNT(*) AS c FROM schema_versions WHERE version = 25").get(),
    ).toMatchObject({ c: 1 });
    rawAgain.close();
  });
});

describe("repository surface", () => {
  it("exposes VacationSchedule create/get/list/update", async () => {
    const repo = await openSqliteVacationScheduleRepository({ filename: tempDbPath() });
    const methods = [
      "createVacationSchedule",
      "getVacationSchedule",
      "listVacationSchedules",
      "updateVacationSchedule",
    ];
    for (const method of methods) {
      expect(typeof (repo as unknown as Record<string, unknown>)[method]).toBe("function");
    }
    repo.close();
  });
});

describe("vacation schedules", () => {
  it("persists start/end, OoO message, and forwarding target, and lists active/upcoming", async () => {
    const filename = tempDbPath();
    (await openSqliteVacationScheduleRepository({ filename })).close();
    seedTenant(filename, TENANT_A);
    seedTenant(filename, TENANT_B);
    const repo = await openSqliteVacationScheduleRepository({ filename });

    await repo.createVacationSchedule(schedule(SCHEDULE_A, TENANT_A));

    const created = await repo.getVacationSchedule(TENANT_A, SCHEDULE_A);
    expect(created?.mailboxId).toBe("mailbox-aaaa");
    expect(created?.startsAt).toBe("2026-10-01T00:00:00.000Z");
    expect(created?.endsAt).toBe("2026-10-08T00:00:00.000Z");
    expect(created?.oooMessage).toBe("Out of office until October 8.");
    expect(created?.forwardTo).toBe("cover@example.invalid");
    expect(created?.state).toBe("scheduled");

    const upcoming = await repo.listVacationSchedules(TENANT_A, { state: "scheduled" });
    expect(upcoming.map((item) => item.id)).toEqual([SCHEDULE_A]);

    const activated = await repo.updateVacationSchedule(TENANT_A, SCHEDULE_A, {
      state: "active",
    });
    expect(activated?.state).toBe("active");
    expect(await repo.listVacationSchedules(TENANT_A, { state: "scheduled" })).toHaveLength(0);
    expect(
      (await repo.listVacationSchedules(TENANT_A, { state: "active" })).map((item) => item.id),
    ).toEqual([SCHEDULE_A]);
    expect((await repo.listVacationSchedules(TENANT_A)).map((item) => item.id)).toEqual([
      SCHEDULE_A,
    ]);

    expect(await repo.getVacationSchedule(TENANT_B, SCHEDULE_A)).toBeUndefined();
    expect(await repo.listVacationSchedules(TENANT_B)).toHaveLength(0);
    expect(
      await repo.updateVacationSchedule(TENANT_B, SCHEDULE_A, { state: "failed" }),
    ).toBeUndefined();

    repo.close();
  });

  it("records a failed revert as failed state", async () => {
    const filename = tempDbPath();
    (await openSqliteVacationScheduleRepository({ filename })).close();
    seedTenant(filename, TENANT_A);
    const repo = await openSqliteVacationScheduleRepository({ filename });

    await repo.createVacationSchedule(schedule(SCHEDULE_A, TENANT_A, { state: "active" }));
    const failed = await repo.updateVacationSchedule(TENANT_A, SCHEDULE_A, {
      state: "failed",
    });
    expect(failed?.state).toBe("failed");
    expect(
      (await repo.listVacationSchedules(TENANT_A, { state: "failed" })).map((item) => item.id),
    ).toEqual([SCHEDULE_A]);
    repo.close();
  });

  it("audits the apply and the revert", async () => {
    const filename = tempDbPath();
    (await openSqliteVacationScheduleRepository({ filename })).close();
    seedTenant(filename, TENANT_A);
    const repo = await openSqliteVacationScheduleRepository({ filename });

    await repo.createVacationSchedule(schedule(SCHEDULE_A, TENANT_A));
    await repo.updateVacationSchedule(TENANT_A, SCHEDULE_A, { state: "active" });
    await repo.updateVacationSchedule(TENANT_A, SCHEDULE_A, { state: "ended" });
    repo.close();

    const raw = new Database(filename);
    const actions = (
      raw
        .prepare(
          "SELECT action FROM audit_events WHERE tenantId = ? AND targetId = ? ORDER BY timestamp, rowid",
        )
        .all(TENANT_A, SCHEDULE_A) as Array<{ action: string }>
    ).map((row) => row.action);
    expect(actions).toEqual([
      "vacation.schedule.create",
      "vacation.schedule.update",
      "vacation.schedule.update",
    ]);
    raw.close();
  });
});

describe("secrets", () => {
  it("has no secret-value column on vacation_schedules", async () => {
    const filename = tempDbPath();
    (await openSqliteVacationScheduleRepository({ filename })).close();
    seedTenant(filename, TENANT_A);
    const repo = await openSqliteVacationScheduleRepository({ filename });
    await repo.createVacationSchedule(schedule(SCHEDULE_A, TENANT_A));
    repo.close();

    const raw = new Database(filename);
    const columns = raw.prepare("PRAGMA table_info(vacation_schedules)").all() as Array<{
      name: string;
      type: string;
    }>;
    expect(
      columns.filter(
        (column) => column.type.toUpperCase().includes("TEXT") && /secret|password|token/i.test(column.name),
      ),
    ).toEqual([]);
    raw.close();
  });
});
