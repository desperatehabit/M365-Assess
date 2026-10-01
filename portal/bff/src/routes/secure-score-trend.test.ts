import { describe, expect, it } from "vitest";
import { AppError } from "../errors.js";
import { tenantScope } from "../rbac/scope.js";
import type { ProviderSecureScore, SecureScoreProvider } from "./secure-score.js";
import {
  SECURE_SCORE_SNAPSHOT_PATH,
  SECURE_SCORE_TREND_OPENAPI,
  SECURE_SCORE_TREND_PATH,
  SECURE_SCORE_TREND_PERMISSION,
  SECURE_SCORE_TREND_RETENTION_DAYS,
  createSecureScoreTrendRoutes,
  type SecureScoreSnapshotInput,
  type SecureScoreTrendSnapshot,
  type SecureScoreTrendStore,
} from "./secure-score-trend.js";

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
  actions: [],
};

class FakeSecureScoreProvider implements SecureScoreProvider {
  readonly calls: string[] = [];

  async getSecureScore(tenantId: string): Promise<ProviderSecureScore> {
    this.calls.push(tenantId);
    return { ...SAMPLE_SCORE, tenantId };
  }
}

class FakeTrendStore implements SecureScoreTrendStore {
  readonly snapshots: SecureScoreTrendSnapshot[] = [];
  readonly recorded: SecureScoreSnapshotInput[] = [];
  readonly pruneCalls: number[] = [];
  pruneCount = 0;

  async listSnapshots(tenantId: string): Promise<readonly SecureScoreTrendSnapshot[]> {
    return this.snapshots.filter((snapshot) => snapshot.tenantId === tenantId);
  }

  async recordSnapshot(input: SecureScoreSnapshotInput): Promise<SecureScoreTrendSnapshot> {
    this.recorded.push(input);
    const record: SecureScoreTrendSnapshot = {
      id: `snap-${this.recorded.length}`,
      tenantId: input.tenantId,
      at: input.at ?? "1970-01-01T00:00:00.000Z",
      current: input.current,
      max: input.max,
      percentage: input.percentage,
      categories: input.categories ?? {},
    };
    this.snapshots.push(record);
    return record;
  }

  async pruneSnapshots(options: {
    readonly retentionDays: number;
  }): Promise<{ prunedSnapshotsCount: number }> {
    this.pruneCalls.push(options.retentionDays);
    return { prunedSnapshotsCount: this.pruneCount };
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
  provider?: FakeSecureScoreProvider;
  store?: FakeTrendStore;
  retentionDays?: number;
  caller?: () => unknown;
}) {
  const provider = options?.provider ?? new FakeSecureScoreProvider();
  const store = options?.store ?? new FakeTrendStore();
  const routes = createSecureScoreTrendRoutes({
    provider,
    store,
    resolveCaller:
      (options?.caller as never) ??
      (() => ({
        tenantScope: tenantScope([TENANT]),
        permissions: [SECURE_SCORE_TREND_PERMISSION],
      })),
    ...(options?.retentionDays !== undefined ? { retentionDays: options.retentionDays } : {}),
  });
  const get = routes.find((r) => r.method === "GET" && r.path === SECURE_SCORE_TREND_PATH);
  const post = routes.find((r) => r.method === "POST" && r.path === SECURE_SCORE_SNAPSHOT_PATH);
  if (!get) throw new Error(`route GET ${SECURE_SCORE_TREND_PATH} not found`);
  if (!post) throw new Error(`route POST ${SECURE_SCORE_SNAPSHOT_PATH} not found`);
  return { routes, get, post, provider, store };
}

