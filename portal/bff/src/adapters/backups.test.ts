// Integration tests for the EPIC-035 backup adapter over real SQLite
// (`SqliteRepository` + migrations) and the filesystem artifact tier (T-0865).
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Readable } from "node:stream";
import type { JobEnvelope } from "@m365-assess/contracts";
import { SqliteRepository, loadMigrations, runMigrations } from "@m365-assess/db";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import {
  applyRestore,
  createMemoryRestoreIdempotencyStore,
} from "../backup/apply.js";
import { readBackupArchive } from "../backup/archive.js";
import { createInstanceBackup } from "../backup/instance.js";
import { createTenantBackup } from "../backup/tenant.js";
import { tenantScope } from "../rbac/scope.js";
import { createBackupSettingsRoutes } from "../routes/backup-settings.js";
import { createBackupsRestoreRoutes } from "../routes/backups-restore.js";
import { createBackupRoutes } from "../routes/backups.js";
import { createMaintenanceRunner } from "../scheduler/maintenance.js";
import {
  BACKUP_MAINTENANCE_COMMAND,
  BACKUP_MAINTENANCE_TIMER,
  createBackupMaintenanceCommand,
  createBackupsArtifactTier,
  createBackupsStore,
} from "./backups.js";

const INSTANCE_VERSION = "1.0.0-test";
const TENANT_A = "tenant-a";
const TENANT_B = "tenant-b";
const NOW = new Date("2026-10-15T03:00:00.000Z");

const tempDirs: string[] = [];
const openDbs: Database.Database[] = [];

afterEach(() => {
  for (const db of openDbs.splice(0)) {
    db.close();
  }
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function createHarness() {
  const db = new Database(":memory:");
  openDbs.push(db);
  db.pragma("foreign_keys = ON");
  const schemaVersion = runMigrations(db, loadMigrations());
  const repo = new SqliteRepository(db, schemaVersion, "memory");
  const store = createBackupsStore(db, repo);

  const root = mkdtempSync(path.join(tmpdir(), "m365-backup-tier-"));
  tempDirs.push(root);
  const artifacts = createBackupsArtifactTier(root);

  return { db, repo, store, artifacts, root, schemaVersion };
}

function seedTenant(db: Database.Database, id: string, displayName: string, domain: string): void {
  const ts = "2026-09-01T00:00:00.000Z";
  db.prepare(
    `INSERT INTO tenants
       (id, displayName, defaultDomain, initialDomain, source, status, excluded, errorCount, environment, createdAt, updatedAt)
     VALUES (?, ?, ?, ?, 'direct', 'active', 0, 0, 'global', ?, ?)`,
  ).run(id, displayName, domain, domain, ts, ts);
}

function seedInstanceConfig(db: Database.Database): void {
  const ts = "2026-09-01T00:00:00.000Z";
  seedTenant(db, TENANT_A, "Alpha Corp", "alpha.example.com");
  seedTenant(db, TENANT_B, "Bravo Corp", "bravo.example.com");

  db.prepare(
    `INSERT INTO roles (id, name, "include", "exclude", builtin, createdAt, updatedAt)
     VALUES ('custom-auditor', 'custom-auditor', '["*.Read"]', '[]', 0, ?, ?)`,
  ).run(ts, ts);

  db.prepare(
    `INSERT INTO template_library_items (id, type, name, body, source, repoId, createdAt, updatedAt)
     VALUES ('tpl-lib-1', 'ca', 'Require MFA', '{"state":"enabled"}', 'local', NULL, ?, ?)`,
  ).run(ts, ts);

  db.prepare(
    `INSERT INTO alert_rules
       (id, name, source, conditions, actions, enabled, scriptMode, scheduleId, createdAt, updatedAt, tenantId, severity, scope, channels, builtIn)
     VALUES ('rule-global', 'Global Alert', 'drift', '[]', '[]', 1, 0, NULL, ?, ?, NULL, 'High', '{"type":"all"}', '["email"]', 0)`,
  ).run(ts, ts);

  db.prepare(
    `INSERT INTO alert_rules
       (id, name, source, conditions, actions, enabled, scriptMode, scheduleId, createdAt, updatedAt, tenantId, severity, scope, channels, builtIn)
     VALUES ('rule-a', 'Tenant A Alert', 'drift', '[]', '[]', 1, 0, NULL, ?, ?, ?, 'Medium', '{"type":"tenant"}', '["slack"]', 0)`,
  ).run(ts, ts, TENANT_A);

  db.prepare(
    `INSERT INTO app_settings (key, value, scope, updatedAt, updatedBy)
     VALUES ('general.portalName', '"Contoso Portal"', 'global', ?, 'operator-1')`,
  ).run(ts);
}

function seedTenantConfig(db: Database.Database): void {
  const ts = "2026-09-01T00:00:00.000Z";
  db.prepare(
    `INSERT INTO standard_templates (id, name, kind, actions, autoRemediate, settings, scheduleId, createdAt, updatedAt)
     VALUES ('std-1', 'Baseline Standard', 'standards', '{"report":true,"alert":true,"remediate":false}', 0, '[]', NULL, ?, ?)`,
  ).run(ts, ts);

  db.prepare(
    `INSERT INTO template_assignments (templateId, targetType, targetId, precedence)
     VALUES ('std-1', 'tenant', ?, 10),
            ('std-1', 'tenant', ?, 20),
            ('std-1', 'allTenants', '', 0)`,
  ).run(TENANT_A, TENANT_B);

  db.prepare(
    `INSERT INTO drift_deviations
       (id, tenantId, standardKey, resourceId, kind, currentValue, expectedValue, state, lastSeenAt)
     VALUES ('dev-a', ?, 'CA-001', 'pol-1', 'mismatch', '"off"', '"on"', 'open', ?),
            ('dev-b', ?, 'CA-001', 'pol-2', 'mismatch', '"off"', '"on"', 'open', ?)`,
  ).run(TENANT_A, ts, TENANT_B, ts);

  db.prepare(
    `INSERT INTO scheduled_tasks
       (id, name, type, cron, timezone, targetScope, command, parameters, enabled, isSystem, createdAt, updatedAt)
     VALUES ('task-a', 'Alpha Task', 'standards', '0 0 * * * *', 'UTC', ?, 'Invoke-TestTask', '{}', 1, 0, ?, ?),
            ('task-b', 'Bravo Task', 'standards', '0 0 * * * *', 'UTC', ?, 'Invoke-TestTask', '{}', 1, 0, ?, ?),
            ('task-all', 'Global Task', 'assessment', '0 0 * * * *', 'UTC', '{"type":"all"}', 'Invoke-TestTask', '{}', 1, 0, ?, ?)`,
  ).run(
    JSON.stringify({ type: "tenant", id: TENANT_A }),
    ts,
    ts,
    JSON.stringify({ type: "tenant", id: TENANT_B }),
    ts,
    ts,
    ts,
    ts,
  );
}

async function readStreamBytes(stream: Readable): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string));
  }
  return Buffer.concat(chunks);
}

