// Breach lookup route (EPIC-040 SPEC.md §3.4, §4.3, §6, §7, §9; T-0788).
//
//   POST /v1/breach-lookup — query an account/tenant against the registered
//                            BreachProvider.
//
// The query is admin-gated (CIPP.Admin.*) and audited for privacy by the
// service. No provider is registered yet — the HIBP integration is EPIC-041 —
// so the route fails closed with a structured 501 until one is; registering a
// provider changes no route or page code. The OpenAPI fragment is published
// here so `portal.v1.yaml` stays untouched (EPIC-001 SPEC §1).

import { AppError, ErrorCodes } from "../errors.js";
import { requireTenantInScope, type Caller } from "../rbac/authorize.js";
import type { RequestContext, Route, RouteResponse } from "../server.js";
import {
  BREACH_INTEGRATION_NOT_CONFIGURED,
  BREACH_PROVIDER_ERROR,
  BreachLookupError,
  type BreachLookupService,
  type BreachQuery,
} from "./breach-lookup-service.js";

export const BREACH_LOOKUP_PATH = "/v1/breach-lookup";

export const BREACH_ADMIN_SCOPE = "CIPP.Admin.*";

export const BREACH_UNAUTHENTICATED = "request.unauthenticated";
export const BREACH_FORBIDDEN = "auth.forbidden";

export interface BreachLookupRouteOptions {
  readonly service: BreachLookupService;
  readonly resolveCaller: (ctx: RequestContext) => (Caller & { userId?: string }) | undefined;
  readonly authorize?: (caller: Caller, permission: string) => void | Promise<void>;
  readonly readBody?: (ctx: RequestContext) => unknown;
}

function unauthenticatedError(): AppError {
  return new AppError(BREACH_UNAUTHENTICATED, "authentication required", 401);
}

function forbiddenError(): AppError {
  return new AppError(BREACH_FORBIDDEN, `forbidden: requires ${BREACH_ADMIN_SCOPE}`, 403);
}

function validationError(message: string, field: string): AppError {
  return new AppError(ErrorCodes.validationFailed, message, 400, [{ field, reason: "invalid" }]);
}

function requireCaller(
  resolveCaller: (ctx: RequestContext) => (Caller & { userId?: string }) | undefined,
  ctx: RequestContext,
): Caller & { userId?: string } {
  const caller = resolveCaller(ctx);
  if (caller === undefined) {
    throw unauthenticatedError();
  }
  return caller;
}

async function ensureAdmin(options: BreachLookupRouteOptions, caller: Caller): Promise<void> {
  if (options.authorize) {
    await options.authorize(caller, BREACH_ADMIN_SCOPE);
    return;
  }
  const granted = caller.permissions ?? [];
  if (!granted.includes(BREACH_ADMIN_SCOPE) && !granted.includes("*")) {
    throw forbiddenError();
  }
}

function readJsonBody(
  ctx: RequestContext,
  readBody: ((ctx: RequestContext) => unknown) | undefined,
): Record<string, unknown> {
  let body = readBody ? readBody(ctx) : ctx.body;
  if (body === undefined) {
    return {};
  }
  if (typeof body === "string") {
    try {
      body = JSON.parse(body);
    } catch {
      throw validationError("request body is not valid JSON", "body");
    }
  }
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    throw validationError("request body must be a JSON object", "body");
  }
  return body as Record<string, unknown>;
}

function parseQuery(body: Record<string, unknown>): BreachQuery {
  const account = body["account"];
  const tenantId = body["tenantId"];
  if (account !== undefined && typeof account !== "string") {
    throw validationError("account must be a string", "account");
  }
  if (tenantId !== undefined && typeof tenantId !== "string") {
    throw validationError("tenantId must be a string", "tenantId");
  }
  return {
    ...(typeof account === "string" ? { account } : {}),
    ...(typeof tenantId === "string" ? { tenantId } : {}),
  };
}

function toServiceError(error: unknown): AppError {
  if (error instanceof BreachLookupError) {
    if (error.code === BREACH_INTEGRATION_NOT_CONFIGURED) {
      return new AppError(error.code, error.message, 501, [
        { field: "integration", reason: "not_configured" },
      ]);
    }
    if (error.code === BREACH_PROVIDER_ERROR) {
      return new AppError(error.code, error.message, 502, [
        { field: "integration", reason: "provider_error" },
      ]);
    }
    return new AppError(error.code, error.message, 400, [
      { field: error.field ?? "body", reason: "invalid" },
    ]);
  }
  throw error;
}

export function createBreachLookupRoutes(options: BreachLookupRouteOptions): Route[] {
  const readBody = options.readBody ?? ((ctx: RequestContext) => ctx.body);

  const handler = async (ctx: RequestContext): Promise<RouteResponse> => {
    const caller = requireCaller(options.resolveCaller, ctx);
    await ensureAdmin(options, caller);

    const query = parseQuery(readJsonBody(ctx, readBody));
    if (query.tenantId !== undefined) {
      requireTenantInScope(caller, query.tenantId);
    }

    let result;
    try {
      result = await options.service.lookup({
        query,
        actor: caller.userId ?? "unknown",
        correlationId: ctx.correlationId,
      });
    } catch (error) {
      throw toServiceError(error);
    }

    return {
      status: 200,
      headers: { "content-type": "application/json" },
      body: result,
    };
  };

  return [{ method: "POST", path: BREACH_LOOKUP_PATH, handler }];
}

export const BREACH_LOOKUP_OPENAPI = {
  paths: {
    "/breach-lookup": {
      post: {
        operationId: "breachLookup",
        summary: "Query an account or tenant against a breach data source",
        permission: BREACH_ADMIN_SCOPE,
        security: [{ bearerAuth: [] }],
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: {
                  account: { type: "string", description: "Email address or UPN to query." },
                  tenantId: { type: "string", description: "Tenant GUID to query." },
                },
              },
            },
          },
        },
        responses: {
          "200": { description: "The breaches the data source reports for the query." },
          "400": { description: "Neither an account nor a tenantId was supplied." },
          "401": { description: "Authentication is required." },
          "403": { description: "The caller lacks CIPP.Admin.* or the tenant is outside scope." },
          "501": { description: "No breach data source is configured (EPIC-041)." },
          "502": { description: "The configured breach data source failed the query." },
        },
      },
    },
  },
} as const;
