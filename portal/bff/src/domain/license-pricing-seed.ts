// License pricing seed (EPIC-033 SPEC §3.3, §11.2; T-0644).
//
// The committed CSV holds the global default price per SKU: one row per SKU,
// no tenant. Seeding is insert-only — a SKU that already has a global row
// keeps it, so bootstrap never clobbers an operator edit, and per-tenant
// overrides are never touched. Seeded rows carry no tenantId; the repository
// stores them with tenantId NULL, which every read resolves as the global
// fallback behind any per-tenant override.
import type { LicensingRepository } from "@m365-assess/db";

export const LICENSE_PRICING_SEED_CSV = `skuId,skuPartNumber,unitPrice,currency
ENTERPRISEPREMIUM,ENTERPRISEPREMIUM,36.00,USD
SPE_E5,SPE_E5,57.00,USD
AAD_PREMIUM,AAD_PREMIUM,6.00,USD
AAD_PREMIUM_P2,AAD_PREMIUM_P2,9.00,USD
EXCHANGEENTERPRISE,EXCHANGEENTERPRISE,8.00,USD
SHAREPOINTENTERPRISE,SHAREPOINTENTERPRISE,10.00,USD`;

const SEED_COLUMNS = ["skuId", "skuPartNumber", "unitPrice", "currency"] as const;

export interface LicensePricingSeedRow {
  readonly skuId: string;
  readonly skuPartNumber: string | null;
  readonly unitPrice: number;
  readonly currency: string;
}

export interface LicensePricingSeedSummary {
  readonly inserted: readonly string[];
  readonly skipped: readonly string[];
}

export function parseLicensePricingSeedCsv(csv: string): LicensePricingSeedRow[] {
  const lines = csv.split(/\r?\n/).filter((line) => line.trim().length > 0);
  if (lines.length === 0) return [];
  const header = lines[0]!.split(",").map((cell) => cell.trim());
  const columnIndexes = new Map<string, number>();
  header.forEach((name, index) => columnIndexes.set(name, index));
  const skuIdIndex = columnIndexes.get("skuId");
  const skuPartNumberIndex = columnIndexes.get("skuPartNumber");
  const unitPriceIndex = columnIndexes.get("unitPrice");
  const currencyIndex = columnIndexes.get("currency");
  if (
    skuIdIndex === undefined ||
    skuPartNumberIndex === undefined ||
    unitPriceIndex === undefined ||
    currencyIndex === undefined
  ) {
    throw new Error(`license pricing seed CSV must contain columns: ${SEED_COLUMNS.join(", ")}`);
  }
  const rows: LicensePricingSeedRow[] = [];
  for (const line of lines.slice(1)) {
    const cells = line.split(",");
    const skuId = (cells[skuIdIndex] ?? "").trim();
    if (skuId.length === 0) continue;
    const unitPrice = Number((cells[unitPriceIndex] ?? "").trim());
    if (!Number.isFinite(unitPrice) || unitPrice < 0) {
      throw new Error(`license pricing seed CSV has an invalid unitPrice for SKU '${skuId}'`);
    }
    rows.push({
      skuId,
      skuPartNumber: (cells[skuPartNumberIndex] ?? "").trim() || null,
      unitPrice,
      currency: (cells[currencyIndex] ?? "").trim().toUpperCase(),
    });
  }
  return rows;
}

export async function seedLicensePricing(
  repository: Pick<LicensingRepository, "listLicensePricing" | "upsertLicensePricing">,
  csv: string = LICENSE_PRICING_SEED_CSV,
): Promise<LicensePricingSeedSummary> {
  const existing = await repository.listLicensePricing();
  const seededSkus = new Set(existing.map((pricing) => pricing.skuId));
  const inserted: string[] = [];
  const skipped: string[] = [];
  for (const row of parseLicensePricingSeedCsv(csv)) {
    if (seededSkus.has(row.skuId)) {
      skipped.push(row.skuId);
      continue;
    }
    await repository.upsertLicensePricing({
      skuId: row.skuId,
      skuPartNumber: row.skuPartNumber,
      unitPrice: row.unitPrice,
      currency: row.currency,
      tenantId: null,
    });
    inserted.push(row.skuId);
  }
  return { inserted, skipped };
}
