import { mkdtempSync, rmSync } from "node:fs";
import type { Server } from "node:http";
import { tmpdir } from "node:os";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  openSqliteLicensingRepository,
  openSqliteRepository,
  type LicensingRepository,
} from "@m365-assess/db";
import { tenantScope } from "../rbac/scope.js";
import { buildServer, type RequestContext, type RouteResponse } from "../server.js";
import { seedLicensePricing } from "../domain/license-pricing-seed.js";
import {
  LICENSE_PRICING_ADMIN_SCOPE,
  LICENSE_PRICING_OPENAPI,
  LICENSE_PRICING_PATH,
  LICENSE_PRICING_READ_PERMISSION,
  createLicensePricingRoutes,
  getLicensePricing,
  putLicensePricing,
  type LicensePricingCaller,
} from "./license-pricing.js";

const TENANT_A = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const TENANT_B = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";
const SKU_1 = "ENTERPRISEPREMIUM";
const SKU_2 = "SPE_E5";

const tempDirs: string[] = [];

function tempDbPath(): string {
  const dir = mkdtempSync(join(tmpdir(), "m365-license-pricing-"));
  tempDirs.push(dir);
  return join(dir, "portal.db");
}

afterEach(async () => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
  tempDirs.length = 0;
  await Promise.all(
    openServers.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => {
          server.close(() => resolve());
        }),
    ),
  );
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

function caller(permissions: readonly string[]): LicensePricingCaller {
  return { roles: ["admin"], tenantScope: tenantScope([TENANT_A]), permissions, userId: "admin-1" };
}

const READ_CALLER = caller([LICENSE_PRICING_READ_PERMISSION]);
const ADMIN_CALLER = caller([LICENSE_PRICING_READ_PERMISSION, LICENSE_PRICING_ADMIN_SCOPE]);
const ADMIN_ONLY_CALLER = caller([LICENSE_PRICING_ADMIN_SCOPE]);

async function seededRepository(): Promise<{ filename: string; repository: LicensingRepository }> {
  const filename = tempDbPath();
  await seedTenant(filename, TENANT_A);
  await seedTenant(filename, TENANT_B);
  const repository = await openSqliteLicensingRepository({ filename });
  await seedLicensePricing(repository);
  return { filename, repository };
}

function pricingBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { skuId: SKU_1, unitPrice: 40, currency: "USD", ...overrides };
}

describe("getLicensePricing", () => {
  it("returns global rows when no tenant is requested", async () => {
    const { repository } = await seededRepository();
    const response = await getLicensePricing(repository, { caller: READ_CALLER, tenantId: null });
    expect(response.status).toBe(200);
    const pricing = response.body["pricing"] as Array<{ skuId: string; tenantId: string | null }>;
    expect(pricing.length).toBeGreaterThan(0);
    expect(pricing.every((row) => row.tenantId === null)).toBe(true);
    expect(pricing.find((row) => row.skuId === SKU_1)?.unitPrice).toBe(36);
    repository.close();
  });

  it("resolves the per-tenant override for that tenant and the global row for others", async () => {
    const { repository } = await seededRepository();
    await repository.upsertLicensePricing({ skuId: SKU_1, unitPrice: 30, currency: "USD", tenantId: TENANT_A });

    const forA = await getLicensePricing(repository, { caller: READ_CALLER, tenantId: TENANT_A });
    const rowsA = forA.body["pricing"] as Array<{ skuId: string; unitPrice: number; tenantId: string | null }>;
    expect(rowsA.find((row) => row.skuId === SKU_1)).toMatchObject({ unitPrice: 30, tenantId: TENANT_A });

    const forB = await getLicensePricing(repository, { caller: READ_CALLER, tenantId: TENANT_B });
    const rowsB = forB.body["pricing"] as Array<{ skuId: string; unitPrice: number; tenantId: string | null }>;
    expect(rowsB.find((row) => row.skuId === SKU_1)).toMatchObject({ unitPrice: 36, tenantId: null });

    const global = await getLicensePricing(repository, { caller: READ_CALLER, tenantId: null });
    const rowsGlobal = global.body["pricing"] as Array<{ skuId: string; unitPrice: number }>;
    expect(rowsGlobal.find((row) => row.skuId === SKU_1)?.unitPrice).toBe(36);
    repository.close();
  });

  it("omits unpriced SKUs instead of reporting a zero", async () => {
    const { repository } = await seededRepository();
    const response = await getLicensePricing(repository, { caller: READ_CALLER, tenantId: null });
    const pricing = response.body["pricing"] as Array<{ skuId: string }>;
    expect(pricing.find((row) => row.skuId === "SKU-NOT-SEEDED")).toBeUndefined();
    repository.close();
  });
});

