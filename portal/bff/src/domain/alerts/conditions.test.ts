// T-0563 — custom alert criteria: validation, operator semantics, script-mode
// gating, and pure condition evaluation.
import { describe, expect, it } from "vitest";
import {
  ALERT_CONDITION_OPERATORS,
  assertCriteriaPersistable,
  criteriaRequiresAdminGate,
  evaluate,
  isHighPrivilegeCriteriaAction,
  isScriptCriteriaAction,
  validateAlertCriteria,
  type AlertCriteria,
} from "./conditions.js";
import { AppError } from "../../errors.js";
import { type Caller } from "../../rbac/authorize.js";
import { ALL_TENANTS } from "../../rbac/scope.js";
import {
  ALERT_CONDITION_OPERATORS as CONTRACT_OPERATORS,
  validateAlertCriteria as validateContractCriteria,
} from "../../../../contracts/src/alert-conditions.js";

const ADMIN: Caller = { roles: ["admin"], tenantScope: ALL_TENANTS };
const OPERATOR: Caller = { roles: ["operator"], tenantScope: ALL_TENANTS };

const CHANNEL_ACTION = { kind: "channel", channel: "email", target: "ops@example.invalid" } as const;

const SCRIPT_ACTION = {
  kind: "script",
  scriptId: "script-0001",
  recurrence: "*/15 * * * *",
  firstRunAt: "2026-01-01T00:00:00.000Z",
  dynamicInputs: ["tenantId"],
  postExecutionActions: ["remediate-0001"],
} as const;

const VALID_CRITERIA: AlertCriteria = {
  conditions: [
    { property: "severity", operator: "eq", input: "High" },
    { property: "count", operator: "ne", input: 0 },
    { property: "title", operator: "like", input: "%phishing%" },
    { property: "id", operator: "match", input: "^inc-[0-9]+$" },
    { property: "score", operator: "gt", input: 50 },
    { property: "state", operator: "in", input: ["open", "snoozed"] },
    { property: "tags", operator: "contains", input: "edr" },
  ],
  actions: [CHANNEL_ACTION],
};

function capture(fn: () => unknown): unknown {
  try {
    fn();
  } catch (error) {
    return error;
  }
  throw new Error("expected function to throw");
}

function expectValidationError(fn: () => unknown, field: string): void {
  const error = capture(fn);
  expect(error).toBeInstanceOf(AppError);
  const appError = error as AppError;
  expect(appError.code).toBe("request.validation_failed");
  expect(appError.status).toBe(400);
  expect(appError.details?.[0]?.field).toBe(field);
}

describe("validateAlertCriteria", () => {
  it("accepts a document using every §3.2 operator", () => {
    expect(validateAlertCriteria(VALID_CRITERIA)).toEqual(VALID_CRITERIA);
  });

  it("accepts a script-mode action as representable", () => {
    const criteria = { conditions: [], actions: [SCRIPT_ACTION] };
    expect(validateAlertCriteria(criteria)).toEqual(criteria);
  });

  it("rejects an unknown operator", () => {
    const criteria = {
      conditions: [{ property: "severity", operator: "regex", input: "High" }],
      actions: [],
    };
    expectValidationError(() => validateAlertCriteria(criteria), "conditions[0].operator");
  });

  it("rejects a condition row that is not an object", () => {
    expectValidationError(() => validateAlertCriteria({ conditions: ["severity"], actions: [] }), "conditions[0]");
  });

  it("rejects a condition row missing its property", () => {
    const criteria = { conditions: [{ operator: "eq", input: "High" }], actions: [] };
    expectValidationError(() => validateAlertCriteria(criteria), "conditions[0].property");
  });

  it("rejects conditions that are not an array", () => {
    expectValidationError(() => validateAlertCriteria({ conditions: "all", actions: [] }), "conditions");
  });

  it("rejects an action with an unknown kind", () => {
    const criteria = { conditions: [], actions: [{ kind: "smoke", signal: "test" }] };
    expectValidationError(() => validateAlertCriteria(criteria), "actions[0].kind");
  });

  it("rejects a channel action with an unknown channel", () => {
    const criteria = { conditions: [], actions: [{ kind: "channel", channel: "carrier-pigeon" }] };
    expectValidationError(() => validateAlertCriteria(criteria), "actions[0].channel");
  });

  it("rejects a script action missing its scriptId", () => {
    const criteria = { conditions: [], actions: [{ kind: "script" }] };
    expectValidationError(() => validateAlertCriteria(criteria), "actions[0].scriptId");
  });

  it("rejects a script action whose dynamicInputs are not strings", () => {
    const criteria = {
      conditions: [],
      actions: [{ kind: "script", scriptId: "script-0001", dynamicInputs: [42] }],
    };
    expectValidationError(() => validateAlertCriteria(criteria), "actions[0].dynamicInputs");
  });

  it("rejects a document that is not an object", () => {
    expectValidationError(() => validateAlertCriteria(["conditions"]), "criteria");
  });
});

