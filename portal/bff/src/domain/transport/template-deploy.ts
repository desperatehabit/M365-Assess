// Transport template deploy (EPIC-021 SPEC.md §2 US-2/US-4, §3.3, §4.2, §5,
// §6, §9; T-0406). Resolves a transport-rule or connector template's declared
// %name% variables (domains, IPs, action overrides) into the stored ruleJson /
// connectorJson, rejects a missing required variable before any target is
// touched, and produces the resolved payload with a per-target diff. The
// resolved payload is applied per target through the EPIC-006 gate (T-0107):
// one target's failure is reported per target and never aborts the rest, and
// every applied target yields an AuditEvent from the gate.
import { AppError } from "../../errors.js";

export type TransportTemplateKind = "transport-rule" | "connector";

export const TRANSPORT_TEMPLATE_DEPLOY_MISSING_VARIABLE = "transport_template.missing_variable";
export const TRANSPORT_TEMPLATE_DEPLOY_INVALID = "transport_template.invalid_payload";

export interface TransportTemplateVariable {
  readonly name: string;
  readonly defaultValue?: string;
}

export interface TransportTemplateDeployRequest {
  readonly kind: TransportTemplateKind;
  readonly templateId: string;
  readonly templateName: string;
  readonly payload: unknown;
  readonly declaredVariables: readonly TransportTemplateVariable[];
  readonly variables: Readonly<Record<string, string>>;
  readonly targets: readonly string[];
}

export interface TransportTemplateTargetPlan {
  readonly tenantId: string;
  readonly targetName: string;
  readonly diff: readonly string[];
}

export interface ResolvedTransportTemplateDeploy {
  readonly kind: TransportTemplateKind;
  readonly templateId: string;
  readonly templateName: string;
  readonly targetName: string;
  readonly payload: Record<string, unknown>;
  readonly resolvedVariables: Readonly<Record<string, string>>;
  readonly targets: readonly TransportTemplateTargetPlan[];
}

export interface TransportTemplateApplyRequest {
  readonly kind: TransportTemplateKind;
  readonly templateId: string;
  readonly tenantId: string;
  readonly name: string;
  readonly payload: Record<string, unknown>;
  readonly actor: string;
}

export interface TransportTemplateApplyOutcome {
  readonly before?: Record<string, unknown> | null;
  readonly after?: Record<string, unknown> | null;
  readonly auditEvent: Record<string, unknown>;
}

// The EPIC-006 gated apply boundary. The route never writes a tenant directly:
// every target goes through this seam, which captures before/after and returns
// the AuditEvent the route persists.
export interface TransportTemplateDeployExecutor {
  apply(request: TransportTemplateApplyRequest): Promise<TransportTemplateApplyOutcome>;
}

export interface TransportTemplateTargetResult {
  readonly tenantId: string;
  readonly success: boolean;
  readonly before?: Record<string, unknown> | null;
  readonly after?: Record<string, unknown> | null;
  readonly auditEvent?: Record<string, unknown>;
  readonly error?: string;
}

const TOKEN_PATTERN = /%([A-Za-z0-9_][A-Za-z0-9_.-]*)%/g;

function missingVariableError(name: string): AppError {
  return new AppError(
    TRANSPORT_TEMPLATE_DEPLOY_MISSING_VARIABLE,
    `required variable '%${name}%' was not supplied`,
    400,
    [{ field: `variables.${name}`, reason: "required" }],
  );
}

