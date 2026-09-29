import { describe, expect, it } from "vitest";
import { tenantScope } from "../rbac/scope.js";
import {
  WEBHOOKS_ADMIN_SCOPE,
  WEBHOOKS_ITEM_PATH,
  WEBHOOKS_PATH,
  WEBHOOKS_RECREATE_PATH,
  WEBHOOKS_RENEW_PATH,
  WEBHOOKS_TEST_PATH,
  createWebhooksRoutes,
  type WebhooksProvider,
  type WebhooksRouteOptions,
  type WebhookSubscription,
} from "./webhooks.js";

const TENANT = "tenant-test";
const SUBSCRIPTION = "sub-1";

const SUBSCRIPTIONS: WebhookSubscription[] = [
  {
    id: SUBSCRIPTION,
    tenantId: TENANT,
    resource: "users",
    notificationUrl: "https://portal.example/v1/webhooks/notify",
    expirationDateTime: "2099-01-01T00:00:00Z",
    state: "active",
  },
  {
    id: "sub-2",
    tenantId: TENANT,
    resource: "groups",
    notificationUrl: "https://portal.example/v1/webhooks/notify",
    expirationDateTime: "2020-01-01T00:00:00Z",
    state: "expired",
  },
];

class FakeWebhooksProvider implements WebhooksProvider {
  readonly createCalls: Array<{ tenantId: string; input: { resource: string; notificationUrl: string } }> = [];
  readonly renewCalls: Array<{ tenantId: string; subscriptionId: string }> = [];
  readonly removeCalls: Array<{ tenantId: string; subscriptionId: string }> = [];
  readonly testCalls: Array<{ tenantId: string; subscriptionId: string }> = [];
  subscription: WebhookSubscription = SUBSCRIPTIONS[0]!;
  createResult: Awaited<ReturnType<WebhooksProvider["create"]>> = {
    success: true,
    subscription: SUBSCRIPTIONS[0],
  };
  renewResult: Awaited<ReturnType<WebhooksProvider["renew"]>> = {
    success: true,
    subscription: SUBSCRIPTIONS[0],
  };

  async list(tenantId: string) {
    return { success: true, tenantId, subscriptions: SUBSCRIPTIONS };
  }

  async create(tenantId: string, input: { resource: string; notificationUrl: string }) {
    this.createCalls.push({ tenantId, input });
    return this.createResult;
  }

  async renew(tenantId: string, subscriptionId: string) {
    this.renewCalls.push({ tenantId, subscriptionId });
    return this.renewResult;
  }

  async recreate(tenantId: string, subscriptionId: string) {
    this.renewCalls.push({ tenantId, subscriptionId });
    return this.renewResult;
  }

  async remove(tenantId: string, subscriptionId: string) {
    this.removeCalls.push({ tenantId, subscriptionId });
    return { success: true, deleted: subscriptionId };
  }

  async test(tenantId: string, subscriptionId: string) {
    this.testCalls.push({ tenantId, subscriptionId });
    return { success: true, subscription: this.subscription, healthy: true };
  }
}

function createHarness(overrides?: Partial<WebhooksRouteOptions>) {
  const provider = new FakeWebhooksProvider();
  let defaultCaller: any = {
    userId: "user-1",
    roles: ["admin"],
    permissions: [WEBHOOKS_ADMIN_SCOPE],
    tenantScope: tenantScope([TENANT]),
  };

  const routes = createWebhooksRoutes({
    provider,
    resolveCaller: () => defaultCaller,
    notificationUrl: "https://portal.example/v1/webhooks/notify",
    ...overrides,
  });

  const getRoute = (method: string, path: string) => {
    const route = routes.find((r) => r.method === method && r.path === path);
    if (!route) throw new Error(`Route not found: ${method} ${path}`);
    return route;
  };

  return {
    provider,
    routes,
    getRoute,
    setCaller: (c: any) => {
      defaultCaller = c;
    },
  };
}

function ctxFor(routePattern: string, overrides?: Record<string, unknown>) {
  const concrete = (overrides?.["concretePath"] as string | undefined) ?? routePattern;
  const params: Record<string, string> = {};
  const patternSegments = routePattern.split("/");
  const concreteSegments = concrete.split("/");
  for (let index = 0; index < patternSegments.length; index += 1) {
    const patternSegment = patternSegments[index]!;
    if (patternSegment.startsWith(":")) {
      params[patternSegment.slice(1)] = concreteSegments[index]!;
    }
  }
  const { concretePath: _concretePath, ...rest } = overrides ?? {};
  return {
    path: concrete,
    params,
    query: new URLSearchParams(),
    headers: {},
    ...rest,
  } as any;
}

