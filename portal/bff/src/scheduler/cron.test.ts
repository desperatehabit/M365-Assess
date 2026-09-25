import { describe, expect, it } from "vitest";
import {
  CronError,
  describeCron,
  formatTzOffset,
  nextFireTime,
  parseCron,
  parseTzOffset,
} from "./cron.js";
import {
  SCHEDULE_TARGET_TYPES,
  SCHEDULE_TYPES,
  isScheduleTargetType,
  isScheduleType,
  type Schedule,
} from "../../../contracts/src/schedules.js";

function expectCronError(fn: () => unknown, code: string): CronError {
  let thrown: unknown;
  try {
    fn();
  } catch (error) {
    thrown = error;
  }
  expect(thrown).toBeInstanceOf(CronError);
  const cronError = thrown as CronError;
  expect(cronError.code).toBe(code);
  return cronError;
}

function localIso(instant: Date, tzOffset: string): string {
  return new Date(instant.getTime() + parseTzOffset(tzOffset) * 60_000).toISOString();
}

describe("6-field cron next fire time", () => {
  it("fires at the next matching second in UTC", () => {
    expect(nextFireTime("0 0 12 * * *", "2026-01-01T00:00:00.000Z", "+00:00").toISOString()).toBe(
      "2026-01-01T12:00:00.000Z",
    );
    expect(
      nextFireTime("30 15 10 * * *", "2026-01-01T00:00:00.000Z", "+00:00").toISOString(),
    ).toBe("2026-01-01T10:15:30.000Z");
  });

  it("is strictly after the supplied instant", () => {
    expect(
      nextFireTime("0 0 12 * * *", "2026-01-01T12:00:00.000Z", "+00:00").toISOString(),
    ).toBe("2026-01-02T12:00:00.000Z");
  });

  it("honours a positive and a negative TZOffset", () => {
    expect(
      nextFireTime("0 0 12 * * *", "2026-01-01T00:00:00.000Z", "+02:00").toISOString(),
    ).toBe("2026-01-01T10:00:00.000Z");
    expect(
      nextFireTime("0 0 12 * * *", "2026-01-01T00:00:00.000Z", "-05:00").toISOString(),
    ).toBe("2026-01-01T17:00:00.000Z");
  });

  it("crosses a calendar day, month, and year boundary", () => {
    expect(
      nextFireTime("0 0 0 1 1 *", "2026-06-15T00:00:00.000Z", "+00:00").toISOString(),
    ).toBe("2027-01-01T00:00:00.000Z");
    expect(
      nextFireTime("0 0 0 29 2 *", "2026-01-01T00:00:00.000Z", "+00:00").toISOString(),
    ).toBe("2028-02-29T00:00:00.000Z");
  });
});

describe("TZOffset boundaries", () => {
  it("keeps the local wall clock across a Europe daylight-saving offset change", () => {
    const cron = "0 0 9 * * *";
    const from = "2026-03-28T00:00:00.000Z";
    const standard = nextFireTime(cron, from, "+01:00");
    const daylight = nextFireTime(cron, from, "+02:00");

    expect(standard.toISOString()).toBe("2026-03-28T08:00:00.000Z");
    expect(daylight.toISOString()).toBe("2026-03-28T07:00:00.000Z");
    expect(standard.getTime() - daylight.getTime()).toBe(60 * 60 * 1_000);
    expect(localIso(standard, "+01:00")).toBe("2026-03-28T09:00:00.000Z");
    expect(localIso(daylight, "+02:00")).toBe("2026-03-28T09:00:00.000Z");
  });

  it("resolves a half-hour offset even when the UTC date differs", () => {
    expect(
      nextFireTime("0 30 0 * * *", "2026-06-01T18:00:00.000Z", "+05:30").toISOString(),
    ).toBe("2026-06-01T19:00:00.000Z");
  });
});

