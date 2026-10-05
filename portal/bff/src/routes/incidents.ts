// Incident list API (EPIC-028 SPEC.md §2 US-1, §3.1, §4.2, §6, §7; T-0543).
// Exposes GET /v1/tenants/:tenantId/incidents with the §3.1 columns:
// Title, Severity, Status, Classification, Assigned to, Alerts, Last updated, Tenant
// and filters (severity, status, classification, assigned, date, tenant).
// The all-tenants view (GET /v1/incidents?tenants=a,b) aggregates open incidents
// by severity across only the tenants in the caller's RBAC scope (SPEC §4.2).
// Incidents are read live by the worker from Graph/Defender (SPEC §5, §7); this
// route performs no Graph call directly and no writes.
// Requires RBAC `Security.Incident.Read` and tenant in caller scope.
import { AppError, ErrorCodes } from "../errors.js";
import { MAX_PAGE_LIMIT, parsePagination } from "../pagination.js";
import { requireTenantInScope, type Caller } from "../rbac/authorize.js";
import { intersectTenantScope } from "../rbac/scope.js";
import type { RequestContext, Route, RouteResponse } from "../server.js";

export const INCIDENTS_PATH = "/v1/tenants/:tenantId/incidents";
export const INCIDENTS_ALL_PATH = "/v1/incidents";
export const INCIDENTS_READ_PERMISSION = "Security.Incident.Read";
export const INCIDENTS_UNAUTHENTICATED = "request.unauthenticated";

export const INCIDENT_SEVERITIES = [
  "unknown",
  "informational",
  "low",
  "medium",
  "high",
] as const;

export type IncidentSeverity = (typeof INCIDENT_SEVERITIES)[number];

export interface IncidentItem {
  readonly id: string;
  readonly title: string;
  readonly severity: IncidentSeverity;
  readonly status: string;
  readonly classification: string;
  readonly assignedTo: string;
  readonly alertCount: number;
  readonly lastUpdated: string;
  readonly tenantId: string;
}

export interface IncidentsFilter {
  readonly severity?: IncidentSeverity;
  readonly status?: string;
  readonly classification?: string;
  readonly assigned?: string;
  readonly from?: string;
  readonly to?: string;
  readonly cursor: string | null;
  readonly limit: number;
}

export interface IncidentsPage {
  readonly tenantId: string;
  readonly totalCount: number;
  readonly items: readonly IncidentItem[];
  readonly nextCursor: string | null;
}

export interface IncidentsAggregate {
  readonly tenants: readonly string[];
  readonly totalOpen: number;
  readonly bySeverity: Record<string, number>;
  readonly items: readonly IncidentItem[];
  readonly nextCursor: string | null;
}

export interface IncidentsProvider {
  listIncidents(tenantId: string, filter: IncidentsFilter): Promise<IncidentsPage>;
}

export interface IncidentsCaller extends Caller {
  readonly userId?: string;
}

export type IncidentsAuthorizer = (
  caller: IncidentsCaller,
  permission: string,
) => void | Promise<void>;

export interface IncidentsRouteOptions {
  readonly provider: IncidentsProvider;
  readonly resolveCaller: (ctx: RequestContext) => IncidentsCaller | undefined;
  readonly authorize?: IncidentsAuthorizer;
}

function unauthenticatedError(): AppError {
  return new AppError(INCIDENTS_UNAUTHENTICATED, "authentication required", 401);
}

function validationError(message: string, field: string): AppError {
  return new AppError(ErrorCodes.validationFailed, message, 400, [
    { field, reason: "invalid" },
  ]);
}

function requireCaller(
  resolveCaller: (ctx: RequestContext) => IncidentsCaller | undefined,
  ctx: RequestContext,
): IncidentsCaller {
  const caller = resolveCaller(ctx);
  if (caller === undefined) {
    throw unauthenticatedError();
  }
  return caller;
}

