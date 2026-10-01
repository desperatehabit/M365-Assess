import { Readable } from "node:stream";
import { describe, expect, it } from "vitest";
import type { Backup, BackupInput, BackupRow } from "@m365-assess/db";
import { tenantScope } from "../rbac/scope.js";
import {
  BACKUP_DOWNLOAD_PATH,
  BACKUP_PATH,
  BACKUP_READ_PERMISSION,
  BACKUP_TYPE_INVALID,
  BACKUP_UNAUTHENTICATED,
  BACKUP_WRITE_PERMISSION,
  BACKUPS_OPENAPI,
  BACKUPS_PATH,
  backupNotFoundError,
  createBackupRoutes,
  type BackupsArtifactStore,
  type BackupsCaller,
  type BackupsStore,
} from "./backups.js";

const TENANT_A = "tenant-a";
const TENANT_B = "tenant-b";
const INSTANCE_VERSION = "test-instance-1.0.0";

function backup(id: string, type: "instance" | "tenant", tenantId: string | null = null): Backup {
  return {
    id,
    type,
    tenantId,
    createdAt: "2026-09-30T00:00:00.000Z",
    createdBy: "operator-1",
    schemaVersion: 43,
    artifactRef: `backups/${id}.zip`,
    checksum: "a".repeat(64),
  };
}

class FakeBackupsStore implements BackupsStore {
  readonly schemaVersion = 43;
  readonly backups = new Map<string, Backup>();
  readonly tables = new Map<string, readonly BackupRow[]>();
  readonly deleted: string[] = [];

  async readTable(name: string, filter?: { tenantId?: string }): Promise<readonly BackupRow[] | undefined> {
    const rows = this.tables.get(name);
    if (rows === undefined) {
      return undefined;
    }
    if (filter?.tenantId === undefined) {
      return rows;
    }
    return rows.filter((row) => row["tenantId"] === filter.tenantId);
  }

  async listBackups(options?: { type?: "instance" | "tenant"; tenantId?: string }): Promise<Backup[]> {
    let rows = [...this.backups.values()];
    if (options?.type !== undefined) {
      rows = rows.filter((row) => row.type === options.type);
    }
    if (options?.tenantId !== undefined) {
      rows = rows.filter((row) => row.tenantId === options.tenantId);
    }
    return rows;
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

  async deleteBackup(backupId: string): Promise<boolean> {
    this.deleted.push(backupId);
    return this.backups.delete(backupId);
  }
}

class FakeArtifacts implements BackupsArtifactStore {
  readonly files = new Map<string, Buffer>();
  readonly removed: string[] = [];

  async write(ref: string, bytes: Buffer): Promise<void> {
    this.files.set(ref, bytes);
  }

  readStream(ref: string): Readable {
    const bytes = this.files.get(ref);
    if (bytes === undefined) {
      const stream = new Readable();
      stream._read = () => {
        stream.destroy(new Error(`ENOENT: no such file '${ref}'`));
      };
      return stream;
    }
    return Readable.from([bytes]);
  }

  async stat(ref: string): Promise<{ readonly size: number }> {
    const bytes = this.files.get(ref);
    if (bytes === undefined) {
      throw new Error(`ENOENT: no such file '${ref}'`);
    }
    return { size: bytes.length };
  }

