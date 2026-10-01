// Tests for the backup restore route: admin gate, explicit confirmation,
// Idempotency-Key requirement and replay, tenant scope, pre-restore backup,
// per-table transaction, and the OpenAPI fragment (EPIC-035 §4.2, §6, §7, §8;
// T-0687).
import { describe, expect, it } from "vitest";
import type { Backup, BackupInput, BackupRow } from "@m365-assess/db";
import {
  BACKUP_ARCHIVE_SCHEMA_MISMATCH,
  packBackupArchive,
  type BackupTableDump,
} from "../backup/archive.js";
import type { BackupTableFilter } from "../backup/collect.js";
import { tenantScope } from "../rbac/scope.js";
import {
  BACKUP_RESTORE_ADMIN_SCOPE,
  BACKUP_RESTORE_CONFIRM_REQUIRED,
  BACKUP_RESTORE_PATH,
  BACKUPS_RESTORE_OPENAPI,
  createBackupsRestoreRoutes,
  type BackupsRestoreArtifactStore,
  type BackupsRestoreCaller,
  type BackupsRestoreRouteOptions,
  type BackupsRestoreStore,
} from "./backups-restore.js";
import { BACKUP_ARTIFACT_MISSING } from "./backups.js";

const TENANT_A = "tenant-a";
const TENANT_B = "tenant-b";
const SCHEMA_VERSION = 43;
const INSTANCE_VERSION = "test-instance-1.0.0";

const ARCHIVE_TABLES: readonly BackupTableDump[] = [
  { name: "tenants", rows: [{ id: "tenant-a", displayName: "Alpha" }] },
  { name: "settings", rows: [{ id: "theme", value: "dark" }] },
];

function archive(): Buffer {
  return packBackupArchive({
    schemaVersion: SCHEMA_VERSION,
    instanceVersion: INSTANCE_VERSION,
    tables: ARCHIVE_TABLES,
    createdAt: "2026-09-30T00:00:00.000Z",
  });
}

function backupRow(id: string, type: "instance" | "tenant", tenantId: string | null = null): Backup {
  return {
    id,
    type,
    tenantId,
    createdAt: "2026-09-30T00:00:00.000Z",
    createdBy: "operator-1",
    schemaVersion: SCHEMA_VERSION,
    artifactRef: `backups/${id}.zip`,
    checksum: "a".repeat(64),
  };
}

class FakeRestoreStore implements BackupsRestoreStore {
  readonly schemaVersion: number;
  readonly backups = new Map<string, Backup>();
  readonly tables = new Map<string, BackupRow[]>();
  readonly writes: string[] = [];
  readonly filters: Array<BackupTableFilter | undefined> = [];
  transactionCalls = 0;

  constructor(schemaVersion: number = SCHEMA_VERSION) {
    this.schemaVersion = schemaVersion;
  }

  async readTable(
    name: string,
    filter?: BackupTableFilter,
  ): Promise<readonly BackupRow[] | undefined> {
    const rows = this.tables.get(name);
    if (rows === undefined) return undefined;
    if (filter?.tenantId === undefined) return rows;
    return rows.filter((row) => row["tenantId"] === filter.tenantId);
  }

  async replaceTable(
    name: string,
    rows: readonly BackupRow[],
    filter?: BackupTableFilter,
  ): Promise<void> {
    this.writes.push(name);
    this.filters.push(filter);
    this.tables.set(name, [...rows]);
  }

  async transaction<T>(work: () => Promise<T>): Promise<T> {
    this.transactionCalls += 1;
    const snapshot = new Map([...this.tables].map(([name, rows]) => [name, [...rows]]));
    try {
      return await work();
    } catch (error) {
      this.tables.clear();
      for (const [name, rows] of snapshot) {
        this.tables.set(name, rows);
      }
      throw error;
    }
  }

  async getBackup(backupId: string): Promise<Backup | undefined> {
    return this.backups.get(backupId);
  }

  async createBackup(input: BackupInput): Promise<Backup> {
    const row: Backup = {
      id: input.id,
      type: input.type,
      tenantId: input.tenantId,
      createdAt: input.createdAt ?? "2026-09-30T00:00:00.000Z",
      createdBy: input.createdBy,
      schemaVersion: input.schemaVersion,
      artifactRef: input.artifactRef,
      checksum: input.checksum,
    };
    this.backups.set(row.id, row);
    return row;
  }
}

class FakeRestoreArtifacts implements BackupsRestoreArtifactStore {
  readonly files = new Map<string, Buffer>();

  async write(ref: string, bytes: Buffer): Promise<void> {
    this.files.set(ref, bytes);
  }

  async read(ref: string): Promise<Buffer> {
    const bytes = this.files.get(ref);
    if (bytes === undefined) {
      throw new Error(`ENOENT: no such file '${ref}'`);
    }
    return bytes;
  }
}

function adminCaller(scope: readonly string[] = [TENANT_A]): BackupsRestoreCaller {
  return {
    tenantScope: tenantScope(scope),
    permissions: [BACKUP_RESTORE_ADMIN_SCOPE],
    userId: "operator-1",
  };
}