describe("secure score trend routes (T-0604)", () => {
  it("exposes GET trend and POST snapshot paths", () => {
    const { routes } = routesFor();
    expect(routes).toHaveLength(2);
    expect(SECURE_SCORE_TREND_PATH).toBe("/v1/tenants/:tenantId/secure-score/trend");
    expect(SECURE_SCORE_SNAPSHOT_PATH).toBe("/v1/tenants/:tenantId/secure-score/snapshot");
  });

  it("rejects unauthenticated requests with 401 on both routes", async () => {
    const { get, post, provider, store } = routesFor({ caller: () => undefined });

    await expect(get.handler(context("GET", SECURE_SCORE_TREND_PATH))).rejects.toMatchObject({
      status: 401,
    });
    await expect(post.handler(context("POST", SECURE_SCORE_SNAPSHOT_PATH))).rejects.toMatchObject({
      status: 401,
    });
    expect(provider.calls).toHaveLength(0);
    expect(store.recorded).toHaveLength(0);
  });

  it("rejects tenants outside caller scope with 403", async () => {
    const { get, provider, store } = routesFor({
      caller: () => ({ tenantScope: tenantScope(["different-tenant"]), permissions: ["*"] }),
    });

    await expect(get.handler(context("GET", SECURE_SCORE_TREND_PATH))).rejects.toMatchObject({
      status: 403,
    });
    expect(provider.calls).toHaveLength(0);
    expect(store.recorded).toHaveLength(0);
  });

  it("rejects callers missing secure-score.read with a structured 403", async () => {
    const { post, provider } = routesFor({
      caller: () => ({
        tenantScope: tenantScope([TENANT]),
        permissions: ["Identity.User.Read"],
      }),
    });

    const error = await post
      .handler(context("POST", SECURE_SCORE_SNAPSHOT_PATH))
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(AppError);
    const appError = error as AppError;
    expect(appError.status).toBe(403);
    expect(appError.code).toBe("auth.forbidden");
    expect(appError.details?.[0]?.reason).toBe(SECURE_SCORE_TREND_PERMISSION);
    expect(provider.calls).toHaveLength(0);
  });

  it("returns the tenant's snapshots in time order", async () => {
    const store = new FakeTrendStore();
    store.snapshots.push(
      {
        id: "later",
        tenantId: TENANT,
        at: "2026-02-01T00:00:00.000Z",
        current: 80,
        max: 100,
        percentage: 80,
        categories: {},
      },
      {
        id: "earlier",
        tenantId: TENANT,
        at: "2026-01-01T00:00:00.000Z",
        current: 40,
        max: 100,
        percentage: 40,
        categories: {},
      },
      {
        id: "other-tenant",
        tenantId: "other",
        at: "2026-01-15T00:00:00.000Z",
        current: 50,
        max: 100,
        percentage: 50,
        categories: {},
      },
    );

    const { get } = routesFor({ store });
    const response = await get.handler(context("GET", SECURE_SCORE_TREND_PATH));

    expect(response.status).toBe(200);
    const body = response.body as {
      tenantId: string;
      snapshots: SecureScoreTrendSnapshot[];
    };
    expect(body.tenantId).toBe(TENANT);
    expect(body.snapshots.map((snapshot) => snapshot.id)).toEqual(["earlier", "later"]);
  });

  it("records a snapshot from the T-0602 provider on demand", async () => {
    const { post, provider, store } = routesFor();
    store.pruneCount = 2;

    const response = await post.handler(context("POST", SECURE_SCORE_SNAPSHOT_PATH));

    expect(response.status).toBe(201);
    expect(provider.calls).toEqual([TENANT]);
    expect(store.recorded).toHaveLength(1);
    const recorded = store.recorded[0];
    expect(recorded?.tenantId).toBe(TENANT);
    expect(recorded?.current).toBe(42.5);
    expect(recorded?.max).toBe(100);
    expect(recorded?.percentage).toBe(42.5);
    expect(recorded?.categories).toEqual({
      Identity: { achieved: 20, available: 40, percentage: 50 },
      Data: { achieved: 22.5, available: 60, percentage: 37.5 },
    });

    const body = response.body as { snapshot: SecureScoreTrendSnapshot; prunedSnapshotsCount: number };
    expect(body.snapshot.current).toBe(42.5);
    expect(body.prunedSnapshotsCount).toBe(2);
  });

  it("prunes snapshots to the configured T-0601 retention window", async () => {
    const { post, store } = routesFor({ retentionDays: 30 });

    await post.handler(context("POST", SECURE_SCORE_SNAPSHOT_PATH));

    expect(store.pruneCalls).toEqual([30]);
  });

  it("uses the default retention window when none is configured", async () => {
    const { post, store } = routesFor();

    await post.handler(context("POST", SECURE_SCORE_SNAPSHOT_PATH));

    expect(store.pruneCalls).toEqual([SECURE_SCORE_TREND_RETENTION_DAYS]);
  });

  it("skips pruning when retention is disabled", async () => {
    const { post, store } = routesFor({ retentionDays: 0 });

    await post.handler(context("POST", SECURE_SCORE_SNAPSHOT_PATH));

    expect(store.pruneCalls).toEqual([]);
  });

  it("publishes the secure-score.read permission through the route module", () => {
    expect(SECURE_SCORE_TREND_PERMISSION).toBe("secure-score.read");
    const trend = SECURE_SCORE_TREND_OPENAPI.paths["/tenants/{tenantId}/secure-score/trend"];
    const snapshot =
      SECURE_SCORE_TREND_OPENAPI.paths["/tenants/{tenantId}/secure-score/snapshot"];
    expect(trend.get.permission).toBe("secure-score.read");
    expect(trend.get.operationId).toBe("getSecureScoreTrend");
    expect(snapshot.post.permission).toBe("secure-score.read");
    expect(snapshot.post.operationId).toBe("recordSecureScoreSnapshot");
  });
});
