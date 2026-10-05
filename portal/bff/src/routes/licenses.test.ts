import { describe, expect, it } from "vitest";
import { AppError } from "../errors.js";
import { tenantScope } from "../rbac/scope.js";
import type { CredentialRecord, CredentialStoreRow } from "./credentials.js";
import {
  LICENSES_OPENAPI,
  LICENSES_PATH,
  LICENSES_READ_PERMISSION,
  createLicensesProvider,
  createLicensesRoute,
  type LicenseItem,
  type LicensesProvider,
  type LicensesResponse,
} from "./licenses.js";
import type { WorkerRunner } from "../adapters/workers.js";

const TENANT = "tenant-test";

const SAMPLE_LICENSES: LicenseItem[] = [
  {
    skuId: "06ebc4ee-1bb5-47dd-8120-11324bc54e06",
    skuPartNumber: "SPE_E5",
    license: "Microsoft 365 E5",
    enabled: 25,
    assigned: 18,
    available: 7,
    suspended: 0,
    warning: 0,
    utilizationPct: 72.0,
    monthlyCost: 57.0,
    currency: "USD",
  },
  {
    skuId: "c5928f49-12ba-48f7-ada3-0d743a3601d5",
    skuPartNumber: "VISIOCLIENT",
    license: "Visio Plan 2",
    enabled: 5,
    assigned: 3,
    available: 2,
    suspended: 0,
    warning: 2,
    utilizationPct: 60.0,
    monthlyCost: "no pricing",
    currency: "USD",
  },
];

class FakeLicensesProvider implements LicensesProvider {
  readonly calls: string[] = [];

  async getLicenses(tenantId: string): Promise<LicensesResponse> {
    this.calls.push(tenantId);
    return {
      tenantId,
      items: SAMPLE_LICENSES,
    };
  }
}

describe("Licenses list route (T-0642)", () => {
  it("exposes GET /v1/tenants/:tenantId/licenses", () => {
    const provider = new FakeLicensesProvider();
    const route = createLicensesRoute({
      provider,
      resolveCaller: () => ({
        tenantScope: tenantScope([TENANT]),
        permissions: [LICENSES_READ_PERMISSION],
      }),
    });
    expect(route.method).toBe("GET");
    expect(route.path).toBe(LICENSES_PATH);
  });

  it("rejects unauthenticated requests with 401", async () => {
    const provider = new FakeLicensesProvider();
    const route = createLicensesRoute({
      provider,
      resolveCaller: () => undefined,
    });

    await expect(
      route.handler({
        path: `/v1/tenants/${TENANT}/licenses`,
        method: "GET",
        headers: {},
        params: { tenantId: TENANT },
        query: new URLSearchParams(),
      }),
    ).rejects.toThrow(AppError);
  });

  it("rejects missing Tenant.Licenses.Read permission with 403", async () => {
    const provider = new FakeLicensesProvider();
    const route = createLicensesRoute({
      provider,
      resolveCaller: () => ({
        tenantScope: tenantScope([TENANT]),
        permissions: ["other.read"],
      }),
    });

    await expect(
      route.handler({
        path: `/v1/tenants/${TENANT}/licenses`,
        method: "GET",
        headers: {},
        params: { tenantId: TENANT },
        query: new URLSearchParams(),
      }),
    ).rejects.toThrow(AppError);
  });

  it("rejects tenant outside caller scope with 403", async () => {
    const provider = new FakeLicensesProvider();
    const route = createLicensesRoute({
      provider,
      resolveCaller: () => ({
        tenantScope: tenantScope(["tenant-other"]),
        permissions: [LICENSES_READ_PERMISSION],
      }),
    });

    await expect(
      route.handler({
        path: `/v1/tenants/${TENANT}/licenses`,
        method: "GET",
        headers: {},
        params: { tenantId: TENANT },
        query: new URLSearchParams(),
      }),
    ).rejects.toThrow(AppError);
  });

  it("returns 200 with license list for authorized caller", async () => {
    const provider = new FakeLicensesProvider();
    const route = createLicensesRoute({
      provider,
      resolveCaller: () => ({
        tenantScope: tenantScope([TENANT]),
        permissions: [LICENSES_READ_PERMISSION],
      }),
    });

    const response = await route.handler({
      path: `/v1/tenants/${TENANT}/licenses`,
      method: "GET",
      headers: {},
      params: { tenantId: TENANT },
      query: new URLSearchParams(),
    });

    expect(response.status).toBe(200);
    const body = response.body as LicensesResponse;
    expect(body.tenantId).toBe(TENANT);
    expect(body.items).toHaveLength(2);
    expect(body.items[0]?.skuPartNumber).toBe("SPE_E5");
    expect(body.items[0]?.monthlyCost).toBe(57.0);
    expect(body.items[1]?.skuPartNumber).toBe("VISIOCLIENT");
    expect(body.items[1]?.monthlyCost).toBe("no pricing");
  });

  it("rejects a blank tenantId with 400", async () => {
    const provider = new FakeLicensesProvider();
    const route = createLicensesRoute({
      provider,
      resolveCaller: () => ({
        tenantScope: tenantScope([TENANT]),
        permissions: [LICENSES_READ_PERMISSION],
      }),
    });

    await expect(
      route.handler({
        path: `/v1/tenants/${TENANT}/licenses`,
        method: "GET",
        headers: {},
        params: { tenantId: "   " },
        query: new URLSearchParams(),
      }),
    ).rejects.toSatisfy((error: unknown) => error instanceof AppError && error.status === 400);
  });

  it("uses the injected authorizer instead of the permissions array", async () => {
    const provider = new FakeLicensesProvider();
    const checks: string[] = [];
    const route = createLicensesRoute({
      provider,
      resolveCaller: () => ({
        tenantScope: tenantScope([TENANT]),
        permissions: [],
      }),
      authorize: async (_caller, permission) => {
        checks.push(permission);
      },
    });

    const response = await route.handler({
      path: `/v1/tenants/${TENANT}/licenses`,
      method: "GET",
      headers: {},
      params: { tenantId: TENANT },
      query: new URLSearchParams(),
    });

    expect(response.status).toBe(200);
    expect(checks).toEqual([LICENSES_READ_PERMISSION]);
  });

  it("publishes the portal.v1.yaml fragment for the licence report", () => {
    const operations = LICENSES_OPENAPI.paths["/tenants/{tenantId}/licenses"];
    expect(operations).toBeDefined();
    expect(operations.get.operationId).toBe("getLicenses");
    expect(operations.get.permission).toBe(LICENSES_READ_PERMISSION);
  });

  it("forwards tenantId to provider", async () => {
    const provider = new FakeLicensesProvider();
    const route = createLicensesRoute({
      provider,
      resolveCaller: () => ({
        tenantScope: tenantScope([TENANT]),
        permissions: [LICENSES_READ_PERMISSION],
      }),
    });

    await route.handler({
      path: `/v1/tenants/${TENANT}/licenses`,
      method: "GET",
      headers: {},
      params: { tenantId: TENANT },
      query: new URLSearchParams(),
    });

    expect(provider.calls).toHaveLength(1);
    expect(provider.calls[0]).toBe(TENANT);
  });
});

