import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import {
  openSqliteLicensingRepository,
  type SqliteLicensingRepository,
} from "./licensing-repository.js";
import type { LicenseChangeInput, LicensePricingInput } from "./repository.js";
import { loadMigrations, openSqliteRepository } from "./sqlite-repository.js";

const TENANT_A = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const TENANT_B = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";
const SKU_1 = "sku-1";
const USER_1 = "user-1";
const USER_2 = "user-2";

const tempDirs: string[] = [];

function tempDbPath(): string {
  const dir = mkdtempSync(join(tmpdir(), "m365-licensing-"));
  tempDirs.push(dir);
  return join(dir, "portal.db");
}

afterEach(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
  tempDirs.length = 0;
});

function columns(filename: string, table: string): string[] {
  const raw = new Database(filename);
  try {
    return (
      raw.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>
    ).map((row) => row.name);
  } finally {
    raw.close();
  }
}

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

function pricing(extra: Partial<LicensePricingInput> = {}): LicensePricingInput {
  return {
    skuId: SKU_1,
    tenantId: null,
    skuPartNumber: "PART-1",
    unitPrice: 8,
    currency: "USD",
    ...extra,
  };
}

function change(id: string, tenantId: string, extra: Partial<LicenseChangeInput> = {}): LicenseChangeInput {
  return {
    id,
    tenantId,
    userId: USER_1,
    skuId: SKU_1,
    action: "assign",
    state: "applied",
    by: "operator-1",
    at: "2026-06-01T00:00:00.000Z",
    ...extra,
  };
}

describe("migration 0056", () => {
  it("creates the SPEC §5 columns, is re-runnable, and advances SchemaVersion", async () => {
    const filename = tempDbPath();
    const expected = loadMigrations().reduce((max, migration) => Math.max(max, migration.version), 0);
    expect(expected).toBeGreaterThanOrEqual(56);

    const first = await openSqliteLicensingRepository({ filename });
    expect(first.schemaVersion).toBe(expected);
    first.close();

    expect(columns(filename, "license_pricing")).toEqual(
      expect.arrayContaining([
        "skuId",
        "tenantId",
        "skuPartNumber",
        "unitPrice",
        "currency",
        "updatedAt",
      ]),
    );
    expect(columns(filename, "license_changes")).toEqual(
      expect.arrayContaining([
        "id",
        "tenantId",
        "userId",
        "skuId",
        "action",
        "state",
        "by",
        "at",
      ]),
    );

    const second = await openSqliteLicensingRepository({ filename });
    expect(second.schemaVersion).toBe(expected);
    second.close();

    const raw = new Database(filename);
    try {
      expect(
        raw.prepare("SELECT COUNT(*) AS c FROM schema_versions WHERE version = 56").get(),
      ).toMatchObject({ c: 1 });
    } finally {
      raw.close();
    }
  });
});

describe("repository surface", () => {
  it("exposes pricing read/upsert and change append/get/list with no update/delete mutator", async () => {
    const repo = await openSqliteLicensingRepository({ filename: tempDbPath() });
    for (const method of [
      "getLicensePricing",
      "listLicensePricing",
      "upsertLicensePricing",
      "appendLicenseChange",
      "getLicenseChange",
      "listLicenseChanges",
    ]) {
      expect(typeof (repo as unknown as Record<string, unknown>)[method]).toBe("function");
    }
    for (const method of ["updateLicenseChange", "deleteLicenseChange", "deleteLicensePricing"]) {
      expect((repo as unknown as Record<string, unknown>)[method]).toBeUndefined();
    }
    repo.close();
  });
});

