// Vacation mode schedules with auto-revert (EPIC-020 SPEC.md §2 US-6, §3.5,
// §4.3, §5, §6; T-0386). GET lists a mailbox's schedules as active/upcoming,
// POST creates a schedule (start/end, OoO message, forwarding target) and
// registers the enable + revert jobs with the EPIC-007 scheduler, and DELETE
// is the manual **End now**: it reverts immediately and is audited. Enable and
// revert apply through the EPIC-006 gate (T-0107): the worker previews with no
// tenant write, applies only with explicit confirmation, captures
// before/after, and emits one AuditEvent plus one MailboxOperation (T-0382)
// for both the apply and the revert. A failed revert is recorded as `failed`
// and raises an alert rather than silently ending (SPEC §9).
//
// Scheduler reuse (§11.2 resolved): the enable and revert are ordinary
// EPIC-007 scheduled_tasks rows whose command is Invoke-VacationSchedule, so
// the T-0123 tick enqueues them with no new engine. A yearly one-shot cron
// carries the exact instant while `nextRunAt` carries the due time; the
// envelope's `notAfter` bounds late refires so a stale job can never
// re-enable OoO or clobber newer forwarding. Reads require `Mailboxes.Mailbox.Read`,
// writes require `Mailboxes.Vacation.ReadWrite` (SPEC §7) intersected with the caller
// tenant scope.
import { randomUUID } from "node:crypto";
import { AppError, ErrorCodes } from "../errors.js";
import { requireTenantInScope, type Caller } from "../rbac/authorize.js";
import type { RequestContext, Route, RouteResponse } from "../server.js";

export const VACATION_SCHEDULES_PATH = "/v1/tenants/:tenantId/vacation-schedules";
export const VACATION_SCHEDULE_PATH = "/v1/tenants/:tenantId/vacation-schedules/:scheduleId";
export const VACATION_READ_PERMISSION = "Mailboxes.Mailbox.Read";
export const VACATION_WRITE_PERMISSION = "Mailboxes.Vacation.ReadWrite";
export const VACATION_APPLY_PERMISSION = "Remediation.Apply";
export const VACATION_UNAUTHENTICATED = "request.unauthenticated";
export const VACATION_NOT_FOUND = "vacation.not_found";
export const VACATION_REVERT_FAILED = "vacation.revert_failed";

export const VACATION_SCHEDULE_COMMAND = "Invoke-VacationSchedule";

export type VacationScheduleState = "scheduled" | "active" | "ended" | "failed";

export type VacationDisplayStatus = "upcoming" | "active" | "ended" | "failed";