  async remove(ref: string): Promise<void> {
    this.removed.push(ref);
    this.files.delete(ref);
  }
}

function makeCaller(
  permissions: readonly string[] = [BACKUP_READ_PERMISSION, BACKUP_WRITE_PERMISSION],
  scope: readonly string[] = [TENANT_A],
): BackupsCaller {
  return {
    tenantScope: tenantScope(scope),
    permissions: [...permissions],
    userId: "operator-1",
  };
}

function readCaller(): BackupsCaller {
  return makeCaller();
}

function listCtx(query = new URLSearchParams()) {
  return {
    method: "GET",
    path: BACKUPS_PATH,
    params: {},
    query,
    headers: {},
  };
}

function createCtx(body: Record<string, unknown>) {
  return {
    method: "POST",
    path: BACKUPS_PATH,
    params: {},
    query: new URLSearchParams(),
    headers: {},
    body,
  };
}

function downloadCtx(id: string) {
  return {
    method: "GET",
    path: BACKUP_DOWNLOAD_PATH,
    params: { id },
    query: new URLSearchParams(),
    headers: {},
  };
}

function deleteCtx(id: string) {
  return {
    method: "DELETE",
    path: BACKUP_PATH,
    params: { id },
    query: new URLSearchParams(),
    headers: {},
  };
}

function makeOptions(store: FakeBackupsStore, artifacts: FakeArtifacts) {
  return {
    store,
    artifacts,
    instanceVersion: INSTANCE_VERSION,
    resolveCaller: readCaller,
  };
}

async function readStream(stream: Readable): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string));
  }
  return Buffer.concat(chunks);
}

