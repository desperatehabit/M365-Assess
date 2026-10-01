import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import type { BackupInput, BackupType, TenantInput } from "./repository.js";
import { loadMigrations, openSqliteRepository } from "./sqlite-repository.js";

const TENANT_A = "11111111-1111-1111-1111-111111111111";
const TENANT_B = "22222222-2222-2222-2222-222222222222";

const tempDirs: string[] = [];

function tempDbPath(): string {
  const dir = mkdtempSync(join(tmpdir(), "m365-backups-"));
  tempDirs.push(dir);
  return join(dir, "portal.db");
}

afterEach(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
  tempDirs.length = 0;
});

function tenant(id: string): TenantInput {
  return {
    id,
    displayName: `Tenant ${id.slice(0, 4)}`,
    defaultDomain: null,
    initialDomain: null,
    source: "direct",
    status: "active",
    excluded: false,
    lastRunAt: null,
    errorCount: 0,
  };
}

function backup(id: string, type: BackupType, extra: Partial<BackupInput> = {}): BackupInput {
  return {
    id,
    type,
    tenantId: type === "tenant" ? TENANT_A : null,
    createdBy: "operator-1",
    schemaVersion: 86,
    artifactRef: `backups/${id}.json`,
    checksum: "sha256:0000000000000000000000000000000000000000000000000000000000000000",
    ...extra,
  };
}