export interface VacationSchedule {
  readonly id: string;
  readonly tenantId: string;
  readonly mailboxId: string;
  readonly startsAt: string;
  readonly endsAt: string;
  readonly oooMessage: string;
  readonly forwardTo: string | null;
  readonly state: VacationScheduleState;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface VacationScheduleInput {
  readonly mailboxId: string;
  readonly startsAt: string;
  readonly endsAt: string;
  readonly oooMessage: string;
  readonly forwardTo?: string;
}

export interface VacationScheduleItem extends VacationSchedule {
  readonly status: VacationDisplayStatus;
}

export interface VacationAuditEvent {
  readonly id: string;
  readonly tenantId: string;
  readonly action: string;
  readonly targetId: string;
  readonly targetName: string;
  readonly timestamp: string;
  readonly before?: Record<string, unknown> | null;
  readonly after?: Record<string, unknown> | null;
  readonly note?: string;
}

export interface VacationMailboxOperation {
  readonly id: string;
  readonly tenantId: string;
  readonly mailboxId: string;
  readonly operation: string;
  readonly before?: Record<string, unknown> | null;
  readonly after?: Record<string, unknown> | null;
  readonly state: "planned" | "applied" | "failed" | "noop";
  readonly at: string;
}

export interface VacationAlert {
  readonly kind: string;
  readonly severity: "Critical" | "High" | "Medium" | "Low" | "Info";
  readonly tenantId: string;
  readonly scheduleId: string;
  readonly mailboxId: string;
  readonly reason: string;
  readonly timestamp: string;
}

export type VacationPhase = "enable" | "revert";

export interface VacationApplyResult {
  readonly success: boolean;
  readonly noop?: boolean;
  readonly expired?: boolean;
  readonly scheduleState: VacationScheduleState;
  readonly auditEvent?: VacationAuditEvent;
  readonly mailboxOperation?: VacationMailboxOperation;
  readonly alert?: VacationAlert;
}

// Structural seam over the T-0386 VacationScheduleRepository. Depending on the
// seam instead of the db package keeps SQL out of the BFF, matching the
// mailboxes route pattern.
export interface VacationScheduleStore {
  listVacationSchedules(tenantId: string): Promise<VacationSchedule[]>;
  getVacationSchedule(tenantId: string, scheduleId: string): Promise<VacationSchedule | undefined>;
  createVacationSchedule(input: {
    id: string;
    tenantId: string;
    mailboxId: string;
    startsAt: string;
    endsAt: string;
    oooMessage: string;
    forwardTo: string | null;
    state: VacationScheduleState;
  }): Promise<VacationSchedule>;
  updateVacationSchedule(
    tenantId: string,
    scheduleId: string,
    update: { state: VacationScheduleState },
  ): Promise<VacationSchedule | undefined>;
}

// Structural seam over the worker queue (T-0010) running the
// Invoke-VacationSchedule child job: enable applies OoO + forwarding at start,
// revert disables them at end (or immediately for End now). Depending on the
// seam keeps EXO and process code out of the BFF.
export interface VacationApplyProvider {
  applyVacationPhase(
    tenantId: string,
    schedule: VacationSchedule,
    phase: VacationPhase,
  ): Promise<VacationApplyResult>;
}

// Structural seam over the T-0122 schedule store for the enable/revert rows.
// The rows are ordinary scheduled_tasks consumed by the T-0123 tick; only
// create/disable are needed here.
export interface VacationJobScheduler {
  createScheduledJob(job: VacationScheduledJob): Promise<unknown>;
  disableScheduledJob(jobId: string): Promise<unknown>;
}

export interface VacationScheduledJob {
  readonly id: string;
  readonly name: string;
  readonly type: "custom-script";
  readonly cron: string;
  readonly timezone: string;
  readonly targetScope: { readonly type: "tenant"; readonly id: string };
  readonly command: string;
  readonly parameters: Record<string, unknown>;
  readonly enabled: boolean;
  readonly nextRunAt: string;
}

export interface VacationCaller extends Caller {
  readonly userId?: string;
}

export type VacationAuthorizer = (
  caller: VacationCaller,
  permission: string,
) => void | Promise<void>;

export interface VacationRouteOptions {
  readonly store: VacationScheduleStore;
  readonly apply: VacationApplyProvider;
  readonly scheduler?: VacationJobScheduler;
  readonly resolveCaller: (ctx: RequestContext) => VacationCaller | undefined;
  readonly authorize?: VacationAuthorizer;
  readonly now?: () => string;
  readonly newId?: () => string;
}

function unauthenticatedError(): AppError {
  return new AppError(VACATION_UNAUTHENTICATED, "authentication required", 401);
}

function validationError(message: string, field: string): AppError {
  return new AppError(ErrorCodes.validationFailed, message, 400, [
    { field, reason: "invalid" },
  ]);
}

function requireCaller(
  resolveCaller: (ctx: RequestContext) => VacationCaller | undefined,
  ctx: RequestContext,
): VacationCaller {
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

function requireScheduleParam(ctx: RequestContext): string {
  const value = ctx.params["scheduleId"];
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new AppError(ErrorCodes.validationFailed, "scheduleId is required", 400, [
      { field: "scheduleId", reason: "required" },
    ]);
  }
  return value.trim();
}

async function requireVacationRead(
  options: VacationRouteOptions,
  caller: VacationCaller,
): Promise<void> {
  if (options.authorize) {
    await options.authorize(caller, VACATION_READ_PERMISSION);
    return;
  }
  const permissions = caller.permissions ?? [];
  if (!permissions.includes(VACATION_READ_PERMISSION) && !permissions.includes("*")) {
    throw new AppError(ErrorCodes.forbidden, "forbidden: missing Mailboxes.Mailbox.Read", 403);
  }
}

async function requireVacationWrite(
  options: VacationRouteOptions,
  caller: VacationCaller,
): Promise<void> {
  if (options.authorize) {
    await options.authorize(caller, VACATION_WRITE_PERMISSION);
    return;
  }
  const permissions = caller.permissions ?? [];
  const hasWrite =
    permissions.includes(VACATION_WRITE_PERMISSION) ||
    permissions.includes(VACATION_APPLY_PERMISSION) ||
    permissions.includes("*");
  if (!hasWrite) {
    throw new AppError(ErrorCodes.forbidden, "forbidden: missing Mailboxes.Vacation.ReadWrite", 403);
  }
}

const SMTP_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function validateVacationForwardTo(value: string): boolean {
  return SMTP_PATTERN.test(value);
}

function parseInstant(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw validationError(`${field} is required and must be an ISO-8601 timestamp`, field);
  }
  const at = Date.parse(value.trim());
  if (Number.isNaN(at)) {
    throw validationError(`${field} must be a valid ISO-8601 timestamp`, field);
  }
  return new Date(at).toISOString();
}

