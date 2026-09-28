import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { tenantScope } from "../rbac/scope.js";
import { buildServer, type Route } from "../server.js";
import type { DeviceAction, DeviceActionRepository } from "../repository/device-actions.js";
import {
  DEVICE_ACTIONS_OPENAPI,
  DEVICE_ACTIONS_PATH,
  DEVICE_ACTIONS_PERMISSION,
  applyDeviceAction,
  createDeviceActionsRoute,
  type DeviceActionProvider,
  type DeviceActionResult,
  type DeviceActionsCaller,
} from "./device-actions.js";

const TENANT = "tenant-a";
const DEVICE = "device-1";
const ACTOR = "operator-1";
const AT = "2026-04-01T00:00:00.000Z";

function actionResult(overrides: Partial<DeviceActionResult> = {}): DeviceActionResult {
  return {
    tenantId: TENANT,
    deviceId: DEVICE,
    action: "sync",
    reason: null,
    result: "success",
    error: "",
    appliedAt: AT,
    ...overrides,
  };
}

class FakeDeviceActionProvider implements DeviceActionProvider {
  readonly calls: Array<{ tenantId: string; deviceId: string; action: string; reason: string }> = [];

  constructor(private readonly result: DeviceActionResult) {}

  async applyAction(
    tenantId: string,
    deviceId: string,
    action: "sync" | "retire",
    reason: string,
  ): Promise<DeviceActionResult> {
    this.calls.push({ tenantId, deviceId, action, reason });
    return { ...this.result, tenantId, deviceId, action, reason: reason || null };
  }
}

class FakeActionStore implements Pick<DeviceActionRepository, "appendDeviceAction"> {
  readonly rows: DeviceAction[] = [];

