// Incident detail API (EPIC-028 SPEC.md §2 US-2, §3.2, §6; T-0545).
// Exposes GET /v1/tenants/:tenantId/incidents/:incidentId with the §3.2 tab
// data: Overview, Alerts (T-0542 normalized), Entities, Timeline, Notes.
// Portal notes and triage state changes (T-0541) are merged by the provider.
// Requires RBAC `incidents.read` and tenant in caller scope.
import { AppError, ErrorCodes } from "../errors.js";
import { requireTenantInScope, type Caller } from "../rbac/authorize.js";
import type { RequestContext, Route, RouteResponse } from "../server.js";

export const INCIDENT_DETAIL_PATH = "/v1/tenants/:tenantId/incidents/:incidentId";
export const INCIDENT_DETAIL_READ_PERMISSION = "incidents.read";
export const INCIDENT_NOT_FOUND_CODE = "incident.not_found";

export interface IncidentOverview {
  readonly incidentId: string;
  readonly title: string;
  readonly severity: string;
  readonly status: string;
  readonly classification: string;
  readonly assignee: string;
  readonly created: string;
  readonly lastUpdated: string;
  readonly webUrl: string;
}

export interface IncidentAlertEntity {
  readonly kind: string;
  readonly id?: string;
  readonly displayName?: string;
}

export interface IncidentAlert {
  readonly schemaVersion: string;
  readonly id: string;
  readonly source: string;
  readonly title: string;
  readonly severity: string;
  readonly status: string;
  readonly entity: IncidentAlertEntity | null;
  readonly created: string;
  readonly incidentId: string;
  readonly passthrough: Record<string, unknown>;
}

export interface IncidentEntity {
  readonly kind: string;
  readonly id?: string;
  readonly displayName?: string;
  readonly alertIds: readonly string[];
}

export interface IncidentTimelineEvent {
  readonly at: string;
  readonly type: string;
  readonly summary: string;
  readonly actor?: string;
  readonly ref?: string;
}

export interface IncidentNote {
  readonly id: string;
  readonly body: string;
  readonly author?: string;
  readonly at: string;
}

export interface IncidentDetailResult {
  readonly tenantId: string;
  readonly incidentId: string;
  readonly overview: IncidentOverview;
  readonly alerts: readonly IncidentAlert[];
  readonly entities: readonly IncidentEntity[];
  readonly timeline: readonly IncidentTimelineEvent[];
  readonly notes: readonly IncidentNote[];
  readonly retrievedAt: string;
}

/** The `{ error, message, statusCode }` shape a worker returns for a missing incident. */
export interface IncidentWorkerError {
  readonly error: string;
  readonly message?: string;
  readonly statusCode: number;
}

export function isIncidentWorkerError(value: unknown): value is IncidentWorkerError {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const record = value as Record<string, unknown>;
  return (
    typeof record.error === "string" &&
    typeof record.statusCode === "number"
  );
}

export interface IncidentDetailProvider {
  getIncident(
    tenantId: string,
    incidentId: string,
  ): Promise<IncidentDetailResult | IncidentWorkerError | null>;
}

export interface IncidentDetailCaller extends Caller {
  readonly userId?: string;
}

export type IncidentDetailAuthorizer = (
  caller: IncidentDetailCaller,
  permission: string,
) => void | Promise<void>;

export interface IncidentDetailRouteOptions {
  readonly provider: IncidentDetailProvider;
  readonly resolveCaller: (ctx: RequestContext) => IncidentDetailCaller | undefined;
  readonly authorize?: IncidentDetailAuthorizer;
}

function unauthenticatedError(): AppError {
  return new AppError("request.unauthenticated", "authentication required", 401);
}

function requireCaller(
  resolveCaller: (ctx: RequestContext) => IncidentDetailCaller | undefined,
  ctx: RequestContext,
): IncidentDetailCaller {
  const caller = resolveCaller(ctx);
  if (caller === undefined) {
    throw unauthenticatedError();
  }
  return caller;
}

function requireParam(ctx: RequestContext, name: string): string {
  const value = ctx.params[name];
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new AppError(ErrorCodes.validationFailed, `${name} is required`, 400, [
      { field: name, reason: "required" },
    ]);
  }
  return value.trim();
}

export function createIncidentsDetailRoute(options: IncidentDetailRouteOptions): Route[] {
  const handler = async (ctx: RequestContext): Promise<RouteResponse> => {
    const caller = requireCaller(options.resolveCaller, ctx);
    const tenantId = requireParam(ctx, "tenantId");
    const incidentId = requireParam(ctx, "incidentId");

    requireTenantInScope(caller, tenantId);

    if (options.authorize) {
      await options.authorize(caller, INCIDENT_DETAIL_READ_PERMISSION);
    } else {
      const permissions = caller.permissions ?? [];
      if (!permissions.includes(INCIDENT_DETAIL_READ_PERMISSION) && !permissions.includes("*")) {
        throw new AppError(ErrorCodes.forbidden, "forbidden: missing incidents.read", 403);
      }
    }

    const result = await options.provider.getIncident(tenantId, incidentId);

    if (result === null || result === undefined) {
      throw new AppError(
        INCIDENT_NOT_FOUND_CODE,
        `Incident '${incidentId}' not found in tenant '${tenantId}'.`,
        404,
      );
    }
    if (isIncidentWorkerError(result)) {
      throw new AppError(
        result.error,
        result.message ?? result.error,
        result.statusCode,
      );
    }

    return {
      status: 200,
      headers: { "content-type": "application/json" },
      body: result,
    };
  };
  return [{ method: "GET", path: INCIDENT_DETAIL_PATH, handler }];
}

export const INCIDENT_DETAIL_OPENAPI = {
  paths: {
    "/tenants/{tenantId}/incidents/{incidentId}": {
      get: {
        operationId: "getIncidentDetail",
        summary: "Get a security incident with its alerts, entities, timeline, and notes",
        permission: "incidents.read",
        security: [{ bearerAuth: [] }],
        parameters: [
          {
            name: "tenantId",
            in: "path",
            required: true,
            schema: { type: "string" },
          },
          {
            name: "incidentId",
            in: "path",
            required: true,
            schema: { type: "string" },
          },
        ],
        responses: {
          "200": { description: "The incident's detail tab data." },
          "400": { description: "A required path parameter is missing." },
          "401": { description: "Authentication is required." },
          "403": { description: "The caller lacks the incidents.read permission." },
          "404": { description: "No incident with that id exists in the tenant." },
        },
      },
    },
  },
} as const;
