import { randomUUID } from "node:crypto";
import type { JobEnvelope, JobType } from "@m365-assess/contracts";
import { nextFireTime } from "./cron.js";
import {
  SYSTEM_TIMERS,
  type SystemTimer,
  type SystemTimerScheduleType,
} from "./system-timers.js";

// Scheduler tick (EPIC-007 SPEC.md §4.2): evaluates due Schedule rows — user
// tasks from the store plus the code-deployed system timers — and enqueues one
// Job per due schedule through the EPIC-003 worker-pool queue. The schedule
// shape is restated here instead of importing the contracts module across the
// workspace boundary; any real Schedule remains assignable to it.
export interface TickScheduleTargetScope {
  readonly type: "tenant" | "group" | "all";
  readonly id?: string;
}

export interface TickSchedule {
  readonly id: string;
  readonly type: SystemTimerScheduleType;
  readonly cron: string;
  readonly timezone: string;
  readonly targetScope: TickScheduleTargetScope;
  readonly enabled: boolean;
  readonly lastRunAt: string | null;
  readonly nextRunAt: string | null;
}

export const SCHEDULE_TRIGGER = "schedule" as const;

// A scheduled run shows as a Job in the queue with its trigger recorded as
// `schedule` alongside the originating schedule id (SPEC §3.4/§5). The T-0010
// queue validates the envelope core and ignores the extra fields.
export interface ScheduledJobEnvelope extends JobEnvelope {
  readonly trigger: typeof SCHEDULE_TRIGGER;
  readonly scheduleId: string;
}

// Structural seam over the T-0010 JobQueue: only enqueue is needed, so fakes
// and the real queue are interchangeable without importing the queue here.
export interface TickQueue {
  enqueue(envelope: unknown): Promise<string>;
}

export interface TickScheduleRunPatch {
  readonly lastRunAt?: string | null;
  readonly nextRunAt?: string | null;
}

export interface TickScheduleStore {
  listSchedules(): Promise<TickSchedule[]>;
  getSchedule(scheduleId: string): Promise<TickSchedule | undefined>;
  updateSchedule(
    scheduleId: string,
    patch: TickScheduleRunPatch,
  ): Promise<unknown>;
}

export interface TickIds {
  readonly jobId: string;
  readonly runId: string;
  readonly requestId: string;
  readonly correlationId: string;
}

export interface TickOptions {
  readonly queue: TickQueue;
  readonly schedules: TickScheduleStore;
  readonly isRunning: (scheduleId: string) => boolean | Promise<boolean>;
  readonly now?: Date;
  readonly newIds?: () => TickIds;
  readonly systemTimers?: readonly SystemTimer[];
}

export interface TickFailure {
  readonly scheduleId: string;
  readonly error: string;
}

export interface TickResult {
  readonly enqueued: string[];
  readonly skippedRunning: string[];
  readonly failed: TickFailure[];
}

export function isScheduleDue(schedule: TickSchedule, now: Date): boolean {
  if (!schedule.enabled) {
    return false;
  }
  if (schedule.nextRunAt === null) {
    return true;
  }
  const at = Date.parse(schedule.nextRunAt);
  return !Number.isNaN(at) && at <= now.getTime();
}

export function toSystemSchedule(
  timer: SystemTimer,
  state?: { lastRunAt?: string | null; nextRunAt?: string | null },
): TickSchedule {
  return {
    id: `system-${timer.name}`,
    type: timer.type,
    cron: timer.cron,
    timezone: timer.timezone,
    targetScope: { type: "all" },
    enabled: true,
    lastRunAt: state?.lastRunAt ?? null,
    nextRunAt: state?.nextRunAt ?? null,
  };
}

function tenantIdOf(schedule: TickSchedule): string {
  if (schedule.targetScope.id !== undefined) {
    return schedule.targetScope.id;
  }
  return schedule.targetScope.type === "all" ? "all" : schedule.id;
}

export function buildScheduledEnvelope(
  schedule: TickSchedule,
  now: Date,
  ids: TickIds,
): ScheduledJobEnvelope {
  const tenantId = tenantIdOf(schedule);
  return {
    schemaVersion: "v1",
    jobId: ids.jobId,
    jobType: schedule.type as JobType,
    tenantId,
    runId: ids.runId,
    requestId: ids.requestId,
    correlationId: ids.correlationId,
    createdAt: now.toISOString(),
    payload: {
      contextRef: `schedules/${schedule.id}/context.json`,
      outputRef: `schedules/${schedule.id}/${ids.runId}`,
      credentialRef:
        schedule.targetScope.type === "tenant"
          ? `tenants/${tenantId}/credential`
          : `schedules/${schedule.id}/credential`,
      sectionRefs: [],
      artifactRefs: [],
    },
    trigger: SCHEDULE_TRIGGER,
    scheduleId: schedule.id,
  };
}

function defaultIds(): TickIds {
  return {
    jobId: randomUUID(),
    runId: randomUUID(),
    requestId: randomUUID(),
    correlationId: randomUUID(),
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export async function tickSchedules(options: TickOptions): Promise<TickResult> {
  const now = options.now ?? new Date();
  const newIds = options.newIds ?? defaultIds;
  const stored = await options.schedules.listSchedules();
  const storedIds = new Set(stored.map((schedule) => schedule.id));
  const timers = options.systemTimers ?? SYSTEM_TIMERS;
  const candidates = [
    ...stored,
    ...timers
      .map((timer) => toSystemSchedule(timer))
      .filter((schedule) => !storedIds.has(schedule.id)),
  ];
  const result: {
    enqueued: string[];
    skippedRunning: string[];
    failed: TickFailure[];
  } = { enqueued: [], skippedRunning: [], failed: [] };
  for (const schedule of candidates) {
    if (!isScheduleDue(schedule, now)) {
      continue;
    }
    if (await options.isRunning(schedule.id)) {
      result.skippedRunning.push(schedule.id);
      continue;
    }
    try {
      const nextRunAt = nextFireTime(schedule.cron, now, schedule.timezone);
      await options.queue.enqueue(buildScheduledEnvelope(schedule, now, newIds()));
      await options.schedules.updateSchedule(schedule.id, {
        nextRunAt: nextRunAt.toISOString(),
      });
      result.enqueued.push(schedule.id);
    } catch (error) {
      result.failed.push({ scheduleId: schedule.id, error: errorMessage(error) });
    }
  }
  return result;
}

// SPEC §4.2 step 4: the job's outcome stamps lastRunAt and recomputes
// nextRunAt from the completion instant, not the tick that enqueued it.
export async function recordScheduleOutcome(
  schedules: TickScheduleStore,
  scheduleId: string,
  finishedAt: Date,
): Promise<boolean> {
  const schedule = await schedules.getSchedule(scheduleId);
  if (schedule === undefined) {
    return false;
  }
  const nextRunAt = nextFireTime(schedule.cron, finishedAt, schedule.timezone);
  await schedules.updateSchedule(scheduleId, {
    lastRunAt: finishedAt.toISOString(),
    nextRunAt: nextRunAt.toISOString(),
  });
  return true;
}
