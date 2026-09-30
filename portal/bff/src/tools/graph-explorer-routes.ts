// Graph Explorer route (EPIC-040 SPEC.md §3.1, §4.1, §6-8; T-0781).
// POST /v1/tenants/{id}/graph-explorer runs a request against the selected
// tenant with the portal app's credentials (EPIC-002) and returns status,
// headers, duration, and the parsed body as a typed envelope. Reads require
// tools.read and are audited for privacy; write methods (non-GET) require the
// CIPP.Admin.* scope and every request — read or write, allowed or denied —
// appends an AuditEvent with actor, tenant, method, URL, and result. The
// request itself is validated and executed by the graph-explorer service,
// which pins the URL to the Graph base and rejects $batch and token endpoints.
import { randomUUID } from "node:crypto";
import { AppError, ErrorCodes } from "../errors.js";
import { requireTenantInScope, type Caller } from "../rbac/authorize.js";
import type { RequestContext, Route, RouteResponse } from "../server.js";
import {
  executeGraphExplorerRequest,
  parseGraphExplorerRequest,
  type GraphExplorerExecutor,
  type GraphExplorerRequest,
  type GraphExplorerResponse,
} from "./graph-explorer-service.js";

export const GRAPH_EXPLORER_PATH = "/v1/tenants/:id/graph-explorer";

export const GRAPH_EXPLORER_READ_PERMISSION = "tools.read";
export const GRAPH_EXPLORER_ADMIN_SCOPE = "CIPP.Admin.*";

export const GRAPH_EXPLORER_UNAUTHENTICATED = "request.unauthenticated";

export interface GraphExplorerAuditInput {
  id: string;
  timestamp: string;
  actorUserId: string | null;
  actorType: "user" | "apiClient" | "system";
  tenantId: string | null;
  action: string;
  targetType: string | null;
  targetId: string | null;
  before: Record<string, unknown> | null;
  after: Record<string, unknown> | null;
  result: "success" | "failure";
  error: string | null;
  source: "request" | "schedule" | "remediation";
  correlationId: string | null;
}

export interface GraphExplorerAuditStore {
  appendAuditEvent(input: GraphExplorerAuditInput): Promise<unknown>;
}

export interface GraphExplorerCaller extends Caller {
  readonly userId?: string;
}

export type GraphExplorerAuthorizer = (
  caller: GraphExplorerCaller,
  permission: string,
) => void | Promise<void>;

export interface GraphExplorerRouteOptions {
  readonly executor: GraphExplorerExecutor;
  readonly audit: GraphExplorerAuditStore;
  readonly resolveCaller: (ctx: RequestContext) => GraphExplorerCaller | undefined;
  readonly authorize?: GraphExplorerAuthorizer;
  readonly now?: () => string;
}

function unauthenticatedError(): AppError {
  return new AppError(GRAPH_EXPLORER_UNAUTHENTICATED, "authentication required", 401);
}

function requireCaller(
  resolveCaller: (ctx: RequestContext) => GraphExplorerCaller | undefined,
  ctx: RequestContext,
): GraphExplorerCaller {
  const caller = resolveCaller(ctx);
  if (caller === undefined) {
    throw unauthenticatedError();
  }
  return caller;
}

function requireTenantParam(ctx: RequestContext): string {
  const value = ctx.params["id"];
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new AppError(ErrorCodes.validationFailed, "tenant id is required", 400, [
      { field: "id", reason: "required" },
    ]);
  }
  return value.trim();
}

async function requireReadPermission(
  options: GraphExplorerRouteOptions,
  caller: GraphExplorerCaller,
): Promise<void> {
  if (options.authorize) {
    await options.authorize(caller, GRAPH_EXPLORER_READ_PERMISSION);
    return;
  }
  const permissions = caller.permissions ?? [];
  if (!permissions.includes(GRAPH_EXPLORER_READ_PERMISSION) && !permissions.includes("*")) {
    throw new AppError(
      ErrorCodes.forbidden,
      `forbidden: missing ${GRAPH_EXPLORER_READ_PERMISSION}`,
      403,
    );
  }
}

