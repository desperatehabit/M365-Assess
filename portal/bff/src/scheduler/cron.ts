// 6-field cron (seconds minutes hours day-of-month month day-of-week) with a
// fixed TZOffset (EPIC-007 SPEC.md §4.1/§11.1). The scheduler stores the offset
// explicitly and this module is the only place that turns a cron string into a
// next fire time, so the §9 "cron/timezone bugs" risk is contained to one parser
// with range-checked fields.

const FIELD_COUNT = 6;

const FIELD_NAMES = [
  "seconds",
  "minutes",
  "hours",
  "day-of-month",
  "month",
  "day-of-week",
] as const;

interface FieldSpec {
  name: string;
  min: number;
  max: number;
}

const FIELD_SPECS: readonly [FieldSpec, FieldSpec, FieldSpec, FieldSpec, FieldSpec, FieldSpec] = [
  { name: FIELD_NAMES[0], min: 0, max: 59 },
  { name: FIELD_NAMES[1], min: 0, max: 59 },
  { name: FIELD_NAMES[2], min: 0, max: 23 },
  { name: FIELD_NAMES[3], min: 1, max: 31 },
  { name: FIELD_NAMES[4], min: 1, max: 12 },
  { name: FIELD_NAMES[5], min: 0, max: 7 },
];

const MS_PER_SECOND = 1_000;
const MS_PER_MINUTE = 60 * MS_PER_SECOND;
const MS_PER_HOUR = 60 * MS_PER_MINUTE;
const MS_PER_DAY = 24 * MS_PER_HOUR;
const MAX_SEARCH_DAYS = 366 * 8;

export interface ParsedCron {
  readonly expression: string;
  readonly seconds: number[];
  readonly minutes: number[];
  readonly hours: number[];
  readonly daysOfMonth: number[];
  readonly months: number[];
  readonly daysOfWeek: number[];
  readonly daysOfMonthWildcard: boolean;
  readonly daysOfWeekWildcard: boolean;
}

export class CronError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "CronError";
    this.code = code;
  }
}

export function parseCron(expression: unknown): ParsedCron {
  if (typeof expression !== "string" || expression.trim().length === 0) {
    throw new CronError("cron.empty", "Cron expression must be a non-empty string");
  }
  const trimmed = expression.trim();
  const tokens = trimmed.split(/\s+/);
  if (tokens.length !== FIELD_COUNT) {
    throw new CronError(
      "cron.invalid_field_count",
      `Cron expression must have ${FIELD_COUNT} fields (${FIELD_NAMES.join(" ")}); ` +
        `got ${tokens.length}: '${trimmed}'`,
    );
  }
  const [secondsToken, minutesToken, hoursToken, domToken, monthToken, dowToken] =
    tokens as [string, string, string, string, string, string];
  const seconds = parseField(secondsToken, FIELD_SPECS[0]);
  const minutes = parseField(minutesToken, FIELD_SPECS[1]);
  const hours = parseField(hoursToken, FIELD_SPECS[2]);
  const daysOfMonth = parseField(domToken, FIELD_SPECS[3]);
  const months = parseField(monthToken, FIELD_SPECS[4]);
  const daysOfWeek = [
    ...new Set(parseField(dowToken, FIELD_SPECS[5]).map((day) => (day === 7 ? 0 : day))),
  ].sort((a, b) => a - b);
  return {
    expression: trimmed,
    seconds,
    minutes,
    hours,
    daysOfMonth,
    months,
    daysOfWeek,
    daysOfMonthWildcard: domToken === "*",
    daysOfWeekWildcard: dowToken === "*",
  };
}

export function parseTzOffset(value?: string | null): number {
  if (value === undefined || value === null) {
    return 0;
  }
  const trimmed = value.trim();
  if (trimmed === "") {
    return 0;
  }
  const upper = trimmed.toUpperCase();
  if (upper === "UTC" || upper === "Z") {
    return 0;
  }
  const match = /^([+-])(\d{2}):?(\d{2})$/.exec(trimmed);
  if (match === null) {
    throw new CronError(
      "cron.invalid_tz_offset",
      `Timezone offset '${value}' must look like +HH:MM, -HHMM, UTC, or Z`,
    );
  }
  const hours = Number(match[2]);
  const minutes = Number(match[3]);
  if (minutes > 59 || hours > 14 || (hours === 14 && minutes !== 0)) {
    throw new CronError(
      "cron.invalid_tz_offset",
      `Timezone offset '${value}' is outside the valid range -14:00 to +14:00`,
    );
  }
  return (match[1] === "-" ? -1 : 1) * (hours * 60 + minutes);
}

export function formatTzOffset(offsetMinutes: number): string {
  if (offsetMinutes === 0) {
    return "UTC";
  }
  const sign = offsetMinutes < 0 ? "-" : "+";
  const absolute = Math.abs(offsetMinutes);
  return `UTC${sign}${pad2(Math.floor(absolute / 60))}:${pad2(absolute % 60)}`;
}

