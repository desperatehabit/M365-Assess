// T-0666 — DNS recommendations API: serves the ranked, actionable
// recommendations for a domain, maps them to the module's DNS CheckIDs (or a
// portal instruction when no check exists), returns an empty list for a clean
// domain, and exposes no write action. The Get-DnsRecommendations worker is an
// injected seam here.

import { describe, expect, it } from "vitest";
import { ALL_TENANTS, tenantScope } from "../rbac/scope.js";
import type { RequestContext } from "../server.js";
import {
  DOMAIN_RECOMMENDATIONS_PATH,
  DOMAINS_RECOMMENDATIONS_OPENAPI,
  DOMAINS_RECOMMENDATIONS_READ_PERMISSION,
  createDomainsRecommendationsRoutes,
  type DnsRecommendation,
  type DnsRecommendationsProvider,
} from "./domains-recommendations.js";

const TENANT_A = "tenant-a";
const TENANT_B = "tenant-b";
const DOMAIN = "contoso.com";

const DMARC_RECOMMENDATION: DnsRecommendation = {
  recordFamily: "DMARC",
  severity: "high",
  explanation: "DMARC policy is `none`, so failing mail is only monitored and still delivered.",
  remediation: "Microsoft 365 Defender > Email authentication settings > DMARC.",
  remediationUrl:
    "https://learn.microsoft.com/en-us/defender-office-365/email-authentication-dmarc-configure",
  checkId: "DNS-DMARC-001",
};

const MTA_STS_RECOMMENDATION: DnsRecommendation = {
  recordFamily: "MTA-STS",
  severity: "low",
  explanation: "MTA-STS is not published, so transport security cannot be enforced.",
  remediation: "Publish an MTA-STS policy file and the _mta-sts TXT record.",
  remediationUrl: "https://learn.microsoft.com/en-us/purview/enhancing-mail-flow-with-mta-sts",
  checkId: null,
};

class FakeDnsRecommendationsProvider implements DnsRecommendationsProvider {
  calls: Array<{ tenantId: string; domain: string }> = [];
  private recommendations: readonly DnsRecommendation[] = [
    DMARC_RECOMMENDATION,
    MTA_STS_RECOMMENDATION,
  ];

  async getRecommendations(tenantId: string, domain: string): Promise<readonly DnsRecommendation[]> {
    this.calls.push({ tenantId, domain });
    return this.recommendations;
  }

  setRecommendations(recommendations: readonly DnsRecommendation[]): void {
    this.recommendations = recommendations;
  }
}

function fixture() {
  const provider = new FakeDnsRecommendationsProvider();
  const routes = createDomainsRecommendationsRoutes({
    provider,
    resolveCaller: () => ({
      roles: ["operator"],
      tenantScope: tenantScope([TENANT_A]),
      permissions: [DOMAINS_RECOMMENDATIONS_READ_PERMISSION],
    }),
  });
  return {
    provider,
    routes,
    route() {
      const found = routes.find((r) => r.method === "GET" && r.path === DOMAIN_RECOMMENDATIONS_PATH);
      if (!found) throw new Error("recommendations route not found");
      return found;
    },
  };
}

function context(
  method: string,
  path: string,
  params: Record<string, string> = { tenantId: TENANT_A, domain: DOMAIN },
): RequestContext {
  return {
    correlationId: "corr-rec-1",
    method,
    path,
    query: new URLSearchParams(),
    headers: {},
    params,
  };
}

describe("route surface (T-0666)", () => {
  it("exposes only the read-only recommendations operation", () => {
    const { routes } = fixture();
    expect(routes.map((r) => `${r.method} ${r.path}`)).toEqual([
      `GET ${DOMAIN_RECOMMENDATIONS_PATH}`,
    ]);
    expect(routes.every((r) => r.method === "GET")).toBe(true);
  });

  it("publishes the operation with domains.read", () => {
    const operation =
      DOMAINS_RECOMMENDATIONS_OPENAPI.paths[
        "/tenants/{tenantId}/domains/{domain}/recommendations"
      ].get;
    expect(operation.permission).toBe(DOMAINS_RECOMMENDATIONS_READ_PERMISSION);
    expect(operation.operationId).toBe("getDomainDnsRecommendations");
  });
});

