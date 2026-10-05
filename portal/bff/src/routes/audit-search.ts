// Manual audit-log search and directory audits (EPIC-032 SPEC.md §3.1, §3.4,
// §4.1, §6, §7, §8, §11.1; T-0622). Exposes POST
// /v1/tenants/:tenantId/audit/search — a manual search with per-workload
// routing (Graph directoryAudits/signIns where those endpoints cover the
// workload, Purview audit search for content workloads) — and GET
// /v1/tenants/:tenantId/audit/directory for Graph directoryAudits with
// category/date filters. Results are ephemeral (§4.1): the route persists
// nothing except the AuditEvent every search and export writes (SPEC §8) —
// the search path fails when that write fails. Search and export are
// sensitive: both require the elevated `Security.AuditSearch.ReadWrite` permission (SPEC §7)
// intersected with the caller tenant scope; directory view requires
// `Security.Audit.Read`.
import { randomUUID } from "node:crypto";
import type { SqliteRepository } from "@m365-assess/db";
import { AppError, ErrorCodes } from "../errors.js";
import { requireTenantInScope, type Caller } from "../rbac/authorize.js";
import type { RequestContext, Route, RouteResponse } from "../server.js";

export const AUDIT_SEARCH_PATH = "/v1/tenants/:tenantId/audit/search";
export const AUDIT_DIRECTORY_PATH = "/v1/tenants/:tenantId/audit/directory";
export const AUDIT_SEARCH_PERMISSION = "Security.AuditSearch.ReadWrite";
export const AUDIT_READ_PERMISSION = "Security.Audit.Read";
export const AUDIT_SEARCH_UNAUTHENTICATED = "request.unauthenticated";
export const AUDIT_SEARCH_INVALID_WORKLOAD = "audit-search.invalid_workload";

export const AUDIT_SEARCH_WORKLOADS = [
  "Exchange",
  "SharePoint",
  "OneDrive",
  "Directory",
  "SignIn",
] as const;
export type AuditSearchWorkload = (typeof AUDIT_SEARCH_WORKLOADS)[number];

export const AUDIT_DIRECTORY_CATEGORIES = [
  "UserManagement",
  "GroupManagement",
  "ApplicationManagement",
  "RoleManagement",
  "DirectoryManagement",
  "PolicyManagement",
  "ResourceManagement",
] as const;
export type AuditDirectoryCategory = (typeof AUDIT_DIRECTORY_CATEGORIES)[number];

export interface AuditSearchInput {
  readonly startDate?: string;
  readonly endDate?: string;
  readonly user?: string;
  readonly activity?: string;
  readonly workloads?: readonly string[];
  readonly ip?: string;
  readonly top?: number;
  readonly format?: "json" | "csv";
}

export interface AuditDirectoryInput {
  readonly category?: string;
  readonly startDate?: string;
  readonly endDate?: string;
  readonly top?: number;
}

export interface AuditSearchResultItem {
  readonly timestamp: string;
  readonly user: string;
  readonly activity: string;
  readonly workload: string;
  readonly object: string;
  readonly result: string;
}

export interface AuditSearchRun {
  readonly searchId: string;
  readonly tenantId: string;
  readonly workloads: readonly string[];
  readonly totalCount: number;
  readonly results: readonly AuditSearchResultItem[];
}

export interface AuditDirectoryEntry {
  readonly timestamp: string;
  readonly activity: string;
  readonly initiatedBy: string;
  readonly target: string;
  readonly result: string;
}

export interface AuditDirectoryRun {
  readonly tenantId: string;
  readonly category: string;
  readonly totalCount: number;
  readonly entries: readonly AuditDirectoryEntry[];
}

export interface AuditSearchAuditEvent {
  readonly id: string;
  readonly tenantId: string;
  readonly action: "audit.search" | "audit.search.export";
  readonly targetId: string;
  readonly actor?: string;
  readonly timestamp: string;
  readonly detail: Record<string, unknown>;
}