describe("license pricing", () => {
  it("falls back to the global seed when no per-tenant override exists", async () => {
    const filename = tempDbPath();
    await seedTenant(filename, TENANT_A);

    const repo = await openSqliteLicensingRepository({ filename });
    await repo.upsertLicensePricing(pricing());

    const resolved = await repo.getLicensePricing(TENANT_A, SKU_1);
    expect(resolved?.unitPrice).toBe(8);
    expect(resolved?.tenantId).toBeNull();
    expect(await repo.getLicensePricing(TENANT_A, "sku-missing")).toBeUndefined();
    repo.close();
  });

  it("lets a per-tenant override win for that tenant only", async () => {
    const filename = tempDbPath();
    await seedTenant(filename, TENANT_A);
    await seedTenant(filename, TENANT_B);

    const repo = await openSqliteLicensingRepository({ filename });
    await repo.upsertLicensePricing(pricing());
    await repo.upsertLicensePricing(pricing({ tenantId: TENANT_A, unitPrice: 10 }));

    expect((await repo.getLicensePricing(TENANT_A, SKU_1))?.unitPrice).toBe(10);
    expect((await repo.getLicensePricing(TENANT_A, SKU_1))?.tenantId).toBe(TENANT_A);
    expect((await repo.getLicensePricing(TENANT_B, SKU_1))?.unitPrice).toBe(8);

    const resolved = await repo.listLicensePricing(TENANT_A);
    expect(resolved).toHaveLength(1);
    expect(resolved[0]?.unitPrice).toBe(10);

    const global = await repo.listLicensePricing();
    expect(global).toHaveLength(1);
    expect(global[0]?.tenantId).toBeNull();
    repo.close();
  });

  it("treats a repeated upsert as an edit of the same row", async () => {
    const filename = tempDbPath();
    await seedTenant(filename, TENANT_A);

    const repo = await openSqliteLicensingRepository({ filename });
    await repo.upsertLicensePricing(pricing());
    const edited = await repo.upsertLicensePricing(
      pricing({ tenantId: TENANT_A, unitPrice: 12, currency: "USD" }),
    );
    expect(edited.unitPrice).toBe(12);
    expect(await repo.listLicensePricing(TENANT_A)).toHaveLength(1);
    repo.close();
  });

  it("writes an AuditEvent for pricing upserts", async () => {
    const filename = tempDbPath();
    await seedTenant(filename, TENANT_A);

    const repo = await openSqliteLicensingRepository({ filename });
    await repo.upsertLicensePricing(pricing());
    await repo.upsertLicensePricing(pricing({ tenantId: TENANT_A, unitPrice: 10 }));
    repo.close();

    const auditor = await openSqliteRepository({ filename });
    const tenantEvents = await auditor.listAuditEvents(TENANT_A);
    expect(
      tenantEvents.filter((event) => event.action === "licensing.pricing.upsert"),
    ).toHaveLength(1);
    const allEvents = await auditor.listAuditEvents();
    expect(
      allEvents.filter((event) => event.action === "licensing.pricing.upsert"),
    ).toHaveLength(2);
    auditor.close();
  });
});

describe("license changes", () => {
  async function openSeeded(filename: string): Promise<SqliteLicensingRepository> {
    await seedTenant(filename, TENANT_A);
    await seedTenant(filename, TENANT_B);
    return openSqliteLicensingRepository({ filename });
  }

  it("appends a change and scopes reads to the tenant and user", async () => {
    const repo = await openSeeded(tempDbPath());
    await repo.appendLicenseChange(change("change-1", TENANT_A));
    await repo.appendLicenseChange(change("change-2", TENANT_A, { userId: USER_2 }));

    const created = await repo.getLicenseChange(TENANT_A, "change-1");
    expect(created?.userId).toBe(USER_1);
    expect(created?.action).toBe("assign");
    expect(created?.state).toBe("applied");
    expect(created?.by).toBe("operator-1");

    expect(await repo.listLicenseChanges(TENANT_A)).toHaveLength(2);
    expect(await repo.listLicenseChanges(TENANT_A, { userId: USER_1 })).toHaveLength(1);
    expect(await repo.getLicenseChange(TENANT_B, "change-1")).toBeUndefined();
    expect(await repo.listLicenseChanges(TENANT_B)).toHaveLength(0);
    repo.close();
  });

  it("writes an AuditEvent for every appended change", async () => {
    const filename = tempDbPath();
    const repo = await openSeeded(filename);
    await repo.appendLicenseChange(change("change-1", TENANT_A));
    repo.close();

    const auditor = await openSqliteRepository({ filename });
    const events = (await auditor.listAuditEvents(TENANT_A)).filter(
      (event) => event.action === "licensing.change.append",
    );
    expect(events).toHaveLength(1);
    expect(events[0]?.targetId).toBe("change-1");
    auditor.close();
  });

  it("is append-only at the storage layer", async () => {
    const filename = tempDbPath();
    const repo = await openSeeded(filename);
    await repo.appendLicenseChange(change("change-1", TENANT_A));
    repo.close();

    const raw = new Database(filename);
    try {
      expect(() =>
        raw.prepare("UPDATE license_changes SET state = ? WHERE id = ?").run("failed", "change-1"),
      ).toThrow(/append-only/);
      expect(() => raw.prepare("DELETE FROM license_changes WHERE id = ?").run("change-1")).toThrow(
        /append-only/,
      );
      expect(raw.prepare("SELECT COUNT(*) AS c FROM license_changes").get()).toMatchObject({ c: 1 });
    } finally {
      raw.close();
    }
  });
});
