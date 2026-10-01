// Scheduler loop (EPIC-007 SPEC.md §4.2): starts and stops with the app. Each tick
// enqueues due schedules through the tick, then records the outcome of jobs that finished
// since the previous tick (SPEC §4.2 step 4: lastRunAt/nextRunAt come from the completion
// instant, not the tick that enqueued the job).
import {
  recordScheduleOutcome,
  tickSchedules,
  type TickIds,
  type TickQueue,
  type TickResult,
  type TickScheduleStore,
} from "./tick.js";
import type { SystemTimer } from "./system-timers.js";

export const DEFAULT_SCHEDULER_INTERVAL_MS = 60_000;

export interface SchedulerOptions {
  readonly queue: TickQueue;
  readonly schedules: TickScheduleStore;
  readonly isRunning: (scheduleId: string) => boolean | Promise<boolean>;
  /** The newest terminal job for a schedule, if any — the outcome source. */
  readonly lastFinishedJob: (scheduleId: string) => Promise<{ readonly finishedAt: string } | undefined>;
  readonly intervalMs?: number;
  readonly now?: () => Date;
  readonly newIds?: () => TickIds;
  readonly systemTimers?: readonly SystemTimer[];
}

export interface Scheduler {
  /** Enqueue due schedules and record finished jobs' outcomes. */
  tick(): Promise<TickResult>;
  start(): void;
  stop(): void;
}

export function createScheduler(options: SchedulerOptions): Scheduler {
  const intervalMs = options.intervalMs ?? DEFAULT_SCHEDULER_INTERVAL_MS;
  let timer: NodeJS.Timeout | undefined;
  let running = false;

  async function recordOutcomes(): Promise<void> {
    for (const schedule of await options.schedules.listSchedules()) {
      const last = await options.lastFinishedJob(schedule.id);
      if (last === undefined) continue;
      if (schedule.lastRunAt !== null && last.finishedAt <= schedule.lastRunAt) continue;
      await recordScheduleOutcome(options.schedules, schedule.id, new Date(last.finishedAt));
    }
  }

  async function tick(): Promise<TickResult> {
    const result = await tickSchedules({
      queue: options.queue,
      schedules: options.schedules,
      isRunning: options.isRunning,
      now: options.now?.(),
      newIds: options.newIds,
      systemTimers: options.systemTimers,
    });
    await recordOutcomes();
    return result;
  }

  return {
    tick,
    start() {
      if (timer !== undefined) return;
      running = true;
      const loop = (): void => {
        if (!running) return;
        void tick().catch(() => undefined);
        timer = setTimeout(loop, intervalMs);
      };
      timer = setTimeout(loop, intervalMs);
    },
    stop() {
      running = false;
      if (timer !== undefined) {
        clearTimeout(timer);
        timer = undefined;
      }
    },
  };
}
