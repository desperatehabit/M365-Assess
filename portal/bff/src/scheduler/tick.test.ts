import { describe, expect, it } from "vitest";
import {
  buildScheduledEnvelope,
  isScheduleDue,
  recordScheduleOutcome,
  tickSchedules,
  toSystemSchedule,
  type TickSchedule,
  type TickScheduleStore,
} from "./tick.js";
import { SYSTEM_TIMERS, getSystemTimer } from "./system-timers.js";

const NOW = new Date("2026-01-01T12:00:01.000Z");

class FakeQueue {
  readonly envelopes: Array<Record<string, unknown>> = [];

  async enqueue(envelope: unknown): Promise<string> {
    this.envelopes.push(envelope as Record<string, unknown>);
    return String((envelope as { jobId: string }).jobId);
  }
}

class FakeSchedules implements TickScheduleStore {
  readonly rows = new Map<string, TickSchedule>();

  constructor(seed: TickSchedule[] = []) {
    for (const schedule of seed) {
      this.rows.set(schedule.id, schedule);
    }
  }

  async listSchedules(): Promise<TickSchedule[]> {
    return [...this.rows.values()];
  }

  async getSchedule(scheduleId: string): Promise<TickSchedule | undefined> {
    return this.rows.get(scheduleId);
  }

  async updateSchedule(
    scheduleId: string,
    patch: { lastRunAt?: string | null; nextRunAt?: string | null },
  ): Promise<unknown> {
    const existing = this.rows.get(scheduleId);
    if (existing === undefined) {
      throw new Error(`unknown schedule ${scheduleId}`);
    }
    this.rows.set(scheduleId, { ...existing, ...patch });
    return undefined;
  }
}

function userSchedule(
  id: string,
  extra: Partial<TickSchedule> = {},
): TickSchedule {
  return {
    id,
    type: "assessment",
    cron: "0 0 */12 * * *",
    timezone: "UTC",
    targetScope: { type: "tenant", id: "tenant-1" },
    enabled: true,
    lastRunAt: null,
    nextRunAt: "2026-01-01T12:00:00.000Z",
    ...extra,
  };
}

function counterIds() {
  let n = 0;
  return () => {
    n += 1;
    return {
      jobId: `job-${n}`,
      runId: `run-${n}`,
      requestId: `req-${n}`,
      correlationId: `corr-${n}`,
    };
  };
}

describe("scheduler tick due evaluation", () => {
  it("enqueues exactly one job with trigger schedule for a due schedule", async () => {
    const queue = new FakeQueue();
    const schedules = new FakeSchedules([userSchedule("sch-1")]);
    const result = await tickSchedules({
      queue,
      schedules,
      isRunning: () => false,
      now: NOW,
      newIds: counterIds(),
      systemTimers: [],
    });

    expect(result.enqueued).toEqual(["sch-1"]);
    expect(result.failed).toEqual([]);
    expect(queue.envelopes).toHaveLength(1);
    const envelope = queue.envelopes[0]!;
    expect(envelope["trigger"]).toBe("schedule");
    expect(envelope["scheduleId"]).toBe("sch-1");
    expect(envelope["jobType"]).toBe("assessment");

    const stored = await schedules.getSchedule("sch-1");
    expect(stored?.nextRunAt).toBe("2026-01-02T00:00:00.000Z");

    const again = await tickSchedules({
      queue,
      schedules,
      isRunning: () => false,
      now: NOW,
      newIds: counterIds(),
      systemTimers: [],
    });
    expect(again.enqueued).toEqual([]);
    expect(queue.envelopes).toHaveLength(1);
  });

  it("skips schedules that are not due or disabled", async () => {
    const queue = new FakeQueue();
    const schedules = new FakeSchedules([
      userSchedule("sch-future", { nextRunAt: "2026-01-02T00:00:00.000Z" }),
      userSchedule("sch-disabled", { enabled: false }),
      userSchedule("sch-bad-date", { nextRunAt: "not-a-date" }),
    ]);
    const result = await tickSchedules({
      queue,
      schedules,
      isRunning: () => false,
      now: NOW,
      newIds: counterIds(),
      systemTimers: [],
    });

    expect(result.enqueued).toEqual([]);
    expect(queue.envelopes).toHaveLength(0);
    expect(isScheduleDue(userSchedule("sch-any", { nextRunAt: null }), NOW)).toBe(
      true,
    );
  });

  it("does not double-enqueue a schedule that is already running", async () => {
    const queue = new FakeQueue();
    const schedules = new FakeSchedules([userSchedule("sch-1")]);
    const result = await tickSchedules({
      queue,
      schedules,
      isRunning: (scheduleId) => scheduleId === "sch-1",
      now: NOW,
      newIds: counterIds(),
      systemTimers: [],
    });

    expect(result.enqueued).toEqual([]);
    expect(result.skippedRunning).toEqual(["sch-1"]);
    expect(queue.envelopes).toHaveLength(0);
    expect((await schedules.getSchedule("sch-1"))?.nextRunAt).toBe(
      "2026-01-01T12:00:00.000Z",
    );
  });

  it("records a failed entry instead of enqueueing when the cron is invalid", async () => {
    const queue = new FakeQueue();
    const schedules = new FakeSchedules([
      userSchedule("sch-bad-cron", { cron: "0 0 25 * * *" }),
    ]);
    const result = await tickSchedules({
      queue,
      schedules,
      isRunning: () => false,
      now: NOW,
      newIds: counterIds(),
      systemTimers: [],
    });

    expect(result.enqueued).toEqual([]);
    expect(queue.envelopes).toHaveLength(0);
    expect(result.failed).toHaveLength(1);
    expect(result.failed[0]?.scheduleId).toBe("sch-bad-cron");
  });
});