describe("putLicensePricing", () => {
  it("upserts a global row when the body carries no tenantId", async () => {
    const { repository } = await seededRepository();
    const response = await putLicensePricing(repository, {
      caller: ADMIN_CALLER,
      tenantId: null,
      body: pricingBody({ unitPrice: 41 }),
    });
    expect(response.status).toBe(200);
    const pricing = response.body["pricing"] as { skuId: string; unitPrice: number; tenantId: string | null };
    expect(pricing).toMatchObject({ skuId: SKU_1, unitPrice: 41, tenantId: null });

    const reread = await repository.getLicensePricing(TENANT_B, SKU_1);
    expect(reread?.unitPrice).toBe(41);
    repository.close();
  });

  it("upserts a per-tenant override from the body or the query tenantId", async () => {
    const { repository } = await seededRepository();
    const routes = createLicensePricingRoutes({
      repository,
      resolveCaller: () => ADMIN_CALLER,
    });
    const put = routes.find((route) => route.method === "PUT");

    const fromBody = (await put!.handler({
      query: new URLSearchParams(),
      headers: {},
      params: {},
      body: pricingBody({ unitPrice: 33, tenantId: TENANT_A }),
    })) as RouteResponse;
    expect((fromBody.body["pricing"] as { tenantId: string }).tenantId).toBe(TENANT_A);

    const fromQuery = (await put!.handler({
      query: new URLSearchParams({ tenantId: TENANT_B }),
      headers: {},
      params: {},
      body: pricingBody({ skuId: SKU_2, unitPrice: 50 }),
    })) as RouteResponse;
    expect((fromQuery.body["pricing"] as { tenantId: string }).tenantId).toBe(TENANT_B);

    expect((await repository.getLicensePricing(TENANT_A, SKU_1))?.unitPrice).toBe(33);
    expect((await repository.getLicensePricing(TENANT_B, SKU_2))?.unitPrice).toBe(50);
    expect((await repository.getLicensePricing(TENANT_A, SKU_2))?.unitPrice).toBe(57);
    repository.close();
  });

  it("writes an AuditEvent for every pricing edit", async () => {
    const { filename, repository } = await seededRepository();
    await putLicensePricing(repository, {
      caller: ADMIN_CALLER,
      tenantId: null,
      body: { skuId: "SKU-AUDIT", unitPrice: 5, currency: "USD" },
    });
    await putLicensePricing(repository, {
      caller: ADMIN_CALLER,
      tenantId: TENANT_A,
      body: { skuId: "SKU-AUDIT", unitPrice: 7, currency: "USD", tenantId: TENANT_A },
    });
    repository.close();

    const auditor = await openSqliteRepository({ filename });
    const events = (await auditor.listAuditEvents()).filter(
      (event) => event.action === "licensing.pricing.upsert" && event.targetId === "SKU-AUDIT",
    );
    expect(events).toHaveLength(2);
    const byTenant = new Map(events.map((event) => [event.tenantId, event]));
    expect(byTenant.get(null)).toMatchObject({ targetId: "SKU-AUDIT", result: "success" });
    expect(byTenant.get(TENANT_A)).toMatchObject({ targetId: "SKU-AUDIT", result: "success" });
    auditor.close();
  });

  it("rejects malformed bodies with a structured 400", async () => {
    const { repository } = await seededRepository();
    await expect(
      putLicensePricing(repository, { caller: ADMIN_CALLER, tenantId: null, body: null }),
    ).rejects.toMatchObject({ status: 400 });
    await expect(
      putLicensePricing(repository, { caller: ADMIN_CALLER, tenantId: null, body: { unitPrice: 1, currency: "USD" } }),
    ).rejects.toMatchObject({ status: 400 });
    await expect(
      putLicensePricing(repository, { caller: ADMIN_CALLER, tenantId: null, body: { skuId: SKU_1, currency: "USD" } }),
    ).rejects.toMatchObject({ status: 400 });
    await expect(
      putLicensePricing(repository, {
        caller: ADMIN_CALLER,
        tenantId: null,
        body: { skuId: SKU_1, unitPrice: -1, currency: "USD" },
      }),
    ).rejects.toMatchObject({ status: 400 });
    repository.close();
  });
});