describe("GET /v1/tenants/:tenantId/webhooks", () => {
  it("rejects an unauthenticated caller", async () => {
    const harness = createHarness({ resolveCaller: () => undefined });
    const route = harness.getRoute("GET", WEBHOOKS_PATH);
    await expect(route.handler(ctxFor(WEBHOOKS_PATH, { concretePath: `/v1/tenants/${TENANT}/webhooks` }))).rejects.toMatchObject({
      status: 401,
    });
  });

  it("rejects a caller without the admin scope", async () => {
    const harness = createHarness();
    harness.setCaller({
      userId: "user-1",
      roles: ["readonly"],
      permissions: ["Tenant.Webhooks.Read"],
      tenantScope: tenantScope([TENANT]),
    });
    const route = harness.getRoute("GET", WEBHOOKS_PATH);
    await expect(route.handler(ctxFor(WEBHOOKS_PATH, { concretePath: `/v1/tenants/${TENANT}/webhooks` }))).rejects.toMatchObject({
      status: 403,
    });
  });

  it("returns the tenant's subscriptions with computed state", async () => {
    const harness = createHarness();
    const route = harness.getRoute("GET", WEBHOOKS_PATH);
    const res = await route.handler(ctxFor(WEBHOOKS_PATH, { concretePath: `/v1/tenants/${TENANT}/webhooks` }));
    expect(res.status).toBe(200);
    const body = res.body as Awaited<ReturnType<WebhooksProvider["list"]>>;
    expect(body.subscriptions).toHaveLength(2);
    expect(body.subscriptions[0]?.state).toBe("active");
    expect(body.subscriptions[1]?.state).toBe("expired");
  });
});

describe("POST /v1/tenants/:tenantId/webhooks", () => {
  it("creates a subscription for a required resource and passes the notification URL", async () => {
    const harness = createHarness();
    const route = harness.getRoute("POST", WEBHOOKS_PATH);
    const res = await route.handler(
      ctxFor(WEBHOOKS_PATH, { concretePath: `/v1/tenants/${TENANT}/webhooks`, body: { resource: "users" } }),
    );
    expect(res.status).toBe(200);
    expect(harness.provider.createCalls).toEqual([
      { tenantId: TENANT, input: { resource: "users", notificationUrl: "https://portal.example/v1/webhooks/notify" } },
    ]);
    const body = res.body as Awaited<ReturnType<WebhooksProvider["create"]>>;
    expect(body.success).toBe(true);
  });

  it("rejects a resource outside the required set with 400", async () => {
    const harness = createHarness();
    const route = harness.getRoute("POST", WEBHOOKS_PATH);
    await expect(
      route.handler(ctxFor(WEBHOOKS_PATH, { concretePath: `/v1/tenants/${TENANT}/webhooks`, body: { resource: "messages" } })),
    ).rejects.toMatchObject({ status: 400 });
    expect(harness.provider.createCalls).toHaveLength(0);
  });

  it("rejects a missing resource with 400", async () => {
    const harness = createHarness();
    const route = harness.getRoute("POST", WEBHOOKS_PATH);
    await expect(route.handler(ctxFor(WEBHOOKS_PATH, { concretePath: `/v1/tenants/${TENANT}/webhooks`, body: {} }))).rejects.toMatchObject(
      { status: 400 },
    );
  });

  it("refuses to create when the notification URL is not configured", async () => {
    const harness = createHarness({ notificationUrl: undefined });
    const route = harness.getRoute("POST", WEBHOOKS_PATH);
    await expect(
      route.handler(ctxFor(WEBHOOKS_PATH, { concretePath: `/v1/tenants/${TENANT}/webhooks`, body: { resource: "users" } })),
    ).rejects.toMatchObject({ status: 501 });
    expect(harness.provider.createCalls).toHaveLength(0);
  });
});

