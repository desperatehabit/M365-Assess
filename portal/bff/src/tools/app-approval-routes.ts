// Application approval routes (EPIC-040 SPEC.md §3.3, §4.2, §6, §7, §8; T-0786).
//
//   GET  /v1/tenants/:tenantId/consent-requests  — list pending consent requests
//   POST /v1/tenants/:tenantId/consent-requests  — approve or deny a request
//
// Approve/deny are tenant writes: they require the CIPP.Admin.* scope (SPEC §7),
// route through the EPIC-006 write boundary (the service's write port), and are
// audited with before/after state. Deny requires a reason.

import { AppError, ErrorCodes } from "../errors.js";
import { requireTenantInScope, type Caller } from "../rbac/authorize.js";
import type { RequestContext, Route, RouteResponse } from "../server.js";
import {
  CONSENT_DECISION_APPROVE,
  CONSENT_DECISION_DENY,
  CONSENT_REQUEST_NOT_FOUND,
  ConsentDecisionError,
  type AppApprovalService,
  type ConsentDecisionInput,
} from "./app-approval-service.js";

export const CONSENT_REQUESTS_PATH = "/v1/tenants/:tenantId/consent-requests";

export const APPROVAL_ADMIN_SCOPE = "CIPP.Admin.*";

export const APPROVAL_UNAUTHENTICATED = "request.unauthenticated";
export const APPROVAL_FORBIDDEN = "auth.forbidden";
export const APPROVAL_NOT_FOUND = "consent.request_not_found";
export const APPROVAL_BAD_REQUEST = "request.validation_failed";

export interface AppApprovalRouteOptions {
  readonly service: AppApprovalService;
  readonly resolveCaller: (ctx: RequestContext) => (Caller & { userId?: string }) | undefined;
  readonly authorize?: (caller: Caller, permission: string) => void | Promise<void>;
  readonly readBody?: (ctx: RequestContext) => unknown;
}

function unauthenticatedError(): AppError {
  return new AppError(APPROVAL_UNAUTHENTICATED, "authentication required", 401);
}

function forbiddenError(): AppError {
  return new AppError(APPROVAL_FORBIDDEN, `forbidden: requires ${APPROVAL_ADMIN_SCOPE}`, 403);
}

function validationError(message: string, field: string): AppError {
  return new AppError(ErrorCodes.validationFailed, message, 400, [
    { field, reason: "invalid" },
  ]);
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

async function ensureAdmin(
  options: AppApprovalRouteOptions,
  caller: Caller,
): Promise<void> {
  if (options.authorize) {
    await options.authorize(caller, APPROVAL_ADMIN_SCOPE);
    return;
  }
  const granted = caller.permissions ?? [];
  if (!granted.includes(APPROVAL_ADMIN_SCOPE) && !granted.includes("*")) {
    throw forbiddenError();
  }
}

function requireTenantParam(ctx: RequestContext): string {
  const value = ctx.params["tenantId"];
  if (typeof value !== "string" || value.trim().length === 0) {
    throw validationError("tenantId is required", "tenantId");
  }
  return value.trim();
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

function parseDecisionBody(body: Record<string, unknown>): Omit<ConsentDecisionInput, "tenantId" | "actor"> {
  const requestId = body["requestId"];
  if (typeof requestId !== "string" || requestId.trim().length === 0) {
    throw validationError("requestId is required", "requestId");
  }
  const decision = body["decision"];
  if (decision !== CONSENT_DECISION_APPROVE && decision !== CONSENT_DECISION_DENY) {
    throw validationError("decision must be 'approve' or 'deny'", "decision");
  }
  const reason = body["reason"];
  if (reason !== undefined && reason !== null && typeof reason !== "string") {
    throw validationError("reason must be a string", "reason");
  }
  return { requestId: requestId.trim(), decision, ...(reason !== undefined ? { reason } : {}) };
}

function toServiceError(error: unknown): AppError {
  if (error instanceof ConsentDecisionError) {
    const status = error.code === CONSENT_REQUEST_NOT_FOUND ? 404 : 400;
    return new AppError(error.code, error.message, status, [
      { field: error.field ?? "body", reason: "invalid" },
    ]);
  }
  throw error;
}

export function createAppApprovalRoutes(options: AppApprovalRouteOptions): Route[] {
  const readBody = options.readBody ?? ((ctx: RequestContext) => ctx.body);

  const listHandler = async (ctx: RequestContext): Promise<RouteResponse> => {
    const caller = requireCaller(options.resolveCaller, ctx);
    const tenantId = requireTenantParam(ctx);
    requireTenantInScope(caller, tenantId);
    await ensureAdmin(options, caller);

    const items = await options.service.list(tenantId);
    return {
      status: 200,
      headers: { "content-type": "application/json" },
      body: { items },
    };
  };

  const decideHandler = async (ctx: RequestContext): Promise<RouteResponse> => {
    const caller = requireCaller(options.resolveCaller, ctx);
    const tenantId = requireTenantParam(ctx);
    requireTenantInScope(caller, tenantId);
    await ensureAdmin(options, caller);

    const body = readJsonBody(ctx, readBody);
    const parsed = parseDecisionBody(body);

    let result;
    try {
      result = await options.service.decide({
        tenantId,
        requestId: parsed.requestId,
        decision: parsed.decision,
        reason: parsed.reason,
        actor: caller.userId ?? "unknown",
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

  return [
    { method: "GET", path: CONSENT_REQUESTS_PATH, handler: listHandler },
    { method: "POST", path: CONSENT_REQUESTS_PATH, handler: decideHandler },
  ];
}
