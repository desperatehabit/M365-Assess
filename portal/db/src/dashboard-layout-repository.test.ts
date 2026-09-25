import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import {
  DEFAULT_DASHBOARD_WIDGETS,
  openSqliteDashboardLayoutRepository,
  type DashboardWidgetPlacement,
} from "./dashboard-layout-repository.js";
import { loadMigrations, runMigrations } from "./sqlite-repository.js";

const USER_A = "user-0000-0000-0000-0000000000a1";
const USER_B = "user-0000-0000-0000-0000000000b2";
const TENANT_A = "11111111-1111-1111-1111-111111111111";
const TENANT_B = "22222222-2222-2222-2222-222222222222";
const NOW = "2026-01-01T00:00:00.000Z";

const tempDirs: string[] = [];

function tempDbPath(): string {
  const dir = mkdtempSync(join(tmpdir(), "m365-dashboard-layout-"));
  tempDirs.push(dir);
  return join(dir, "portal.db");
}

afterEach(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
  tempDirs.length = 0;
});

function seed(dbFile: string, users: readonly string[], tenants: readonly string[]): void {
  const raw = new Database(dbFile);
  try {
    const user = raw.prepare(
      `INSERT OR IGNORE INTO portal_users (id, upn, status, preferences, roleId, createdAt, updatedAt)
       VALUES (?, ?, 'active', NULL, NULL, ?, ?)`,
    );
    for (const id of users) user.run(id, `${id}@example.invalid`, NOW, NOW);
    const tenant = raw.prepare(
      `INSERT OR IGNORE INTO tenants (id, source, status, excluded, errorCount, createdAt, updatedAt)
       VALUES (?, 'direct', 'active', 0, 0, ?, ?)`,
    );
    for (const id of tenants) tenant.run(id, NOW, NOW);
  } finally {
    raw.close();
  }
}

function widget(id: string, position = 0, extra: Record<string, unknown> = {}): DashboardWidgetPlacement {
  return { id, position, size: { width: 4, height: 2 }, settings: { ...extra } };
}

async function open(dbFile: string, users: readonly string[] = [], tenants: readonly string[] = []) {
  const repo = await openSqliteDashboardLayoutRepository({ filename: dbFile });
  if (users.length > 0 || tenants.length > 0) seed(dbFile, users, tenants);
  return repo;
}

describe("migration 0004", () => {
  it("creates the layout table with timestamps, applies once, and is re-runnable", () => {
    const migrations = loadMigrations();
    const target = migrations.reduce((max, migration) => Math.max(max, migration.version), 0);
    const db = new Database(":memory:");
    try {
      expect(runMigrations(db, migrations)).toBe(target);
      expect(runMigrations(db, migrations)).toBe(target);
      expect(
        db.prepare("SELECT COUNT(*) AS c FROM schema_versions WHERE version = ?").get(target),
      ).toMatchObject({ c: 1 });

      const columns = (
        db.prepare("PRAGMA table_info(dashboard_layouts)").all() as Array<{ name: string }>
      ).map((row) => row.name);
      expect(columns).toEqual(
        expect.arrayContaining(["id", "userId", "scope", "tenantId", "widgets", "createdAt", "updatedAt"]),
      );

      const indexes = (
        db.prepare("SELECT name FROM sqlite_master WHERE type = 'index'").all() as Array<{
          name: string;
        }>
      ).map((row) => row.name);
      expect(indexes).toContain("idx_dashboard_layouts_user_tenant");
    } finally {
      db.close();
    }
  });

  it("applies forward onto a database already at the previous version", () => {
    const migrations = loadMigrations();
    const db = new Database(":memory:");
    try {
      runMigrations(
        db,
        migrations.filter((migration) => migration.version <= 2),
      );
      expect(db.prepare("SELECT MAX(version) AS v FROM schema_versions").get()).toMatchObject({ v: 2 });

      const target = migrations.reduce((max, migration) => Math.max(max, migration.version), 0);
      expect(runMigrations(db, migrations)).toBe(target);
      expect(runMigrations(db, migrations)).toBe(target);
      expect(
        db.prepare("SELECT COUNT(*) AS c FROM schema_versions WHERE version = ?").get(target),
      ).toMatchObject({ c: 1 });
      expect(
        (
          db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{
            name: string;
          }>
        ).map((row) => row.name),
      ).toContain("dashboard_layouts");
    } finally {
      db.close();
    }
  });
});

