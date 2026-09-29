// Historical search as a cancellable EXO compliance-search job (EPIC-024
// SPEC.md §2 US-2, §3.2, §4.1, §6, §9; §11 items 1+4; T-0465). Exposes
// POST /v1/tenants/:tenantId/mail/historical-search — enqueues a search job
// with scoped parameters — GET .../:jobId for progress and completion, and
// POST .../:jobId/cancel for the cancel path. The backend is EXO/Purview
// compliance search (New-/Start-/Get-ComplianceSearch) run by the
// start-historical-search worker inside the per-tenant EXO process.
// Results are ephemeral (§11.4): matches and the download reference are
// returned but never persisted — only job and audit records persist. Search
// and restore-adjacent reads are sensitive: every endpoint requires the
// elevated `mailtools.search` permission (SPEC §7) intersected with the
// caller tenant scope, and start/cancel/finish each write an audit record.
import { AppError, ErrorCodes } from "../errors.js";
import { requireTenantInScope, type Caller } from "../rbac/authorize.js";
import type { RequestContext, Route, RouteResponse } from "../server.js";

export const HISTORICAL_SEARCH_PATH = "/v1/tenants/:tenantId/mail/historical-search";
export const HISTORICAL_SEARCH_JOB_PATH = "/v1/tenants/:tenantId/mail/historical-search/:jobId";
export const HISTORICAL_SEARCH_CANCEL_PATH =
  "/v1/tenants/:tenantId/mail/historical-search/:jobId/cancel";
export const HISTORICAL_SEARCH_PERMISSION = "mailtools.search";
export const HISTORICAL_SEARCH_UNAUTHENTICATED = "request.unauthenticated";
export const HISTORICAL_SEARCH_NOT_CANCELLABLE = "historical-search.not_cancellable";
export const HISTORICAL_SEARCH_JOB_NOT_FOUND = "historical-search.not_found";

export type HistoricalSearchJobState =
  | "queued"
  | "running"
  | "succeeded"
  | "failed"
  | "cancelled";

export interface HistoricalSearchInput {
  readonly query: string;
  readonly mailboxes?: readonly string[];
  readonly startDate?: string;
  readonly endDate?: string;
  readonly top?: number;
}

