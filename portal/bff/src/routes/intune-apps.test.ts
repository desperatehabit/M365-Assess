// Tests for the Intune apps BFF route (T-0321).
import { describe, expect, it } from "vitest";
import { tenantScope } from "../rbac/scope.js";
import {
  INTUNE_APPS_PATH,
  INTUNE_APPS_READ_PERMISSION,
  INTUNE_APPS_WRITE_PERMISSION,
  createIntuneAppsRoutes,
  parseIntuneAppsFilter,
  type IntuneAppsCaller,
  type IntuneAppsFilter,
  type IntuneAppsPage,
  type IntuneAppsProvider,
  type IntuneAppsRoutesOptions,
} from "./intune-apps.js";
import type { RequestContext } from "../server.js";

const TENANT = "tenant-apps-test";

class FakeIntuneAppsProvider implements IntuneAppsProvider {
  readonly calls: Array<{ tenantId: string; filter: IntuneAppsFilter }> = [];

  async listApps(tenantId: string, filter: IntuneAppsFilter): Promise<IntuneAppsPage> {
    this.calls.push({ tenantId, filter });
    if (filter.view === "detected") {
      return {
        tenantId,
        view: "detected",
        totalCount: 1,
        items: [
          {
            id: "det-1",
            displayName: "7-Zip",
            version: "23.01",
            publisher: "Igor Pavlov",
            platform: "windows",
            deviceCount: 12,
            sizeInByte: 5_000_000,
          },
        ],
        nextCursor: null,
      };
    }
    return {
      tenantId,
      view: "catalog",
      totalCount: 1,
      items: [
        {
          id: "app-1",
          displayName: "Company Portal",
          appType: "store",
          odataType: "#microsoft.graph.winGetApp",
          platform: "windows",
          publisher: "Microsoft",
          assignedCount: 2,
          publishingState: "published",
          lastModifiedDateTime: "2026-09-20T10:00:00Z",
        },
      ],
      unsupported: [{ appType: "office", count: 1 }],
      nextCursor: null,
    };
  }
}

function createHarness(overrides?: Partial<IntuneAppsRoutesOptions>) {
  const provider = new FakeIntuneAppsProvider();
  let caller: IntuneAppsCaller | undefined = {
    userId: "user-1",
    permissions: [INTUNE_APPS_READ_PERMISSION],
    tenantScope: tenantScope([TENANT]),
  };
  const routes = createIntuneAppsRoutes({ provider, resolveCaller: () => caller, ...overrides });
  const route = routes.find((r) => r.method === "GET" && r.path === INTUNE_APPS_PATH);
  if (!route) throw new Error("apps route not registered");
  return {
    provider,
    route,
    setCaller: (c: IntuneAppsCaller | undefined) => {
      caller = c;
    },
  };
}

function ctx(query: Record<string, string> = {}): RequestContext {
  return {
    correlationId: "corr-test",
    method: "GET",
    path: `/v1/tenants/${TENANT}/apps`,
    params: { tenantId: TENANT },
    query: new URLSearchParams(query),
    headers: {},
  };
}

