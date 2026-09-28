import { describe, expect, it } from "vitest";
import { AppError } from "../errors.js";
import { tenantScope } from "../rbac/scope.js";
import {
  DEFENDER_STATUS_OPENAPI,
  DEFENDER_STATUS_PATH,
  DEFENDER_STATUS_READ_PERMISSION,
  createDefenderStatusRoutes,
  type DefenderStatus,
  type DefenderStatusCaller,
  type DefenderStatusProvider,
} from "./defender-status.js";

const TENANT = "tenant-test";

const SAMPLE_STATUS: DefenderStatus = {
  tenantId: TENANT,
  areas: [
    {
      area: "av",
      displayName: "Antivirus (AV)",
      source: "device-management",
      supported: true,
      current: "2 AV policies assigned",
      recommended: "Real-time protection enabled with up-to-date signatures",
      status: "Pass",
    },
    {
      area: "edr",
      displayName: "Endpoint Detection and Response (EDR)",
      source: "graph-security",
      supported: true,
      current: "MDE onboarded in block mode",
      recommended: "Devices onboarded to Defender for Endpoint in block mode",
      status: "Pass",
    },
    {
      area: "asr",
      displayName: "Attack Surface Reduction (ASR)",
      source: "device-management",
      supported: true,
      current: "ASR rules in block mode",
      recommended: "ASR rules in block or warn mode per baseline",
      status: "Warning",
    },
    {
      area: "compliance",
      displayName: "Device Compliance",
      source: "device-management",
      supported: false,
      current: "Not yet supported in v1",
      recommended: "Compliance policies assigned with conditional access",
      status: "Unsupported",
    },
    {
      area: "exclusions",
      displayName: "Exclusions",
      source: "exo",
      supported: false,
      current: "Not yet supported in v1",
      recommended: "No standing allow-list entries without expiry",
      status: "Unsupported",
    },
    {
      area: "firewall",
      displayName: "Firewall",
      source: "device-management",
      supported: false,
      current: "Not yet supported in v1",
      recommended: "Host firewall enabled on all profiles",
      status: "Unsupported",
    },
  ],
};

class FakeDefenderStatusProvider implements DefenderStatusProvider {
  readonly calls: string[] = [];

  async getDefenderStatus(tenantId: string): Promise<DefenderStatus> {
    this.calls.push(tenantId);
    return { ...SAMPLE_STATUS, tenantId };
  }
}

function route(provider = new FakeDefenderStatusProvider()) {
  const routes = createDefenderStatusRoutes({
    provider,
    resolveCaller: () => ({
      tenantScope: tenantScope([TENANT]),
      permissions: [DEFENDER_STATUS_READ_PERMISSION],
    }),
  });
  const found = routes.find(
    (candidate) => candidate.method === "GET" && candidate.path === DEFENDER_STATUS_PATH,
  );
  if (!found) throw new Error(`route GET ${DEFENDER_STATUS_PATH} not found`);
  return { routes, found, provider };
}

