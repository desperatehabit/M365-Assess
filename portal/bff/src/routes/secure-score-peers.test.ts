import { describe, expect, it } from "vitest";
import { AppError } from "../errors.js";
import { tenantScope } from "../rbac/scope.js";
import type { ProviderSecureScore } from "./secure-score.js";
import {
  SECURE_SCORE_PEERS_OPENAPI,
  SECURE_SCORE_PEERS_PATH,
  SECURE_SCORE_PEERS_PERMISSION,
  createSecureScorePeersRoutes,
  toSecureScorePeers,
  type ProviderSecureScoreWithComparisons,
  type SecureScoreCaller,
  type SecureScoreComparison,
  type SecureScorePeers,
  type SecureScorePeersProvider,
} from "./secure-score-peers.js";

const TENANT = "tenant-test";

const SAMPLE_SCORE: ProviderSecureScore = {
  tenantId: TENANT,
  current: 42.5,
  max: 100,
  percentage: 42.5,
  categories: [],
  actions: [],
};

const COMPARISONS: readonly SecureScoreComparison[] = [
  { basis: "All", averageScore: 38.25 },
  { basis: "Vertical", averageScore: 51.5 },
];

class FakeSecureScorePeersProvider implements SecureScorePeersProvider {
  readonly calls: string[] = [];
  readonly comparisons?: readonly SecureScoreComparison[];

  constructor(comparisons?: readonly SecureScoreComparison[]) {
    this.comparisons = comparisons;
  }

  async getSecureScore(tenantId: string): Promise<ProviderSecureScoreWithComparisons> {
    this.calls.push(tenantId);
    return {
      ...SAMPLE_SCORE,
      tenantId,
      ...(this.comparisons === undefined
        ? {}
        : { averageComparativeScores: this.comparisons }),
    };
  }
}

function context(method: string, path: string) {
  return {
    method,
    path,
    params: { tenantId: TENANT },
    query: new URLSearchParams(),
    headers: {},
  };
}

function routesFor(options?: {
  provider?: FakeSecureScorePeersProvider;
  caller?: () => SecureScoreCaller | undefined;
}) {
  const provider = options?.provider ?? new FakeSecureScorePeersProvider(COMPARISONS);
  const routes = createSecureScorePeersRoutes({
    provider,
    resolveCaller:
      options?.caller ??
      (() => ({
        tenantScope: tenantScope([TENANT]),
        permissions: [SECURE_SCORE_PEERS_PERMISSION],
      })),
  });
  const found = routes.find(
    (candidate) => candidate.method === "GET" && candidate.path === SECURE_SCORE_PEERS_PATH,
  );
  if (!found) throw new Error(`route GET ${SECURE_SCORE_PEERS_PATH} not found`);
  return { routes, found, provider };
}

