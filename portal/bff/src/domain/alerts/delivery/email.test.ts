// T-0565 — email delivery adapter: success, bounded retry, meta-alert, redaction.
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
  DEFAULT_EMAIL_RETRY,
  createEmailDelivery,
  type DeliveryMetaAlert,
  type EmailMessage,
} from "./email.js";

const EVENT: DeliveryEvent = {
  id: "evt-1",
  ruleId: "run-failed",
  tenantId: "t-alpha",
  severity: "High",
  firedAt: "2026-01-01T00:00:00.000Z",
  payload: { section: "defender" },
};

const CONFIG: DeliveryChannelConfig = {
  id: "notif-email-1",
  channel: "email",
  target: "ops@example.invalid",
  enabled: true,
};

class CapturingLogger {
  readonly entries: Array<{ message: string; fields?: Record<string, unknown> }> = [];
  warn(message: string, fields?: Record<string, unknown>): void {
    this.entries.push({ message, fields });
  }
}

describe("email delivery adapter (T-0565)", () => {
  it("pins the adapter to the canonical alert-delivery contract", () => {
    expect([...DELIVERY_CHANNELS]).toEqual(["email", "webhook"]);
    expect(isDeliveryChannel("psa")).toBe(false);
    expect(isDeliveryChannel("slack")).toBe(false);
    expect(META_ALERT_RULE_ID).toBe("delivery-channel-failure");
    expect(DEFAULT_EMAIL_RETRY).toEqual(DEFAULT_DELIVERY_RETRY_POLICY);
    expect(redactTarget("ops@example.invalid")).toBe("***");
    expect(redactText("sent to ops@example.invalid via https://hooks.example/x")).toBe(
      "sent to *** via ***",
    );
  });

  it("delivers a payload and reports the successful attempt", async () => {
    const sent: Array<{ message: EmailMessage; credential: string | null }> = [];
    const delivery = createEmailDelivery({
      transport: {
        async send(message, credential) {
          sent.push({ message, credential });
        },
      },
    });

    const contract: AlertDelivery = delivery;
    const result: DeliveryResult = await contract.deliver(EVENT, CONFIG);

    expect(result.channel).toBe("email");
    expect(result.outcome).toBe("delivered");
    expect(result.attempts).toEqual([{ attempt: 1, outcome: "delivered" }]);
    expect(result.metaAlertRaised).toBe(false);
    expect(sent).toHaveLength(1);
    expect(sent[0]?.message.to).toBe(CONFIG.target);
    expect(JSON.parse(sent[0]!.message.body)).toMatchObject({ id: "evt-1", ruleId: "run-failed" });
  });

  it("retries with bounded exponential backoff and stops on success", async () => {
    let calls = 0;
    const delays: number[] = [];
    const raised: DeliveryMetaAlert[] = [];
    const delivery = createEmailDelivery({
      transport: {
        async send() {
          calls += 1;
          if (calls < 3) throw new Error("smtp temporarily unavailable");
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
    expect(delays).toEqual([250, 500]);
    expect(deliveryBackoffMs(DEFAULT_DELIVERY_RETRY_POLICY, 1)).toBe(250);
    expect(deliveryBackoffMs(DEFAULT_DELIVERY_RETRY_POLICY, 5)).toBe(4_000);
  });

  it("raises the meta-alert exactly once after every attempt fails", async () => {
    const raised: DeliveryMetaAlert[] = [];
    const logger = new CapturingLogger();
    const delivery = createEmailDelivery({
      transport: {
        async send() {
          throw new Error("smtp unavailable");
        },
      },
      logger,
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
      channel: "email",
      severity: "High",
      attempts: 3,
      firedAt: "2026-01-01T00:00:00.000Z",
    });
  });

  it("never logs or returns the target or the resolved credential", async () => {
    const secret = "smtp-secret-value";
    const target = "ops@example.invalid";
    const logger = new CapturingLogger();
    let seenCredential: string | null = "unset";
    const delivery = createEmailDelivery({
      transport: {
        async send(_message, credential) {
          seenCredential = credential;
          throw new Error(`auth ${secret} rejected for ${target}`);
        },
      },
      logger,
      sleep: async () => {},
      credentialRef: "ref://tenants/t-alpha/credential/1",
      resolveSecret: async () => secret,
    });

    const result = await delivery.deliver(EVENT, { ...CONFIG, target });

    expect(seenCredential).toBe(secret);
    const output = JSON.stringify({ result, entries: logger.entries });
    expect(output).not.toContain(secret);
    expect(output).not.toContain(target);
    expect(result.error).toContain("***");
  });

  it("rejects a config for another channel", async () => {
    const delivery = createEmailDelivery({ transport: { async send() {} } });
    await expect(delivery.deliver(EVENT, { ...CONFIG, channel: "webhook" })).rejects.toThrow(
      /email adapter cannot deliver channel webhook/,
    );
  });
});
