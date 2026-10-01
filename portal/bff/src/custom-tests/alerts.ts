// Custom-test failure alert hand-off (EPIC-036 SPEC.md §2 US-5, §3.4, §4.3; T-0708).
//
// When a custom-test run fails, if alertsEnabled is set for the test, an alert
// event carrying the test output and identity is emitted through the EPIC-029
// alerting seam.
//
// Delivery, channels, and dedupe are deferred to EPIC-029.

import { randomUUID } from "node:crypto";
import type { AlertEvent, AlertSeverity } from "@m365-assess/contracts";
import type { CustomTestRunResult } from "./run.js";

export interface AlertEmitter {
  emit(event: AlertEvent): Promise<void> | void;
}

export interface CustomTestAlertOptions {
  readonly emitter: AlertEmitter;
  readonly idGenerator?: () => string;
  readonly now?: () => string;
}

export interface CustomTestAlertTarget {
  readonly id: string;
  readonly name?: string;
  readonly category?: string;
  readonly alertsEnabled: boolean;
}

/**
 * On a failed custom-test run, when alertsEnabled is set, emit an alert event
 * carrying the test identity and rendered output through the EPIC-029 alerting seam.
 * A passing run emits none. A failed run with alerts disabled emits none.
 */
export async function emitCustomTestAlert(
  test: CustomTestAlertTarget,
  runResult: CustomTestRunResult,
  options: CustomTestAlertOptions,
): Promise<AlertEvent | null> {
  // If run passed, no alert is emitted
  if (runResult.status !== "Fail" && runResult.status !== "Error") {
    return null;
  }

  // If alerts are disabled for this custom test, no alert is emitted
  if (!test.alertsEnabled) {
    return null;
  }

  const now = options.now?.() ?? new Date().toISOString();
  const alertId = options.idGenerator?.() ?? randomUUID();

  const event: AlertEvent = {
    id: alertId,
    ruleId: `custom-test:${test.id}`,
    tenantId: runResult.tenantId,
    firedAt: now,
    severity: "High" as AlertSeverity,
    payload: {
      testId: test.id,
      testName: test.name ?? test.id,
      category: test.category ?? "Custom",
      status: runResult.status,
      score: runResult.score,
      output: runResult.output,
      renderedMarkdown: runResult.renderedMarkdown,
      error: runResult.error ?? null,
      versionId: runResult.versionId,
      runId: runResult.id ?? null,
    },
    state: "open",
    snoozeUntil: null,
  };

  await options.emitter.emit(event);
  return event;
}
