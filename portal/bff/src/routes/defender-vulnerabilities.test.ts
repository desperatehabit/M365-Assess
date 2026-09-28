import { describe, expect, it } from "vitest";
import { AppError } from "../errors.js";
import { tenantScope } from "../rbac/scope.js";
import {
  DEFENDER_VULNERABILITIES_OPENAPI,
  VULNERABILITIES_PATH,
  VULNERABILITIES_READ_PERMISSION,
  VULNERABILITY_DEVICES_PATH,
  createDefenderVulnerabilitiesRoutes,
  parseTvmVulnerabilitiesFilter,
  type TvmVulnerabilitiesCaller,
  type TvmVulnerabilitiesFilter,
  type TvmVulnerabilitiesPage,
  type TvmVulnerabilitiesProvider,
  type TvmVulnerabilityDevicesPage,
} from "./defender-vulnerabilities.js";

const TENANT = "tenant-test";
const CVE = "CVE-2026-12345";

const SAMPLE_PAGE: TvmVulnerabilitiesPage = {
  tenantId: TENANT,
  totalCount: 2,
  items: [
    {
      cve: CVE,
      severity: "high",
      cvss: 8.1,
      exposedDeviceCount: 2,
      affectedSoftware: ["Contoso VPN 4.2", "Contoso Agent 4.2"],
      recommendation: "Update Contoso VPN to 4.3 or later.",
      affectedDeviceIds: ["device-1", "device-2"],
    },
    {
      cve: "CVE-2026-99999",
      severity: "medium",
      cvss: 5.4,
      exposedDeviceCount: 1,
      affectedSoftware: ["Fabrikam Browser 120.0"],
      recommendation: "Update Fabrikam Browser to 121.0 or later.",
      affectedDeviceIds: ["device-3"],
    },
  ],
  nextCursor: null,
};

const SAMPLE_DEVICES: TvmVulnerabilityDevicesPage = {
  tenantId: TENANT,
  cve: CVE,
  totalCount: 2,
  items: [
    { id: "device-1", deviceName: "WS-1001" },
    { id: "device-2", deviceName: "WS-1002" },
  ],
  nextCursor: null,
};

class FakeTvmProvider implements TvmVulnerabilitiesProvider {
  readonly listCalls: Array<{ tenantId: string; filter: TvmVulnerabilitiesFilter }> = [];
  readonly deviceCalls: Array<{ tenantId: string; cveId: string }> = [];

  async listVulnerabilities(tenantId: string, filter: TvmVulnerabilitiesFilter): Promise<TvmVulnerabilitiesPage> {
    this.listCalls.push({ tenantId, filter });
    return { ...SAMPLE_PAGE, tenantId };
  }

  async listVulnerabilityDevices(
    tenantId: string,
    cveId: string,
  ): Promise<TvmVulnerabilityDevicesPage> {
    this.deviceCalls.push({ tenantId, cveId });
    return { ...SAMPLE_DEVICES, tenantId, cve: cveId };
  }
}

function route(method: string, path: string, provider = new FakeTvmProvider()) {
  const routes = createDefenderVulnerabilitiesRoutes({
    provider,
    resolveCaller: () => ({
      tenantScope: tenantScope([TENANT]),
      permissions: [VULNERABILITIES_READ_PERMISSION],
    }),
  });
  const found = routes.find((candidate) => candidate.method === method && candidate.path === path);
  if (!found) throw new Error(`route ${method} ${path} not found`);
  return { routes, found, provider };
}

