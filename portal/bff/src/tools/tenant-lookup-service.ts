// Tenant lookup service (EPIC-040 SPEC.md §3.2, §6; T-0785).
// Resolves a domain or tenant ID against Graph's tenant endpoints and cross-checks
// the portal's own tenant store. Both the Graph transport and the portal store are
// seams: the production wiring (app.ts) provides the implementations, and the unit
// test fakes them. The resolved tenant is intersected with the caller's scope, so
// a caller scoped away from a tenant is denied rather than shown its details.
import { AppError, ErrorCodes } from "../errors.js";
import { isTenantAllowed, type TenantScope } from "../rbac/scope.js";

export const TENANT_LOOKUP_NOT_FOUND = "tenant.not_found";
export const TENANT_LOOKUP_OUT_OF_SCOPE = "auth.forbidden";

/** The §3.2 fields as resolved from Graph's tenant endpoints. */
export interface GraphTenantDetails {
  readonly tenantId: string;
  readonly displayName: string;
  readonly defaultDomain: string;
  readonly verifiedDomains: readonly string[];
  readonly region: string;
}

/**
 * Seam for Graph's tenant endpoints: the openid-configuration endpoint resolves a
 * domain to a tenant, and the organization endpoint returns the tenant's details.
 * A null return means the query matched no tenant.
 */
export interface TenantLookupGraphClient {
  resolveByDomain(domain: string): Promise<GraphTenantDetails | null>;
  resolveByTenantId(tenantId: string): Promise<GraphTenantDetails | null>;
}

/** The portal store's tenant record, narrowed to what the cross-check needs. */
export interface TenantLookupStoreTenant {
  readonly id: string;
  readonly deletedAt: string | null;
}

/** Seam over the portal's own tenant store (EPIC-002). */
export interface TenantLookupStore {
  getTenant(tenantId: string): Promise<TenantLookupStoreTenant | undefined>;
}

export interface TenantLookupResult {
  readonly tenantId: string;
  readonly name: string;
  readonly defaultDomain: string;
  readonly verifiedDomains: readonly string[];
  readonly region: string;
  readonly inPortal: boolean;
}

export interface TenantLookupService {
  lookup(query: string, scope: TenantScope): Promise<TenantLookupResult>;
}

// Tenant IDs are Graph tenant GUIDs; anything else is treated as a domain.
const TENANT_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function createTenantLookupService(options: {
  readonly graph: TenantLookupGraphClient;
  readonly store: TenantLookupStore;
}): TenantLookupService {
  const { graph, store } = options;

  async function resolve(query: string): Promise<GraphTenantDetails> {
    const trimmed = query.trim();
    if (trimmed.length === 0) {
      throw new AppError(
        ErrorCodes.validationFailed,
        "query must be a non-empty domain or tenant id",
        400,
        [{ field: "query", reason: "required" }],
      );
    }
    const found = TENANT_ID_PATTERN.test(trimmed)
      ? await graph.resolveByTenantId(trimmed)
      : await graph.resolveByDomain(trimmed);
    if (found === null) {
      throw new AppError(TENANT_LOOKUP_NOT_FOUND, `no tenant matches '${trimmed}'`, 404);
    }
    return found;
  }

  return {
    async lookup(query: string, scope: TenantScope): Promise<TenantLookupResult> {
      const tenant = await resolve(query);
      if (!isTenantAllowed(scope, tenant.tenantId)) {
        throw new AppError(TENANT_LOOKUP_OUT_OF_SCOPE, "tenant is outside the caller scope", 403, [
          { field: "tenantId", reason: "out_of_scope" },
        ]);
      }
      const record = await store.getTenant(tenant.tenantId);
      return {
        tenantId: tenant.tenantId,
        name: tenant.displayName,
        defaultDomain: tenant.defaultDomain,
        verifiedDomains: tenant.verifiedDomains,
        region: tenant.region,
        inPortal: record !== undefined && record.deletedAt === null,
      };
    },
  };
}