function invalidPayloadError(reason: string): AppError {
  return new AppError(TRANSPORT_TEMPLATE_DEPLOY_INVALID, reason, 400, [
    { field: "payload", reason: "invalid" },
  ]);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// Supplied values win over declared defaults; a declared variable with neither a
// supplied value nor a default is a required variable and fails here, before any
// target is touched.
function resolveVariables(
  declared: readonly TransportTemplateVariable[],
  supplied: Readonly<Record<string, string>>,
): Record<string, string> {
  const resolved: Record<string, string> = {};
  for (const variable of declared) {
    const provided = supplied[variable.name];
    if (provided !== undefined && provided !== "") {
      resolved[variable.name] = provided;
      continue;
    }
    const fallback = variable.defaultValue;
    if (fallback !== undefined && fallback !== "") {
      resolved[variable.name] = fallback;
      continue;
    }
    throw missingVariableError(variable.name);
  }
  for (const [name, value] of Object.entries(supplied)) {
    if (resolved[name] === undefined && value !== undefined && value !== "") {
      resolved[name] = value;
    }
  }
  return resolved;
}

function substitute(value: unknown, resolved: Record<string, string>): unknown {
  if (typeof value === "string") {
    TOKEN_PATTERN.lastIndex = 0;
    return value.replace(TOKEN_PATTERN, (_match, name: string) => {
      const replacement = resolved[name];
      if (replacement === undefined) throw missingVariableError(name);
      return replacement;
    });
  }
  if (Array.isArray(value)) return value.map((item) => substitute(item, resolved));
  if (isRecord(value)) {
    const next: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) {
      next[key] = substitute(item, resolved);
    }
    return next;
  }
  return value;
}

function labelFor(kind: TransportTemplateKind): string {
  return kind === "transport-rule" ? "transport rule" : "connector";
}

function buildTargetPlan(
  kind: TransportTemplateKind,
  targetName: string,
  tenantId: string,
  resolved: Record<string, string>,
): TransportTemplateTargetPlan {
  const diff: string[] = [
    `Deploy ${labelFor(kind)} '${targetName}' to tenant '${tenantId}'`,
  ];
  for (const [name, value] of Object.entries(resolved)) {
    diff.push(`Resolve %${name}% = ${value}`);
  }
  return { tenantId, targetName, diff };
}

/**
 * Resolves the deploy-supplied variables into the template's ruleJson /
 * connectorJson and returns the payload to apply plus a per-target plan. A
 * required variable that is missing (or a %name% token with no supplied value)
 * throws a 400 before any target is touched.
 */
export function resolveTransportTemplateDeploy(
  request: TransportTemplateDeployRequest,
): ResolvedTransportTemplateDeploy {
  const resolvedVariables = resolveVariables(request.declaredVariables, request.variables);
  const resolved = substitute(request.payload, resolvedVariables);
  if (!isRecord(resolved)) {
    throw invalidPayloadError("template payload must resolve to a JSON object");
  }
  const name =
    typeof resolved["name"] === "string" && resolved["name"].trim().length > 0
      ? resolved["name"].trim()
      : request.templateName;
  const targets = request.targets.map((tenantId) =>
    buildTargetPlan(request.kind, name, tenantId, resolvedVariables),
  );
  return {
    kind: request.kind,
    templateId: request.templateId,
    templateName: request.templateName,
    targetName: name,
    payload: resolved,
    resolvedVariables,
    targets,
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Applies the resolved payload to every target through the EPIC-006 gate. One
 * target's failure is captured in its own result and never aborts the rest.
 */
export async function runTransportTemplateDeploy(
  resolved: ResolvedTransportTemplateDeploy,
  executor: TransportTemplateDeployExecutor,
  actor: string,
): Promise<readonly TransportTemplateTargetResult[]> {
  const results: TransportTemplateTargetResult[] = [];
  for (const target of resolved.targets) {
    try {
      const outcome = await executor.apply({
        kind: resolved.kind,
        templateId: resolved.templateId,
        tenantId: target.tenantId,
        name: resolved.targetName,
        payload: resolved.payload,
        actor,
      });
      results.push({
        tenantId: target.tenantId,
        success: true,
        before: outcome.before ?? null,
        after: outcome.after ?? null,
        auditEvent: outcome.auditEvent,
      });
    } catch (error) {
      results.push({
        tenantId: target.tenantId,
        success: false,
        error: errorMessage(error),
      });
    }
  }
  return results;
}
