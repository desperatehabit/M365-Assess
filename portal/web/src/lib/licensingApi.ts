// Typed licensing API client (EPIC-033 SPEC.md §3.1-§3.5, §6; T-0647, T-0648).
// Wraps consumption, pricing, optimization, gates, and assign/remove actions
// behind small typed functions. A `fetcher` seam keeps the client testable without a live BFF.

export type Fetcher = typeof fetch;

function asFetcher(fetcher?: Fetcher): Fetcher {
  return fetcher ?? fetch;
}

async function expectOk(response: Response, what: string): Promise<unknown> {
  if (!response.ok) {
    let detail = response.statusText;
    try {
      const body = (await response.json()) as { message?: string };
      if (body?.message) detail = body.message;
    } catch {
      // non-JSON error body; keep the status text
    }
    throw new Error(`${what} failed: ${response.status} ${detail}`);
  }
  return response.json();
}

// ─── Consumption & Pricing (T-0647) ──────────────────────────────────────────

export interface LicenseItem {
  readonly skuId: string;
  readonly skuPartNumber: string;
  readonly license: string;
  readonly enabled: number;
  readonly assigned: number;
  readonly available: number;
  readonly suspended: number;
  readonly warning: number;
  readonly utilizationPct: number;
  readonly monthlyCost: string | number;
  readonly currency: string;
}

export interface LicensesReport {
  readonly tenantId: string;
  readonly items: readonly LicenseItem[];
}

export interface LicensePricing {
  readonly skuId: string;
  readonly tenantId: string | null;
  readonly skuPartNumber: string | null;
  readonly unitPrice: number;
  readonly currency: string;
  readonly updatedAt: string;
}

export interface LicensePricingInput {
  readonly skuId: string;
  readonly skuPartNumber?: string;
  readonly unitPrice: number;
  readonly currency: string;
  readonly tenantId?: string;
}

// Pricing edits require the CIPP.Admin.* scope (SPEC §7); the page gates on it.
export const LICENSE_PRICING_ADMIN_SCOPE = "CIPP.Admin.*";

export const LICENSES_PATH = "/v1/tenants";
export const LICENSE_PRICING_PATH = "/v1/license-pricing";

export function licensesPath(tenantId: string): string {
  return `${LICENSES_PATH}/${encodeURIComponent(tenantId)}/licenses`;
}

export function licensePricingPath(tenantId?: string): string {
  const query = tenantId && tenantId.trim().length > 0 ? `?tenantId=${encodeURIComponent(tenantId)}` : "";
  return `${LICENSE_PRICING_PATH}${query}`;
}

/** T-0642: per-SKU consumption with utilization and effective monthly cost. */
export async function getLicenseReport(
  tenantId: string,
  fetcher?: Fetcher,
): Promise<LicensesReport> {
  const response = await asFetcher(fetcher)(licensesPath(tenantId));
  const body = (await expectOk(response, "Load licence report")) as {
    tenantId?: string;
    items?: LicenseItem[];
  };
  return { tenantId: body.tenantId ?? tenantId, items: body.items ?? [] };
}

/** T-0644: effective pricing — the tenant override when one exists, else the global row. */
export async function listLicensePricing(
  tenantId?: string,
  fetcher?: Fetcher,
): Promise<LicensePricing[]> {
  const response = await asFetcher(fetcher)(licensePricingPath(tenantId));
  const body = (await expectOk(response, "Load licence pricing")) as {
    pricing?: LicensePricing[];
  };
  return body.pricing ?? [];
}

