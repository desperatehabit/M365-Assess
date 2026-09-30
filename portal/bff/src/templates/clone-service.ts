// Clone service (EPIC-039 SPEC.md §3.3, §4.1, §6, §8; T-0765).
//
// Resolves a library item's type to the owning epic's deploy-plan builder and
// produces a read-only plan: the target tenants, one action per target, and the
// diff the target flow will show. Nothing here writes to a tenant — apply is
// deferred to the target epic's deploy flow, which owns the EPIC-006
// plan/permission boundary (T-0101). Clone itself is gated on `templates.clone`
// and is tenant-scoped (EPIC-038); that gate lives in ./clone-routes.
import type { TemplateLibraryItem, TemplateRepository } from "@m365-assess/db";

/**
 * The deploy flow a template type clones through, owned by the target epic.
 * `path` is the deploy endpoint the drawer routes confirmation to; `:id` is the
 * library item / template id.
 */
export interface CloneDeployFlow {
  readonly id: string;
  readonly epic: string;
  readonly label: string;
  readonly method: "POST";
  readonly path: string;
}

/** One target tenant's planned deploy, produced without writing. */
export interface ClonePlanAction {
  readonly tenantId: string;
  readonly action: "deploy";
  readonly templateId: string;
  readonly flowId: string;
  readonly epic: string;
  readonly deployPath: string;
  readonly description: string;
  readonly diff: readonly string[];
}

export interface ClonePlan {
  readonly itemId: string;
  readonly itemType: string;
  readonly itemName: string;
  readonly itemSource: string;
  readonly flow: CloneDeployFlow;
  readonly targets: readonly string[];
  readonly actions: readonly ClonePlanAction[];
  readonly diff: readonly string[];
  readonly valid: boolean;
  readonly dryRun: true;
}

/** Resolves a library item's type to its owning epic's deploy-plan builder. */
export interface CloneDeployPlanBuilder {
  readonly flow: CloneDeployFlow;
  plan(item: TemplateLibraryItem, tenantId: string): ClonePlanAction;
}

export type ClonePlanBuilders = Readonly<Record<string, CloneDeployPlanBuilder>>;

export interface CloneService {
  planClone(itemId: string, targets: readonly string[]): Promise<ClonePlan>;
}

export class TemplateLibraryItemNotFoundError extends Error {
  readonly code = "template_library.not_found";

  constructor(itemId: string) {
    super(`template library item ${itemId} was not found`);
    this.name = "TemplateLibraryItemNotFoundError";
  }
}

export class UnsupportedCloneTypeError extends Error {
  readonly code = "template_library.clone_unsupported";
  readonly type: string;

  constructor(type: string) {
    super(`no deploy flow is registered for template type ${type}`);
    this.name = "UnsupportedCloneTypeError";
    this.type = type;
  }
}

// ---- Owning-epic deploy flows (SPEC §3.3, §9) ------------------------------
// CA is EPIC-015 and Intune is EPIC-016 (T-0285, T-0301); the remaining types
// reuse their epic's existing deploy/apply endpoint. `policy` has no owning
// deploy flow yet, so it is intentionally absent and resolves as unsupported.

export const CA_TEMPLATE_DEPLOY_FLOW: CloneDeployFlow = Object.freeze({
  id: "ca-template-deploy",
  epic: "EPIC-015",
  label: "Conditional Access deploy drawer",
  method: "POST",
  path: "/v1/ca-templates/:id/deploy",
});

export const INTUNE_TEMPLATE_DEPLOY_FLOW: CloneDeployFlow = Object.freeze({
  id: "intune-template-deploy",
  epic: "EPIC-016",
  label: "Intune policy deploy drawer",
  method: "POST",
  path: "/v1/intune-templates/:id/deploy",
});

export const STANDARDS_TEMPLATE_FLOW: CloneDeployFlow = Object.freeze({
  id: "standards-template",
  epic: "EPIC-008",
  label: "Standards template flow",
  method: "POST",
  path: "/v1/standards/templates/:templateId/clone",
});

export const GROUP_TEMPLATE_DEPLOY_FLOW: CloneDeployFlow = Object.freeze({
  id: "group-template-deploy",
  epic: "EPIC-014",
  label: "Group deploy flow",
  method: "POST",
  path: "/v1/group-templates/:id/deploy",
});

export const BASELINE_ROLLOUT_FLOW: CloneDeployFlow = Object.freeze({
  id: "baseline-rollout",
  epic: "EPIC-010",
  label: "Baseline rollout",
  method: "POST",
  path: "/v1/baselines/:id/stages/:order/advance",
});

