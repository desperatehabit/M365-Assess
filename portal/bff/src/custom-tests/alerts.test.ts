import { describe, expect, it, vi } from "vitest";
import type { AlertEvent } from "@m365-assess/contracts";
import { emitCustomTestAlert, type CustomTestAlertTarget } from "./alerts.js";
import type { CustomTestRunResult } from "./run.js";

const TEST_ALERTS_ON: CustomTestAlertTarget = {
  id: "test-sec-01",
  name: "Audit Ingestion Check",
  category: "Compliance",
  alertsEnabled: true,
};

const TEST_ALERTS_OFF: CustomTestAlertTarget = {
  id: "test-sec-02",
  name: "Experimental Rule",
  category: "Draft",
  alertsEnabled: false,
};

const FAILED_RUN: CustomTestRunResult = {
  id: "run-fail-1",
  testId: "test-sec-01",
  versionId: "ver-1",
  tenantId: "tenant-contoso",
  dryRun: false,
  status: "Fail",
  score: 0,
  output: "Rule check returned 0 items; expected >= 1",
  renderedMarkdown: "### Failure\nRule check returned 0 items; expected >= 1",
  durationMs: 120,
  at: "2026-10-01T12:00:00.000Z",
  error: "Check failed",
};

const PASSED_RUN: CustomTestRunResult = {
  id: "run-pass-1",
  testId: "test-sec-01",
  versionId: "ver-1",
  tenantId: "tenant-contoso",
  dryRun: false,
  status: "Pass",
  score: 100,
  output: "All audit records verified",
  renderedMarkdown: "### Success\nAll audit records verified",
  durationMs: 95,
  at: "2026-10-01T12:00:00.000Z",
  error: null,
};

describe("emitCustomTestAlert (T-0708)", () => {
  it("emits one alert event carrying the test output on failed run with alerts enabled", async () => {
    const emitted: AlertEvent[] = [];
    const emitter = {
      emit: vi.fn(async (event: AlertEvent) => {
        emitted.push(event);
      }),
    };

    const alert = await emitCustomTestAlert(TEST_ALERTS_ON, FAILED_RUN, {
      emitter,
      idGenerator: () => "alert-123",
      now: () => "2026-10-01T12:00:01.000Z",
    });

    expect(alert).not.toBeNull();
    expect(emitter.emit).toHaveBeenCalledTimes(1);
    expect(emitted).toHaveLength(1);

    const event = emitted[0];
    expect(event.id).toBe("alert-123");
    expect(event.ruleId).toBe("custom-test:test-sec-01");
    expect(event.tenantId).toBe("tenant-contoso");
    expect(event.firedAt).toBe("2026-10-01T12:00:01.000Z");
    expect(event.severity).toBe("High");
    expect(event.state).toBe("open");
    expect(event.payload.testId).toBe("test-sec-01");
    expect(event.payload.testName).toBe("Audit Ingestion Check");
    expect(event.payload.status).toBe("Fail");
    expect(event.payload.output).toBe(FAILED_RUN.output);
    expect(event.payload.renderedMarkdown).toBe(FAILED_RUN.renderedMarkdown);
    expect(event.payload.runId).toBe("run-fail-1");
  });

  it("emits none when run fails but alerts are disabled on the test", async () => {
    const emitter = { emit: vi.fn() };

    const alert = await emitCustomTestAlert(TEST_ALERTS_OFF, FAILED_RUN, {
      emitter,
    });

    expect(alert).toBeNull();
    expect(emitter.emit).not.toHaveBeenCalled();
  });

  it("emits none when run passes even if alerts are enabled", async () => {
    const emitter = { emit: vi.fn() };

    const alert = await emitCustomTestAlert(TEST_ALERTS_ON, PASSED_RUN, {
      emitter,
    });

    expect(alert).toBeNull();
    expect(emitter.emit).not.toHaveBeenCalled();
  });

  it("does not implement channel delivery or dispatch logic directly (seam contract)", async () => {
    const emitter = { emit: vi.fn() };
    const alert = await emitCustomTestAlert(TEST_ALERTS_ON, FAILED_RUN, { emitter });

    // Confirms it only emits the event contract, without channel/webhook/email calls
    expect(alert).toBeDefined();
    expect(emitter.emit).toHaveBeenCalledWith(
      expect.objectContaining({
        ruleId: "custom-test:test-sec-01",
        state: "open",
      }),
    );
  });
});
