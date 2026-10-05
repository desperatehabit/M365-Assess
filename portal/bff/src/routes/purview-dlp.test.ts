// T-0582 — Purview DLP policy read API.
// Route-level tests: the read routes validate Purview.Compliance.Read + tenant scope and
// return the provider's live cursor page / single policy; callers missing the
// permission get a structured 403 and unknown policies a 404.

import { describe, expect, it } from "vitest";
import { tenantScope } from "../rbac/scope.js";
import type { RequestContext } from "../server.js";
import {
  PURVIEW_DLP_ITEM_PATH,
  PURVIEW_DLP_NOT_FOUND,
  PURVIEW_DLP_PATH,
  PURVIEW_READ_PERMISSION,
  createPurviewDlpRoutes,
  type PurviewDlpFilter,
  type PurviewDlpPage,
  type PurviewDlpPolicy,
  type PurviewDlpProvider,
} from "./purview-dlp.js";

const TENANT = "tenant-test";

const POLICY: PurviewDlpPolicy = {
  id: "policy-1",
  name: "Finance DLP",
  state: "enabled",
  locations: ["Exchange", "SharePoint"],
  rules: 2,
  lastModified: "2026-05-01T10:00:00.000Z",
};

const DISABLED_POLICY: PurviewDlpPolicy = {
  id: "policy-2",
  name: "Legal Hold DLP",
  state: "disabled",
  locations: ["Teams", "Endpoint"],
  rules: 1,
  lastModified: "2026-06-02T11:00:00.000Z",
};

const PAGE: PurviewDlpPage = {
  tenantId: TENANT,
  items: [POLICY, DISABLED_POLICY],
  nextCursor: null,
  totalCount: 2,
};

class FakeDlpProvider implements PurviewDlpProvider {
  readonly listCalls: Array<{ tenantId: string; filter?: PurviewDlpFilter }> = [];
  readonly getCalls: Array<{ tenantId: string; policyId: string }> = [];

  async listPolicies(tenantId: string, filter?: PurviewDlpFilter): Promise<PurviewDlpPage> {
    this.listCalls.push({ tenantId, filter });
    return PAGE;
  }

  async getPolicy(tenantId: string, policyId: string): Promise<PurviewDlpPolicy | undefined> {
    this.getCalls.push({ tenantId, policyId });
    return [POLICY, DISABLED_POLICY].find((policy) => policy.id === policyId);
  }
}

function readerCaller() {
  return {
    tenantScope: tenantScope([TENANT]),
    permissions: [PURVIEW_READ_PERMISSION],
  };
}

function routeByPath(
  routes: ReturnType<typeof createPurviewDlpRoutes>,
  method: string,
  path: string,
) {
  const route = routes.find((r) => r.method === method && r.path === path);
  if (!route) throw new Error(`missing route ${method} ${path}`);
  return route;
}

function ctx(
  path: string,
  options: { params?: Record<string, string>; query?: Record<string, string> } = {},
): RequestContext {
  return {
    correlationId: "corr-dlp-1",
    method: "GET",
    path,
    query: new URLSearchParams(options.query ?? {}),
    headers: {},
    params: options.params ?? {},
  };
}

function makeRoutes(
  overrides: {
    provider?: PurviewDlpProvider;
    resolveCaller?: () => ReturnType<typeof readerCaller> | undefined;
  } = {},
) {
  return createPurviewDlpRoutes({
    provider: overrides.provider ?? new FakeDlpProvider(),
    resolveCaller: overrides.resolveCaller ?? readerCaller,
  });
}

