import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { openSqliteLicensingRepository, openSqliteRepository } from "@m365-assess/db";
import {
  LICENSE_PRICING_SEED_CSV,
  parseLicensePricingSeedCsv,
  seedLicensePricing,
} from "./license-pricing-seed.js";

const TENANT_A = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const SKU_1 = "ENTERPRISEPREMIUM";
const SKU_2 = "SPE_E5";

const tempDirs: string[] = [];

function tempDbPath(): string {
  const dir = mkdtempSync(join(tmpdir(), "m365-license-pricing-seed-"));
  tempDirs.push(dir);
  return join(dir, "portal.db");
}

afterEach(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
  tempDirs.length = 0;
});

async function seedTenant(filename: string, tenantId: string): Promise<void> {
  const repo = await openSqliteRepository({ filename });
  await repo.upsertTenant({
    id: tenantId,
    displayName: null,
    defaultDomain: null,
    initialDomain: null,
    source: "direct",
    status: "active",
    excluded: false,
    lastRunAt: null,
    errorCount: 0,
  });
  repo.close();
}

describe("parseLicensePricingSeedCsv", () => {
  it("parses the committed seed CSV into global rows", () => {
    const rows = parseLicensePricingSeedCsv(LICENSE_PRICING_SEED_CSV);
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.map((row) => row.skuId)).toContain(SKU_1);
    const e3 = rows.find((row) => row.skuId === SKU_1);
    expect(e3).toMatchObject({ skuPartNumber: SKU_1, unitPrice: 36, currency: "USD" });
    expect(rows.every((row) => row.unitPrice > 0)).toBe(true);
  });

  it("reads columns by header name so order does not matter", () => {
    const rows = parseLicensePricingSeedCsv("currency,skuId,unitPrice,skuPartNumber\nUSD,SKU_X,12.5,SKU_X");
    expect(rows).toEqual([{ skuId: "SKU_X", skuPartNumber: "SKU_X", unitPrice: 12.5, currency: "USD" }]);
  });

  it("rejects a CSV missing a required column", () => {
    expect(() => parseLicensePricingSeedCsv("skuId,unitPrice\nSKU_X,12.5")).toThrow(/must contain columns/);
  });

  it("rejects a CSV with a non-numeric price", () => {
    expect(() =>
      parseLicensePricingSeedCsv("skuId,skuPartNumber,unitPrice,currency\nSKU_X,SKU_X,free,USD"),
    ).toThrow(/invalid unitPrice/);
  });
});

describe("seedLicensePricing", () => {
  it("populates global defaults once and reports what it inserted", async () => {
    const repo = await openSqliteLicensingRepository({ filename: tempDbPath() });
    const summary = await seedLicensePricing(repo);
    expect(summary.inserted.length).toBeGreaterThan(0);
    expect(summary.skipped).toEqual([]);

    const global = await repo.listLicensePricing();
    expect(global).toHaveLength(summary.inserted.length);
    expect(global.every((pricing) => pricing.tenantId === null)).toBe(true);
    expect(global.find((pricing) => pricing.skuId === SKU_1)?.unitPrice).toBe(36);
    repo.close();
  });

  it("does not clobber an operator edit of a global row", async () => {
    const repo = await openSqliteLicensingRepository({ filename: tempDbPath() });
    await repo.upsertLicensePricing({ skuId: SKU_1, unitPrice: 41, currency: "EUR" });

    const summary = await seedLicensePricing(repo);
    expect(summary.skipped).toContain(SKU_1);
    expect(summary.inserted).not.toContain(SKU_1);

    const edited = await repo.getLicensePricing(TENANT_A, SKU_1);
    expect(edited?.unitPrice).toBe(41);
    expect(edited?.currency).toBe("EUR");
    expect(edited?.tenantId).toBeNull();
    repo.close();
  });

  it("leaves per-tenant overrides untouched and still seeds the global row", async () => {
    const filename = tempDbPath();
    await seedTenant(filename, TENANT_A);
    const repo = await openSqliteLicensingRepository({ filename });
    await repo.upsertLicensePricing({ skuId: SKU_1, unitPrice: 30, currency: "USD", tenantId: TENANT_A });

    const summary = await seedLicensePricing(repo);
    expect(summary.inserted).toContain(SKU_1);

    const override = await repo.getLicensePricing(TENANT_A, SKU_1);
    expect(override?.unitPrice).toBe(30);
    expect(override?.tenantId).toBe(TENANT_A);
    const global = await repo.listLicensePricing();
    expect(global.find((pricing) => pricing.skuId === SKU_1)?.unitPrice).toBe(36);
    repo.close();
  });

  it("is idempotent: a second run inserts nothing and changes no rows", async () => {
    const repo = await openSqliteLicensingRepository({ filename: tempDbPath() });
    const first = await seedLicensePricing(repo);
    const second = await seedLicensePricing(repo);
    expect(second.inserted).toEqual([]);
    expect(second.skipped).toHaveLength(first.inserted.length);

    const global = await repo.listLicensePricing();
    expect(global).toHaveLength(first.inserted.length);
    expect(global.find((pricing) => pricing.skuId === SKU_2)?.unitPrice).toBe(57);
    repo.close();
  });
});
