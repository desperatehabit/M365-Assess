// EPIC-034 Domains & DNS worker-backed providers (T-0864).
//
// The route factories were written against provider seams but never mounted,
// and no adapter bound them to the PowerShell workers, so every §6 endpoint
// 404'd. This module does that:
//
//   list             get-domains.ps1           (flat job: top, cursor, latestChecks)
//   actions          domain-action.ps1         (T-0007 envelope: domain, action, ...)
//   dns analyser     check-domain-dns.ps1      (flat job: domain; no tenant auth)
//   recommendations  get-dns-recommendations.ps1 (flat job: records from the latest check)
//
// The DNS analysis worker performs no tenant write and needs no credential, so
// it runs through the raw worker runner. Domain writes run through the envelope
// worker and are gated by the route module (confirm + Idempotency-Key); the
// worker itself re-checks confirmation before issuing a Graph write.
import type { DomainCheck } from "@m365-assess/db";
import type { CredentialStoreRow } from "../routes/credentials.js";
import type {
  DomainActionOutcome,
  DomainActionProvider,
  DomainActionRequest,
} from "../routes/domains-actions.js";
import type { DomainCheck as RouteDomainCheck, DomainsFilter, DomainsPage, DomainsProvider } from "../routes/domains.js";
import type { DomainCheckStore, DnsAnalyser, DnsAnalysisResult } from "../routes/domains-dns.js";
import type {
  DnsRecommendation,
  DnsRecommendationsProvider,
  DnsRecommendationSeverity,
} from "../routes/domains-recommendations.js";
import { createEnvelopeWorker, createTenantWorker, raiseWorkerError, type WorkerRunner } from "./workers.js";

export const DOMAINS_WORKER = "get-domains.ps1";
export const DOMAIN_ACTION_WORKER = "domain-action.ps1";
export const DOMAIN_DNS_WORKER = "check-domain-dns.ps1";
export const DNS_RECOMMENDATIONS_WORKER = "get-dns-recommendations.ps1";

type Row = Record<string, unknown>;

function asRecord(value: unknown): Row {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Row) : {};
}

function asArray(value: unknown): unknown[] {
  if (value === null || value === undefined) return [];
  return Array.isArray(value) ? value : [value];
}

function asString(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : value === null || value === undefined ? fallback : String(value);
}

function asNumber(value: unknown, fallback = 0): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function nullableString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

/** Maps the get-domains worker's page onto the route's DomainsPage shape. */
export function mapDomainsPage(value: unknown, tenantId: string): DomainsPage {
  const page = asRecord(value);
  const items = asArray(page["items"]).map((item) => {
    const row = asRecord(item);
    return {
      domain: asString(row["domain"]),
      type: asString(row["type"], "verified"),
      verification: asString(row["verification"], "unverified"),
      dnsHealth: nullableString(row["dnsHealth"]),
      services: nullableString(row["services"]),
      lastChecked: nullableString(row["lastChecked"]),
    };
  });
  return {
    tenantId: asString(page["tenantId"], tenantId),
    totalCount: asNumber(page["totalCount"], items.length),
    items,
    nextCursor: nullableString(page["nextCursor"]),
  };
}

/** Maps the domain-action worker's result onto the route's outcome shape. */
export function mapDomainActionOutcome(
  value: unknown,
  tenantId: string,
  request: DomainActionRequest,
): DomainActionOutcome {
  const row = asRecord(value);
  const status = asString(row["status"], "failed");
  const verification = asArray(row["verificationRecords"])
    .map((record) => asRecord(record))
    .map((record) => ({
      recordType: asString(record["recordType"]),
      ...(record["label"] === undefined ? {} : { label: asString(record["label"]) }),
      ...(record["text"] === undefined ? {} : { text: asString(record["text"]) }),
      ...(record["mailExchange"] === undefined ? {} : { mailExchange: asString(record["mailExchange"]) }),
      ...(record["preference"] === undefined ? {} : { preference: asNumber(record["preference"]) }),
      ...(record["ttl"] === undefined ? {} : { ttl: asNumber(record["ttl"]) }),
    }));
  const auditEvent = asRecord(row["auditEvent"]);
  return {
    tenantId: asString(row["tenantId"], tenantId),
    domain: asString(row["domain"], request.domain),
    action: (asString(row["action"], request.action) as DomainActionOutcome["action"]),
    status: (status === "applied" || status === "planned" || status === "failed"
      ? status
      : "failed"),
    ...(verification.length > 0 ? { verificationRecords: verification } : {}),
    code: nullableString(row["code"]),
    error: nullableString(row["error"]),
    ...(Object.keys(auditEvent).length > 0 ? { auditEvent } : {}),
  };
}

