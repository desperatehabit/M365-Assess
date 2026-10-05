// T-0566 — notification channel config and test-send routes.
import { describe, expect, it } from "vitest";
import { AppError } from "../errors.js";
import { RbacErrorCodes, type Caller } from "../rbac/authorize.js";
import { ALL_TENANTS } from "../rbac/scope.js";
import type { RequestContext } from "../server.js";
import type { DeliveryEvent } from "../domain/alerts/delivery/email.js";
import {
  NOTIFICATIONS_OPENAPI,
  NOTIFICATIONS_PATH,
  NOTIFICATIONS_READ_PERMISSION,
  NOTIFICATIONS_TEST_PATH,
  NOTIFICATIONS_WRITE_PERMISSION,
  createNotificationRoutes,
  type NotificationConfig,
  type NotificationConfigPatch,
  type NotificationConfigStore,
  type NotificationDelivery,
} from "./notifications.js";

class FakeStore implements NotificationConfigStore {
  channels: NotificationConfig[];

  constructor(channels: NotificationConfig[] = []) {
    this.channels = channels.map((channel) => ({ ...channel }));
  }

  async listChannels(): Promise<readonly NotificationConfig[]> {
    return this.channels;
  }

  async getChannel(id: string): Promise<NotificationConfig | undefined> {
    return this.channels.find((channel) => channel.id === id);
  }

  async updateChannel(
    id: string,
    patch: NotificationConfigPatch,
  ): Promise<NotificationConfig | undefined> {
    const index = this.channels.findIndex((channel) => channel.id === id);
    if (index < 0) return undefined;
    const updated: NotificationConfig = { ...this.channels[index]!, ...patch };
    this.channels[index] = updated;
    return updated;
  }
}

class FakeDelivery implements NotificationDelivery {
  readonly channel: "email" | "webhook";
  readonly calls: Array<{ event: DeliveryEvent; config: { target: string } }> = [];
  failWith?: string;

  constructor(channel: "email" | "webhook") {
    this.channel = channel;
  }

  async deliver(event: DeliveryEvent, config: { target: string }) {
    this.calls.push({ event, config });
    if (this.failWith !== undefined) {
      return {
        channel: this.channel,
        outcome: "failed" as const,
        attempts: [{ attempt: 1, outcome: "failed" as const, error: this.failWith }],
        metaAlertRaised: false,
        error: this.failWith,
      };
    }
    return {
      channel: this.channel,
      outcome: "delivered" as const,
      attempts: [{ attempt: 1, outcome: "delivered" as const }],
      metaAlertRaised: false,
    };
  }
}

function adminCaller(): Caller {
  return { roles: ["admin"], tenantScope: ALL_TENANTS };
}

function ctx(
  method: string,
  path: string,
  options: { params?: Record<string, string>; body?: unknown } = {},
): RequestContext {
  return {
    correlationId: "corr-1",
    method,
    path,
    query: new URLSearchParams(),
    headers: {},
    params: options.params ?? {},
    body: options.body,
  };
}

function routeFor(
  options: Parameters<typeof createNotificationRoutes>[0],
  method: string,
  path: string,
) {
  const route = createNotificationRoutes(options).find(
    (candidate) => candidate.method === method && candidate.path === path,
  );
  if (!route) throw new Error(`route not found: ${method} ${path}`);
  return route;
}

function makeOptions(store: NotificationConfigStore, overrides: Record<string, unknown> = {}) {
  return {
    store,
    resolveCaller: () => adminCaller(),
    authorize: () => {},
    generateEventId: () => "test-evt-1",
    ...overrides,
  };
}

function seedChannels(): NotificationConfig[] {
  return [
    { id: "notif-email-1", channel: "email", target: "ops@example.com", enabled: true },
    { id: "notif-webhook-1", channel: "webhook", target: "https://hooks.example.com/abc", enabled: false },
    { id: "notif-psa-1", channel: "psa", target: "connector-1", enabled: false },
  ];
}