function maintenanceEnvelope(command: string): JobEnvelope {
  return {
    schemaVersion: "v1",
    jobId: "job-maint-1",
    jobType: "maintenance",
    tenantId: "all",
    runId: "run-maint-1",
    requestId: "req-maint-1",
    correlationId: "corr-maint-1",
    createdAt: NOW.toISOString(),
    payload: {
      contextRef: "schedules/system-backup-maintenance/context.json",
      outputRef: "schedules/system-backup-maintenance/run-maint-1",
      credentialRef: "schedules/system-backup-maintenance/credential",
      sectionRefs: [],
      artifactRefs: [],
      command,
    },
  };
}

describe("BACKUP_MAINTENANCE_TIMER", () => {
  it("matches the SystemTimer contract", () => {
    expect(BACKUP_MAINTENANCE_COMMAND).toBe("Invoke-BackupMaintenance");
    expect(BACKUP_MAINTENANCE_TIMER).toEqual({
      name: "backup-maintenance",
      cron: "0 0 3 * * *",
      type: "report",
      jobType: "maintenance",
      timezone: "UTC",
      command: "Invoke-BackupMaintenance",
    });
    expect(Object.isFrozen(BACKUP_MAINTENANCE_TIMER)).toBe(true);
  });
});

describe("createBackupsStore", () => {
  it("delegates backup metadata and config operations to SqliteRepository", async () => {
    const { db, store, schemaVersion } = createHarness();
    seedTenant(db, TENANT_A, "Alpha", "alpha.example.com");

    expect(store.schemaVersion).toBe(schemaVersion);

    const initialConfig = await store.getBackupConfig();
    expect(initialConfig).toMatchObject({
      id: "default",
      retentionDays: 30,
      replicationTarget: null,
    });

    const updatedConfig = await store.upsertBackupConfig({
      retentionDays: 14,
      replicationTarget: "backups-replica",
    });
    expect(updatedConfig).toMatchObject({
      id: "default",
      retentionDays: 14,
      replicationTarget: "backups-replica",
    });

    const created = await store.createBackup({
      id: "bk-repo-1",
      type: "tenant",
      tenantId: TENANT_A,
      createdBy: "operator-1",
      schemaVersion,
      artifactRef: "backups/bk-repo-1.zip",
      checksum: "a".repeat(64),
      createdAt: "2026-10-01T00:00:00.000Z",
    });
    expect(created.id).toBe("bk-repo-1");
    await expect(store.getBackup("bk-repo-1")).resolves.toEqual(created);
    await expect(store.getBackup("bk-repo-1", { tenantId: TENANT_B })).resolves.toBeUndefined();
    await expect(store.listBackups({ tenantId: TENANT_A })).resolves.toEqual([created]);
    await expect(store.deleteBackup("bk-repo-1")).resolves.toBe(true);
    await expect(store.getBackup("bk-repo-1")).resolves.toBeUndefined();
  });

  it("maps allow-listed logical tables, returns undefined for unknown/missing tables, and filters strictly by tenantId", async () => {
    const { db, store } = createHarness();
    seedInstanceConfig(db);
    seedTenantConfig(db);

    expect(await store.readTable("audit_events")).toBeUndefined();
    expect(await store.readTable("unknown_table")).toBeUndefined();
    expect(await store.readTable("__proto__")).toBeUndefined();

    // Missing from sqlite_master even though present in the allow-list.
    db.exec("DROP TABLE template_library_items");
    expect(await store.readTable("templates")).toBeUndefined();

    // Unfiltered reads cover every mapped table.
    const allTenants = await store.readTable("tenants");
    expect(allTenants?.map((r) => r["id"]).sort()).toEqual([TENANT_A, TENANT_B]);

    const allSettings = await store.readTable("settings");
    expect(allSettings?.map((r) => r["key"])).toEqual(["general.portalName"]);

    const allRoles = await store.readTable("roles");
    expect(allRoles?.some((r) => r["id"] === "custom-auditor")).toBe(true);

    // Tenant-filtered reads never leak another tenant or global rows.
    const tenantOnly = await store.readTable("tenants", { tenantId: TENANT_A });
    expect(tenantOnly?.map((r) => r["id"])).toEqual([TENANT_A]);

    const alertsA = await store.readTable("alerts", { tenantId: TENANT_A });
    expect(alertsA?.map((r) => r["id"])).toEqual(["rule-a"]);

    const assignmentsA = await store.readTable("template_assignments", { tenantId: TENANT_A });
    expect(assignmentsA).toEqual([
      { templateId: "std-1", targetType: "tenant", targetId: TENANT_A, precedence: 10 },
    ]);

    const driftA = await store.readTable("drift_deviations", { tenantId: TENANT_A });
    expect(driftA?.map((r) => r["id"])).toEqual(["dev-a"]);

    const tasksA = await store.readTable("scheduled_tasks", { tenantId: TENANT_A });
    expect(tasksA?.map((r) => r["id"])).toEqual(["task-a"]);
  });

  it("replaces table rows matching PRAGMA table_info columns and respects tenant scope", async () => {
    const { db, store } = createHarness();
    seedInstanceConfig(db);
    seedTenantConfig(db);

    // Extra columns not in PRAGMA table_info are ignored cleanly.
    await store.replaceTable("settings", [
      {
        key: "general.portalName",
        value: '"Restored Portal"',
        scope: "global",
        updatedAt: "2026-10-02T00:00:00.000Z",
        updatedBy: "operator-2",
        ignoredExtraColumn: "drop-me",
      },
    ]);
    expect(await store.readTable("settings")).toEqual([
      {
        key: "general.portalName",
        value: '"Restored Portal"',
        scope: "global",
        updatedAt: "2026-10-02T00:00:00.000Z",
        updatedBy: "operator-2",
      },
    ]);

    // Tenant-scoped replaceTable leaves tenant-b and global rows untouched.
    await store.replaceTable(
      "drift_deviations",
      [
        {
          id: "dev-a-restored",
          tenantId: TENANT_A,
          standardKey: "CA-002",
          resourceId: "pol-9",
          kind: "extra",
          currentValue: '"x"',
          expectedValue: null,
          state: "accepted",
          reason: "approved",
          expiresOn: null,
          autoRemediateOnExpiry: false,
          overrideValue: null,
          lastSeenAt: "2026-10-02T00:00:00.000Z",
        },
      ],
      { tenantId: TENANT_A },
    );

    const allDeviations = await store.readTable("drift_deviations");
    expect(allDeviations?.map((r) => r["id"]).sort()).toEqual(["dev-a-restored", "dev-b"]);

    // Refuses cross-tenant rows during tenant-scoped replaceTable.
    await expect(
      store.replaceTable(
        "drift_deviations",
        [
          {
            id: "dev-hijack",
            tenantId: TENANT_B,
            standardKey: "CA-003",
            resourceId: "pol-3",
            kind: "mismatch",
            state: "open",
            lastSeenAt: "2026-10-02T00:00:00.000Z",
          },
        ],
        { tenantId: TENANT_A },
      ),
    ).rejects.toThrow(/tenant/);

    // Rejects unknown tables.
    await expect(store.replaceTable("unknown_table", [])).rejects.toThrow(/unknown or missing/);
  });

  it("backs up and restores instance configuration end-to-end with pre-restore backup and idempotency", async () => {
    const { db, store, artifacts, schemaVersion } = createHarness();
    seedInstanceConfig(db);

    let nextId = 0;
    const instanceResult = await createInstanceBackup(
      {
        store,
        artifacts,
        instanceVersion: INSTANCE_VERSION,
        now: () => new Date("2026-10-01T00:00:00.000Z"),
        newId: () => `bk-inst-${(nextId += 1)}`,
      },
      { createdBy: "operator-1" },
    );

    expect(instanceResult.collection.included).toEqual([
      "tenants",
      "roles",
      "templates",
      "alerts",
      "settings",
    ]);
    expect(instanceResult.collection.skipped).toEqual([]);
    expect(await artifacts.exists(instanceResult.backup.artifactRef)).toBe(true);

    // Mutate instance configuration after the backup.
    db.prepare("UPDATE tenants SET displayName = 'Mutated Alpha' WHERE id = ?").run(TENANT_A);
    db.prepare("DELETE FROM roles WHERE id = 'custom-auditor'").run();
    db.prepare(
      "UPDATE app_settings SET value = '\"Mutated\"' WHERE key = 'general.portalName'",
    ).run();

    const archive = await artifacts.read(instanceResult.backup.artifactRef);
    const idempotency = createMemoryRestoreIdempotencyStore();
    const restoreResult = await applyRestore({
      store,
      archive,
      backupId: instanceResult.backup.id,
      createdBy: "admin-1",
      idempotencyKey: "restore-inst-1",
      idempotency,
      now: () => new Date("2026-10-02T00:00:00.000Z"),
      preRestoreBackup: async () => {
        const pre = await createInstanceBackup(
          {
            store,
            artifacts,
            instanceVersion: INSTANCE_VERSION,
            now: () => new Date("2026-10-02T00:00:00.000Z"),
            newId: () => `bk-pre-${(nextId += 1)}`,
          },
          { createdBy: "admin-1" },
        );
        return {
          backupId: pre.backup.id,
          artifactRef: pre.backup.artifactRef,
          checksum: pre.backup.checksum,
          schemaVersion: pre.backup.schemaVersion,
        };
      },
    });

    expect(restoreResult.replayed).toBe(false);
    expect(restoreResult.schemaVersion).toBe(schemaVersion);
    expect(restoreResult.preRestoreBackupId).toBe("bk-pre-2");
    expect(await artifacts.exists("backups/bk-pre-2.zip")).toBe(true);

    const restoredTenants = await store.readTable("tenants");
    expect(restoredTenants?.find((r) => r["id"] === TENANT_A)?.["displayName"]).toBe("Alpha Corp");
    const restoredRoles = await store.readTable("roles");
    expect(restoredRoles?.some((r) => r["id"] === "custom-auditor")).toBe(true);
    const restoredSettings = await store.readTable("settings");
    expect(restoredSettings?.[0]?.["value"]).toBe('"Contoso Portal"');

    // Replaying the Idempotency-Key returns the prior outcome without restoring again.
    const replay = await applyRestore({
      store,
      archive,
      backupId: instanceResult.backup.id,
      createdBy: "admin-1",
      idempotencyKey: "restore-inst-1",
      idempotency,
      preRestoreBackup: async () => {
        throw new Error("should not create a second pre-restore backup");
      },
    });
    expect(replay.replayed).toBe(true);
    expect(replay.preRestoreBackupId).toBe("bk-pre-2");
  });

  it("backs up and restores a tenant without leaking or touching other tenants", async () => {
    const { db, store, artifacts, schemaVersion } = createHarness();
    seedInstanceConfig(db);
    seedTenantConfig(db);

    const tenantBackup = await createTenantBackup(
      {
        store,
        artifacts,
        instanceVersion: INSTANCE_VERSION,
        now: () => new Date("2026-10-01T00:00:00.000Z"),
        newId: () => "bk-tenant-a-1",
      },
      { tenantId: TENANT_A, createdBy: "operator-1" },
    );

    const archive = await artifacts.read(tenantBackup.backup.artifactRef);
    const parsed = readBackupArchive(archive, { instanceSchemaVersion: schemaVersion });
    expect(parsed.tables["template_assignments"]).toEqual([
      { templateId: "std-1", targetType: "tenant", targetId: TENANT_A, precedence: 10 },
    ]);
    expect(parsed.tables["drift_deviations"]?.map((r) => r["id"])).toEqual(["dev-a"]);
    expect(parsed.tables["scheduled_tasks"]?.map((r) => r["id"])).toEqual(["task-a"]);

    // Mutate both tenant A and tenant B state.
    db.prepare(
      "UPDATE template_assignments SET precedence = 99 WHERE targetType = 'tenant' AND targetId = ?",
    ).run(TENANT_A);
    db.prepare(
      "UPDATE template_assignments SET precedence = 77 WHERE targetType = 'tenant' AND targetId = ?",
    ).run(TENANT_B);
    db.prepare("UPDATE drift_deviations SET state = 'resolved' WHERE id = 'dev-a'").run();
    db.prepare("UPDATE drift_deviations SET state = 'accepted' WHERE id = 'dev-b'").run();
    db.prepare("UPDATE scheduled_tasks SET name = 'Alpha Mutated' WHERE id = 'task-a'").run();
    db.prepare("UPDATE scheduled_tasks SET name = 'Bravo Mutated' WHERE id = 'task-b'").run();

    await applyRestore({
      store,
      archive,
      backupId: tenantBackup.backup.id,
      createdBy: "admin-1",
      idempotencyKey: "restore-tenant-a-1",
      filter: { tenantId: TENANT_A },
      idempotency: createMemoryRestoreIdempotencyStore(),
      preRestoreBackup: async () => {
        const pre = await createTenantBackup(
          {
            store,
            artifacts,
            instanceVersion: INSTANCE_VERSION,
            now: () => new Date("2026-10-02T00:00:00.000Z"),
            newId: () => "bk-tenant-a-pre",
          },
          { tenantId: TENANT_A, createdBy: "admin-1" },
        );
        return {
          backupId: pre.backup.id,
          artifactRef: pre.backup.artifactRef,
          checksum: pre.backup.checksum,
          schemaVersion: pre.backup.schemaVersion,
        };
      },
    });

    // Tenant A was restored.
    expect(await store.readTable("template_assignments", { tenantId: TENANT_A })).toEqual([
      { templateId: "std-1", targetType: "tenant", targetId: TENANT_A, precedence: 10 },
    ]);
    expect(
      (await store.readTable("drift_deviations", { tenantId: TENANT_A }))?.[0]?.["state"],
    ).toBe("open");
    expect((await store.readTable("scheduled_tasks", { tenantId: TENANT_A }))?.[0]?.["name"]).toBe(
      "Alpha Task",
    );

    // Tenant B and global assignments/tasks remained untouched.
    expect(await store.readTable("template_assignments", { tenantId: TENANT_B })).toEqual([
      { templateId: "std-1", targetType: "tenant", targetId: TENANT_B, precedence: 77 },
    ]);
    expect(
      (await store.readTable("drift_deviations", { tenantId: TENANT_B }))?.[0]?.["state"],
    ).toBe("accepted");
    expect((await store.readTable("scheduled_tasks", { tenantId: TENANT_B }))?.[0]?.["name"]).toBe(
      "Bravo Mutated",
    );
    const allTasks = await store.readTable("scheduled_tasks");
    expect(allTasks?.some((r) => r["id"] === "task-all")).toBe(true);
    const allAssignments = await store.readTable("template_assignments");
    expect(allAssignments?.some((r) => r["targetType"] === "allTenants")).toBe(true);
  });

  it("rolls back all tables on mid-apply restore failure while preserving pre-restore backup", async () => {
    const { db, store, artifacts } = createHarness();
    seedInstanceConfig(db);

    const backup = await createInstanceBackup(
      {
        store,
        artifacts,
        instanceVersion: INSTANCE_VERSION,
        now: () => new Date("2026-10-01T00:00:00.000Z"),
        newId: () => "bk-inst-rollback",
      },
      { createdBy: "operator-1" },
    );

    // Mutate tenants and settings after the backup.
    db.prepare("UPDATE tenants SET displayName = 'Keep On Rollback' WHERE id = ?").run(TENANT_A);
    db.prepare(
      "UPDATE app_settings SET value = '\"Keep Setting\"' WHERE key = 'general.portalName'",
    ).run();

    // Force the second table write (`settings`) to fail inside applyRestore's transaction.
    const archive = await artifacts.read(backup.backup.artifactRef);
    const failingStore = {
      ...store,
      schemaVersion: store.schemaVersion,
      readTable: store.readTable.bind(store),
      transaction: store.transaction.bind(store),
      async replaceTable(name: string, rows: readonly Record<string, unknown>[], filter?: { tenantId?: string }) {
        if (name === "settings") {
          throw new Error("simulated mid-apply failure on settings");
        }
        return store.replaceTable(name, rows, filter);
      },
    };

    await expect(
      applyRestore({
        store: failingStore,
        archive,
        backupId: backup.backup.id,
        createdBy: "admin-1",
        idempotencyKey: "restore-fail-1",
        idempotency: createMemoryRestoreIdempotencyStore(),
        preRestoreBackup: async () => {
          const pre = await createInstanceBackup(
            {
              store,
              artifacts,
              instanceVersion: INSTANCE_VERSION,
              now: () => new Date("2026-10-02T00:00:00.000Z"),
              newId: () => "bk-pre-survives",
            },
            { createdBy: "admin-1" },
          );
          return {
            backupId: pre.backup.id,
            artifactRef: pre.backup.artifactRef,
            checksum: pre.backup.checksum,
            schemaVersion: pre.backup.schemaVersion,
          };
        },
      }),
    ).rejects.toThrow("simulated mid-apply failure on settings");

    // Pre-restore backup survived outside the rolled-back transaction.
    expect(await store.getBackup("bk-pre-survives")).toBeDefined();
    expect(await artifacts.exists("backups/bk-pre-survives.zip")).toBe(true);

    // First table (`tenants`) was rolled back completely.
    const tenantsAfter = await store.readTable("tenants");
    expect(tenantsAfter?.find((r) => r["id"] === TENANT_A)?.["displayName"]).toBe("Keep On Rollback");
    expect((await store.readTable("settings"))?.[0]?.["value"]).toBe('"Keep Setting"');
    expect(db.inTransaction).toBe(false);
  });

  it("supports nested SAVEPOINT rollback and concurrent async transactions cleanly", async () => {
    const { db, store } = createHarness();
    seedInstanceConfig(db);

    await store.transaction(async () => {
      await Promise.resolve();
      await store.replaceTable("settings", [
        {
          key: "outer.key",
          value: '"outer"',
          scope: "global",
          updatedAt: "2026-10-02T00:00:00.000Z",
          updatedBy: "op",
        },
      ]);

      await expect(
        store.transaction(async () => {
          await Promise.resolve();
          await store.replaceTable("settings", [
            {
              key: "inner.key",
              value: '"inner"',
              scope: "global",
              updatedAt: "2026-10-02T00:00:00.000Z",
              updatedBy: "op",
            },
          ]);
          throw new Error("abort inner savepoint");
        }),
      ).rejects.toThrow("abort inner savepoint");
    });

    // Outer transaction committed; inner savepoint rolled back.
    expect(await store.readTable("settings")).toEqual([
      {
        key: "outer.key",
        value: '"outer"',
        scope: "global",
        updatedAt: "2026-10-02T00:00:00.000Z",
        updatedBy: "op",
      },
    ]);

    // Concurrent transactions serialize cleanly without nested-BEGIN errors.
    await Promise.all([
      store.transaction(async () => {
        await Promise.resolve();
        await store.replaceTable("settings", [
          {
            key: "concurrent.1",
            value: "1",
            scope: "global",
            updatedAt: "2026-10-02T00:00:00.000Z",
            updatedBy: "op",
          },
        ]);
      }),
      store.transaction(async () => {
        await Promise.resolve();
        await store.replaceTable("settings", [
          {
            key: "concurrent.2",
            value: "2",
            scope: "global",
            updatedAt: "2026-10-02T00:00:00.000Z",
            updatedBy: "op",
          },
        ]);
      }),
    ]);

    expect(await store.readTable("settings")).toEqual([
      {
        key: "concurrent.2",
        value: "2",
        scope: "global",
        updatedAt: "2026-10-02T00:00:00.000Z",
        updatedBy: "op",
      },
    ]);
    expect(db.inTransaction).toBe(false);
  });
});