describe("license pricing routes", () => {
  it("gates GET on the licensing read permission", async () => {
    const { repository } = await seededRepository();
    const routes = createLicensePricingRoutes({
      repository,
      resolveCaller: () => ADMIN_ONLY_CALLER,
    });
    const get = routes.find((route) => route.method === "GET");
    await expect(get!.handler({} as RequestContext)).rejects.toMatchObject({ status: 403 });
    repository.close();
  });

  it("gates PUT on the CIPP.Admin.* scope", async () => {
    const { repository } = await seededRepository();
    const routes = createLicensePricingRoutes({
      repository,
      resolveCaller: () => READ_CALLER,
    });
    const put = routes.find((route) => route.method === "PUT");
    await expect(
      put!.handler({ query: new URLSearchParams(), headers: {}, params: {} } as RequestContext),
    ).rejects.toMatchObject({ status: 403 });
    repository.close();
  });

  it("answers 401 for an anonymous caller and 403 for a non-admin over HTTP", async () => {
    const { repository } = await seededRepository();
    const routes = createLicensePricingRoutes({
      repository,
      resolveCaller: (ctx) => {
        const raw = ctx.headers["x-permissions"];
        const header = Array.isArray(raw) ? raw[0] : raw;
        if (typeof header !== "string" || header.length === 0) return undefined;
        return caller(header.split(","));
      },
    });
    const baseUrl = await startServer(routes);
    const anonymous = await fetch(`${baseUrl}${LICENSE_PRICING_PATH}`);
    expect(anonymous.status).toBe(401);
    expect((await anonymous.json()) as Record<string, unknown>).toMatchObject({
      code: "request.unauthenticated",
    });

    const forbidden = await fetch(`${baseUrl}${LICENSE_PRICING_PATH}`, {
      method: "PUT",
      headers: { "content-type": "application/json", "x-permissions": LICENSE_PRICING_READ_PERMISSION },
      body: JSON.stringify(pricingBody()),
    });
    expect(forbidden.status).toBe(403);
    expect((await forbidden.json()) as Record<string, unknown>).toMatchObject({
      code: "auth.forbidden",
    });
    repository.close();
  });

  it("round-trips an admin edit from PUT into the effective GET", async () => {
    const { repository } = await seededRepository();
    const routes = createLicensePricingRoutes({
      repository,
      resolveCaller: () => ADMIN_CALLER,
    });
    const put = routes.find((route) => route.method === "PUT");
    const get = routes.find((route) => route.method === "GET");

    const saved = (await put!.handler({
      query: new URLSearchParams({ tenantId: TENANT_A }),
      headers: {},
      params: {},
      body: pricingBody({ unitPrice: 31 }),
    })) as RouteResponse;
    expect(saved.status).toBe(200);

    const loaded = (await get!.handler({
      query: new URLSearchParams({ tenantId: TENANT_A }),
      headers: {},
      params: {},
    })) as RouteResponse;
    const pricing = loaded.body["pricing"] as Array<{ skuId: string; unitPrice: number }>;
    expect(pricing.find((row) => row.skuId === SKU_1)?.unitPrice).toBe(31);
    repository.close();
  });

  it("publishes both operations and their permissions through the route module", () => {
    const path = LICENSE_PRICING_OPENAPI.paths["/license-pricing"];
    expect(path.get.permission).toBe(LICENSE_PRICING_READ_PERMISSION);
    expect(path.put.permission).toBe(LICENSE_PRICING_ADMIN_SCOPE);
    expect(LICENSE_PRICING_OPENAPI.schemas.LicensePricing).toBeDefined();
  });
});

const openServers: Server[] = [];

async function startServer(routes: ReturnType<typeof createLicensePricingRoutes>): Promise<string> {
  const server = buildServer({ routes });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  openServers.push(server);
  const { port } = server.address() as AddressInfo;
  return `http://127.0.0.1:${port}`;
}
