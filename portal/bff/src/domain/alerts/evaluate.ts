// Alert rule dry-run evaluation (EPIC-029 SPEC.md §4.1, §4.2, §6; T-0564).
//
// The rule `Test` action evaluates a rule's criteria against current log-source
// data and reports whether it would fire — without delivering anything (§4.2).
// This module is the pure evaluator plus the read-only seams the dry-run route
// composes: the condition semantics live in `./conditions.ts` (T-0563), and the
// log-source read is a port so the route never reaches into a tenant itself
// (ADR-0014). Nothing here delivers, and nothing here executes a script:
// script-mode rules are only flagged for the sandboxed worker path.

import {
  evaluate as evaluateConditions,
  isScriptCriteriaAction,
  validateAlertCriteria,
  type AlertConditionEvaluation,
} from "./conditions.js";

export interface AlertRuleEvaluationInput {
  readonly ruleId: string;
  readonly tenantId: string;
  readonly source: string;
  readonly criteria: unknown;
  readonly entries: readonly Record<string, unknown>[];
}

export interface AlertRuleEvaluation {
  readonly ruleId: string;
  readonly tenantId: string;
  readonly source: string;
  readonly matched: boolean;
  readonly matchCount: number;
  readonly evaluated: number;
  readonly scriptMode: boolean;
  readonly evaluations: readonly AlertConditionEvaluation[];
}

/**
 * Evaluates a rule's conditions against each current log-source row and reports
 * whether the rule would fire. A row fires when every condition matches (AND,
 * empty set matches vacuously — the T-0563 semantics); the rule matches when at
 * least one row fires. The per-condition detail is taken from the first firing
 * row so the operator can see which predicates matched.
 */
export function evaluateAlertRule(input: AlertRuleEvaluationInput): AlertRuleEvaluation {
  const criteria = validateAlertCriteria(input.criteria);
  const scriptMode = criteria.actions.some(isScriptCriteriaAction);
  let matchCount = 0;
  let evaluations: readonly AlertConditionEvaluation[] = [];
  for (const entry of input.entries) {
    const result = evaluateConditions(criteria.conditions, entry);
    if (result.matched) {
      matchCount += 1;
      if (evaluations.length === 0) {
        evaluations = result.evaluations;
      }
    }
  }
  return {
    ruleId: input.ruleId,
    tenantId: input.tenantId,
    source: input.source,
    matched: matchCount > 0,
    matchCount,
    evaluated: input.entries.length,
    scriptMode,
    evaluations,
  };
}

// Read-only log-source seam: the wiring ticket backs this with the worker that
// reads the tenant's source (SPEC §4.1). It returns property bags, one per row,
// and never mutates tenant state.
export interface AlertLogSourceReader {
  read(input: {
    readonly tenantId: string;
    readonly source: string;
  }): Promise<readonly Record<string, unknown>[]>;
}

// The dry-run port the route calls. A real evaluator reads the current source
// once through AlertLogSourceReader and runs the pure evaluator; a test can
// inject either a fake evaluator or a fake reader.
export interface AlertRuleTestEvaluator {
  evaluate(input: {
    readonly ruleId: string;
    readonly tenantId: string;
    readonly source: string;
    readonly criteria: unknown;
  }): Promise<AlertRuleEvaluation>;
}

export function createAlertRuleTestEvaluator(
  reader: AlertLogSourceReader,
): AlertRuleTestEvaluator {
  return {
    async evaluate(input): Promise<AlertRuleEvaluation> {
      const entries = await reader.read({ tenantId: input.tenantId, source: input.source });
      return evaluateAlertRule({ ...input, entries });
    },
  };
}

// The wire shape the §6 dry-run route returns and the web client renders
// (`AlertRuleTestResult`): matched plus counts and a human-readable message.
export interface AlertRuleTestResult {
  readonly matched: boolean;
  readonly matchCount: number;
  readonly evaluated: number;
  readonly message: string;
  readonly scriptMode: boolean;
}

export function toAlertRuleTestResult(evaluation: AlertRuleEvaluation): AlertRuleTestResult {
  return {
    matched: evaluation.matched,
    matchCount: evaluation.matchCount,
    evaluated: evaluation.evaluated,
    message: evaluation.matched
      ? evaluation.scriptMode
        ? "Would fire; script-mode rules run only in the sandbox"
        : "Would fire"
      : "No matching data",
    scriptMode: evaluation.scriptMode,
  };
}
