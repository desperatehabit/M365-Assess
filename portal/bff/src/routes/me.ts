// Caller identity (EPIC-038 SPEC §6). GET /v1/me returns the caller's own
// identity, roles, effective permissions, and tenant-scope summary. The
// effective set is resolved through the T-0743 include/exclude engine over the
// endpoint permission registry, so the UI can hide what the caller may not
// use. Any authenticated caller may read their own record; an anonymous
// request is a 401.
import { AppError } from "../errors.js";
import { PermissionRegistry, PUBLIC_PERMISSION } from "../rbac/permissions.js";
import { isBaseRoleId, type BaseRoleId } from "../rbac/base-roles.js";
import { testPortalAccess } from "../rbac/test-portal-access.js";
import type { RequestContext, Route, RouteResponse } from "../server.js";

export const ME_PATH = "/v1/me";

export const ME_UNAUTHENTICATED = "request.unauthenticated";

export interface MeCaller {
  readonly id?: string;
  readonly upn?: string;
  readonly displayName?: string | null;
  readonly roles: readonly string[];
  readonly tenantScope: {
    readonly all: boolean;
    readonly tenantIds: readonly string[];
  };
}

export interface MeRouteOptions {
  readonly resolveCaller: (ctx: RequestContext) => MeCaller | undefined;
}

export interface MeIdentity {
  readonly id: string | null;
  readonly upn: string | null;
  readonly displayName: string | null;
  readonly roles: readonly string[];
  readonly permissions: readonly string[];
  readonly scope: {
    readonly all: boolean;
    readonly tenantIds: readonly string[];
  };
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

export function effectivePermissions(roles: readonly string[]): string[] {
  const baseRoles = baseRolesOf(roles);
  if (baseRoles.length === 0) {
    return [];
  }
  const granted = new Set<string>();
  for (const entry of PermissionRegistry) {
    if (entry.permission === PUBLIC_PERMISSION) {
      continue;
    }
    if (testPortalAccess({ permission: entry.permission, roles: baseRoles }).allowed) {
      granted.add(entry.permission);
    }
  }
  return [...granted].sort();
}

export function createMeRoutes(options: MeRouteOptions): Route[] {
  const handler = async (ctx: RequestContext): Promise<RouteResponse> => {
    const caller = options.resolveCaller(ctx);
    if (caller === undefined) {
      throw new AppError(ME_UNAUTHENTICATED, "authentication required", 401);
    }
    const identity: MeIdentity = {
      id: caller.id ?? null,
      upn: caller.upn ?? null,
      displayName: caller.displayName ?? null,
      roles: [...caller.roles],
      permissions: effectivePermissions(caller.roles),
      scope: {
        all: caller.tenantScope.all,
        tenantIds: [...caller.tenantScope.tenantIds],
      },
    };
    return { status: 200, body: identity };
  };
  return [{ method: "GET", path: ME_PATH, handler }];
}

// Route modules own their OpenAPI path items (portal.v1.yaml `paths` is empty
// by design); a wiring ticket merges this fragment into the served document.
export const ME_OPENAPI = {
  paths: {
    "/me": {
      get: {
        operationId: "getCurrentCaller",
        summary: "Return the caller's identity, roles, effective permissions, and scope.",
        security: [{ bearerAuth: [] }],
        responses: {
          "200": { description: "The caller's own identity and effective permissions." },
          "401": { description: "Authentication required." },
        },
      },
    },
  },
} as const;
