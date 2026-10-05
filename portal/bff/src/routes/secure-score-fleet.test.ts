// T-0606 — Secure Score fleet overview endpoint.
import { describe, expect, it } from "vitest";
import { AppError } from "../errors.js";
import { ALL_TENANTS, tenantScope } from "../rbac/scope.js";
import type { SecureScoreSnapshotRecord } from "../repository/secure-score.js";
import type { RequestContext } from "../server.js";
import { SECURE_SCORE_READ_PERMISSION } from "./secure-score.js";
import {
  SECURE_SCORE_FLEET_OPENAPI,
  SECURE_SCORE_FLEET_PATH,
  SECURE_SCORE_FLEET_TREND_LIMIT,
  buildFleetTenant,
  createSecureScoreFleetRoutes,
  type SecureScoreFleet,
  type SecureScoreFleetRouteOptions,
  type SecureScoreFleetTenantSource,
} from "./secure-score-fleet.js";

const TENANT_A = "tenant-a";
const TENANT_B = "tenant-b";
const TENANT_C = "tenant-c";

function snapshot(
  tenantId: string,
  at: string,
  percentage: number,
): SecureScoreSnapshotRecord {
  return {
    id: `${tenantId}:${at}`,
    tenantId,
    at,
    current: percentage,
    max: 100,
    percentage,
    categories: {},
    createdAt: at,
  };
}

class FakeSnapshotRepository {
  readonly calls: string[] = [];

  constructor(
    private readonly byTenant: Readonly<Record<string, SecureScoreSnapshotRecord[]>> = {},
  ) {}

  async listSnapshots(tenantId: string): Promise<SecureScoreSnapshotRecord[]> {
    this.calls.push(tenantId);
    return [...(this.byTenant[tenantId] ?? [])];
  }
}

class FakeTenantSource implements SecureScoreFleetTenantSource {
  constructor(private readonly ids: readonly string[]) {}

  async listTenantIds(): Promise<readonly string[]> {
    return this.ids;
  }
}

function ctx(): RequestContext {
  return {
    method: "GET",
    path: SECURE_SCORE_FLEET_PATH,
    params: {},
    query: new URLSearchParams(),
    headers: {},
    correlationId: "test-correlation",
  };
}

function options(
  repository: FakeSnapshotRepository,
  tenantIds: readonly string[],
  overrides: Partial<SecureScoreFleetRouteOptions> = {},
): SecureScoreFleetRouteOptions {
  return {
    repository,
    tenants: new FakeTenantSource(tenantIds),
    resolveCaller: () => ({
      tenantScope: ALL_TENANTS,
      permissions: [SECURE_SCORE_READ_PERMISSION],
    }),
    ...overrides,
  };
}