/** T-0644: upsert a global seed price or a per-tenant override (admin only). */
export async function saveLicensePricing(
  input: LicensePricingInput,
  fetcher?: Fetcher,
): Promise<LicensePricing> {
  const response = await asFetcher(fetcher)(LICENSE_PRICING_PATH, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
  const body = (await expectOk(response, "Save licence pricing")) as {
    pricing?: LicensePricing;
  };
  if (!body.pricing) throw new Error("Save licence pricing failed: empty response");
  return body.pricing;
}

/** A SKU with no effective pricing is reported as "no pricing", never a zero (SPEC §9). */
export function isUnpriced(monthlyCost: string | number): boolean {
  return typeof monthlyCost !== "number" || !Number.isFinite(monthlyCost);
}

export function formatMonthlyCost(monthlyCost: string | number, currency: string): string {
  if (isUnpriced(monthlyCost)) return "no pricing";
  return `${currency} ${(monthlyCost as number).toFixed(2)}`;
}

// ─── Optimization (T-0643) ───────────────────────────────────────────────────

export interface LicenseActivityUser {
  readonly userId: string;
  readonly userPrincipalName: string;
  readonly displayName: string;
  readonly lastActivityDate: string | null;
}

export interface UnusedLicenseRow {
  readonly skuId: string;
  readonly skuPartNumber: string;
  readonly affectedUsers: readonly LicenseActivityUser[];
}

export interface OverusedLicenseRow {
  readonly skuId: string;
  readonly skuPartNumber: string;
  readonly error: string;
  readonly affectedUsers: readonly LicenseActivityUser[];
}

export interface ExpiringLicenseRow {
  readonly skuId: string;
  readonly skuPartNumber: string;
  readonly expirationDateTime: string;
  readonly daysRemaining: number;
  readonly affectedUsers: readonly LicenseActivityUser[];
}

export interface LicenseOptimizationResult {
  readonly tenantId: string;
  readonly generatedAt: string;
  readonly inactivityDays: number;
  /** Always true: the optimization view only advises, it never removes a licence. */
  readonly advisory: true;
  readonly unused: readonly UnusedLicenseRow[];
  readonly overused: readonly OverusedLicenseRow[];
  readonly expiring: readonly ExpiringLicenseRow[];
}

export async function getLicenseOptimization(
  tenantId: string,
  inactivityDays?: number,
  fetcher?: Fetcher,
): Promise<LicenseOptimizationResult> {
  const query = inactivityDays === undefined ? "" : `?inactivityDays=${encodeURIComponent(String(inactivityDays))}`;
  const response = await asFetcher(fetcher)(
    `/v1/tenants/${encodeURIComponent(tenantId)}/licenses/optimization${query}`,
  );
  return (await expectOk(response, "Loading licence optimization")) as LicenseOptimizationResult;
}

// ─── Gates (T-0646) ──────────────────────────────────────────────────────────

export type LicenseGateStatus = "available" | "gated";

export interface LicenseGateFeature {
  readonly status: LicenseGateStatus;
  readonly requiredPlans: readonly string[];
  readonly missingPlans: readonly string[];
}

export interface LicenseGatesResponse {
  readonly tenantId: string;
  readonly gates: Readonly<Record<string, LicenseGateFeature>>;
}

export async function getLicenseGates(
  tenantId: string,
  fetcher?: Fetcher,
): Promise<LicenseGatesResponse> {
  const response = await asFetcher(fetcher)(
    `/v1/tenants/${encodeURIComponent(tenantId)}/licenses/gates`,
  );
  return (await expectOk(response, "Loading licence gates")) as LicenseGatesResponse;
}

// ─── Assign / remove (T-0645) ────────────────────────────────────────────────

export type LicenseChangeAction = "assign" | "remove";
export type LicensePlanChange = "assign" | "remove" | "unchanged";
export type LicenseChangeRowState = "applied" | "planned" | "failed" | "skipped";

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
  readonly dryRun: true;
  readonly applied: false;
  readonly requiresConfirmation: boolean;
  readonly planHash: string | null;
  readonly rows: readonly LicensePlanRow[];
}

export interface LicenseChangeRowResult {
  readonly userId: string;
  readonly skuId: string;
  readonly action: LicenseChangeAction;
  readonly state: LicenseChangeRowState;
  readonly before: Record<string, unknown> | null;
  readonly after: Record<string, unknown> | null;
  readonly error: string | null;
}

export interface LicenseChangeOutcome {
  readonly tenantId: string;
  readonly skuId: string;
  readonly action: LicenseChangeAction;
  readonly dryRun: boolean;
  readonly applied: boolean;
  readonly requiresConfirmation: boolean;
  readonly planHash: string | null;
  readonly stoppedOnFailure: boolean;
  readonly rows: readonly LicenseChangeRowResult[];
  readonly summary?: Readonly<Record<string, number>>;
  readonly replayed?: boolean;
}

export interface LicenseChangePreviewInput {
  readonly tenantId: string;
  readonly skuId: string;
  readonly action: LicenseChangeAction;
  readonly userIds: readonly string[];
  readonly idempotencyKey: string;
}

export interface LicenseChangeApplyInput extends LicenseChangePreviewInput {
  readonly confirm: boolean;
  readonly confirmPlan?: string | null;
  readonly continueOnFailure?: boolean;
  readonly reason?: string | null;
}

interface LicenseChangeBody {
  readonly skuId: string;
  readonly userIds: readonly string[];
  readonly dryRun: boolean;
  readonly confirm?: boolean;
  readonly confirmPlan?: string | null;
  readonly continueOnFailure?: boolean;
  readonly reason?: string | null;
}

async function postLicenseChange(
  path: string,
  input: LicenseChangePreviewInput,
  body: LicenseChangeBody,
  fetcher?: Fetcher,
): Promise<unknown> {
  const response = await asFetcher(fetcher)(path, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Idempotency-Key": input.idempotencyKey,
    },
    body: JSON.stringify(body),
  });
  return expectOk(response, "Changing licences");
}

function changePath(action: LicenseChangeAction, tenantId: string): string {
  const segment = action === "assign" ? "assign" : "remove";
  return `/v1/tenants/${encodeURIComponent(tenantId)}/licenses/${segment}`;
}

/** Dry run: computes and returns the before/after plan preview without writing. */
export async function previewLicenseChange(
  input: LicenseChangePreviewInput,
  fetcher?: Fetcher,
): Promise<LicensePlanPreview> {
  const result = await postLicenseChange(
    changePath(input.action, input.tenantId),
    input,
    { skuId: input.skuId, userIds: input.userIds, dryRun: true },
    fetcher,
  );
  return result as LicensePlanPreview;
}

/** Applies the change; a removal must echo the preview's `planHash` as `confirmPlan`. */
export async function applyLicenseChange(
  input: LicenseChangeApplyInput,
  fetcher?: Fetcher,
): Promise<LicenseChangeOutcome> {
  const result = await postLicenseChange(
    changePath(input.action, input.tenantId),
    input,
    {
      skuId: input.skuId,
      userIds: input.userIds,
      dryRun: false,
      confirm: input.confirm,
      confirmPlan: input.confirmPlan ?? null,
      continueOnFailure: input.continueOnFailure ?? false,
      reason: input.reason ?? null,
    },
    fetcher,
  );
  return result as LicenseChangeOutcome;
}