describe("cron validation", () => {
  it("rejects a 5-field expression with a clear error", () => {
    const error = expectCronError(() => parseCron("0 12 * * *"), "cron.invalid_field_count");
    expect(error.message).toContain("6 fields");
  });

  it("rejects a 7-field expression", () => {
    expectCronError(() => parseCron("0 0 12 * * * *"), "cron.invalid_field_count");
  });

  it("rejects an empty expression", () => {
    expectCronError(() => parseCron("   "), "cron.empty");
  });

  it("rejects out-of-range, malformed, and reversed fields", () => {
    expectCronError(() => parseCron("0 0 25 * * *"), "cron.invalid_field");
    expectCronError(() => parseCron("0 0 abc * * *"), "cron.invalid_field");
    expectCronError(() => parseCron("0 0 * * * 5-1"), "cron.invalid_field");
    expectCronError(() => parseCron("0 */0 * * * *"), "cron.invalid_field");
    expectCronError(() => parseCron("0 0 0 * * 8"), "cron.invalid_field");
  });

  it("rejects a malformed TZOffset", () => {
    expectCronError(() => parseTzOffset("+25:00"), "cron.invalid_tz_offset");
    expectCronError(() => parseTzOffset("+14:30"), "cron.invalid_tz_offset");
    expectCronError(() => parseTzOffset("nope"), "cron.invalid_tz_offset");
  });

  it("accepts the documented TZOffset forms", () => {
    expect(parseTzOffset(undefined)).toBe(0);
    expect(parseTzOffset("Z")).toBe(0);
    expect(parseTzOffset("UTC")).toBe(0);
    expect(parseTzOffset("+14:00")).toBe(14 * 60);
    expect(parseTzOffset("-05:30")).toBe(-(5 * 60 + 30));
    expect(parseTzOffset("+0530")).toBe(5 * 60 + 30);
  });

  it("rejects a field combination that can never fire", () => {
    expectCronError(
      () => nextFireTime("0 0 0 30 2 *", "2026-01-01T00:00:00.000Z", "+00:00"),
      "cron.no_fire_time",
    );
  });

  it("rejects an invalid from instant", () => {
    expectCronError(
      () => nextFireTime("0 0 12 * * *", "not-a-date", "+00:00"),
      "cron.invalid_date",
    );
  });
});

describe("human-readable description", () => {
  it("describes fixed and stepped schedules", () => {
    expect(describeCron("0 0 12 * * *")).toBe("Every day at 12:00:00");
    expect(describeCron("0 0 0 * * *")).toBe("Every day at 00:00:00");
    expect(describeCron("0 */15 * * * *")).toBe("Every 15 minutes");
    expect(describeCron("0 0 */12 * * *")).toBe("Every 12 hours");
  });

  it("describes weekday and calendar schedules", () => {
    expect(describeCron("0 30 6 * * 1")).toBe("Every Monday at 06:30:00");
    expect(describeCron("0 0 0 * * 0")).toBe("Every Sunday at 00:00:00");
    expect(describeCron("0 0 0 1 1 *")).toBe(
      "On day 1 of the month in January at 00:00:00",
    );
  });

  it("appends the timezone for the Scheduler UI", () => {
    expect(describeCron("0 0 12 * * *", "+02:00")).toBe(
      "Every day at 12:00:00 (UTC+02:00)",
    );
    expect(describeCron("0 0 12 * * *", "UTC")).toBe("Every day at 12:00:00 (UTC)");
  });

  it("formats offsets", () => {
    expect(formatTzOffset(0)).toBe("UTC");
    expect(formatTzOffset(5 * 60 + 30)).toBe("UTC+05:30");
    expect(formatTzOffset(-300)).toBe("UTC-05:00");
  });
});

describe("schedule contracts", () => {
  it("exposes the §4.2 job types", () => {
    expect(SCHEDULE_TYPES).toEqual([
      "assessment",
      "standards",
      "drift",
      "baseline",
      "backup",
      "custom-script",
      "report",
    ]);
    expect(isScheduleType("custom-script")).toBe(true);
    expect(isScheduleType("unknown")).toBe(false);
  });

  it("exposes the target scope types and accepts a full Schedule", () => {
    expect(SCHEDULE_TARGET_TYPES).toEqual(["tenant", "group", "all"]);
    expect(isScheduleTargetType("group")).toBe(true);
    expect(isScheduleTargetType("tenant-group")).toBe(false);

    const schedule: Schedule = {
      id: "sch-0001",
      name: "Nightly standards run",
      type: "standards",
      cron: "0 0 2 * * *",
      timezone: "+02:00",
      targetScope: { type: "all" },
      command: "Invoke-StandardsRun",
      parameters: { remediate: false },
      enabled: true,
      isSystem: false,
      lastRunAt: null,
      nextRunAt: "2026-06-01T00:00:00.000Z",
    };
    expect(schedule.targetScope.type).toBe("all");
    expect(schedule.cron.split(" ")).toHaveLength(6);
  });
});
