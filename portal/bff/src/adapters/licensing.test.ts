import { describe, expect, it } from "vitest";
import type { CredentialRecord, CredentialStoreRow } from "../routes/credentials.js";
import { createLicensingProviders, mapLicenseGates } from "./licensing.js";
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

const PRICING = [{ skuId: "sku-1", unitPrice: 20, currency: "USD" }];

function harness(handler: (entrypoint: string, job: Record<string, unknown>) => unknown) {
  const calls: Array<{ entrypoint: string; job: Record<string, unknown> }> = [];
  const run: WorkerRunner = async <T>(entrypoint: string, job: Record<string, unknown>): Promise<T> => {
    calls.push({ entrypoint, job });
    return handler(entrypoint, job) as T;
  };
  return {
    calls,
    providers: createLicensingProviders(run, credentials, {
      listLicensePricing: async () => PRICING,
    }),
  };
}

describe("Licensing providers (T-0863)", () => {
  it("reads consumption with pricing passed in the flat job", async () => {
    const { calls, providers } = harness(() => ({
      tenantId: "t-a",
      items: [
        {
          skuId: "sku-1",
          skuPartNumber: "ENTERPRISEPACK",
          license: "E3",
          enabled: 100,
          assigned: 40,
          available: 60,
          suspended: 0,
          warning: 0,
          utilizationPct: 40,
          monthlyCost: "800.00",
          currency: "USD",
        },
      ],
    }));

    const report = await providers.licenses.getLicenses("t-a");
    expect(report.items[0]?.skuPartNumber).toBe("ENTERPRISEPACK");
    expect(calls[0]!.entrypoint).toBe("get-license-report.ps1");
    expect(calls[0]!.job).toMatchObject({ pricing: PRICING });
    expect(calls[0]!.job["credential"]).toMatchObject({ record: { tenantId: "t-a" } });
  });

  it("reads optimization through the new wrapper entrypoint", async () => {
    const { calls, providers } = harness(() => ({
      tenantId: "t-a",
      generatedAt: "2026-11-08T00:00:00Z",
      inactivityDays: 45,
      assignments: [],
      assignmentErrors: [],
      expirations: [],
    }));

    const optimization = await providers.optimization.getOptimization("t-a", 45);
    expect(optimization.inactivityDays).toBe(45);
    expect(calls[0]!.entrypoint).toBe("get-license-optimization.ps1");
    expect(calls[0]!.job).toMatchObject({ inactivityDays: 45 });
  });

  it("resolves gates through the new wrapper entrypoint", async () => {
    const { calls, providers } = harness(() => ({
      tenantId: "t-a",
      gates: {
        "COMPLIANCE-AUDIT-001": {
          status: "gated",
          requiredPlans: ["AUDIO_CONFERENCING"],
          missingPlans: ["AUDIO_CONFERENCING"],
        },
      },
    }));

    const gates = await providers.gates.getLicenseGates("t-a");
    expect(gates.gates["COMPLIANCE-AUDIT-001"]?.status).toBe("gated");
    expect(gates.gates["COMPLIANCE-AUDIT-001"]?.missingPlans).toEqual(["AUDIO_CONFERENCING"]);
    expect(calls[0]!.entrypoint).toBe("get-license-gates.ps1");
  });

  it("assigns and removes through update-user-license.ps1", async () => {
    const { calls, providers } = harness((_entrypoint, job) => {
      const payload = job["payload"] as Record<string, unknown>;
      if (payload["operation"] === "plan") {
        return {
          users: [
            {
              userId: "u-1",
              displayName: "User One",
              userPrincipalName: "u1@example.invalid",
              assigned: false,
            },
          ],
        };
      }
      return {
        dryRun: false,
        stoppedOnFailure: false,
        rows: [
          {
            userId: "u-1",
            skuId: "sku-1",
            action: "assign",
            state: "applied",
            before: null,
            after: { assigned: true },
            error: null,
          },
        ],
        changes: [
          {
            id: "change-1",
            tenantId: "t-a",
            userId: "u-1",
            skuId: "sku-1",
            action: "assign",
            state: "applied",
            by: "user-1",
            at: "2026-11-08T00:00:00Z",
          },
        ],
        auditEvents: [{ action: "license.assign", tenantId: "t-a" }],
      };
    });

    const plan = await providers.licenseChanges.plan("t-a", "sku-1", ["u-1"]);
    expect(plan[0]?.userId).toBe("u-1");

    const execution = await providers.licenseChanges.apply({
      tenantId: "t-a",
      skuId: "sku-1",
      action: "assign",
      userIds: ["u-1"],
      dryRun: false,
      confirmed: true,
      continueOnFailure: false,
      reason: null,
      actor: "user-1",
      correlationId: "corr-1",
    });
    expect(execution.rows[0]?.state).toBe("applied");
    expect(execution.changes[0]?.id).toBe("change-1");
    expect(calls.map((call) => call.entrypoint)).toEqual([
      "update-user-license.ps1",
      "update-user-license.ps1",
    ]);
    expect((calls[0]!.job["payload"] as Record<string, unknown>)["operation"]).toBe("plan");
    expect((calls[1]!.job["payload"] as Record<string, unknown>)["operation"]).toBe("apply");
  });

  it("normalizes an overlay result with absent collections", () => {
    const mapped = mapLicenseGates(
      { tenantId: "t-a", gates: { feature: { status: "available" } } },
      "t-a",
    );
    expect(mapped.gates["feature"]).toEqual({
      status: "available",
      requiredPlans: [],
      missingPlans: [],
    });
  });
});
