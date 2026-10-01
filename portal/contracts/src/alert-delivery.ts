// Alert delivery adapter contract (EPIC-029 SPEC.md §3.4, §4.3, §9, §11.2;
// T-0565). A fired alert is delivered per channel: an adapter takes the
// `AlertEvent` fields and the `NotificationConfig` row for one target, then
// returns a `DeliveryResult` that records every attempt. A failed delivery
// retries with bounded exponential backoff and, after the final attempt, raises
// the `delivery-channel-failure` meta-alert once through the rule pipeline.
//
// §11.2 makes email + webhook the first channels; PSA is deferred to EPIC-041
// and Slack remains future, so neither is a delivery channel here. §9 requires
// channel credentials to be stored by reference and redacted in logs, so the
// adapters accept a credential *reference*, resolve it through the EPIC-002
// store, and redact the resolved material, the target, and any URL or address
// that reaches a log line. Types and pure helpers only — the BFF adapters
// restate these because this module is not an exported subpath of
// `@m365-assess/contracts` and sits outside the BFF tsconfig rootDir.

import type { AlertSeverity } from "./alerting.js";

export const DELIVERY_CHANNELS = ["email", "webhook"] as const;

export type DeliveryChannel = (typeof DELIVERY_CHANNELS)[number];

export function isDeliveryChannel(value: unknown): value is DeliveryChannel {
  return typeof value === "string" && (DELIVERY_CHANNELS as readonly string[]).includes(value);
}

/** The built-in catalog id (T-0562) a channel failure raises. */
export const META_ALERT_RULE_ID = "delivery-channel-failure";

/** Replacement written wherever secret material or a target would appear. */
export const REDACTED = "***";

export type DeliveryOutcome = "delivered" | "failed";

export interface DeliveryAttempt {
  readonly attempt: number;
  readonly outcome: DeliveryOutcome;
  readonly error?: string;
}

export interface DeliveryResult {
  readonly channel: DeliveryChannel;
  readonly outcome: DeliveryOutcome;
  readonly attempts: readonly DeliveryAttempt[];
  readonly metaAlertRaised: boolean;
  readonly error?: string;
}

export interface DeliveryRetryPolicy {
  readonly maxAttempts: number;
  readonly baseDelayMs: number;
  readonly maxDelayMs: number;
}

export const DEFAULT_DELIVERY_RETRY_POLICY: DeliveryRetryPolicy = Object.freeze({
  maxAttempts: 3,
  baseDelayMs: 250,
  maxDelayMs: 4_000,
});

/**
 * Exponential backoff, capped at `maxDelayMs`. `attempt` is the 1-based index of
 * the failure just recorded, so the wait before the next attempt is
 * `baseDelayMs * 2^(attempt - 1)`.
 */
export function deliveryBackoffMs(policy: DeliveryRetryPolicy, attempt: number): number {
  const exponent = Math.max(0, Math.trunc(attempt) - 1);
  return Math.min(policy.maxDelayMs, policy.baseDelayMs * 2 ** exponent);
}

/** The §5 `AlertEvent` fields an adapter needs to build a payload. */
export interface DeliveryEvent {
  readonly id: string;
  readonly ruleId: string;
  readonly tenantId: string;
  readonly severity: AlertSeverity;
  readonly firedAt: string;
  readonly payload: Record<string, unknown>;
}

/**
 * The `NotificationConfig` row for one target (T-0561). `target` is a recipient
 * address for email or a URL for webhook and is never logged unredacted.
 */
export interface DeliveryChannelConfig {
  readonly id: string;
  readonly channel: DeliveryChannel;
  readonly target: string;
  readonly enabled: boolean;
}

/**
 * The meta-alert a failed delivery raises once. The pipeline maps `ruleId` onto
 * the built-in catalog entry of the same id (severity High, §5 AlertEvent).
 */
export interface DeliveryMetaAlert {
  readonly ruleId: typeof META_ALERT_RULE_ID;
  readonly tenantId: string;
  readonly channel: DeliveryChannel;
  readonly firedAt: string;
  readonly severity: AlertSeverity;
  readonly attempts: number;
  readonly error: string;
}

/** The rule-pipeline seam the meta-alert is emitted through. */
export interface MetaAlertPort {
  raise(alert: DeliveryMetaAlert): Promise<void> | void;
}

export interface DeliveryLogger {
  warn(message: string, fields?: Record<string, unknown>): void;
}

export interface AlertDelivery {
  readonly channel: DeliveryChannel;
  deliver(event: DeliveryEvent, config: DeliveryChannelConfig): Promise<DeliveryResult>;
}

/**
 * Replaces a target wholesale: a recipient address or webhook URL is PII or
 * secret-bearing, so no fragment of it is safe to log. Callers correlate
 * failures by `NotificationConfig.id` instead.
 */
export function redactTarget(_target: string): string {
  return REDACTED;
}

/**
 * Redacts free text before it reaches a log or an error result: every explicit
 * `redactables` value (resolved secret, target) is replaced, then any remaining
 * URL or email address. Adapters log only the value this returns.
 */
export function redactText(value: string, redactables: readonly string[] = []): string {
  let output = value;
  for (const secret of redactables) {
    if (secret.length > 0) {
      output = output.split(secret).join(REDACTED);
    }
  }
  output = output.replace(/https?:\/\/[^\s"']+/gi, REDACTED);
  output = output.replace(/[\w.+-]+@[\w-]+\.[\w.-]+/g, REDACTED);
  return output;
}

export function redactError(error: unknown, redactables: readonly string[] = []): string {
  const message = error instanceof Error ? error.message : String(error);
  return redactText(message, redactables);
}
