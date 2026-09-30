import { describe, expect, it } from "vitest";
import type { FeatureFlag, FeatureFlagInput } from "@m365-assess/db";
import { AppError } from "../errors.js";
import { assertFeatureEnabled, FEATURE_FLAG_DISABLED } from "../feature-flags/enforce.js";
import type { RequestContext, Route } from "../server.js";
import {
  FEATURE_FLAG_TENANT_SCOPE_DEFERRED,
  FEATURE_FLAGS_OPENAPI,
  FEATURE_FLAGS_PATH,
  FEATURE_FLAGS_READ_PERMISSION,
  FEATURE_FLAGS_WRITE_PERMISSION,
  createFeatureFlagRoutes,
  parseFeatureFlagInput,
  type FeatureFlagCaller,
  type FeatureFlagStore,
} from "./feature-flags.js";

function flag(key: string, enabled: boolean, description = ""): FeatureFlag {
  return {
    key,
    enabled,
    scope: "global",
    description,
    updatedAt: "2026-09-29T00:00:00.000Z",
    updatedBy: null,
  };
}

class FakeFeatureFlagStore implements FeatureFlagStore {
  private readonly rows = new Map<string, FeatureFlag>();

  async getFeatureFlags(): Promise<FeatureFlag[]> {
    return [...this.rows.values()]
      .map((entry) => ({ ...entry }))
      .sort((a, b) => a.key.localeCompare(b.key));
  }

  async upsertFeatureFlag(input: FeatureFlagInput): Promise<FeatureFlag> {
    const stored: FeatureFlag = {
      key: input.key,
      enabled: input.enabled,
      scope: input.scope ?? "global",
      description: input.description ?? "",
      updatedAt: "2026-09-29T00:00:00.000Z",
      updatedBy: input.updatedBy ?? null,
    };
    this.rows.set(input.key, stored);
    return { ...stored };
  }
}

function makeCaller(userId = "user-1"): FeatureFlagCaller {
  return { userId };
}

function authorizer(permissions: readonly string[]) {
  return (caller: FeatureFlagCaller, permission: string): void => {
    if (!permissions.includes(permission)) {
      throw new AppError("auth.forbidden", `forbidden: requires ${permission}`, 403);
    }
  };
}

function ctx(body?: unknown): RequestContext {
  return {
    correlationId: "corr-1",
    method: "PUT",
    path: FEATURE_FLAGS_PATH,
    params: {},
    query: new URLSearchParams(),
    headers: {},
    ...(body !== undefined ? { body } : {}),
  };
}

