// Dashboard layout persistence (EPIC-004 SPEC §5, §11.2). Layouts are
// user-owned: every query filters on the caller's userId, so one user can never
// read or overwrite another's; a missing row resolves to the stock default
// (reset-to-default). Widgets are opaque placements stored as JSON so the widget
// catalogue can grow without a migration.
import Database from "better-sqlite3";
import { SchemaVersionError } from "./repository.js";
import {
  SCHEMA_VERSIONS_TABLE,
  loadMigrations,
  runMigrations,
  type OpenSqliteRepositoryOptions,
} from "./sqlite-repository.js";

type Row = Record<string, unknown>;

export type DashboardLayoutScope = "global" | "tenant";

export interface DashboardWidgetSize {
  readonly width: number;
  readonly height: number;
}

export interface DashboardWidgetPlacement {
  readonly id: string;
  readonly position: number;
  readonly size: DashboardWidgetSize;
  readonly settings: Record<string, unknown>;
}

export interface DashboardLayout {
  readonly id: string;
  readonly userId: string;
  readonly scope: DashboardLayoutScope;
  readonly tenantId: string | null;
  readonly widgets: DashboardWidgetPlacement[];
  readonly isDefault: boolean;
  readonly createdAt: string | null;
  readonly updatedAt: string | null;
}

export interface DashboardLayoutLookup {
  tenantId?: string | null;
}

export interface DashboardLayoutInput {
  tenantId?: string | null;
  widgets: readonly DashboardWidgetPlacement[];
}

export interface DashboardLayoutRepository {
  readonly schemaVersion: number;

  close(): void;

  getLayout(userId: string, lookup?: DashboardLayoutLookup): Promise<DashboardLayout>;
  saveLayout(userId: string, input: DashboardLayoutInput): Promise<DashboardLayout>;
  resetLayout(userId: string, lookup?: DashboardLayoutLookup): Promise<DashboardLayout>;
}

// Stock v1 widgets (SPEC §3.1, §11.1) in their default order.
export const DEFAULT_DASHBOARD_WIDGETS: readonly DashboardWidgetPlacement[] = Object.freeze(
  [
    { id: "TenantInfoCard", position: 0, size: { width: 4, height: 2 }, settings: {} },
    { id: "TenantMetricsGrid", position: 1, size: { width: 4, height: 2 }, settings: {} },
    { id: "AssessmentCard", position: 2, size: { width: 4, height: 2 }, settings: {} },
    { id: "AlertsOverviewCard", position: 3, size: { width: 12, height: 2 }, settings: {} },
    { id: "SecureScoreCard", position: 4, size: { width: 6, height: 3 }, settings: {} },
    { id: "AuthMethodCard", position: 5, size: { width: 6, height: 3 }, settings: {} },
    { id: "MFACard", position: 6, size: { width: 6, height: 3 }, settings: {} },
    { id: "LicenseCard", position: 7, size: { width: 6, height: 3 }, settings: {} },
  ].map((widget) =>
    Object.freeze({
      ...widget,
      size: Object.freeze({ ...widget.size }),
      settings: Object.freeze({ ...widget.settings }),
    }),
  ),
);

function cloneWidgets(widgets: readonly DashboardWidgetPlacement[]): DashboardWidgetPlacement[] {
  return widgets.map((widget) => ({
    id: widget.id,
    position: widget.position,
    size: { width: widget.size.width, height: widget.size.height },
    settings: { ...widget.settings },
  }));
}

export function dashboardLayoutId(
  userId: string,
  scope: DashboardLayoutScope,
  tenantId: string | null,
): string {
  return `layout:${userId}:${scope}:${tenantId ?? "global"}`;
}

function scopeFor(tenantId: string | null): DashboardLayoutScope {
  return tenantId === null ? "global" : "tenant";
}

export function createDefaultDashboardLayout(
  userId: string,
  scope: DashboardLayoutScope,
  tenantId: string | null,
): DashboardLayout {
  return {
    id: dashboardLayoutId(userId, scope, tenantId),
    userId,
    scope,
    tenantId,
    widgets: cloneWidgets(DEFAULT_DASHBOARD_WIDGETS),
    isDefault: true,
    createdAt: null,
    updatedAt: null,
  };
}

function nowIso(): string {
  return new Date().toISOString();
}

function asString(value: unknown): string {
  return String(value);
}

function asNullableString(value: unknown): string | null {
  return value === null || value === undefined ? null : String(value);
}

