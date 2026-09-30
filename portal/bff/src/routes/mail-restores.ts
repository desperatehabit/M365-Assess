// Mailbox restore with plan preview and persisted progress (EPIC-024 SPEC.md §2
// US-4, §3.4, §4.2, §5, §6, §9; §11 item 3; T-0467). Exposes
// POST /v1/tenants/:tenantId/mail/restores — builds a plan preview
// (preview:true) or applies the restore — and GET
// /v1/tenants/:tenantId/mail/restores/:jobId for progress.
//
// Restore is destructive-adjacent (SPEC §9): the plan preview runs before any
// write and a preview restores nothing; every apply requires mailtools.restore
// plus Remediation.Apply, requires explicit `confirm: true`, is audited with
// before/after item counts, and is tracked as a RestoreJob. The provider seam
// enqueues the start-mailbox-restore worker and persists/reads the RestoreJob
// through the T-0461 repository; the BFF never talks to EXO or the database
// directly, so EXO and process code stay out of the BFF.
import { AppError, ErrorCodes } from "../errors.js";
import { requireTenantInScope, type Caller } from "../rbac/authorize.js";
import type { RequestContext, Route, RouteResponse } from "../server.js";

export const MAIL_RESTORES_PATH = "/v1/tenants/:tenantId/mail/restores";
export const MAIL_RESTORE_JOB_PATH = "/v1/tenants/:tenantId/mail/restores/:jobId";
export const MAIL_RESTORE_PERMISSION = "mailtools.restore";
export const MAIL_RESTORE_APPLY_PERMISSION = "Remediation.Apply";
export const MAIL_RESTORES_UNAUTHENTICATED = "request.unauthenticated";
export const MAIL_RESTORE_CONFIRM_REQUIRED = "mail-restores.confirm_required";
export const MAIL_RESTORE_NOT_FOUND = "mail-restores.not_found";

export const MAIL_RESTORE_SCOPES = ["mailbox", "items", "date"] as const;

export type MailRestoreScope = (typeof MAIL_RESTORE_SCOPES)[number];
export type MailRestoreState = "planned" | "running" | "completed" | "failed";

export interface MailRestoreInput {
  readonly mailboxId: string;
  readonly scope: MailRestoreScope;
  readonly target?: string;
  readonly query?: string;
  readonly startDate?: string;
  readonly endDate?: string;
}

export interface MailRestorePlan {
  readonly action: "restore";
  readonly mailboxId: string;
  readonly scope: MailRestoreScope;
  readonly target: string | null;
  readonly before?: Record<string, unknown> | null;
  readonly after?: Record<string, unknown> | null;
  readonly diff: readonly string[];
  readonly valid: boolean;
  readonly dryRun: boolean;
  readonly requiresConfirmation: boolean;
}

// Mirrors the persisted RestoreJob entity (T-0461, SPEC §5).
export interface MailRestoreJob {
  readonly id: string;
  readonly tenantId: string;
  readonly mailboxId: string;
  readonly scope: string;
  readonly target: string | null;
  readonly state: MailRestoreState;
  readonly result: Record<string, unknown> | null;
  readonly createdAt: string;
  readonly createdBy: string;
}

export interface MailRestoreAuditEvent {
  readonly id: string;
  readonly tenantId: string;
  readonly action: string;
  readonly targetId: string;
  readonly targetName?: string;
  readonly scope?: string;
  readonly timestamp: string;
  readonly before?: Record<string, unknown> | null;
  readonly after?: Record<string, unknown> | null;
}

export interface MailRestoreResult {
  readonly success: boolean;
  readonly job: MailRestoreJob;
  readonly plan: MailRestorePlan;
  readonly result?: Record<string, unknown>;
  readonly auditEvent?: MailRestoreAuditEvent;
}

// Queue-backed seam for the restore: the production wiring enqueues a
// start-mailbox-restore worker job per call, then creates/updates the
// RestoreJob through the repository (createRestoreJob/updateRestoreJob) and
// serves it back with getRestoreJob. Depending on the seam keeps EXO and
// process code out of the BFF.
export interface MailRestoresProvider {
  planRestore(
    tenantId: string,
    input: MailRestoreInput,
    createdBy?: string,
  ): Promise<MailRestorePlan>;
  applyRestore(
    tenantId: string,
    input: MailRestoreInput,
    createdBy?: string,
  ): Promise<MailRestoreResult>;
  getRestoreJob(tenantId: string, jobId: string): Promise<MailRestoreJob>;
}

