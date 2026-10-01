// T-0565 — webhook delivery adapter: success, bounded retry, meta-alert, redaction.
import { describe, expect, it } from "vitest";
import {
  DEFAULT_DELIVERY_RETRY_POLICY,
  DELIVERY_CHANNELS,
  META_ALERT_RULE_ID,
  deliveryBackoffMs,
  isDeliveryChannel,
  redactTarget,
  redactText,
  type AlertDelivery,
  type DeliveryChannelConfig,
  type DeliveryEvent,
  type DeliveryResult,
} from "../../../../../contracts/src/alert-delivery.js";
import {
  DEFAULT_WEBHOOK_RETRY,
  createWebhookDelivery,
  type DeliveryMetaAlert,
  type WebhookRequest,
  type WebhookResponse,
} from "./webhook.js";

const EVENT: DeliveryEvent = {
  id: "evt-1",
  ruleId: "conditional-access-policy-change",
  tenantId: "t-alpha",
  severity: "High",
  firedAt: "2026-01-01T00:00:00.000Z",
  payload: { policyId: "policy-1" },
};

const CONFIG: DeliveryChannelConfig = {
  id: "notif-webhook-1",
  channel: "webhook",
  target: "https://hooks.example.invalid/services/abc",
  enabled: true,
};

class CapturingLogger {
  readonly entries: Array<{ message: string; fields?: Record<string, unknown> }> = [];
  warn(message: string, fields?: Record<string, unknown>): void {
    this.entries.push({ message, fields });
  }
}

describe("webhook delivery adapter (T-0565)", () => {
  it("pins the adapter to the canonical alert-delivery contract", () => {
    expect([...DELIVERY_CHANNELS]).toEqual(["email", "webhook"]);
    expect(isDeliveryChannel("psa")).toBe(false);
    expect(isDeliveryChannel("slack")).toBe(false);
    expect(META_ALERT_RULE_ID).toBe("delivery-channel-failure");
    expect(DEFAULT_WEBHOOK_RETRY).toEqual(DEFAULT_DELIVERY_RETRY_POLICY);
    expect(redactTarget(CONFIG.target)).toBe("***");
    expect(redactText("POST https://hooks.example.invalid/x failed")).toBe("POST *** failed");
  });

  it("posts the payload and reports the successful attempt", async () => {
    const sent: Array<{ request: WebhookRequest; credential: string | null }> = [];
    const delivery = createWebhookDelivery({
      transport: {
        async post(request, credential) {
          sent.push({ request, credential });
          return { status: 204 } satisfies WebhookResponse;
        },
      },
    });

    const contract: AlertDelivery = delivery;
    const result: DeliveryResult = await contract.deliver(EVENT, CONFIG);

    expect(result.channel).toBe("webhook");
    expect(result.outcome).toBe("delivered");
    expect(result.attempts).toEqual([{ attempt: 1, outcome: "delivered" }]);
    expect(result.metaAlertRaised).toBe(false);
    expect(sent).toHaveLength(1);
    expect(sent[0]?.request.url).toBe(CONFIG.target);
    expect(sent[0]?.request.method).toBe("POST");
    expect(JSON.parse(sent[0]!.request.body)).toMatchObject({ ruleId: EVENT.ruleId });
  });

  it("retries a non-2xx response with bounded exponential backoff", async () => {
    let calls = 0;
    const delays: number[] = [];
    const raised: DeliveryMetaAlert[] = [];
    const delivery = createWebhookDelivery({
      transport: {
        async post() {
          calls += 1;
          return calls < 3 ? { status: 503 } : { status: 200 };
        },
      },
      retry: { maxAttempts: 3 },
      sleep: async (ms) => {
        delays.push(ms);
      },
      metaAlert: {
        raise(alert) {
          raised.push(alert);
        },
      },
    });

    const result = await delivery.deliver(EVENT, CONFIG);

    expect(result.outcome).toBe("delivered");
    expect(raised).toHaveLength(0);
    expect(result.attempts.map((attempt) => attempt.outcome)).toEqual([
      "failed",
      "failed",
      "delivered",
    ]);
    expect(result.attempts[0]?.error).toContain("503");
    expect(delays).toEqual([250, 500]);
    expect(deliveryBackoffMs(DEFAULT_DELIVERY_RETRY_POLICY, 2)).toBe(500);
    expect(deliveryBackoffMs(DEFAULT_DELIVERY_RETRY_POLICY, 6)).toBe(4_000);
  });

  it("raises the meta-alert exactly once after every attempt fails", async () => {
    const raised: DeliveryMetaAlert[] = [];
    const delivery = createWebhookDelivery({
      transport: {
        async post() {
          return { status: 500 };
        },
      },
      sleep: async () => {},
      now: () => "2026-01-01T00:00:00.000Z",
      metaAlert: {
        raise(alert) {
          raised.push(alert);
        },
      },
    });

    const result = await delivery.deliver(EVENT, CONFIG);

    expect(result.outcome).toBe("failed");
    expect(result.attempts).toHaveLength(3);
    expect(result.metaAlertRaised).toBe(true);
    expect(raised).toHaveLength(1);
    expect(raised[0]).toMatchObject({
      ruleId: "delivery-channel-failure",
      tenantId: "t-alpha",
      channel: "webhook",
      attempts: 3,
    });
  });

  it("never logs or returns the URL or the resolved credential", async () => {
    const secret = "bearer-secret-value";
    const logger = new CapturingLogger();
    let seenCredential: string | null = "unset";
    const delivery = createWebhookDelivery({
      transport: {
        async post(_request, credential) {
          seenCredential = credential;
          throw new Error(`POST ${CONFIG.target} rejected credential ${secret}`);
        },
      },
      logger,
      sleep: async () => {},
      credentialRef: "ref://tenants/t-alpha/credential/2",
      resolveSecret: async () => secret,
    });

    const result = await delivery.deliver(EVENT, CONFIG);

    expect(seenCredential).toBe(secret);
    const output = JSON.stringify({ result, entries: logger.entries });
    expect(output).not.toContain(secret);
    expect(output).not.toContain(CONFIG.target);
    expect(result.error).toContain("***");
  });

  it("rejects a config for another channel", async () => {
    const delivery = createWebhookDelivery({
      transport: {
        async post() {
          return { status: 200 };
        },
      },
    });
    await expect(delivery.deliver(EVENT, { ...CONFIG, channel: "email" })).rejects.toThrow(
      /webhook adapter cannot deliver channel email/,
    );
  });
});