// Queue-backed seam for the audit-search jobs: the production wiring
// dispatches a search-audit worker job per call and serves the worker
// result. Depending on the seam keeps Graph/Purview and process code out of
// the BFF. Only the AuditEvent persists through the repository — audit
// records themselves are never stored.
export interface AuditSearchProvider {
  search(tenantId: string, input: AuditSearchInput): Promise<AuditSearchRun>;
  listDirectory(tenantId: string, input: AuditDirectoryInput): Promise<AuditDirectoryRun>;
}

export interface AuditSearchCaller extends Caller {
  readonly userId?: string;
}

export type AuditSearchAuthorizer = (
  caller: AuditSearchCaller,
  permission: string,
) => void | Promise<void>;

export type AuditEventStore = Pick<SqliteRepository, "appendAuditEvent">;

export interface AuditSearchRouteOptions {
  readonly provider: AuditSearchProvider;
  readonly audit: AuditEventStore;
  readonly resolveCaller: (ctx: RequestContext) => AuditSearchCaller | undefined;
  readonly authorize?: AuditSearchAuthorizer;
}

function unauthenticatedError(): AppError {
  return new AppError(AUDIT_SEARCH_UNAUTHENTICATED, "authentication required", 401);
}

function validationError(message: string, field: string): AppError {
  return new AppError(ErrorCodes.validationFailed, message, 400, [
    { field, reason: "invalid" },
  ]);
}

