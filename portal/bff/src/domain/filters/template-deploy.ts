// Filter template deploy (EPIC-022 SPEC.md §3.2, §4.1, §5, §6; T-0423).
// Resolves a template's %name% variables (domains, IPs, action overrides) into
// the persisted policyJson. Every variable the template declares must be
// supplied at deploy time: a missing required variable is a validation error,
// never a partial apply. The resolved policy is applied through the EPIC-006
// gate (T-0107) by the route, with before/after and an AuditEvent.
import { AppError } from "../../errors.js";
import type { FilterPolicyState } from "./policy-guard.js";

export const FILTER_TEMPLATE_DEPLOY_MISSING_VARIABLE = "filter_template.missing_variable";
export const FILTER_TEMPLATE_DEPLOY_INVALID_POLICY = "filter_template.invalid_policy";

export interface FilterTemplateDeployRequest {
  readonly policyJson: unknown;
  readonly requiredVariables: readonly string[];
  readonly variables: Readonly<Record<string, string>>;
}

export interface ResolvedFilterTemplatePolicy {
  readonly name: string;
  readonly enabled: boolean;
  readonly settings: Record<string, unknown>;
}

const TOKEN_PATTERN = /%([A-Za-z0-9_][A-Za-z0-9_.-]*)%/g;

function missingVariableError(name: string): AppError {
  return new AppError(
    FILTER_TEMPLATE_DEPLOY_MISSING_VARIABLE,
    `required variable '%${name}%' was not supplied`,
    400,
    [{ field: `variables.${name}`, reason: "required" }],
  );
}

function substitute(value: unknown, supplied: Readonly<Record<string, string>>): unknown {
  if (typeof value === "string") {
    TOKEN_PATTERN.lastIndex = 0;
    return value.replace(TOKEN_PATTERN, (_match, name: string) => {
      const replacement = supplied[name];
      if (replacement === undefined) throw missingVariableError(name);
      return replacement;
    });
  }
  if (Array.isArray(value)) return value.map((item) => substitute(item, supplied));
  if (typeof value === "object" && value !== null) {
    const resolved: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) {
      resolved[key] = substitute(item, supplied);
    }
    return resolved;
  }
  return value;
}

function invalidPolicyError(reason: string): AppError {
  return new AppError(FILTER_TEMPLATE_DEPLOY_INVALID_POLICY, reason, 400, [
    { field: "policyJson", reason: "invalid" },
  ]);
}

/**
 * Resolves the deploy-supplied variables into the template's policyJson and
 * returns the policy to apply. Throws a 400 naming the variable when a
 * required variable is missing or a %name% token has no supplied value.
 */
export function resolveFilterTemplatePolicy(
  request: FilterTemplateDeployRequest,
): ResolvedFilterTemplatePolicy {
  const supplied = request.variables ?? {};
  for (const name of request.requiredVariables ?? []) {
    const value = supplied[name];
    if (value === undefined || value === "") throw missingVariableError(name);
  }

  const resolved = substitute(request.policyJson, supplied);
  if (typeof resolved !== "object" || resolved === null || Array.isArray(resolved)) {
    throw invalidPolicyError("policyJson must resolve to a JSON object");
  }
  const record = resolved as Record<string, unknown>;
  if (typeof record["name"] !== "string" || record["name"].trim().length === 0) {
    throw invalidPolicyError("policyJson must resolve to a policy with a non-empty name");
  }
  if (
    typeof record["settings"] !== "object" ||
    record["settings"] === null ||
    Array.isArray(record["settings"])
  ) {
    throw invalidPolicyError("policyJson must resolve to a policy with a settings object");
  }
  return {
    name: record["name"].trim(),
    enabled: record["enabled"] !== false,
    settings: record["settings"] as Record<string, unknown>,
  };
}

/** The policy state a resolved template deploys as (EPIC-022 §4.1 create/edit). */
export function resolvedPolicyState(policy: ResolvedFilterTemplatePolicy): FilterPolicyState {
  return { name: policy.name, enabled: policy.enabled, settings: policy.settings };
}