export interface MailRestoresCaller extends Caller {
  readonly userId?: string;
}

export type MailRestoresAuthorizer = (
  caller: MailRestoresCaller,
  permission: string,
) => void | Promise<void>;

export interface MailRestoresRouteOptions {
  readonly provider: MailRestoresProvider;
  readonly resolveCaller: (ctx: RequestContext) => MailRestoresCaller | undefined;
  readonly authorize?: MailRestoresAuthorizer;
  readonly recordAudit?: (event: MailRestoreAuditEvent) => void | Promise<void>;
}

function unauthenticatedError(): AppError {
  return new AppError(MAIL_RESTORES_UNAUTHENTICATED, "authentication required", 401);
}

function validationError(message: string, field: string): AppError {
  return new AppError(ErrorCodes.validationFailed, message, 400, [
    { field, reason: "invalid" },
  ]);
}

export function mailRestoreNotFoundError(jobId: string): AppError {
  return new AppError(
    MAIL_RESTORE_NOT_FOUND,
    `mailbox restore job '${jobId}' was not found`,
    404,
    [{ field: "jobId", reason: "not_found" }],
  );
}

function requireCaller(
  resolveCaller: (ctx: RequestContext) => MailRestoresCaller | undefined,
  ctx: RequestContext,
): MailRestoresCaller {
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

function requireJobParam(ctx: RequestContext): string {
  const value = ctx.params["jobId"];
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new AppError(ErrorCodes.validationFailed, "jobId is required", 400, [
      { field: "jobId", reason: "required" },
    ]);
  }
  return value.trim();
}

