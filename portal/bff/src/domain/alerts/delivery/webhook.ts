// Webhook delivery adapter (EPIC-029 SPEC.md §3.4, §4.3, §9, §11.2; T-0565).
//
// The HTTP POST transport is injected, so the adapter is unit-testable and the
// secret never reaches a log: the URL is read from the NotificationConfig target
// (T-0561), a credential is resolved by *reference* through the EPIC-002 store,
// and only redacted strings are logged or returned. A non-2xx response is a
// failure. A delivery that fails every attempt raises the
// `delivery-channel-failure` meta-alert exactly once through the supplied
// rule-pipeline port.
//
// `@m365-assess/contracts/alert-delivery` owns the canonical types and redaction
// helpers, but that module is not an exported subpath of `@m365-assess/contracts`
// and sits outside the BFF tsconfig rootDir, so the small pure helpers are
// restated here (the same convention as domain/alerts/builtin-catalog.ts).

export const WEBHOOK_CHANNEL = "webhook" as const;

export const DELIVERY_CHANNELS = ["email", "webhook"] as const;

export type DeliveryChannel = (typeof DELIVERY_CHANNELS)[number];

export const META_ALERT_RULE_ID = "delivery-channel-failure";

const REDACTED = "***";

export const DEFAULT_WEBHOOK_RETRY = Object.freeze({
  maxAttempts: 3,
  baseDelayMs: 250,
  maxDelayMs: 4_000,
});

export interface WebhookRequest {
  readonly url: string;
  readonly method: "POST";
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string;
}

export interface WebhookResponse {
  readonly status: number;
}

/** HTTP POST seam. `credential` is the resolved secret, or null. */
export interface WebhookTransport {
  post(request: WebhookRequest, credential: string | null): Promise<WebhookResponse>;
}

export interface DeliveryEvent {
  readonly id: string;
  readonly ruleId: string;
  readonly tenantId: string;
  readonly severity: string;
  readonly firedAt: string;
  readonly payload: Record<string, unknown>;
}

export interface DeliveryChannelConfig {
  readonly id: string;
  readonly channel: DeliveryChannel;
  readonly target: string;
  readonly enabled: boolean;
}

export type DeliveryOutcome = "delivered" | "failed";

export interface DeliveryAttempt {
  readonly attempt: number;
  readonly outcome: DeliveryOutcome;
  readonly error?: string;
}

export interface DeliveryResult {
  readonly channel: "webhook";
  readonly outcome: DeliveryOutcome;
  readonly attempts: readonly DeliveryAttempt[];
  readonly metaAlertRaised: boolean;
  readonly error?: string;
}

export interface DeliveryMetaAlert {
  readonly ruleId: typeof META_ALERT_RULE_ID;
  readonly tenantId: string;
  readonly channel: "webhook";
  readonly firedAt: string;
  readonly severity: string;
  readonly attempts: number;
  readonly error: string;
}

export interface MetaAlertPort {
  raise(alert: DeliveryMetaAlert): Promise<void> | void;
}

export interface DeliveryLogger {
  warn(message: string, fields?: Record<string, unknown>): void;
}

export interface WebhookDeliveryOptions {
  readonly transport: WebhookTransport;
  readonly metaAlert?: MetaAlertPort;
  readonly logger?: DeliveryLogger;
  readonly retry?: Partial<{ maxAttempts: number; baseDelayMs: number; maxDelayMs: number }>;
  /** EPIC-002 reference; resolved with `resolveSecret`, never logged. */
  readonly credentialRef?: string;
  readonly resolveSecret?: (ref: string) => Promise<string | null>;
  /** Test seams. */
  readonly sleep?: (ms: number) => Promise<void>;
  readonly now?: () => string;
}

export interface WebhookDelivery {
  readonly channel: "webhook";
  deliver(event: DeliveryEvent, config: DeliveryChannelConfig): Promise<DeliveryResult>;
}