describe("script-mode gating", () => {
  it("flags a script action as high privilege but not a channel action", () => {
    expect(isHighPrivilegeCriteriaAction(SCRIPT_ACTION)).toBe(true);
    expect(isHighPrivilegeCriteriaAction(CHANNEL_ACTION)).toBe(false);
    expect(isScriptCriteriaAction(SCRIPT_ACTION)).toBe(true);
  });

  it("flags a criteria document as requiring the admin gate only when it has a script action", () => {
    expect(criteriaRequiresAdminGate({ conditions: [], actions: [SCRIPT_ACTION] })).toBe(true);
    expect(criteriaRequiresAdminGate({ conditions: [], actions: [CHANNEL_ACTION] })).toBe(false);
    expect(criteriaRequiresAdminGate({ conditions: [], actions: [] })).toBe(false);
  });

  it("lets an admin caller persist script-mode criteria", () => {
    const criteria = { conditions: [], actions: [SCRIPT_ACTION] };
    expect(() => assertCriteriaPersistable(criteria, ADMIN)).not.toThrow();
  });

  it("refuses script-mode criteria for a caller without the admin gate", () => {
    const criteria = { conditions: [], actions: [SCRIPT_ACTION] };
    const error = capture(() => assertCriteriaPersistable(criteria, OPERATOR));
    expect(error).toBeInstanceOf(AppError);
    const appError = error as AppError;
    expect(appError.code).toBe("auth.forbidden");
    expect(appError.status).toBe(403);
    expect(appError.details?.[0]?.reason).toBe("script_mode_requires_admin");
  });

  it("lets any caller persist channel-only criteria", () => {
    const criteria = { conditions: [], actions: [CHANNEL_ACTION] };
    expect(() => assertCriteriaPersistable(criteria, OPERATOR)).not.toThrow();
  });
});

