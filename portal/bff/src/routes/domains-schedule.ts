// Domain analysis schedule (EPIC-034 SPEC.md §3.4, §4.3; T-0667).
//
//   GET  /v1/tenants/:tenantId/domains/analysis-schedule   the tenant's schedule
//   POST /v1/tenants/:tenantId/domains/analysis-schedule   create / enable / disable
//
// The schedule is an ordinary EPIC-007 user task whose command is
// `Invoke-DomainAnalysisSchedule`, so the T-0123 tick enqueues the domain
// analyser for the tenant with no new engine. This route is the operator's
// control over it: the first POST creates the task, later POSTs edit the cron
// or flip `enabled`. Reads require `Tenant.Domains.Read`, writes require `Tenant.Domains.ReadWrite`
// (SPEC §7) and the tenant in the caller scope. The OpenAPI fragment is
// published here so `portal.v1.yaml` stays untouched (EPIC-001 SPEC §1).

import { randomUUID } from "node:crypto";
import { AppError, ErrorCodes } from "../errors.js";
import { requireTenantInScope, type Caller } from "../rbac/authorize.js";
import { CronError, nextFireTime, parseCron, parseTzOffset } from "../scheduler/cron.js";
import type { RequestContext, Route, RouteResponse } from "../server.js";
import type {
  ScheduleCreateRecord,
  ScheduleRecord,
  ScheduleStore,
  ScheduleUpdatePatch,
} from "./schedules.js";

// ─── Paths, permissions, error codes ─────────────────────────────────────────

export const DOMAIN_ANALYSIS_SCHEDULE_PATH = "/v1/tenants/:tenantId/domains/analysis-schedule";
export const DOMAIN_ANALYSIS_SCHEDULE_COMMAND = "Invoke-DomainAnalysisSchedule";
export const DOMAIN_ANALYSIS_SCHEDULE_TYPE = "assessment";
export const DOMAIN_ANALYSIS_SCHEDULE_DEFAULT_CRON = "0 0 6 * * *";
export const DOMAIN_ANALYSIS_SCHEDULE_NAME = "Domain analysis";

export const DOMAINS_SCHEDULE_READ_PERMISSION = "Tenant.Domains.Read";
export const DOMAINS_SCHEDULE_WRITE_PERMISSION = "Tenant.Domains.ReadWrite";
export const DOMAINS_SCHEDULE_UNAUTHENTICATED = "request.unauthenticated";
export const DOMAINS_SCHEDULE_NOT_FOUND = "domain_analysis_schedule.not_found";

// ─── Records and seams ───────────────────────────────────────────────────────

export interface DomainAnalysisScheduleResponse {
  readonly tenantId: string;
  readonly schedule: ScheduleRecord | null;
}

export interface DomainsScheduleRouteOptions {
  readonly schedules: ScheduleStore;
  readonly resolveCaller: (ctx: RequestContext) => Caller | undefined;
  readonly authorize?: (caller: Caller, permission: string) => void | Promise<void>;
  readonly now?: () => string;
  readonly newId?: () => string;
}

export interface DomainsScheduleRequest extends RequestContext {
  readonly body?: unknown;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function unauthenticatedError(): AppError {
  return new AppError(DOMAINS_SCHEDULE_UNAUTHENTICATED, "authentication required", 401);
}

function validationError(message: string, field: string): AppError {
  return new AppError(ErrorCodes.validationFailed, message, 400, [{ field, reason: "invalid" }]);
}

function requireCaller(
  resolveCaller: (ctx: RequestContext) => Caller | undefined,
  ctx: RequestContext,
): Caller {
  const caller = resolveCaller(ctx);
  if (caller === undefined) {
    throw unauthenticatedError();
  }
  return caller;
}

function requireTenantParam(ctx: RequestContext): string {
  const value = ctx.params["tenantId"];
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new AppError(ErrorCodes.validationFailed, "tenantId is required", 400, [
      { field: "tenantId", reason: "required" },
    ]);
  }
  return value.trim();
}

async function requirePermission(
  options: DomainsScheduleRouteOptions,
  caller: Caller,
  permission: string,
): Promise<void> {
  if (options.authorize) {
    await options.authorize(caller, permission);
    return;
  }
  const permissions = caller.permissions ?? [];
  if (!permissions.includes(permission) && !permissions.includes("*")) {
    throw new AppError(ErrorCodes.forbidden, `forbidden: missing ${permission}`, 403);
  }
}

function readBodyRecord(ctx: DomainsScheduleRequest): Record<string, unknown> {
  const body = ctx.body;
  if (typeof body === "string") {
    try {
      const parsed: unknown = JSON.parse(body);
      if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
    } catch {
      throw validationError("request body is not valid JSON", "body");
    }
  }
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    throw validationError("request body must be a JSON object", "body");
  }
  return body as Record<string, unknown>;
}