describe("secure score peers routes (T-0605)", () => {
  it("exposes GET /v1/tenants/:tenantId/secure-score/peers", () => {
    const { routes } = routesFor();
    expect(routes).toHaveLength(1);
    expect(routes[0]?.method).toBe("GET");
    expect(routes[0]?.path).toBe(SECURE_SCORE_PEERS_PATH);
    expect(SECURE_SCORE_PEERS_PATH).toBe("/v1/tenants/:tenantId/secure-score/peers");
  });

  it("rejects unauthenticated requests with 401", async () => {
    const provider = new FakeSecureScorePeersProvider(COMPARISONS);
    const { found } = routesFor({ provider, caller: () => undefined });

    await expect(found.handler(context("GET", SECURE_SCORE_PEERS_PATH))).rejects.toMatchObject({
      status: 401,
    });
    expect(provider.calls).toHaveLength(0);
  });

  it("rejects tenants outside caller scope with 403", async () => {
    const provider = new FakeSecureScorePeersProvider(COMPARISONS);
    const { found } = routesFor({
      provider,
      caller: () => ({
        tenantScope: tenantScope(["different-tenant"]),
        permissions: [SECURE_SCORE_PEERS_PERMISSION],
      }),
    });

    await expect(found.handler(context("GET", SECURE_SCORE_PEERS_PATH))).rejects.toMatchObject({
      status: 403,
    });
    expect(provider.calls).toHaveLength(0);
  });

  it("rejects callers missing Security.SecureScore.Read with a structured 403", async () => {
    const provider = new FakeSecureScorePeersProvider(COMPARISONS);
    const { found } = routesFor({
      provider,
      caller: () => ({
        tenantScope: tenantScope([TENANT]),
        permissions: ["Identity.User.Read"],
      }),
    });

    const error = await found
      .handler(context("GET", SECURE_SCORE_PEERS_PATH))
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(AppError);
    const appError = error as AppError;
    expect(appError.status).toBe(403);
    expect(appError.code).toBe("auth.forbidden");
    expect(appError.details?.[0]?.reason).toBe(SECURE_SCORE_PEERS_PERMISSION);
    expect(provider.calls).toHaveLength(0);
  });

  it("returns similar-organisation and all-organisation comparisons when present", async () => {
    const { found, provider } = routesFor({
      provider: new FakeSecureScorePeersProvider(COMPARISONS),
    });

    const response = await found.handler(context("GET", SECURE_SCORE_PEERS_PATH));

    expect(response?.status).toBe(200);
    const body = response?.body as SecureScorePeers;
    expect(body.tenantId).toBe(TENANT);
    expect(body.available).toBe(true);
    expect(body.comparisons).toHaveLength(2);
    const all = body.comparisons.find((entry) => entry.basis === "All");
    expect(all?.averageScore).toBe(38.25);
    const vertical = body.comparisons.find((entry) => entry.basis === "Vertical");
    expect(vertical?.averageScore).toBe(51.5);
    expect(provider.calls).toEqual([TENANT]);
  });

  it("reports unavailability without an error when Graph omits the comparison fields", async () => {
    const { found, provider } = routesFor({
      provider: new FakeSecureScorePeersProvider(undefined),
    });

    const response = await found.handler(context("GET", SECURE_SCORE_PEERS_PATH));

    expect(response?.status).toBe(200);
    const body = response?.body as SecureScorePeers;
    expect(body.tenantId).toBe(TENANT);
    expect(body.available).toBe(false);
    expect(body.comparisons).toEqual([]);
    expect(provider.calls).toEqual([TENANT]);
  });

  it("reports unavailability when Graph returns an empty comparison list", async () => {
    const { found } = routesFor({ provider: new FakeSecureScorePeersProvider([]) });

    const response = await found.handler(context("GET", SECURE_SCORE_PEERS_PATH));

    expect(response?.status).toBe(200);
    const body = response?.body as SecureScorePeers;
    expect(body.available).toBe(false);
    expect(body.comparisons).toEqual([]);
  });

  it("invents no peer value when Microsoft provides none", () => {
    const absent = toSecureScorePeers(TENANT, { ...SAMPLE_SCORE, tenantId: TENANT });
    expect(absent).toEqual({ tenantId: TENANT, available: false, comparisons: [] });

    const empty = toSecureScorePeers(TENANT, {
      ...SAMPLE_SCORE,
      tenantId: TENANT,
      averageComparativeScores: [],
    });
    expect(empty).toEqual({ tenantId: TENANT, available: false, comparisons: [] });
  });

  it("surfaces only the values Microsoft returned", () => {
    const score: ProviderSecureScoreWithComparisons = {
      ...SAMPLE_SCORE,
      tenantId: TENANT,
      averageComparativeScores: [{ basis: "Seats", averageScore: 47 }],
    };
    const body = toSecureScorePeers(TENANT, score);
    expect(body.available).toBe(true);
    expect(body.comparisons).toEqual([{ basis: "Seats", averageScore: 47 }]);
  });

  it("publishes the Security.SecureScore.Read permission through the route module", () => {
    const entry = SECURE_SCORE_PEERS_OPENAPI.paths["/tenants/{tenantId}/secure-score/peers"];
    expect(entry.get.permission).toBe("Security.SecureScore.Read");
    expect(entry.get.operationId).toBe("getSecureScorePeers");
    expect(SECURE_SCORE_PEERS_PERMISSION).toBe("Security.SecureScore.Read");
  });
});