export function parseVacationInput(body: Record<string, unknown>): VacationScheduleInput {
  const mailboxId =
    typeof body["mailboxId"] === "string" ? body["mailboxId"].trim() : "";
  if (!mailboxId) {
    throw validationError("mailboxId is required", "mailboxId");
  }
  const startsAt = parseInstant(body["startsAt"], "startsAt");
  const endsAt = parseInstant(body["endsAt"], "endsAt");
  if (Date.parse(endsAt) <= Date.parse(startsAt)) {
    throw validationError("endsAt must be after startsAt", "endsAt");
  }
  const oooMessage =
    typeof body["oooMessage"] === "string" ? body["oooMessage"].trim() : "";
  if (!oooMessage) {
    throw validationError("oooMessage is required", "oooMessage");
  }
  const rawForwardTo = body["forwardTo"];
  if (rawForwardTo !== undefined && rawForwardTo !== null && String(rawForwardTo).trim() !== "") {
    const forwardTo = String(rawForwardTo).trim();
    if (!validateVacationForwardTo(forwardTo)) {
      throw validationError("forwardTo must be a valid SMTP address", "forwardTo");
    }
    return { mailboxId, startsAt, endsAt, oooMessage, forwardTo };
  }
  return { mailboxId, startsAt, endsAt, oooMessage };
}

export function getVacationDisplayStatus(schedule: VacationSchedule): VacationDisplayStatus {
  switch (schedule.state) {
    case "active":
      return "active";
    case "ended":
      return "ended";
    case "failed":
      return "failed";
    default:
      return "upcoming";
  }
}

export function toVacationItem(schedule: VacationSchedule): VacationScheduleItem {
  return { ...schedule, status: getVacationDisplayStatus(schedule) };
}

// Encodes one instant as a yearly one-shot cron (seconds minutes hours
// day-of-month month day-of-week) for the EPIC-007 6-field contract. The
// envelope `notAfter` — not the cron — bounds late refires.
export function cronFromInstant(instantIso: string): string {
  const at = new Date(Date.parse(instantIso));
  return (
    `${at.getUTCSeconds()} ${at.getUTCMinutes()} ${at.getUTCHours()} ` +
    `${at.getUTCDate()} ${at.getUTCMonth() + 1} *`
  );
}

function vacationJobId(scheduleId: string, phase: VacationPhase): string {
  return `vacation-${scheduleId}-${phase}`;
}

export function buildVacationSchedulerJob(
  schedule: VacationSchedule,
  phase: VacationPhase,
): VacationScheduledJob {
  const at = phase === "enable" ? schedule.startsAt : schedule.endsAt;
  const revertNotAfter = new Date(Date.parse(schedule.endsAt) + 24 * 3600 * 1000).toISOString();
  return {
    id: vacationJobId(schedule.id, phase),
    name: `Vacation ${phase} for ${schedule.mailboxId}`,
    type: "custom-script",
    cron: cronFromInstant(at),
    timezone: "UTC",
    targetScope: { type: "tenant", id: schedule.tenantId },
    command: VACATION_SCHEDULE_COMMAND,
    parameters: {
      vacationScheduleId: schedule.id,
      tenantId: schedule.tenantId,
      mailboxId: schedule.mailboxId,
      phase,
      oooMessage: schedule.oooMessage,
      forwardTo: schedule.forwardTo,
      notAfter: phase === "enable" ? schedule.endsAt : revertNotAfter,
    },
    enabled: true,
    nextRunAt: at,
  };
}

export async function registerVacationSchedulerJobs(
  scheduler: VacationJobScheduler,
  schedule: VacationSchedule,
  phases: readonly VacationPhase[],
): Promise<VacationScheduledJob[]> {
  const jobs = phases.map((phase) => buildVacationSchedulerJob(schedule, phase));
  for (const job of jobs) {
    await scheduler.createScheduledJob(job);
  }
  return jobs;
}

async function disableVacationSchedulerJobs(
  scheduler: VacationJobScheduler | undefined,
  scheduleId: string,
): Promise<void> {
  if (!scheduler) return;
  for (const phase of ["enable", "revert"] as const) {
    try {
      await scheduler.disableScheduledJob(vacationJobId(scheduleId, phase));
    } catch {
      continue;
    }
  }
}