function requireCaller(
  resolveCaller: (ctx: RequestContext) => AuditSearchCaller | undefined,
  ctx: RequestContext,
): AuditSearchCaller {
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

async function requireAuditSearchPermission(
  options: AuditSearchRouteOptions,
  caller: AuditSearchCaller,
): Promise<void> {
  if (options.authorize) {
    await options.authorize(caller, AUDIT_SEARCH_PERMISSION);
    return;
  }
  const permissions = caller.permissions ?? [];
  if (!permissions.includes(AUDIT_SEARCH_PERMISSION) && !permissions.includes("*")) {
    throw new AppError(ErrorCodes.forbidden, "forbidden: missing Security.AuditSearch.ReadWrite", 403);
  }
}

async function requireAuditReadPermission(
  options: AuditSearchRouteOptions,
  caller: AuditSearchCaller,
): Promise<void> {
  if (options.authorize) {
    await options.authorize(caller, AUDIT_READ_PERMISSION);
    return;
  }
  const permissions = caller.permissions ?? [];
  if (!permissions.includes(AUDIT_READ_PERMISSION) && !permissions.includes("*")) {
    throw new AppError(ErrorCodes.forbidden, "forbidden: missing Security.Audit.Read", 403);
  }
}

function readBodyRecord(ctx: RequestContext): Record<string, unknown> {
  return (ctx.body ?? {}) as Record<string, unknown>;
}

export function parseAuditSearchInput(body: Record<string, unknown>): AuditSearchInput {
  const input: {
    startDate?: string;
    endDate?: string;
    user?: string;
    activity?: string;
    workloads?: readonly string[];
    ip?: string;
    top?: number;
    format?: "json" | "csv";
  } = {};

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
  if (
    input.startDate !== undefined &&
    input.endDate !== undefined &&
    Date.parse(input.startDate) > Date.parse(input.endDate)
  ) {
    throw validationError("startDate must not be after endDate", "startDate");
  }

  for (const field of ["user", "activity", "ip"] as const) {
    const value = body[field];
    if (value !== undefined) {
      if (typeof value !== "string" || value.trim().length === 0) {
        throw validationError(`${field} must be a non-empty string`, field);
      }
      input[field] = value.trim();
    }
  }

  const workloads = body["workloads"];
  if (workloads !== undefined) {
    if (
      !Array.isArray(workloads) ||
      workloads.some((entry) => typeof entry !== "string" || entry.trim().length === 0)
    ) {
      throw validationError("workloads must be an array of non-empty strings", "workloads");
    }
    const canonical: string[] = [];
    for (const entry of workloads as string[]) {
      const known = AUDIT_SEARCH_WORKLOADS.find(
        (name) => name.toLowerCase() === entry.trim().toLowerCase(),
      );
      if (!known) {
        throw new AppError(
          AUDIT_SEARCH_INVALID_WORKLOAD,
          `workload '${entry.trim()}' is not supported`,
          400,
          [{ field: "workloads", reason: "invalid" }],
        );
      }
      if (!canonical.includes(known)) {
        canonical.push(known);
      }
    }
    input.workloads = canonical;
  }

  const top = body["top"];
  if (top !== undefined) {
    if (typeof top !== "number" || !Number.isInteger(top) || top < 1 || top > 1000) {
      throw validationError("top must be an integer between 1 and 1000", "top");
    }
    input.top = top;
  }

  const format = body["format"];
  if (format !== undefined) {
    if (format !== "json" && format !== "csv") {
      throw validationError("format must be 'json' or 'csv'", "format");
    }
    input.format = format;
  }

  return input;
}

export function parseAuditDirectoryInput(query: URLSearchParams): AuditDirectoryInput {
  const input: {
    category?: string;
    startDate?: string;
    endDate?: string;
    top?: number;
  } = {};

  const category = query.get("category");
  if (category !== null && category.trim().length > 0) {
    const canonical = AUDIT_DIRECTORY_CATEGORIES.find(
      (known) => known.toLowerCase() === category.trim().toLowerCase(),
    );
    if (!canonical) {
      throw validationError(
        `category must be one of: ${AUDIT_DIRECTORY_CATEGORIES.join(", ")}`,
        "category",
      );
    }
    input.category = canonical;
  }

  for (const field of ["startDate", "endDate"] as const) {
    const value = query.get(field);
    if (value !== null && value.trim().length > 0) {
      if (Number.isNaN(Date.parse(value))) {
        throw validationError(`${field} must be a parseable datetime`, field);
      }
      input[field] = value.trim();
    }
  }
  if (
    input.startDate !== undefined &&
    input.endDate !== undefined &&
    Date.parse(input.startDate) > Date.parse(input.endDate)
  ) {
    throw validationError("startDate must not be after endDate", "startDate");
  }

  const top = query.get("top");
  if (top !== null && top.trim().length > 0) {
    const parsed = Number(top);
    if (!Number.isInteger(parsed) || parsed < 1 || parsed > 1000) {
      throw validationError("top must be an integer between 1 and 1000", "top");
    }
    input.top = parsed;
  }

  return input;
}

function csvEscape(value: string): string {
  if (/[",\r\n]/.test(value)) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}

function toAuditSearchCsv(results: readonly AuditSearchResultItem[]): string {
  const header = "Timestamp,User,Activity,Workload,Object,Result";
  const lines = results.map((row) =>
    [row.timestamp, row.user, row.activity, row.workload, row.object, row.result]
      .map(csvEscape)
      .join(","),
  );
  return [header, ...lines].join("\r\n");
}

async function recordSearchAuditEvent(
  options: AuditSearchRouteOptions,
  ctx: RequestContext,
  caller: AuditSearchCaller,
  tenantId: string,
  run: AuditSearchRun,
  input: AuditSearchInput,
): Promise<void> {
  const event: AuditSearchAuditEvent = {
    id: randomUUID(),
    tenantId,
    action: input.format === "csv" ? "audit.search.export" : "audit.search",
    targetId: run.searchId,
    actor: caller.userId,
    timestamp: new Date().toISOString(),
    detail: {
      workloads: run.workloads,
      filters: {
        startDate: input.startDate ?? null,
        endDate: input.endDate ?? null,
        user: input.user ?? null,
        activity: input.activity ?? null,
        ip: input.ip ?? null,
      },
      format: input.format ?? "json",
      resultCount: run.totalCount,
    },
  };
  await options.audit.appendAuditEvent({
    id: event.id,
    timestamp: event.timestamp,
    actorUserId: caller.userId ?? null,
    actorType: "user",
    tenantId,
    action: event.action,
    targetType: "audit_search",
    targetId: event.targetId,
    before: null,
    after: event.detail,
    result: "success",
    error: null,
    source: "request",
    correlationId: ctx.correlationId,
  });
}

export function createAuditSearchRoutes(options: AuditSearchRouteOptions): Route[] {
  const searchHandler = async (ctx: RequestContext): Promise<RouteResponse> => {
    const caller = requireCaller(options.resolveCaller, ctx);
    const tenantId = requireTenantParam(ctx);

    requireTenantInScope(caller, tenantId);
    await requireAuditSearchPermission(options, caller);

    const input = parseAuditSearchInput(readBodyRecord(ctx));
    const run = await options.provider.search(tenantId, input);
    await recordSearchAuditEvent(options, ctx, caller, tenantId, run, input);

    if (input.format === "csv") {
      return {
        status: 200,
        contentType: "text/csv",
        raw: toAuditSearchCsv(run.results),
      };
    }
    return {
      status: 200,
      headers: { "content-type": "application/json" },
      body: run,
    };
  };

  const directoryHandler = async (ctx: RequestContext): Promise<RouteResponse> => {
    const caller = requireCaller(options.resolveCaller, ctx);
    const tenantId = requireTenantParam(ctx);

    requireTenantInScope(caller, tenantId);
    await requireAuditReadPermission(options, caller);

    const input = parseAuditDirectoryInput(ctx.query);
    const run = await options.provider.listDirectory(tenantId, input);
    return {
      status: 200,
      headers: { "content-type": "application/json" },
      body: run,
    };
  };

  return [
    { method: "POST", path: AUDIT_SEARCH_PATH, handler: searchHandler },
    { method: "GET", path: AUDIT_DIRECTORY_PATH, handler: directoryHandler },
  ];
}

// Route modules own their OpenAPI path items (portal.v1.yaml `paths` is empty
// by design); a wiring ticket merges this fragment into the served document.
export const AUDIT_SEARCH_OPENAPI = {
  paths: {
    "/tenants/{tenantId}/audit/search": {
      post: {
        operationId: "searchAuditLog",
        summary: "Run a manual audit-log search with per-workload routing",
        permission: AUDIT_SEARCH_PERMISSION,
        security: [{ bearerAuth: [] }],
        parameters: [
          { name: "tenantId", in: "path", required: true, schema: { type: "string" } },
        ],
        responses: {
          "200": {
            description:
              "Normalised audit records (SPEC §3.1 columns), or CSV when format is csv.",
          },
          "400": { description: "The scoped search filters are invalid." },
          "401": { description: "Authentication required." },
          "403": {
            description: "The caller lacks Security.AuditSearch.ReadWrite or the tenant is out of scope.",
          },
        },
      },
    },
    "/tenants/{tenantId}/audit/directory": {
      get: {
        operationId: "listAuditDirectory",
        summary: "List directory audits with category and date filters",
        permission: AUDIT_READ_PERMISSION,
        security: [{ bearerAuth: [] }],
        parameters: [
          { name: "tenantId", in: "path", required: true, schema: { type: "string" } },
          { name: "category", in: "query", required: false, schema: { type: "string" } },
          { name: "startDate", in: "query", required: false, schema: { type: "string" } },
          { name: "endDate", in: "query", required: false, schema: { type: "string" } },
          { name: "top", in: "query", required: false, schema: { type: "integer" } },
        ],
        responses: {
          "200": {
            description: "Directory audit entries (SPEC §3.4 columns), newest first.",
          },
          "400": { description: "A filter is invalid." },
          "401": { description: "Authentication required." },
          "403": {
            description: "The caller lacks Security.Audit.Read or the tenant is out of scope.",
          },
        },
      },
    },
  },
} as const;
