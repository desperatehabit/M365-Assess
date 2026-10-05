// Tests for the backup-settings route: GET/PUT /v1/backup-settings persist and
// return retentionDays and replicationTarget, validate the body, enforce the
// Tenant.Backup.Read/Tenant.Backup.ReadWrite permission seam, and audit the change
// (EPIC-035 §3.3, §5, §6, §7; T-0688).
import { describe, expect, it } from "vitest";
import type { BackupConfig, BackupConfigInput } from "@m365-assess/db";
import { tenantScope } from "../rbac/scope.js";
import {
  BACKUP_SETTINGS_OPENAPI,
  BACKUP_SETTINGS_PATH,
  BACKUP_SETTINGS_UNAUTHENTICATED,
  DEFAULT_BACKUP_RETENTION_DAYS,
  createBackupSettingsRoutes,
  type BackupSettingsCaller,
  type BackupSettingsStore,
} from "./backup-settings.js";
import { BACKUP_READ_PERMISSION, BACKUP_WRITE_PERMISSION } from "./backups.js";

class FakeSettingsStore implements BackupSettingsStore {
  config: BackupConfig | undefined;
  readonly upserts: BackupConfigInput[] = [];

  async getBackupConfig(): Promise<BackupConfig | undefined> {
    return this.config;
  }

  async upsertBackupConfig(input: BackupConfigInput): Promise<BackupConfig> {
    this.upserts.push(input);
    this.config = {
      id: input.id ?? "default",
      scheduleId: input.scheduleId === undefined ? this.config?.scheduleId ?? null : input.scheduleId,
      retentionDays: input.retentionDays,
      replicationTarget:
        input.replicationTarget === undefined
          ? this.config?.replicationTarget ?? null
          : input.replicationTarget,
    };
    return this.config;
  }
}

function makeCaller(
  permissions: readonly string[] = [BACKUP_READ_PERMISSION, BACKUP_WRITE_PERMISSION],
): BackupSettingsCaller {
  return {
    roles: [],
    tenantScope: tenantScope([]),
    permissions: [...permissions],
    userId: "operator-1",
  };
}

function ctx(method: string, body?: unknown) {
  return {
    correlationId: "corr-1",
    method,
    path: BACKUP_SETTINGS_PATH,
    params: {},
    query: new URLSearchParams(),
    headers: {},
    ...(body === undefined ? {} : { body }),
  };
}

function makeOptions(store: FakeSettingsStore, caller: BackupSettingsCaller = makeCaller()) {
  return {
    store,
    resolveCaller: () => caller,
  };
}

