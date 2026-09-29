import { describe, expect, it } from "vitest";
import {
  WEBHOOK_NOTIFY_PATH,
  createWebhookNotifyRoute,
  handleWebhookNotify,
  type WebhookDispatchedNotification,
  type WebhookNotifyDispatcher,
  type WebhookNotifyRouteOptions,
  type WebhookNotifyStore,
  type WebhookNotificationReference,
} from "./webhook-notify.js";

const TENANT = "tenant-test";
const SUBSCRIPTION = "sub-1";
const CLIENT_STATE = "secret-client-state";

class FakeWebhookNotifyStore implements WebhookNotifyStore {
  readonly records: WebhookNotificationReference[] = [];
  subscriptions: Record<string, { tenantId: string; clientState: string }> = {
    [SUBSCRIPTION]: { tenantId: TENANT, clientState: CLIENT_STATE },
  };

  async getSubscription(subscriptionId: string) {
    return this.subscriptions[subscriptionId];
  }

  async recordNotification(reference: WebhookNotificationReference) {
    this.records.push(reference);
  }
}

class FakeWebhookNotifyDispatcher implements WebhookNotifyDispatcher {
  readonly dispatched: WebhookDispatchedNotification[] = [];

  async dispatch(notification: WebhookDispatchedNotification) {
    this.dispatched.push(notification);
  }
}

function createHarness(overrides?: Partial<WebhookNotifyRouteOptions>) {
  const store = new FakeWebhookNotifyStore();
  const dispatch = new FakeWebhookNotifyDispatcher();
  const routes = createWebhookNotifyRoute({
    store,
    dispatch,
    ...overrides,
  });
  return { store, dispatch, routes };
}

function ctxFor(body: unknown, query?: URLSearchParams) {
  return {
    path: WEBHOOK_NOTIFY_PATH,
    params: {},
    query: query ?? new URLSearchParams(),
    headers: {},
    body,
  } as any;
}

function notificationBody(overrides?: Record<string, unknown>) {
  return {
    value: [
      {
        subscriptionId: SUBSCRIPTION,
        clientState: CLIENT_STATE,
        resource: "users",
        changeType: "updated",
        ...overrides,
      },
    ],
  };
}

describe("POST /v1/webhooks/notify", () => {
  it("rejects a notification whose clientState does not match the subscription", async () => {
    const harness = createHarness();
    const route = harness.routes[0]!;
    await expect(
      route.handler(ctxFor(notificationBody({ clientState: "wrong-state" }))),
    ).rejects.toMatchObject({ status: 401 });
    expect(harness.store.records).toHaveLength(0);
    expect(harness.dispatch.dispatched).toHaveLength(0);
  });

  it("rejects a notification for an unknown subscription", async () => {
    const harness = createHarness();
    const route = harness.routes[0]!;
    await expect(
      route.handler(ctxFor(notificationBody({ subscriptionId: "sub-unknown" }))),
    ).rejects.toMatchObject({ status: 401 });
  });

  it("dispatches a valid notification and records it by reference", async () => {
    const harness = createHarness();
    const route = harness.routes[0]!;
    const res = await route.handler(ctxFor(notificationBody()));
    expect(res.status).toBe(200);
    const body = res.body as { received: number };
    expect(body.received).toBe(1);

    expect(harness.store.records).toEqual([
      {
        subscriptionId: SUBSCRIPTION,
        tenantId: TENANT,
        resource: "users",
        changeType: "updated",
        receivedAt: harness.store.records[0]?.receivedAt,
      },
    ]);
    expect(harness.dispatch.dispatched).toEqual([
      {
        subscriptionId: SUBSCRIPTION,
        tenantId: TENANT,
        resource: "users",
        changeType: "updated",
        clientState: CLIENT_STATE,
        receivedAt: harness.dispatch.dispatched[0]?.receivedAt,
      },
    ]);
  });

  it("stores an encrypted content payload by reference only, without reading it", async () => {
    const harness = createHarness();
    const route = harness.routes[0]!;
    const res = await route.handler(
      ctxFor(
        notificationBody({
          encryptedContent: {
            data: "opaque-bytes",
            dataKey: "opaque-key",
            dataSignature: "opaque-sig",
            encryptionCertificateId: "cert-1",
          },
        }),
      ),
    );
    expect(res.status).toBe(200);
    const reference = harness.store.records[0] as Record<string, unknown>;
    expect(reference).not.toHaveProperty("encryptedContent");
    expect(reference).not.toHaveProperty("content");
    expect(reference).not.toHaveProperty("data");
    const dispatched = harness.dispatch.dispatched[0] as Record<string, unknown>;
    expect(dispatched).not.toHaveProperty("encryptedContent");
  });

  it("rejects a body without a value array", async () => {
    const harness = createHarness();
    const route = harness.routes[0]!;
    await expect(route.handler(ctxFor({}))).rejects.toMatchObject({ status: 400 });
  });

  it("rejects a notification missing clientState", async () => {
    const harness = createHarness();
    const route = harness.routes[0]!;
    const body = notificationBody();
    delete (body.value[0] as Record<string, unknown>)["clientState"];
    await expect(route.handler(ctxFor(body))).rejects.toMatchObject({ status: 400 });
  });

  it("answers the Graph validation handshake by echoing the validation token", async () => {
    const harness = createHarness();
    const route = harness.routes[0]!;
    const res = await route.handler(
      ctxFor(undefined, new URLSearchParams({ validationToken: "token-123" })),
    );
    expect(res.status).toBe(200);
    expect(res.raw).toBe("token-123");
    expect(res.contentType).toBe("text/plain; charset=utf-8");
    expect(harness.store.records).toHaveLength(0);
  });

  it("requires no caller: the receiver is unauthenticated", async () => {
    const harness = createHarness();
    const route = harness.routes[0]!;
    const res = await handleWebhookNotify(
      { store: harness.store, dispatch: harness.dispatch },
      ctxFor(notificationBody()),
    );
    expect(res.status).toBe(200);
  });
});