const CREDENTIAL: CredentialRecord = {
  id: "cred-1",
  tenantId: TENANT,
  authMethod: "certificate-thumbprint",
  clientId: "client-1",
  secretRef: "thumbprint://fixture",
  thumbprint: "fixture",
  environment: "commercial",
  expiresOn: null,
  lastValidated: null,
  createdAt: "",
  updatedAt: "",
};

const CREDENTIALS: CredentialStoreRow = {
  getCredential: async (tenantId) => (tenantId === TENANT ? CREDENTIAL : undefined),
  upsertCredential: async (input) => input,
  appendAuditEvent: async () => undefined,
};

describe("Licenses provider (T-0642)", () => {
  it("fetches effective pricing for the tenant and forwards it to the worker", async () => {
    const pricingRows = [
      { skuId: "06ebc4ee-1bb5-47dd-8120-11324bc54e06", unitPrice: 57.0, currency: "USD" },
      { skuId: "c5928f49-12ba-48f7-ada3-0d743a3601d5", unitPrice: 15.0, currency: "USD" },
    ];
    const pricingCalls: string[] = [];
    const pricing = {
      listLicensePricing: async (tenantId: string) => {
        pricingCalls.push(tenantId);
        return pricingRows;
      },
    };
    const calls: { entrypoint: string; job: Record<string, unknown> }[] = [];
    const run: WorkerRunner = async (entrypoint, job) => {
      calls.push({ entrypoint, job });
      return {
        tenantId: job.tenantId,
        items: [
          {
            skuId: "06ebc4ee-1bb5-47dd-8120-11324bc54e06",
            skuPartNumber: "SPE_E5",
            license: "Microsoft 365 E5",
            enabled: 25,
            assigned: 18,
            available: 7,
            suspended: 0,
            warning: 0,
            utilizationPct: 72.0,
            monthlyCost: 1026.0,
            currency: "USD",
          },
        ],
      } as never;
    };

    const provider = createLicensesProvider(run, CREDENTIALS, pricing);
    const response = await provider.getLicenses(TENANT);

    expect(pricingCalls).toEqual([TENANT]);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.entrypoint).toBe("get-license-report.ps1");
    expect(calls[0]?.job).toMatchObject({
      tenantId: TENANT,
      pricing: pricingRows,
    });
    expect(response.items[0]).toMatchObject({ monthlyCost: 1026.0, currency: "USD" });
  });

  it("maps a worker error result to an AppError", async () => {
    const pricing = { listLicensePricing: async () => [] };
    const run: WorkerRunner = async () =>
      ({
        error: "worker.failed",
        message: "graph unavailable",
        statusCode: 502,
      }) as never;

    const provider = createLicensesProvider(run, CREDENTIALS, pricing);
    await expect(provider.getLicenses(TENANT)).rejects.toSatisfy(
      (error: unknown) => error instanceof AppError && error.status === 502,
    );
  });
});