describe("system timers", () => {
  it("exposes the code-deployed timers as a frozen registry", () => {
    expect(SYSTEM_TIMERS.map((timer) => timer.name)).toEqual([
      "standards",
      "drift",
      "webhooks",
      "cleanup",
      "token-refresh",
    ]);
    expect(getSystemTimer("standards")?.cron).toBe("0 0 */12 * * *");
    expect(getSystemTimer("drift")?.cron).toBe("0 15 */12 * * *");
    expect(getSystemTimer("webhooks")?.cron).toBe("0 */15 * * * *");
    expect(Object.isFrozen(SYSTEM_TIMERS)).toBe(true);
    for (const timer of SYSTEM_TIMERS) {
      expect(Object.isFrozen(timer)).toBe(true);
    }
    expect(getSystemTimer("missing")).toBeUndefined();
  });

  it("evaluates system timers through the same single-flight enqueue path", async () => {
    const queue = new FakeQueue();
    const schedules = new FakeSchedules(
      SYSTEM_TIMERS.map((timer) => toSystemSchedule(timer)),
    );
    const result = await tickSchedules({
      queue,
      schedules,
      isRunning: (scheduleId) => scheduleId === "system-drift",
      now: NOW,
      newIds: counterIds(),
    });

    expect(result.enqueued).toHaveLength(4);
    expect(result.skippedRunning).toEqual(["system-drift"]);
    for (const envelope of queue.envelopes) {
      expect(envelope["trigger"]).toBe("schedule");
      expect(String(envelope["scheduleId"])).toMatch(/^system-/);
    }
    expect(await schedules.getSchedule("system-standards")).toMatchObject({
      nextRunAt: "2026-01-02T00:00:00.000Z",
    });
  });
});

describe("schedule outcome", () => {
  it("updates lastRunAt and nextRunAt after the job outcome is recorded", async () => {
    const schedules = new FakeSchedules([userSchedule("sch-1")]);
    const finishedAt = new Date("2026-01-01T12:30:00.000Z");

    await expect(
      recordScheduleOutcome(schedules, "sch-missing", finishedAt),
    ).resolves.toBe(false);
    await expect(
      recordScheduleOutcome(schedules, "sch-1", finishedAt),
    ).resolves.toBe(true);

    await expect(schedules.getSchedule("sch-1")).resolves.toMatchObject({
      lastRunAt: "2026-01-01T12:30:00.000Z",
      nextRunAt: "2026-01-02T00:00:00.000Z",
    });
  });

  it("builds a queue-compatible envelope carrying trigger and schedule id", () => {
    const envelope = buildScheduledEnvelope(userSchedule("sch-1"), NOW, {
      jobId: "job-1",
      runId: "run-1",
      requestId: "req-1",
      correlationId: "corr-1",
    });
    expect(envelope.trigger).toBe("schedule");
    expect(envelope.scheduleId).toBe("sch-1");
    expect(envelope.tenantId).toBe("tenant-1");
    expect(envelope.createdAt).toBe(NOW.toISOString());
  });
});