describe("GET recommendations (T-0666)", () => {
  it("serves ranked recommendations mapped to module CheckIDs and remediation links", async () => {
    const { provider, route } = fixture();

    const res = await route().handler(context("GET", DOMAIN_RECOMMENDATIONS_PATH));

    expect(res.status).toBe(200);
    const body = res.body as {
      tenantId: string;
      domain: string;
      totalCount: number;
      recommendations: readonly DnsRecommendation[];
    };
    expect(body.tenantId).toBe(TENANT_A);
    expect(body.domain).toBe(DOMAIN);
    expect(body.totalCount).toBe(2);
    expect(body.recommendations[0]!.recordFamily).toBe("DMARC");
    expect(body.recommendations[0]!.checkId).toBe("DNS-DMARC-001");
    expect(body.recommendations[0]!.remediationUrl).toMatch(/^https:\/\//);
    expect(body.recommendations[1]!.checkId).toBeNull();
    expect(body.recommendations[1]!.remediation).not.toBeUndefined();
    expect(provider.calls).toEqual([{ tenantId: TENANT_A, domain: DOMAIN }]);
  });

  it("returns an empty list (200) for a clean domain", async () => {
    const { provider, route } = fixture();
    provider.setRecommendations([]);

    const res = await route().handler(context("GET", DOMAIN_RECOMMENDATIONS_PATH));

    expect(res.status).toBe(200);
    const body = res.body as { totalCount: number; recommendations: readonly DnsRecommendation[] };
    expect(body.totalCount).toBe(0);
    expect(body.recommendations).toEqual([]);
  });

  it("normalises the domain to lower case before asking the worker", async () => {
    const { provider, route } = fixture();

    await route().handler(
      context("GET", DOMAIN_RECOMMENDATIONS_PATH, { tenantId: TENANT_A, domain: "Contoso.COM" }),
    );

    expect(provider.calls).toEqual([{ tenantId: TENANT_A, domain: DOMAIN }]);
  });

  it("rejects an unauthenticated caller with 401", async () => {
    const routes = createDomainsRecommendationsRoutes({
      provider: new FakeDnsRecommendationsProvider(),
      resolveCaller: () => undefined,
    });
    await expect(routes[0]!.handler(context("GET", DOMAIN_RECOMMENDATIONS_PATH))).rejects.toMatchObject({
      status: 401,
    });
  });

  it("rejects a caller without domains.read with 403", async () => {
    const provider = new FakeDnsRecommendationsProvider();
    const routes = createDomainsRecommendationsRoutes({
      provider,
      resolveCaller: () => ({
        roles: ["operator"],
        tenantScope: ALL_TENANTS,
        permissions: ["other.read"],
      }),
    });
    await expect(routes[0]!.handler(context("GET", DOMAIN_RECOMMENDATIONS_PATH))).rejects.toMatchObject({
      status: 403,
    });
    expect(provider.calls).toHaveLength(0);
  });

  it("rejects a tenant outside the caller scope with 403", async () => {
    const { provider, route } = fixture();
    await expect(
      route().handler(
        context("GET", DOMAIN_RECOMMENDATIONS_PATH, { tenantId: TENANT_B, domain: DOMAIN }),
      ),
    ).rejects.toMatchObject({ status: 403 });
    expect(provider.calls).toHaveLength(0);
  });

  it("rejects a missing domain parameter with 400", async () => {
    const { route } = fixture();
    await expect(
      route().handler(
        context("GET", DOMAIN_RECOMMENDATIONS_PATH, { tenantId: TENANT_A, domain: "  " }),
      ),
    ).rejects.toMatchObject({ status: 400 });
  });
});
