// Logbook (EPIC-037 SPEC.md §3.5, §4.4, §6, §7; T-0727).
// Read-only, admin-scoped projection over the append-only audit store: GET /v1/logbook
// filters by actor, action, tenant, result, and date range, paginates by cursor, and
// exports the filtered set as CSV or JSON. Requires the CIPP.Admin.* scope (SPEC §7);
// the tenant filter is intersected with the caller's tenant scope, never widened.
// Audit before/after blobs are never rendered: they can carry tenant configuration,
// so entries show identity, action, outcome, and correlation id only.
import { AppError, ErrorCodes } from "../errors.js";
import { paginate, parsePagination } from "../pagination.js";
import type { Caller } from "../rbac/authorize.js";
import type { RequestContext, Route, RouteResponse } from "../server.js";

export const LOGBOOK_PATH = "/v1/logbook";
export const LOGBOOK_ADMIN_SCOPE = "CIPP.Admin.*";
export const LOGBOOK_UNAUTHENTICATED = "request.unauthenticated";
export const LOGBOOK_FORBIDDEN = "auth.forbidden";

export type LogbookResult = "success" | "failure";
export type LogbookFormat = "json" | "csv";

export interface LogbookEntry {
  readonly id: string;
  readonly timestamp: string;
  readonly actor: string | null;
  readonly actorType: string;
  readonly tenantId: string | null;
  readonly action: string;
  readonly targetType: string | null;
  readonly targetId: string | null;
  readonly result: LogbookResult;
  readonly error: string | null;
  readonly correlationId: string | null;
}

export interface LogbookFilter {
  readonly actor?: string;
  readonly action?: string;
  readonly tenant?: string;
  readonly result?: LogbookResult;
  readonly from?: string;
  readonly to?: string;
  readonly cursor: string | null;
  readonly limit: number;
  readonly format: LogbookFormat;
}

export interface LogbookPage {
  readonly items: readonly LogbookEntry[];
  readonly nextCursor: string | null;
  readonly totalCount: number;
}

// Seam over the append-only audit store: the production wiring adapts the db
// repository's listAuditEvents (optionally tenant-filtered) to this shape.
export interface LogbookStore {
  listAuditEvents(): Promise<readonly LogbookEntry[]>;
}

export interface LogbookCaller extends Caller {
  readonly userId?: string;
}

export type LogbookAuthorizer = (
  caller: LogbookCaller,
  permission: string,
) => void | Promise<void>;

export interface LogbookRouteOptions {
  readonly store: LogbookStore;
  readonly resolveCaller: (ctx: RequestContext) => LogbookCaller | undefined;
  readonly authorize?: LogbookAuthorizer;
}

function unauthenticatedError(): AppError {
  return new AppError(LOGBOOK_UNAUTHENTICATED, "authentication required", 401);
}

function forbiddenError(): AppError {
  return new AppError(LOGBOOK_FORBIDDEN, `forbidden: requires ${LOGBOOK_ADMIN_SCOPE}`, 403);
}

function validationError(message: string, field: string): AppError {
  return new AppError(ErrorCodes.validationFailed, message, 400, [
    { field, reason: "invalid" },
  ]);
}

function requireCaller(
  resolveCaller: (ctx: RequestContext) => LogbookCaller | undefined,
  ctx: RequestContext,
): LogbookCaller {
  const caller = resolveCaller(ctx);
  if (caller === undefined) {
    throw unauthenticatedError();
  }
  return caller;
}

async function ensureAdmin(options: LogbookRouteOptions, caller: LogbookCaller): Promise<void> {
  if (options.authorize) {
    await options.authorize(caller, LOGBOOK_ADMIN_SCOPE);
    return;
  }
  const granted = caller.permissions ?? [];
  if (!granted.includes(LOGBOOK_ADMIN_SCOPE) && !granted.includes("*")) {
    throw forbiddenError();
  }
}

function optionalText(query: URLSearchParams, name: string): string | undefined {
  const value = query.get(name);
  if (value === null || value.length === 0) {
    return undefined;
  }
  return value;
}

function parseResult(value: string | undefined): LogbookResult | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (value !== "success" && value !== "failure") {
    throw validationError("result must be 'success' or 'failure'", "result");
  }
  return value;
}

function parseFormat(value: string | undefined): LogbookFormat {
  if (value === undefined || value === "json") {
    return "json";
  }
  if (value === "csv") {
    return "csv";
  }
  throw validationError("format must be 'json' or 'csv'", "format");
}

function parseDateBound(value: string | undefined, field: string): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (Number.isNaN(Date.parse(value))) {
    throw validationError(`${field} must be an ISO 8601 timestamp`, field);
  }
  return value;
}

export function parseLogbookFilter(query: URLSearchParams): LogbookFilter {
  const pagination = parsePagination(query);
  return {
    actor: optionalText(query, "actor"),
    action: optionalText(query, "action"),
    tenant: optionalText(query, "tenant"),
    result: parseResult(optionalText(query, "result")),
    from: parseDateBound(optionalText(query, "from"), "from"),
    to: parseDateBound(optionalText(query, "to"), "to"),
    cursor: pagination.cursor,
    limit: pagination.limit,
    format: parseFormat(optionalText(query, "format")),
  };
}