describe("Backup settings routes (T-0688)", () => {
  it("exposes the GET and PUT paths", () => {
    const routes = createBackupSettingsRoutes(makeOptions(new FakeSettingsStore()));
    expect(routes.map((route) => `${route.method} ${route.path}`)).toEqual([
      `GET ${BACKUP_SETTINGS_PATH}`,
      `PUT ${BACKUP_SETTINGS_PATH}`,
    ]);
  });

  it("returns the seeded defaults when the singleton has never been written", async () => {
    const routes = createBackupSettingsRoutes(makeOptions(new FakeSettingsStore()));
    const response = await routes[0]!.handler(ctx("GET"));
    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      id: "default",
      scheduleId: null,
      retentionDays: DEFAULT_BACKUP_RETENTION_DAYS,
      replicationTarget: null,
    });
  });

  it("returns the stored retention window and replication target", async () => {
    const store = new FakeSettingsStore();
    store.config = {
      id: "default",
      scheduleId: "sch-1",
      retentionDays: 14,
      replicationTarget: "backups-replica",
    };
    const routes = createBackupSettingsRoutes(makeOptions(store));
    const response = await routes[0]!.handler(ctx("GET"));
    expect(response.body).toMatchObject({
      scheduleId: "sch-1",
      retentionDays: 14,
      replicationTarget: "backups-replica",
    });
  });

  it("persists and returns retentionDays and replicationTarget on PUT", async () => {
    const store = new FakeSettingsStore();
    const routes = createBackupSettingsRoutes(makeOptions(store));

    const response = await routes[1]!.handler(
      ctx("PUT", { retentionDays: 45, replicationTarget: "backups-replica" }),
    );

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ retentionDays: 45, replicationTarget: "backups-replica" });
    expect(store.upserts).toEqual([{ retentionDays: 45, replicationTarget: "backups-replica" }]);
    expect(store.config).toMatchObject({ retentionDays: 45, replicationTarget: "backups-replica" });
  });

  it("clears the replication target with null", async () => {
    const store = new FakeSettingsStore();
    store.config = { id: "default", scheduleId: null, retentionDays: 30, replicationTarget: "old" };
    const routes = createBackupSettingsRoutes(makeOptions(store));

    const response = await routes[1]!.handler(ctx("PUT", { retentionDays: 30, replicationTarget: null }));

    expect(response.body).toMatchObject({ retentionDays: 30, replicationTarget: null });
    expect(store.config?.replicationTarget).toBeNull();
  });

  it("rejects an invalid retentionDays with 400 and writes nothing", async () => {
    const store = new FakeSettingsStore();
    const routes = createBackupSettingsRoutes(makeOptions(store));

    for (const body of [{}, { retentionDays: -1 }, { retentionDays: 1.5 }, { retentionDays: "30" }]) {
      await expect(routes[1]!.handler(ctx("PUT", body))).rejects.toMatchObject({
        status: 400,
        code: "request.validation_failed",
      });
    }
    expect(store.upserts).toEqual([]);
  });

  it("rejects a blank replicationTarget with 400", async () => {
    const store = new FakeSettingsStore();
    const routes = createBackupSettingsRoutes(makeOptions(store));
    await expect(
      routes[1]!.handler(ctx("PUT", { retentionDays: 30, replicationTarget: "  " })),
    ).rejects.toMatchObject({ status: 400 });
  });

  it("rejects unauthenticated requests with 401", async () => {
    const routes = createBackupSettingsRoutes({
      store: new FakeSettingsStore(),
      resolveCaller: () => undefined,
    });
    for (const route of routes) {
      await expect(route.handler(ctx(route.method))).rejects.toMatchObject({
        status: 401,
        code: BACKUP_SETTINGS_UNAUTHENTICATED,
      });
    }
  });

  it("refuses callers lacking the write permission with 403", async () => {
    const store = new FakeSettingsStore();
    const routes = createBackupSettingsRoutes(
      makeOptions(store, makeCaller([BACKUP_READ_PERMISSION])),
    );
    await expect(routes[1]!.handler(ctx("PUT", { retentionDays: 30 }))).rejects.toMatchObject({
      status: 403,
      code: "auth.forbidden",
    });
    expect(store.upserts).toEqual([]);
  });

  it("audits the change with before and after", async () => {
    const store = new FakeSettingsStore();
    store.config = { id: "default", scheduleId: null, retentionDays: 30, replicationTarget: null };
    const events: Array<Record<string, unknown>> = [];
    const routes = createBackupSettingsRoutes({
      store,
      resolveCaller: () => makeCaller(),
      now: () => new Date("2026-10-01T00:00:00.000Z"),
      newId: () => "audit-1",
      recordAudit: async (event) => {
        events.push(event);
      },
    });

    await routes[1]!.handler(ctx("PUT", { retentionDays: 14, replicationTarget: "backups-replica" }));

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      id: "audit-1",
      action: "backupconfig.update",
      targetType: "backup_config",
      targetId: "default",
      actorUserId: "operator-1",
      before: { retentionDays: 30, replicationTarget: null },
      after: { retentionDays: 14, replicationTarget: "backups-replica" },
    });
  });

  it("publishes the OpenAPI fragment for both endpoints", () => {
    expect(BACKUP_SETTINGS_OPENAPI.paths["/backup-settings"]?.get).toMatchObject({
      operationId: "getBackupSettings",
      permission: BACKUP_READ_PERMISSION,
    });
    expect(BACKUP_SETTINGS_OPENAPI.paths["/backup-settings"]?.put).toMatchObject({
      operationId: "putBackupSettings",
      permission: BACKUP_WRITE_PERMISSION,
    });
  });
});