describe("evaluate operator semantics", () => {
  const bag = {
    severity: "High",
    count: 3,
    title: "Phishing email delivered",
    id: "inc-0001",
    score: 75,
    state: "open",
    tags: ["edr", "mailbox"],
    nested: { kind: "device", id: "device-0001" },
    absent: null,
  };

  it("matches eq on strings, numbers, booleans, null, and deep-equal objects", () => {
    expect(evaluate([{ property: "severity", operator: "eq", input: "High" }], bag).matched).toBe(true);
    expect(evaluate([{ property: "count", operator: "eq", input: 3 }], bag).matched).toBe(true);
    expect(evaluate([{ property: "absent", operator: "eq", input: null }], bag).matched).toBe(true);
    expect(
      evaluate([{ property: "nested", operator: "eq", input: { kind: "device", id: "device-0001" } }], bag).matched,
    ).toBe(true);
    expect(evaluate([{ property: "severity", operator: "eq", input: "Low" }], bag).matched).toBe(false);
  });

  it("matches ne as the negation of eq", () => {
    expect(evaluate([{ property: "severity", operator: "ne", input: "Low" }], bag).matched).toBe(true);
    expect(evaluate([{ property: "severity", operator: "ne", input: "High" }], bag).matched).toBe(false);
  });

  it("matches like with % and _ wildcards, case-insensitively", () => {
    expect(evaluate([{ property: "title", operator: "like", input: "%phishing%" }], bag).matched).toBe(true);
    expect(evaluate([{ property: "title", operator: "like", input: "PHISHING%" }], bag).matched).toBe(true);
    expect(evaluate([{ property: "title", operator: "like", input: "Phishing email _________" }], bag).matched).toBe(true);
    expect(evaluate([{ property: "title", operator: "like", input: "Phishing email _______" }], bag).matched).toBe(false);
    expect(evaluate([{ property: "title", operator: "like", input: "%malware%" }], bag).matched).toBe(false);
    expect(evaluate([{ property: "count", operator: "like", input: "3" }], bag).matched).toBe(false);
  });

  it("matches regex patterns and never matches an invalid pattern", () => {
    expect(evaluate([{ property: "id", operator: "match", input: "^inc-[0-9]+$" }], bag).matched).toBe(true);
    expect(evaluate([{ property: "id", operator: "match", input: "^evt-" }], bag).matched).toBe(false);
    expect(evaluate([{ property: "id", operator: "match", input: "([unclosed" }], bag).matched).toBe(false);
    expect(evaluate([{ property: "count", operator: "match", input: "3" }], bag).matched).toBe(false);
  });

  it("matches gt numerically for numbers and lexicographically for strings", () => {
    expect(evaluate([{ property: "score", operator: "gt", input: 50 }], bag).matched).toBe(true);
    expect(evaluate([{ property: "score", operator: "gt", input: 75 }], bag).matched).toBe(false);
    expect(evaluate([{ property: "severity", operator: "gt", input: "Critical" }], bag).matched).toBe(true);
    expect(evaluate([{ property: "severity", operator: "gt", input: "Medium" }], bag).matched).toBe(false);
    expect(evaluate([{ property: "score", operator: "gt", input: "50" }], bag).matched).toBe(false);
  });

  it("matches in against array membership", () => {
    expect(evaluate([{ property: "state", operator: "in", input: ["open", "snoozed"] }], bag).matched).toBe(true);
    expect(evaluate([{ property: "state", operator: "in", input: ["resolved"] }], bag).matched).toBe(false);
    expect(evaluate([{ property: "state", operator: "in", input: "open" }], bag).matched).toBe(false);
  });

  it("matches contains for string substrings and array elements", () => {
    expect(evaluate([{ property: "title", operator: "contains", input: "email" }], bag).matched).toBe(true);
    expect(evaluate([{ property: "title", operator: "contains", input: "malware" }], bag).matched).toBe(false);
    expect(evaluate([{ property: "tags", operator: "contains", input: "edr" }], bag).matched).toBe(true);
    expect(evaluate([{ property: "tags", operator: "contains", input: "identity" }], bag).matched).toBe(false);
    expect(evaluate([{ property: "count", operator: "contains", input: 3 }], bag).matched).toBe(false);
  });

  it("never matches a property that is absent from the bag, for every operator", () => {
    for (const operator of ALERT_CONDITION_OPERATORS) {
      const result = evaluate([{ property: "missing", operator, input: "x" }], bag);
      expect(result.matched).toBe(false);
      expect(result.evaluations[0]?.matched).toBe(false);
    }
  });

  it("requires every row to match (AND semantics) and reports each row", () => {
    const result = evaluate(
      [
        { property: "severity", operator: "eq", input: "High" },
        { property: "score", operator: "gt", input: 50 },
      ],
      bag,
    );
    expect(result.matched).toBe(true);
    expect(result.evaluations).toEqual([
      { property: "severity", operator: "eq", matched: true },
      { property: "score", operator: "gt", matched: true },
    ]);
    const partial = evaluate(
      [
        { property: "severity", operator: "eq", input: "High" },
        { property: "score", operator: "gt", input: 100 },
      ],
      bag,
    );
    expect(partial.matched).toBe(false);
    expect(partial.evaluations[1]).toEqual({ property: "score", operator: "gt", matched: false });
  });

  it("matches vacuously for an empty condition set", () => {
    expect(evaluate([], bag)).toEqual({ matched: true, evaluations: [] });
  });

  it("is deterministic across repeated evaluations", () => {
    const conditions = [{ property: "severity", operator: "eq", input: "High" }];
    expect(evaluate(conditions, bag)).toEqual(evaluate(conditions, bag));
  });
});

describe("contract pinning", () => {
  it("restates the exact §3.2 operator list from the contracts module", () => {
    expect([...ALERT_CONDITION_OPERATORS]).toEqual([...CONTRACT_OPERATORS]);
    expect([...ALERT_CONDITION_OPERATORS]).toEqual(["eq", "ne", "like", "match", "gt", "in", "contains"]);
  });

  it("accepts with the contracts validator everything the bff validator accepts", () => {
    const criteria = validateAlertCriteria(VALID_CRITERIA);
    expect(validateContractCriteria(criteria)).toEqual(criteria);
  });
});