function matchesText(haystack: string | null, needle: string): boolean {
  return haystack !== null && haystack.toLowerCase().includes(needle.toLowerCase());
}

// Applies the query filters and the caller's tenant scope, newest first. A caller
// without `all` scope sees only events for their tenants; a tenant filter outside
// that scope intersects to empty rather than widening or erroring.
export function filterLogbookEntries(
  entries: readonly LogbookEntry[],
  filter: LogbookFilter,
  scope: { all: boolean; tenantIds: readonly string[] },
): LogbookEntry[] {
  const allowedTenants = scope.all ? null : new Set(scope.tenantIds);
  const actor = filter.actor?.toLowerCase();
  const action = filter.action?.toLowerCase();
  const visible: LogbookEntry[] = [];
  for (const entry of entries) {
    if (allowedTenants !== null && (entry.tenantId === null || !allowedTenants.has(entry.tenantId))) {
      continue;
    }
    if (filter.tenant !== undefined && entry.tenantId !== filter.tenant) {
      continue;
    }
    if (actor !== undefined && !matchesText(entry.actor, actor)) {
      continue;
    }
    if (action !== undefined && !matchesText(entry.action, action)) {
      continue;
    }
    if (filter.result !== undefined && entry.result !== filter.result) {
      continue;
    }
    if (filter.from !== undefined && entry.timestamp < filter.from) {
      continue;
    }
    if (filter.to !== undefined && entry.timestamp > filter.to) {
      continue;
    }
    visible.push(entry);
  }
  return visible.sort(
    (left, right) => right.timestamp.localeCompare(left.timestamp) || right.id.localeCompare(left.id),
  );
}

function csvEscape(value: string): string {
  if (/[",\r\n]/.test(value)) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}

function csvCell(value: string | null): string {
  return value === null ? "" : csvEscape(value);
}

export function toLogbookCsv(entries: readonly LogbookEntry[]): string {
  const header = "Timestamp,Actor,ActorType,Tenant,Action,TargetType,TargetId,Result,Error,CorrelationId";
  const lines = entries.map((entry) =>
    [
      entry.timestamp,
      entry.actor,
      entry.actorType,
      entry.tenantId,
      entry.action,
      entry.targetType,
      entry.targetId,
      entry.result,
      entry.error,
      entry.correlationId,
    ]
      .map(csvCell)
      .join(","),
  );
  return [header, ...lines].join("\r\n");
}

export function createLogbookRoutes(options: LogbookRouteOptions): Route[] {
  const handler = async (ctx: RequestContext): Promise<RouteResponse> => {
    const caller = requireCaller(options.resolveCaller, ctx);
    await ensureAdmin(options, caller);

    const filter = parseLogbookFilter(ctx.query);
    const entries = await options.store.listAuditEvents();
    const matches = filterLogbookEntries(entries, filter, caller.tenantScope);

    if (filter.format === "csv") {
      return {
        status: 200,
        contentType: "text/csv",
        raw: toLogbookCsv(matches),
      };
    }

    const page = paginate(matches, filter);
    const body: LogbookPage = {
      items: page.items,
      nextCursor: page.nextCursor,
      totalCount: matches.length,
    };
    return {
      status: 200,
      headers: { "content-type": "application/json" },
      body,
    };
  };

  return [{ method: "GET", path: LOGBOOK_PATH, handler }];
}

// Route modules own their OpenAPI path items (portal.v1.yaml `paths` is empty
// by design); a wiring ticket merges this fragment into the served document.
export const LOGBOOK_OPENAPI = {
  paths: {
    "/logbook": {
      get: {
        operationId: "listLogbook",
        summary: "Search the logbook with actor, action, tenant, result, and date filters",
        permission: LOGBOOK_ADMIN_SCOPE,
        security: [{ bearerAuth: [] }],
        parameters: [
          { name: "actor", in: "query", required: false, schema: { type: "string" } },
          { name: "action", in: "query", required: false, schema: { type: "string" } },
          { name: "tenant", in: "query", required: false, schema: { type: "string" } },
          {
            name: "result",
            in: "query",
            required: false,
            schema: { type: "string", enum: ["success", "failure"] },
          },
          { name: "from", in: "query", required: false, schema: { type: "string", format: "date-time" } },
          { name: "to", in: "query", required: false, schema: { type: "string", format: "date-time" } },
          { name: "cursor", in: "query", required: false, schema: { type: "string" } },
          { name: "limit", in: "query", required: false, schema: { type: "integer" } },
          {
            name: "format",
            in: "query",
            required: false,
            schema: { type: "string", enum: ["json", "csv"] },
          },
        ],
        responses: {
          "200": {
            description:
              "A cursor page of audit entries, or the complete filtered set as CSV when format=csv.",
          },
          "400": { description: "A filter value is invalid." },
          "401": { description: "Authentication required." },
          "403": { description: "The caller lacks the CIPP.Admin.* scope." },
        },
      },
    },
  },
} as const;