describe("defender vulnerabilities routes (T-0366)", () => {
  it("exposes GET /v1/tenants/:tenantId/defender/vulnerabilities and its drill-through", () => {
    const { routes } = route("GET", VULNERABILITIES_PATH);
    expect(routes).toHaveLength(2);
    expect(routes[0]?.method).toBe("GET");
    expect(routes[0]?.path).toBe(VULNERABILITIES_PATH);
    expect(routes[1]?.method).toBe("GET");
    expect(routes[1]?.path).toBe(VULNERABILITY_DEVICES_PATH);
  });

  it("rejects unauthenticated requests with 401", async () => {
    const provider = new FakeTvmProvider();
    const routes = createDefenderVulnerabilitiesRoutes({
      provider,
      resolveCaller: () => undefined,
    });

    await expect(
      routes[0]?.handler({
        method: "GET",
        path: `/v1/tenants/${TENANT}/defender/vulnerabilities`,
        params: { tenantId: TENANT },
        query: new URLSearchParams(),
        headers: {},
      }),
    ).rejects.toMatchObject({ status: 401 });

    await expect(
      routes[1]?.handler({
        method: "GET",
        path: `/v1/tenants/${TENANT}/defender/vulnerabilities/${CVE}`,
        params: { tenantId: TENANT, cveId: CVE },
        query: new URLSearchParams(),
        headers: {},
      }),
    ).rejects.toMatchObject({ status: 401 });
  });

  it("rejects tenant outside caller scope with 403", async () => {
    const provider = new FakeTvmProvider();
    const routes = createDefenderVulnerabilitiesRoutes({
      provider,
      resolveCaller: () => ({
        tenantScope: tenantScope(["different-tenant"]),
        permissions: [VULNERABILITIES_READ_PERMISSION],
      }),
    });

    await expect(
      routes[0]?.handler({
        method: "GET",
        path: `/v1/tenants/${TENANT}/defender/vulnerabilities`,
        params: { tenantId: TENANT },
        query: new URLSearchParams(),
        headers: {},
      }),
    ).rejects.toMatchObject({ status: 403 });
  });

  it("rejects callers missing defender.read with 403", async () => {
    const provider = new FakeTvmProvider();
    const routes = createDefenderVulnerabilitiesRoutes({
      provider,
      resolveCaller: () => ({
        tenantScope: tenantScope([TENANT]),
        permissions: ["Identity.User.Read"],
      }),
    });

    await expect(
      routes[0]?.handler({
        method: "GET",
        path: `/v1/tenants/${TENANT}/defender/vulnerabilities`,
        params: { tenantId: TENANT },
        query: new URLSearchParams(),
        headers: {},
      }),
    ).rejects.toMatchObject({ status: 403 });

    await expect(
      routes[1]?.handler({
        method: "GET",
        path: `/v1/tenants/${TENANT}/defender/vulnerabilities/${CVE}`,
        params: { tenantId: TENANT, cveId: CVE },
        query: new URLSearchParams(),
        headers: {},
      }),
    ).rejects.toMatchObject({ status: 403 });
  });

  it("returns CVEs with severity, CVSS, exposed devices, software, and recommendation", async () => {
    const provider = new FakeTvmProvider();
    const caller: TvmVulnerabilitiesCaller = {
      tenantScope: tenantScope([TENANT]),
      permissions: [VULNERABILITIES_READ_PERMISSION],
    };
    const routes = createDefenderVulnerabilitiesRoutes({
      provider,
      resolveCaller: () => caller,
    });

    const response = await routes[0]?.handler({
      method: "GET",
      path: `/v1/tenants/${TENANT}/defender/vulnerabilities`,
      params: { tenantId: TENANT },
      query: new URLSearchParams("severity=high&software=vpn&device=device-1&search=2026-12345"),
      headers: {},
    });

    expect(response?.status).toBe(200);
    const body = response?.body as TvmVulnerabilitiesPage;
    expect(body.tenantId).toBe(TENANT);
    expect(body.items).toHaveLength(2);
    expect(body.items[0]).toMatchObject({
      cve: CVE,
      severity: "high",
      cvss: 8.1,
      exposedDeviceCount: 2,
      recommendation: "Update Contoso VPN to 4.3 or later.",
    });
    expect(body.items[0]?.affectedSoftware).toContain("Contoso VPN 4.2");
    expect(body.items[0]?.affectedDeviceIds).toEqual(["device-1", "device-2"]);

    expect(provider.listCalls).toHaveLength(1);
    expect(provider.listCalls[0]?.filter.severity).toBe("high");
    expect(provider.listCalls[0]?.filter.software).toBe("vpn");
    expect(provider.listCalls[0]?.filter.device).toBe("device-1");
    expect(provider.listCalls[0]?.filter.search).toBe("2026-12345");
  });

  it("lists affected devices for a CVE on drill-through", async () => {
    const provider = new FakeTvmProvider();
    const caller: TvmVulnerabilitiesCaller = {
      tenantScope: tenantScope([TENANT]),
      permissions: [VULNERABILITIES_READ_PERMISSION],
    };
    const routes = createDefenderVulnerabilitiesRoutes({
      provider,
      resolveCaller: () => caller,
    });

    const response = await routes[1]?.handler({
      method: "GET",
      path: `/v1/tenants/${TENANT}/defender/vulnerabilities/${CVE}`,
      params: { tenantId: TENANT, cveId: CVE },
      query: new URLSearchParams(),
      headers: {},
    });

    expect(response?.status).toBe(200);
    const body = response?.body as TvmVulnerabilityDevicesPage;
    expect(body.tenantId).toBe(TENANT);
    expect(body.cve).toBe(CVE);
    expect(body.items).toHaveLength(2);
    expect(body.items[0]).toMatchObject({ id: "device-1", deviceName: "WS-1001" });

    expect(provider.deviceCalls).toHaveLength(1);
    expect(provider.deviceCalls[0]).toMatchObject({ tenantId: TENANT, cveId: CVE });
  });

  it("requires cveId on the drill-through route", async () => {
    const provider = new FakeTvmProvider();
    const routes = createDefenderVulnerabilitiesRoutes({
      provider,
      resolveCaller: () => ({
        tenantScope: tenantScope([TENANT]),
        permissions: [VULNERABILITIES_READ_PERMISSION],
      }),
    });

    await expect(
      routes[1]?.handler({
        method: "GET",
        path: `/v1/tenants/${TENANT}/defender/vulnerabilities/`,
        params: { tenantId: TENANT },
        query: new URLSearchParams(),
        headers: {},
      }),
    ).rejects.toMatchObject({ status: 400 });
  });

  it("validates the severity filter parameter", () => {
    expect(() => parseTvmVulnerabilitiesFilter(new URLSearchParams("severity=extreme"))).toThrow(AppError);

    expect(parseTvmVulnerabilitiesFilter(new URLSearchParams("severity=High")).severity).toBe("high");
    expect(parseTvmVulnerabilitiesFilter(new URLSearchParams()).severity).toBeUndefined();
  });

  it("publishes the defender.read permission through the route module", () => {
    const list = DEFENDER_VULNERABILITIES_OPENAPI.paths["/tenants/{tenantId}/defender/vulnerabilities"];
    expect(list.get.permission).toBe("Security.Defender.Read");
    expect(list.get.operationId).toBe("listTvmVulnerabilities");
    const drill =
      DEFENDER_VULNERABILITIES_OPENAPI.paths["/tenants/{tenantId}/defender/vulnerabilities/{cveId}"];
    expect(drill.get.permission).toBe("Security.Defender.Read");
    expect(drill.get.operationId).toBe("listTvmVulnerabilityDevices");
    expect(VULNERABILITIES_READ_PERMISSION).toBe("Security.Defender.Read");
    expect(VULNERABILITIES_PATH).toBe("/v1/tenants/:tenantId/defender/vulnerabilities");
    expect(VULNERABILITY_DEVICES_PATH).toBe(
      "/v1/tenants/:tenantId/defender/vulnerabilities/:cveId",
    );
  });
});
