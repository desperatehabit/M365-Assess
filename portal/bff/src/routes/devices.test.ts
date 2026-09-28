import { describe, expect, it } from "vitest";
import { AppError } from "../errors.js";
import { tenantScope } from "../rbac/scope.js";
import {
  DEVICES_PATH,
  DEVICES_READ_PERMISSION,
  createDevicesListRoute,
  parseDevicesFilter,
  type DeviceItem,
  type DevicesCaller,
  type DevicesFilter,
  type DevicesPage,
  type DevicesProvider,
} from "./devices.js";

const TENANT = "tenant-test";

const SAMPLE_DEVICE: DeviceItem = {
  id: "dev-1",
  deviceName: "WS-1001",
  name: "WS-1001",
  ownerUpn: "alice@example.com",
  platform: "Windows",
  compliance: "compliant",
  ownership: "company",
  lastCheckIn: "2026-09-20T00:00:00.000Z",
  enrolled: "2026-01-10T00:00:00.000Z",
  serial: "SN1001",
  encrypted: true,
  osVersion: "10.0.22631",
};

const PERSONAL_DEVICE: DeviceItem = {
  id: "dev-2",
  deviceName: "iPhone-7",
  name: "iPhone-7",
  ownerUpn: "bob@example.com",
  platform: "iOS",
  compliance: "noncompliant",
  ownership: "personal",
  lastCheckIn: "2026-06-01T00:00:00.000Z",
  enrolled: "2025-11-02T00:00:00.000Z",
  serial: "SN2002",
  encrypted: false,
  osVersion: "18.1",
};

class FakeDevicesProvider implements DevicesProvider {
  readonly calls: Array<{ tenantId: string; filter: DevicesFilter }> = [];

  async listDevices(tenantId: string, filter: DevicesFilter): Promise<DevicesPage> {
    this.calls.push({ tenantId, filter });
    return {
      tenantId,
      totalCount: 2,
      items: [SAMPLE_DEVICE, PERSONAL_DEVICE],
      nextCursor: null,
    };
  }
}

describe("Devices list route (T-0341)", () => {
  it("exposes GET /v1/tenants/:tenantId/devices", () => {
    const provider = new FakeDevicesProvider();
    const route = createDevicesListRoute({
      provider,
      resolveCaller: () => ({
        tenantScope: tenantScope([TENANT]),
        permissions: [DEVICES_READ_PERMISSION],
      }),
    });
    expect(route.method).toBe("GET");
    expect(route.path).toBe(DEVICES_PATH);
  });

  it("rejects unauthenticated requests with 401", async () => {
    const provider = new FakeDevicesProvider();
    const route = createDevicesListRoute({
      provider,
      resolveCaller: () => undefined,
    });

    await expect(
      route.handler({
        method: "GET",
        path: `/v1/tenants/${TENANT}/devices`,
        params: { tenantId: TENANT },
        query: new URLSearchParams(),
        headers: {},
      }),
    ).rejects.toMatchObject({ status: 401 });
  });

  it("rejects tenant outside caller scope with 403", async () => {
    const provider = new FakeDevicesProvider();
    const route = createDevicesListRoute({
      provider,
      resolveCaller: () => ({
        tenantScope: tenantScope(["different-tenant"]),
        permissions: [DEVICES_READ_PERMISSION],
      }),
    });

    await expect(
      route.handler({
        method: "GET",
        path: `/v1/tenants/${TENANT}/devices`,
        params: { tenantId: TENANT },
        query: new URLSearchParams(),
        headers: {},
      }),
    ).rejects.toMatchObject({ status: 403 });
  });

  it("rejects callers missing devices.read with 403", async () => {
    const provider = new FakeDevicesProvider();
    const route = createDevicesListRoute({
      provider,
      resolveCaller: () => ({
        tenantScope: tenantScope([TENANT]),
        permissions: ["Identity.User.Read"],
      }),
    });

    await expect(
      route.handler({
        method: "GET",
        path: `/v1/tenants/${TENANT}/devices`,
        params: { tenantId: TENANT },
        query: new URLSearchParams(),
        headers: {},
      }),
    ).rejects.toMatchObject({ status: 403 });
  });

  it("returns the device list with §3.1 columns and filters applied", async () => {
    const provider = new FakeDevicesProvider();
    const caller: DevicesCaller = {
      tenantScope: tenantScope([TENANT]),
      permissions: [DEVICES_READ_PERMISSION],
    };
    const route = createDevicesListRoute({
      provider,
      resolveCaller: () => caller,
    });

    const response = await route.handler({
      method: "GET",
      path: `/v1/tenants/${TENANT}/devices`,
      params: { tenantId: TENANT },
      query: new URLSearchParams("platform=iOS&compliance=noncompliant&ownership=personal&encrypted=false&search=bob"),
      headers: {},
    });

    expect(response.status).toBe(200);
    const body = response.body as DevicesPage;
    expect(body.tenantId).toBe(TENANT);
    expect(body.items).toHaveLength(2);
    expect(body.items[0]?.deviceName).toBe("WS-1001");
    expect(body.items[0]?.ownerUpn).toBe("alice@example.com");
    expect(body.items[0]?.platform).toBe("Windows");
    expect(body.items[0]?.compliance).toBe("compliant");
    expect(body.items[0]?.ownership).toBe("company");
    expect(body.items[0]?.serial).toBe("SN1001");
    expect(body.items[1]?.platform).toBe("iOS");
    expect(body.items[1]?.encrypted).toBe(false);

    expect(provider.calls).toHaveLength(1);
    expect(provider.calls[0]?.filter.platform).toBe("iOS");
    expect(provider.calls[0]?.filter.compliance).toBe("noncompliant");
    expect(provider.calls[0]?.filter.ownership).toBe("personal");
    expect(provider.calls[0]?.filter.encrypted).toBe(false);
    expect(provider.calls[0]?.filter.search).toBe("bob");
  });

  it("validates lastCheckIn and encrypted filter parameters", () => {
    expect(() => parseDevicesFilter(new URLSearchParams("lastCheckIn=forever"))).toThrow(AppError);

    expect(() => parseDevicesFilter(new URLSearchParams("encrypted=maybe"))).toThrow(AppError);

    expect(parseDevicesFilter(new URLSearchParams("lastCheckIn=30d")).lastCheckIn).toBe("30d");
  });

  it("publishes the devices.read permission through the route module", async () => {
    const { DEVICES_OPENAPI } = await import("./devices.js");
    const path = DEVICES_OPENAPI.paths["/tenants/{tenantId}/devices"];
    expect(path.get.permission).toBe("Endpoint.Device.Read");
    expect(path.get.operationId).toBe("listManagedDevices");
    expect(DEVICES_READ_PERMISSION).toBe("Endpoint.Device.Read");
    expect(DEVICES_PATH).toBe("/v1/tenants/:tenantId/devices");
  });
});
