// T-0805 — vendor-neutral CSP licensing adapter (EPIC-041 SPEC §3.1, §9).
// The adapter registers with the T-0801 registry and exposes mapping config,
// a test handshake, and a sync entry point. No vendor HTTP: a fake provider
// stands in for a concrete CSP vendor. Sync is a structured no-op until a
// provider is registered. Credentials stay by reference — the adapter sees
// config.secretRef only, never secret material.
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import {
  SqliteIntegrationRepository,
  loadMigrations,
  runMigrations,
  type IntegrationConfig,
  type IntegrationConfigInput,
} from "@m365-assess/db";
import { IntegrationRegistry } from "../integration-registry.js";
import {
  CSP_KIND,
  CspLicensingAdapter,
  parseMapping,
  type CspLicence,
  type CspProvider,
} from "./csp-adapter.js";

const SECRET_REF = "vault://fixtures/csp-api-key";
const SECRET_VALUE = "csp_supersecretvalue";

const dbs: Database.Database[] = [];

afterEach(() => {
  for (const db of dbs) db.close();
  dbs.length = 0;
});

function harness() {
  const db = new Database(":memory:");
  dbs.push(db);
  const version = runMigrations(db, loadMigrations());
  const repository = new SqliteIntegrationRepository(db, version);
  const registry = new IntegrationRegistry(repository);
  return { db, repository, registry };
}

function configInput(extra: Partial<IntegrationConfigInput> = {}): IntegrationConfigInput {
  return {
    kind: CSP_KIND,
    enabled: true,
    secretRef: SECRET_REF,
    mapping: { skuMappings: [{ cspSku: "CSP-001", portalSku: "ENTERPRISEPACK" }] },
    ...extra,
  };
}

function fakeProvider(licences: readonly CspLicence[]): CspProvider & { calls: IntegrationConfig[] } {
  const calls: IntegrationConfig[] = [];
  return {
    name: "fake-csp",
    calls,
    fetchLicences: async (config) => {
      calls.push(config);
      return licences;
    },
  };
}

describe("CspLicensingAdapter registration", () => {
  it("registers with the T-0801 registry under the csp kind", () => {
    const { registry } = harness();
    const adapter = new CspLicensingAdapter();
    registry.register(adapter);
    expect(registry.listKinds()).toEqual([CSP_KIND]);
    expect(registry.resolve(CSP_KIND).kind).toBe(CSP_KIND);
  });
});

describe("CspLicensingAdapter test handshake", () => {
  it("succeeds with a secretRef and well-formed mapping", async () => {
    const adapter = new CspLicensingAdapter();
    const result = await adapter.test({
      id: "1",
      kind: CSP_KIND,
      enabled: true,
      secretRef: SECRET_REF,
      mapping: { skuMappings: [{ cspSku: "CSP-001", portalSku: "ENTERPRISEPACK" }] },
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    });
    expect(result.ok).toBe(true);
    expect(result.message).toContain("1 sku mapping(s)");
  });

  it("fails when secretRef is missing", async () => {
    const adapter = new CspLicensingAdapter();
    const result = await adapter.test({
      id: "1",
      kind: CSP_KIND,
      enabled: true,
      secretRef: "",
      mapping: {},
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    });
    expect(result).toEqual({ ok: false, message: "secretRef is required" });
  });

  it("fails when mapping.skuMappings is not an array", async () => {
    const adapter = new CspLicensingAdapter();
    const result = await adapter.test({
      id: "1",
      kind: CSP_KIND,
      enabled: true,
      secretRef: SECRET_REF,
      mapping: { skuMappings: "not-an-array" },
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    });
    expect(result).toEqual({ ok: false, message: "mapping.skuMappings must be an array" });
  });
});

describe("CspLicensingAdapter sync", () => {
  it("is a structured no-op when no provider is registered", async () => {
    const adapter = new CspLicensingAdapter();
    const config: IntegrationConfig = {
      id: "1",
      kind: CSP_KIND,
      enabled: true,
      secretRef: SECRET_REF,
      mapping: {},
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    };
    const result = await adapter.sync(config);
    expect(result).toEqual({ ok: true, synced: 0, message: "no provider configured" });
  });

  it("delegates to a registered fake provider and reports the licence count", async () => {
    const licences: readonly CspLicence[] = [
      { sku: "CSP-001", total: 10, assigned: 7 },
      { sku: "CSP-002", total: 5, assigned: 5 },
    ];
    const provider = fakeProvider(licences);
    const adapter = new CspLicensingAdapter();
    adapter.registerProvider(provider);
    const config: IntegrationConfig = {
      id: "1",
      kind: CSP_KIND,
      enabled: true,
      secretRef: SECRET_REF,
      mapping: {},
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    };
    const result = await adapter.sync(config);
    expect(result).toEqual({ ok: true, synced: 2, message: "synced 2 licence(s) from fake-csp" });
    expect(provider.calls).toEqual([config]);
  });

  it("exercises the adapter through the T-0801 registry with a fake provider", async () => {
    const { registry } = harness();
    const adapter = new CspLicensingAdapter();
    registry.register(adapter);
    const config = await registry.putConfig(CSP_KIND, configInput(), {
      permissions: ["integrations.manage"],
    });

    const testResult = await registry.testIntegration(CSP_KIND);
    expect(testResult.ok).toBe(true);

    const syncResult = await registry.syncIntegration(CSP_KIND);
    expect(syncResult).toEqual({ ok: true, synced: 0, message: "no provider configured" });
    expect(JSON.stringify(syncResult)).not.toContain(SECRET_VALUE);
  });
});

describe("parseMapping", () => {
  it("returns an empty mapping when skuMappings is absent", () => {
    expect(parseMapping({})).toEqual({ skuMappings: [] });
  });

  it("keeps well-formed entries and drops malformed ones", () => {
    expect(
      parseMapping({
        skuMappings: [
          { cspSku: "CSP-001", portalSku: "ENTERPRISEPACK" },
          { cspSku: "CSP-002" },
          "not-an-object",
        ],
      }),
    ).toEqual({ skuMappings: [{ cspSku: "CSP-001", portalSku: "ENTERPRISEPACK" }] });
  });

  it("returns undefined when skuMappings is not an array", () => {
    expect(parseMapping({ skuMappings: 42 })).toBeUndefined();
  });
});
