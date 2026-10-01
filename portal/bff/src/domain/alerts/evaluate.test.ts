// T-0564 — batched/dry-run alert evaluation primitives.
import { describe, expect, it, vi } from "vitest";
import {
  createAlertRuleTestEvaluator,
  evaluateAlertRule,
  toAlertRuleTestResult,
  type AlertLogSourceReader,
} from "./evaluate.js";

function channelCriteria(conditions: readonly Record<string, unknown>[]) {
  return { conditions, actions: [{ kind: "channel", channel: "email" }] };
}

describe("evaluateAlertRule (T-0564)", () => {
  it("matches when at least one current row satisfies every condition", () => {
    const result = evaluateAlertRule({
      ruleId: "run-failed",
      tenantId: "tenant-1",
      source: "runs",
      criteria: channelCriteria([{ property: "status", operator: "eq", input: "failed" }]),
      entries: [
        { status: "succeeded" },
        { status: "failed", id: "run-2" },
        { status: "failed", id: "run-3" },
      ],
    });

    expect(result.matched).toBe(true);
    expect(result.matchCount).toBe(2);
    expect(result.evaluated).toBe(3);
    expect(result.scriptMode).toBe(false);
    expect(result.evaluations).toEqual([{ property: "status", operator: "eq", matched: true }]);
  });

  it("reports not-matched with zero counts when no row fires", () => {
    const result = evaluateAlertRule({
      ruleId: "run-failed",
      tenantId: "tenant-1",
      source: "runs",
      criteria: channelCriteria([{ property: "status", operator: "eq", input: "failed" }]),
      entries: [{ status: "succeeded" }, { status: "partial" }],
    });

    expect(result.matched).toBe(false);
    expect(result.matchCount).toBe(0);
    expect(result.evaluated).toBe(2);
    expect(result.evaluations).toEqual([]);
  });

  it("applies AND semantics across the condition rows", () => {
    const criteria = channelCriteria([
      { property: "severity", operator: "eq", input: "High" },
      { property: "status", operator: "eq", input: "open" },
    ]);

    const both = evaluateAlertRule({
      ruleId: "r",
      tenantId: "t",
      source: "incidents",
      criteria,
      entries: [{ severity: "High", status: "open" }],
    });
    const one = evaluateAlertRule({
      ruleId: "r",
      tenantId: "t",
      source: "incidents",
      criteria,
      entries: [{ severity: "High", status: "resolved" }],
    });

    expect(both.matched).toBe(true);
    expect(one.matched).toBe(false);
  });

  it("flags a script-mode rule without executing anything", () => {
    const result = evaluateAlertRule({
      ruleId: "scripted",
      tenantId: "t",
      source: "runs",
      criteria: {
        conditions: [{ property: "status", operator: "eq", input: "failed" }],
        actions: [{ kind: "script", scriptId: "alert-script-1" }],
      },
      entries: [{ status: "failed" }],
    });

    expect(result.matched).toBe(true);
    expect(result.scriptMode).toBe(true);
  });

  it("rejects an invalid criteria document instead of evaluating it", () => {
    expect(() =>
      evaluateAlertRule({
        ruleId: "r",
        tenantId: "t",
        source: "runs",
        criteria: channelCriteria([{ property: "status", operator: "bogus", input: 1 }]),
        entries: [{ status: "failed" }],
      }),
    ).toThrowError(/unknown operator/i);
  });
});

describe("createAlertRuleTestEvaluator (T-0564)", () => {
  it("reads the rule's log source and evaluates the returned rows", async () => {
    const read = vi.fn(async () => [{ status: "failed" }]);
    const reader: AlertLogSourceReader = { read };
    const evaluator = createAlertRuleTestEvaluator(reader);

    const result = await evaluator.evaluate({
      ruleId: "run-failed",
      tenantId: "tenant-1",
      source: "runs",
      criteria: channelCriteria([{ property: "status", operator: "eq", input: "failed" }]),
    });

    expect(read).toHaveBeenCalledTimes(1);
    expect(read).toHaveBeenCalledWith({ tenantId: "tenant-1", source: "runs" });
    expect(result.matched).toBe(true);
    expect(result.evaluated).toBe(1);
  });
});

describe("toAlertRuleTestResult (T-0564)", () => {
  it("maps a match to the wire shape with a would-fire message", () => {
    const wire = toAlertRuleTestResult({
      ruleId: "r",
      tenantId: "t",
      source: "runs",
      matched: true,
      matchCount: 2,
      evaluated: 5,
      scriptMode: false,
      evaluations: [],
    });

    expect(wire).toEqual({
      matched: true,
      matchCount: 2,
      evaluated: 5,
      message: "Would fire",
      scriptMode: false,
    });
  });

  it("notes the sandbox for a script-mode match and no-match otherwise", () => {
    const scripted = toAlertRuleTestResult({
      ruleId: "r",
      tenantId: "t",
      source: "runs",
      matched: true,
      matchCount: 1,
      evaluated: 1,
      scriptMode: true,
      evaluations: [],
    });
    const none = toAlertRuleTestResult({
      ruleId: "r",
      tenantId: "t",
      source: "runs",
      matched: false,
      matchCount: 0,
      evaluated: 1,
      scriptMode: false,
      evaluations: [],
    });

    expect(scripted.message).toMatch(/sandbox/i);
    expect(none.message).toBe("No matching data");
  });
});
