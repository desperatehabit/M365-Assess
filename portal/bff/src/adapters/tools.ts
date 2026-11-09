// EPIC-040 tool adapters (T-0870).
//
// The Tenant Lookup service was written against a Graph seam but no adapter
// bound it. The portal already stores each managed tenant's display name,
// default domain, initial domain, and environment, so a known tenant resolves
// locally. A domain outside the portal is resolved through Microsoft's public
// OpenID configuration (tenant id only); the remaining display fields fall back
// to the queried domain rather than inventing data.
//
// The application-approval write port is deliberately fail-closed: the portal
// does not yet own a Graph consent-write flow, so a decision is refused with a
// structured error instead of silently reporting success.
import type {
  ConsentWritePort,
  ConsentWriteResult,
} from "../tools/app-approval-service.js";
import type {
  GraphTenantDetails,
  TenantLookupGraphClient,
} from "../tools/tenant-lookup-service.js";

export interface TenantLookupTenant {
  readonly id: string;
  readonly displayName: string | null;
  readonly defaultDomain: string | null;
  readonly initialDomain: string | null;
  readonly environment: string;
}

export interface TenantLookupTenantStore {
  getTenant(tenantId: string): Promise<TenantLookupTenant | undefined>;
}

type FetchLike = (url: string) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

const TENANT_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function tenantIdFromIssuer(issuer: unknown): string | null {
  if (typeof issuer !== "string") return null;
  const match = /^https:\/\/login\.microsoftonline\.[a-z.]+\/([0-9a-f-]{36})\/v2\.0\/?$/i.exec(
    issuer.trim(),
  );
  return match?.[1] ?? null;
}

function detailsFromTenant(
  record: TenantLookupTenant,
  seedDomain?: string,
): GraphTenantDetails {
  const domains = [record.defaultDomain, record.initialDomain].filter(
    (value): value is string => typeof value === "string" && value.length > 0,
  );
  if (seedDomain && !domains.includes(seedDomain)) domains.push(seedDomain);
  return {
    tenantId: record.id,
    displayName: record.displayName ?? record.defaultDomain ?? record.id,
    defaultDomain: record.defaultDomain ?? record.initialDomain ?? seedDomain ?? "",
    verifiedDomains: domains,
    region: record.environment.length > 0 ? record.environment : "Unknown",
  };
}

export interface TenantLookupGraphClientOptions {
  readonly store: TenantLookupTenantStore;
  /** Test seam; production uses the runtime fetch. */
  readonly fetchImpl?: FetchLike;
}

export function createTenantLookupGraphClient(
  options: TenantLookupGraphClientOptions,
): TenantLookupGraphClient {
  const doFetch: FetchLike =
    options.fetchImpl ?? ((url) => fetch(url) as unknown as ReturnType<FetchLike>);

  async function resolveKnownTenant(
    tenantId: string,
    seedDomain?: string,
  ): Promise<GraphTenantDetails | null> {
    const record = await options.store.getTenant(tenantId);
    if (record !== undefined) return detailsFromTenant(record, seedDomain);
    return {
      tenantId,
      displayName: seedDomain ?? tenantId,
      defaultDomain: seedDomain ?? "",
      verifiedDomains: seedDomain ? [seedDomain] : [],
      region: "Unknown",
    };
  }

  return {
    async resolveByDomain(domain: string): Promise<GraphTenantDetails | null> {
      const trimmed = domain.trim();
      if (trimmed.length === 0) return null;
      if (TENANT_ID_PATTERN.test(trimmed)) return resolveKnownTenant(trimmed);

      let response: Awaited<ReturnType<FetchLike>>;
      try {
        response = await doFetch(
          `https://login.microsoftonline.com/${encodeURIComponent(trimmed)}/v2.0/.well-known/openid-configuration`,
        );
      } catch {
        return null;
      }
      if (!response.ok) return null;
      let body: unknown;
      try {
        body = await response.json();
      } catch {
        return null;
      }
      const issuer =
        typeof body === "object" && body !== null
          ? (body as Record<string, unknown>)["issuer"]
          : undefined;
      const tenantId = tenantIdFromIssuer(issuer);
      if (tenantId === null) return null;
      return resolveKnownTenant(tenantId, trimmed);
    },

    async resolveByTenantId(tenantId: string): Promise<GraphTenantDetails | null> {
      if (!TENANT_ID_PATTERN.test(tenantId.trim())) return null;
      return resolveKnownTenant(tenantId.trim());
    },
  };
}

/**
 * Fail-closed consent write port. The Graph consent-approval flow depends on
 * the request kind (admin consent vs user consent) and is not implemented yet;
 * reporting success would record a decision that never reached the tenant.
 */
export function createConsentWritePort(): ConsentWritePort {
  return {
    async applyDecision(): Promise<ConsentWriteResult> {
      return {
        success: false,
        error: "consent approval writes are not available in this build",
      };
    },
  };
}