describe("createBackupsArtifactTier", () => {
  it("supports write, read, exists, stat, readStream, and remove", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "m365-tier-"));
    tempDirs.push(root);
    const tier = createBackupsArtifactTier(root);
    const ref = "backups/bk-1.zip";
    const payload = Buffer.from("zip-archive-bytes");

    expect(await tier.exists(ref)).toBe(false);
    expect(await tier.exists(".")).toBe(false);

    await tier.write(ref, payload);
    expect(await tier.exists(ref)).toBe(true);
    expect(await tier.exists("backups")).toBe(false);
    expect(await tier.read(ref)).toEqual(payload);
    expect(await tier.stat(ref)).toEqual({ size: payload.length });
    expect(await readStreamBytes(tier.readStream(ref))).toEqual(payload);

    await tier.remove(ref);
    expect(await tier.exists(ref)).toBe(false);
  });

  it("rejects path traversal on every artifact method", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "m365-tier-sec-"));
    tempDirs.push(root);
    const tier = createBackupsArtifactTier(root);

    for (const badRef of ["../escape.zip", "backups/../../escape.zip", "/abs/escape.zip", "bad\0ref"]) {
      await expect(tier.write(badRef, Buffer.from("x"))).rejects.toThrow(/escapes/);
      await expect(tier.read(badRef)).rejects.toThrow(/escapes/);
      await expect(tier.exists(badRef)).rejects.toThrow(/escapes/);
      await expect(tier.stat(badRef)).rejects.toThrow(/escapes/);
      await expect(tier.remove(badRef)).rejects.toThrow(/escapes/);
      expect(() => tier.readStream(badRef)).toThrow(/escapes/);
    }
    await expect(tier.read(".")).rejects.toThrow(/escapes/);
  });
});