function columns(filename: string, table: string): string[] {
  const raw = new Database(filename);
  try {
    return (raw.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map(
      (row) => row.name,
    );
  } finally {
    raw.close();
  }
}

describe("migration 0043", () => {
  it("creates the SPEC §5 tables, is re-runnable, and advances SchemaVersion", async () => {
    const filename = tempDbPath();
    const expected = loadMigrations().reduce((max, migration) => Math.max(max, migration.version), 0);
    expect(expected).toBeGreaterThanOrEqual(43);

    const first = await openSqliteRepository({ filename });
    expect(first.schemaVersion).toBe(expected);
    first.close();

    expect(columns(filename, "backups")).toEqual(
      expect.arrayContaining([
        "id",
        "type",
        "tenantId",
        "createdAt",
        "createdBy",
        "schemaVersion",
        "artifactRef",
        "checksum",
      ]),
    );
    expect(columns(filename, "backup_config")).toEqual(
      expect.arrayContaining(["id", "scheduleId", "retentionDays", "replicationTarget"]),
    );

    const second = await openSqliteRepository({ filename });
    expect(second.schemaVersion).toBe(expected);
    second.close();

    const raw = new Database(filename);
    try {
      expect(
        raw.prepare("SELECT COUNT(*) AS c FROM schema_versions WHERE version = 43").get(),
      ).toMatchObject({ c: 1 });
      expect(raw.prepare("SELECT COUNT(*) AS c FROM backup_config").get()).toMatchObject({ c: 1 });
    } finally {
      raw.close();
    }
  });
});

describe("secret-free schema", () => {
  it("has no backup column that could store a secret value", async () => {
    const filename = tempDbPath();
    const repo = await openSqliteRepository({ filename });
    repo.close();

    const forbidden =
      /secret|token|password|passwd|credential|private|apikey|key|blob|bytes|content|value/i;
    for (const table of ["backups", "backup_config"]) {
      for (const name of columns(filename, table)) {
        expect(name).not.toMatch(forbidden);
      }
    }
  });
});

describe("repository surface", () => {
  it("exposes backup list/get/create/delete and config get/upsert", async () => {
    const repo = await openSqliteRepository({ filename: tempDbPath() });
    const surface = repo as unknown as Record<string, unknown>;
    for (const method of [
      "listBackups",
      "getBackup",
      "createBackup",
      "deleteBackup",
      "getBackupConfig",
      "upsertBackupConfig",
    ]) {
      expect(typeof surface[method]).toBe("function");
    }
    repo.close();
  });
});

describe("backups", () => {
  it("round-trips an instance backup and a tenant backup", async () => {
    const repo = await openSqliteRepository({ filename: tempDbPath() });
    await repo.upsertTenant(tenant(TENANT_A));
    const instance = await repo.createBackup(backup("bk-instance", "instance"));
    const scoped = await repo.createBackup(backup("bk-tenant-a", "tenant"));

    expect(instance.tenantId).toBeNull();
    expect(scoped.tenantId).toBe(TENANT_A);
    expect(await repo.getBackup("bk-instance")).toEqual(instance);
    expect(await repo.getBackup("bk-tenant-a")).toEqual(scoped);
    repo.close();
  });

  it("scopes tenant-type backups to their tenant", async () => {
    const repo = await openSqliteRepository({ filename: tempDbPath() });
    await repo.upsertTenant(tenant(TENANT_A));
    await repo.upsertTenant(tenant(TENANT_B));
    await repo.createBackup(backup("bk-instance", "instance"));
    await repo.createBackup(backup("bk-tenant-a", "tenant", { tenantId: TENANT_A }));
    await repo.createBackup(backup("bk-tenant-b", "tenant", { tenantId: TENANT_B }));

    expect((await repo.listBackups({ tenantId: TENANT_A })).map((row) => row.id)).toEqual([
      "bk-tenant-a",
    ]);
    expect((await repo.listBackups({ type: "instance" })).map((row) => row.id)).toEqual([
      "bk-instance",
    ]);
    expect(await repo.getBackup("bk-tenant-a", { tenantId: TENANT_B })).toBeUndefined();
    expect(await repo.getBackup("bk-tenant-a", { tenantId: TENANT_A })).toBeDefined();
    repo.close();
  });

  it("rejects a tenant backup without a tenantId and an instance backup with one", async () => {
    const repo = await openSqliteRepository({ filename: tempDbPath() });
    await expect(
      repo.createBackup(backup("bk-bad", "tenant", { tenantId: null })),
    ).rejects.toThrow(/tenantId/);
    await expect(
      repo.createBackup(backup("bk-bad", "instance", { tenantId: TENANT_A })),
    ).rejects.toThrow(/tenantId/);
    repo.close();
  });

  it("deletes a backup once and reports the second delete", async () => {
    const repo = await openSqliteRepository({ filename: tempDbPath() });
    await repo.createBackup(backup("bk-instance", "instance"));
    expect(await repo.deleteBackup("bk-instance")).toBe(true);
    expect(await repo.getBackup("bk-instance")).toBeUndefined();
    expect(await repo.deleteBackup("bk-instance")).toBe(false);
    repo.close();
  });
});

describe("backup audit", () => {
  it("writes an AuditEvent for create and delete", async () => {
    const repo = await openSqliteRepository({ filename: tempDbPath() });
    await repo.upsertTenant(tenant(TENANT_A));
    await repo.createBackup(backup("bk-tenant-a", "tenant"));
    await repo.deleteBackup("bk-tenant-a");

    const events = await repo.listAuditEvents();
    const created = events.filter((event) => event.action === "backup.create");
    const deleted = events.filter((event) => event.action === "backup.delete");
    expect(created).toHaveLength(1);
    expect(created[0]?.targetId).toBe("bk-tenant-a");
    expect(created[0]?.tenantId).toBe(TENANT_A);
    expect(deleted).toHaveLength(1);
    expect(deleted[0]?.targetId).toBe("bk-tenant-a");
    expect(deleted[0]?.before).toMatchObject({ id: "bk-tenant-a", type: "tenant" });
    repo.close();
  });
});

describe("backup config", () => {
  it("returns the default singleton and upserts retention/replication", async () => {
    const filename = tempDbPath();
    const repo = await openSqliteRepository({ filename });
    expect(await repo.getBackupConfig()).toMatchObject({
      id: "default",
      retentionDays: 30,
      scheduleId: null,
      replicationTarget: null,
    });

    const updated = await repo.upsertBackupConfig({
      retentionDays: 14,
      replicationTarget: "backups-secondary",
    });
    expect(updated).toMatchObject({
      id: "default",
      retentionDays: 14,
      replicationTarget: "backups-secondary",
    });
    expect(await repo.getBackupConfig()).toEqual(updated);

    const cleared = await repo.upsertBackupConfig({ retentionDays: 14, replicationTarget: null });
    expect(cleared.replicationTarget).toBeNull();
    repo.close();

    const raw = new Database(filename);
    try {
      expect(raw.prepare("SELECT COUNT(*) AS c FROM backup_config").get()).toMatchObject({ c: 1 });
    } finally {
      raw.close();
    }
  });
});