export interface HistoricalSearchJob {
  readonly id: string;
  readonly tenantId: string;
  readonly searchName: string;
  readonly state: HistoricalSearchJobState;
  readonly progressPercent?: number;
  readonly createdBy?: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface HistoricalSearchMatch {
  readonly mailbox: string;
  readonly subject: string;
  readonly receivedAt: string;
  readonly sizeBytes?: number | null;
}

export interface HistoricalSearchResult {
  readonly job: HistoricalSearchJob;
  readonly matches: readonly HistoricalSearchMatch[];
  readonly totalCount: number;
  readonly downloadRef?: string;
}

export interface HistoricalSearchAuditEvent {
  readonly id: string;
  readonly tenantId: string;
  readonly action:
    | "mail.historical_search.start"
    | "mail.historical_search.cancel"
    | "mail.historical_search.finish";
  readonly targetId: string;
  readonly targetName?: string;
  readonly actor?: string;
  readonly timestamp: string;
}

// Queue-backed seam for the compliance-search jobs: the production wiring
// enqueues a start-historical-search worker job per call and serves the
// worker result. Depending on the seam keeps EXO and process code out of the
// BFF. Only job and audit records persist through this seam — message data
// is never stored.
export interface HistoricalSearchProvider {
  startSearch(
    tenantId: string,
    input: HistoricalSearchInput,
    createdBy?: string,
  ): Promise<HistoricalSearchJob>;
  getSearch(tenantId: string, jobId: string): Promise<HistoricalSearchResult>;
  cancelSearch(tenantId: string, jobId: string): Promise<HistoricalSearchJob>;
}

export interface HistoricalSearchCaller extends Caller {
  readonly userId?: string;
}

export type HistoricalSearchAuthorizer = (
  caller: HistoricalSearchCaller,
  permission: string,
) => void | Promise<void>;

export interface HistoricalSearchRouteOptions {
  readonly provider: HistoricalSearchProvider;
  readonly resolveCaller: (ctx: RequestContext) => HistoricalSearchCaller | undefined;
  readonly authorize?: HistoricalSearchAuthorizer;
  readonly recordAudit?: (event: HistoricalSearchAuditEvent) => void | Promise<void>;
}

function unauthenticatedError(): AppError {
  return new AppError(HISTORICAL_SEARCH_UNAUTHENTICATED, "authentication required", 401);
}

function validationError(message: string, field: string): AppError {
  return new AppError(ErrorCodes.validationFailed, message, 400, [
    { field, reason: "invalid" },
  ]);
}

export function historicalSearchNotFoundError(jobId: string): AppError {
  return new AppError(
    HISTORICAL_SEARCH_JOB_NOT_FOUND,
    `historical search job '${jobId}' was not found`,
    404,
    [{ field: "jobId", reason: "not_found" }],
  );
}

export function historicalSearchNotCancellableError(jobId: string, state: string): AppError {
  return new AppError(
    HISTORICAL_SEARCH_NOT_CANCELLABLE,
    `historical search job '${jobId}' in state '${state}' cannot be cancelled`,
    409,
    [{ field: "state", reason: "terminal_or_inactive" }],
  );
}

function requireCaller(
  resolveCaller: (ctx: RequestContext) => HistoricalSearchCaller | undefined,
  ctx: RequestContext,
): HistoricalSearchCaller {
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

async function requireHistoricalSearchPermission(
  options: HistoricalSearchRouteOptions,
  caller: HistoricalSearchCaller,
): Promise<void> {
  if (options.authorize) {
    await options.authorize(caller, HISTORICAL_SEARCH_PERMISSION);
    return;
  }
  const permissions = caller.permissions ?? [];
  if (!permissions.includes(HISTORICAL_SEARCH_PERMISSION) && !permissions.includes("*")) {
    throw new AppError(ErrorCodes.forbidden, "forbidden: missing mailtools.search", 403);
  }
}

function readBodyRecord(ctx: RequestContext): Record<string, unknown> {
  const body = (ctx.body ?? {}) as Record<string, unknown>;
  return body;
}

export function parseHistoricalSearchInput(body: Record<string, unknown>): HistoricalSearchInput {
  const query = body["query"];
  if (typeof query !== "string" || query.trim().length === 0) {
    throw validationError("query must be a non-empty KQL string", "query");
  }
  const input: {
    query: string;
    mailboxes?: readonly string[];
    startDate?: string;
    endDate?: string;
    top?: number;
  } = { query: query.trim() };

  const mailboxes = body["mailboxes"];
  if (mailboxes !== undefined) {
    if (
      !Array.isArray(mailboxes) ||
      mailboxes.some((entry) => typeof entry !== "string" || entry.trim().length === 0)
    ) {
      throw validationError("mailboxes must be an array of non-empty strings", "mailboxes");
    }
    input.mailboxes = (mailboxes as string[]).map((entry) => entry.trim());
  }

  for (const field of ["startDate", "endDate"] as const) {
    const value = body[field];
    if (value !== undefined) {
      if (typeof value !== "string" || value.trim().length === 0) {
        throw validationError(`${field} must be a non-empty datetime string`, field);
      }
      if (Number.isNaN(Date.parse(value))) {
        throw validationError(`${field} must be a parseable datetime`, field);
      }
      input[field] = value.trim();
    }
  }
  if (input.startDate !== undefined && input.endDate !== undefined) {
    if (Date.parse(input.startDate) > Date.parse(input.endDate)) {
      throw validationError("startDate must not be after endDate", "startDate");
    }
  }

  const top = body["top"];
  if (top !== undefined) {
    if (typeof top !== "number" || !Number.isInteger(top) || top < 1 || top > 1000) {
      throw validationError("top must be an integer between 1 and 1000", "top");
    }
    input.top = top;
  }

  return input;
}

function auditEventFor(
  action: HistoricalSearchAuditEvent["action"],
  tenantId: string,
  job: HistoricalSearchJob,
  actor?: string,
): HistoricalSearchAuditEvent {
  return {
    id: `${action}-${job.id}`,
    tenantId,
    action,
    targetId: job.id,
    targetName: job.searchName,
    actor,
    timestamp: new Date().toISOString(),
  };
}

export function createHistoricalSearchRoutes(options: HistoricalSearchRouteOptions): Route[] {
  const startHandler = async (ctx: RequestContext): Promise<RouteResponse> => {
    const caller = requireCaller(options.resolveCaller, ctx);
    const tenantId = requireTenantParam(ctx);

    requireTenantInScope(caller, tenantId);
    await requireHistoricalSearchPermission(options, caller);

    const input = parseHistoricalSearchInput(readBodyRecord(ctx));
    let job: HistoricalSearchJob;
    try {
      job = await options.provider.startSearch(tenantId, input, caller.userId);
    } catch (error) {
      if (error instanceof AppError) {
        throw error;
      }
      throw error;
    }

    if (options.recordAudit) {
      await options.recordAudit(auditEventFor("mail.historical_search.start", tenantId, job, caller.userId));
    }
    return {
      status: 202,
      headers: { "content-type": "application/json" },
      body: job,
    };
  };

  const getHandler = async (ctx: RequestContext): Promise<RouteResponse> => {
    const caller = requireCaller(options.resolveCaller, ctx);
    const tenantId = requireTenantParam(ctx);
    const jobId = requireJobParam(ctx);

    requireTenantInScope(caller, tenantId);
    await requireHistoricalSearchPermission(options, caller);

    let result: HistoricalSearchResult;
    try {
      result = await options.provider.getSearch(tenantId, jobId);
    } catch (error) {
      if (error instanceof AppError) {
        throw error;
      }
      const message = error instanceof Error ? error.message : "";
      if (/not.?found/i.test(message)) {
        throw historicalSearchNotFoundError(jobId);
      }
      throw error;
    }

    if (result.job.state === "succeeded" && options.recordAudit) {
      await options.recordAudit(
        auditEventFor("mail.historical_search.finish", tenantId, result.job, caller.userId),
      );
    }
    return {
      status: 200,
      headers: { "content-type": "application/json" },
      body: result,
    };
  };

  const cancelHandler = async (ctx: RequestContext): Promise<RouteResponse> => {
    const caller = requireCaller(options.resolveCaller, ctx);
    const tenantId = requireTenantParam(ctx);
    const jobId = requireJobParam(ctx);

    requireTenantInScope(caller, tenantId);
    await requireHistoricalSearchPermission(options, caller);

    let job: HistoricalSearchJob;
    try {
      job = await options.provider.cancelSearch(tenantId, jobId);
    } catch (error) {
      if (error instanceof AppError) {
        throw error;
      }
      const message = error instanceof Error ? error.message : "";
      if (/not.?found/i.test(message)) {
        throw historicalSearchNotFoundError(jobId);
      }
      if (/cancell?ed|completed|terminal|already/i.test(message)) {
        throw historicalSearchNotCancellableError(jobId, "terminal");
      }
      throw error;
    }

    if (options.recordAudit) {
      await options.recordAudit(auditEventFor("mail.historical_search.cancel", tenantId, job, caller.userId));
    }
    return {
      status: 200,
      headers: { "content-type": "application/json" },
      body: job,
    };
  };

  return [
    { method: "POST", path: HISTORICAL_SEARCH_PATH, handler: startHandler },
    { method: "GET", path: HISTORICAL_SEARCH_JOB_PATH, handler: getHandler },
    { method: "POST", path: HISTORICAL_SEARCH_CANCEL_PATH, handler: cancelHandler },
  ];
}

// Route modules own their OpenAPI path items (portal.v1.yaml `paths` is empty
// by design); a wiring ticket merges this fragment into the served document.
export const HISTORICAL_SEARCH_OPENAPI = {
  paths: {
    "/tenants/{tenantId}/mail/historical-search": {
      post: {
        operationId: "startHistoricalSearch",
        summary: "Enqueue a cancellable historical search across mailboxes",
        permission: HISTORICAL_SEARCH_PERMISSION,
        security: [{ bearerAuth: [] }],
        parameters: [
          { name: "tenantId", in: "path", required: true, schema: { type: "string" } },
        ],
        responses: {
          "202": { description: "The enqueued historical-search job with progress." },
          "400": { description: "The scoped search parameters are invalid." },
          "401": { description: "Authentication required." },
          "403": { description: "The caller lacks mailtools.search or the tenant is out of scope." },
        },
      },
    },
    "/tenants/{tenantId}/mail/historical-search/{jobId}": {
      get: {
        operationId: "getHistoricalSearch",
        summary: "Poll a historical search for progress or ephemeral results",
        permission: HISTORICAL_SEARCH_PERMISSION,
        security: [{ bearerAuth: [] }],
        parameters: [
          { name: "tenantId", in: "path", required: true, schema: { type: "string" } },
          { name: "jobId", in: "path", required: true, schema: { type: "string" } },
        ],
        responses: {
          "200": { description: "Job progress, or matches with the download reference when complete." },
          "401": { description: "Authentication required." },
          "403": { description: "The caller lacks mailtools.search or the tenant is out of scope." },
          "404": { description: "The historical search job was not found." },
        },
      },
    },
    "/tenants/{tenantId}/mail/historical-search/{jobId}/cancel": {
      post: {
        operationId: "cancelHistoricalSearch",
        summary: "Cancel an in-flight historical search",
        permission: HISTORICAL_SEARCH_PERMISSION,
        security: [{ bearerAuth: [] }],
        parameters: [
          { name: "tenantId", in: "path", required: true, schema: { type: "string" } },
          { name: "jobId", in: "path", required: true, schema: { type: "string" } },
        ],
        responses: {
          "200": { description: "The cancelled historical-search job." },
          "401": { description: "Authentication required." },
          "403": { description: "The caller lacks mailtools.search or the tenant is out of scope." },
          "404": { description: "The historical search job was not found." },
          "409": { description: "The job is terminal and cannot be cancelled." },
        },
      },
    },
  },
} as const;
