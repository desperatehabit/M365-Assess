// Access check preflight (EPIC-038 SPEC §6, §3.4; T-0750).
// POST /v1/access/check evaluates a permission for the caller and returns the
// same decision the endpoint would enforce, so UI buttons can preflight
// rather than guess. The decision runs through the T-0743 Test-PortalAccess
// path and, when the request names a tenant, the T-0746 tenant-scope path.
// Every decision — allow or deny, RBAC or scope — is audited through the
// single access-audit writer (SPEC §4.5). An anonymous request is a 401.
import { AppError, ErrorCodes } from "../errors.js";
import { isBaseRoleId, type BaseRoleId } from "../rbac/base-roles.js";
import {
  recordAccessDecision,
  type AccessAuditActorType,
  type AccessAuditSink,
} from "../rbac/access-audit.js";
import { PortalAccessCodes, testPortalAccess } from "../rbac/test-portal-access.js";
import { isTenantAllowed } from "../rbac/scope.js";
import type { RequestContext, Route, RouteResponse } from "../server.js";

export const ACCESS_CHECK_PATH = "/v1/access/check";

export const ACCESS_CHECK_UNAUTHENTICATED = "request.unauthenticated";

export interface AccessCaller {
  readonly id?: string;
  readonly upn?: string;
  readonly displayName?: string | null;
  readonly kind?: "api-client";
  readonly clientId?: string;
  readonly roles: readonly string[];
  readonly tenantScope: {
    readonly all: boolean;
    readonly tenantIds: readonly string[];
  };
}

export interface AccessRouteOptions {
  readonly resolveCaller: (ctx: RequestContext) => AccessCaller | undefined;
  readonly recordAccess: AccessAuditSink;
}

export interface AccessCheckRequest {
  readonly permission: string;
  readonly tenantId?: string;
}

export interface AccessCheckDecision {
  readonly allowed: boolean;
  readonly code: string;
  readonly permission: string;
  readonly matchedRoles: readonly string[];
  readonly tenantId?: string;
  readonly tenantAllowed?: boolean;
}

// EPIC-001 role ids map onto EPIC-038 base roles (the app wiring maps the same
// way); unknown ids drop out so a caller never resolves a permission it does
// not hold.
const EPIC001_BASE_ROLES: Readonly<Record<string, BaseRoleId>> = Object.freeze({
  admin: "admin",
  operator: "readonly",
});

function baseRolesOf(roles: readonly string[]): BaseRoleId[] {
  const mapped = new Set<BaseRoleId>();
  for (const role of roles) {
    const base = EPIC001_BASE_ROLES[role] ?? (isBaseRoleId(role) ? role : undefined);
    if (base !== undefined) {
      mapped.add(base);
    }
  }
  return [...mapped];
}

function accessAuditActor(caller: AccessCaller): {
  actorType: AccessAuditActorType;
  actorId: string | null;
} {
  if (caller.kind === "api-client") {
    return { actorType: "apiClient", actorId: caller.clientId ?? null };
  }
  return { actorType: "user", actorId: caller.id ?? null };
}

// Leftmost x-forwarded-for entry, mirroring the API client auth extractor.
function readClientIp(headers: RequestContext["headers"]): string | null {
  const forwarded = headers["x-forwarded-for"];
  const first = (Array.isArray(forwarded) ? forwarded[0] : forwarded)?.split(",")[0]?.trim();
  return first !== undefined && first.length > 0 ? first : null;
}

function validationError(message: string, field: string): AppError {
  return new AppError(ErrorCodes.validationFailed, message, 400, [{ field, reason: "invalid" }]);
}

function parseAccessCheckRequest(body: unknown): AccessCheckRequest {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    throw validationError("request body must be a JSON object", "body");
  }
  const record = body as Record<string, unknown>;
  const permission = record["permission"];
  if (typeof permission !== "string" || permission.trim().length === 0) {
    throw validationError("permission is required", "permission");
  }
  const tenantId = record["tenantId"];
  if (tenantId !== undefined && (typeof tenantId !== "string" || tenantId.trim().length === 0)) {
    throw validationError("tenantId must be a non-empty string", "tenantId");
  }
  return tenantId === undefined ? { permission } : { permission, tenantId };
}

export function createAccessRoutes(options: AccessRouteOptions): Route[] {
  const handler = async (ctx: RequestContext): Promise<RouteResponse> => {
    const caller = options.resolveCaller(ctx);
    if (caller === undefined) {
      throw new AppError(ACCESS_CHECK_UNAUTHENTICATED, "authentication required", 401);
    }
    const request = parseAccessCheckRequest(ctx.body);
    const actor = accessAuditActor(caller);
    const roles = baseRolesOf(caller.roles);
    const ip = readClientIp(ctx.headers);

    const rbacDecision = testPortalAccess({ permission: request.permission, roles });
    await recordAccessDecision(
      options.recordAccess,
      {
        ...actor,
        roles,
        permission: request.permission,
        tenantId: request.tenantId ?? null,
        allowed: rbacDecision.allowed,
        ip,
        correlationId: ctx.correlationId,
      },
      "rbac",
    );

    let tenantAllowed: boolean | undefined;
    if (request.tenantId !== undefined) {
      tenantAllowed = isTenantAllowed(caller.tenantScope, request.tenantId);
      await recordAccessDecision(
        options.recordAccess,
        {
          ...actor,
          roles,
          permission: request.permission,
          tenantId: request.tenantId,
          allowed: tenantAllowed,
          ip,
          correlationId: ctx.correlationId,
        },
        "scope",
      );
    }

    const allowed = rbacDecision.allowed && (tenantAllowed ?? true);
    const decision: AccessCheckDecision = {
      allowed,
      code: allowed ? PortalAccessCodes.allowed : PortalAccessCodes.forbidden,
      permission: request.permission,
      matchedRoles: [...rbacDecision.matchedRoles],
      ...(request.tenantId !== undefined ? { tenantId: request.tenantId, tenantAllowed } : {}),
    };
    return { status: 200, body: decision };
  };
  return [{ method: "POST", path: ACCESS_CHECK_PATH, handler }];
}

// Route modules own their OpenAPI path items (portal.v1.yaml `paths` is empty
// by design); a wiring ticket merges this fragment into the served document.
export const ACCESS_CHECK_OPENAPI = {
  paths: {
    "/access/check": {
      post: {
        operationId: "checkAccess",
        summary: "Evaluate a permission for the caller (UI preflight).",
        security: [{ bearerAuth: [] }],
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                additionalProperties: false,
                required: ["permission"],
                properties: {
                  permission: { type: "string", description: "Permission to evaluate, e.g. Tenant.Read." },
                  tenantId: { type: "string", description: "Tenant to include in the scope check." },
                },
              },
            },
          },
        },
        responses: {
          "200": { description: "The access decision the endpoint would enforce." },
          "400": { description: "The request body is invalid." },
          "401": { description: "Authentication required." },
        },
      },
    },
  },
} as const;
