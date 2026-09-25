// Tenant scoping helper (05-programming.md §3): every response is tenant-scoped
// by the caller's RBAC scope, and a client-sent tenant list is intersected —
// never trusted wholesale and never widened.

export interface TenantScope {
  readonly all: boolean;
  readonly tenantIds: readonly string[];
}

export const ALL_TENANTS: TenantScope = Object.freeze({
  all: true,
  tenantIds: Object.freeze([] as string[]),
});

export function tenantScope(tenantIds: readonly string[]): TenantScope {
  return Object.freeze({ all: false, tenantIds: Object.freeze([...tenantIds]) });
}

export function isTenantAllowed(scope: TenantScope, tenantId: string): boolean {
  return scope.all || scope.tenantIds.includes(tenantId);
}

// Returns the requested tenants that the caller may see, in request order. The
// result is always a subset of `requested`: an `all` scope grants exactly what was
// asked for, an explicit scope adds an intersection filter, and nothing is added.
export function intersectTenantScope(
  scope: TenantScope,
  requested: readonly string[],
): string[] {
  const unique = [...new Set(requested)];
  if (scope.all) {
    return unique;
  }
  const allowed = new Set(scope.tenantIds);
  return unique.filter((tenantId) => allowed.has(tenantId));
}