async function requireMailRestorePermission(
  options: MailRestoresRouteOptions,
  caller: MailRestoresCaller,
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

function readPreviewFlag(ctx: RequestContext, body: Record<string, unknown>): boolean {
  return Boolean(body["preview"] ?? (ctx.query.get("preview") === "true"));
}

function optionalText(value: unknown, field: string): string | undefined {
  if (value === undefined || value === null || value === "") {
    return undefined;
  }
  if (typeof value !== "string" || value.trim().length === 0) {
    throw validationError(`${field} must be a non-empty string`, field);
  }
  return value.trim();
}

export function parseMailRestoreInput(body: Record<string, unknown>): MailRestoreInput {
  const mailboxId = body["mailboxId"];
  if (typeof mailboxId !== "string" || mailboxId.trim().length === 0) {
    throw validationError("mailboxId must be a non-empty string", "mailboxId");
  }

  let scope: MailRestoreScope = "mailbox";
  const rawScope = body["scope"];
  if (rawScope !== undefined && rawScope !== null) {
    if (
      typeof rawScope !== "string" ||
      !(MAIL_RESTORE_SCOPES as readonly string[]).includes(rawScope.trim())
    ) {
      throw validationError(`scope must be one of ${MAIL_RESTORE_SCOPES.join(", ")}`, "scope");
    }
    scope = rawScope.trim() as MailRestoreScope;
  }

  const target = optionalText(body["target"], "target");
  if (scope !== "mailbox" && target === undefined) {
    throw validationError(`target is required when scope is '${scope}'`, "target");
  }

  const query = optionalText(body["query"], "query");
  const startDate = optionalText(body["startDate"], "startDate");
  const endDate = optionalText(body["endDate"], "endDate");
  for (const [field, value] of [
    ["startDate", startDate],
    ["endDate", endDate],
  ] as const) {
    if (value !== undefined && Number.isNaN(Date.parse(value))) {
      throw validationError(`${field} must be a parseable datetime`, field);
    }
  }
  if (startDate !== undefined && endDate !== undefined) {
    if (Date.parse(startDate) > Date.parse(endDate)) {
      throw validationError("startDate must not be after endDate", "startDate");
    }
  }
  if (scope === "date" && (startDate === undefined || endDate === undefined)) {
    throw validationError("scope 'date' requires startDate and endDate", "startDate");
  }

  return { mailboxId: mailboxId.trim(), scope, target, query, startDate, endDate };
}

export function createMailRestoreRoutes(options: MailRestoresRouteOptions): Route[] {
  const startHandler = async (ctx: RequestContext): Promise<RouteResponse> => {
    const caller = requireCaller(options.resolveCaller, ctx);
    const tenantId = requireTenantParam(ctx);

    requireTenantInScope(caller, tenantId);
    await requireMailRestorePermission(options, caller, MAIL_RESTORE_PERMISSION);

    const body = (ctx.body ?? {}) as Record<string, unknown>;
    const input = parseMailRestoreInput(body);
    const isPreview = readPreviewFlag(ctx, body);

    if (isPreview) {
      const plan = await options.provider.planRestore(tenantId, input, caller.userId);
      return {
        status: 200,
        headers: { "content-type": "application/json" },
        body: plan,
      };
    }

    await requireMailRestorePermission(options, caller, MAIL_RESTORE_APPLY_PERMISSION);

    const confirmRaw = body["confirm"];
    if (confirmRaw !== undefined && typeof confirmRaw !== "boolean") {
      throw validationError("confirm must be a boolean", "confirm");
    }
    if (confirmRaw !== true) {
      throw new AppError(
        MAIL_RESTORE_CONFIRM_REQUIRED,
        "restore requires { \"confirm\": true }",
        400,
        [{ field: "confirm", reason: "required" }],
      );
    }

    let result: MailRestoreResult;
    try {
      result = await options.provider.applyRestore(tenantId, input, caller.userId);
    } catch (error) {
      if (error instanceof AppError) {
        throw error;
      }
      const message = error instanceof Error ? error.message : "";
      if (/not.?found/i.test(message)) {
        throw mailRestoreNotFoundError(input.mailboxId);
      }
      throw error;
    }

    if (result.auditEvent && options.recordAudit) {
      await options.recordAudit(result.auditEvent);
    }
    return {
      status: 202,
      headers: { "content-type": "application/json" },
      body: result,
    };
  };

  const getHandler = async (ctx: RequestContext): Promise<RouteResponse> => {
    const caller = requireCaller(options.resolveCaller, ctx);
    const tenantId = requireTenantParam(ctx);
    const jobId = requireJobParam(ctx);

    requireTenantInScope(caller, tenantId);
    await requireMailRestorePermission(options, caller, MAIL_RESTORE_PERMISSION);

    let job: MailRestoreJob;
    try {
      job = await options.provider.getRestoreJob(tenantId, jobId);
    } catch (error) {
      if (error instanceof AppError) {
        throw error;
      }
      const message = error instanceof Error ? error.message : "";
      if (/not.?found/i.test(message)) {
        throw mailRestoreNotFoundError(jobId);
      }
      throw error;
    }

    return {
      status: 200,
      headers: { "content-type": "application/json" },
      body: job,
    };
  };

  return [
    { method: "POST", path: MAIL_RESTORES_PATH, handler: startHandler },
    { method: "GET", path: MAIL_RESTORE_JOB_PATH, handler: getHandler },
  ];
}

// Route modules own their OpenAPI path items (portal.v1.yaml `paths` is empty
// by design); a wiring ticket merges this fragment into the served document.
export const MAIL_RESTORES_OPENAPI = {
  paths: {
    "/tenants/{tenantId}/mail/restores": {
      post: {
        operationId: "startMailRestore",
        summary: "Start a mailbox restore (plan preview with preview:true)",
        permission: MAIL_RESTORE_PERMISSION,
        security: [{ bearerAuth: [] }],
        parameters: [
          { name: "tenantId", in: "path", required: true, schema: { type: "string" } },
        ],
        responses: {
          "200": { description: "The restore plan preview; nothing is restored." },
          "202": { description: "The started restore with the persisted RestoreJob and audit event." },
          "400": { description: "The restore input is invalid or confirmation is missing." },
          "401": { description: "Authentication required." },
          "403": { description: "The caller lacks mailtools.restore or Remediation.Apply, or the tenant is out of scope." },
        },
      },
    },
    "/tenants/{tenantId}/mail/restores/{jobId}": {
      get: {
        operationId: "getMailRestore",
        summary: "Poll a mailbox restore for progress from the persisted RestoreJob",
        permission: MAIL_RESTORE_PERMISSION,
        security: [{ bearerAuth: [] }],
        parameters: [
          { name: "tenantId", in: "path", required: true, schema: { type: "string" } },
          { name: "jobId", in: "path", required: true, schema: { type: "string" } },
        ],
        responses: {
          "200": { description: "The persisted RestoreJob with progress and before/after counts." },
          "401": { description: "Authentication required." },
          "403": { description: "The caller lacks mailtools.restore or the tenant is out of scope." },
          "404": { description: "The restore job was not found." },
        },
      },
    },
  },
} as const;
