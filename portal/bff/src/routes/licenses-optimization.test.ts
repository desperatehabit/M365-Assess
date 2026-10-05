import { describe, expect, it } from "vitest";
import { AppError } from "../errors.js";
import { tenantScope } from "../rbac/scope.js";
import type { CredentialRecord, CredentialStoreRow } from "./credentials.js";
import {
  LICENSE_OPTIMIZATION_OPENAPI,
  LICENSE_OPTIMIZATION_PATH,
  LICENSE_OPTIMIZATION_READ_PERMISSION,
  createLicenseOptimizationProvider,
  createLicenseOptimizationRoute,
  type LicenseOptimizationProvider,
  type LicenseOptimizationResponse,
} from "./licenses-optimization.js";
import type { WorkerRunner } from "../adapters/workers.js";

const TENANT = "tenant-test";

const SAMPLE: LicenseOptimizationResponse = {
  tenantId: TENANT,
  generatedAt: "2026-01-30T00:00:00.000Z",
  inactivityDays: 30,
  advisory: true,
  unused: [
    {
      skuId: "06ebc4ee-1bb5-47dd-8120-11324bc54e06",
      skuPartNumber: "SPE_E5",
      affectedUsers: [
        {
          userId: "user-1",
          userPrincipalName: "user.one@example.invalid",
          displayName: "User One",
          lastActivityDate: "2025-12-01T00:00:00.000Z",
        },
      ],
    },
  ],
  overused: [
    {
      skuId: "c5928f49-12ba-48f7-ada3-0d743a3601d5",
      skuPartNumber: "VISIOCLIENT",
      error: "over-allocated",
      affectedUsers: [],
    },
  ],
  expiring: [
    {
      skuId: "06ebc4ee-1bb5-47dd-8120-11324bc54e06",
      skuPartNumber: "SPE_E5",
      expirationDateTime: "2026-02-10T00:00:00.000Z",
      daysRemaining: 11,
      affectedUsers: [],
    },
  ],
};

class FakeOptimizationProvider implements LicenseOptimizationProvider {
  readonly calls: { tenantId: string; inactivityDays: number }[] = [];

  async getOptimization(tenantId: string, inactivityDays: number): Promise<LicenseOptimizationResponse> {
    this.calls.push({ tenantId, inactivityDays });
    return { ...SAMPLE, tenantId, inactivityDays };
  }
}

function request(overrides: { tenantId?: string; query?: string } = {}) {
  const tenantId = overrides.tenantId ?? TENANT;
  return {
    path: `/v1/tenants/${tenantId}/licenses/optimization`,
    method: "GET",
    headers: {},
    params: { tenantId },
    query: new URLSearchParams(overrides.query ?? ""),
  };
}

