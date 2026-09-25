// Scheduler contracts (EPIC-007 SPEC.md §4.1/§4.2/§5). A `Schedule` is either a
// code-deployed system timer or an operator-created task; the split lives in
// `isSystem`. The shape is shared by the BFF, storage, and web UI so a schedule's
// job type is validated against one list instead of drifting per layer.

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

export const SCHEDULE_TARGET_TYPES = ["tenant", "group", "all"] as const;

export type ScheduleTargetType = (typeof SCHEDULE_TARGET_TYPES)[number];

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
}

export function isScheduleType(value: unknown): value is ScheduleType {
  return (
    typeof value === "string" && (SCHEDULE_TYPES as readonly string[]).includes(value)
  );
}

export function isScheduleTargetType(value: unknown): value is ScheduleTargetType {
  return (
    typeof value === "string" &&
    (SCHEDULE_TARGET_TYPES as readonly string[]).includes(value)
  );
}