async function recordRevertOutcome(
  options: VacationRouteOptions,
  tenantId: string,
  schedule: VacationSchedule,
  outcome: VacationApplyResult,
): Promise<VacationSchedule | undefined> {
  const state = outcome.success ? "ended" : "failed";
  const updated = await options.store.updateVacationSchedule(tenantId, schedule.id, { state });
  await disableVacationSchedulerJobs(options.scheduler, schedule.id);
  return updated;
}

export function createVacationScheduleRoutes(options: VacationRouteOptions): Route[] {
  const now = options.now ?? (() => new Date().toISOString());
  const newId = options.newId ?? randomUUID;

  return [
    // GET /v1/tenants/:tenantId/vacation-schedules - active/upcoming schedules
    {
      method: "GET",
      path: VACATION_SCHEDULES_PATH,
      handler: async (ctx: RequestContext): Promise<RouteResponse> => {
        const caller = requireCaller(options.resolveCaller, ctx);
        const tenantId = requireTenantParam(ctx);
        requireTenantInScope(caller, tenantId);
        await requireVacationRead(options, caller);

        const schedules = await options.store.listVacationSchedules(tenantId);
        return {
          status: 200,
          headers: { "content-type": "application/json" },
          body: { tenantId, items: schedules.map(toVacationItem) },
        };
      },
    },

    // POST /v1/tenants/:tenantId/vacation-schedules - schedule OoO + forwarding
    {
      method: "POST",
      path: VACATION_SCHEDULES_PATH,
      handler: async (ctx: RequestContext): Promise<RouteResponse> => {
        const caller = requireCaller(options.resolveCaller, ctx);
        const tenantId = requireTenantParam(ctx);
        requireTenantInScope(caller, tenantId);
        await requireVacationWrite(options, caller);

        const body = (ctx.body ?? {}) as Record<string, unknown>;
        const input = parseVacationInput(body);
        if (Date.parse(input.endsAt) <= Date.parse(now())) {
          throw validationError("endsAt must be in the future", "endsAt");
        }

        const created = await options.store.createVacationSchedule({
          id: newId(),
          tenantId,
          mailboxId: input.mailboxId,
          startsAt: input.startsAt,
          endsAt: input.endsAt,
          oooMessage: input.oooMessage,
          forwardTo: input.forwardTo ?? null,
          state: "scheduled",
        });

        // A window that already started enables now through the gated apply;
        // otherwise the scheduler enable job fires at startsAt.
        if (Date.parse(created.startsAt) <= Date.parse(now())) {
          let outcome: VacationApplyResult;
          try {
            outcome = await options.apply.applyVacationPhase(tenantId, created, "enable");
          } catch (error) {
            // A worker that throws (EXO unreachable, mailbox missing) must not leave the row
            // `scheduled` with no job registered: nothing would ever enable or revert it.
            await options.store.updateVacationSchedule(tenantId, created.id, { state: "failed" });
            await disableVacationSchedulerJobs(options.scheduler, created.id);
            throw error;
          }
          if (!outcome.success) {
            await options.store.updateVacationSchedule(tenantId, created.id, {
              state: "failed",
            });
            await disableVacationSchedulerJobs(options.scheduler, created.id);
            throw new AppError(
              VACATION_REVERT_FAILED,
              `vacation enable failed for schedule '${created.id}'`,
              502,
              [{ field: "startsAt", reason: "enable_failed" }],
            );
          }
          const activated = await options.store.updateVacationSchedule(tenantId, created.id, {
            state: outcome.scheduleState,
          });
          if (options.scheduler) {
            await registerVacationSchedulerJobs(options.scheduler, activated ?? created, [
              "revert",
            ]);
          }
          return {
            status: 201,
            headers: { "content-type": "application/json" },
            body: {
              schedule: toVacationItem(activated ?? created),
              apply: outcome,
            },
          };
        }

        if (options.scheduler) {
          await registerVacationSchedulerJobs(options.scheduler, created, ["enable", "revert"]);
        }
        return {
          status: 201,
          headers: { "content-type": "application/json" },
          body: { schedule: toVacationItem(created) },
        };
      },
    },

    // DELETE /v1/tenants/:tenantId/vacation-schedules/:scheduleId - End now
    {
      method: "DELETE",
      path: VACATION_SCHEDULE_PATH,
      handler: async (ctx: RequestContext): Promise<RouteResponse> => {
        const caller = requireCaller(options.resolveCaller, ctx);
        const tenantId = requireTenantParam(ctx);
        const scheduleId = requireScheduleParam(ctx);
        requireTenantInScope(caller, tenantId);
        await requireVacationWrite(options, caller);

        const schedule = await options.store.getVacationSchedule(tenantId, scheduleId);
        if (!schedule) {
          throw new AppError(
            VACATION_NOT_FOUND,
            `vacation schedule '${scheduleId}' was not found`,
            404,
            [{ field: "scheduleId", reason: "not_found" }],
          );
        }
        if (schedule.state === "ended") {
          return {
            status: 200,
            headers: { "content-type": "application/json" },
            body: { schedule: toVacationItem(schedule), ended: false, reason: "already_ended" },
          };
        }

        if (schedule.state === "scheduled") {
          // The window never started, so there is nothing to revert. Running the revert
          // worker would clear forwarding and OoO the mailbox already had (the worker's
          // revert is unconditional), so the schedule is cancelled with no tenant write.
          const cancelled = await options.store.updateVacationSchedule(tenantId, schedule.id, { state: "ended" });
          await disableVacationSchedulerJobs(options.scheduler, schedule.id);
          return {
            status: 200,
            headers: { "content-type": "application/json" },
            body: {
              schedule: toVacationItem(cancelled ?? { ...schedule, state: "ended" }),
              ended: true,
              reason: "never_started",
            },
          };
        }

        const outcome = await options.apply.applyVacationPhase(tenantId, schedule, "revert");
        const updated = await recordRevertOutcome(options, tenantId, schedule, outcome);
        if (!outcome.success) {
          throw new AppError(
            VACATION_REVERT_FAILED,
            `vacation revert failed for schedule '${scheduleId}'; recorded as failed with an alert`,
            502,
            [{ field: "scheduleId", reason: "revert_failed" }],
          );
        }
        return {
          status: 200,
          headers: { "content-type": "application/json" },
          body: {
            schedule: toVacationItem(updated ?? { ...schedule, state: "ended" }),
            ended: true,
            auditEvent: outcome.auditEvent,
            mailboxOperation: outcome.mailboxOperation,
          },
        };
      },
    },
  ];
}

