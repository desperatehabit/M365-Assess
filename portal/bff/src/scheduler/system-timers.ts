// Code-deployed system timers (EPIC-007 SPEC.md §4.1). These mirror CIPP's
// CIPPTimers.json split: timers ship with the app and are read-only in the UI
// and API, while operator tasks live in the scheduled_tasks table. The array
// and every entry are frozen so a consumer cannot mutate the registry at
// runtime; edits happen here, in code.
export type SystemTimerScheduleType =
  | "assessment"
  | "standards"
  | "drift"
  | "baseline"
  | "backup"
  | "custom-script"
  | "report";

/**
 * The job type a timer enqueues. Operational timers (webhooks, cleanup) do not
 * correspond to a tenant run, so they ride the `maintenance` job type and dispatch
 * on their command; their `type` stays the user-visible schedule type.
 */
export type SystemTimerJobType = SystemTimerScheduleType | "maintenance";

export interface SystemTimer {
  readonly name: string;
  readonly cron: string;
  readonly type: SystemTimerScheduleType;
  /** Job type to enqueue; defaults to `type` when omitted. */
  readonly jobType?: SystemTimerJobType;
  readonly timezone: string;
  readonly command: string;
  /**
   * Set when the timer's command has no implementation yet. The scheduler tick
   * skips such a timer and the API shows it disabled with this reason, instead of
   * enqueueing a job that no runner can execute (T-0876).
   */
  readonly unavailableReason?: string;
}

// Operational timers that do not run an assessment or report: they ride the
// `maintenance` job type and dispatch on the command carried in the job payload
// (T-0902/T-0903). Token refresh was retired in T-0904: tenant credentials are
// certificate-based, so there is no OAuth token to keep warm. Credential and
// certificate expiry is covered by the scheduled credential-expiry scan (T-0874).
export const SYSTEM_TIMERS: readonly SystemTimer[] = Object.freeze(
  (
    [
      {
        name: "standards",
        cron: "0 0 */12 * * *",
        type: "standards",
        timezone: "UTC",
        command: "Invoke-StandardsRun",
      },
      {
        name: "drift",
        cron: "0 15 */12 * * *",
        type: "drift",
        timezone: "UTC",
        command: "Invoke-DriftRun",
      },
      {
        name: "webhooks",
        cron: "0 */15 * * * *",
        type: "report",
        jobType: "maintenance",
        timezone: "UTC",
        command: "Invoke-WebhookRenewal",
      },
      {
        name: "cleanup",
        cron: "0 0 3 * * *",
        type: "backup",
        jobType: "maintenance",
        timezone: "UTC",
        command: "Invoke-PortalCleanup",
      },
    ] satisfies SystemTimer[]
  ).map((timer) => Object.freeze(timer)),
);

export function isSystemTimerAvailable(timer: SystemTimer): boolean {
  return timer.unavailableReason === undefined;
}

export function getSystemTimer(name: string): SystemTimer | undefined {
  return SYSTEM_TIMERS.find((timer) => timer.name === name);
}
