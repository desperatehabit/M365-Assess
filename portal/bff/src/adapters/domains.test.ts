import { describe, expect, it } from "vitest";
import type { DomainCheck } from "@m365-assess/db";
import type { CredentialRecord, CredentialStoreRow } from "../routes/credentials.js";
import { createDomainsProviders } from "./domains.js";
import type { WorkerRunner } from "./workers.js";

const CREDENTIAL: CredentialRecord = {
  id: "c-1",
  tenantId: "t-a",
  authMethod: "certificate-thumbprint",
  clientId: "app-1",
  secretRef: "thumbprint://ABC",
  thumbprint: "ABC",
  environment: "commercial",
  expiresOn: null,
  lastValidated: null,
  createdAt: "",
  updatedAt: "",
};

const credentials: CredentialStoreRow = {
  getCredential: async (tenantId) => ({ ...CREDENTIAL, tenantId }),
  upsertCredential: async (input) => input,
  appendAuditEvent: async () => undefined,
};

const CHECK: DomainCheck = {
  id: "check-1",
  tenantId: "t-a",
  domain: "contoso.com",
  at: "2026-11-08T00:00:00.000Z",
  records: { dmarc: { record: "v=DMARC1; p=none;" } },
  health: { overall: "unhealthy", families: { dmarc: "fail" } },
  recommendations: ["DMARC policy is none."],
};

function harness(handler: (entrypoint: string, job: Record<string, unknown>) => unknown) {
  const calls: Array<{ entrypoint: string; job: Record<string, unknown> }> = [];
  const appended: unknown[] = [];
  const run: WorkerRunner = async <T>(entrypoint: string, job: Record<string, unknown>): Promise<T> => {
    calls.push({ entrypoint, job });
    return handler(entrypoint, job) as T;
  };
  const providers = createDomainsProviders(run, credentials, {
    checks: {
      listLatestDomainChecks: async () => [CHECK],
      appendDomainCheck: async (input) => {
        appended.push(input);
        return { ...CHECK, ...input } as DomainCheck;
      },
      listDomainHistory: async () => [CHECK],
    },
  });
  return { calls, appended, providers };
}

const PAGE = {
  tenantId: "t-a",
  totalCount: 1,
  items: [
    {
      domain: "contoso.com",
      type: "verified",
      verification: "verified",
      dnsHealth: "unhealthy",
      services: "contoso-com.mail.protection.outlook.com",
      lastChecked: "2026-11-08T00:00:00.000Z",
    },
  ],
  nextCursor: null,
};

describe("EPIC-034 domain providers (T-0864)", () => {
  it("lists domains through get-domains.ps1 with the flat paging fields", async () => {
    const { calls, providers } = harness(() => PAGE);

    const page = await providers.list.listDomains(
      "t-a",
      { cursor: "offset:1", limit: 25 },
      [
        {
          id: "check-1",
          tenantId: "t-a",
          domain: "contoso.com",
          at: "2026-11-08T00:00:00.000Z",
          records: "{}",
          health: '{"overall":"unhealthy"}',
          recommendations: "[]",
        },
      ],
    );

    expect(page.items[0]?.domain).toBe("contoso.com");
    expect(page.items[0]?.dnsHealth).toBe("unhealthy");
    expect(page.nextCursor).toBeNull();
    expect(calls[0]!.entrypoint).toBe("get-domains.ps1");
    expect(calls[0]!.job).toMatchObject({
      tenantId: "t-a",
      top: 25,
      cursor: "offset:1",
      latestChecks: [
        {
          domain: "contoso.com",
          at: "2026-11-08T00:00:00.000Z",
          health: '{"overall":"unhealthy"}',
        },
      ],
    });
    expect(calls[0]!.job["credential"]).toMatchObject({ record: { tenantId: "t-a" } });
  });

  it("runs domain writes through the domain-action envelope", async () => {
    const { calls, providers } = harness(() => ({
      tenantId: "t-a",
      domain: "contoso.com",
      action: "add",
      status: "applied",
      verificationRecords: [{ recordType: "TXT", text: "MS=ms123", ttl: 3600 }],
      code: null,
      error: null,
      auditEvent: { action: "domains.action:add" },
    }));

    const outcome = await providers.actions.run("t-a", {
      action: "add",
      domain: "contoso.com",
      dryRun: false,
      confirmed: true,
      reason: "onboard",
      actor: "user-1",
    });

    expect(outcome.status).toBe("applied");
    expect(outcome.verificationRecords?.[0]).toMatchObject({ recordType: "TXT", text: "MS=ms123" });
    expect(calls[0]!.entrypoint).toBe("domain-action.ps1");
    expect(calls[0]!.job).toMatchObject({
      schemaVersion: "v1",
      payload: {
        domain: "contoso.com",
        action: "add",
        dryRun: false,
        confirmed: true,
        actor: "user-1",
        reason: "onboard",
      },
    });
    expect(calls[0]!.job["credential"]).toMatchObject({ record: { tenantId: "t-a" } });
  });

  it("analyses DNS without a tenant credential", async () => {
    const { calls, providers } = harness(() => ({
      records: { mx: ["contoso-com.mail.protection.outlook.com"] },
      health: { overall: "healthy", families: { mx: "pass" } },
      recommendations: [],
    }));

    const analysis = await providers.dns.analyse("t-a", "contoso.com");

    expect(analysis.health["overall"]).toBe("healthy");
    expect(analysis.records["mx"]).toEqual(["contoso-com.mail.protection.outlook.com"]);
    expect(calls[0]!.entrypoint).toBe("check-domain-dns.ps1");
    expect(calls[0]!.job).toEqual({ tenantId: "t-a", domain: "contoso.com" });
    expect(calls[0]!.job["credential"]).toBeUndefined();
  });

  it("derives recommendations from the latest stored records", async () => {
    const { calls, providers } = harness(() => [
      {
        recordFamily: "DMARC",
        severity: "high",
        explanation: "DMARC policy is `none`.",
        remediationUrl: "https://learn.microsoft.com/",
        remediation: "Set p=reject.",
        checkId: "DNS-DMARC-001",
      },
    ]);

    const recommendations = await providers.recommendations.getRecommendations("t-a", "CONTOSO.COM");

    expect(recommendations).toHaveLength(1);
    expect(recommendations[0]).toMatchObject({
      recordFamily: "DMARC",
      severity: "high",
      checkId: "DNS-DMARC-001",
    });
    expect(calls[0]!.entrypoint).toBe("get-dns-recommendations.ps1");
    expect(calls[0]!.job).toEqual({ tenantId: "t-a", records: CHECK.records });
  });

  it("returns no recommendations before the first stored check", async () => {
    const run: WorkerRunner = async () => {
      throw new Error("the worker must not run when no check is stored");
    };
    const providers = createDomainsProviders(run, credentials, {
      checks: {
        listLatestDomainChecks: async () => [],
        appendDomainCheck: async () => CHECK,
        listDomainHistory: async () => [],
      },
    });

    await expect(providers.recommendations.getRecommendations("t-a", "contoso.com")).resolves.toEqual([]);
  });
});