function asNumber(value: unknown): number {
  return typeof value === "number" ? value : Number(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeWidget(value: unknown): DashboardWidgetPlacement | null {
  if (!isRecord(value)) return null;
  const id = value["id"];
  if (typeof id !== "string" || id.length === 0) return null;
  const size = isRecord(value["size"]) ? value["size"] : {};
  return {
    id,
    position: asNumber(value["position"] ?? 0),
    size: { width: asNumber(size["width"] ?? 1), height: asNumber(size["height"] ?? 1) },
    settings: isRecord(value["settings"]) ? { ...value["settings"] } : {},
  };
}

function parseWidgets(value: unknown): DashboardWidgetPlacement[] {
  if (typeof value !== "string") return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  const widgets: DashboardWidgetPlacement[] = [];
  for (const item of parsed) {
    const widget = normalizeWidget(item);
    if (widget !== null) widgets.push(widget);
  }
  return widgets;
}

export class SqliteDashboardLayoutRepository implements DashboardLayoutRepository {
  readonly schemaVersion: number;

  constructor(
    private readonly db: Database.Database,
    schemaVersion: number,
  ) {
    this.schemaVersion = schemaVersion;
  }

  close(): void {
    this.db.close();
  }

  private mapLayout(row: Row): DashboardLayout {
    return {
      id: asString(row["id"]),
      userId: asString(row["userId"]),
      scope: asString(row["scope"]) as DashboardLayoutScope,
      tenantId: asNullableString(row["tenantId"]),
      widgets: parseWidgets(row["widgets"]),
      isDefault: false,
      createdAt: asString(row["createdAt"]),
      updatedAt: asString(row["updatedAt"]),
    };
  }

  private selectExact(
    userId: string,
    scope: DashboardLayoutScope,
    tenantId: string | null,
  ): DashboardLayout | undefined {
    const row = this.db
      .prepare("SELECT * FROM dashboard_layouts WHERE userId = ? AND scope = ? AND tenantId IS ?")
      .get(userId, scope, tenantId) as Row | undefined;
    return row ? this.mapLayout(row) : undefined;
  }

  private stock(userId: string, tenantId: string | null): DashboardLayout {
    return createDefaultDashboardLayout(userId, scopeFor(tenantId), tenantId);
  }

  async getLayout(userId: string, lookup: DashboardLayoutLookup = {}): Promise<DashboardLayout> {
    const tenantId = lookup.tenantId ?? null;
    if (tenantId !== null) {
      const tenantLayout = this.selectExact(userId, "tenant", tenantId);
      if (tenantLayout) return tenantLayout;
      // SPEC §11.2: a tenant with no override falls back to the user's default.
      const globalLayout = this.selectExact(userId, "global", null);
      if (globalLayout) return globalLayout;
      return this.stock(userId, tenantId);
    }
    return this.selectExact(userId, "global", null) ?? this.stock(userId, null);
  }

  async saveLayout(userId: string, input: DashboardLayoutInput): Promise<DashboardLayout> {
    const tenantId = input.tenantId ?? null;
    const scope = scopeFor(tenantId);
    const id = dashboardLayoutId(userId, scope, tenantId);
    const existing = this.selectExact(userId, scope, tenantId);
    const createdAt = existing?.createdAt ?? nowIso();
    const updatedAt = nowIso();
    this.db
      .prepare(
        `INSERT INTO dashboard_layouts (id, userId, scope, tenantId, widgets, createdAt, updatedAt)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           widgets = excluded.widgets,
           updatedAt = excluded.updatedAt`,
      )
      .run(
        id,
        userId,
        scope,
        tenantId,
        JSON.stringify(cloneWidgets(input.widgets)),
        createdAt,
        updatedAt,
      );
    const saved = this.selectExact(userId, scope, tenantId);
    if (!saved) throw new Error(`dashboard layout ${id} was not persisted`);
    return saved;
  }

  async resetLayout(userId: string, lookup: DashboardLayoutLookup = {}): Promise<DashboardLayout> {
    const tenantId = lookup.tenantId ?? null;
    this.db
      .prepare("DELETE FROM dashboard_layouts WHERE userId = ? AND scope = ? AND tenantId IS ?")
      .run(userId, scopeFor(tenantId), tenantId);
    return this.getLayout(userId, { tenantId });
  }
}

export async function openSqliteDashboardLayoutRepository(
  options: OpenSqliteRepositoryOptions,
): Promise<SqliteDashboardLayoutRepository> {
  const migrations = options.migrations ?? loadMigrations(options.migrationsDir);
  const target = migrations.reduce((max, migration) => Math.max(max, migration.version), 0);
  const db = new Database(options.filename);
  try {
    db.pragma("journal_mode = WAL");
    db.pragma("foreign_keys = ON");
    db.exec(SCHEMA_VERSIONS_TABLE);
    const row = db
      .prepare("SELECT MAX(version) AS version FROM schema_versions")
      .get() as { version: number | null } | undefined;
    const existing = row?.version === null || row?.version === undefined ? 0 : asNumber(row.version);
    if (existing > target) {
      throw new SchemaVersionError(existing, target);
    }
    const applied = runMigrations(db, migrations);
    if (applied !== target) {
      throw new SchemaVersionError(applied, target);
    }
    return new SqliteDashboardLayoutRepository(db, applied);
  } catch (error) {
    db.close();
    throw error;
  }
}