describe("Purview DLP read routes (T-0582)", () => {
  it("exposes the list and detail read paths", () => {
    const routes = makeRoutes();
    expect(routes.map((route) => `${route.method} ${route.path}`)).toEqual([
      `GET ${PURVIEW_DLP_PATH}`,
      `GET ${PURVIEW_DLP_ITEM_PATH}`,
    ]);
  });

  it("rejects unauthenticated reads with 401", async () => {
    const routes = makeRoutes({ resolveCaller: () => undefined });
    await expect(
      routeByPath(routes, "GET", PURVIEW_DLP_PATH).handler(
        ctx(`/v1/tenants/${TENANT}/purview/dlp`, { params: { tenantId: TENANT } }),
      ),
    ).rejects.toMatchObject({ status: 401 });
  });

  it("rejects a tenant outside caller scope with 403", async () => {
    const routes = createPurviewDlpRoutes({
      provider: new FakeDlpProvider(),
      resolveCaller: () => ({
        tenantScope: tenantScope(["different-tenant"]),
        permissions: [PURVIEW_READ_PERMISSION],
      }),
    });
    await expect(
      routeByPath(routes, "GET", PURVIEW_DLP_PATH).handler(
        ctx(`/v1/tenants/${TENANT}/purview/dlp`, { params: { tenantId: TENANT } }),
      ),
    ).rejects.toMatchObject({ status: 403 });
  });

  it("rejects callers missing Purview.Compliance.Read with a structured 403", async () => {
    const routes = makeRoutes({
      resolveCaller: () => ({
        tenantScope: tenantScope([TENANT]),
        permissions: ["SomeOther.Read"],
      }),
    });
    await expect(
      routeByPath(routes, "GET", PURVIEW_DLP_PATH).handler(
        ctx(`/v1/tenants/${TENANT}/purview/dlp`, { params: { tenantId: TENANT } }),
      ),
    ).rejects.toMatchObject({ status: 403, code: "auth.forbidden" });
  });

  it("lists policies with the §3.1 columns and pagination metadata", async () => {
    const routes = makeRoutes();
    const response = await routeByPath(routes, "GET", PURVIEW_DLP_PATH).handler(
      ctx(`/v1/tenants/${TENANT}/purview/dlp`, { params: { tenantId: TENANT } }),
    );
    expect(response.status).toBe(200);
    const body = response.body as {
      tenantId: string;
      items: PurviewDlpPolicy[];
      totalCount: number;
      nextCursor: string | null;
    };
    expect(body.tenantId).toBe(TENANT);
    expect(body.items).toHaveLength(2);
    expect(body.items[0]).toMatchObject({
      id: "policy-1",
      name: "Finance DLP",
      state: "enabled",
      rules: 2,
      lastModified: "2026-05-01T10:00:00.000Z",
    });
    expect(body.items[0]?.locations).toEqual(["Exchange", "SharePoint"]);
    expect(body.totalCount).toBe(2);
  });

  it("forwards the tenant, search, state, limit, and cursor to the provider", async () => {
    const provider = new FakeDlpProvider();
    const routes = makeRoutes({ provider });
    await routeByPath(routes, "GET", PURVIEW_DLP_PATH).handler(
      ctx(`/v1/tenants/${TENANT}/purview/dlp`, {
        params: { tenantId: TENANT },
        query: { search: "finance", state: "enabled", limit: "25", cursor: "opaque" },
      }),
    );
    expect(provider.listCalls).toHaveLength(1);
    expect(provider.listCalls[0]?.tenantId).toBe(TENANT);
    expect(provider.listCalls[0]?.filter).toMatchObject({
      search: "finance",
      state: "enabled",
      limit: 25,
      cursor: "opaque",
    });
  });

  it("returns the provider cursor for the next page", async () => {
    const provider: PurviewDlpProvider = {
      async listPolicies(tenantId: string): Promise<PurviewDlpPage> {
        return { tenantId, items: [POLICY], nextCursor: "next-page", totalCount: 3 };
      },
      async getPolicy(): Promise<PurviewDlpPolicy | undefined> {
        return undefined;
      },
    };
    const routes = makeRoutes({ provider });
    const response = await routeByPath(routes, "GET", PURVIEW_DLP_PATH).handler(
      ctx(`/v1/tenants/${TENANT}/purview/dlp`, {
        params: { tenantId: TENANT },
        query: { limit: "1" },
      }),
    );
    const body = response.body as { nextCursor: string | null; totalCount: number };
    expect(body.nextCursor).toBe("next-page");
    expect(body.totalCount).toBe(3);
  });

  it("returns one policy from the detail route", async () => {
    const provider = new FakeDlpProvider();
    const routes = makeRoutes({ provider });
    const response = await routeByPath(routes, "GET", PURVIEW_DLP_ITEM_PATH).handler(
      ctx(`/v1/tenants/${TENANT}/purview/dlp/policy-2`, {
        params: { tenantId: TENANT, policyId: "policy-2" },
      }),
    );
    expect(response.status).toBe(200);
    const body = response.body as { tenantId: string; policy: PurviewDlpPolicy };
    expect(body.tenantId).toBe(TENANT);
    expect(body.policy).toMatchObject({ id: "policy-2", state: "disabled", rules: 1 });
    expect(provider.getCalls).toEqual([{ tenantId: TENANT, policyId: "policy-2" }]);
  });

  it("returns a structured 404 for an unknown policy", async () => {
    const routes = makeRoutes();
    await expect(
      routeByPath(routes, "GET", PURVIEW_DLP_ITEM_PATH).handler(
        ctx(`/v1/tenants/${TENANT}/purview/dlp/missing`, {
          params: { tenantId: TENANT, policyId: "missing" },
        }),
      ),
    ).rejects.toMatchObject({ status: 404, code: PURVIEW_DLP_NOT_FOUND });
  });
});
