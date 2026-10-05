import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { tenantScope } from "../rbac/scope.js";
import { buildServer, type Route } from "../server.js";
import type { DeviceAction, DeviceActionRepository } from "../repository/device-actions.js";
import type { DeviceActionPolicy, DeviceActionPolicyRepository } from "../repository/device-action-policies.js";
import {
  DEVICE_DESTRUCTIVE_ACTIONS_OPENAPI,
  DEVICE_DESTRUCTIVE_ACTIONS_PATH,
  DEVICE_DESTRUCTIVE_ACTIONS_PERMISSION,
  applyDestructiveAction,
  createDestructiveActionsRoute,
  type DestructiveActionProvider,
  type DestructiveActionResult,
  type DestructiveActionsCaller,
} from "./device-actions-destructive.js";
import {
  DEVICE_ACTIONS_PERMISSION,
  createDeviceActionsRoute,
  type DeviceActionProvider,
  type DeviceActionResult,
  type DeviceActionsCaller,
} from "./device-actions.js";

const TENANT = "tenant-a";
const DEVICE = "device-1";
const DEVICE_NAME = "WS-1001";
const ACTOR = "operator-1";
const AT = "2026-04-01T00:00:00.000Z";

function destructiveResult(overrides: Partial<DestructiveActionResult> = {}): DestructiveActionResult {
  return {
    tenantId: TENANT,
    deviceId: DEVICE,
    action: "wipe",
    reason: "Device lost",
    state: "applied",
    result: "success",
    error: "",
    appliedAt: AT,
    ...overrides,
  };
}

class FakeDestructiveProvider implements DestructiveActionProvider {
  readonly calls: Array<{ tenantId: string; deviceId: string; action: string; reason: string }> = [];

  constructor(private readonly result: DestructiveActionResult) {}

  async applyAction(
    tenantId: string,
    deviceId: string,
    action: "wipe" | "fresh-start",
    reason: string,
  ): Promise<DestructiveActionResult> {
    this.calls.push({ tenantId, deviceId, action, reason });
    return { ...this.result, tenantId, deviceId, action, reason };
  }
}

class FakeActionStore implements Pick<DeviceActionRepository, "appendDeviceAction"> {
  readonly rows: DeviceAction[] = [];

  async appendDeviceAction(input: DeviceAction): Promise<DeviceAction> {
    this.rows.push({ ...input });
    return input;
  }
}

class FakePolicyStore implements Pick<DeviceActionPolicyRepository, "getPolicy"> {
  constructor(private readonly policy: DeviceActionPolicy) {}