describe("GET /v1/tenants/:tenantId/apps (T-0321)", () => {
  it("registers only the read route", () => {
    const routes = createIntuneAppsRoutes({ provider: new FakeIntuneAppsProvider(), resolveCaller: () => undefined });
    expect(routes.map((r) => `${r.method} ${r.path}`)).toEqual([`GET ${INTUNE_APPS_PATH}`]);
  });

  it("rejects an unauthenticated caller with 401", async () => {
    const h = createHarness({ resolveCaller: () => undefined });
    await expect(h.route.handler(ctx())).rejects.toMatchObject({ status: 401 });
  });

  it("rejects a caller without the apps read permission with 403", async () => {
    const h = createHarness();
    h.setCaller({ userId: "u", permissions: ["Endpoint.Intune.Read"], tenantScope: tenantScope([TENANT]) });
    await expect(h.route.handler(ctx())).rejects.toMatchObject({ status: 403, code: "auth.forbidden" });
    expect(h.provider.calls).toHaveLength(0);
  });

  it("accepts the write permission as implying read", async () => {
    const h = createHarness();
    h.setCaller({ userId: "u", permissions: [INTUNE_APPS_WRITE_PERMISSION], tenantScope: tenantScope([TENANT]) });
    await expect(h.route.handler(ctx())).resolves.toMatchObject({ status: 200 });
  });

  it("rejects a tenant outside the caller scope before reading", async () => {
    const h = createHarness();
    h.setCaller({ userId: "u", permissions: [INTUNE_APPS_READ_PERMISSION], tenantScope: tenantScope(["other"]) });
    await expect(h.route.handler(ctx())).rejects.toMatchObject({ status: 403 });
    expect(h.provider.calls).toHaveLength(0);
  });

  it("delegates to an injected authorizer with the read permission", async () => {
    const seen: string[] = [];
    const h = createHarness({ authorize: (_c, permission) => void seen.push(permission) });
    h.setCaller({ userId: "u", permissions: [], tenantScope: tenantScope([TENANT]) });
    await h.route.handler(ctx());
    expect(seen).toEqual([INTUNE_APPS_READ_PERMISSION]);
  });

  it("lists the catalog by default with type, platform, assignment, and modification info", async () => {
    const h = createHarness();
    const res = await h.route.handler(ctx());
    expect(res.status).toBe(200);
    const body = res.body as IntuneAppsPage;
    expect(body.view).toBe("catalog");
    expect(body.items[0]).toMatchObject({
      appType: "store",
      platform: "windows",
      assignedCount: 2,
      lastModifiedDateTime: "2026-09-20T10:00:00Z",
    });
    expect(h.provider.calls[0]!.filter.view).toBe("catalog");
  });

  it("passes unsupported-type counts through rather than dropping them", async () => {
    const h = createHarness();
    const body = (await h.route.handler(ctx())).body as IntuneAppsPage;
    expect(body.view === "catalog" && body.unsupported).toEqual([{ appType: "office", count: 1 }]);
  });

  it("lists detected apps for view=detected", async () => {
    const h = createHarness();
    const body = (await h.route.handler(ctx({ view: "detected" }))).body as IntuneAppsPage;
    expect(body.view).toBe("detected");
    expect(body.items[0]).toMatchObject({ displayName: "7-Zip", deviceCount: 12 });
  });

  it("forwards type, assigned, search, and paging to the provider", async () => {
    const h = createHarness();
    await h.route.handler(ctx({ type: "Win32", assigned: "false", search: "zip", cursor: "20", limit: "10" }));
    expect(h.provider.calls[0]).toEqual({
      tenantId: TENANT,
      filter: { view: "catalog", appType: "win32", assigned: false, search: "zip", cursor: "20", limit: 10 },
    });
  });

  it("returns 400 for an unknown view", async () => {
    const h = createHarness();
    await expect(h.route.handler(ctx({ view: "installed" }))).rejects.toMatchObject({
      status: 400,
      code: "request.validation_failed",
    });
  });

  it("returns 400 for an unknown app type", async () => {
    const h = createHarness();
    await expect(h.route.handler(ctx({ type: "msi" }))).rejects.toMatchObject({
      status: 400,
      code: "request.validation_failed",
    });
    expect(h.provider.calls).toHaveLength(0);
  });

  it.each(["office", "edge", "msp", "choco"])("returns 501 for the unsupported '%s' type", async (type) => {
    const h = createHarness();
    await expect(h.route.handler(ctx({ type }))).rejects.toMatchObject({
      status: 501,
      code: "intune.app-type.unsupported",
    });
    expect(h.provider.calls).toHaveLength(0);
  });

  it("rejects a type filter on the detected view", async () => {
    const h = createHarness();
    await expect(h.route.handler(ctx({ view: "detected", type: "win32" }))).rejects.toMatchObject({ status: 400 });
  });

  it("rejects an assigned value that is not a boolean", async () => {
    expect(() => parseIntuneAppsFilter(new URLSearchParams({ assigned: "yes" }))).toThrow(/assigned/);
  });
});