describe("dashboard layout repository", () => {
  it("returns the stock default when the user has no layout", async () => {
    const filename = tempDbPath();
    const repo = await open(filename);
    try {
      const layout = await repo.getLayout(USER_A, { tenantId: TENANT_A });
      expect(layout.isDefault).toBe(true);
      expect(layout.scope).toBe("tenant");
      expect(layout.tenantId).toBe(TENANT_A);
      expect(layout.widgets.map((item) => item.id)).toEqual(
        DEFAULT_DASHBOARD_WIDGETS.map((item) => item.id),
      );
    } finally {
      repo.close();
    }
  });

  it("round-trips a saved layout for the same user and tenant", async () => {
    const filename = tempDbPath();
    const repo = await open(filename, [USER_A], [TENANT_A]);
    try {
      const widgets = [widget("SecureScoreCard", 0, { metric: "score" }), widget("MFACard", 1)];
      const saved = await repo.saveLayout(USER_A, { tenantId: TENANT_A, widgets });
      expect(saved.isDefault).toBe(false);
      expect(saved.userId).toBe(USER_A);

      const reloaded = await repo.getLayout(USER_A, { tenantId: TENANT_A });
      expect(reloaded.isDefault).toBe(false);
      expect(reloaded.id).toBe(saved.id);
      expect(reloaded.widgets).toEqual(widgets);
      expect(reloaded.createdAt).not.toBeNull();
    } finally {
      repo.close();
    }
  });

  it("falls back to the stock default for another user on the same tenant", async () => {
    const filename = tempDbPath();
    const repo = await open(filename, [USER_A], [TENANT_A]);
    try {
      await repo.saveLayout(USER_A, {
        tenantId: TENANT_A,
        widgets: [widget("AssessmentCard")],
      });

      const other = await repo.getLayout(USER_B, { tenantId: TENANT_A });
      expect(other.isDefault).toBe(true);
      expect(other.widgets.map((item) => item.id)).toEqual(
        DEFAULT_DASHBOARD_WIDGETS.map((item) => item.id),
      );
    } finally {
      repo.close();
    }
  });

  it("keeps layouts user-owned so one user cannot overwrite another's", async () => {
    const filename = tempDbPath();
    const repo = await open(filename, [USER_A, USER_B], [TENANT_A]);
    try {
      await repo.saveLayout(USER_A, { tenantId: TENANT_A, widgets: [widget("LicenseCard")] });
      await repo.saveLayout(USER_B, { tenantId: TENANT_A, widgets: [widget("MFACard")] });

      expect((await repo.getLayout(USER_A, { tenantId: TENANT_A })).widgets).toEqual([
        widget("LicenseCard"),
      ]);
      expect((await repo.getLayout(USER_B, { tenantId: TENANT_A })).widgets).toEqual([
        widget("MFACard"),
      ]);
    } finally {
      repo.close();
    }
  });

  it("resets to the stock default", async () => {
    const filename = tempDbPath();
    const repo = await open(filename, [USER_A], [TENANT_A]);
    try {
      await repo.saveLayout(USER_A, { tenantId: TENANT_A, widgets: [widget("AuthMethodCard")] });

      const reset = await repo.resetLayout(USER_A, { tenantId: TENANT_A });
      expect(reset.isDefault).toBe(true);
      expect(reset.widgets.map((item) => item.id)).toEqual(
        DEFAULT_DASHBOARD_WIDGETS.map((item) => item.id),
      );

      const reloaded = await repo.getLayout(USER_A, { tenantId: TENANT_A });
      expect(reloaded.isDefault).toBe(true);
    } finally {
      repo.close();
    }
  });

  it("falls back to the user's global layout when a tenant override is absent", async () => {
    const filename = tempDbPath();
    const repo = await open(filename, [USER_A], [TENANT_A]);
    try {
      await repo.saveLayout(USER_A, { widgets: [widget("TenantInfoCard")] });

      const tenantLayout = await repo.getLayout(USER_A, { tenantId: TENANT_A });
      expect(tenantLayout.scope).toBe("global");
      expect(tenantLayout.tenantId).toBeNull();
      expect(tenantLayout.widgets).toEqual([widget("TenantInfoCard")]);
    } finally {
      repo.close();
    }
  });

  it("updates an existing layout without changing its createdAt", async () => {
    const filename = tempDbPath();
    const repo = await open(filename, [USER_A], [TENANT_A]);
    try {
      const first = await repo.saveLayout(USER_A, {
        tenantId: TENANT_A,
        widgets: [widget("LicenseCard", 0)],
      });
      const second = await repo.saveLayout(USER_A, {
        tenantId: TENANT_A,
        widgets: [widget("LicenseCard", 0), widget("MFACard", 1)],
      });
      expect(second.id).toBe(first.id);
      expect(second.createdAt).toBe(first.createdAt);
      expect(second.widgets).toHaveLength(2);
    } finally {
      repo.close();
    }
  });
});