describe("parseFeatureFlagInput", () => {
  it("accepts a minimal global flag and defaults description", () => {
    expect(parseFeatureFlagInput({ key: "reports.executive", enabled: true })).toEqual({
      key: "reports.executive",
      enabled: true,
      scope: "global",
      description: "",
    });
  });

  it("rejects a missing key, a non-boolean enabled, and a non-string description", () => {
    expect(() => parseFeatureFlagInput({ enabled: true })).toThrow(AppError);
    expect(() => parseFeatureFlagInput({ key: "reports.executive", enabled: "yes" })).toThrow(
      AppError,
    );
    expect(() =>
      parseFeatureFlagInput({ key: "reports.executive", enabled: true, description: 7 }),
    ).toThrow(AppError);
  });

  it("rejects the reserved tenant scope with the structured deferred error", () => {
    let thrown: unknown;
    try {
      parseFeatureFlagInput({ key: "nav.diagnostics", enabled: true, scope: "tenant" });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(AppError);
    expect(thrown).toMatchObject({
      code: FEATURE_FLAG_TENANT_SCOPE_DEFERRED,
      status: 400,
    });
    expect((thrown as AppError).details).toEqual([{ field: "scope", reason: "tenant_scope_deferred" }]);
  });
});

describe("feature-flags route", () => {
  it("GET lists flags and requires the read permission", async () => {
    const store = new FakeFeatureFlagStore();
    await store.upsertFeatureFlag({ key: "reports.executive", enabled: true, description: "Executive reports" });

    const routes = createFeatureFlagRoutes({
      store,
      resolveCaller: () => makeCaller(),
      authorize: authorizer([FEATURE_FLAGS_READ_PERMISSION]),
    });
    const get = routes.find((route) => route.method === "GET")!;
    const response = await get.handler(ctx());
    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      flags: [flag("reports.executive", true, "Executive reports")],
    });

    const forbidden = createFeatureFlagRoutes({
      store,
      resolveCaller: () => makeCaller(),
      authorize: authorizer([FEATURE_FLAGS_WRITE_PERMISSION]),
    });
    const forbiddenGet = forbidden.find((route) => route.method === "GET")!;
    await expect(forbiddenGet.handler(ctx())).rejects.toMatchObject({
      code: "auth.forbidden",
      status: 403,
    });
  });

  it("GET requires an authenticated caller", async () => {
    const routes = createFeatureFlagRoutes({
      store: new FakeFeatureFlagStore(),
      resolveCaller: () => undefined,
      authorize: authorizer([FEATURE_FLAGS_READ_PERMISSION]),
    });
    const get = routes.find((route) => route.method === "GET")!;
    await expect(get.handler(ctx())).rejects.toMatchObject({ status: 401 });
  });

  it("PUT upserts a flag with the caller stamped and requires the write permission", async () => {
    const store = new FakeFeatureFlagStore();
    const routes = createFeatureFlagRoutes({
      store,
      resolveCaller: () => makeCaller("admin-user"),
      authorize: authorizer([FEATURE_FLAGS_READ_PERMISSION, FEATURE_FLAGS_WRITE_PERMISSION]),
    });
    const put = routes.find((route) => route.method === "PUT")!;

    const response = await put.handler(
      ctx({ key: "nav.diagnostics", enabled: false, description: "Diagnostics nav" }),
    );
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      flag: {
        key: "nav.diagnostics",
        enabled: false,
        scope: "global",
        updatedBy: "admin-user",
      },
    });
    expect(await store.getFeatureFlags()).toHaveLength(1);

    const readOnly = createFeatureFlagRoutes({
      store,
      resolveCaller: () => makeCaller(),
      authorize: authorizer([FEATURE_FLAGS_READ_PERMISSION]),
    });
    const readOnlyPut = readOnly.find((route) => route.method === "PUT")!;
    await expect(readOnlyPut.handler(ctx({ key: "nav.diagnostics", enabled: true }))).rejects.toMatchObject({
      code: "auth.forbidden",
      status: 403,
    });
  });

  it("PUT rejects the reserved tenant scope before touching the store", async () => {
    const store = new FakeFeatureFlagStore();
    const routes = createFeatureFlagRoutes({
      store,
      resolveCaller: () => makeCaller(),
      authorize: authorizer([FEATURE_FLAGS_READ_PERMISSION, FEATURE_FLAGS_WRITE_PERMISSION]),
    });
    const put = routes.find((route) => route.method === "PUT")!;
    await expect(
      put.handler(ctx({ key: "nav.diagnostics", enabled: true, scope: "tenant" })),
    ).rejects.toMatchObject({ code: FEATURE_FLAG_TENANT_SCOPE_DEFERRED, status: 400 });
    expect(await store.getFeatureFlags()).toEqual([]);
  });

  it("publishes the portal.v1.yaml fragment with the CIPP.AppSettings.* permissions", () => {
    const path = FEATURE_FLAGS_OPENAPI.paths["/feature-flags"];
    expect(path.get.permission).toBe(FEATURE_FLAGS_READ_PERMISSION);
    expect(path.put.permission).toBe(FEATURE_FLAGS_WRITE_PERMISSION);
    expect(FEATURE_FLAGS_OPENAPI.schemas.FeatureFlag.properties).toHaveProperty("scope");
    expect(FEATURE_FLAGS_OPENAPI.schemas.FeatureFlagInput.properties.scope.enum).toEqual(["global"]);
  });
});

describe("enforcement seam (SPEC §9)", () => {
  it("lets an endpoint behind an enabled flag through", async () => {
    const store = new FakeFeatureFlagStore();
    await store.upsertFeatureFlag({ key: "reports.executive", enabled: true });
    const gated: Route = {
      method: "GET",
      path: "/v1/reports/executive",
      handler: async () => {
        await assertFeatureEnabled(store, "reports.executive");
        return { status: 200, body: { ok: true } };
      },
    };
    const response = await gated.handler(ctx());
    expect(response.status).toBe(200);
  });

  it("returns the structured feature-disabled error when the flag is off", async () => {
    const store = new FakeFeatureFlagStore();
    await store.upsertFeatureFlag({ key: "reports.executive", enabled: false });
    const gated: Route = {
      method: "GET",
      path: "/v1/reports/executive",
      handler: async () => {
        await assertFeatureEnabled(store, "reports.executive");
        return { status: 200, body: { ok: true } };
      },
    };
    const error = await gated.handler(ctx()).then(
      () => undefined,
      (thrown) => thrown,
    );
    expect(error).toBeInstanceOf(AppError);
    expect(error).toMatchObject({ code: FEATURE_FLAG_DISABLED, status: 403 });
    expect((error as AppError).details).toEqual([{ field: "feature", reason: "disabled" }]);
  });
});
