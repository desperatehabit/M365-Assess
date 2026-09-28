import { describe, expect, it } from "vitest";
import { tenantScope } from "../rbac/scope.js";
import {
  MDE_ONBOARDING_OPENAPI,
  MDE_ONBOARDING_PATH,
  MDE_ONBOARDING_READ_PERMISSION,
  createMdeOnboardingRoutes,
  type MdeOnboarding,
  type MdeOnboardingCaller,
  type MdeOnboardingProvider,
} from "./defender-mde-onboarding.js";

const TENANT = "tenant-test";
const POLICY_URL = `/v1/tenants/${TENANT}/defender/deploy`;

const SAMPLE_COVERAGE: MdeOnboarding = {
  tenantId: TENANT,
  deploymentPolicyUrl: POLICY_URL,
  platforms: [
    {
      platform: "windows",
      total: 3,
      onboarded: 2,
      notOnboarded: 1,
      coveragePct: 66.7,
      gaps: [
        {
          id: "device-3",
          deviceName: "WS-1003",
          platform: "windows",
          policyUrl: POLICY_URL,
        },
      ],
    },
    {
      platform: "macos",
      total: 1,
      onboarded: 1,
      notOnboarded: 0,
      coveragePct: 100,
      gaps: [],
    },
  ],
  totals: { total: 4, onboarded: 3, notOnboarded: 1, coveragePct: 75 },
};

class FakeMdeOnboardingProvider implements MdeOnboardingProvider {
  readonly calls: string[] = [];

  async getMdeOnboarding(tenantId: string): Promise<MdeOnboarding> {
    this.calls.push(tenantId);
    return { ...SAMPLE_COVERAGE, tenantId };
  }
}

function route(provider = new FakeMdeOnboardingProvider()) {
  const routes = createMdeOnboardingRoutes({
    provider,
    resolveCaller: () => ({
      tenantScope: tenantScope([TENANT]),
      permissions: [MDE_ONBOARDING_READ_PERMISSION],
    }),
  });
  const found = routes.find(
    (candidate) => candidate.method === "GET" && candidate.path === MDE_ONBOARDING_PATH,
  );
  if (!found) throw new Error(`route GET ${MDE_ONBOARDING_PATH} not found`);
  return { routes, found, provider };
}

describe("mde onboarding routes (T-0370)", () => {
  it("exposes GET /v1/tenants/:tenantId/defender/mde-onboarding", () => {
    const { routes } = route();
    expect(routes).toHaveLength(1);
    expect(routes[0]?.method).toBe("GET");
    expect(routes[0]?.path).toBe(MDE_ONBOARDING_PATH);
    expect(MDE_ONBOARDING_PATH).toBe("/v1/tenants/:tenantId/defender/mde-onboarding");
  });

  it("rejects unauthenticated requests with 401", async () => {
    const provider = new FakeMdeOnboardingProvider();
    const routes = createMdeOnboardingRoutes({
      provider,
      resolveCaller: () => undefined,
    });

    await expect(
      routes[0]?.handler({
        method: "GET",
        path: `/v1/tenants/${TENANT}/defender/mde-onboarding`,
        params: { tenantId: TENANT },
        query: new URLSearchParams(),
        headers: {},
      }),
    ).rejects.toMatchObject({ status: 401 });
  });

  it("rejects tenants outside caller scope with 403", async () => {
    const provider = new FakeMdeOnboardingProvider();
    const routes = createMdeOnboardingRoutes({
      provider,
      resolveCaller: () => ({
        tenantScope: tenantScope(["different-tenant"]),
        permissions: [MDE_ONBOARDING_READ_PERMISSION],
      }),
    });

    await expect(
      routes[0]?.handler({
        method: "GET",
        path: `/v1/tenants/${TENANT}/defender/mde-onboarding`,
        params: { tenantId: TENANT },
        query: new URLSearchParams(),
        headers: {},
      }),
    ).rejects.toMatchObject({ status: 403 });
  });

  it("rejects callers missing defender.read with 403", async () => {
    const provider = new FakeMdeOnboardingProvider();
    const routes = createMdeOnboardingRoutes({
      provider,
      resolveCaller: () => ({
        tenantScope: tenantScope([TENANT]),
        permissions: ["Identity.User.Read"],
      }),
    });

    await expect(
      routes[0]?.handler({
        method: "GET",
        path: `/v1/tenants/${TENANT}/defender/mde-onboarding`,
        params: { tenantId: TENANT },
        query: new URLSearchParams(),
        headers: {},
      }),
    ).rejects.toMatchObject({ status: 403 });
    expect(provider.calls).toHaveLength(0);
  });

  it("returns onboarded vs total by platform with gap lists", async () => {
    const { found, provider } = route();
    const caller: MdeOnboardingCaller = {
      tenantScope: tenantScope([TENANT]),
      permissions: [MDE_ONBOARDING_READ_PERMISSION],
    };
    const routes = createMdeOnboardingRoutes({
      provider,
      resolveCaller: () => caller,
    });

    const response = await routes[0]?.handler({
      method: "GET",
      path: `/v1/tenants/${TENANT}/defender/mde-onboarding`,
      params: { tenantId: TENANT },
      query: new URLSearchParams(),
      headers: {},
    });

    expect(response?.status).toBe(200);
    const body = response?.body as MdeOnboarding;
    expect(body.tenantId).toBe(TENANT);
    expect(body.deploymentPolicyUrl).toBe(POLICY_URL);
    const windows = body.platforms.find((entry) => entry.platform === "windows");
    expect(windows?.total).toBe(3);
    expect(windows?.onboarded).toBe(2);
    expect(windows?.notOnboarded).toBe(1);
    expect(windows?.gaps).toHaveLength(1);
    expect(windows?.gaps[0]?.policyUrl).toBe(POLICY_URL);
    const macos = body.platforms.find((entry) => entry.platform === "macos");
    expect(macos?.gaps).toHaveLength(0);
    expect(body.totals.total).toBe(4);
    expect(body.totals.onboarded).toBe(3);
    expect(body.totals.notOnboarded).toBe(1);
    expect(provider.calls).toEqual([TENANT]);
    void found;
  });

  it("publishes the defender.read permission through the route module", () => {
    const entry =
      MDE_ONBOARDING_OPENAPI.paths["/tenants/{tenantId}/defender/mde-onboarding"];
    expect(entry.get.permission).toBe("Security.Defender.Read");
    expect(entry.get.operationId).toBe("getMdeOnboarding");
    expect(MDE_ONBOARDING_READ_PERMISSION).toBe("Security.Defender.Read");
  });
});