describe("POST /v1/tenants/:tenantId/webhooks/:subscriptionId/renew", () => {
  it("renews the subscription", async () => {
    const harness = createHarness();
    const route = harness.getRoute("POST", WEBHOOKS_RENEW_PATH);
    const res = await route.handler(ctxFor(WEBHOOKS_RENEW_PATH, { concretePath: `/v1/tenants/${TENANT}/webhooks/${SUBSCRIPTION}/renew` }));
    expect(res.status).toBe(200);
    expect(harness.provider.renewCalls).toEqual([{ tenantId: TENANT, subscriptionId: SUBSCRIPTION }]);
  });

  it("surfaces a failed renewal with the alert event instead of throwing", async () => {
    const harness = createHarness();
    harness.provider.renewResult = {
      success: false,
      error: "subscription not found",
      alertEvent: {
        kind: "webhook.renewal_failed",
        severity: "High",
        tenantId: TENANT,
        subscriptionId: SUBSCRIPTION,
        resource: "users",
        reason: "subscription not found",
        timestamp: "2026-09-29T00:00:00Z",
      },
      auditEvent: {
        id: "audit-1",
        tenantId: TENANT,
        action: "webhook.subscription.renew",
        targetId: SUBSCRIPTION,
        targetName: "users",
        timestamp: "2026-09-29T00:00:00Z",
        note: "renew failed: subscription not found",
      },
    };
    const route = harness.getRoute("POST", WEBHOOKS_RENEW_PATH);
    const res = await route.handler(ctxFor(WEBHOOKS_RENEW_PATH, { concretePath: `/v1/tenants/${TENANT}/webhooks/${SUBSCRIPTION}/renew` }));
    expect(res.status).toBe(200);
    const body = res.body as Awaited<ReturnType<WebhooksProvider["renew"]>>;
    expect(body.success).toBe(false);
    expect(body.alertEvent?.kind).toBe("webhook.renewal_failed");
    expect(body.auditEvent?.action).toBe("webhook.subscription.renew");
  });
});

describe("POST /v1/tenants/:tenantId/webhooks/:subscriptionId/recreate", () => {
  it("recreates the subscription", async () => {
    const harness = createHarness();
    const route = harness.getRoute("POST", WEBHOOKS_RECREATE_PATH);
    const res = await route.handler(ctxFor(WEBHOOKS_RECREATE_PATH, { concretePath: `/v1/tenants/${TENANT}/webhooks/${SUBSCRIPTION}/recreate` }));
    expect(res.status).toBe(200);
    const body = res.body as Awaited<ReturnType<WebhooksProvider["recreate"]>>;
    expect(body.success).toBe(true);
  });
});

describe("DELETE /v1/tenants/:tenantId/webhooks/:subscriptionId", () => {
  it("deletes the subscription", async () => {
    const harness = createHarness();
    const route = harness.getRoute("DELETE", WEBHOOKS_ITEM_PATH);
    const res = await route.handler(ctxFor(WEBHOOKS_ITEM_PATH, { concretePath: `/v1/tenants/${TENANT}/webhooks/${SUBSCRIPTION}` }));
    expect(res.status).toBe(200);
    expect(harness.provider.removeCalls).toEqual([{ tenantId: TENANT, subscriptionId: SUBSCRIPTION }]);
  });
});

describe("POST /v1/tenants/:tenantId/webhooks/:subscriptionId/test", () => {
  it("reports a healthy subscription", async () => {
    const harness = createHarness();
    const route = harness.getRoute("POST", WEBHOOKS_TEST_PATH);
    const res = await route.handler(ctxFor(WEBHOOKS_TEST_PATH, { concretePath: `/v1/tenants/${TENANT}/webhooks/${SUBSCRIPTION}/test` }));
    expect(res.status).toBe(200);
    const body = res.body as Awaited<ReturnType<WebhooksProvider["test"]>>;
    expect(body.healthy).toBe(true);
    expect(harness.provider.testCalls).toEqual([{ tenantId: TENANT, subscriptionId: SUBSCRIPTION }]);
  });
});

describe("route surface", () => {
  it("mounts the §6 subscription endpoints and the §3.5 row actions", () => {
    const harness = createHarness();
    expect(harness.routes.map((r) => `${r.method} ${r.path}`).sort()).toEqual(
      [
        "GET /v1/tenants/:tenantId/webhooks",
        "POST /v1/tenants/:tenantId/webhooks",
        "DELETE /v1/tenants/:tenantId/webhooks/:subscriptionId",
        "POST /v1/tenants/:tenantId/webhooks/:subscriptionId/renew",
        "POST /v1/tenants/:tenantId/webhooks/:subscriptionId/recreate",
        "POST /v1/tenants/:tenantId/webhooks/:subscriptionId/test",
      ].sort(),
    );
  });
});