  async getPolicy(tenantId: string): Promise<DeviceActionPolicy> {
    return { ...this.policy, tenantId };
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

describe("destructive device actions handler (T-0345)", () => {
  it("applies a wipe action with typed confirmation and reason", async () => {
    const provider = new FakeDestructiveProvider(destructiveResult());
    const store = new FakeActionStore();
    const policyStore = new FakePolicyStore({ tenantId: TENANT, twoPersonRule: false, revealWindowSec: 30, updatedAt: AT });

    const result = await applyDestructiveAction(
      { provider, store, policyStore, now: () => AT },
      TENANT,
      DEVICE,
      DEVICE_NAME,
      "wipe",
      "Device lost",
      DEVICE_NAME,
      ACTOR,
    );

    expect(result.action).toBe("wipe");
    expect(result.state).toBe("applied");
    expect(result.result).toBe("success");
    expect(provider.calls).toEqual([{ tenantId: TENANT, deviceId: DEVICE, action: "wipe", reason: "Device lost" }]);
  });

  it("requires typed confirmation to match the device name", async () => {
    const provider = new FakeDestructiveProvider(destructiveResult());
    const store = new FakeActionStore();
    const policyStore = new FakePolicyStore({ tenantId: TENANT, twoPersonRule: false, revealWindowSec: 30, updatedAt: AT });

    await expect(
      applyDestructiveAction(
        { provider, store, policyStore, now: () => AT },
        TENANT,
        DEVICE,
        DEVICE_NAME,
        "wipe",
        "Device lost",
        "WRONG-NAME",
        ACTOR,
      ),
    ).rejects.toMatchObject({ status: 400 });
    expect(store.rows).toHaveLength(0);
  });

  it("requires a reason", async () => {
    const provider = new FakeDestructiveProvider(destructiveResult());
    const store = new FakeActionStore();
    const policyStore = new FakePolicyStore({ tenantId: TENANT, twoPersonRule: false, revealWindowSec: 30, updatedAt: AT });

    await expect(
      applyDestructiveAction(
        { provider, store, policyStore, now: () => AT },
        TENANT,
        DEVICE,
        DEVICE_NAME,
        "wipe",
        "",
        DEVICE_NAME,
        ACTOR,
      ),
    ).rejects.toMatchObject({ status: 400 });
    expect(store.rows).toHaveLength(0);
  });

  it("holds wipe in pending-approval when two-person rule is enabled", async () => {
    const provider = new FakeDestructiveProvider(destructiveResult());
    const store = new FakeActionStore();
    const policyStore = new FakePolicyStore({ tenantId: TENANT, twoPersonRule: true, revealWindowSec: 30, updatedAt: AT });

    const result = await applyDestructiveAction(
      { provider, store, policyStore, now: () => AT },
      TENANT,
      DEVICE,
      DEVICE_NAME,
      "wipe",
      "Device lost",
      DEVICE_NAME,
      ACTOR,
    );

    expect(result.state).toBe("pending-approval");
    expect(result.result).toBe("pending");
    expect(provider.calls).toHaveLength(0);
    expect(store.rows).toHaveLength(1);
    expect(store.rows[0]?.state).toBe("pending-approval");
  });

  it("applies fresh-start without two-person rule", async () => {
    const provider = new FakeDestructiveProvider(destructiveResult({ action: "fresh-start" }));
    const store = new FakeActionStore();
    const policyStore = new FakePolicyStore({ tenantId: TENANT, twoPersonRule: true, revealWindowSec: 30, updatedAt: AT });

    const result = await applyDestructiveAction(
      { provider, store, policyStore, now: () => AT },
      TENANT,
      DEVICE,
      DEVICE_NAME,
      "fresh-start",
      "Device refresh",
      DEVICE_NAME,
      ACTOR,
    );

    expect(result.action).toBe("fresh-start");
    expect(result.state).toBe("applied");
    expect(provider.calls).toHaveLength(1);
  });

  it("appends a DeviceAction record with actor, reason, and result", async () => {
    const provider = new FakeDestructiveProvider(destructiveResult());
    const store = new FakeActionStore();
    const policyStore = new FakePolicyStore({ tenantId: TENANT, twoPersonRule: false, revealWindowSec: 30, updatedAt: AT });

    await applyDestructiveAction(
      { provider, store, policyStore, now: () => AT },
      TENANT,
      DEVICE,
      DEVICE_NAME,
      "wipe",
      "Device lost",
      DEVICE_NAME,
      ACTOR,
    );

    expect(store.rows).toHaveLength(1);
    const row = store.rows[0]!;
    expect(row.tenantId).toBe(TENANT);
    expect(row.deviceId).toBe(DEVICE);
    expect(row.action).toBe("wipe");
    expect(row.reason).toBe("Device lost");
    expect(row.state).toBe("applied");
    expect(row.appliedBy).toBe(ACTOR);
    expect(row.result).toBe("success");
  });
});

describe("destructive device actions route (T-0345)", () => {
  function options(allowed: boolean, twoPersonRule = false) {
    const provider = new FakeDestructiveProvider(destructiveResult());
    const store = new FakeActionStore();
    const policyStore = new FakePolicyStore({ tenantId: TENANT, twoPersonRule, revealWindowSec: 30, updatedAt: AT });
    const routes = createDestructiveActionsRoute({
      provider,
      store,
      policyStore,
      resolveCaller: () => ({
        tenantScope: tenantScope([TENANT]),
        permissions: allowed ? [DEVICE_DESTRUCTIVE_ACTIONS_PERMISSION] : [],
        id: ACTOR,
      } as DestructiveActionsCaller),
      now: () => AT,
    });
    return { provider, store, policyStore, routes };
  }

  it("exposes POST /v1/tenants/:tenantId/devices/:deviceId/actions/:action", () => {
    const { routes } = options(true);
    expect(routes[0]?.method).toBe("POST");
    expect(routes[0]?.path).toBe(DEVICE_DESTRUCTIVE_ACTIONS_PATH);
  });

  it("applies wipe with typed confirmation and reason", async () => {
    const { store, routes } = options(true);
    const baseUrl = await startServer(routes);

    const response = await fetch(
      `${baseUrl}/v1/tenants/${TENANT}/devices/${DEVICE}/device-actions/wipe`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ deviceName: DEVICE_NAME, reason: "Device lost", typedConfirmation: DEVICE_NAME }),
      },
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as DestructiveActionResult;
    expect(body.action).toBe("wipe");
    expect(body.state).toBe("applied");
    expect(store.rows).toHaveLength(1);
  });

  it("holds wipe in pending-approval when two-person rule is on", async () => {
    const { store, routes } = options(true, true);
    const baseUrl = await startServer(routes);

    const response = await fetch(
      `${baseUrl}/v1/tenants/${TENANT}/devices/${DEVICE}/device-actions/wipe`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ deviceName: DEVICE_NAME, reason: "Device lost", typedConfirmation: DEVICE_NAME }),
      },
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as DestructiveActionResult;
    expect(body.state).toBe("pending-approval");
    expect(store.rows).toHaveLength(1);
    expect(store.rows[0]?.state).toBe("pending-approval");
  });

  it("rejects mismatched typed confirmation with 400", async () => {
    const { routes } = options(true);
    const baseUrl = await startServer(routes);

    const response = await fetch(
      `${baseUrl}/v1/tenants/${TENANT}/devices/${DEVICE}/device-actions/wipe`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ deviceName: DEVICE_NAME, reason: "Device lost", typedConfirmation: "WRONG" }),
      },
    );
    expect(response.status).toBe(400);
  });

  it("rejects callers missing devices.actions with 403", async () => {
    const { routes } = options(false);
    const baseUrl = await startServer(routes);

    const response = await fetch(
      `${baseUrl}/v1/tenants/${TENANT}/devices/${DEVICE}/device-actions/wipe`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ deviceName: DEVICE_NAME, reason: "Device lost", typedConfirmation: DEVICE_NAME }),
      },
    );
    expect(response.status).toBe(403);
  });

  it("publishes the devices.actions permission through the route module", () => {
    const path = DEVICE_DESTRUCTIVE_ACTIONS_OPENAPI.paths["/tenants/{tenantId}/devices/{deviceId}/device-actions/{action}"];
    expect(path.post.permission).toBe("Endpoint.Device.ReadWrite");
    expect(path.post.operationId).toBe("applyDestructiveDeviceAction");
    expect(DEVICE_DESTRUCTIVE_ACTIONS_PERMISSION).toBe("Endpoint.Device.ReadWrite");
    expect(DEVICE_DESTRUCTIVE_ACTIONS_PATH).toBe("/v1/tenants/:tenantId/devices/:deviceId/device-actions/:action");
  });
});

