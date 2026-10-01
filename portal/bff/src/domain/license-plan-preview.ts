// Per-user licence assign/remove plan preview (EPIC-033 SPEC.md §3.4, §4.3, §9; T-0645).
//
// Pure, side-effect-free: given the per-user licence state read from the tenant,
// compute the before/after of an assign or a remove, and the plan hash the apply
// step echoes back as confirmation. Removal is the risky direction (SPEC §9: a
// user may depend on the licence being removed), so a plan that removes an
// assigned licence requires confirmation; an assign, or a row that changes
// nothing, does not. The BFF performs no tenant writes here — the worker
// (Update-UserLicense.ps1) owns the Graph call.
import { createHash } from "node:crypto";

export type LicenseChangeAction = "assign" | "remove";
export type LicensePlanChange = "assign" | "remove" | "unchanged";

export interface LicensePlanUserInput {
  readonly userId: string;
  readonly displayName?: string | null;
  readonly userPrincipalName?: string | null;
  /** Whether the SKU is currently assigned to the user. */
  readonly assigned: boolean;
}

export interface LicensePlanRow {
  readonly userId: string;
  readonly displayName: string | null;
  readonly userPrincipalName: string | null;
  readonly before: { readonly assigned: boolean };
  readonly after: { readonly assigned: boolean };
  readonly change: LicensePlanChange;
}

export interface LicensePlanPreview {
  readonly tenantId: string;
  readonly skuId: string;
  readonly action: LicenseChangeAction;
  readonly rows: readonly LicensePlanRow[];
  /** True when at least one row removes an assigned licence (SPEC §9). */
  readonly requiresConfirmation: boolean;
  /** Stable hash over the preview; apply echoes it back as `confirmPlan`. */
  readonly planHash: string;
}

export interface ComputeLicensePlanPreviewInput {
  readonly tenantId: string;
  readonly skuId: string;
  readonly action: LicenseChangeAction;
  readonly users: readonly LicensePlanUserInput[];
}

export function isLicenseChangeAction(value: unknown): value is LicenseChangeAction {
  return value === "assign" || value === "remove";
}

function toNullableString(value: string | null | undefined): string | null {
  return value === undefined || value === null || value.length === 0 ? null : value;
}

function computeRow(user: LicensePlanUserInput, action: LicenseChangeAction): LicensePlanRow {
  const before = user.assigned === true;
  const after = action === "assign" ? true : false;
  let change: LicensePlanChange = "unchanged";
  if (before !== after) change = action;
  return {
    userId: user.userId,
    displayName: toNullableString(user.displayName),
    userPrincipalName: toNullableString(user.userPrincipalName),
    before: { assigned: before },
    after: { assigned: after },
    change,
  };
}

/** Stable hash over the tenant, SKU, action, and every row's before/after. */
export function licensePlanHash(
  tenantId: string,
  skuId: string,
  action: LicenseChangeAction,
  rows: readonly LicensePlanRow[],
): string {
  const canonical = JSON.stringify({
    tenantId,
    skuId,
    action,
    rows: rows.map((row) => [row.userId, row.before.assigned, row.after.assigned]),
  });
  return createHash("sha256").update(canonical).digest("hex");
}

/**
 * Computes the assign/remove plan preview. A remove row whose licence is
 * already absent is `unchanged`; only a remove that would actually strip an
 * assigned licence sets `requiresConfirmation` (SPEC §9).
 */
export function computeLicensePlanPreview(
  input: ComputeLicensePlanPreviewInput,
): LicensePlanPreview {
  const rows = input.users.map((user) => computeRow(user, input.action));
  const requiresConfirmation =
    input.action === "remove" && rows.some((row) => row.change === "remove");
  return {
    tenantId: input.tenantId,
    skuId: input.skuId,
    action: input.action,
    rows,
    requiresConfirmation,
    planHash: licensePlanHash(input.tenantId, input.skuId, input.action, rows),
  };
}
