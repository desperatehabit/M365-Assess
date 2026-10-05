// T-0564 — POST /v1/alert-rules/{ruleId}/test dry-run route.
import { describe, expect, it, vi } from "vitest";
import { AppError } from "../errors.js";
import { RbacErrorCodes, type Caller } from "../rbac/authorize.js";
import { ALL_TENANTS } from "../rbac/scope.js";
import type { RequestContext } from "../server.js";
import {
  createAlertRuleTestEvaluator,
  type AlertRuleEvaluation,
} from "../domain/alerts/evaluate.js";
import {
  ALERT_RULES_TEST_OPENAPI,
  ALERT_RULES_TEST_PERMISSION,
  ALERT_RULE_TEST_PATH,
  createAlertRulesTestRoutes,
  type AlertRuleTestStore,
  type TestableAlertRule,
} from "./alert-rules-test.js";

function rule(overrides: Partial<TestableAlertRule> = {}): TestableAlertRule {
  return {
    id: "run-failed",
    name: "Assessment run failed",
    source: "runs",
    severity: "High",
    scope: "tenant",
    channels: ["email"],
    enabled: true,
    scriptMode: false,
    scheduleId: null,
    lastFiredAt: null,
    builtIn: true,
    tenantId: "tenant-1",
    criteria: {
      conditions: [{ property: "status", operator: "eq", input: "failed" }],
      actions: [{ kind: "channel", channel: "email" }],
    },
    ...overrides,
  };
}

function adminCaller(): Caller {
  return { roles: ["admin"], tenantScope: ALL_TENANTS };
}

function ctx(method: string, path: string, params: Record<string, string> = {}): RequestContext {
  return {
    correlationId: "corr-1",
    method,
    path,
    query: new URLSearchParams(),
    headers: {},
    params,
    body: undefined,
  };
}

function routeFor(options: Parameters<typeof createAlertRulesTestRoutes>[0]) {
  const route = createAlertRulesTestRoutes(options).find(
    (candidate) => candidate.method === "POST" && candidate.path === ALERT_RULE_TEST_PATH,
  );
  if (!route) throw new Error("route not found");
  return route;
}

function makeStore(subject: TestableAlertRule | undefined): AlertRuleTestStore {
  return { getRule: async () => subject };
}

describe("POST /v1/alert-rules/{ruleId}/test (T-0564)", () => {
  it("returns matched with counts for a rule that would fire, and delivers nothing", async () => {
    const evaluate = vi.fn(
      async (): Promise<AlertRuleEvaluation> => ({
        ruleId: "run-failed",
        tenantId: "tenant-1",
        source: "runs",
        matched: true,
        matchCount: 2,
        evaluated: 5,
        scriptMode: false,
        evaluations: [],
      }),
    );
    const route = routeFor({
      store: makeStore(rule()),
      evaluator: { evaluate },
      resolveCaller: () => adminCaller(),
      authorize: () => {},
    });

    const response = await route.handler(ctx("POST", ALERT_RULE_TEST_PATH, { ruleId: "run-failed" }));

    expect(response.status).toBe(200);
    // The dry-run route has no delivery or event-write dependency; the response
    // is the whole side effect, so nothing is delivered.
    expect(response.body).toEqual({
      matched: true,
      matchCount: 2,
      evaluated: 5,
      message: "Would fire",
      scriptMode: false,
    });
    expect(evaluate).toHaveBeenCalledTimes(1);
    expect(evaluate).toHaveBeenCalledWith({
      ruleId: "run-failed",
      tenantId: "tenant-1",
      source: "runs",
      criteria: rule().criteria,
    });
  });

  it("returns not-matched when no current row fires", async () => {
    const route = routeFor({
      store: makeStore(rule()),
      evaluator: createAlertRuleTestEvaluator({ read: async () => [{ status: "succeeded" }] }),
      resolveCaller: () => adminCaller(),
      authorize: () => {},
    });

    const response = await route.handler(ctx("POST", ALERT_RULE_TEST_PATH, { ruleId: "run-failed" }));

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ matched: false, matchCount: 0, evaluated: 1 });
  });

  it("flags a script-mode rule without executing it", async () => {
    const subject = rule({
      scriptMode: true,
      criteria: {
        conditions: [{ property: "status", operator: "eq", input: "failed" }],
        actions: [{ kind: "script", scriptId: "alert-script-1" }],
      },
    });
    const route = routeFor({
      store: makeStore(subject),
      evaluator: createAlertRuleTestEvaluator({ read: async () => [{ status: "failed" }] }),
      resolveCaller: () => adminCaller(),
      authorize: () => {},
    });

    const response = await route.handler(ctx("POST", ALERT_RULE_TEST_PATH, { ruleId: "run-failed" }));

    expect(response.body).toMatchObject({ matched: true, scriptMode: true });
  });

  it("returns 404 for an unknown rule", async () => {
    const route = routeFor({
      store: makeStore(undefined),
      evaluator: { evaluate: async () => ({ matched: false }) as AlertRuleEvaluation },
      resolveCaller: () => adminCaller(),
      authorize: () => {},
    });

    await expect(
      route.handler(ctx("POST", ALERT_RULE_TEST_PATH, { ruleId: "missing" })),
    ).rejects.toMatchObject({ status: 404 });
  });

  it("returns 401 without a caller", async () => {
    const route = routeFor({
      store: makeStore(rule()),
      evaluator: { evaluate: async () => ({ matched: false }) as AlertRuleEvaluation },
      resolveCaller: () => undefined,
      authorize: () => {},
    });

    await expect(
      route.handler(ctx("POST", ALERT_RULE_TEST_PATH, { ruleId: "run-failed" })),
    ).rejects.toMatchObject({ status: 401 });
  });

  it("requires CIPP.Alert.ReadWrite through the authorizer seam", async () => {
    const seen: string[] = [];
    const route = routeFor({
      store: makeStore(rule()),
      evaluator: { evaluate: async () => ({ matched: false }) as AlertRuleEvaluation },
      resolveCaller: () => adminCaller(),
      authorize: (_caller: Caller, permission: string) => {
        seen.push(permission);
      },
    });

    await route.handler(ctx("POST", ALERT_RULE_TEST_PATH, { ruleId: "run-failed" }));
    expect(seen).toEqual([ALERT_RULES_TEST_PERMISSION]);
  });

  it("propagates a structured 403 from the authorizer and evaluates nothing", async () => {
    const evaluate = vi.fn(async () => ({ matched: false }) as AlertRuleEvaluation);
    const route = routeFor({
      store: makeStore(rule()),
      evaluator: { evaluate },
      resolveCaller: () => adminCaller(),
      authorize: () => {
        throw new AppError(RbacErrorCodes.forbidden, "forbidden", 403);
      },
    });

    await expect(
      route.handler(ctx("POST", ALERT_RULE_TEST_PATH, { ruleId: "run-failed" })),
    ).rejects.toMatchObject({ status: 403 });
    expect(evaluate).not.toHaveBeenCalled();
  });
});

describe("alert-rules test OpenAPI fragment (T-0564)", () => {
  it("publishes the dry-run operation under CIPP.Alert.ReadWrite", () => {
    const paths = ALERT_RULES_TEST_OPENAPI.paths;
    expect(Object.keys(paths)).toEqual(["/alert-rules/{ruleId}/test"]);
    expect(paths["/alert-rules/{ruleId}/test"].post.permission).toBe(ALERT_RULES_TEST_PERMISSION);
  });
});
