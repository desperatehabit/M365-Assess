// Typed licensing API client (EPIC-033 SPEC.md §3.1, §3.3, §6; T-0647).
// Wraps the T-0642 consumption report and the T-0644 pricing GET/PUT behind
// small typed functions. A `fetcher` seam keeps the client testable without a
// live BFF.

export type Fetcher = typeof fetch;

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