function parseCronExpression(value: unknown): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw validationError("cron must be a non-empty 6-field cron expression", "cron");
  }
  try {
    parseCron(value);
  } catch (error) {
    if (error instanceof CronError) {
      throw validationError(error.message, "cron");
    }
    throw error;
  }
  return value.trim();
}

function parseTimezone(value: unknown): string {
  if (value === undefined) {
    return "UTC";
  }
  if (typeof value !== "string" || value.trim().length === 0) {
    throw validationError("timezone must be a non-empty string", "timezone");
  }
  try {
    parseTzOffset(value);
  } catch (error) {
    if (error instanceof CronError) {
      throw validationError(error.message, "timezone");
    }
    throw error;
  }
  return value.trim();
}

function parseOptionalEnabled(value: unknown): boolean | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "boolean") {
    throw validationError("enabled must be a boolean", "enabled");
  }
  return value;
}

function parseOptionalScheduleId(value: unknown): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "string" || value.trim().length === 0) {
    throw validationError("scheduleId must be a non-empty string", "scheduleId");
  }
  return value.trim();
}

function computeNextRunAt(cron: string, timezone: string, nowIso: string): string {
  try {
    return nextFireTime(cron, nowIso, timezone).toISOString();
  } catch (error) {
    if (error instanceof CronError) {
      throw validationError(error.message, "cron");
    }
    throw error;
  }
}

function isDomainAnalysisSchedule(schedule: ScheduleRecord): boolean {
  return (
    !schedule.isSystem &&
    schedule.deletedAt === null &&
    schedule.command === DOMAIN_ANALYSIS_SCHEDULE_COMMAND &&
    schedule.targetScope.type === "tenant"
  );
}

function scheduleNotFoundError(scheduleId: string): AppError {
  return new AppError(
    DOMAINS_SCHEDULE_NOT_FOUND,
    `domain analysis schedule ${scheduleId} was not found`,
    404,
    [{ field: "scheduleId", reason: "not_found" }],
  );
}

/**
 * The EPIC-007 schedule record for a tenant's domain analysis. Kept next to the
 * route so the command, target scope, and type cannot drift from the route.
 */
export function buildDomainAnalysisScheduleInput(options: {
  readonly tenantId: string;
  readonly cron: string;
  readonly timezone: string;
  readonly enabled: boolean;
}): Omit<ScheduleCreateRecord, "id" | "createdAt" | "updatedAt" | "deletedAt"> {
  return {
    name: DOMAIN_ANALYSIS_SCHEDULE_NAME,
    type: DOMAIN_ANALYSIS_SCHEDULE_TYPE,
    cron: options.cron,
    timezone: options.timezone,
    targetScope: { type: "tenant", id: options.tenantId },
    command: DOMAIN_ANALYSIS_SCHEDULE_COMMAND,
    parameters: {},
    enabled: options.enabled,
    isSystem: false,
    lastRunAt: null,
    nextRunAt: null,
  };
}

// ─── Route factory ───────────────────────────────────────────────────────────

