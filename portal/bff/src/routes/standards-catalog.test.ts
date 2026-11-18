// T-0877 — standards catalog tenant license classification.
import {
  DEFAULT_STANDARDS_REGISTRY_PATH,
  SqliteRepository,
  SqliteStandardsRepository,
  loadMigrations,
  runMigrations,
} from "@m365-assess/db";
import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import {
  createStandardsCatalogStore,
  createTenantLicenseResolver,
  loadLicensingOverlay,
} from "../adapters/standards.js";
import { AppError } from "../errors.js";
import { RbacErrorCodes, type Caller } from "../rbac/authorize.js";
import { ALL_TENANTS, tenantScope } from "../rbac/scope.js";
import type { RequestContext } from "../server.js";
import {
  STANDARDS_CATALOG_OPENAPI,
  STANDARDS_CATALOG_PATH,
  STANDARDS_CATALOG_PERMISSION,
  createStandardsCatalogRoutes,
  type CatalogItem,
  type CatalogStandardRecord,
} from "./standards-catalog.js";

const TENANT_E3 = "11111111-1111-1111-1111-111111111111";
const TENANT_E5 = "22222222-2222-2222-2222-222222222222";
const TENANT_EMPTY = "33333333-3333-3333-3333-333333333333";

function adminCaller(): Caller {
  return { roles: ["admin"], tenantScope: ALL_TENANTS };
}

function allowAll(): void {}
function denyAll(): void {
  throw new AppError(RbacErrorCodes.forbidden, "not permitted to perform this action", 403);
}

function ctx(query: Record<string, string> = {}): RequestContext {
  return {
    correlationId: "corr-1",
    method: "GET",
    path: STANDARDS_CATALOG_PATH,
    query: new URLSearchParams(query),
    headers: {},
    params: {},
  };
}

async function setupWithRealRegistry() {
  const db = new Database(":memory:");
  const version = runMigrations(db, loadMigrations());
  const repo = new SqliteRepository(db, version, "memory");
  const standards = new SqliteStandardsRepository(db, version, DEFAULT_STANDARDS_REGISTRY_PATH);

  for (const id of [TENANT_E3, TENANT_E5, TENANT_EMPTY]) {
    await repo.upsertTenant({
      id,
      displayName: null,
      defaultDomain: null,
      initialDomain: null,
      source: "direct",
      status: "active",
      excluded: false,
      lastRunAt: null,
      errorCount: 0,
    });
  }

  await repo.upsertTenantLicenseInventory({
    tenantId: TENANT_E3,
    skuId: "sku-e3",
    skuPartNumber: "SPE_E3",
    enabledUnits: 25,
    consumedUnits: 10,
    lastSynced: "2026-10-01T00:00:00.000Z",
  });
  await repo.upsertTenantLicenseInventory({
    tenantId: TENANT_E5,
    skuId: "sku-e5",
    skuPartNumber: "SPE_E5",
    enabledUnits: 10,
    consumedUnits: 8,
    lastSynced: "2026-10-01T00:00:00.000Z",
  });

  const overlay = await loadLicensingOverlay();
  const routes = createStandardsCatalogRoutes({
    catalog: createStandardsCatalogStore(standards),
    resolveTenantLicense: createTenantLicenseResolver(repo),
    overlay: overlay.checks,
    resolveCaller: () => adminCaller(),
    authorize: allowAll,
  });
  const route = routes.find((r) => r.method === "GET" && r.path === STANDARDS_CATALOG_PATH);
  if (!route) throw new Error("catalog route not found");

  return { db, repo, standards, overlay, route };
}

