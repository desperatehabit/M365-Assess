// T-0804 — contract test for the vendor-neutral PSA/RMM adapter shape
// (EPIC-041 SPEC §3.1, §4, §9). The fake vendor stands in for a later
// Halo/Hudu/NinjaOne adapter: it proves test and sync are exercised through
// the T-0801 registry and delegate to whatever vendor is registered, while
// the unconfigured default is a structured no-op.
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import {
  SqliteIntegrationRepository,
  loadMigrations,
  runMigrations,
  type IntegrationConfigInput,
} from "@m365-assess/db";
import {
  INTEGRATIONS_MANAGE_PERMISSION,
  IntegrationRegistry,
  type IntegrationCaller,
} from "../integration-registry.js";
import {
  PSA_DEFAULT_MAPPING,
  PSA_KIND,
  PSA_NO_VENDOR_MESSAGE,
  PsaAdapter,
  registerPsaAdapter,
  type PsaVendorDelegate,
} from "./psa-adapter.js";

const MANAGE: IntegrationCaller = { permissions: [INTEGRATIONS_MANAGE_PERMISSION] };

const SECRET_REF = "vault://fixtures/psa-token";
const SECRET_VALUE = "psa_supersecretvalue";

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

function fakeVendor(calls: { test: unknown[]; sync: unknown[] }): PsaVendorDelegate {
  return {
    test: async (config) => {
      calls.test.push(config);
      return { ok: true, message: "fake vendor test ok" };
    },
    sync: async (config) => {
      calls.sync.push(config);
      return { ok: true, synced: 7, message: "fake vendor sync ok" };
    },
  };
}

function auditRows(db: Database.Database): Array<{ action: string; after: string | null }> {
  return db
    .prepare('SELECT action, "after" FROM audit_events ORDER BY rowid')
    .all() as Array<{ action: string; after: string | null }>;
}

function configInput(extra: Partial<IntegrationConfigInput> = {}): IntegrationConfigInput {
  return {
    kind: PSA_KIND,
    enabled: true,
    secretRef: SECRET_REF,
    mapping: PSA_DEFAULT_MAPPING,
    ...extra,
  };
}

describe("PsaAdapter registration with the T-0801 registry", () => {
  it("registers the psa kind and resolves to the adapter", () => {
    const { registry } = harness();
    expect(registry.listKinds()).toEqual([]);
    registerPsaAdapter(registry);
    expect(registry.listKinds()).toEqual([PSA_KIND]);
    expect(registry.resolve(PSA_KIND)).toBeInstanceOf(PsaAdapter);
    expect(registry.resolve(PSA_KIND).kind).toBe(PSA_KIND);
  });

  it("exposes the vendor-neutral default entity mapping", () => {
    expect(PSA_DEFAULT_MAPPING).toEqual({
      company: "tenantId",
      ticket: "alertId",
      asset: "deviceId",
      contact: "userId",
    });
  });
});

describe("PsaAdapter unconfigured default", () => {
  it("returns a structured no-vendor test result through the registry", async () => {
    const { registry } = harness();
    registerPsaAdapter(registry);
    await registry.putConfig(PSA_KIND, configInput(), MANAGE);

    const result = await registry.testIntegration(PSA_KIND);
    expect(result).toEqual({ ok: false, message: PSA_NO_VENDOR_MESSAGE });
  });

  it("is a no-op sync with a structured no-vendor result through the registry", async () => {
    const { registry } = harness();
    registerPsaAdapter(registry);
    await registry.putConfig(PSA_KIND, configInput(), MANAGE);

    const result = await registry.syncIntegration(PSA_KIND);
    expect(result).toEqual({ ok: true, synced: 0, message: PSA_NO_VENDOR_MESSAGE });
  });
});

describe("PsaAdapter with a fake vendor", () => {
  it("exercises the fake vendor's test and sync through the registry", async () => {
    const calls: { test: unknown[]; sync: unknown[] } = { test: [], sync: [] };
    const { registry } = harness();
    registerPsaAdapter(registry, fakeVendor(calls));
    const config = await registry.putConfig(PSA_KIND, configInput(), MANAGE);

    const testResult = await registry.testIntegration(PSA_KIND);
    expect(testResult).toEqual({ ok: true, message: "fake vendor test ok" });
    expect(calls.test).toEqual([config]);

    const syncResult = await registry.syncIntegration(PSA_KIND);
    expect(syncResult).toEqual({ ok: true, synced: 7, message: "fake vendor sync ok" });
    expect(calls.sync).toEqual([config]);
  });

  it("hands the vendor the config with only the secret reference", async () => {
    const calls: { test: unknown[]; sync: unknown[] } = { test: [], sync: [] };
    const { registry } = harness();
    registerPsaAdapter(registry, fakeVendor(calls));
    await registry.putConfig(PSA_KIND, configInput(), MANAGE);

    await registry.testIntegration(PSA_KIND);
    await registry.syncIntegration(PSA_KIND);

    for (const seen of [...calls.test, ...calls.sync]) {
      expect(seen).toMatchObject({ kind: PSA_KIND, secretRef: SECRET_REF });
      expect(JSON.stringify(seen)).not.toContain(SECRET_VALUE);
    }
  });

  it("persists and audits only the secretRef; no secret value is stored or logged", async () => {
    const { db, registry } = harness();
    registerPsaAdapter(registry, fakeVendor({ test: [], sync: [] }));
    await registry.putConfig(PSA_KIND, configInput(), MANAGE);

    const row = db
      .prepare("SELECT * FROM integration_configs WHERE kind = ?")
      .get(PSA_KIND) as Record<string, unknown>;
    expect(JSON.stringify(row)).not.toContain(SECRET_VALUE);

    const audited = auditRows(db)
      .map((entry) => entry.after ?? "")
      .join("\n");
    expect(audited).toContain(SECRET_REF);
    expect(audited).not.toContain(SECRET_VALUE);
  });

  it("round-trips the default mapping through the config store", async () => {
    const { registry } = harness();
    registerPsaAdapter(registry);
    const config = await registry.putConfig(PSA_KIND, configInput(), MANAGE);
    expect(config.mapping).toEqual(PSA_DEFAULT_MAPPING);

    const stored = await registry.getConfig(PSA_KIND);
    expect(stored?.mapping).toEqual(PSA_DEFAULT_MAPPING);
  });
});
