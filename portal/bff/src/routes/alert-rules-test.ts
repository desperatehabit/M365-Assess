// Alert rule dry-run API (EPIC-029 SPEC.md §4.2, §6, §7; T-0564).
//
//   POST /v1/alert-rules/:ruleId/test -> evaluate the rule against current data
//                                        and report matched/not-matched
//
// §4.2 requires `Test` to evaluate against current data *without delivering*;
// §7 gates it like the rest of the rule surface through the EPIC-001 authorizer
// seam (full RBAC is EPIC-038). The route never reaches into a tenant itself:
// it loads the stored rule and hands the evaluation to the read-only
// AlertRuleTestEvaluator port (ADR-0014). It performs no delivery, writes no
// AlertEvent, and never executes a script — script-mode rules are evaluated for
// a match only; execution belongs to the worker sandbox.

import type { AlertRule } from "../domain/alerts/builtin-catalog.js";
import {
  toAlertRuleTestResult,
  type AlertRuleTestEvaluator,
} from "../domain/alerts/evaluate.js";
import { AppError, ErrorCodes } from "../errors.js";
import { requirePermission, type Caller } from "../rbac/authorize.js";
import type { Permission } from "../rbac/roles.js";
import type { RequestContext, Route, RouteResponse } from "../server.js";

export const ALERT_RULE_TEST_PATH = "/v1/alert-rules/:ruleId/test";

export const ALERT_RULES_TEST_PERMISSION = "alerts.write";
export const ALERT_RULES_TEST_UNAUTHENTICATED = "request.unauthenticated";
export const ALERT_RULE_TEST_NOT_FOUND = "alert.rule_not_found";

// The stored rule the dry-run needs: identity, tenant scope, log source, and the
// criteria document (conditions/actions) the evaluator rehydrates via T-0563.
export interface TestableAlertRule extends AlertRule {
  readonly tenantId: string;
  readonly criteria?: unknown;
}

export interface AlertRuleTestStore {
  getRule(ruleId: string): Promise<TestableAlertRule | undefined>;
}

export interface AlertRulesTestOptions {
  readonly store: AlertRuleTestStore;
  readonly evaluator: AlertRuleTestEvaluator;
  readonly resolveCaller: (ctx: RequestContext) => Caller | undefined;
  readonly authorize?: (caller: Caller, permission: string) => void | Promise<void>;
}

function unauthenticatedError(): AppError {
  return new AppError(ALERT_RULES_TEST_UNAUTHENTICATED, "authentication required", 401);
}

function notFoundError(ruleId: string): AppError {
  return new AppError(ALERT_RULE_TEST_NOT_FOUND, `Alert rule ${ruleId} not found`, 404);
}

function requireCaller(options: AlertRulesTestOptions, ctx: RequestContext): Caller {
  const caller = options.resolveCaller(ctx);
  if (!caller) {
    throw unauthenticatedError();
  }
  return caller;
}

async function ensureAuthorized(
  options: AlertRulesTestOptions,
  caller: Caller,
  permission: string,
): Promise<void> {
  if (options.authorize) {
    await options.authorize(caller, permission);
    return;
  }
  // alerts.* is not in the roles.ts union yet (EPIC-038); deny without a seam.
  requirePermission(caller, permission as Permission);
}

function requireRuleIdParam(ctx: RequestContext): string {
  const value = ctx.params["ruleId"];
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new AppError(ErrorCodes.validationFailed, "ruleId is required", 400, [
      { field: "ruleId", reason: "required" },
    ]);
  }
  return value.trim();
}

export function createAlertRulesTestRoutes(options: AlertRulesTestOptions): Route[] {
  async function handleTest(ctx: RequestContext): Promise<RouteResponse> {
    const caller = requireCaller(options, ctx);
    await ensureAuthorized(options, caller, ALERT_RULES_TEST_PERMISSION);
    const ruleId = requireRuleIdParam(ctx);
    const rule = await options.store.getRule(ruleId);
    if (!rule) {
      throw notFoundError(ruleId);
    }
    const evaluation = await options.evaluator.evaluate({
      ruleId: rule.id,
      tenantId: rule.tenantId,
      source: rule.source,
      criteria: rule.criteria,
    });
    return {
      status: 200,
      headers: { "content-type": "application/json" },
      body: toAlertRuleTestResult(evaluation),
    };
  }

  return [{ method: "POST", path: ALERT_RULE_TEST_PATH, handler: handleTest }];
}

// Route modules own their OpenAPI path items (portal.v1.yaml `paths` is empty
// by design); a wiring ticket merges this fragment into the served document.
export const ALERT_RULES_TEST_OPENAPI = {
  paths: {
    "/alert-rules/{ruleId}/test": {
      post: {
        tags: ["Alerting"],
        operationId: "testAlertRule",
        summary:
          "Dry-run an alert rule against current data and report matched/not-matched without delivering (§4.2).",
        permission: ALERT_RULES_TEST_PERMISSION,
        security: [{ bearerAuth: [] }],
        parameters: [{ name: "ruleId", in: "path", required: true, schema: { type: "string" } }],
        responses: {
          "200": {
            description:
              "The dry-run result (matched, matchCount, evaluated); no AlertEvent is recorded and nothing is delivered.",
          },
          "401": { description: "Authentication is required." },
          "403": { description: "The caller lacks alerts.write." },
          "404": { description: "No such rule." },
        },
      },
    },
  },
} as const;
