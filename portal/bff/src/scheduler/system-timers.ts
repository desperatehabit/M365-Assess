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

export interface SystemTimer {
  readonly name: string;
  readonly cron: string;
  readonly type: SystemTimerScheduleType;
  readonly timezone: string;
  readonly command: string;
}

// The operational timers (webhooks, cleanup, token-refresh) predate a
// dedicated maintenance job type, so they ride the closest existing schedule
// type until that taxonomy gap is closed; dispatch already keys on command.
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
        timezone: "UTC",
        command: "Invoke-WebhookRenewal",
      },
      {
        name: "cleanup",
        cron: "0 0 3 * * *",
        type: "backup",
        timezone: "UTC",
        command: "Invoke-PortalCleanup",
      },
      {
        name: "token-refresh",
        cron: "0 0 * * * *",
        type: "assessment",
        timezone: "UTC",
        command: "Invoke-TokenRefresh",
      },
    ] satisfies SystemTimer[]
  ).map((timer) => Object.freeze(timer)),
);

export function getSystemTimer(name: string): SystemTimer | undefined {
  return SYSTEM_TIMERS.find((timer) => timer.name === name);
}
