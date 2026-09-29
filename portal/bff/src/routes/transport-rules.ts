// Transport rules list read (EPIC-021 SPEC.md §2 US-1, §3.1, §5, §6; T-0401).
// Exposes GET /v1/tenants/:tenantId/transport-rules with the §3.1 columns:
// name, priority, state, conditions, actions, exceptions, last modified.
// Requires RBAC `transport.read` and tenant in caller scope. Rules are read
// live from EXO and never persisted: the injected provider is backed by the
// worker queue (T-0010) running the Get-TransportRules child job, so this
// module holds no M365 SDK call and issues no tenant write.
import { AppError, ErrorCodes } from "../errors.js";
import { parsePagination } from "../pagination.js";
import { requireTenantInScope, type Caller } from "../rbac/authorize.js";
import type { RequestContext, Route, RouteResponse } from "../server.js";

export const TRANSPORT_RULES_PATH = "/v1/tenants/:tenantId/transport-rules";
export const TRANSPORT_READ_PERMISSION = "transport.read";
export const TRANSPORT_RULES_UNAUTHENTICATED = "request.unauthenticated";

export type TransportRuleState = "enabled" | "disabled";

export interface TransportRuleItem {
  readonly id: string;
  readonly name: string;
  readonly priority: number | null;
  readonly state: TransportRuleState | string;
  readonly conditions: readonly string[];
  readonly actions: readonly string[];
  readonly exceptions: readonly string[];
  readonly lastModified: string | null;
}

export interface TransportRulesFilter {
  readonly search?: string;
  readonly state?: string;
  readonly cursor: string | null;
  readonly limit: number;
}

export interface TransportRulesPage {
  readonly tenantId: string;
  readonly totalCount: number;
  readonly items: readonly TransportRuleItem[];
  readonly nextCursor: string | null;
}

export interface TransportRulesProvider {
  listTransportRules(tenantId: string, filter: TransportRulesFilter): Promise<TransportRulesPage>;
}

export interface TransportRulesCaller extends Caller {
  readonly userId?: string;
}

export type TransportRulesAuthorizer = (
  caller: TransportRulesCaller,
  permission: string,
) => void | Promise<void>;

export interface TransportRulesRouteOptions {
  readonly provider: TransportRulesProvider;
  readonly resolveCaller: (ctx: RequestContext) => TransportRulesCaller | undefined;
  readonly authorize?: TransportRulesAuthorizer;
}

function unauthenticatedError(): AppError {
  return new AppError(TRANSPORT_RULES_UNAUTHENTICATED, "authentication required", 401);
}

function requireCaller(
  resolveCaller: (ctx: RequestContext) => TransportRulesCaller | undefined,
  ctx: RequestContext,
): TransportRulesCaller {
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

function optionalText(query: URLSearchParams, name: string): string | undefined {
  const value = query.get(name);
  if (value === null || value.length === 0) {
    return undefined;
  }
  return value;
}

export function parseTransportRulesFilter(query: URLSearchParams): TransportRulesFilter {
  const pagination = parsePagination(query);
  const search = optionalText(query, "search");
  const state = optionalText(query, "state");
  if (state !== undefined && state !== "enabled" && state !== "disabled") {
    throw new AppError(ErrorCodes.validationFailed, "state must be enabled or disabled", 400, [
      { field: "state", reason: "invalid" },
    ]);
  }

  return {
    search,
    state,
    cursor: pagination.cursor,
    limit: pagination.limit,
  };
}

export function createTransportRulesRoute(options: TransportRulesRouteOptions): Route {
  return {
    method: "GET",
    path: TRANSPORT_RULES_PATH,
    handler: async (ctx: RequestContext): Promise<RouteResponse> => {
      const caller = requireCaller(options.resolveCaller, ctx);
      const tenantId = requireTenantParam(ctx);

      requireTenantInScope(caller, tenantId);

      if (options.authorize) {
        await options.authorize(caller, TRANSPORT_READ_PERMISSION);
      } else {
        const permissions = caller.permissions ?? [];
        if (!permissions.includes(TRANSPORT_READ_PERMISSION) && !permissions.includes("*")) {
          throw new AppError(ErrorCodes.forbidden, "forbidden: missing transport.read", 403);
        }
      }

      const filter = parseTransportRulesFilter(ctx.query);
      const page = await options.provider.listTransportRules(tenantId, filter);

      return {
        status: 200,
        headers: { "content-type": "application/json" },
        body: page,
      };
    },
  };
}

// Route modules own their OpenAPI path items (portal.v1.yaml `paths` is empty
// by design); a wiring ticket merges this fragment into the served document.
export const TRANSPORT_RULES_OPENAPI = {
  paths: {
    "/tenants/{tenantId}/transport-rules": {
      get: {
        operationId: "listTransportRules",
        summary: "List transport rules live from EXO (name, priority, state, conditions, actions, exceptions, last modified)",
        permission: TRANSPORT_READ_PERMISSION,
        security: [{ bearerAuth: [] }],
        parameters: [
          { name: "tenantId", in: "path", required: true, schema: { type: "string" } },
          { name: "search", in: "query", required: false, schema: { type: "string" } },
          {
            name: "state",
            in: "query",
            required: false,
            schema: { type: "string", enum: ["enabled", "disabled"] },
          },
          { name: "cursor", in: "query", required: false, schema: { type: "string" } },
          { name: "limit", in: "query", required: false, schema: { type: "integer" } },
        ],
        responses: {
          "200": { description: "Cursor-paginated transport rules with the §3.1 columns." },
          "400": { description: "An unsupported filter value was supplied." },
          "401": { description: "Authentication required." },
          "403": { description: "The caller lacks transport.read or the tenant is out of scope." },
        },
      },
    },
  },
} as const;