export const PIM_SETTINGS_APPLY_FLOW: CloneDeployFlow = Object.freeze({
  id: "pim-settings-apply",
  epic: "EPIC-013",
  label: "PIM settings apply",
  method: "POST",
  path: "/v1/pim-settings-templates/:id/apply",
});

export const REPORT_TEMPLATE_FLOW: CloneDeployFlow = Object.freeze({
  id: "report-template-generate",
  epic: "EPIC-005",
  label: "Report builder flow",
  method: "POST",
  path: "/v1/report-templates/:templateId/generate",
});

export const CUSTOM_TEST_RUN_FLOW: CloneDeployFlow = Object.freeze({
  id: "custom-test-run",
  epic: "EPIC-036",
  label: "Custom test run",
  method: "POST",
  path: "/v1/custom-tests/:id/run",
});

// ---- Default plan builders -------------------------------------------------

function parseBody(body: string): Record<string, unknown> | undefined {
  try {
    const parsed: unknown = JSON.parse(body);
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

function readString(record: Record<string, unknown> | undefined, key: string): string | undefined {
  const value = record?.[key];
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function buildDiff(
  item: TemplateLibraryItem,
  tenantId: string,
  flow: CloneDeployFlow,
): string[] {
  const parsed = parseBody(item.body);
  const name = readString(parsed, "displayName") ?? readString(parsed, "name") ?? item.name;
  const diff = [`+ ${flow.label} → ${tenantId}: "${name}"`];
  if (flow.id === CA_TEMPLATE_DEPLOY_FLOW.id) {
    diff.push(
      `~ state: ${readString(parsed, "state") ?? "enabledForReportingButNotEnforced"} (report-only recommended)`,
    );
  }
  return diff;
}

export function createDeployPlanBuilder(flow: CloneDeployFlow): CloneDeployPlanBuilder {
  return {
    flow,
    plan(item, tenantId) {
      return {
        tenantId,
        action: "deploy",
        templateId: item.id,
        flowId: flow.id,
        epic: flow.epic,
        deployPath: flow.path,
        description: `${flow.label} → ${tenantId}`,
        diff: buildDiff(item, tenantId, flow),
      };
    },
  };
}

/** §9 type registry → owning epic's deploy flow. */
export const DEFAULT_CLONE_PLAN_BUILDERS: ClonePlanBuilders = Object.freeze({
  "conditional-access": createDeployPlanBuilder(CA_TEMPLATE_DEPLOY_FLOW),
  "intune-configuration": createDeployPlanBuilder(INTUNE_TEMPLATE_DEPLOY_FLOW),
  "intune-compliance": createDeployPlanBuilder(INTUNE_TEMPLATE_DEPLOY_FLOW),
  "intune-protection": createDeployPlanBuilder(INTUNE_TEMPLATE_DEPLOY_FLOW),
  "intune-policy": createDeployPlanBuilder(INTUNE_TEMPLATE_DEPLOY_FLOW),
  standards: createDeployPlanBuilder(STANDARDS_TEMPLATE_FLOW),
  baseline: createDeployPlanBuilder(BASELINE_ROLLOUT_FLOW),
  group: createDeployPlanBuilder(GROUP_TEMPLATE_DEPLOY_FLOW),
  "pim-role-settings": createDeployPlanBuilder(PIM_SETTINGS_APPLY_FLOW),
  "report-builder": createDeployPlanBuilder(REPORT_TEMPLATE_FLOW),
  "custom-test": createDeployPlanBuilder(CUSTOM_TEST_RUN_FLOW),
});

export class TemplateLibraryCloneService implements CloneService {
  constructor(
    private readonly repository: TemplateRepository,
    private readonly builders: ClonePlanBuilders = DEFAULT_CLONE_PLAN_BUILDERS,
  ) {}

  async planClone(itemId: string, targets: readonly string[]): Promise<ClonePlan> {
    const item = await this.repository.getTemplateLibraryItem(itemId);
    if (!item) {
      throw new TemplateLibraryItemNotFoundError(itemId);
    }
    const builder = this.builders[item.type];
    if (!builder) {
      throw new UnsupportedCloneTypeError(item.type);
    }
    const uniqueTargets = [...new Set(targets.map((target) => target.trim()).filter(Boolean))];
    const actions = uniqueTargets.map((tenantId) => builder.plan(item, tenantId));
    return {
      itemId: item.id,
      itemType: item.type,
      itemName: item.name,
      itemSource: item.source,
      flow: builder.flow,
      targets: uniqueTargets,
      actions,
      diff: actions.flatMap((action) => action.diff),
      valid: uniqueTargets.length > 0,
      dryRun: true,
    };
  }
}