describe("GET /v1/standards/catalog (T-0877)", () => {
  it("returns unevaluated catalog items when tenantId is omitted", async () => {
    const { route } = await setupWithRealRegistry();
    const res = await route.handler(ctx());
    expect(res.status).toBe(200);
    const items = (res.body as { items: CatalogItem[] }).items;
    expect(items.length).toBeGreaterThan(0);
    expect(items.every((item) => item.licenseState === null && item.licenseReason === null)).toBe(true);
  });

  it("returns 200 with per-check classification for an E3-only tenant (E5 checks license-missing)", async () => {
    const { route } = await setupWithRealRegistry();
    const res = await route.handler(ctx({ tenantId: TENANT_E3 }));
    expect(res.status).toBe(200);
    const items = (res.body as { items: CatalogItem[] }).items;
    const byCheck = new Map(items.map((item) => [item.check, item]));

    expect(byCheck.get("ENTRA-SECDEFAULT-001")).toMatchObject({
      licensePreset: "E3",
      licenseState: "eligible",
      licenseReason: null,
    });
    expect(byCheck.get("ENTRA-PIM-001")).toMatchObject({
      licensePreset: "E5",
      licenseState: "license-missing",
    });
    expect(byCheck.get("ENTRA-PIM-001")?.licenseReason).toContain("E5");
    expect(byCheck.get("DEFENDER-ANTIPHISH-001")?.licenseState).toBe("license-missing");
    expect(byCheck.get("CA-SIGNINRISK-001")?.licenseState).toBe("license-missing");
  });

  it("returns 200 with all E3 and overlay-gated E5 checks eligible for an E5 tenant", async () => {
    const { route } = await setupWithRealRegistry();
    const res = await route.handler(ctx({ tenantId: TENANT_E5 }));
    expect(res.status).toBe(200);
    const items = (res.body as { items: CatalogItem[] }).items;
    const byCheck = new Map(items.map((item) => [item.check, item]));

    expect(byCheck.get("ENTRA-SECDEFAULT-001")?.licenseState).toBe("eligible");
    expect(byCheck.get("ENTRA-PIM-001")?.licenseState).toBe("eligible");
    expect(byCheck.get("CA-SIGNINRISK-001")?.licenseState).toBe("eligible");
    expect(byCheck.get("DEFENDER-ANTIPHISH-001")?.licenseState).toBe("eligible");
    expect(byCheck.get("EXO-LOCKBOX-001")?.licenseState).toBe("eligible");
    expect(byCheck.get("COMPLIANCE-DLP-002")?.licenseState).toBe("eligible");
  });

  it("classifies all E3 and E5 checks as license-missing when a tenant has no active SKUs", async () => {
    const { route } = await setupWithRealRegistry();
    const res = await route.handler(ctx({ tenantId: TENANT_EMPTY }));
    expect(res.status).toBe(200);
    const items = (res.body as { items: CatalogItem[] }).items;
    expect(items.every((item) => item.licenseState === "license-missing")).toBe(true);
  });

  it("classifies overlay service-plan gates for a tenant with partial add-on licenses", async () => {
    const overlay = await loadLicensingOverlay();
    const definitions: CatalogStandardRecord[] = [
      { id: "ENTRA-SECDEFAULT-001", check: "ENTRA-SECDEFAULT-001", name: "Security defaults", category: "SECDEFAULT", licensePreset: "E3" },
      { id: "CA-SIGNINRISK-001", check: "CA-SIGNINRISK-001", name: "Sign-in risk", category: "SIGNINRISK", licensePreset: null },
      { id: "DEFENDER-ANTIPHISH-001", check: "DEFENDER-ANTIPHISH-001", name: "Anti-phish", category: "ANTIPHISH", licensePreset: null },
    ];
    const resolveTenantLicense = createTenantLicenseResolver({
      listTenantLicenseInventory: async () => [
        {
          tenantId: "t-partial",
          skuId: "sku-e3",
          skuPartNumber: "SPE_E3",
          enabledUnits: 10,
          consumedUnits: 2,
          lastSynced: "2026-10-01T00:00:00.000Z",
          createdAt: "",
          updatedAt: "",
        },
        {
          tenantId: "t-partial",
          skuId: "sku-p2",
          skuPartNumber: "AAD_PREMIUM_P2",
          enabledUnits: 10,
          consumedUnits: 2,
          lastSynced: "2026-10-01T00:00:00.000Z",
          createdAt: "",
          updatedAt: "",
        },
      ],
    });
    const [route] = createStandardsCatalogRoutes({
      catalog: { listDefinitions: async () => definitions },
      resolveTenantLicense,
      overlay: overlay.checks,
      resolveCaller: () => adminCaller(),
      authorize: allowAll,
    });

    const res = await route!.handler(ctx({ tenantId: "t-partial" }));
    expect(res.status).toBe(200);
    const items = (res.body as { items: CatalogItem[] }).items;
    const byCheck = new Map(items.map((item) => [item.check, item]));

    expect(byCheck.get("ENTRA-SECDEFAULT-001")?.licenseState).toBe("eligible");
    expect(byCheck.get("CA-SIGNINRISK-001")?.licenseState).toBe("eligible");
    expect(byCheck.get("DEFENDER-ANTIPHISH-001")?.licenseState).toBe("license-missing");
    expect(byCheck.get("DEFENDER-ANTIPHISH-001")?.licenseReason).toContain("ATP_ENTERPRISE");
  });

  it("filters by category alongside tenantId classification", async () => {
    const { route } = await setupWithRealRegistry();
    const res = await route.handler(ctx({ tenantId: TENANT_E3, category: "PIM" }));
    expect(res.status).toBe(200);
    const items = (res.body as { items: CatalogItem[] }).items;
    expect(items.length).toBeGreaterThan(0);
    expect(items.every((item) => item.category === "PIM")).toBe(true);
    const byCheck = new Map(items.map((item) => [item.check, item]));
    expect(byCheck.get("ENTRA-PIM-007")?.licenseState).toBe("eligible");
    expect(byCheck.get("ENTRA-PIM-001")?.licenseState).toBe("license-missing");
  });

  it("enforces authentication, RBAC permission, and tenant scope", async () => {
    const overlay = await loadLicensingOverlay();
    const baseOpts = {
      catalog: { listDefinitions: async () => [] },
      resolveTenantLicense: createTenantLicenseResolver({ listTenantLicenseInventory: async () => [] }),
      overlay: overlay.checks,
    };

    const unauth = createStandardsCatalogRoutes({ ...baseOpts, resolveCaller: () => undefined, authorize: allowAll })[0]!;
    await expect(unauth.handler(ctx({ tenantId: TENANT_E3 }))).rejects.toMatchObject({ status: 401 });

    const forbidden = createStandardsCatalogRoutes({ ...baseOpts, resolveCaller: () => adminCaller(), authorize: denyAll })[0]!;
    await expect(forbidden.handler(ctx({ tenantId: TENANT_E3 }))).rejects.toMatchObject({ status: 403 });

    const outOfScope = createStandardsCatalogRoutes({
      ...baseOpts,
      resolveCaller: () => ({ roles: ["operator"], tenantScope: tenantScope([TENANT_E5]) }),
      authorize: allowAll,
    })[0]!;
    await expect(outOfScope.handler(ctx({ tenantId: TENANT_E3 }))).rejects.toMatchObject({ status: 403 });

    expect(STANDARDS_CATALOG_OPENAPI["/v1/standards/catalog"].get.permission).toBe(
      STANDARDS_CATALOG_PERMISSION,
    );
  });
});