describe("defender status routes (T-0361)", () => {
  it("exposes GET /v1/tenants/:tenantId/defender/status", () => {
    const { routes } = route();
    expect(routes).toHaveLength(1);
    expect(routes[0]?.method).toBe("GET");
    expect(routes[0]?.path).toBe(DEFENDER_STATUS_PATH);
    expect(DEFENDER_STATUS_PATH).toBe("/v1/tenants/:tenantId/defender/status");
  });

  it("rejects unauthenticated requests with 401", async () => {
    const provider = new FakeDefenderStatusProvider();
    const routes = createDefenderStatusRoutes({
      provider,
      resolveCaller: () => undefined,
    });

    await expect(
      routes[0]?.handler({
        method: "GET",
        path: `/v1/tenants/${TENANT}/defender/status`,
        params: { tenantId: TENANT },
        query: new URLSearchParams(),
        headers: {},
      }),
    ).rejects.toMatchObject({ status: 401 });
  });

  it("rejects tenants outside caller scope with 403", async () => {
    const provider = new FakeDefenderStatusProvider();
    const routes = createDefenderStatusRoutes({
      provider,
      resolveCaller: () => ({
        tenantScope: tenantScope(["different-tenant"]),
        permissions: [DEFENDER_STATUS_READ_PERMISSION],
      }),
    });

    await expect(
      routes[0]?.handler({
        method: "GET",
        path: `/v1/tenants/${TENANT}/defender/status`,
        params: { tenantId: TENANT },
        query: new URLSearchParams(),
        headers: {},
      }),
    ).rejects.toMatchObject({ status: 403 });
  });

  it("rejects callers missing defender.read with 403", async () => {
    const provider = new FakeDefenderStatusProvider();
    const routes = createDefenderStatusRoutes({
      provider,
      resolveCaller: () => ({
        tenantScope: tenantScope([TENANT]),
        permissions: ["Identity.User.Read"],
      }),
    });

    await expect(
      routes[0]?.handler({
        method: "GET",
        path: `/v1/tenants/${TENANT}/defender/status`,
        params: { tenantId: TENANT },
        query: new URLSearchParams(),
        headers: {},
      }),
    ).rejects.toMatchObject({ status: 403 });
    expect(provider.calls).toHaveLength(0);
  });

  it("returns current vs recommended per policy area", async () => {
    const { found, provider } = route();
    const caller: DefenderStatusCaller = {
      tenantScope: tenantScope([TENANT]),
      permissions: [DEFENDER_STATUS_READ_PERMISSION],
    };
    const routes = createDefenderStatusRoutes({
      provider,
      resolveCaller: () => caller,
    });

    const response = await routes[0]?.handler({
      method: "GET",
      path: `/v1/tenants/${TENANT}/defender/status`,
      params: { tenantId: TENANT },
      query: new URLSearchParams(),
      headers: {},
    });

    expect(response?.status).toBe(200);
    const body = response?.body as DefenderStatus;
    expect(body.tenantId).toBe(TENANT);
    expect(body.areas.map((a) => a.area).sort()).toEqual([
      "asr",
      "av",
      "compliance",
      "edr",
      "exclusions",
      "firewall",
    ]);
    for (const area of body.areas) {
      expect(area.current, `current ${area.area}`).toBeTruthy();
      expect(area.recommended, `recommended ${area.area}`).toBeTruthy();
      expect(area.status, `status ${area.area}`).toBeTruthy();
    }
    const av = body.areas.find((a) => a.area === "av");
    expect(av?.supported).toBe(true);
    const firewall = body.areas.find((a) => a.area === "firewall");
    expect(firewall?.supported).toBe(false);
    expect(provider.calls).toEqual([TENANT]);
    void found;
  });

  it("narrows to one supported area with ?area=", async () => {
    const provider = new FakeDefenderStatusProvider();
    const routes = createDefenderStatusRoutes({
      provider,
      resolveCaller: () => ({
        tenantScope: tenantScope([TENANT]),
        permissions: [DEFENDER_STATUS_READ_PERMISSION],
      }),
    });

    const response = await routes[0]?.handler({
      method: "GET",
      path: `/v1/tenants/${TENANT}/defender/status`,
      params: { tenantId: TENANT },
      query: new URLSearchParams("area=av"),
      headers: {},
    });

    expect(response?.status).toBe(200);
    const body = response?.body as DefenderStatus;
    expect(body.areas).toHaveLength(1);
    expect(body.areas[0]?.area).toBe("av");
    expect(provider.calls).toEqual([TENANT]);
  });

  it("rejects unknown areas with 400", async () => {
    const provider = new FakeDefenderStatusProvider();
    const routes = createDefenderStatusRoutes({
      provider,
      resolveCaller: () => ({
        tenantScope: tenantScope([TENANT]),
        permissions: [DEFENDER_STATUS_READ_PERMISSION],
      }),
    });

    const error = await routes[0]
      ?.handler({
        method: "GET",
        path: `/v1/tenants/${TENANT}/defender/status`,
        params: { tenantId: TENANT },
        query: new URLSearchParams("area=unknown"),
        headers: {},
      })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(AppError);
    expect((error as AppError).status).toBe(400);
    expect(provider.calls).toHaveLength(0);
  });

  it("marks deferred areas as not yet supported with 501", async () => {
    const provider = new FakeDefenderStatusProvider();
    const routes = createDefenderStatusRoutes({
      provider,
      resolveCaller: () => ({
        tenantScope: tenantScope([TENANT]),
        permissions: [DEFENDER_STATUS_READ_PERMISSION],
      }),
    });

    for (const area of ["compliance", "firewall", "exclusions"]) {
      const error = await routes[0]
        ?.handler({
          method: "GET",
          path: `/v1/tenants/${TENANT}/defender/status`,
          params: { tenantId: TENANT },
          query: new URLSearchParams(`area=${area}`),
          headers: {},
        })
        .catch((e: unknown) => e);
      expect(error, `area=${area}`).toBeInstanceOf(AppError);
      expect((error as AppError).status, `area=${area}`).toBe(501);
    }
    expect(provider.calls).toHaveLength(0);
  });

  it("publishes the defender.read permission through the route module", () => {
    const entry =
      DEFENDER_STATUS_OPENAPI.paths["/tenants/{tenantId}/defender/status"];
    expect(entry.get.permission).toBe("Security.Defender.Read");
    expect(entry.get.operationId).toBe("getDefenderStatus");
    expect(DEFENDER_STATUS_READ_PERMISSION).toBe("Security.Defender.Read");
  });
});