describe("route shadowing (T-0871)", () => {
  it("routes wipe to the destructive handler and sync to the non-destructive handler", async () => {
    const syncCalls: string[] = [];
    const syncProvider: DeviceActionProvider = {
      async applyAction(tenantId, deviceId, action, reason): Promise<DeviceActionResult> {
        syncCalls.push(action);
        return { tenantId, deviceId, action, reason: reason || null, result: "success", error: "", appliedAt: AT };
      },
    };
    const syncStore = new FakeActionStore();
    const destructiveProvider = new FakeDestructiveProvider(destructiveResult());
    const destructiveStore = new FakeActionStore();
    const policyStore = new FakePolicyStore({ tenantId: TENANT, twoPersonRule: false, revealWindowSec: 30, updatedAt: AT });

    const caller: DeviceActionsCaller & DestructiveActionsCaller = {
      tenantScope: tenantScope([TENANT]),
      permissions: [DEVICE_ACTIONS_PERMISSION, DEVICE_DESTRUCTIVE_ACTIONS_PERMISSION],
      id: ACTOR,
    };

    // Mounted in the same order as portal/bff/src/app.ts: non-destructive first.
    const routes = [
      ...createDeviceActionsRoute({ provider: syncProvider, store: syncStore, resolveCaller: () => caller, now: () => AT }),
      ...createDestructiveActionsRoute({
        provider: destructiveProvider,
        store: destructiveStore,
        policyStore,
        resolveCaller: () => caller,
        now: () => AT,
      }),
    ];
    const baseUrl = await startServer(routes);

    const wipe = await fetch(`${baseUrl}/v1/tenants/${TENANT}/devices/${DEVICE}/device-actions/wipe`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ deviceName: DEVICE_NAME, reason: "Device lost", typedConfirmation: DEVICE_NAME }),
    });
    expect(wipe.status).toBe(200);
    expect(((await wipe.json()) as DestructiveActionResult).action).toBe("wipe");
    expect(destructiveProvider.calls).toHaveLength(1);
    expect(syncCalls).toHaveLength(0);

    const sync = await fetch(`${baseUrl}/v1/tenants/${TENANT}/devices/${DEVICE}/actions/sync`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    expect(sync.status).toBe(200);
    expect(((await sync.json()) as DeviceActionResult).action).toBe("sync");
    expect(syncCalls).toEqual(["sync"]);
  });
});
