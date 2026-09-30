import { describe, expect, it } from "vitest";
import { AppError } from "../errors.js";
import { tenantScope } from "../rbac/scope.js";
import {
  LICENSE_GATES_PATH,
  LICENSE_GATES_READ_PERMISSION,
  createLicenseGatesRoutes,
  type LicenseGatesProvider,
  type LicenseGatesResponse,
  type LicenseGatesRoutesOptions,
} from "./license-gates.js";

const TENANT = "tenant-test";

class FakeLicenseGatesProvider implements LicenseGatesProvider {
  readonly calls: string[] = [];

  sampleGates: LicenseGatesResponse = {
    tenantId: TENANT,
    gates: {
      "CA-SIGNINRISK-001": {
        status: "available",
        requiredPlans: ["AAD_PREMIUM_P2"],
        missingPlans: [],
      },
      "ENTRA-PIM-001": {
        status: "gated",
        requiredPlans: ["AAD_PREMIUM_P2"],
        missingPlans: ["AAD_PREMIUM_P2"],
      },
      "COMPLIANCE-DLP-002": {
        status: "gated",
        requiredPlans: ["INFORMATION_PROTECTION_COMPLIANCE", "COMMUNICATIONS_DLP"],
        missingPlans: ["COMMUNICATIONS_DLP"],
      },
    },
  };

  async getLicenseGates(tenantId: string): Promise<LicenseGatesResponse> {
    this.calls.push(tenantId);
    return this.sampleGates;
  }
}

function createHarness(overrides?: Partial<LicenseGatesRoutesOptions>) {
  const provider = new FakeLicenseGatesProvider();
  let defaultCaller: any = {
    userId: "user-1",
    roles: ["admin"],
    permissions: [LICENSE_GATES_READ_PERMISSION],
    tenantScope: tenantScope([TENANT]),
  };

  const routes = createLicenseGatesRoutes({
    provider,
    resolveCaller: () => defaultCaller,
    ...overrides,
  });

  const getRoute = (method: string, path: string) => {
    const route = routes.find((r) => r.method === method && r.path === path);
    if (!route) throw new Error(`Route not found: ${method} ${path}`);
    return route;
  };

  return {
    provider,
    routes,
    getRoute,
    setCaller: (c: any) => {
      defaultCaller = c;
    },
  };
}

describe("GET /v1/tenants/:tenantId/licenses/gates (T-0646)", () => {
  it("rejects unauthenticated caller", async () => {
    const harness = createHarness({ resolveCaller: () => undefined });
    const route = harness.getRoute("GET", LICENSE_GATES_PATH);
    await expect(
      route.handler({
        path: `/v1/tenants/${TENANT}/licenses/gates`,
        params: { tenantId: TENANT },
        query: new URLSearchParams(),
        headers: {},
      }),
    ).rejects.toThrow(AppError);
  });

  it("rejects a tenant outside the caller scope", async () => {
    const harness = createHarness();
    const route = harness.getRoute("GET", LICENSE_GATES_PATH);
    await expect(
      route.handler({
        path: "/v1/tenants/tenant-other/licenses/gates",
        params: { tenantId: "tenant-other" },
        query: new URLSearchParams(),
        headers: {},
      }),
    ).rejects.toThrow("tenant is outside the caller scope");
  });

  it("rejects a caller without licenses.read", async () => {
    const harness = createHarness();
    harness.setCaller({
      userId: "user-2",
      roles: ["operator"],
      permissions: ["some.other.permission"],
      tenantScope: tenantScope([TENANT]),
    });
    const route = harness.getRoute("GET", LICENSE_GATES_PATH);
    await expect(
      route.handler({
        path: `/v1/tenants/${TENANT}/licenses/gates`,
        params: { tenantId: TENANT },
        query: new URLSearchParams(),
        headers: {},
      }),
    ).rejects.toThrow(AppError);
  });

  it("returns the per-feature gate map with required plans", async () => {
    const harness = createHarness();
    const route = harness.getRoute("GET", LICENSE_GATES_PATH);
    const res = await route.handler({
      path: `/v1/tenants/${TENANT}/licenses/gates`,
      params: { tenantId: TENANT },
      query: new URLSearchParams(),
      headers: {},
    });
    expect(res.status).toBe(200);
    const body = res.body as LicenseGatesResponse;
    expect(body.tenantId).toBe(TENANT);
    expect(body.gates["CA-SIGNINRISK-001"]?.status).toBe("available");
    expect(body.gates["CA-SIGNINRISK-001"]?.requiredPlans).toEqual(["AAD_PREMIUM_P2"]);
    expect(body.gates["ENTRA-PIM-001"]?.status).toBe("gated");
    expect(body.gates["ENTRA-PIM-001"]?.missingPlans).toEqual(["AAD_PREMIUM_P2"]);
    expect(body.gates["COMPLIANCE-DLP-002"]?.missingPlans).toEqual(["COMMUNICATIONS_DLP"]);
    expect(harness.provider.calls).toEqual([TENANT]);
  });
});
