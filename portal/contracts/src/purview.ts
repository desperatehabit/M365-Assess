// Purview compliance contracts (EPIC-030 SPEC.md §5, §11.3). Policies are read
// live from Purview/Graph/EXO; only templates and policy-change history persist.
// A ComplianceTemplate is area-typed and carries a JSON payload plus deploy-time
// variables; `source` is `local` only in v1 (the community catalog is deferred
// to EPIC-039). Templates soft-delete; CompliancePolicyChange is append-only.
// Types only — no HTTP or storage behavior lives in this module.

export const PURVIEW_AREAS = ["dlp", "retention", "label", "sit", "safelinks"] as const;

export type PurviewArea = (typeof PURVIEW_AREAS)[number];

export const COMPLIANCE_TEMPLATE_SOURCES = ["local"] as const;

export type ComplianceTemplateSource = (typeof COMPLIANCE_TEMPLATE_SOURCES)[number];

export interface ComplianceTemplate {
  id: string;
  name: string;
  area: PurviewArea;
  payload: Record<string, unknown>;
  variables: Record<string, unknown>;
  source: ComplianceTemplateSource;
}

// Storage metadata: templates soft-delete so audit and history survive (§5).
export interface ComplianceTemplateRecord extends ComplianceTemplate {
  createdAt: string;
  updatedAt: string;
  deletedAt: string | null;
}

export interface CompliancePolicyChange {
  id: string;
  tenantId: string;
  area: PurviewArea;
  policyId: string;
  at: string;
  by: string;
  before: Record<string, unknown> | null;
  after: Record<string, unknown> | null;
}

export function isPurviewArea(value: unknown): value is PurviewArea {
  return typeof value === "string" && (PURVIEW_AREAS as readonly string[]).includes(value);
}

export function isComplianceTemplateSource(
  value: unknown,
): value is ComplianceTemplateSource {
  return (
    typeof value === "string" &&
    (COMPLIANCE_TEMPLATE_SOURCES as readonly string[]).includes(value)
  );
}
