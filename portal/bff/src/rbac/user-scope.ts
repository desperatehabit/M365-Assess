// UserScope resolution and intersection (EPIC-038 SPEC §4.2, §9).
//
// A caller's allowed tenant set is the union of their UserScope rows: direct
// `tenant` targets plus the member tenants of every `group` target. An `all`
// target grants the whole fleet, but only a superadmin may hold one. Every
// tenant-scoped query resolves the caller's rows to this concrete set and
// intersects its requested selection with it before touching a provider. A
// request naming a tenant outside the set is denied outright rather than
// silently narrowed — the SPEC §9 scope-bypass mitigation.
import { AppError, ErrorCodes } from "../errors.js";
import { ALL_TENANTS, type TenantScope } from "./scope.js";

export type UserScopeTargetType = "tenant" | "group" | "all";

// One UserScope row (SPEC §5): `tenant` and `group` targets carry a targetId;
// `all` carries none.
export interface UserScopeRow {
  readonly targetType: UserScopeTargetType;
  readonly targetId: string | null;
}

// Expands a tenant-group id to its member tenant ids. The production wiring
// backs this with the tenant-group store; keeping it a function leaves the
// resolver pure and free of a database dependency.
export type GroupTenantResolver = (groupId: string) => readonly string[];

export const UserScopeCodes = {
  allForbidden: "rbac.scope_all_forbidden",
  outOfScope: "rbac.scope_out_of_scope",
} as const;

export type UserScopeCode = (typeof UserScopeCodes)[keyof typeof UserScopeCodes];

export interface ResolveUserScopeInput {
  readonly rows: readonly UserScopeRow[];
  readonly roles: readonly string[];
  readonly resolveGroupTenants: GroupTenantResolver;
}

// The intersection outcome. `tenantIds` is the concrete selection the caller
// may query; `denied` is the subset of the request that fell outside the
// allowed set. A request is allowed only when nothing was denied.
export type UserScopeDecision =
  | { readonly allowed: true; readonly tenantIds: readonly string[] }
  | { readonly allowed: false; readonly denied: readonly string[] };

function normalizeTargetId(targetId: string | null): string | null {
  if (targetId === null) {
    return null;
  }
  const trimmed = targetId.trim();
  return trimmed.length === 0 ? null : trimmed;
}

// Resolves the caller's UserScope rows to the concrete tenant set. An `all`
// row is honored only for a superadmin; any other role holding one is a
// configuration error and is rejected rather than silently dropped.
export function resolveUserScope(input: ResolveUserScopeInput): TenantScope {
  const tenantIds = new Set<string>();
  let all = false;
  for (const row of input.rows) {
    if (row.targetType === "all") {
      if (!input.roles.includes("superadmin")) {
        throw new AppError(
          UserScopeCodes.allForbidden,
          "only a superadmin may hold an all-tenants scope",
          403,
          [{ field: "scope", reason: "all_forbidden" }],
        );
      }
      all = true;
      continue;
    }
    const targetId = normalizeTargetId(row.targetId);
    if (targetId === null) {
      continue;
    }
    if (row.targetType === "tenant") {
      tenantIds.add(targetId);
      continue;
    }
    for (const memberTenantId of input.resolveGroupTenants(targetId)) {
      const normalized = memberTenantId.trim();
      if (normalized.length > 0) {
        tenantIds.add(normalized);
      }
    }
  }
  if (all) {
    return ALL_TENANTS;
  }
  return Object.freeze({ all: false, tenantIds: Object.freeze([...tenantIds]) });
}

// Intersects a requested tenant selection with the resolved allowed scope. An
// `all` scope grants exactly what was requested; an explicit scope grants only
// the requested tenants it contains. If any requested tenant is out of scope
// the whole request is denied — never narrowed to the in-scope remainder.
export function intersectUserScope(
  scope: TenantScope,
  requested: readonly string[],
): UserScopeDecision {
  const unique = [...new Set(requested)];
  if (scope.all) {
    return { allowed: true, tenantIds: unique };
  }
  const allowed = new Set(scope.tenantIds);
  const denied = unique.filter((tenantId) => !allowed.has(tenantId));
  if (denied.length > 0) {
    return { allowed: false, denied };
  }
  return { allowed: true, tenantIds: unique };
}

// Throwing guard for the endpoint path: resolve the rows, intersect the
// requested selection, and deny the whole request with a structured 403 when
// any requested tenant is out of scope. Returns the permitted selection so the
// caller queries only that set, never a client-supplied list.
export function requireUserScope(
  input: ResolveUserScopeInput,
  requested: readonly string[],
): readonly string[] {
  const decision = intersectUserScope(resolveUserScope(input), requested);
  if (!decision.allowed) {
    throw new AppError(
      UserScopeCodes.outOfScope,
      "one or more requested tenants are outside the caller scope",
      403,
      [{ field: "tenantIds", reason: "out_of_scope" }],
    );
  }
  return decision.tenantIds;
}

// Parses one scope object for the UserScope edit path (and the portal-user
// create/patch scope field). Absent scope defaults to `all`; a tenant or group
// target requires a non-empty targetId.
export function parseUserScopeRow(value: unknown): UserScopeRow {
  if (value === undefined || value === null) {
    return { targetType: "all", targetId: null };
  }
  if (typeof value !== "object" || Array.isArray(value)) {
    throw new AppError(ErrorCodes.validationFailed, "scope must be an object", 400, [
      { field: "scope", reason: "invalid" },
    ]);
  }
  const record = value as Record<string, unknown>;
  const targetType = record["targetType"];
  if (targetType !== "tenant" && targetType !== "group" && targetType !== "all") {
    throw new AppError(
      ErrorCodes.validationFailed,
      "scope.targetType must be one of: tenant, group, all",
      400,
      [{ field: "scope.targetType", reason: "invalid" }],
    );
  }
  if (targetType === "all") {
    return { targetType: "all", targetId: null };
  }
  const targetId = record["targetId"];
  if (typeof targetId !== "string" || targetId.trim().length === 0) {
    throw new AppError(
      ErrorCodes.validationFailed,
      "scope.targetId is required for a tenant or group scope",
      400,
      [{ field: "scope.targetId", reason: "required" }],
    );
  }
  return { targetType, targetId: targetId.trim() };
}
