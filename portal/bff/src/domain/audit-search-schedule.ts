// Saved audit-search domain logic (EPIC-032 SPEC.md §3.1, §4.1, §5; T-0623).
// The §3.1 filter shape (date range, user, activity, workload, IP) is validated
// here so every collector — manual search (T-0622) and saved-search CRUD — parses
// the same shape, and the Schedule action's EPIC-007 schedule record is built
// here so the route stays a thin HTTP adapter. No HTTP, no seams, no I/O.
import { AppError, ErrorCodes } from "../errors.js";

export type AuditSearchFilters = {
  readonly startDate?: string;
  readonly endDate?: string;
  readonly user?: string;
  readonly activity?: string;
  readonly workload?: string;
  readonly ip?: string;
};

export const AUDIT_SEARCH_FILTER_FIELDS = [
  "startDate",
  "endDate",
  "user",
  "activity",
  "workload",
  "ip",
] as const;

// The scheduled run dispatches the T-0622 audit-search worker; `parameters`
// carries the saved search id and its filter so the worker re-runs the same
// query without re-deriving it.
export const AUDIT_SEARCH_SCHEDULE_COMMAND = "Search-AuditLog";
export const AUDIT_SEARCH_SCHEDULE_TYPE = "report";

export interface AuditSearchScheduleInput {
  readonly name: string;
  readonly type: typeof AUDIT_SEARCH_SCHEDULE_TYPE;
  readonly cron: string;
  readonly timezone: string;
  readonly targetScope: { readonly type: "tenant"; readonly id: string };
  readonly command: string;
  readonly parameters: Record<string, unknown>;
  readonly enabled: boolean;
}

function validationError(message: string, field: string): AppError {
  return new AppError(ErrorCodes.validationFailed, message, 400, [
    { field, reason: "invalid" },
  ]);
}

function optionalFilterString(value: unknown, field: string): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "string" || value.trim().length === 0) {
    throw validationError(`${field} must be a non-empty string`, field);
  }
  return value.trim();
}

export function parseAuditSearchFilters(value: unknown): AuditSearchFilters {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw validationError("filters must be a JSON object", "filters");
  }
  const record = value as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (!(AUDIT_SEARCH_FILTER_FIELDS as readonly string[]).includes(key)) {
      throw validationError(
        `unknown filter field '${key}'; allowed: ${(AUDIT_SEARCH_FILTER_FIELDS as readonly string[]).join(", ")}`,
        "filters",
      );
    }
  }

  const filters: Record<string, string> = {};
  for (const field of ["user", "activity", "workload", "ip"] as const) {
    const parsed = optionalFilterString(record[field], field);
    if (parsed !== undefined) {
      filters[field] = parsed;
    }
  }

  const startDate = optionalFilterString(record["startDate"], "startDate");
  const endDate = optionalFilterString(record["endDate"], "endDate");
  if (startDate !== undefined && Number.isNaN(Date.parse(startDate))) {
    throw validationError("startDate must be a parseable datetime", "startDate");
  }
  if (endDate !== undefined && Number.isNaN(Date.parse(endDate))) {
    throw validationError("endDate must be a parseable datetime", "endDate");
  }
  if (
    startDate !== undefined &&
    endDate !== undefined &&
    Date.parse(startDate) > Date.parse(endDate)
  ) {
    throw validationError("startDate must not be after endDate", "startDate");
  }
  if (startDate !== undefined) {
    filters["startDate"] = startDate;
  }
  if (endDate !== undefined) {
    filters["endDate"] = endDate;
  }

  return filters;
}

export function buildAuditSearchScheduleInput(options: {
  readonly search: {
    readonly id: string;
    readonly name: string;
    readonly filters: Record<string, unknown>;
  };
  readonly tenantId: string;
  readonly cron: string;
  readonly timezone: string;
}): AuditSearchScheduleInput {
  return {
    name: `Audit search: ${options.search.name}`,
    type: AUDIT_SEARCH_SCHEDULE_TYPE,
    cron: options.cron,
    timezone: options.timezone,
    targetScope: { type: "tenant", id: options.tenantId },
    command: AUDIT_SEARCH_SCHEDULE_COMMAND,
    parameters: { searchId: options.search.id, filters: options.search.filters },
    enabled: true,
  };
}