export const VACATION_SCHEDULES_OPENAPI = {
  paths: {
    "/tenants/{tenantId}/vacation-schedules": {
      get: {
        operationId: "listVacationSchedules",
        summary: "List vacation schedules as active/upcoming with auto-revert state",
        permission: VACATION_READ_PERMISSION,
        security: [{ bearerAuth: [] }],
        parameters: [
          { name: "tenantId", in: "path", required: true, schema: { type: "string" } },
        ],
        responses: {
          "200": { description: "The tenant's vacation schedules with display status." },
          "401": { description: "Authentication required." },
          "403": { description: "The caller lacks Mailboxes.Mailbox.Read or the tenant is out of scope." },
        },
      },
      post: {
        operationId: "createVacationSchedule",
        summary: "Schedule OoO and forwarding for a window (enable + revert jobs registered)",
        permission: VACATION_WRITE_PERMISSION,
        security: [{ bearerAuth: [] }],
        parameters: [
          { name: "tenantId", in: "path", required: true, schema: { type: "string" } },
        ],
        responses: {
          "201": { description: "The created schedule; applies immediately when already started." },
          "400": { description: "mailboxId, startsAt, endsAt, oooMessage, or forwardTo failed validation." },
          "401": { description: "Authentication required." },
          "403": { description: "The caller lacks Mailboxes.Vacation.ReadWrite or the tenant is out of scope." },
          "502": { description: "The immediate enable failed and the schedule was recorded as failed." },
        },
      },
    },
    "/tenants/{tenantId}/vacation-schedules/{scheduleId}": {
      delete: {
        operationId: "endVacationScheduleNow",
        summary: "End now: revert OoO and forwarding immediately (audited)",
        permission: VACATION_WRITE_PERMISSION,
        security: [{ bearerAuth: [] }],
        parameters: [
          { name: "tenantId", in: "path", required: true, schema: { type: "string" } },
          { name: "scheduleId", in: "path", required: true, schema: { type: "string" } },
        ],
        responses: {
          "200": { description: "The reverted schedule with its audit event and mailbox operation." },
          "401": { description: "Authentication required." },
          "403": { description: "The caller lacks Mailboxes.Vacation.ReadWrite or the tenant is out of scope." },
          "404": { description: "The vacation schedule was not found." },
          "502": { description: "The revert failed; recorded as failed with an alert." },
        },
      },
    },
  },
} as const;
