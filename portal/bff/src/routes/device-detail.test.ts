import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { tenantScope } from "../rbac/scope.js";
import { buildServer, type Route } from "../server.js";
import {
  DEVICE_DETAIL_OPENAPI,
  DEVICE_DETAIL_PATH,
  DEVICE_DETAIL_READ_PERMISSION,
  createDeviceDetailRoute,
  type DeviceDetailCaller,
  type DeviceDetailProvider,
  type DeviceDetailResult,
} from "./device-detail.js";

const TENANT = "tenant-test";
const DEVICE = "device-1";

const SAMPLE_DETAIL: DeviceDetailResult = {
  tenantId: TENANT,
  deviceId: DEVICE,
  overview: {
    deviceName: "WS-1001",
    ownerUpn: "alice@example.com",
    platform: "Windows",
    osVersion: "10.0.22631",
    compliance: "compliant",
    ownership: "company",
    lastCheckIn: "2026-09-20T00:00:00.000Z",
    enrolled: "2026-01-10T00:00:00.000Z",
    serial: "SN1001",
    encrypted: true,
    deviceType: "windows10",
    managementState: "managed",
  },
  hardware: {
    model: "Surface Pro 9",
    manufacturer: "Microsoft",
    serialNumber: "SN1001",
    storageSpace: 256000000000,
    totalStorage: 512000000000,
    phoneNumber: "",
    imei: "",
  },
  software: [
    { id: "app-1", displayName: "Microsoft Edge", version: "120.0", publisher: "Microsoft" },
  ],
  policies: [
    { id: "pol-1", displayName: "Compliance Policy 1", state: "compliant", lastReported: "2026-09-20", type: "compliance" },
  ],
  encryption: { encrypted: true, keyType: "bitlocker" },
  retrievedAt: "2026-09-20T00:00:00.000Z",
};

class FakeDeviceDetailProvider implements DeviceDetailProvider {
  readonly calls: Array<{ tenantId: string; deviceId: string }> = [];

  async getDevice(tenantId: string, deviceId: string): Promise<DeviceDetailResult> {
    this.calls.push({ tenantId, deviceId });
    return { ...SAMPLE_DETAIL, tenantId, deviceId };
  }
}

const openServers: Server[] = [];

async function startServer(routes: readonly Route[]) {
  const server = buildServer({ routes });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  openServers.push(server);
  const { port } = server.address() as AddressInfo;
  return `http://127.0.0.1:${port}`;
}

afterEach(async () => {
  await Promise.all(
    openServers.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => {
          server.close(() => resolve());
        }),
    ),
  );
});

