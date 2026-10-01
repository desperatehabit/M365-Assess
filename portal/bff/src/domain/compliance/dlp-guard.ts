// DLP policy compliance guard (EPIC-030 SPEC.md §4.1, §8; T-0583).
//
// Classifies a proposed DLP policy change before it reaches the EPIC-006 gated
// apply path (T-0108). Disabling or deleting a DLP policy is compliance-impacting
// — it weakens or removes an information-protection control — so the plan carries
// the warning with requiresConfirmation and apply is refused until the caller
// sends explicit confirmation. Every applied change is still audited with
// before/after by the route. This module is pure: it names no command and
// performs no tenant write.
import { AppError } from "../../errors.js";

export const DLP_COMPLIANCE_IMPACTING_CODE = "dlp.compliance_impacting";

export const DLP_COMPLIANCE_IMPACTING_WARNING =
  "Disabling or deleting a DLP policy weakens information protection. " +
  "Review the plan preview before applying. This change is audited with before/after.";

export const DLP_POLICY_ACTIONS = ["create", "edit", "enable", "disable", "delete"] as const;

export type DlpPolicyAction = (typeof DLP_POLICY_ACTIONS)[number];

const COMPLIANCE_IMPACTING_ACTIONS: ReadonlySet<DlpPolicyAction> = new Set(["disable", "delete"]);

export interface DlpPolicyState {
  readonly name: string;
  readonly enabled: boolean;
  readonly locations: readonly string[];
}

export interface DlpPolicyProposal {
  readonly action: DlpPolicyAction;
  readonly before?: DlpPolicyState | null;
  readonly after?: DlpPolicyState | null;
}

export interface DlpPolicyAssessment {
  readonly valid: boolean;
  readonly complianceImpacting: boolean;
  readonly requiresConfirmation: boolean;
  readonly warning?: string;
  readonly reasons: readonly string[];
}

function isDlpPolicyAction(value: unknown): value is DlpPolicyAction {
  return typeof value === "string" && (DLP_POLICY_ACTIONS as readonly string[]).includes(value);
}

function hasName(state: DlpPolicyState | null | undefined): boolean {
  return typeof state?.name === "string" && state.name.trim().length > 0;
}

function validateProposal(proposal: DlpPolicyProposal): string[] {
  const errors: string[] = [];
  if (!isDlpPolicyAction(proposal.action)) {
    errors.push(`action must be one of: ${DLP_POLICY_ACTIONS.join(", ")}`);
    return errors;
  }
  if (proposal.action === "create") {
    if (!hasName(proposal.after)) {
      errors.push("after.name is required for create");
    }
  } else if (proposal.action === "delete") {
    if (!hasName(proposal.before)) {
      errors.push("before.name is required for delete");
    }
  } else {
    if (!hasName(proposal.before)) {
      errors.push(`before.name is required for ${proposal.action}`);
    }
    if (!hasName(proposal.after)) {
      errors.push(`after.name is required for ${proposal.action}`);
    }
  }
  return errors;
}

function impactReasons(action: DlpPolicyAction, before: DlpPolicyState | null | undefined): string[] {
  const name = before?.name ?? "";
  if (action === "disable") {
    return [`DLP policy '${name}' is disabled, weakening information protection`];
  }
  if (action === "delete") {
    return [`DLP policy '${name}' is deleted, removing an information-protection control`];
  }
  return [];
}

export function assessDlpPolicyChange(proposal: DlpPolicyProposal): DlpPolicyAssessment {
  const errors = validateProposal(proposal);
  if (errors.length > 0) {
    return {
      valid: false,
      complianceImpacting: false,
      requiresConfirmation: false,
      reasons: errors,
    };
  }

  const complianceImpacting = COMPLIANCE_IMPACTING_ACTIONS.has(proposal.action);
  return {
    valid: true,
    complianceImpacting,
    requiresConfirmation: complianceImpacting,
    ...(complianceImpacting ? { warning: DLP_COMPLIANCE_IMPACTING_WARNING } : {}),
    reasons: impactReasons(proposal.action, proposal.before),
  };
}

export interface DlpPolicyChangeGuardInput extends DlpPolicyProposal {
  readonly confirm: boolean;
}

// Classifies the change and throws a structured 400 when a compliance-impacting
// change was proposed without explicit confirmation. Returns the assessment so
// the route can carry the warning/requiresConfirmation onto the plan preview.
export function assertDlpPolicyChange(input: DlpPolicyChangeGuardInput): DlpPolicyAssessment {
  const assessment = assessDlpPolicyChange(input);
  if (assessment.requiresConfirmation && !input.confirm) {
    throw new AppError(
      DLP_COMPLIANCE_IMPACTING_CODE,
      "disabling or deleting a DLP policy is compliance-impacting and requires confirmation",
      400,
      [{ field: "confirm", reason: "required" }],
    );
  }
  return assessment;
}
