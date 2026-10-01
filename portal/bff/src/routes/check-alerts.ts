// Check-alert read API (EPIC-028 SPEC.md §2 US-5, §3.4, §4.3, §6, §11 item 3;
// T-0549). Exposes GET /v1/check-alerts returning the module's own check-alert
// findings so analysts see portal-detected issues alongside the tenant alerts
// served by T-0548. The surface is module-wide, not tenant-scoped, and validates
// authentication only. It is read-only: snooze/resolve and auto-incident
// creation are deferred to EPIC-029, so this module has no store, no executor,
// and no write path.
import { AppError, ErrorCodes } from "../errors.js";
import { parsePagination } from "../pagination.js";
import type { Caller } from "../rbac/authorize.js";
import type { RequestContext, Route, RouteResponse } from "../server.js";

export const CHECK_ALERTS_PATH = "/v1/check-alerts";

export const CHECK_ALERTS_UNAUTHENTICATED = "request.unauthenticated";

// The module's finding vocabulary (FindingStatus/Severity in @m365-assess/db);
// a check alert is a finding that warrants analyst attention.
export const CHECK_ALERT_STATUSES = ["Fail", "Warning", "Review", "Info"] as const;
export type CheckAlertStatus = (typeof CHECK_ALERT_STATUSES)[number];

export const CHECK_ALERT_SEVERITIES = ["Critical", "High", "Medium", "Low", "Info"] as const;
export type CheckAlertSeverity = (typeof CHECK_ALERT_SEVERITIES)[number];

/** One module check alert: a non-passing check finding plus its remediation. */
export interface CheckAlert {
  readonly id: string;
  readonly checkId: string;
  readonly title: string;
  readonly category: string | null;
  readonly severity: CheckAlertSeverity;
  readonly status: CheckAlertStatus;
  readonly entity: string | null;
  readonly created: string;
  readonly remediation: string | null;
}

export interface CheckAlertsFilter {
  readonly severity?: CheckAlertSeverity;
  readonly status?: CheckAlertStatus;
  readonly cursor: string | null;
  readonly limit: number;
}

export interface CheckAlertsPage {
  readonly totalCount: number;
  readonly items: readonly CheckAlert[];
  readonly nextCursor: string | null;
}

// Read seam: the production wiring backs this with the module's check findings.
// There is deliberately no write seam — check alerts cannot be mutated here.
export interface CheckAlertsProvider {
  listCheckAlerts(filter: CheckAlertsFilter): Promise<CheckAlertsPage>;
}

export interface CheckAlertsRouteOptions {
  readonly provider: CheckAlertsProvider;
  readonly resolveCaller: (ctx: RequestContext) => Caller | undefined;
}

function unauthenticatedError(): AppError {
  return new AppError(CHECK_ALERTS_UNAUTHENTICATED, "authentication required", 401);
}

function validationError(message: string, field: string): AppError {
  return new AppError(ErrorCodes.validationFailed, message, 400, [
    { field, reason: "invalid" },
  ]);
}

function optionalText(query: URLSearchParams, name: string): string | undefined {
  const value = query.get(name);
  if (value === null || value.length === 0) {
    return undefined;
  }
  return value;
}

function parseEnumParam<T extends string>(
  query: URLSearchParams,
  name: string,
  allowed: readonly T[],
): T | undefined {
  const value = optionalText(query, name);
  if (value === undefined) {
    return undefined;
  }
  const match = allowed.find((entry) => entry.toLowerCase() === value.toLowerCase());
  if (match === undefined) {
    throw validationError(`${name} must be one of: ${allowed.join(", ")}`, name);
  }
  return match;
}

export function parseCheckAlertsFilter(query: URLSearchParams): CheckAlertsFilter {
  const pagination = parsePagination(query);
  return {
    severity: parseEnumParam(query, "severity", CHECK_ALERT_SEVERITIES),
    status: parseEnumParam(query, "status", CHECK_ALERT_STATUSES),
    cursor: pagination.cursor,
    limit: pagination.limit,
  };
}

export function createCheckAlertsRoutes(options: CheckAlertsRouteOptions): Route[] {
  async function handleList(ctx: RequestContext): Promise<RouteResponse> {
    const caller = options.resolveCaller(ctx);
    if (caller === undefined) {
      throw unauthenticatedError();
    }

    const filter = parseCheckAlertsFilter(ctx.query);
    const page = await options.provider.listCheckAlerts(filter);

    return {
      status: 200,
      headers: { "content-type": "application/json" },
      body: page,
    };
  }

  return [{ method: "GET", path: CHECK_ALERTS_PATH, handler: handleList }];
}

// Route modules own their OpenAPI path items (portal.v1.yaml `paths` is empty
// by design); a wiring ticket merges this fragment into the served document.
export const CHECK_ALERTS_OPENAPI = {
  paths: {
    "/check-alerts": {
      get: {
        operationId: "listCheckAlerts",
        summary:
          "List the module's own check-alert findings (§3.4) alongside tenant alerts; module-wide, read-only",
        security: [{ bearerAuth: [] }],
        parameters: [
          {
            name: "severity",
            in: "query",
            required: false,
            schema: { type: "string", enum: [...CHECK_ALERT_SEVERITIES] },
          },
          {
            name: "status",
            in: "query",
            required: false,
            schema: { type: "string", enum: [...CHECK_ALERT_STATUSES] },
          },
          { name: "cursor", in: "query", required: false, schema: { type: "string" } },
          { name: "limit", in: "query", required: false, schema: { type: "integer" } },
        ],
        responses: {
          "200": {
            description:
              "The module's check-alert page. Check alerts carry no triage actions here; snooze/resolve and auto-incident creation are EPIC-029.",
          },
          "400": { description: "A query parameter is invalid." },
          "401": { description: "Authentication is required." },
        },
      },
    },
  },
} as const;