function restoreCtx(
  id: string,
  options: {
    readonly headers?: Record<string, string>;
    readonly body?: Record<string, unknown>;
  } = {},
) {
  return {
    method: "POST",
    path: BACKUP_RESTORE_PATH,
    params: { id },
    query: new URLSearchParams(),
    headers: options.headers ?? {},
    body: options.body ?? { confirm: true },
    correlationId: "corr-1",
  };
}

function makeOptions(
  store: FakeRestoreStore,
  artifacts: FakeRestoreArtifacts,
  overrides: Partial<BackupsRestoreRouteOptions> = {},
): BackupsRestoreRouteOptions {
  let ids = 0;
  return {
    store,
    artifacts,
    instanceVersion: INSTANCE_VERSION,
    resolveCaller: () => adminCaller(),
    now: () => new Date("2026-10-01T00:00:00.000Z"),
    newId: () => `pre-backup-${(ids += 1)}`,
    ...overrides,
  };
}

describe("Backup restore route (T-0687)", () => {
  it("exposes POST /v1/backups/:id/restore", () => {
    const routes = createBackupsRestoreRoutes(
      makeOptions(new FakeRestoreStore(), new FakeRestoreArtifacts()),
    );
    expect(routes.map((route) => `${route.method} ${route.path}`)).toEqual([
      `POST ${BACKUP_RESTORE_PATH}`,
    ]);
  });

  it("rejects unauthenticated requests with 401", async () => {
    const routes = createBackupsRestoreRoutes(
      makeOptions(new FakeRestoreStore(), new FakeRestoreArtifacts(), {
        resolveCaller: () => undefined,
      }),
    );
    await expect(routes[0]!.handler(restoreCtx("bk-1"))).rejects.toMatchObject({
      status: 401,
      code: "request.unauthenticated",
    });
  });

  it("refuses a caller without the admin scope with 403", async () => {
    const routes = createBackupsRestoreRoutes(
      makeOptions(new FakeRestoreStore(), new FakeRestoreArtifacts(), {
        resolveCaller: () => ({
          tenantScope: tenantScope([TENANT_A]),
          permissions: ["backup.write"],
          userId: "operator-1",
        }),
      }),
    );
    await expect(routes[0]!.handler(restoreCtx("bk-1"))).rejects.toMatchObject({
      status: 403,
      code: "auth.forbidden",
    });
  });

  it("maps a missing backup to the structured 404", async () => {
    const routes = createBackupsRestoreRoutes(
      makeOptions(new FakeRestoreStore(), new FakeRestoreArtifacts()),
    );
    await expect(routes[0]!.handler(restoreCtx("bk-missing"))).rejects.toMatchObject({
      status: 404,
      code: "backup.not_found",
    });
  });

  it("refuses a restore of another tenant's backup with 403", async () => {
    const store = new FakeRestoreStore();
    store.backups.set("bk-tenant-b", backupRow("bk-tenant-b", "tenant", TENANT_B));
    const routes = createBackupsRestoreRoutes(
      makeOptions(store, new FakeRestoreArtifacts(), {
        resolveCaller: () => adminCaller([TENANT_A]),
      }),
    );
    await expect(routes[0]!.handler(restoreCtx("bk-tenant-b"))).rejects.toMatchObject({
      status: 403,
      code: "auth.forbidden",
    });
  });

  it("requires explicit confirmation with 400", async () => {
    const store = new FakeRestoreStore();
    store.backups.set("bk-1", backupRow("bk-1", "instance"));
    const routes = createBackupsRestoreRoutes(makeOptions(store, new FakeRestoreArtifacts()));

    await expect(
      routes[0]!.handler(restoreCtx("bk-1", { body: { confirm: false } })),
    ).rejects.toMatchObject({ status: 400, code: BACKUP_RESTORE_CONFIRM_REQUIRED });
    expect(store.writes).toEqual([]);
  });

  it("requires an Idempotency-Key with 400", async () => {
    const store = new FakeRestoreStore();
    const artifacts = new FakeRestoreArtifacts();
    store.backups.set("bk-1", backupRow("bk-1", "instance"));
    artifacts.files.set("backups/bk-1.zip", archive());
    const routes = createBackupsRestoreRoutes(makeOptions(store, artifacts));

    await expect(routes[0]!.handler(restoreCtx("bk-1"))).rejects.toMatchObject({
      status: 400,
      code: "backup.restore.idempotency_key_required",
    });
    expect(store.writes).toEqual([]);
  });

  it("maps a missing archive artifact to a 404", async () => {
    const store = new FakeRestoreStore();
    store.backups.set("bk-1", backupRow("bk-1", "instance"));
    const routes = createBackupsRestoreRoutes(makeOptions(store, new FakeRestoreArtifacts()));

    await expect(
      routes[0]!.handler(restoreCtx("bk-1", { headers: { "idempotency-key": "idem-1" } })),
    ).rejects.toMatchObject({ status: 404, code: BACKUP_ARTIFACT_MISSING });
  });

  it("restores an instance backup: pre-restore backup, transaction, audit", async () => {
    const store = new FakeRestoreStore();
    const artifacts = new FakeRestoreArtifacts();
    store.backups.set("bk-1", backupRow("bk-1", "instance"));
    store.tables.set("tenants", [{ id: "tenant-a", displayName: "Old" }]);
    store.tables.set("settings", [{ id: "theme", value: "light" }]);
    artifacts.files.set("backups/bk-1.zip", archive());
    const audits: Record<string, unknown>[] = [];
    const routes = createBackupsRestoreRoutes(
      makeOptions(store, artifacts, {
        recordAudit: async (event: Record<string, unknown>) => {
          audits.push(event);
        },
      }),
    );

    const response = await routes[0]!.handler(
      restoreCtx("bk-1", { headers: { "idempotency-key": "idem-1" } }),
    );

    expect(response.status).toBe(200);
    const body = response.body as {
      backupId: string;
      preRestoreBackupId: string;
      tables: string[];
      replayed: boolean;
    };
    expect(body).toMatchObject({
      backupId: "bk-1",
      preRestoreBackupId: "pre-backup-1",
      tables: ["tenants", "settings"],
      replayed: false,
    });
    expect(store.transactionCalls).toBe(1);
    expect(store.writes).toEqual(["tenants", "settings"]);
    expect(store.tables.get("tenants")).toEqual(ARCHIVE_TABLES[0]!.rows);
    expect(store.tables.get("settings")).toEqual(ARCHIVE_TABLES[1]!.rows);
    expect(store.backups.get("pre-backup-1")).toMatchObject({
      type: "instance",
      tenantId: null,
      createdBy: "operator-1",
    });
    expect(artifacts.files.has("backups/pre-backup-1.zip")).toBe(true);
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({
      action: "backup.restore",
      targetType: "backup",
      targetId: "bk-1",
      result: "success",
    });
  });

  it("does not apply twice when the Idempotency-Key is replayed", async () => {
    const store = new FakeRestoreStore();
    const artifacts = new FakeRestoreArtifacts();
    store.backups.set("bk-1", backupRow("bk-1", "instance"));
    store.tables.set("tenants", []);
    store.tables.set("settings", []);
    artifacts.files.set("backups/bk-1.zip", archive());
    const routes = createBackupsRestoreRoutes(makeOptions(store, artifacts));
    const ctx = restoreCtx("bk-1", { headers: { "idempotency-key": "idem-1" } });

    const first = await routes[0]!.handler(ctx);
    const writesAfterFirst = [...store.writes];
    const second = await routes[0]!.handler(ctx);

    expect((first.body as { replayed: boolean }).replayed).toBe(false);
    expect((second.body as { replayed: boolean }).replayed).toBe(true);
    expect(store.writes).toEqual(writesAfterFirst);
    expect(store.transactionCalls).toBe(1);
    expect([...store.backups.values()].filter((row) => row.id.startsWith("pre-backup-"))).toHaveLength(
      1,
    );
  });

  it("restores a tenant backup within that tenant's scope", async () => {
    const store = new FakeRestoreStore();
    const artifacts = new FakeRestoreArtifacts();
    store.backups.set("bk-tenant-a", backupRow("bk-tenant-a", "tenant", TENANT_A));
    store.tables.set("template_assignments", [{ id: "ta-1", tenantId: TENANT_A }]);
    artifacts.files.set("backups/bk-tenant-a.zip", archive());
    const routes = createBackupsRestoreRoutes(makeOptions(store, artifacts));

    const response = await routes[0]!.handler(
      restoreCtx("bk-tenant-a", { headers: { "idempotency-key": "idem-t" } }),
    );

    expect(response.status).toBe(200);
    expect(store.filters.every((filter) => filter?.tenantId === TENANT_A)).toBe(true);
    expect(store.backups.get("pre-backup-1")).toMatchObject({
      type: "tenant",
      tenantId: TENANT_A,
    });
  });

  it("refuses an incompatible schema with 409 before mutating", async () => {
    const store = new FakeRestoreStore(SCHEMA_VERSION + 1);
    const artifacts = new FakeRestoreArtifacts();
    store.backups.set("bk-1", backupRow("bk-1", "instance"));
    artifacts.files.set("backups/bk-1.zip", archive());
    const routes = createBackupsRestoreRoutes(makeOptions(store, artifacts));

    await expect(
      routes[0]!.handler(restoreCtx("bk-1", { headers: { "idempotency-key": "idem-1" } })),
    ).rejects.toMatchObject({ status: 409, code: BACKUP_ARCHIVE_SCHEMA_MISMATCH });
    expect(store.writes).toEqual([]);
  });

  it("publishes the portal.v1.yaml fragment for restore", () => {
    expect(BACKUPS_RESTORE_OPENAPI.paths["/backups/{id}/restore"]?.post).toMatchObject({
      operationId: "restoreBackup",
      permission: BACKUP_RESTORE_ADMIN_SCOPE,
    });
  });
});