describe("Backups routes (T-0685)", () => {
  it("exposes the list, create, download, and delete paths", () => {
    const routes = createBackupRoutes(makeOptions(new FakeBackupsStore(), new FakeArtifacts()));
    expect(routes.map((route) => `${route.method} ${route.path}`)).toEqual([
      `GET ${BACKUPS_PATH}`,
      `POST ${BACKUPS_PATH}`,
      `GET ${BACKUP_DOWNLOAD_PATH}`,
      `DELETE ${BACKUP_PATH}`,
    ]);
  });

  it("rejects unauthenticated requests with 401", async () => {
    const routes = createBackupRoutes({
      store: new FakeBackupsStore(),
      artifacts: new FakeArtifacts(),
      instanceVersion: INSTANCE_VERSION,
      resolveCaller: () => undefined,
    });
    for (const route of routes) {
      await expect(route.handler(listCtx())).rejects.toMatchObject({
        status: 401,
        code: BACKUP_UNAUTHENTICATED,
      });
    }
  });

  it("refuses callers lacking backup.read on list with 403", async () => {
    const store = new FakeBackupsStore();
    const routes = createBackupRoutes({
      store,
      artifacts: new FakeArtifacts(),
      instanceVersion: INSTANCE_VERSION,
      resolveCaller: () => makeCaller([BACKUP_WRITE_PERMISSION]),
    });
    await expect(routes[0]!.handler(listCtx())).rejects.toMatchObject({
      status: 403,
      code: "auth.forbidden",
    });
  });

  it("lists backups visible to the caller and hides another tenant's", async () => {
    const store = new FakeBackupsStore();
    store.backups.set("bk-instance", backup("bk-instance", "instance"));
    store.backups.set("bk-tenant-a", backup("bk-tenant-a", "tenant", TENANT_A));
    store.backups.set("bk-tenant-b", backup("bk-tenant-b", "tenant", TENANT_B));
    const routes = createBackupRoutes(makeOptions(store, new FakeArtifacts()));

    const response = await routes[0]!.handler(listCtx());
    expect(response.status).toBe(200);
    const body = response.body as { items: Array<{ id: string; tenantId: string | null }> };
    expect(body.items.map((item) => item.id).sort()).toEqual(["bk-instance", "bk-tenant-a"]);
  });

  it("scopes a tenant-scoped caller to their own tenant's backups", async () => {
    const store = new FakeBackupsStore();
    store.backups.set("bk-tenant-a", backup("bk-tenant-a", "tenant", TENANT_A));
    store.backups.set("bk-tenant-b", backup("bk-tenant-b", "tenant", TENANT_B));
    const routes = createBackupRoutes({
      store,
      artifacts: new FakeArtifacts(),
      instanceVersion: INSTANCE_VERSION,
      resolveCaller: () => makeCaller([BACKUP_READ_PERMISSION], [TENANT_A]),
    });

    const response = await routes[0]!.handler(listCtx());
    const body = response.body as { items: Array<{ id: string }> };
    expect(body.items.map((item) => item.id)).toEqual(["bk-tenant-a"]);
  });

  it("refuses a tenant filter outside the caller scope with 403", async () => {
    const store = new FakeBackupsStore();
    const routes = createBackupRoutes({
      store,
      artifacts: new FakeArtifacts(),
      instanceVersion: INSTANCE_VERSION,
      resolveCaller: () => makeCaller([BACKUP_READ_PERMISSION], [TENANT_A]),
    });
    await expect(
      routes[0]!.handler(listCtx(new URLSearchParams({ tenantId: TENANT_B }))),
    ).rejects.toMatchObject({ status: 403, code: "auth.forbidden" });
  });

  it("paginates the listing with a cursor", async () => {
    const store = new FakeBackupsStore();
    for (let i = 0; i < 5; i += 1) {
      store.backups.set(`bk-${i}`, backup(`bk-${i}`, "instance"));
    }
    const routes = createBackupRoutes(makeOptions(store, new FakeArtifacts()));

    const first = (await routes[0]!.handler(listCtx(new URLSearchParams({ limit: "2" })))) as {
      body: { items: Array<{ id: string }>; nextCursor: string | null };
    };
    expect(first.body.items).toHaveLength(2);
    expect(first.body.nextCursor).not.toBeNull();

    const second = (await routes[0]!.handler(
      listCtx(new URLSearchParams({ limit: "2", cursor: first.body.nextCursor ?? "" })),
    )) as { body: { items: Array<{ id: string }>; nextCursor: string | null } };
    expect(second.body.items).toHaveLength(2);
    expect(second.body.nextCursor).not.toBeNull();

    const third = (await routes[0]!.handler(
      listCtx(new URLSearchParams({ limit: "2", cursor: second.body.nextCursor ?? "" })),
    )) as { body: { items: Array<{ id: string }>; nextCursor: string | null } };
    expect(third.body.items).toHaveLength(1);
    expect(third.body.nextCursor).toBeNull();
  });

  it("creates an instance backup, writes the artifact and row, and audits", async () => {
    const store = new FakeBackupsStore();
    store.tables.set("tenants", [{ id: TENANT_A, name: "Tenant A" }]);
    store.tables.set("roles", []);
    const artifacts = new FakeArtifacts();
    const audits: Record<string, unknown>[] = [];
    const routes = createBackupRoutes({
      store,
      artifacts,
      instanceVersion: INSTANCE_VERSION,
      resolveCaller: readCaller,
      recordAudit: async (event) => {
        audits.push(event);
      },
    });

    const response = await routes[1]!.handler(createCtx({ type: "instance" }));
    expect(response.status).toBe(201);
    const body = response.body as Backup;
    expect(body.type).toBe("instance");
    expect(body.tenantId).toBeNull();
    expect(body.createdBy).toBe("operator-1");
    expect(artifacts.files.has(body.artifactRef)).toBe(true);
    expect(store.backups.get(body.id)).toBeDefined();
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({ action: "backup.create", targetId: body.id, tenantId: null });
  });

  it("creates a tenant backup scoped to the caller's tenant and audits", async () => {
    const store = new FakeBackupsStore();
    store.tables.set("template_assignments", [{ id: "ta-1", tenantId: TENANT_A }]);
    const artifacts = new FakeArtifacts();
    const audits: Record<string, unknown>[] = [];
    const routes = createBackupRoutes({
      store,
      artifacts,
      instanceVersion: INSTANCE_VERSION,
      resolveCaller: readCaller,
      recordAudit: async (event) => {
        audits.push(event);
      },
    });

    const response = await routes[1]!.handler(createCtx({ type: "tenant", tenantId: TENANT_A }));
    expect(response.status).toBe(201);
    const body = response.body as Backup;
    expect(body.type).toBe("tenant");
    expect(body.tenantId).toBe(TENANT_A);
    expect(artifacts.files.has(body.artifactRef)).toBe(true);
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({ action: "backup.create", targetId: body.id, tenantId: TENANT_A });
  });

  it("refuses a tenant backup for a tenant outside the caller scope with 403", async () => {
    const store = new FakeBackupsStore();
    const routes = createBackupRoutes({
      store,
      artifacts: new FakeArtifacts(),
      instanceVersion: INSTANCE_VERSION,
      resolveCaller: () => makeCaller([BACKUP_WRITE_PERMISSION], [TENANT_A]),
    });
    await expect(
      routes[1]!.handler(createCtx({ type: "tenant", tenantId: TENANT_B })),
    ).rejects.toMatchObject({ status: 403, code: "auth.forbidden" });
    expect(store.backups.size).toBe(0);
  });

  it("rejects an invalid backup type with 400", async () => {
    const store = new FakeBackupsStore();
    const routes = createBackupRoutes(makeOptions(store, new FakeArtifacts()));
    await expect(routes[1]!.handler(createCtx({ type: "everything" }))).rejects.toMatchObject({
      status: 400,
      code: BACKUP_TYPE_INVALID,
    });
    expect(store.backups.size).toBe(0);
  });

  it("rejects a tenant backup without a tenantId with 400", async () => {
    const store = new FakeBackupsStore();
    const routes = createBackupRoutes(makeOptions(store, new FakeArtifacts()));
    await expect(routes[1]!.handler(createCtx({ type: "tenant" }))).rejects.toMatchObject({
      status: 400,
    });
    expect(store.backups.size).toBe(0);
  });

  it("refuses create callers lacking backup.write with 403", async () => {
    const store = new FakeBackupsStore();
    const routes = createBackupRoutes({
      store,
      artifacts: new FakeArtifacts(),
      instanceVersion: INSTANCE_VERSION,
      resolveCaller: () => makeCaller([BACKUP_READ_PERMISSION]),
    });
    await expect(routes[1]!.handler(createCtx({ type: "instance" }))).rejects.toMatchObject({
      status: 403,
      code: "auth.forbidden",
    });
    expect(store.backups.size).toBe(0);
  });

  it("streams the archive artifact on download without buffering it", async () => {
    const store = new FakeBackupsStore();
    const artifacts = new FakeArtifacts();
    const row = backup("bk-dl", "instance");
    store.backups.set(row.id, row);
    artifacts.files.set(row.artifactRef, Buffer.from("archive-bytes"));
    const routes = createBackupRoutes(makeOptions(store, artifacts));

    const response = await routes[2]!.handler(downloadCtx(row.id));
    expect(response.status).toBe(200);
    expect(response.contentType).toBe("application/zip");
    expect(response.contentLength).toBe("archive-bytes".length);
    expect(response.body).toBeUndefined();
    expect(response.stream).toBeInstanceOf(Readable);
    const bytes = await readStream(response.stream!);
    expect(bytes.toString("utf8")).toBe("archive-bytes");
  });

  it("maps a missing backup download to the structured 404", async () => {
    const store = new FakeBackupsStore();
    const routes = createBackupRoutes(makeOptions(store, new FakeArtifacts()));
    await expect(routes[2]!.handler(downloadCtx("bk-missing"))).rejects.toMatchObject({
      status: 404,
      code: "backup.not_found",
    });
  });

  it("refuses a download of another tenant's backup with 403", async () => {
    const store = new FakeBackupsStore();
    const artifacts = new FakeArtifacts();
    const row = backup("bk-tenant-b", "tenant", TENANT_B);
    store.backups.set(row.id, row);
    artifacts.files.set(row.artifactRef, Buffer.from("archive-bytes"));
    const routes = createBackupRoutes({
      store,
      artifacts,
      instanceVersion: INSTANCE_VERSION,
      resolveCaller: () => makeCaller([BACKUP_READ_PERMISSION], [TENANT_A]),
    });
    await expect(routes[2]!.handler(downloadCtx(row.id))).rejects.toMatchObject({
      status: 403,
      code: "auth.forbidden",
    });
  });

  it("maps a missing artifact to a 404", async () => {
    const store = new FakeBackupsStore();
    const artifacts = new FakeArtifacts();
    const row = backup("bk-no-artifact", "instance");
    store.backups.set(row.id, row);
    const routes = createBackupRoutes(makeOptions(store, artifacts));
    await expect(routes[2]!.handler(downloadCtx(row.id))).rejects.toMatchObject({
      status: 404,
      code: "backup.artifact_missing",
    });
  });

  it("deletes the artifact and row and audits", async () => {
    const store = new FakeBackupsStore();
    const artifacts = new FakeArtifacts();
    const row = backup("bk-del", "instance");
    store.backups.set(row.id, row);
    artifacts.files.set(row.artifactRef, Buffer.from("archive-bytes"));
    const audits: Record<string, unknown>[] = [];
    const routes = createBackupRoutes({
      store,
      artifacts,
      instanceVersion: INSTANCE_VERSION,
      resolveCaller: readCaller,
      recordAudit: async (event) => {
        audits.push(event);
      },
    });

    const response = await routes[3]!.handler(deleteCtx(row.id));
    expect(response.status).toBe(204);
    expect(store.backups.has(row.id)).toBe(false);
    expect(artifacts.removed).toContain(row.artifactRef);
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({ action: "backup.delete", targetId: row.id });
  });

  it("maps a missing backup delete to the structured 404", async () => {
    const store = new FakeBackupsStore();
    const routes = createBackupRoutes(makeOptions(store, new FakeArtifacts()));
    await expect(routes[3]!.handler(deleteCtx("bk-missing"))).rejects.toMatchObject({
      status: 404,
      code: "backup.not_found",
    });
  });

  it("refuses a delete of another tenant's backup with 403", async () => {
    const store = new FakeBackupsStore();
    const artifacts = new FakeArtifacts();
    const row = backup("bk-tenant-b", "tenant", TENANT_B);
    store.backups.set(row.id, row);
    artifacts.files.set(row.artifactRef, Buffer.from("archive-bytes"));
    const routes = createBackupRoutes({
      store,
      artifacts,
      instanceVersion: INSTANCE_VERSION,
      resolveCaller: () => makeCaller([BACKUP_WRITE_PERMISSION], [TENANT_A]),
    });
    await expect(routes[3]!.handler(deleteCtx(row.id))).rejects.toMatchObject({
      status: 403,
      code: "auth.forbidden",
    });
    expect(store.backups.has(row.id)).toBe(true);
  });

  it("refuses delete callers lacking backup.write with 403", async () => {
    const store = new FakeBackupsStore();
    const row = backup("bk-del", "instance");
    store.backups.set(row.id, row);
    const routes = createBackupRoutes({
      store,
      artifacts: new FakeArtifacts(),
      instanceVersion: INSTANCE_VERSION,
      resolveCaller: () => makeCaller([BACKUP_READ_PERMISSION]),
    });
    await expect(routes[3]!.handler(deleteCtx(row.id))).rejects.toMatchObject({
      status: 403,
      code: "auth.forbidden",
    });
    expect(store.backups.has(row.id)).toBe(true);
  });

  it("builds the structured not-found error", () => {
    const error = backupNotFoundError("bk-9");
    expect(error.status).toBe(404);
    expect(error.code).toBe("backup.not_found");
  });

  it("publishes the portal.v1.yaml fragment for all four endpoints", () => {
    expect(BACKUPS_OPENAPI.paths["/backups"]?.get).toMatchObject({
      operationId: "listBackups",
      permission: BACKUP_READ_PERMISSION,
    });
    expect(BACKUPS_OPENAPI.paths["/backups"]?.post).toMatchObject({
      operationId: "createBackup",
      permission: BACKUP_WRITE_PERMISSION,
    });
    expect(BACKUPS_OPENAPI.paths["/backups/{id}/download"]?.get).toMatchObject({
      operationId: "downloadBackup",
      permission: BACKUP_READ_PERMISSION,
    });
    expect(BACKUPS_OPENAPI.paths["/backups/{id}"]?.delete).toMatchObject({
      operationId: "deleteBackup",
      permission: BACKUP_WRITE_PERMISSION,
    });
  });
});