async function ensureRead(
  options: IncidentsRouteOptions,
  caller: IncidentsCaller,
): Promise<void> {
  if (options.authorize) {
    await options.authorize(caller, INCIDENTS_READ_PERMISSION);
    return;
  }
  const permissions = caller.permissions ?? [];
  if (!permissions.includes(INCIDENTS_READ_PERMISSION) && !permissions.includes("*")) {
    throw new AppError(ErrorCodes.forbidden, "forbidden: missing Security.Incident.Read", 403);
  }
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

function optionalText(query: URLSearchParams, name: string): string | undefined {
  const value = query.get(name);
  if (value === null || value.length === 0) {
    return undefined;
  }
  return value;
}

function parseSeverity(query: URLSearchParams): IncidentSeverity | undefined {
  const value = optionalText(query, "severity");
  if (value === undefined) {
    return undefined;
  }
  if (!(INCIDENT_SEVERITIES as readonly string[]).includes(value)) {
    throw validationError(
      `severity must be one of: ${INCIDENT_SEVERITIES.join(", ")}`,
      "severity",
    );
  }
  return value as IncidentSeverity;
}

function parseDateParam(query: URLSearchParams, name: string): string | undefined {
  const value = optionalText(query, name);
  if (value === undefined) {
    return undefined;
  }
  if (Number.isNaN(Date.parse(value))) {
    throw validationError(`${name} must be a valid date-time`, name);
  }
  return value;
}

export function parseIncidentsFilter(query: URLSearchParams): IncidentsFilter {
  const pagination = parsePagination(query);
  return {
    severity: parseSeverity(query),
    status: optionalText(query, "status"),
    classification: optionalText(query, "classification"),
    assigned: optionalText(query, "assigned"),
    from: parseDateParam(query, "from"),
    to: parseDateParam(query, "to"),
    cursor: pagination.cursor,
    limit: pagination.limit,
  };
}

function parseRequestedTenants(query: URLSearchParams): string[] {
  const value = optionalText(query, "tenants") ?? optionalText(query, "tenant");
  if (value === undefined) {
    return [];
  }
  return value
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

/** An incident counts as open unless its status is resolved or closed. */
export function isOpenIncident(item: Pick<IncidentItem, "status">): boolean {
  const status = item.status.trim().toLowerCase();
  return status !== "resolved" && status !== "closed";
}

export function buildSeverityAggregate(
  items: readonly IncidentItem[],
): Record<string, number> {
  const bySeverity: Record<string, number> = {};
  for (const item of items) {
    bySeverity[item.severity] = (bySeverity[item.severity] ?? 0) + 1;
  }
  return bySeverity;
}

async function listAllFiltered(
  provider: IncidentsProvider,
  tenantId: string,
  filter: IncidentsFilter,
): Promise<IncidentItem[]> {
  const items: IncidentItem[] = [];
  let cursor: string | null = null;
  for (;;) {
    const page = await provider.listIncidents(tenantId, {
      ...filter,
      cursor,
      limit: MAX_PAGE_LIMIT,
    });
    items.push(...page.items);
    if (page.nextCursor === null) {
      return items;
    }
    cursor = page.nextCursor;
  }
}

export function createIncidentsRoutes(options: IncidentsRouteOptions): Route[] {
  async function handleList(ctx: RequestContext): Promise<RouteResponse> {
    const caller = requireCaller(options.resolveCaller, ctx);
    const tenantId = requireTenantParam(ctx);

    requireTenantInScope(caller, tenantId);
    await ensureRead(options, caller);

    const filter = parseIncidentsFilter(ctx.query);
    const page = await options.provider.listIncidents(tenantId, filter);

    return {
      status: 200,
      headers: { "content-type": "application/json" },
      body: page,
    };
  }

  async function handleAggregate(ctx: RequestContext): Promise<RouteResponse> {
    const caller = requireCaller(options.resolveCaller, ctx);
    await ensureRead(options, caller);

    const requested = parseRequestedTenants(ctx.query);
    const tenants =
      requested.length > 0
        ? intersectTenantScope(caller.tenantScope, requested)
        : [...caller.tenantScope.tenantIds];

    const filter = parseIncidentsFilter(ctx.query);
    const merged: IncidentItem[] = [];
    for (const tenantId of tenants) {
      const items = await listAllFiltered(options.provider, tenantId, filter);
      for (const item of items) {
        if (isOpenIncident(item)) {
          merged.push(item);
        }
      }
    }
    merged.sort((left, right) => right.lastUpdated.localeCompare(left.lastUpdated));

    const start =
      filter.cursor === null ? 0 : decodeAggregateCursor(filter.cursor);
    const page = merged.slice(start, start + filter.limit);
    const nextOffset = start + page.length;

    const aggregate: IncidentsAggregate = {
      tenants,
      totalOpen: merged.length,
      bySeverity: buildSeverityAggregate(merged),
      items: page,
      nextCursor: nextOffset < merged.length ? encodeAggregateCursor(nextOffset) : null,
    };
    return {
      status: 200,
      headers: { "content-type": "application/json" },
      body: aggregate,
    };
  }

  return [
    { method: "GET", path: INCIDENTS_ALL_PATH, handler: handleAggregate },
    { method: "GET", path: INCIDENTS_PATH, handler: handleList },
  ];
}

function encodeAggregateCursor(offset: number): string {
  return Buffer.from(`offset:${offset}`, "utf8").toString("base64url");
}

function decodeAggregateCursor(cursor: string): number {
  try {
    const decoded = Buffer.from(cursor, "base64url").toString("utf8");
    const match = /^offset:(\d+)$/.exec(decoded);
    if (!match) {
      return 0;
    }
    const offset = Number(match[1]);
    return Number.isInteger(offset) && offset >= 0 ? offset : 0;
  } catch {
    return 0;
  }
}

export const INCIDENTS_OPENAPI = {
  paths: {
    "/tenants/{tenantId}/incidents": {
      get: {
        operationId: "listIncidents",
        summary: "List security incidents with §3.1 columns, filters, and cursor pagination",
        permission: INCIDENTS_READ_PERMISSION,
        security: [{ bearerAuth: [] }],
        parameters: [
          { name: "tenantId", in: "path", required: true, schema: { type: "string" } },
          {
            name: "severity",
            in: "query",
            required: false,
            schema: { type: "string", enum: [...INCIDENT_SEVERITIES] },
          },
          { name: "status", in: "query", required: false, schema: { type: "string" } },
          {
            name: "classification",
            in: "query",
            required: false,
            schema: { type: "string" },
          },
          { name: "assigned", in: "query", required: false, schema: { type: "string" } },
          { name: "from", in: "query", required: false, schema: { type: "string" } },
          { name: "to", in: "query", required: false, schema: { type: "string" } },
          { name: "cursor", in: "query", required: false, schema: { type: "string" } },
          { name: "limit", in: "query", required: false, schema: { type: "integer" } },
        ],
        responses: {
          "200": { description: "The tenant's filtered incident page." },
          "400": { description: "A path or query parameter is invalid." },
          "401": { description: "Authentication is required." },
          "403": { description: "The caller lacks the Security.Incident.Read permission." },
        },
      },
    },
    "/incidents": {
      get: {
        operationId: "aggregateIncidents",
        summary: "Aggregate open incidents by severity across tenants in caller scope",
        permission: INCIDENTS_READ_PERMISSION,
        security: [{ bearerAuth: [] }],
        parameters: [
          {
            name: "tenants",
            in: "query",
            required: false,
            schema: { type: "string" },
            description: "Comma-separated tenant ids, intersected with caller scope.",
          },
        ],
        responses: {
          "200": { description: "Open incidents aggregated by severity." },
          "401": { description: "Authentication is required." },
          "403": { description: "The caller lacks the Security.Incident.Read permission." },
        },
      },
    },
  },
} as const;