export function nextFireTime(
  cron: string | ParsedCron,
  from: Date | string | number = new Date(),
  tzOffset = "+00:00",
): Date {
  const parsed = typeof cron === "string" ? parseCron(cron) : cron;
  const offsetMs = parseTzOffset(tzOffset) * MS_PER_MINUTE;
  const startMs = toEpochMs(from);
  const localStart = new Date(startMs + offsetMs);
  const startDayMs = Date.UTC(
    localStart.getUTCFullYear(),
    localStart.getUTCMonth(),
    localStart.getUTCDate(),
  );
  for (let dayIndex = 0; dayIndex <= MAX_SEARCH_DAYS; dayIndex += 1) {
    const dayMs = startDayMs + dayIndex * MS_PER_DAY;
    const date = new Date(dayMs);
    if (!parsed.months.includes(date.getUTCMonth() + 1)) {
      continue;
    }
    if (!matchesDay(parsed, date)) {
      continue;
    }
    for (const hour of parsed.hours) {
      for (const minute of parsed.minutes) {
        for (const second of parsed.seconds) {
          const instant = dayMs + hour * MS_PER_HOUR + minute * MS_PER_MINUTE + second * MS_PER_SECOND - offsetMs;
          if (instant > startMs) {
            return new Date(instant);
          }
        }
      }
    }
  }
  throw new CronError(
    "cron.no_fire_time",
    `Cron '${parsed.expression}' has no fire time within ${MAX_SEARCH_DAYS} days`,
  );
}

export function describeCron(cron: string | ParsedCron, tzOffset?: string): string {
  const parsed = typeof cron === "string" ? parseCron(cron) : cron;
  const time = describeTime(parsed);
  const allDatesWildcard =
    parsed.daysOfMonthWildcard && parsed.daysOfWeekWildcard && isFull(parsed.months, 1, 12);
  let description: string;
  if (allDatesWildcard) {
    description = time.startsWith("every") ? capitalize(time) : `Every day ${time}`;
  } else {
    const date = describeDate(parsed);
    description = time.startsWith("every")
      ? `${capitalize(date)}, ${time}`
      : `${capitalize(date)} ${time}`;
  }
  if (tzOffset === undefined) {
    return description;
  }
  return `${description} (${formatTzOffset(parseTzOffset(tzOffset))})`;
}

function parseField(token: string, spec: FieldSpec): number[] {
  const values = new Set<number>();
  for (const part of token.split(",")) {
    for (const value of expandPart(part, spec, token)) {
      values.add(value);
    }
  }
  return [...values].sort((a, b) => a - b);
}

function expandPart(part: string, spec: FieldSpec, token: string): number[] {
  if (part === "") {
    throw fieldError(spec, token, "contains an empty entry");
  }
  const slash = part.indexOf("/");
  const rangePart = slash === -1 ? part : part.slice(0, slash);
  let step = 1;
  if (slash !== -1) {
    const stepPiece = part.slice(slash + 1);
    const parsedStep = toInt(stepPiece);
    if (parsedStep === undefined || parsedStep < 1) {
      throw fieldError(spec, token, `step '${stepPiece}' must be a positive integer`);
    }
    step = parsedStep;
  }
  let start: number;
  let end: number;
  if (rangePart === "*") {
    start = spec.min;
    end = spec.max;
  } else if (rangePart.includes("-")) {
    const [startPiece, endPiece] = rangePart.split("-");
    const startValue = toInt(startPiece ?? "");
    const endValue = toInt(endPiece ?? "");
    if (startValue === undefined || endValue === undefined) {
      throw fieldError(spec, token, `range '${rangePart}' must be two integers`);
    }
    if (startValue > endValue) {
      throw fieldError(spec, token, `range '${rangePart}' is reversed`);
    }
    start = startValue;
    end = endValue;
  } else {
    const single = toInt(rangePart);
    if (single === undefined) {
      throw fieldError(spec, token, `'${rangePart}' is not an integer`);
    }
    start = single;
    end = slash === -1 ? single : spec.max;
  }
  for (const bound of [start, end]) {
    if (bound < spec.min || bound > spec.max) {
      throw fieldError(spec, token, `value ${bound} is outside ${spec.min}-${spec.max}`);
    }
  }
  const values: number[] = [];
  for (let value = start; value <= end; value += step) {
    values.push(value);
  }
  return values;
}

function fieldError(spec: FieldSpec, token: string, message: string): CronError {
  return new CronError(
    "cron.invalid_field",
    `Invalid ${spec.name} field '${token}': ${message}`,
  );
}

function toInt(piece: string): number | undefined {
  return /^\d+$/.test(piece) ? Number(piece) : undefined;
}