describe("GET /v1/notifications (T-0566)", () => {
  it("lists channels with enabled state", async () => {
    const store = new FakeStore(seedChannels());
    const route = routeFor(makeOptions(store), "GET", NOTIFICATIONS_PATH);

    const response = await route.handler(ctx("GET", NOTIFICATIONS_PATH));
    expect(response.status).toBe(200);
    const { channels } = response.body as { channels: NotificationConfig[] };
    expect(channels).toHaveLength(3);
    expect(channels[0]).toEqual({
      id: "notif-email-1",
      channel: "email",
      target: "ops@example.com",
      enabled: true,
    });
    expect(channels[1]!.enabled).toBe(false);
  });

  it("requires CIPP.Alert.Read", async () => {
    const seen: string[] = [];
    const route = routeFor(
      makeOptions(new FakeStore(), {
        authorize: (_caller: Caller, permission: string) => {
          seen.push(permission);
        },
      }),
      "GET",
      NOTIFICATIONS_PATH,
    );
    await route.handler(ctx("GET", NOTIFICATIONS_PATH));
    expect(seen).toEqual([NOTIFICATIONS_READ_PERMISSION]);
  });

  it("returns 401 without a caller", async () => {
    const route = routeFor(
      makeOptions(new FakeStore(), { resolveCaller: () => undefined }),
      "GET",
      NOTIFICATIONS_PATH,
    );
    await expect(route.handler(ctx("GET", NOTIFICATIONS_PATH))).rejects.toMatchObject({ status: 401 });
  });
});

describe("PUT /v1/notifications (T-0566)", () => {
  it("updates a channel's target and enabled state", async () => {
    const store = new FakeStore(seedChannels());
    const route = routeFor(makeOptions(store), "PUT", NOTIFICATIONS_PATH);

    const response = await route.handler(
      ctx("PUT", NOTIFICATIONS_PATH, {
        body: { id: "notif-email-1", target: "new@example.com", enabled: false },
      }),
    );
    expect(response.status).toBe(200);
    const { channel } = response.body as { channel: NotificationConfig };
    expect(channel).toEqual({
      id: "notif-email-1",
      channel: "email",
      target: "new@example.com",
      enabled: false,
    });
    expect(store.channels[0]!.target).toBe("new@example.com");
    expect(store.channels[0]!.enabled).toBe(false);
  });

  it("requires CIPP.Alert.ReadWrite and audits the change without the target value", async () => {
    const seen: string[] = [];
    const audits: Record<string, unknown>[] = [];
    const store = new FakeStore(seedChannels());
    const route = routeFor(
      makeOptions(store, {
        authorize: (_caller: Caller, permission: string) => {
          seen.push(permission);
        },
        audit: { record: (event: Record<string, unknown>) => { audits.push(event); } },
      }),
      "PUT",
      NOTIFICATIONS_PATH,
    );
    await route.handler(
      ctx("PUT", NOTIFICATIONS_PATH, { body: { id: "notif-email-1", target: "new@example.com" } }),
    );
    expect(seen).toEqual([NOTIFICATIONS_WRITE_PERMISSION]);
    expect(audits).toHaveLength(1);
    expect(audits[0]!["action"]).toBe("notification-channel.update");
    expect(audits[0]!["channelId"]).toBe("notif-email-1");
    expect(audits[0]!["channel"]).toBe("email");
    expect(audits[0]!["fields"]).toEqual(["target"]);
    expect(audits[0]!["target"]).toBe("***");
    expect(JSON.stringify(audits[0])).not.toContain("new@example.com");
    expect(audits[0]!["correlationId"]).toBe("corr-1");
  });

  it("audits an enable-only change without a target field", async () => {
    const audits: Record<string, unknown>[] = [];
    const route = routeFor(
      makeOptions(new FakeStore(seedChannels()), {
        audit: { record: (event: Record<string, unknown>) => { audits.push(event); } },
      }),
      "PUT",
      NOTIFICATIONS_PATH,
    );
    const response = await route.handler(
      ctx("PUT", NOTIFICATIONS_PATH, { body: { id: "notif-webhook-1", enabled: true } }),
    );
    expect(response.status).toBe(200);
    expect(audits[0]!["fields"]).toEqual(["enabled"]);
    expect(audits[0]!["target"]).toBeUndefined();
  });

  it("returns 404 for an unknown channel", async () => {
    const route = routeFor(makeOptions(new FakeStore(seedChannels())), "PUT", NOTIFICATIONS_PATH);
    await expect(
      route.handler(ctx("PUT", NOTIFICATIONS_PATH, { body: { id: "missing", enabled: true } })),
    ).rejects.toMatchObject({ status: 404 });
  });

  it("rejects a missing id, empty target, non-boolean enabled, or no changes", async () => {
    const route = routeFor(makeOptions(new FakeStore(seedChannels())), "PUT", NOTIFICATIONS_PATH);
    await expect(
      route.handler(ctx("PUT", NOTIFICATIONS_PATH, { body: { enabled: true } })),
    ).rejects.toMatchObject({ status: 400 });
    await expect(
      route.handler(ctx("PUT", NOTIFICATIONS_PATH, { body: { id: "notif-email-1", target: "  " } })),
    ).rejects.toMatchObject({ status: 400 });
    await expect(
      route.handler(ctx("PUT", NOTIFICATIONS_PATH, { body: { id: "notif-email-1", enabled: "yes" } })),
    ).rejects.toMatchObject({ status: 400 });
    await expect(
      route.handler(ctx("PUT", NOTIFICATIONS_PATH, { body: { id: "notif-email-1" } })),
    ).rejects.toMatchObject({ status: 400 });
  });

  it("propagates a structured 403 from the authorizer and does not mutate", async () => {
    const store = new FakeStore(seedChannels());
    const deny = () => {
      throw new AppError(RbacErrorCodes.forbidden, "forbidden", 403);
    };
    const route = routeFor(makeOptions(store, { authorize: deny }), "PUT", NOTIFICATIONS_PATH);
    await expect(
      route.handler(ctx("PUT", NOTIFICATIONS_PATH, { body: { id: "notif-email-1", enabled: false } })),
    ).rejects.toMatchObject({ status: 403 });
    expect(store.channels[0]!.enabled).toBe(true);
  });
});