export function createDomainsScheduleRoutes(options: DomainsScheduleRouteOptions): Route[] {
  const now = options.now ?? (() => new Date().toISOString());
  const newId = options.newId ?? (() => randomUUID());

  const findSchedule = async (tenantId: string): Promise<ScheduleRecord | undefined> => {
    const listed = await options.schedules.listSchedules();
    return listed.find(
      (schedule) => isDomainAnalysisSchedule(schedule) && schedule.targetScope.id === tenantId,
    );
  };

  return [
    {
      method: "GET",
      path: DOMAIN_ANALYSIS_SCHEDULE_PATH,
      handler: async (ctx: RequestContext): Promise<RouteResponse> => {
        const caller = requireCaller(options.resolveCaller, ctx);
        const tenantId = requireTenantParam(ctx);
        requireTenantInScope(caller, tenantId);
        await requirePermission(options, caller, DOMAINS_SCHEDULE_READ_PERMISSION);

        const schedule = await findSchedule(tenantId);
        const body: DomainAnalysisScheduleResponse = { tenantId, schedule: schedule ?? null };
        return {
          status: 200,
          headers: { "content-type": "application/json" },
          body,
        };
      },
    },
    {
      method: "POST",
      path: DOMAIN_ANALYSIS_SCHEDULE_PATH,
      handler: async (ctx: RequestContext): Promise<RouteResponse> => {
        const caller = requireCaller(options.resolveCaller, ctx);
        const tenantId = requireTenantParam(ctx);
        requireTenantInScope(caller, tenantId);
        await requirePermission(options, caller, DOMAINS_SCHEDULE_WRITE_PERMISSION);

        const body = readBodyRecord(ctx as DomainsScheduleRequest);
        const scheduleId = parseOptionalScheduleId(body["scheduleId"]);
        const enabled = parseOptionalEnabled(body["enabled"]);

        let schedule: ScheduleRecord;
        if (scheduleId !== undefined) {
          const existing = await options.schedules.getSchedule(scheduleId);
          if (existing === undefined || !isDomainAnalysisSchedule(existing)) {
            throw scheduleNotFoundError(scheduleId);
          }
          if (existing.targetScope.id !== tenantId) {
            throw scheduleNotFoundError(scheduleId);
          }
          const patch: ScheduleUpdatePatch = {};
          // A partial edit that omits `enabled` must not silently re-enable a
          // task the operator disabled.
          if (enabled !== undefined) {
            patch.enabled = enabled;
          }
          if (body["cron"] !== undefined) {
            patch.cron = parseCronExpression(body["cron"]);
          }
          if (body["timezone"] !== undefined) {
            patch.timezone = parseTimezone(body["timezone"]);
          }
          if (patch.cron !== undefined || patch.timezone !== undefined) {
            patch.nextRunAt = computeNextRunAt(
              patch.cron ?? existing.cron,
              patch.timezone ?? existing.timezone,
              now(),
            );
          }
          const updated = await options.schedules.updateSchedule(scheduleId, patch);
          if (updated === undefined) {
            throw scheduleNotFoundError(scheduleId);
          }
          schedule = updated;
        } else {
          if (body["cron"] === undefined) {
            throw validationError("cron is required to create the domain analysis schedule", "cron");
          }
          const cron = parseCronExpression(body["cron"]);
          const timezone = parseTimezone(body["timezone"]);
          const instant = now();
          schedule = await options.schedules.createSchedule({
            id: newId(),
            ...buildDomainAnalysisScheduleInput({
              tenantId,
              cron,
              timezone,
              enabled: enabled ?? true,
            }),
            createdAt: instant,
            updatedAt: instant,
            nextRunAt: computeNextRunAt(cron, timezone, instant),
          });
        }

        const responseBody: DomainAnalysisScheduleResponse = { tenantId, schedule };
        return {
          status: 200,
          headers: { "content-type": "application/json" },
          body: responseBody,
        };
      },
    },
  ];
}

// ─── OpenAPI fragment (paths published by the route module, SPEC §6) ─────────

const TENANT_ID_PARAMETER = {
  name: "tenantId",
  in: "path",
  required: true,
  schema: { type: "string" },
} as const;

const ERROR_RESPONSES = {
  "401": { description: "Authentication required." },
  "403": { description: "The caller lacks Tenant.Domains.Read/Tenant.Domains.ReadWrite or the tenant is out of scope." },
} as const;

export const DOMAINS_SCHEDULE_OPENAPI = {
  paths: {
    "/tenants/{tenantId}/domains/analysis-schedule": {
      get: {
        tags: ["Domains"],
        operationId: "getDomainAnalysisSchedule",
        summary: "The tenant's scheduled domain analysis task, or null when none exists.",
        permission: DOMAINS_SCHEDULE_READ_PERMISSION,
        security: [{ bearerAuth: [] }],
        parameters: [TENANT_ID_PARAMETER],
        responses: {
          "200": { description: "The domain analysis schedule, or null." },
          ...ERROR_RESPONSES,
        },
      },
      post: {
        tags: ["Domains"],
        operationId: "setDomainAnalysisSchedule",
        summary: "Create the scheduled domain analysis task, or edit its cron and enabled state.",
        permission: DOMAINS_SCHEDULE_WRITE_PERMISSION,
        security: [{ bearerAuth: [] }],
        parameters: [TENANT_ID_PARAMETER],
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                additionalProperties: false,
                properties: {
                  scheduleId: {
                    type: "string",
                    description: "Edit an existing task instead of creating one.",
                  },
                  cron: {
                    type: "string",
                    description: "6-field cron expression; required when creating.",
                  },
                  timezone: {
                    type: "string",
                    description: "Timezone offset for the cron; defaults to UTC.",
                  },
                  enabled: {
                    type: "boolean",
                    description: "Enable or disable the scheduled run; defaults to true.",
                  },
                },
              },
            },
          },
        },
        responses: {
          "200": { description: "The created or updated domain analysis schedule." },
          "400": { description: "Invalid cron, timezone, or body." },
          "404": { description: "The referenced schedule was not found." },
          ...ERROR_RESPONSES,
        },
      },
    },
  },
} as const;
