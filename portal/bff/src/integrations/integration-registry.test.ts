// T-0801 — integration config store and vendor-adapter registry (EPIC-041
// SPEC §5, §6, §9). The fixture adapter stands in for a vendor: no vendor is
// registered by this ticket, it only proves an adapter is exercised through
// the registry.
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import {
  SqliteIntegrationRepository,
  loadMigrations,
  runMigrations,
  type IntegrationConfigInput,
} from "@m365-assess/db";
import { AppError } from "../errors.js";
import {
  INTEGRATIONS_MANAGE_PERMISSION,
  IntegrationRegistry,
  type IntegrationAdapter,
  type IntegrationCaller,
} from "./integration-registry.js";

const MANAGE: IntegrationCaller = { permissions: [INTEGRATIONS_MANAGE_PERMISSION] };
const WILDCARD: IntegrationCaller = { permissions: ["*"] };
const READER: IntegrationCaller = { permissions: ["Integrations.Read"] };

const SECRET_REF = "vault://fixtures/github-token";
const SECRET_VALUE = "ghp_supersecretvalue";

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

function fixtureAdapter(calls: { test: unknown[]; sync: unknown[] }): IntegrationAdapter {
  return {
    kind: "fixture",
    test: async (config) => {
      calls.test.push(config);
      return { ok: true, message: "fixture test ok" };
    },
    sync: async (config) => {
      calls.sync.push(config);
      return { ok: true, synced: 3, message: "fixture sync ok" };
    },
  };
}

function auditRows(db: Database.Database): Array<{ action: string; after: string | null }> {
  return db
    .prepare('SELECT action, "after" FROM audit_events ORDER BY rowid')
    .all() as Array<{ action: string; after: string | null }>;
}

function catchError(fn: () => unknown): unknown {
  try {
    fn();
  } catch (error) {
    return error;
  }
  throw new Error("expected fn to throw");
}

async function catchAsyncError(fn: () => Promise<unknown>): Promise<unknown> {
  try {
    await fn();
  } catch (error) {
    return error;
  }
  throw new Error("expected fn to reject");
}

function configInput(extra: Partial<IntegrationConfigInput> = {}): IntegrationConfigInput {
  return {
    kind: "fixture",
    enabled: true,
    secretRef: SECRET_REF,
    mapping: { company: "tenantId" },
    ...extra,
  };
}

describe("migration 0052", () => {
  it("creates the SPEC §5 IntegrationConfig columns", () => {
    const { db } = harness();
    const columns = (
      db.prepare("PRAGMA table_info(integration_configs)").all() as Array<{ name: string }>
    ).map((row) => row.name);
    expect(columns).toEqual(
      expect.arrayContaining([
        "id",
        "kind",
        "enabled",
        "secretRef",
        "mapping",
        "createdAt",
        "updatedAt",
      ]),
    );
  });
});

describe("IntegrationRegistry kind resolution", () => {
  it("resolves a registered kind to its adapter and lists kinds", () => {
    const { registry } = harness();
    expect(registry.listKinds()).toEqual([]);
    registry.register(fixtureAdapter({ test: [], sync: [] }));
    expect(registry.listKinds()).toEqual(["fixture"]);
    expect(registry.resolve("fixture").kind).toBe("fixture");
  });

  it("returns a structured error for an unknown kind", () => {
    const { registry } = harness();
    const error = catchError(() => registry.resolve("nope"));
    expect(error).toBeInstanceOf(AppError);
    expect((error as AppError).code).toBe("resource.not_found");
    expect((error as AppError).status).toBe(404);
    expect((error as AppError).details).toEqual([{ field: "kind", reason: "unknown_kind" }]);
  });

  it("returns the same structured error through test and sync", async () => {
    const { registry } = harness();
    const testError = await catchAsyncError(() => registry.testIntegration("nope"));
    const syncError = await catchAsyncError(() => registry.syncIntegration("nope"));
    for (const error of [testError, syncError]) {
      expect(error).toBeInstanceOf(AppError);
      expect((error as AppError).code).toBe("resource.not_found");
      expect((error as AppError).status).toBe(404);
    }
  });

  it("reports a known kind with no config as not_configured", async () => {
    const { registry } = harness();
    registry.register(fixtureAdapter({ test: [], sync: [] }));
    const error = await catchAsyncError(() => registry.testIntegration("fixture"));
    expect(error).toBeInstanceOf(AppError);
    expect((error as AppError).code).toBe("resource.not_found");
    expect((error as AppError).details).toEqual([{ field: "kind", reason: "not_configured" }]);
  });
});

describe("IntegrationRegistry config changes", () => {
  it("requires integrations.manage and persists nothing when denied", async () => {
    const { db, registry } = harness();
    const error = await catchAsyncError(() =>
      registry.putConfig("fixture", configInput(), READER),
    );
    expect(error).toBeInstanceOf(AppError);
    expect((error as AppError).code).toBe("auth.forbidden");
    expect((error as AppError).status).toBe(403);
    expect((error as AppError).details).toEqual([
      { field: "permission", reason: INTEGRATIONS_MANAGE_PERMISSION },
    ]);
    expect(await registry.getConfig("fixture")).toBeUndefined();
    expect(auditRows(db)).toEqual([]);
  });

  it("accepts the wildcard permission like the route guards", async () => {
    const { registry } = harness();
    const config = await registry.putConfig("fixture", configInput(), WILDCARD);
    expect(config.kind).toBe("fixture");
    expect(config.enabled).toBe(true);
  });

  it("exercises a registered adapter's test and sync through the registry", async () => {
    const calls: { test: unknown[]; sync: unknown[] } = { test: [], sync: [] };
    const { registry } = harness();
    registry.register(fixtureAdapter(calls));
    const config = await registry.putConfig("fixture", configInput(), MANAGE);

    const testResult = await registry.testIntegration("fixture");
    expect(testResult).toEqual({ ok: true, message: "fixture test ok" });
    expect(calls.test).toEqual([config]);

    const syncResult = await registry.syncIntegration("fixture");
    expect(syncResult).toEqual({ ok: true, synced: 3, message: "fixture sync ok" });
    expect(calls.sync).toEqual([config]);
  });

  it("audits config changes with before and after snapshots", async () => {
    const { db, registry } = harness();
    await registry.putConfig("fixture", configInput(), MANAGE);
    await registry.putConfig("fixture", configInput({ enabled: false }), MANAGE);

    const rows = auditRows(db);
    expect(rows).toHaveLength(2);
    expect(rows[0]?.action).toBe("integration.config.upsert");
    expect(rows[0]?.after).toContain(SECRET_REF);
    expect(rows[1]?.after).toContain('"enabled":false');
  });

  it("persists only the secretRef; no secret value is stored or logged", async () => {
    const { db, registry } = harness();
    const config = await registry.putConfig("fixture", configInput(), MANAGE);

    expect(config.secretRef).toBe(SECRET_REF);
    const stored = await registry.getConfig("fixture");
    expect(stored?.secretRef).toBe(SECRET_REF);

    const row = db
      .prepare("SELECT * FROM integration_configs WHERE kind = 'fixture'")
      .get() as Record<string, unknown>;
    expect(JSON.stringify(row)).not.toContain(SECRET_VALUE);

    const audited = auditRows(db)
      .map((entry) => entry.after ?? "")
      .join("\n");
    expect(audited).toContain(SECRET_REF);
    expect(audited).not.toContain(SECRET_VALUE);
  });
});
