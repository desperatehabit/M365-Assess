// Breach lookup — pluggable provider seam (EPIC-040 SPEC.md §3.4, §4.3, §6,
// §7, §9; T-0788). The HIBP/breach data source is deferred to EPIC-041 (SPEC
// §11 open question 2), so this module ships only the seam: a BreachProvider is
// registered when the integration lands, and until then every query fails
// closed with a structured "integration not configured" error.
//
// Privacy (SPEC §7, §9): a query names an account or tenant, so every query —
// including the fail-closed one — writes a privacy-preserving AuditEvent. The
// queried identifier reaches the provider but is recorded in the audit event
// only as a SHA-256 pseudonym; the cleartext identifier is never logged by this
// service and never appears in an error message.

import { createHash } from "node:crypto";

export const BREACH_INTEGRATION_NOT_CONFIGURED = "breach.integration_not_configured";
export const BREACH_QUERY_REQUIRED = "breach.query_required";
export const BREACH_PROVIDER_ERROR = "breach.provider_error";

export const BREACH_LOOKUP_ACTION = "breach.lookup";
export const BREACH_TARGET_TYPE = "breach_query";

/** One breach a data source reports for a queried subject (e.g. an HIBP breach). */
export interface BreachMatch {
  readonly name: string;
  readonly title: string;
  readonly domain: string;
  readonly breachDate: string;
  readonly pwnCount: number;
  readonly dataClasses: readonly string[];
  readonly isVerified: boolean;
  readonly isSensitive: boolean;
}

/** A breach query names an account (email/UPN) and/or a tenant. */
export interface BreachQuery {
  readonly account?: string;
  readonly tenantId?: string;
}

/**
 * Seam over an external breach data source. EPIC-041 registers an
 * implementation (the HIBP adapter); this service and the route never name a
 * vendor, so registering a provider needs no route or page change.
 */
export interface BreachProvider {
  readonly name: string;
  lookup(query: BreachQuery): Promise<readonly BreachMatch[]>;
}

export interface BreachLookupResult {
  readonly found: boolean;
  readonly breaches: readonly BreachMatch[];
  readonly source: string;
}

export interface BreachLookupInput {
  readonly query: BreachQuery;
  readonly actor: string;
  readonly correlationId?: string | null;
}

export interface BreachLookupService {
  lookup(input: BreachLookupInput): Promise<BreachLookupResult>;
  registerProvider(provider: BreachProvider): void;
  hasProvider(): boolean;
}

export interface BreachAuditPort {
  record(event: Record<string, unknown>): Promise<void> | void;
}

export interface BreachLookupServiceOptions {
  readonly provider?: BreachProvider;
  readonly auditPort: BreachAuditPort;
  readonly now?: () => Date;
}

export class BreachLookupError extends Error {
  readonly code: string;
  readonly field?: string;

  constructor(code: string, message: string, field?: string) {
    super(message);
    this.name = "BreachLookupError";
    this.code = code;
    this.field = field;
  }
}

function validateQuery(query: BreachQuery): BreachQuery {
  const account = query.account?.trim();
  const tenantId = query.tenantId?.trim();
  if (
    (account === undefined || account.length === 0) &&
    (tenantId === undefined || tenantId.length === 0)
  ) {
    throw new BreachLookupError(BREACH_QUERY_REQUIRED, "an account or tenantId is required", "query");
  }
  return {
    ...(account !== undefined && account.length > 0 ? { account } : {}),
    ...(tenantId !== undefined && tenantId.length > 0 ? { tenantId } : {}),
  };
}

/** Pseudonymises a subject so the audit trail can count queries without naming the subject. */
function pseudonymize(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export function createBreachLookupService(options: BreachLookupServiceOptions): BreachLookupService {
  const now = options.now ?? (() => new Date());
  let provider = options.provider;

  async function lookup(input: BreachLookupInput): Promise<BreachLookupResult> {
    const query = validateQuery(input.query);
    const subjectType = query.account !== undefined ? "account" : "tenant";
    const subject = query.account ?? query.tenantId ?? "";
    const event: Record<string, unknown> = {
      id: globalThis.crypto.randomUUID(),
      timestamp: now().toISOString(),
      actor: input.actor,
      actorType: "user",
      tenantId: query.tenantId ?? null,
      action: BREACH_LOOKUP_ACTION,
      targetType: BREACH_TARGET_TYPE,
      targetId: `breach:${subjectType}:${pseudonymize(subject)}`,
      before: null,
      source: "request",
      correlationId: input.correlationId ?? null,
    };

    if (provider === undefined) {
      await options.auditPort.record({
        ...event,
        after: { result: "not_configured", subjectType, matchCount: 0 },
        result: "failure",
        error: BREACH_INTEGRATION_NOT_CONFIGURED,
      });
      throw new BreachLookupError(
        BREACH_INTEGRATION_NOT_CONFIGURED,
        "breach lookup integration is not configured",
      );
    }

    let breaches: readonly BreachMatch[];
    try {
      breaches = await provider.lookup(query);
    } catch {
      await options.auditPort.record({
        ...event,
        after: { result: "provider_error", subjectType, matchCount: 0 },
        result: "failure",
        error: BREACH_PROVIDER_ERROR,
      });
      // The provider's own error may quote the queried identifier; replace it
      // with a generic error so nothing sensitive reaches the server log.
      throw new BreachLookupError(BREACH_PROVIDER_ERROR, "breach lookup provider failed");
    }

    await options.auditPort.record({
      ...event,
      after: { result: "success", subjectType, matchCount: breaches.length },
      result: "success",
      error: null,
    });

    return { found: breaches.length > 0, breaches, source: provider.name };
  }

  function registerProvider(next: BreachProvider): void {
    provider = next;
  }

  function hasProvider(): boolean {
    return provider !== undefined;
  }

  return { lookup, registerProvider, hasProvider };
}