async function requireWritePermission(
  options: GraphExplorerRouteOptions,
  caller: GraphExplorerCaller,
): Promise<void> {
  if (options.authorize) {
    await options.authorize(caller, GRAPH_EXPLORER_ADMIN_SCOPE);
    return;
  }
  const granted = caller.permissions ?? [];
  if (!granted.includes(GRAPH_EXPLORER_ADMIN_SCOPE) && !granted.includes("*")) {
    throw new AppError(
      ErrorCodes.forbidden,
      `forbidden: requires ${GRAPH_EXPLORER_ADMIN_SCOPE}`,
      403,
    );
  }
}

function readBodyRecord(ctx: RequestContext): Record<string, unknown> {
  return (ctx.body ?? {}) as Record<string, unknown>;
}

async function recordGraphExplorerAuditEvent(
  options: GraphExplorerRouteOptions,
  ctx: RequestContext,
  caller: GraphExplorerCaller,
  tenantId: string,
  request: GraphExplorerRequest,
  result: "success" | "failure",
  error: unknown,
  response?: GraphExplorerResponse,
): Promise<void> {
  const now = options.now ?? (() => new Date().toISOString());
  const after: Record<string, unknown> = {
    method: request.method,
    url: request.url,
  };
  if (response !== undefined) {
    after["status"] = response.status;
    after["durationMs"] = response.durationMs;
  }
  await options.audit.appendAuditEvent({
    id: randomUUID(),
    timestamp: now(),
    actorUserId: caller.userId ?? null,
    actorType: caller.userId ? "user" : "system",
    tenantId,
    action: "graph-explorer.request",
    targetType: "graph_request",
    targetId: null,
    before: null,
    after,
    result,
    error: error instanceof Error ? error.message : error === null ? null : String(error),
    source: "request",
    correlationId: ctx.correlationId,
  });
}

export function createGraphExplorerRoutes(options: GraphExplorerRouteOptions): Route[] {
  const handler = async (ctx: RequestContext): Promise<RouteResponse> => {
    const caller = requireCaller(options.resolveCaller, ctx);
    const tenantId = requireTenantParam(ctx);
    requireTenantInScope(caller, tenantId);
    await requireReadPermission(options, caller);

    const request = parseGraphExplorerRequest(readBodyRecord(ctx));

    if (request.method !== "GET") {
      try {
        await requireWritePermission(options, caller);
      } catch (error) {
        await recordGraphExplorerAuditEvent(options, ctx, caller, tenantId, request, "failure", error);
        throw error;
      }
    }

    try {
      const response = await executeGraphExplorerRequest(tenantId, request, options.executor);
      await recordGraphExplorerAuditEvent(
        options,
        ctx,
        caller,
        tenantId,
        request,
        "success",
        null,
        response,
      );
      return {
        status: 200,
        headers: { "content-type": "application/json" },
        body: response,
      };
    } catch (error) {
      await recordGraphExplorerAuditEvent(options, ctx, caller, tenantId, request, "failure", error);
      throw error;
    }
  };

  return [{ method: "POST", path: GRAPH_EXPLORER_PATH, handler }];
}

// Route modules own their OpenAPI path items (portal.v1.yaml `paths` is empty
// by design); a wiring ticket merges this fragment into the served document.
export const GRAPH_EXPLORER_OPENAPI = {
  paths: {
    "/tenants/{id}/graph-explorer": {
      post: {
        operationId: "runGraphExplorerRequest",
        summary: "Run a Graph request against the tenant with the portal app's credentials",
        permission: GRAPH_EXPLORER_READ_PERMISSION,
        security: [{ bearerAuth: [] }],
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
        responses: {
          "200": {
            description:
              "The Graph response envelope: status, headers, durationMs, and the parsed body.",
          },
          "400": {
            description: "The request failed validation (method, URL, or body).",
          },
          "401": { description: "Authentication required." },
          "403": {
            description:
              "The caller lacks tools.read, the write scope CIPP.Admin.*, or the tenant is out of scope.",
          },
        },
      },
    },
  },
} as const;