describe("device detail route (T-0342)", () => {
  it("exposes GET /v1/tenants/:tenantId/devices/:deviceId", () => {
    const provider = new FakeDeviceDetailProvider();
    const [route] = createDeviceDetailRoute({
      provider,
      resolveCaller: () => ({
        tenantScope: tenantScope([TENANT]),
        permissions: [DEVICE_DETAIL_READ_PERMISSION],
      }),
    });
    expect(route.method).toBe("GET");
    expect(route.path).toBe(DEVICE_DETAIL_PATH);
  });

  it("rejects unauthenticated requests with 401", async () => {
    const provider = new FakeDeviceDetailProvider();
    const [route] = createDeviceDetailRoute({
      provider,
      resolveCaller: () => undefined,
    });

    await expect(
      route.handler({
        method: "GET",
        path: `/v1/tenants/${TENANT}/devices/${DEVICE}`,
        params: { tenantId: TENANT, deviceId: DEVICE },
        query: new URLSearchParams(),
        headers: {},
      }),
    ).rejects.toMatchObject({ status: 401 });
  });

  it("rejects tenant outside caller scope with 403", async () => {
    const provider = new FakeDeviceDetailProvider();
    const [route] = createDeviceDetailRoute({
      provider,
      resolveCaller: () => ({
        tenantScope: tenantScope(["different-tenant"]),
        permissions: [DEVICE_DETAIL_READ_PERMISSION],
      }),
    });

    await expect(
      route.handler({
        method: "GET",
        path: `/v1/tenants/${TENANT}/devices/${DEVICE}`,
        params: { tenantId: TENANT, deviceId: DEVICE },
        query: new URLSearchParams(),
        headers: {},
      }),
    ).rejects.toMatchObject({ status: 403 });
  });

  it("rejects callers missing devices.read with 403", async () => {
    const provider = new FakeDeviceDetailProvider();
    const [route] = createDeviceDetailRoute({
      provider,
      resolveCaller: () => ({
        tenantScope: tenantScope([TENANT]),
        permissions: ["Identity.User.Read"],
      }),
    });

    await expect(
      route.handler({
        method: "GET",
        path: `/v1/tenants/${TENANT}/devices/${DEVICE}`,
        params: { tenantId: TENANT, deviceId: DEVICE },
        query: new URLSearchParams(),
        headers: {},
      }),
    ).rejects.toMatchObject({ status: 403 });
  });

  it("returns the device detail with all tab data", async () => {
    const provider = new FakeDeviceDetailProvider();
    const caller: DeviceDetailCaller = {
      tenantScope: tenantScope([TENANT]),
      permissions: [DEVICE_DETAIL_READ_PERMISSION],
    };
    const [route] = createDeviceDetailRoute({
      provider,
      resolveCaller: () => caller,
    });

    const response = await route.handler({
      method: "GET",
      path: `/v1/tenants/${TENANT}/devices/${DEVICE}`,
      params: { tenantId: TENANT, deviceId: DEVICE },
      query: new URLSearchParams(),
      headers: {},
    });

    expect(response.status).toBe(200);
    const body = response.body as DeviceDetailResult;
    expect(body.tenantId).toBe(TENANT);
    expect(body.deviceId).toBe(DEVICE);
    expect(body.overview.deviceName).toBe("WS-1001");
    expect(body.overview.ownerUpn).toBe("alice@example.com");
    expect(body.overview.platform).toBe("Windows");
    expect(body.overview.compliance).toBe("compliant");
    expect(body.overview.serial).toBe("SN1001");
    expect(body.overview.encrypted).toBe(true);
    expect(body.hardware.model).toBe("Surface Pro 9");
    expect(body.hardware.manufacturer).toBe("Microsoft");
    expect(body.software).toHaveLength(1);
    expect(body.software[0]?.displayName).toBe("Microsoft Edge");
    expect(body.policies).toHaveLength(1);
    expect(body.policies[0]?.displayName).toBe("Compliance Policy 1");
    expect(body.encryption.encrypted).toBe(true);
    expect(body.encryption.keyType).toBe("bitlocker");

    expect(provider.calls).toHaveLength(1);
    expect(provider.calls[0]?.tenantId).toBe(TENANT);
    expect(provider.calls[0]?.deviceId).toBe(DEVICE);
  });

  it("serves detail scoped by the tenant and device in the path", async () => {
    const provider = new FakeDeviceDetailProvider();
    const baseUrl = await startServer(
      createDeviceDetailRoute({
        provider,
        resolveCaller: () => ({
          tenantScope: tenantScope([TENANT]),
          permissions: [DEVICE_DETAIL_READ_PERMISSION],
        }),
      }),
    );

    const response = await fetch(`${baseUrl}/v1/tenants/${TENANT}/devices/${DEVICE}`);
    expect(response.status).toBe(200);
    const body = (await response.json()) as DeviceDetailResult;
    expect(body.deviceId).toBe(DEVICE);
    expect(body.overview.deviceName).toBe("WS-1001");
  });

  it("publishes the devices.read permission through the route module", () => {
    const path = DEVICE_DETAIL_OPENAPI.paths["/tenants/{tenantId}/devices/{deviceId}"];
    expect(path.get.permission).toBe("Endpoint.Device.Read");
    expect(path.get.operationId).toBe("getManagedDevice");
    expect(DEVICE_DETAIL_READ_PERMISSION).toBe("Endpoint.Device.Read");
    expect(DEVICE_DETAIL_PATH).toBe("/v1/tenants/:tenantId/devices/:deviceId");
  });
});