  async appendDeviceAction(input: DeviceAction): Promise<DeviceAction> {
    this.rows.push({ ...input });
    return input;
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

describe("device actions handler (T-0344)", () => {
  it("applies a sync action without a reason", async () => {
    const provider = new FakeDeviceActionProvider(actionResult({ action: "sync" }));
    const store = new FakeActionStore();

    const result = await applyDeviceAction(
      { provider, store, now: () => AT },
      TENANT,
      DEVICE,
      "sync",
      "",
      ACTOR,
    );

    expect(result.action).toBe("sync");
    expect(result.result).toBe("success");
    expect(provider.calls).toEqual([{ tenantId: TENANT, deviceId: DEVICE, action: "sync", reason: "" }]);
  });

  it("applies a retire action with a reason", async () => {
    const provider = new FakeDeviceActionProvider(actionResult({ action: "retire", reason: "Device lost" }));
    const store = new FakeActionStore();

    const result = await applyDeviceAction(
      { provider, store, now: () => AT },
      TENANT,
      DEVICE,
      "retire",
      "Device lost",
      ACTOR,
    );

    expect(result.action).toBe("retire");
    expect(result.reason).toBe("Device lost");
  });

  it("appends a DeviceAction record with actor, reason, and result", async () => {
    const provider = new FakeDeviceActionProvider(actionResult({ action: "retire", reason: "Device lost" }));
    const store = new FakeActionStore();

    await applyDeviceAction(
      { provider, store, now: () => AT },
      TENANT,
      DEVICE,
      "retire",
      "Device lost",
      ACTOR,
    );

    expect(store.rows).toHaveLength(1);
    const row = store.rows[0]!;
    expect(row.tenantId).toBe(TENANT);
    expect(row.deviceId).toBe(DEVICE);
    expect(row.action).toBe("retire");
    expect(row.reason).toBe("Device lost");
    expect(row.state).toBe("applied");
    expect(row.appliedBy).toBe(ACTOR);
    expect(row.result).toBe("success");
  });

  it("requires a reason for retire", async () => {
    const provider = new FakeDeviceActionProvider(actionResult());
    const store = new FakeActionStore();

    await expect(
      applyDeviceAction({ provider, store, now: () => AT }, TENANT, DEVICE, "retire", "", ACTOR),
    ).rejects.toMatchObject({ status: 400 });
    expect(store.rows).toHaveLength(0);
  });

  it("rejects blank tenant and device", async () => {
    const provider = new FakeDeviceActionProvider(actionResult());
    const store = new FakeActionStore();

    await expect(
      applyDeviceAction({ provider, store, now: () => AT }, "", DEVICE, "sync", "", ACTOR),
    ).rejects.toMatchObject({ status: 400 });
    await expect(
      applyDeviceAction({ provider, store, now: () => AT }, TENANT, "", "sync", "", ACTOR),
    ).rejects.toMatchObject({ status: 400 });
  });
});

describe("device actions route (T-0344)", () => {
  function options(allowed: boolean) {
    const provider = new FakeDeviceActionProvider(actionResult());
    const store = new FakeActionStore();
    const routes = createDeviceActionsRoute({
      provider,
      store,
      resolveCaller: () => ({
        tenantScope: tenantScope([TENANT]),
        permissions: allowed ? [DEVICE_ACTIONS_PERMISSION] : [],
        id: ACTOR,
      } as DeviceActionsCaller),
      now: () => AT,
    });
    return { provider, store, routes };
  }

  it("exposes POST /v1/tenants/:tenantId/devices/:deviceId/actions/:action", () => {
    const { routes } = options(true);
    expect(routes[0]?.method).toBe("POST");
    expect(routes[0]?.path).toBe(DEVICE_ACTIONS_PATH);
  });

  it("applies sync without a reason", async () => {
    const { provider, store, routes } = options(true);
    const baseUrl = await startServer(routes);

    const response = await fetch(
      `${baseUrl}/v1/tenants/${TENANT}/devices/${DEVICE}/actions/sync`,
      { method: "POST", headers: { "content-type": "application/json" }, body: "{}" },
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as DeviceActionResult;
    expect(body.action).toBe("sync");
    expect(body.result).toBe("success");
    expect(store.rows).toHaveLength(1);
    expect(store.rows[0]?.action).toBe("sync");
  });

  it("requires a reason for retire", async () => {
    const { store, routes } = options(true);
    const baseUrl = await startServer(routes);

    const response = await fetch(
      `${baseUrl}/v1/tenants/${TENANT}/devices/${DEVICE}/actions/retire`,
      { method: "POST", headers: { "content-type": "application/json" }, body: "{}" },
    );
    expect(response.status).toBe(400);
    expect(store.rows).toHaveLength(0);
  });

  it("rejects callers missing devices.actions with 403", async () => {
    const { routes } = options(false);
    const baseUrl = await startServer(routes);

    const response = await fetch(
      `${baseUrl}/v1/tenants/${TENANT}/devices/${DEVICE}/actions/sync`,
      { method: "POST", headers: { "content-type": "application/json" }, body: "{}" },
    );
    expect(response.status).toBe(403);
  });

  it("rejects invalid action with 400", async () => {
    const { routes } = options(true);
    const handler = routes[0]?.handler;
    if (!handler) throw new Error("route handler is missing");
    await expect(
      handler({
        method: "POST",
        path: `/v1/tenants/${TENANT}/devices/${DEVICE}/actions/wipe`,
        params: { tenantId: TENANT, deviceId: DEVICE, action: "wipe" },
        query: new URLSearchParams(),
        headers: {},
        body: {},
      }),
    ).rejects.toMatchObject({ status: 400 });
  });

  it("publishes the devices.actions permission through the route module", () => {
    const path = DEVICE_ACTIONS_OPENAPI.paths["/tenants/{tenantId}/devices/{deviceId}/actions/{action}"];
    expect(path.post.permission).toBe("Endpoint.Device.ReadWrite");
    expect(path.post.operationId).toBe("applyDeviceAction");
    expect(DEVICE_ACTIONS_PERMISSION).toBe("Endpoint.Device.ReadWrite");
    expect(DEVICE_ACTIONS_PATH).toBe("/v1/tenants/:tenantId/devices/:deviceId/actions/:action");
  });
});