describe("License optimization route (T-0643)", () => {
  it("exposes GET /v1/tenants/:tenantId/licenses/optimization", () => {
    const provider = new FakeOptimizationProvider();
    const route = createLicenseOptimizationRoute({
      provider,
      resolveCaller: () => ({
        tenantScope: tenantScope([TENANT]),
        permissions: [LICENSE_OPTIMIZATION_READ_PERMISSION],
      }),
    });
    expect(route.method).toBe("GET");
    expect(route.path).toBe(LICENSE_OPTIMIZATION_PATH);
  });

  it("rejects unauthenticated requests with 401", async () => {
    const route = createLicenseOptimizationRoute({
      provider: new FakeOptimizationProvider(),
      resolveCaller: () => undefined,
    });

    await expect(route.handler(request())).rejects.toThrow(AppError);
  });

  it("rejects missing Tenant.Licenses.Read permission with 403", async () => {
    const route = createLicenseOptimizationRoute({
      provider: new FakeOptimizationProvider(),
      resolveCaller: () => ({
        tenantScope: tenantScope([TENANT]),
        permissions: ["other.read"],
      }),
    });

    await expect(route.handler(request())).rejects.toThrow(AppError);
  });

  it("rejects tenant outside caller scope with 403", async () => {
    const route = createLicenseOptimizationRoute({
      provider: new FakeOptimizationProvider(),
      resolveCaller: () => ({
        tenantScope: tenantScope(["tenant-other"]),
        permissions: [LICENSE_OPTIMIZATION_READ_PERMISSION],
      }),
    });

    await expect(route.handler(request())).rejects.toSatisfy(
      (error: unknown) => error instanceof AppError && error.status === 403,
    );
  });

  it("rejects a blank tenantId with 400", async () => {
    const route = createLicenseOptimizationRoute({
      provider: new FakeOptimizationProvider(),
      resolveCaller: () => ({
        tenantScope: tenantScope([TENANT]),
        permissions: [LICENSE_OPTIMIZATION_READ_PERMISSION],
      }),
    });

    await expect(
      route.handler({ ...request(), params: { tenantId: "   " } }),
    ).rejects.toSatisfy((error: unknown) => error instanceof AppError && error.status === 400);
  });

  it("returns 200 with the grouped result for an authorized caller", async () => {
    const route = createLicenseOptimizationRoute({
      provider: new FakeOptimizationProvider(),
      resolveCaller: () => ({
        tenantScope: tenantScope([TENANT]),
        permissions: [LICENSE_OPTIMIZATION_READ_PERMISSION],
      }),
    });

    const response = await route.handler(request());
    expect(response.status).toBe(200);
    const body = response.body as LicenseOptimizationResponse;
    expect(body.advisory).toBe(true);
    expect(body.unused[0]?.skuPartNumber).toBe("SPE_E5");
    expect(body.overused[0]?.error).toBe("over-allocated");
    expect(body.expiring[0]?.daysRemaining).toBe(11);
  });

  it("defaults the inactivity window to 30 days", async () => {
    const provider = new FakeOptimizationProvider();
    const route = createLicenseOptimizationRoute({
      provider,
      resolveCaller: () => ({
        tenantScope: tenantScope([TENANT]),
        permissions: [LICENSE_OPTIMIZATION_READ_PERMISSION],
      }),
    });

    await route.handler(request());
    expect(provider.calls).toEqual([{ tenantId: TENANT, inactivityDays: 30 }]);
  });

  it("passes a configurable inactivityDays through to the provider", async () => {
    const provider = new FakeOptimizationProvider();
    const route = createLicenseOptimizationRoute({
      provider,
      resolveCaller: () => ({
        tenantScope: tenantScope([TENANT]),
        permissions: [LICENSE_OPTIMIZATION_READ_PERMISSION],
      }),
    });

    await route.handler(request({ query: "inactivityDays=7" }));
    expect(provider.calls).toEqual([{ tenantId: TENANT, inactivityDays: 7 }]);
  });

  it("rejects an invalid inactivityDays with 400", async () => {
    const route = createLicenseOptimizationRoute({
      provider: new FakeOptimizationProvider(),
      resolveCaller: () => ({
        tenantScope: tenantScope([TENANT]),
        permissions: [LICENSE_OPTIMIZATION_READ_PERMISSION],
      }),
    });

    await expect(route.handler(request({ query: "inactivityDays=0" }))).rejects.toSatisfy(
      (error: unknown) => error instanceof AppError && error.status === 400,
    );
  });

  it("uses the injected authorizer instead of the permissions array", async () => {
    const checks: string[] = [];
    const route = createLicenseOptimizationRoute({
      provider: new FakeOptimizationProvider(),
      resolveCaller: () => ({
        tenantScope: tenantScope([TENANT]),
        permissions: [],
      }),
      authorize: async (_caller, permission) => {
        checks.push(permission);
      },
    });

    const response = await route.handler(request());
    expect(response.status).toBe(200);
    expect(checks).toEqual([LICENSE_OPTIMIZATION_READ_PERMISSION]);
  });

  it("publishes the portal.v1.yaml fragment for licence optimization", () => {
    const operations = LICENSE_OPTIMIZATION_OPENAPI.paths["/tenants/{tenantId}/licenses/optimization"];
    expect(operations).toBeDefined();
    expect(operations.get.operationId).toBe("getLicenseOptimization");
    expect(operations.get.permission).toBe(LICENSE_OPTIMIZATION_READ_PERMISSION);
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

describe("License optimization provider (T-0643)", () => {
  it("calls the worker and classifies its raw payload", async () => {
    const calls: { entrypoint: string; job: Record<string, unknown> }[] = [];
    const run: WorkerRunner = async (entrypoint, job) => {
      calls.push({ entrypoint, job });
      return {
        tenantId: job.tenantId,
        generatedAt: "2026-01-30T00:00:00.000Z",
        assignments: [
          {
            userId: "user-1",
            userPrincipalName: "user.one@example.invalid",
            displayName: "User One",
            skuId: "sku-e5",
            skuPartNumber: "SPE_E5",
            lastActivityDate: "2025-12-01T00:00:00.000Z",
          },
        ],
        assignmentErrors: [],
        expirations: [],
      } as never;
    };

    const provider = createLicenseOptimizationProvider(run, CREDENTIALS);
    const response = await provider.getOptimization(TENANT, 30);

    expect(calls).toHaveLength(1);
    expect(calls[0]?.entrypoint).toBe("get-license-optimization.ps1");
    expect(calls[0]?.job).toMatchObject({ tenantId: TENANT, inactivityDays: 30 });
    expect(response.inactivityDays).toBe(30);
    expect(response.unused[0]?.skuPartNumber).toBe("SPE_E5");
  });

  it("maps a worker error result to an AppError", async () => {
    const run: WorkerRunner = async () =>
      ({
        error: "worker.failed",
        message: "graph unavailable",
        statusCode: 502,
      }) as never;

    const provider = createLicenseOptimizationProvider(run, CREDENTIALS);
    await expect(provider.getOptimization(TENANT, 30)).rejects.toSatisfy(
      (error: unknown) => error instanceof AppError && error.status === 502,
    );
  });
});
