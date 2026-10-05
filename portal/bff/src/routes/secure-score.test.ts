import { describe, expect, it } from "vitest";
import { AppError } from "../errors.js";
import { tenantScope } from "../rbac/scope.js";
import {
  SECURE_SCORE_OPENAPI,
  SECURE_SCORE_PATH,
  SECURE_SCORE_READ_PERMISSION,
  createSecureScoreRoutes,
  type ProviderSecureScore,
  type SecureScore,
  type SecureScoreCaller,
  type SecureScoreProvider,
} from "./secure-score.js";

const TENANT = "tenant-test";

const SAMPLE_SCORE: ProviderSecureScore = {
  tenantId: TENANT,
  current: 42.5,
  max: 100,
  percentage: 42.5,
  categories: [
    { category: "Identity", achieved: 20, available: 40, percentage: 50 },
    { category: "Data", achieved: 22.5, available: 60, percentage: 37.5 },
  ],
  actions: [
    {
      id: "MFARegistrationV2",
      title: "Ensure multifactor authentication is enabled for all users",
      category: "Identity",
      pointsAchieved: 20,
      pointsAvailable: 40,
      impact: "High",
      implementationStatus: "Implemented",
    },
    {
      id: "DataClassification",
      title: "Apply sensitivity labels",
      category: "Data",
      pointsAchieved: 22.5,
      pointsAvailable: 60,
      impact: "Medium",
      implementationStatus: "NotImplemented",
    },
  ],
};

class FakeSecureScoreProvider implements SecureScoreProvider {
  readonly calls: string[] = [];

  async getSecureScore(tenantId: string): Promise<ProviderSecureScore> {
    this.calls.push(tenantId);
    return { ...SAMPLE_SCORE, tenantId };
  }
}

function route(provider = new FakeSecureScoreProvider()) {
  const routes = createSecureScoreRoutes({
    provider,
    resolveCaller: () => ({
      tenantScope: tenantScope([TENANT]),
      permissions: [SECURE_SCORE_READ_PERMISSION],
    }),
  });
  const found = routes.find(
    (candidate) => candidate.method === "GET" && candidate.path === SECURE_SCORE_PATH,
  );
  if (!found) throw new Error(`route GET ${SECURE_SCORE_PATH} not found`);
  return { routes, found, provider };
}

describe("secure score routes (T-0602)", () => {
  it("exposes GET /v1/tenants/:tenantId/secure-score", () => {
    const { routes } = route();
    expect(routes).toHaveLength(1);
    expect(routes[0]?.method).toBe("GET");
    expect(routes[0]?.path).toBe(SECURE_SCORE_PATH);
    expect(SECURE_SCORE_PATH).toBe("/v1/tenants/:tenantId/secure-score");
  });

  it("rejects unauthenticated requests with 401", async () => {
    const provider = new FakeSecureScoreProvider();
    const routes = createSecureScoreRoutes({ provider, resolveCaller: () => undefined });

    await expect(
      routes[0]?.handler({
        method: "GET",
        path: `/v1/tenants/${TENANT}/secure-score`,
        params: { tenantId: TENANT },
        query: new URLSearchParams(),
        headers: {},
      }),
    ).rejects.toMatchObject({ status: 401 });
    expect(provider.calls).toHaveLength(0);
  });

  it("rejects tenants outside caller scope with 403", async () => {
    const provider = new FakeSecureScoreProvider();
    const routes = createSecureScoreRoutes({
      provider,
      resolveCaller: () => ({
        tenantScope: tenantScope(["different-tenant"]),
        permissions: [SECURE_SCORE_READ_PERMISSION],
      }),
    });

    await expect(
      routes[0]?.handler({
        method: "GET",
        path: `/v1/tenants/${TENANT}/secure-score`,
        params: { tenantId: TENANT },
        query: new URLSearchParams(),
        headers: {},
      }),
    ).rejects.toMatchObject({ status: 403 });
    expect(provider.calls).toHaveLength(0);
  });

  it("rejects callers missing Security.SecureScore.Read with a structured 403", async () => {
    const provider = new FakeSecureScoreProvider();
    const routes = createSecureScoreRoutes({
      provider,
      resolveCaller: () => ({
        tenantScope: tenantScope([TENANT]),
        permissions: ["Identity.User.Read"],
      }),
    });

    const error = await routes[0]
      ?.handler({
        method: "GET",
        path: `/v1/tenants/${TENANT}/secure-score`,
        params: { tenantId: TENANT },
        query: new URLSearchParams(),
        headers: {},
      })
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(AppError);
    const appError = error as AppError;
    expect(appError.status).toBe(403);
    expect(appError.code).toBe("auth.forbidden");
    expect(appError.details?.[0]?.reason).toBe(SECURE_SCORE_READ_PERMISSION);
    expect(provider.calls).toHaveLength(0);
  });

  it("returns current, max, percentage, and the category split", async () => {
    const { found, provider } = route();
    const caller: SecureScoreCaller = {
      tenantScope: tenantScope([TENANT]),
      permissions: [SECURE_SCORE_READ_PERMISSION],
    };
    const routes = createSecureScoreRoutes({ provider, resolveCaller: () => caller });

    const response = await routes[0]?.handler({
      method: "GET",
      path: `/v1/tenants/${TENANT}/secure-score`,
      params: { tenantId: TENANT },
      query: new URLSearchParams(),
      headers: {},
    });

    expect(response?.status).toBe(200);
    const body = response?.body as SecureScore;
    expect(body.tenantId).toBe(TENANT);
    expect(body.current).toBe(42.5);
    expect(body.max).toBe(100);
    expect(body.percentage).toBe(42.5);
    expect(body.categories.map((category) => category.category)).toEqual(["Identity", "Data"]);
    const identity = body.categories.find((category) => category.category === "Identity");
    expect(identity?.achieved).toBe(20);
    expect(identity?.available).toBe(40);
    expect(provider.calls).toEqual([TENANT]);
    void found;
  });

  it("returns improvement actions with points achieved/available and impact, unmapped", async () => {
    const { provider } = route();
    const routes = createSecureScoreRoutes({
      provider,
      resolveCaller: () => ({
        tenantScope: tenantScope([TENANT]),
        permissions: [SECURE_SCORE_READ_PERMISSION],
      }),
    });

    const response = await routes[0]?.handler({
      method: "GET",
      path: `/v1/tenants/${TENANT}/secure-score`,
      params: { tenantId: TENANT },
      query: new URLSearchParams(),
      headers: {},
    });

    const body = response?.body as SecureScore;
    expect(body.actions).toHaveLength(2);
    const action = body.actions.find((entry) => entry.id === "MFARegistrationV2");
    expect(action?.pointsAchieved).toBe(20);
    expect(action?.pointsAvailable).toBe(40);
    expect(action?.impact).toBe("High");
    expect(action?.implementationStatus).toBe("Implemented");
    // The action-to-check mapping is T-0603; until it lands every action is unmapped.
    expect(action?.check).toBeNull();
    expect(action?.standardKey).toBeNull();
  });

  it("publishes the Security.SecureScore.Read permission through the route module", () => {
    const entry = SECURE_SCORE_OPENAPI.paths["/tenants/{tenantId}/secure-score"];
    expect(entry.get.permission).toBe("Security.SecureScore.Read");
    expect(entry.get.operationId).toBe("getSecureScore");
    expect(SECURE_SCORE_READ_PERMISSION).toBe("Security.SecureScore.Read");
  });
});