describe("POST /v1/notifications/test (T-0566)", () => {
  it("sends through the real email adapter and records no event", async () => {
    const delivery = new FakeDelivery("email");
    const audits: Record<string, unknown>[] = [];
    const route = routeFor(
      makeOptions(new FakeStore(seedChannels()), {
        deliveries: { email: delivery },
        audit: { record: (event: Record<string, unknown>) => { audits.push(event); } },
      }),
      "POST",
      NOTIFICATIONS_TEST_PATH,
    );

    const response = await route.handler(
      ctx("POST", NOTIFICATIONS_TEST_PATH, { body: { channel: "email", target: "ops@example.com" } }),
    );
    expect(response.status).toBe(200);
    expect(delivery.calls).toHaveLength(1);
    const { event, config } = delivery.calls[0]!;
    expect(event["ruleId"]).toBe("notification-test");
    expect(event["id"]).toBe("test-evt-1");
    expect(event["severity"]).toBe("Info");
    expect(event["payload"]).toEqual({ test: true, channel: "email" });
    expect(config.target).toBe("ops@example.com");

    const body = response.body as Record<string, unknown>;
    expect(body["channel"]).toBe("email");
    expect(body["outcome"]).toBe("delivered");
    expect(body["attempts"]).toEqual([{ attempt: 1, outcome: "delivered" }]);
    expect(body["metaAlertRaised"]).toBe(false);
    expect(JSON.stringify(body)).not.toContain("ops@example.com");
    expect(audits).toHaveLength(0);
  });

  it("sends through the webhook adapter with the default target when none is given", async () => {
    const delivery = new FakeDelivery("webhook");
    const route = routeFor(
      makeOptions(new FakeStore(), { deliveries: { webhook: delivery } }),
      "POST",
      NOTIFICATIONS_TEST_PATH,
    );

    const response = await route.handler(
      ctx("POST", NOTIFICATIONS_TEST_PATH, { body: { channel: "webhook" } }),
    );
    expect(response.status).toBe(200);
    expect(delivery.calls).toHaveLength(1);
    expect(delivery.calls[0]!.config.target).toBe("https://portal-test.example.invalid/notifications");
    expect(delivery.calls[0]!.event["payload"]).toEqual({ test: true, channel: "webhook" });
    const body = response.body as Record<string, unknown>;
    expect(body["channel"]).toBe("webhook");
    expect(body["outcome"]).toBe("delivered");
  });

  it("reports a failed delivery without recording an event", async () => {
    const delivery = new FakeDelivery("email");
    delivery.failWith = "smtp unavailable";
    const route = routeFor(
      makeOptions(new FakeStore(), { deliveries: { email: delivery } }),
      "POST",
      NOTIFICATIONS_TEST_PATH,
    );

    const response = await route.handler(
      ctx("POST", NOTIFICATIONS_TEST_PATH, { body: { channel: "email" } }),
    );
    expect(response.status).toBe(200);
    const body = response.body as Record<string, unknown>;
    expect(body["outcome"]).toBe("failed");
    expect(body["error"]).toBe("smtp unavailable");
    expect(body["metaAlertRaised"]).toBe(false);
  });

  it("returns a structured 501 for psa and slack", async () => {
    const route = routeFor(makeOptions(new FakeStore()), "POST", NOTIFICATIONS_TEST_PATH);
    for (const channel of ["psa", "slack"] as const) {
      const error = await route.handler(
        ctx("POST", NOTIFICATIONS_TEST_PATH, { body: { channel } }),
      ).catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(AppError);
      expect((error as AppError).status).toBe(501);
      expect((error as AppError).code).toBe("notification.channel_not_supported");
    }
  });

  it("returns a structured 501 when no adapter is wired for the channel", async () => {
    const route = routeFor(makeOptions(new FakeStore()), "POST", NOTIFICATIONS_TEST_PATH);
    await expect(
      route.handler(ctx("POST", NOTIFICATIONS_TEST_PATH, { body: { channel: "email" } })),
    ).rejects.toMatchObject({ status: 501, code: "notification.channel_not_supported" });
  });

  it("requires CIPP.Alert.ReadWrite", async () => {
    const seen: string[] = [];
    const route = routeFor(
      makeOptions(new FakeStore(), {
        deliveries: { email: new FakeDelivery("email") },
        authorize: (_caller: Caller, permission: string) => {
          seen.push(permission);
        },
      }),
      "POST",
      NOTIFICATIONS_TEST_PATH,
    );
    await route.handler(ctx("POST", NOTIFICATIONS_TEST_PATH, { body: { channel: "email" } }));
    expect(seen).toEqual([NOTIFICATIONS_WRITE_PERMISSION]);
  });

  it("rejects an unknown or missing channel", async () => {
    const route = routeFor(makeOptions(new FakeStore()), "POST", NOTIFICATIONS_TEST_PATH);
    await expect(
      route.handler(ctx("POST", NOTIFICATIONS_TEST_PATH, { body: { channel: "sms" } })),
    ).rejects.toMatchObject({ status: 400 });
    await expect(
      route.handler(ctx("POST", NOTIFICATIONS_TEST_PATH, { body: {} })),
    ).rejects.toMatchObject({ status: 400 });
  });
});

describe("notifications OpenAPI fragment (T-0566)", () => {
  it("publishes the config and test-send operations with the alerts permissions", () => {
    const paths = NOTIFICATIONS_OPENAPI.paths;
    expect(Object.keys(paths)).toEqual(["/notifications", "/notifications/test"]);
    expect(paths["/notifications"].get.permission).toBe(NOTIFICATIONS_READ_PERMISSION);
    expect(paths["/notifications"].put.permission).toBe(NOTIFICATIONS_WRITE_PERMISSION);
    expect(paths["/notifications/test"].post.permission).toBe(NOTIFICATIONS_WRITE_PERMISSION);
  });
});