function matchesDay(parsed: ParsedCron, date: Date): boolean {
  const domMatch = parsed.daysOfMonth.includes(date.getUTCDate());
  const dowMatch = parsed.daysOfWeek.includes(date.getUTCDay());
  if (parsed.daysOfMonthWildcard && parsed.daysOfWeekWildcard) {
    return true;
  }
  if (parsed.daysOfMonthWildcard) {
    return dowMatch;
  }
  if (parsed.daysOfWeekWildcard) {
    return domMatch;
  }
  return domMatch || dowMatch;
}

function toEpochMs(value: Date | string | number): number {
  if (value instanceof Date) {
    const ms = value.getTime();
    if (Number.isNaN(ms)) {
      throw new CronError("cron.invalid_date", "Invalid Date provided");
    }
    return ms;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new CronError("cron.invalid_date", `Invalid timestamp ${value}`);
    }
    return value;
  }
  const ms = Date.parse(value);
  if (Number.isNaN(ms)) {
    throw new CronError("cron.invalid_date", `Invalid date string '${value}'`);
  }
  return ms;
}

const WEEKDAY_NAMES = [
  "Sunday",
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
] as const;

const MONTH_NAMES = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
] as const;

function describeTime(parsed: ParsedCron): string {
  const { seconds, minutes, hours } = parsed;
  const everySecond = isFull(seconds, 0, 59);
  const everyMinute = isFull(minutes, 0, 59);
  const everyHour = isFull(hours, 0, 23);
  if (everySecond && everyMinute && everyHour) {
    return "every second";
  }
  if (everyHour && everyMinute) {
    return `every minute at second${seconds.length === 1 ? "" : "s"} ${list(seconds)}`;
  }
  if (everyHour) {
    const minuteStep = uniformStep(minutes, 0, 59);
    if (minuteStep !== undefined && seconds.length === 1 && seconds[0] === 0) {
      return minuteStep === 1 ? "every minute" : `every ${minuteStep} minutes`;
    }
    return `every hour at minute${minutes.length === 1 ? "" : "s"} ${list(minutes)}${secondsClause(seconds)}`;
  }
  const hourStep = uniformStep(hours, 0, 23);
  if (
    hourStep !== undefined &&
    minutes.length === 1 &&
    minutes[0] === 0 &&
    seconds.length === 1 &&
    seconds[0] === 0
  ) {
    return hourStep === 1 ? "every hour" : `every ${hourStep} hours`;
  }
  return `at ${describeTimes(hours, minutes, seconds)}`;
}

function describeDate(parsed: ParsedCron): string {
  const clauses: string[] = [];
  const weekdays = parsed.daysOfWeek.map((day) => WEEKDAY_NAMES[day] ?? String(day));
  if (parsed.daysOfMonthWildcard && parsed.daysOfWeekWildcard) {
    clauses.push("every day");
  } else if (parsed.daysOfWeekWildcard) {
    clauses.push(`on day ${list(parsed.daysOfMonth)} of the month`);
  } else if (parsed.daysOfMonthWildcard) {
    clauses.push(`every ${list(weekdays)}`);
  } else {
    clauses.push(`on day ${list(parsed.daysOfMonth)} of the month or every ${list(weekdays)}`);
  }
  if (!isFull(parsed.months, 1, 12)) {
    clauses.push(`in ${list(parsed.months.map((month) => MONTH_NAMES[month - 1] ?? String(month)))}`);
  }
  return clauses.join(" ");
}

function describeTimes(
  hours: readonly number[],
  minutes: readonly number[],
  seconds: readonly number[],
): string {
  const entries: string[] = [];
  for (const hour of hours) {
    for (const minute of minutes) {
      for (const second of seconds) {
        entries.push(`${pad2(hour)}:${pad2(minute)}:${pad2(second)}`);
      }
    }
  }
  return list(entries);
}

function secondsClause(seconds: readonly number[]): string {
  if (seconds.length === 1 && seconds[0] === 0) {
    return "";
  }
  return ` at second${seconds.length === 1 ? "" : "s"} ${list(seconds)}`;
}

function isFull(values: readonly number[], min: number, max: number): boolean {
  return (
    values.length === max - min + 1 &&
    values[0] === min &&
    values[values.length - 1] === max
  );
}

function uniformStep(values: readonly number[], min: number, max: number): number | undefined {
  if (values.length < 2) {
    return undefined;
  }
  const first = values[0]!;
  const step = values[1]! - first;
  if (first !== min || step < 1) {
    return undefined;
  }
  for (let index = 0; index < values.length; index += 1) {
    if (values[index] !== min + index * step) {
      return undefined;
    }
  }
  if (values[values.length - 1]! + step <= max) {
    return undefined;
  }
  return step;
}

function list(values: readonly (number | string)[]): string {
  return values.join(", ");
}

function capitalize(text: string): string {
  return text.length === 0 ? text : text.charAt(0).toUpperCase() + text.slice(1);
}

function pad2(value: number): string {
  return value.toString().padStart(2, "0");
}