describe("createBackupMaintenanceCommand", () => {
  it("prunes expired backups and replicates the latest remaining backup idempotently", async () => {
    const { store, artifacts, schemaVersion } = createHarness();
    const audits: Record<string, unknown>[] = [];

    await store.upsertBackupConfig({
      retentionDays: 30,
      replicationTarget: "backups-replica",
    });

    const expiredBytes = Buffer.from("expired-archive");
    const olderFreshBytes = Buffer.from("older-fresh-archive");
    const newestFreshBytes = Buffer.from("newest-fresh-archive");

    await artifacts.write("backups/bk-expired.zip", expiredBytes);
    await artifacts.write("backups/bk-fresh-1.zip", olderFreshBytes);
    await artifacts.write("backups/bk-fresh-2.zip", newestFreshBytes);

    await store.createBackup({
      id: "bk-expired",
      type: "instance",
      tenantId: null,
      createdBy: "operator-1",
      schemaVersion,
      artifactRef: "backups/bk-expired.zip",
      checksum: "1".repeat(64),
      createdAt: "2026-08-01T00:00:00.000Z",
    });
    await store.createBackup({
      id: "bk-fresh-1",
      type: "instance",
      tenantId: null,
      createdBy: "operator-1",
      schemaVersion,
      artifactRef: "backups/bk-fresh-1.zip",
      checksum: "2".repeat(64),
      createdAt: "2026-10-01T00:00:00.000Z",
    });
    await store.createBackup({
      id: "bk-fresh-2",
      type: "instance",
      tenantId: null,
      createdBy: "operator-1",
      schemaVersion,
      artifactRef: "backups/bk-fresh-2.zip",
      checksum: "3".repeat(64),
      createdAt: "2026-10-10T00:00:00.000Z",
    });

    const command = createBackupMaintenanceCommand({
      store,
      artifacts,
      now: () => NOW,
      audit: async (event) => {
        audits.push(event);
      },
    });

    // First run prunes expired and replicates latest.
    const first = await command();
    expect(first).toMatchObject({
      status: "succeeded",
      exitCode: 0,
      prune: {
        pruned: ["bk-expired"],
        retained: ["bk-fresh-1", "bk-fresh-2"],
      },
      replication: {
        replicated: true,
        alreadyReplicated: false,
        sourceBackupId: "bk-fresh-2",
        sourceRef: "backups/bk-fresh-2.zip",
        targetRef: "backups-replica/bk-fresh-2.zip",
      },
    });
    expect(await store.getBackup("bk-expired")).toBeUndefined();
    expect(await artifacts.exists("backups/bk-expired.zip")).toBe(false);
    expect(await artifacts.exists("backups-replica/bk-fresh-2.zip")).toBe(true);
    expect(await artifacts.read("backups-replica/bk-fresh-2.zip")).toEqual(newestFreshBytes);
    expect(audits.map((e) => e["action"])).toEqual(["backup.prune", "backup.replicate"]);

    // Second run is idempotent via the maintenance runner too.
    const runner = createMaintenanceRunner({
      handlers: {
        [BACKUP_MAINTENANCE_COMMAND]: command,
      },
    });
    const envelopeResult = await runner(
      maintenanceEnvelope(BACKUP_MAINTENANCE_COMMAND),
      new AbortController().signal,
    );
    expect(envelopeResult).toMatchObject({
      jobType: "maintenance",
      status: "succeeded",
      exitCode: 0,
    });

    const second = await command();
    expect(second.prune.pruned).toEqual([]);
    expect(second.prune.retained).toEqual(["bk-fresh-1", "bk-fresh-2"]);
    expect(second.replication).toEqual({
      replicated: false,
      alreadyReplicated: true,
      sourceBackupId: "bk-fresh-2",
      sourceRef: "backups/bk-fresh-2.zip",
      targetRef: "backups-replica/bk-fresh-2.zip",
    });
    expect(audits).toHaveLength(2);
  });

  it("falls back to default retention and skips replication when config is missing or target is null", async () => {
    const { store: baseStore, artifacts, schemaVersion } = createHarness();
    // Simulate a missing config through the store, not raw SQL: backup SQL lives only in portal/db (ADR-0015).
    const store = { ...baseStore, getBackupConfig: async () => undefined };

    await artifacts.write("backups/bk-old.zip", Buffer.from("old"));
    await store.createBackup({
      id: "bk-old",
      type: "instance",
      tenantId: null,
      createdBy: "operator-1",
      schemaVersion,
      artifactRef: "backups/bk-old.zip",
      checksum: "4".repeat(64),
      createdAt: "2026-08-01T00:00:00.000Z",
    });

    const command = createBackupMaintenanceCommand({
      store,
      artifacts,
      now: () => NOW,
    });
    const outcome = await command();

    expect(outcome.prune.pruned).toEqual(["bk-old"]);
    expect(outcome.replication).toEqual({
      replicated: false,
      alreadyReplicated: false,
      sourceBackupId: null,
      sourceRef: null,
      targetRef: null,
    });
  });

  it("integrates with backup, backup-settings, and restore routes on a temp WAL SQLite DB", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "m365-backup-wal-"));
    tempDirs.push(dir);
    const db = new Database(path.join(dir, "portal.db"));
    openDbs.push(db);
    const journalMode = String(db.pragma("journal_mode = WAL", { simple: true }) ?? "memory");
    db.pragma("foreign_keys = ON");
    const schemaVersion = runMigrations(db, loadMigrations());
    const repo = new SqliteRepository(db, schemaVersion, journalMode);
    const store = createBackupsStore(db, repo);
    const artifacts = createBackupsArtifactTier(dir);

    seedInstanceConfig(db);

    const caller = {
      tenantScope: tenantScope([TENANT_A, TENANT_B]),
      permissions: ["*"],
      userId: "admin-1",
    };

    const backupRoutes = createBackupRoutes({
      store,
      artifacts,
      instanceVersion: INSTANCE_VERSION,
      resolveCaller: () => caller,
    });
    const settingsRoutes = createBackupSettingsRoutes({
      store,
      resolveCaller: () => caller,
    });
    const restoreRoutes = createBackupsRestoreRoutes({
      store,
      artifacts,
      instanceVersion: INSTANCE_VERSION,
      resolveCaller: () => caller,
    });

    const putRes = await settingsRoutes[1]!.handler({
      method: "PUT",
      path: "/v1/backup-settings",
      params: {},
      query: new URLSearchParams(),
      headers: {},
      body: { retentionDays: 7, replicationTarget: "backups-replica" },
      correlationId: "corr-settings",
    });
    expect(putRes.status).toBe(200);

    const createRes = await backupRoutes[1]!.handler({
      method: "POST",
      path: "/v1/backups",
      params: {},
      query: new URLSearchParams(),
      headers: {},
      body: { type: "instance" },
      correlationId: "corr-create",
    });
    expect(createRes.status).toBe(201);
    const createdId = (createRes.body as { id: string }).id;

    const downloadRes = await backupRoutes[2]!.handler({
      method: "GET",
      path: "/v1/backups/:id/download",
      params: { id: createdId },
      query: new URLSearchParams(),
      headers: {},
      correlationId: "corr-dl",
    });
    expect(downloadRes.status).toBe(200);
    const downloadedBytes = await readStreamBytes(downloadRes.stream!);
    expect(downloadedBytes.length).toBeGreaterThan(0);

    db.prepare("UPDATE tenants SET displayName = 'Temp Changed' WHERE id = ?").run(TENANT_A);

    const restoreRes = await restoreRoutes[0]!.handler({
      method: "POST",
      path: "/v1/backups/:id/restore",
      params: { id: createdId },
      query: new URLSearchParams(),
      headers: { "idempotency-key": "wal-restore-1" },
      body: { confirm: true },
      correlationId: "corr-restore",
    });
    expect(restoreRes.status).toBe(200);
    expect((await store.readTable("tenants", { tenantId: TENANT_A }))?.[0]?.["displayName"]).toBe(
      "Alpha Corp",
    );

    const delRes = await backupRoutes[3]!.handler({
      method: "DELETE",
      path: "/v1/backups/:id",
      params: { id: createdId },
      query: new URLSearchParams(),
      headers: {},
      correlationId: "corr-del",
    });
    expect(delRes.status).toBe(204);
    expect(await artifacts.exists(`backups/${createdId}.zip`)).toBe(false);
  });
});