function redactText(value: string, redactables: readonly string[] = []): string {
  let output = value;
  for (const secret of redactables) {
    if (secret.length > 0) output = output.split(secret).join(REDACTED);
  }
  output = output.replace(/https?:\/\/[^\s"']+/gi, REDACTED);
  output = output.replace(/[\w.+-]+@[\w-]+\.[\w.-]+/g, REDACTED);
  return output;
}

function redactError(error: unknown, redactables: readonly string[] = []): string {
  const message = error instanceof Error ? error.message : String(error);
  return redactText(message, redactables);
}

function backoffMs(policy: { baseDelayMs: number; maxDelayMs: number }, attempt: number): number {
  const exponent = Math.max(0, Math.trunc(attempt) - 1);
  return Math.min(policy.maxDelayMs, policy.baseDelayMs * 2 ** exponent);
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function resolveCredential(
  options: WebhookDeliveryOptions,
  logger: DeliveryLogger | undefined,
): Promise<string | null> {
  if (!options.credentialRef || !options.resolveSecret) return null;
  try {
    return await options.resolveSecret(options.credentialRef);
  } catch (error) {
    logger?.warn("credential resolution failed for webhook delivery", {
      channel: WEBHOOK_CHANNEL,
      error: redactError(error),
    });
    return null;
  }
}

export function createWebhookDelivery(options: WebhookDeliveryOptions): WebhookDelivery {
  const retry = { ...DEFAULT_WEBHOOK_RETRY, ...options.retry };
  const sleep = options.sleep ?? defaultSleep;
  const now = options.now ?? (() => new Date().toISOString());
  const logger = options.logger;

  async function deliver(
    event: DeliveryEvent,
    config: DeliveryChannelConfig,
  ): Promise<DeliveryResult> {
    if (config.channel !== WEBHOOK_CHANNEL) {
      throw new Error(`webhook adapter cannot deliver channel ${config.channel}`);
    }
    const credential = await resolveCredential(options, logger);
    const redactables = credential ? [config.target, credential] : [config.target];
    const attempts: DeliveryAttempt[] = [];
    let lastError = "";

    for (let attempt = 1; attempt <= retry.maxAttempts; attempt++) {
      try {
        const response = await options.transport.post(
          {
            url: config.target,
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              id: event.id,
              ruleId: event.ruleId,
              tenantId: event.tenantId,
              severity: event.severity,
              firedAt: event.firedAt,
              payload: event.payload,
            }),
          },
          credential,
        );
        if (response.status < 200 || response.status >= 300) {
          throw new Error(`webhook returned status ${response.status}`);
        }
        attempts.push({ attempt, outcome: "delivered" });
        return { channel: WEBHOOK_CHANNEL, outcome: "delivered", attempts, metaAlertRaised: false };
      } catch (error) {
        lastError = redactError(error, redactables);
        attempts.push({ attempt, outcome: "failed", error: lastError });
        logger?.warn("webhook delivery attempt failed", {
          channel: WEBHOOK_CHANNEL,
          configId: config.id,
          target: REDACTED,
          attempt,
          error: lastError,
        });
        if (attempt < retry.maxAttempts) {
          await sleep(backoffMs(retry, attempt));
        }
      }
    }

    const metaAlertRaised = await raiseMetaAlert(options, logger, event, attempts.length, lastError, now);
    return {
      channel: WEBHOOK_CHANNEL,
      outcome: "failed",
      attempts,
      metaAlertRaised,
      error: lastError,
    };
  }

  return { channel: WEBHOOK_CHANNEL, deliver };
}

async function raiseMetaAlert(
  options: WebhookDeliveryOptions,
  logger: DeliveryLogger | undefined,
  event: DeliveryEvent,
  attempts: number,
  error: string,
  now: () => string,
): Promise<boolean> {
  if (!options.metaAlert) return false;
  try {
    await options.metaAlert.raise({
      ruleId: META_ALERT_RULE_ID,
      tenantId: event.tenantId,
      channel: WEBHOOK_CHANNEL,
      firedAt: now(),
      severity: "High",
      attempts,
      error,
    });
    return true;
  } catch (raiseError) {
    logger?.warn("failed to raise delivery meta-alert", {
      channel: WEBHOOK_CHANNEL,
      error: redactError(raiseError),
    });
    return false;
  }
}
