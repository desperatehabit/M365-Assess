import { describe, expect, it } from "vitest";
import type { CredentialRecord, CredentialStoreRow } from "../routes/credentials.js";
import { createDefenderProviders } from "./defender.js";
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
  getCredential: async (tenantId) => (tenantId === "t-a" ? CREDENTIAL : undefined),
  upsertCredential: async (input) => input,
  appendAuditEvent: async () => undefined,
};

interface Call {
  readonly entrypoint: string;
  readonly job: Record<string, unknown>;
}

function harness(handler: (entrypoint: string, job: Record<string, unknown>) => unknown) {
  const calls: Call[] = [];
  const run: WorkerRunner = async <T>(entrypoint: string, job: Record<string, unknown>): Promise<T> => {
    calls.push({ entrypoint, job });
    return handler(entrypoint, job) as T;
  };
  return { calls, run, providers: createDefenderProviders(run, credentials) };
}

describe("Defender providers (T-0849)", () => {
  it("reads the status worker through the tenant credential block", async () => {
    const { calls, providers } = harness(() => ({
      tenantId: "t-a",
      areas: [
        {
          area: "av",
          displayName: "Antivirus (AV)",
          source: "device-management",
          supported: true,
          current: "2 AV policies assigned",
          recommended: "Real-time protection enabled",
          status: "Pass",
        },
      ],
    }));

    const status = await providers.status.getDefenderStatus("t-a");

    expect(status.tenantId).toBe("t-a");
    expect(status.areas).toHaveLength(1);
    expect(status.areas[0]?.area).toBe("av");
    expect(calls[0]!.entrypoint).toBe("get-defender-status.ps1");
    expect(calls[0]!.job).toMatchObject({ tenantId: "t-a" });
    expect(calls[0]!.job["credential"]).toMatchObject({ record: { tenantId: "t-a" } });
  });

  it("plans a deploy with dryRun and maps the per-area plan", async () => {
    const { calls, providers } = harness(() => ({
      success: true,
      plans: [
        {
          area: "av",
          displayName: "Antivirus (AV)",
          supported: true,
          action: "create",
          policyName: "Defender av Baseline",
          targetScope: "allDevices",
          overwrite: false,
          conflict: false,
          conflictMessage: null,
          diff: ["create policy"],
          valid: true,
        },
      ],
      allValid: true,
      dryRun: true,
    }));

    const plan = await providers.deploy.planDeploy("t-a", {
      policyAreas: ["av", "edr"],
      targetScope: "allDevices",
      overwrite: false,
      saveAsTemplate: false,
    });

    expect(plan).toMatchObject({ tenantId: "t-a", allValid: true, overwrite: false });
    expect(plan.plans).toHaveLength(1);
    expect(calls[0]!.entrypoint).toBe("deploy-defender-policies.ps1");
    expect(calls[0]!.job).toMatchObject({
      tenantId: "t-a",
      policyAreas: ["av", "edr"],
      targetScope: "allDevices",
      dryRun: true,
    });
  });

  it("applies a deploy and lifts the template draft into policyJson", async () => {
    const { calls, providers } = harness(() => ({
      success: true,
      state: "succeeded",
      tenantId: "t-a",
      plans: [],
      results: [{ area: "av", policyId: "policy-1", action: "create", state: "succeeded" }],
      auditEvents: [
        {
          id: "evt-1",
          tenantId: "t-a",
          action: "defender.deploy.create",
          targetId: "policy-1",
          targetName: "Defender av Baseline",
          timestamp: "2026-01-01T00:00:00Z",
        },
      ],
      templateDraft: {
        name: "Baseline",
        policyAreas: ["av"],
        policyJson: { av: { realTimeProtection: true } },
      },
      error: null,
    }));

    const result = await providers.deploy.executeDeploy("t-a", {
      policyAreas: ["av"],
      targetScope: "allDevices",
      overwrite: false,
      saveAsTemplate: true,
      templateName: "Baseline",
    });

    expect(result).toMatchObject({ success: true, state: "succeeded", tenantId: "t-a" });
    expect(result.results).toHaveLength(1);
    expect(result.auditEvents).toHaveLength(1);
    expect(result.policyJson).toEqual({ av: { realTimeProtection: true } });
    expect(calls[0]!.job).toMatchObject({
      policyAreas: ["av"],
      dryRun: false,
      saveAsTemplate: true,
      templateName: "Baseline",
    });
  });

  it("passes the TVM filters and pagination to the vulnerabilities worker", async () => {
    const { calls, providers } = harness(() => ({
      tenantId: "t-a",
      totalCount: 1,
      items: [
        {
          cve: "CVE-2026-12345",
          severity: "high",
          cvss: 8.1,
          exposedDeviceCount: 2,
          affectedSoftware: ["Contoso VPN 4.2"],
          recommendation: "Update Contoso VPN.",
          affectedDeviceIds: ["device-1", "device-2"],
        },
      ],
      nextCursor: null,
    }));

    const page = await providers.vulnerabilities.listVulnerabilities("t-a", {
      severity: "high",
      software: "vpn",
      device: "device-1",
      search: "2026-12345",
      cursor: "b2Zmc2V0OjE=",
      limit: 50,
    });

    expect(page).toMatchObject({ tenantId: "t-a", totalCount: 1, nextCursor: null });
    expect(page.items[0]?.cve).toBe("CVE-2026-12345");
    expect(calls[0]!.entrypoint).toBe("get-tvm-vulnerabilities.ps1");
    expect(calls[0]!.job).toMatchObject({
      severity: "high",
      software: "vpn",
      device: "device-1",
      search: "2026-12345",
      top: 50,
      cursor: "b2Zmc2V0OjE=",
    });
  });

  it("drills through to the affected devices for one CVE", async () => {
    const { calls, providers } = harness(() => ({
      tenantId: "t-a",
      cve: "CVE-2026-12345",
      totalCount: 2,
      items: [
        { id: "device-1", deviceName: "WS-1001" },
        { id: "device-2", deviceName: "WS-1002" },
      ],
      nextCursor: null,
    }));

    const page = await providers.vulnerabilities.listVulnerabilityDevices(
      "t-a",
      "CVE-2026-12345",
      { cursor: null, limit: 100 },
    );

    expect(page.cve).toBe("CVE-2026-12345");
    expect(page.items).toHaveLength(2);
    expect(calls[0]!.job).toMatchObject({ cveId: "CVE-2026-12345", top: 100 });
  });

  it("reads MDE onboarding coverage", async () => {
    const { calls, providers } = harness(() => ({
      tenantId: "t-a",
      deploymentPolicyUrl: "https://intune.example/policy",
      platforms: [
        { platform: "windows", total: 4, onboarded: 3, notOnboarded: 1, coveragePct: 75, gaps: [] },
      ],
      totals: { total: 4, onboarded: 3, notOnboarded: 1, coveragePct: 75 },
    }));

    const coverage = await providers.mdeOnboarding.getMdeOnboarding("t-a");

    expect(coverage.tenantId).toBe("t-a");
    expect(coverage.totals.coveragePct).toBe(75);
    expect(calls[0]!.entrypoint).toBe("get-mde-onboarding.ps1");
  });

  it("fails with 409 when the tenant has no credential", async () => {
    const { run } = harness(() => ({}));
    const providers = createDefenderProviders(run, credentials);

    await expect(providers.status.getDefenderStatus("t-missing")).rejects.toMatchObject({
      status: 409,
    });
  });
});
