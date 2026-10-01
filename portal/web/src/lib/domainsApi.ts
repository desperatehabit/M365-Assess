// Typed domains API client (EPIC-034 SPEC.md §3.1, §6; T-0662, T-0663).
// Wraps the domain list (T-0662) and action (T-0663) endpoints behind small
// typed functions. A `fetcher` seam keeps the client testable without a live BFF.

export type DomainType = "initial" | "verified" | "managed";
export type DomainVerificationStatus = "verified" | "pending" | "failed";
export type DnsHealthStatus = "healthy" | "degraded" | "unhealthy" | "unknown";

export interface DomainVerificationRecord {
  readonly type: string;
  readonly value: string;
}

export interface DomainItem {
  readonly domain: string;
  readonly type: DomainType;
  readonly verification: DomainVerificationStatus;
  readonly dnsHealth: DnsHealthStatus;
  readonly mxTarget: string | null;
  readonly lastCheckedAt: string | null;
  readonly isDefault: boolean;
}

export interface DomainVerificationResult {
  readonly domain: string;
  readonly records: readonly DomainVerificationRecord[];
}

export interface DomainActionResult {
  readonly domain: string;
  readonly action: "verify" | "setDefault" | "remove";
  readonly status: "applied" | "planned" | "failed";
  readonly error: string | null;
}

export type Fetcher = typeof fetch;

function asFetcher(fetcher?: Fetcher): Fetcher {
  return fetcher ?? fetch;
}

async function expectOk(response: Response, what: string): Promise<unknown> {
  if (!response.ok) {
    let detail = response.statusText;
    try {
      const body = (await response.json()) as { message?: string };
      if (body?.message) detail = body.message;
    } catch {
      // non-JSON error body; keep the status text
    }
    throw new Error(`${what} failed: ${response.status} ${detail}`);
  }
  return response.json();
}

export async function listDomains(
  tenantId: string,
  fetcher?: Fetcher,
): Promise<readonly DomainItem[]> {
  const response = await asFetcher(fetcher)(
    `/v1/tenants/${encodeURIComponent(tenantId)}/domains`,
  );
  const body = (await expectOk(response, "List domains")) as {
    items?: DomainItem[];
  };
  return body.items ?? [];
}

export async function addDomain(
  tenantId: string,
  domain: string,
  fetcher?: Fetcher,
): Promise<DomainVerificationResult> {
  const response = await asFetcher(fetcher)(
    `/v1/tenants/${encodeURIComponent(tenantId)}/domains`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ domain }),
    },
  );
  return (await expectOk(response, "Add domain")) as DomainVerificationResult;
}

export async function verifyDomain(
  tenantId: string,
  domain: string,
  fetcher?: Fetcher,
): Promise<DomainActionResult> {
  const response = await asFetcher(fetcher)(
    `/v1/tenants/${encodeURIComponent(tenantId)}/domains/${encodeURIComponent(domain)}/verify`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    },
  );
  return (await expectOk(response, "Verify domain")) as DomainActionResult;
}

export async function setDefaultDomain(
  tenantId: string,
  domain: string,
  fetcher?: Fetcher,
): Promise<DomainActionResult> {
  const response = await asFetcher(fetcher)(
    `/v1/tenants/${encodeURIComponent(tenantId)}/domains/${encodeURIComponent(domain)}/default`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    },
  );
  return (await expectOk(response, "Set default domain")) as DomainActionResult;
}

export async function removeDomain(
  tenantId: string,
  domain: string,
  fetcher?: Fetcher,
): Promise<DomainActionResult> {
  const response = await asFetcher(fetcher)(
    `/v1/tenants/${encodeURIComponent(tenantId)}/domains/${encodeURIComponent(domain)}`,
    { method: "DELETE" },
  );
  return (await expectOk(response, "Remove domain")) as DomainActionResult;
}

export async function checkDomainDns(
  tenantId: string,
  domain: string,
  fetcher?: Fetcher,
): Promise<Record<string, unknown>> {
  const response = await asFetcher(fetcher)(
    `/v1/tenants/${encodeURIComponent(tenantId)}/domains/${encodeURIComponent(domain)}/check-dns`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    },
  );
  return (await expectOk(response, "Check DNS")) as Record<string, unknown>;
}