/** Maps the check-domain-dns worker's payload onto the route's analyser result. */
export function mapDnsAnalysis(value: unknown): DnsAnalysisResult {
  const row = asRecord(value);
  return {
    records: asRecord(row["records"]),
    health: asRecord(row["health"]),
    recommendations: asArray(row["recommendations"]).map((item) => asString(item)),
  };
}

const SEVERITIES: ReadonlySet<string> = new Set(["high", "medium", "low", "info"]);

function severityOf(value: unknown): DnsRecommendationSeverity {
  const severity = asString(value, "info");
  return (SEVERITIES.has(severity) ? severity : "info") as DnsRecommendationSeverity;
}

/** Maps the get-dns-recommendations worker's array onto the route's shape. */
export function mapDnsRecommendations(value: unknown): DnsRecommendation[] {
  return asArray(value).map((item) => {
    const row = asRecord(item);
    const remediation = nullableString(row["remediation"]);
    const checkId = nullableString(row["checkId"]);
    return {
      recordFamily: asString(row["recordFamily"]),
      severity: severityOf(row["severity"]),
      explanation: asString(row["explanation"]),
      remediationUrl: asString(row["remediationUrl"]),
      ...(remediation !== null ? { remediation } : {}),
      checkId: checkId ?? null,
    };
  });
}

/** The latest-checks read the recommendations provider uses (T-0661 repository). */
export interface DomainCheckReader {
  listLatestDomainChecks(tenantId: string): Promise<DomainCheck[]>;
}

export interface DomainsProviders {
  readonly list: DomainsProvider;
  readonly actions: DomainActionProvider;
  readonly dns: DnsAnalyser;
  readonly recommendations: DnsRecommendationsProvider;
}

export interface CreateDomainsProvidersOptions {
  readonly checks: DomainCheckStore & DomainCheckReader;
  readonly selectorOverride?: (tenantId: string) => string | undefined;
}

export function createDomainsProviders(
  run: WorkerRunner,
  credentials: CredentialStoreRow,
  options: CreateDomainsProvidersOptions,
): DomainsProviders {
  const tenantCall = createEnvelopeWorker(run, credentials);
  const flatCall = createTenantWorker(run, credentials);

  return {
    list: {
      async listDomains(
        tenantId: string,
        filter: DomainsFilter,
        latestChecks: readonly RouteDomainCheck[],
      ): Promise<DomainsPage> {
        const result = await flatCall<unknown>(DOMAINS_WORKER, tenantId, {
          top: filter.limit,
          cursor: filter.cursor ?? "",
          latestChecks: latestChecks.map((check) => ({
            domain: check.domain,
            at: check.at,
            health: check.health,
          })),
        });
        raiseWorkerError(result);
        return mapDomainsPage(result, tenantId);
      },
    },
    actions: {
      async run(tenantId: string, request: DomainActionRequest): Promise<DomainActionOutcome> {
        const result = await tenantCall<unknown>(DOMAIN_ACTION_WORKER, tenantId, {
          domain: request.domain,
          action: request.action,
          dryRun: request.dryRun,
          confirmed: request.confirmed,
          actor: request.actor,
          reason: request.reason,
        });
        raiseWorkerError(result);
        return mapDomainActionOutcome(result, tenantId, request);
      },
    },
    dns: {
      async analyse(tenantId: string, domain: string): Promise<DnsAnalysisResult> {
        const selectorOverride = options.selectorOverride?.(tenantId) ?? "";
        const result = await run<unknown>(DOMAIN_DNS_WORKER, {
          tenantId,
          domain,
          ...(selectorOverride ? { selectorOverride } : {}),
        });
        raiseWorkerError(result);
        return mapDnsAnalysis(result);
      },
    },
    recommendations: {
      async getRecommendations(tenantId: string, domain: string): Promise<readonly DnsRecommendation[]> {
        const latest = (await options.checks.listLatestDomainChecks(tenantId)).find(
          (check) => check.domain.toLowerCase() === domain.toLowerCase(),
        );
        if (latest === undefined) return [];
        const result = await run<unknown>(DNS_RECOMMENDATIONS_WORKER, {
          tenantId,
          records: latest.records,
        });
        raiseWorkerError(result);
        return mapDnsRecommendations(result);
      },
    },
  };
}