describe("secure score fleet route (T-0606)", () => {
  it("exposes GET /v1/secure-score/fleet", () => {
    const routes = createSecureScoreFleetRoutes(options(new FakeSnapshotRepository(), []));
    expect(routes).toHaveLength(1);
    expect(routes[0]?.method).toBe("GET");
    expect(routes[0]?.path).toBe(SECURE_SCORE_FLEET_PATH);
    expect(SECURE_SCORE_FLEET_PATH).toBe("/v1/secure-score/fleet");
  });

  it("returns the latest snapshot and a short trend series per tenant", async () => {
    const repository = new FakeSnapshotRepository({
      [TENANT_A]: [
        snapshot(TENANT_A, "2026-09-01T00:00:00.000Z", 40),
        snapshot(TENANT_A, "2026-09-02T00:00:00.000Z", 42),
        snapshot(TENANT_A, "2026-09-03T00:00:00.000Z", 45),
      ],
    });
    const routes = createSecureScoreFleetRoutes(options(repository, [TENANT_A]));

    const response = await routes[0]?.handler(ctx());
    expect(response?.status).toBe(200);
    const body = response?.body as SecureScoreFleet;
    expect(body.tenants).toHaveLength(1);
    const row = body.tenants[0]!;
    expect(row.tenantId).toBe(TENANT_A);
    expect(row.hasSnapshot).toBe(true);
    expect(row.at).toBe("2026-09-03T00:00:00.000Z");
    expect(row.current).toBe(45);
    expect(row.percentage).toBe(45);
    expect(row.trend.map((point) => point.percentage)).toEqual([40, 42, 45]);
    expect(row.trend.map((point) => point.at)).toEqual([
      "2026-09-01T00:00:00.000Z",
      "2026-09-02T00:00:00.000Z",
      "2026-09-03T00:00:00.000Z",
    ]);
  });

  it("caps the trend at the limit, keeping the most recent points", async () => {
    const repository = new FakeSnapshotRepository({
      [TENANT_A]: [
        snapshot(TENANT_A, "2026-09-01T00:00:00.000Z", 40),
        snapshot(TENANT_A, "2026-09-02T00:00:00.000Z", 41),
        snapshot(TENANT_A, "2026-09-03T00:00:00.000Z", 42),
      ],
    });
    const routes = createSecureScoreFleetRoutes(
      options(repository, [TENANT_A], { trendLimit: 2 }),
    );

    const response = await routes[0]?.handler(ctx());
    const row = (response?.body as SecureScoreFleet).tenants[0]!;
    expect(row.trend.map((point) => point.percentage)).toEqual([41, 42]);
    // The latest score still reflects the newest snapshot.
    expect(row.percentage).toBe(42);
  });

  it("filters tenants by the caller scope and never queries out-of-scope tenants", async () => {
    const repository = new FakeSnapshotRepository({
      [TENANT_A]: [snapshot(TENANT_A, "2026-09-03T00:00:00.000Z", 45)],
      [TENANT_B]: [snapshot(TENANT_B, "2026-09-03T00:00:00.000Z", 70)],
      [TENANT_C]: [snapshot(TENANT_C, "2026-09-03T00:00:00.000Z", 10)],
    });
    const routes = createSecureScoreFleetRoutes(
      options(repository, [TENANT_A, TENANT_B, TENANT_C], {
        resolveCaller: () => ({
          tenantScope: tenantScope([TENANT_A]),
          permissions: [SECURE_SCORE_READ_PERMISSION],
        }),
      }),
    );

    const response = await routes[0]?.handler(ctx());
    const body = response?.body as SecureScoreFleet;
    expect(body.tenants.map((row) => row.tenantId)).toEqual([TENANT_A]);
    // The out-of-scope tenants are never read, not merely hidden afterwards.
    expect(repository.calls).toEqual([TENANT_A]);
  });

  it("reports a tenant with no snapshot instead of omitting it", async () => {
    const repository = new FakeSnapshotRepository({
      [TENANT_A]: [snapshot(TENANT_A, "2026-09-03T00:00:00.000Z", 45)],
    });
    const routes = createSecureScoreFleetRoutes(
      options(repository, [TENANT_A, TENANT_B]),
    );

    const response = await routes[0]?.handler(ctx());
    const body = response?.body as SecureScoreFleet;
    expect(body.tenants.map((row) => row.tenantId)).toEqual([TENANT_A, TENANT_B]);
    const empty = body.tenants.find((row) => row.tenantId === TENANT_B);
    expect(empty).toMatchObject({
      hasSnapshot: false,
      at: null,
      current: null,
      max: null,
      percentage: null,
      trend: [],
    });
  });

  it("returns every fleet tenant for an all-tenants caller", async () => {
    const repository = new FakeSnapshotRepository({
      [TENANT_A]: [snapshot(TENANT_A, "2026-09-03T00:00:00.000Z", 45)],
      [TENANT_B]: [snapshot(TENANT_B, "2026-09-03T00:00:00.000Z", 70)],
    });
    const routes = createSecureScoreFleetRoutes(
      options(repository, [TENANT_A, TENANT_B], {
        resolveCaller: () => ({
          tenantScope: ALL_TENANTS,
          permissions: [SECURE_SCORE_READ_PERMISSION],
        }),
      }),
    );

    const response = await routes[0]?.handler(ctx());
    const body = response?.body as SecureScoreFleet;
    expect(body.tenants.map((row) => row.tenantId)).toEqual([TENANT_A, TENANT_B]);
    expect(repository.calls.sort()).toEqual([TENANT_A, TENANT_B]);
  });

  it("rejects unauthenticated requests with 401 without reading snapshots", async () => {
    const repository = new FakeSnapshotRepository();
    const routes = createSecureScoreFleetRoutes(
      options(repository, [TENANT_A], { resolveCaller: () => undefined }),
    );

    await expect(routes[0]?.handler(ctx())).rejects.toMatchObject({ status: 401 });
    expect(repository.calls).toHaveLength(0);
  });

  it("rejects callers missing Security.SecureScore.Read with a structured 403", async () => {
    const repository = new FakeSnapshotRepository();
    const routes = createSecureScoreFleetRoutes(
      options(repository, [TENANT_A], {
        resolveCaller: () => ({
          tenantScope: ALL_TENANTS,
          permissions: ["Identity.User.Read"],
        }),
      }),
    );

    const error = await routes[0]
      ?.handler(ctx())
      .catch((thrown: unknown) => thrown);

    expect(error).toBeInstanceOf(AppError);
    const appError = error as AppError;
    expect(appError.status).toBe(403);
    expect(appError.code).toBe("auth.forbidden");
    expect(appError.details?.[0]?.reason).toBe(SECURE_SCORE_READ_PERMISSION);
    expect(repository.calls).toHaveLength(0);
  });

  it("documents the fleet endpoint", () => {
    const entry = SECURE_SCORE_FLEET_OPENAPI.paths["/secure-score/fleet"];
    expect(entry.get.permission).toBe(SECURE_SCORE_READ_PERMISSION);
    expect(entry.get.operationId).toBe("getSecureScoreFleet");
    expect(SECURE_SCORE_FLEET_TREND_LIMIT).toBeGreaterThan(0);
  });
});

describe("buildFleetTenant (T-0606)", () => {
  it("orders the trend oldest-first regardless of input order", () => {
    const row = buildFleetTenant(
      TENANT_A,
      [
        snapshot(TENANT_A, "2026-09-03T00:00:00.000Z", 45),
        snapshot(TENANT_A, "2026-09-01T00:00:00.000Z", 40),
        snapshot(TENANT_A, "2026-09-02T00:00:00.000Z", 42),
      ],
      12,
    );
    expect(row.trend.map((point) => point.percentage)).toEqual([40, 42, 45]);
    expect(row.percentage).toBe(45);
  });
});
