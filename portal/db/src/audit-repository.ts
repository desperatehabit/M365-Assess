// Audit search, coverage, webhook, and exclusion-window entities (EPIC-032 §5)
// on top of the shared repository contract. Tenant scoping and soft delete are
// enforced here, not left to callers (ADR-0015): every read requires a tenant
// id, rows with `deletedAt` set are hidden unless explicitly requested, and a
// mutation appends an AuditEvent in the same transaction as the write. Coverage
// is a single upserted cache row per tenant with no delete path. No Graph calls
// and no route code belong here.
import Database from "better-sqlite3";
import { randomUUID } from "node:crypto";
import {
  SchemaVersionError,
  type AuditCoverage,
  type AuditCoverageInput,
  type AuditEventInput,
  type AuditExclusionWindow,
  type AuditExclusionWindowInput,
  type AuditExclusionWindowUpdate,
  type AuditSearch,
  type AuditSearchInput,
  type AuditSearchUpdate,
  type ListOptions,
  type WebhookSubscription,
  type WebhookSubscriptionInput,
} from "./repository.js";
import {
  SCHEMA_VERSIONS_TABLE,
  loadMigrations,
  runMigrations,
  type OpenSqliteRepositoryOptions,
} from "./sqlite-repository.js";

type Row = Record<string, unknown>;

function nowIso(): string {
  return new Date().toISOString();
}

function asString(value: unknown): string {
  return String(value);
}

function asNullableString(value: unknown): string | null {
  return value === null || value === undefined ? null : String(value);
}

function asBool(value: unknown): boolean {
  return Number(value) === 1;
}

function parseJson(value: unknown): Record<string, unknown> {
  if (value === null || value === undefined) return {};
  try {
    const parsed: unknown = JSON.parse(String(value));
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

function parseJsonArray(value: unknown): string[] {
  if (value === null || value === undefined) return [];
  try {
    const parsed: unknown = JSON.parse(String(value));
    return Array.isArray(parsed) ? parsed.map((item) => String(item)) : [];
  } catch {
    return [];
  }
}

export interface AuditRepository {
  readonly schemaVersion: number;

  close(): void;

  createAuditSearch(input: AuditSearchInput): Promise<AuditSearch>;
  getAuditSearch(
    tenantId: string,
    searchId: string,
    options?: ListOptions,
  ): Promise<AuditSearch | undefined>;
  listAuditSearches(tenantId: string, options?: ListOptions): Promise<AuditSearch[]>;
  updateAuditSearch(
    tenantId: string,
    searchId: string,
    update: AuditSearchUpdate,
  ): Promise<AuditSearch | undefined>;
  softDeleteAuditSearch(
    tenantId: string,
    searchId: string,
    options?: { now?: string },
  ): Promise<boolean>;

  upsertAuditCoverage(input: AuditCoverageInput): Promise<AuditCoverage>;
  getAuditCoverage(tenantId: string): Promise<AuditCoverage | undefined>;

  createWebhookSubscription(input: WebhookSubscriptionInput): Promise<WebhookSubscription>;
  getWebhookSubscription(
    tenantId: string,
    subscriptionId: string,
  ): Promise<WebhookSubscription | undefined>;
  listWebhookSubscriptions(tenantId: string): Promise<WebhookSubscription[]>;
  listWebhookSubscriptionsExpiringBetween(
    tenantId: string,
    from: string,
    to: string,
  ): Promise<WebhookSubscription[]>;

  createAuditExclusionWindow(input: AuditExclusionWindowInput): Promise<AuditExclusionWindow>;
  getAuditExclusionWindow(
    tenantId: string,
    windowId: string,
    options?: ListOptions,
  ): Promise<AuditExclusionWindow | undefined>;
  listAuditExclusionWindows(
    tenantId: string,
    options?: ListOptions,
  ): Promise<AuditExclusionWindow[]>;
  updateAuditExclusionWindow(
    tenantId: string,
    windowId: string,
    update: AuditExclusionWindowUpdate,
  ): Promise<AuditExclusionWindow | undefined>;
  softDeleteAuditExclusionWindow(
    tenantId: string,
    windowId: string,
    options?: { now?: string },
  ): Promise<boolean>;
}

function snapshot(value: unknown): Record<string, unknown> | null {
  return value === null || value === undefined
    ? null
    : (JSON.parse(JSON.stringify(value)) as Record<string, unknown>);
}

export class SqliteAuditRepository implements AuditRepository {
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

  private mapSearch(row: Row): AuditSearch {
    return {
      id: asString(row["id"]),
      tenantId: asString(row["tenantId"]),
      name: asString(row["name"]),
      filters: parseJson(row["filters"]),
      saved: asBool(row["saved"]),
      scheduleId: asNullableString(row["scheduleId"]),
      lastRunAt: asNullableString(row["lastRunAt"]),
      createdBy: asNullableString(row["createdBy"]),
      createdAt: asString(row["createdAt"]),
      updatedAt: asString(row["updatedAt"]),
      deletedAt: asNullableString(row["deletedAt"]),
    };
  }

  private mapCoverage(row: Row): AuditCoverage {
    return {
      tenantId: asString(row["tenantId"]),
      auditEnabled: asBool(row["auditEnabled"]),
      lastSearchAt: asNullableString(row["lastSearchAt"]),
      gaps: parseJsonArray(row["gaps"]),
      createdAt: asString(row["createdAt"]),
      updatedAt: asString(row["updatedAt"]),
    };
  }

  private mapSubscription(row: Row): WebhookSubscription {
    return {
      id: asString(row["id"]),
      tenantId: asString(row["tenantId"]),
      resource: asString(row["resource"]),
      expiresOn: asNullableString(row["expiresOn"]),
      state: asString(row["state"]),
      notificationUrl: asString(row["notificationUrl"]),
      createdAt: asString(row["createdAt"]),
      updatedAt: asString(row["updatedAt"]),
    };
  }

  private mapWindow(row: Row): AuditExclusionWindow {
    return {
      id: asString(row["id"]),
      tenantId: asString(row["tenantId"]),
      startsAt: asString(row["startsAt"]),
      endsAt: asString(row["endsAt"]),
      reason: asNullableString(row["reason"]),
      createdAt: asString(row["createdAt"]),
      updatedAt: asString(row["updatedAt"]),
      deletedAt: asNullableString(row["deletedAt"]),
    };
  }

  private writeAuditEvent(
    action: string,
    targetType: string,
    targetId: string,
    tenantId: string,
    before: unknown,
    after: unknown,
  ): void {
    const input: AuditEventInput = {
      id: randomUUID(),
      timestamp: nowIso(),
      actorUserId: null,
      actorType: "system",
      tenantId,
      action,
      targetType,
      targetId,
      before: snapshot(before),
      after: snapshot(after),
      result: "success",
      error: null,
      source: "request",
      correlationId: null,
    };
    this.db
      .prepare(
        `INSERT INTO audit_events
           (id, timestamp, actorUserId, actorType, tenantId, action, targetType, targetId, before, after, result, error, source, correlationId, createdAt)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.id,
        input.timestamp,
        input.actorUserId,
        input.actorType,
        input.tenantId,
        input.action,
        input.targetType,
        input.targetId,
        input.before === null ? null : JSON.stringify(input.before),
        input.after === null ? null : JSON.stringify(input.after),
        input.result,
        input.error,
        input.source,
        input.correlationId,
        input.timestamp,
      );
  }

  async createAuditSearch(input: AuditSearchInput): Promise<AuditSearch> {
    const createdAt = input.createdAt ?? nowIso();
    const search: AuditSearch = {
      id: input.id,
      tenantId: input.tenantId,
      name: input.name,
      filters: input.filters,
      saved: input.saved,
      scheduleId: input.scheduleId ?? null,
      lastRunAt: input.lastRunAt ?? null,
      createdBy: input.createdBy ?? null,
      createdAt,
      updatedAt: input.updatedAt ?? createdAt,
      deletedAt: input.deletedAt ?? null,
    };
    this.db.transaction(() => {
      this.db
        .prepare(
          `INSERT INTO audit_searches
             (id, tenantId, name, filters, saved, scheduleId, lastRunAt, createdBy, createdAt, updatedAt, deletedAt)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          search.id,
          search.tenantId,
          search.name,
          JSON.stringify(search.filters),
          search.saved ? 1 : 0,
          search.scheduleId,
          search.lastRunAt,
          search.createdBy,
          search.createdAt,
          search.updatedAt,
          search.deletedAt,
        );
      this.writeAuditEvent("audit.search.create", "audit_search", search.id, search.tenantId, null, search);
    })();
    const persisted = await this.getAuditSearch(search.tenantId, search.id);
    if (!persisted) throw new Error(`audit search ${search.id} was not persisted`);
    return persisted;
  }

  async getAuditSearch(
    tenantId: string,
    searchId: string,
    options: ListOptions = {},
  ): Promise<AuditSearch | undefined> {
    const sql = options.includeDeleted
      ? "SELECT * FROM audit_searches WHERE id = ? AND tenantId = ?"
      : "SELECT * FROM audit_searches WHERE id = ? AND tenantId = ? AND deletedAt IS NULL";
    const row = this.db.prepare(sql).get(searchId, tenantId) as Row | undefined;
    return row ? this.mapSearch(row) : undefined;
  }

  async listAuditSearches(tenantId: string, options: ListOptions = {}): Promise<AuditSearch[]> {
    const sql = options.includeDeleted
      ? "SELECT * FROM audit_searches WHERE tenantId = ? ORDER BY createdAt, id"
      : "SELECT * FROM audit_searches WHERE tenantId = ? AND deletedAt IS NULL ORDER BY createdAt, id";
    return (this.db.prepare(sql).all(tenantId) as Row[]).map((row) => this.mapSearch(row));
  }

  async updateAuditSearch(
    tenantId: string,
    searchId: string,
    update: AuditSearchUpdate,
  ): Promise<AuditSearch | undefined> {
    const existing = await this.getAuditSearch(tenantId, searchId);
    if (!existing) return undefined;
    const updated: AuditSearch = {
      ...existing,
      name: update.name ?? existing.name,
      filters: update.filters === undefined ? existing.filters : update.filters,
      saved: update.saved === undefined ? existing.saved : update.saved,
      scheduleId: update.scheduleId === undefined ? existing.scheduleId : update.scheduleId,
      lastRunAt: update.lastRunAt === undefined ? existing.lastRunAt : update.lastRunAt,
      updatedAt: nowIso(),
    };
    this.db.transaction(() => {
      this.db
        .prepare(
          `UPDATE audit_searches
             SET name = ?, filters = ?, saved = ?, scheduleId = ?, lastRunAt = ?, updatedAt = ?
           WHERE id = ? AND tenantId = ? AND deletedAt IS NULL`,
        )
        .run(
          updated.name,
          JSON.stringify(updated.filters),
          updated.saved ? 1 : 0,
          updated.scheduleId,
          updated.lastRunAt,
          updated.updatedAt,
          searchId,
          tenantId,
        );
      this.writeAuditEvent("audit.search.update", "audit_search", searchId, tenantId, existing, updated);
    })();
    return this.getAuditSearch(tenantId, searchId);
  }

  async softDeleteAuditSearch(
    tenantId: string,
    searchId: string,
    options: { now?: string } = {},
  ): Promise<boolean> {
    const existing = await this.getAuditSearch(tenantId, searchId);
    if (!existing) return false;
    const at = options.now ?? nowIso();
    const after: AuditSearch = { ...existing, deletedAt: at, updatedAt: at };
    this.db.transaction(() => {
      this.db
        .prepare(
          "UPDATE audit_searches SET deletedAt = ?, updatedAt = ? WHERE id = ? AND tenantId = ? AND deletedAt IS NULL",
        )
        .run(at, at, searchId, tenantId);
      this.writeAuditEvent("audit.search.delete", "audit_search", searchId, tenantId, existing, after);
    })();
    return true;
  }

  async upsertAuditCoverage(input: AuditCoverageInput): Promise<AuditCoverage> {
    const createdAt = input.createdAt ?? nowIso();
    const coverage: AuditCoverage = {
      tenantId: input.tenantId,
      auditEnabled: input.auditEnabled,
      lastSearchAt: input.lastSearchAt ?? null,
      gaps: input.gaps ?? [],
      createdAt,
      updatedAt: input.updatedAt ?? createdAt,
    };
    this.db
      .prepare(
        `INSERT INTO audit_coverage (tenantId, auditEnabled, lastSearchAt, gaps, createdAt, updatedAt)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(tenantId) DO UPDATE SET
           auditEnabled = excluded.auditEnabled,
           lastSearchAt = excluded.lastSearchAt,
           gaps = excluded.gaps,
           updatedAt = excluded.updatedAt`,
      )
      .run(
        coverage.tenantId,
        coverage.auditEnabled ? 1 : 0,
        coverage.lastSearchAt,
        JSON.stringify(coverage.gaps),
        coverage.createdAt,
        coverage.updatedAt,
      );
    const persisted = await this.getAuditCoverage(coverage.tenantId);
    if (!persisted) throw new Error(`audit coverage for tenant ${coverage.tenantId} was not persisted`);
    return persisted;
  }

  async getAuditCoverage(tenantId: string): Promise<AuditCoverage | undefined> {
    const row = this.db
      .prepare("SELECT * FROM audit_coverage WHERE tenantId = ?")
      .get(tenantId) as Row | undefined;
    return row ? this.mapCoverage(row) : undefined;
  }

  async createWebhookSubscription(
    input: WebhookSubscriptionInput,
  ): Promise<WebhookSubscription> {
    const createdAt = input.createdAt ?? nowIso();
    const subscription: WebhookSubscription = {
      id: input.id,
      tenantId: input.tenantId,
      resource: input.resource,
      expiresOn: input.expiresOn ?? null,
      state: input.state,
      notificationUrl: input.notificationUrl,
      createdAt,
      updatedAt: input.updatedAt ?? createdAt,
    };
    this.db.transaction(() => {
      this.db
        .prepare(
          `INSERT INTO webhook_subscriptions
             (id, tenantId, resource, expiresOn, state, notificationUrl, createdAt, updatedAt)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          subscription.id,
          subscription.tenantId,
          subscription.resource,
          subscription.expiresOn,
          subscription.state,
          subscription.notificationUrl,
          subscription.createdAt,
          subscription.updatedAt,
        );
      this.writeAuditEvent("audit.webhook.create", "webhook_subscription", subscription.id, subscription.tenantId, null, subscription);
    })();
    const persisted = await this.getWebhookSubscription(subscription.tenantId, subscription.id);
    if (!persisted) throw new Error(`webhook subscription ${subscription.id} was not persisted`);
    return persisted;
  }

  async getWebhookSubscription(
    tenantId: string,
    subscriptionId: string,
  ): Promise<WebhookSubscription | undefined> {
    const row = this.db
      .prepare("SELECT * FROM webhook_subscriptions WHERE id = ? AND tenantId = ?")
      .get(subscriptionId, tenantId) as Row | undefined;
    return row ? this.mapSubscription(row) : undefined;
  }

  async listWebhookSubscriptions(tenantId: string): Promise<WebhookSubscription[]> {
    return (
      this.db
        .prepare("SELECT * FROM webhook_subscriptions WHERE tenantId = ? ORDER BY createdAt, id")
        .all(tenantId) as Row[]
    ).map((row) => this.mapSubscription(row));
  }

  async listWebhookSubscriptionsExpiringBetween(
    tenantId: string,
    from: string,
    to: string,
  ): Promise<WebhookSubscription[]> {
    return (
      this.db
        .prepare(
          `SELECT * FROM webhook_subscriptions
           WHERE tenantId = ? AND expiresOn IS NOT NULL AND expiresOn >= ? AND expiresOn <= ?
           ORDER BY expiresOn, id`,
        )
        .all(tenantId, from, to) as Row[]
    ).map((row) => this.mapSubscription(row));
  }

  async createAuditExclusionWindow(
    input: AuditExclusionWindowInput,
  ): Promise<AuditExclusionWindow> {
    const createdAt = input.createdAt ?? nowIso();
    const window: AuditExclusionWindow = {
      id: input.id,
      tenantId: input.tenantId,
      startsAt: input.startsAt,
      endsAt: input.endsAt,
      reason: input.reason ?? null,
      createdAt,
      updatedAt: input.updatedAt ?? createdAt,
      deletedAt: input.deletedAt ?? null,
    };
    this.db.transaction(() => {
      this.db
        .prepare(
          `INSERT INTO audit_exclusion_windows
             (id, tenantId, startsAt, endsAt, reason, createdAt, updatedAt, deletedAt)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          window.id,
          window.tenantId,
          window.startsAt,
          window.endsAt,
          window.reason,
          window.createdAt,
          window.updatedAt,
          window.deletedAt,
        );
      this.writeAuditEvent("audit.window.create", "audit_exclusion_window", window.id, window.tenantId, null, window);
    })();
    const persisted = await this.getAuditExclusionWindow(window.tenantId, window.id);
    if (!persisted) throw new Error(`audit exclusion window ${window.id} was not persisted`);
    return persisted;
  }

  async getAuditExclusionWindow(
    tenantId: string,
    windowId: string,
    options: ListOptions = {},
  ): Promise<AuditExclusionWindow | undefined> {
    const sql = options.includeDeleted
      ? "SELECT * FROM audit_exclusion_windows WHERE id = ? AND tenantId = ?"
      : "SELECT * FROM audit_exclusion_windows WHERE id = ? AND tenantId = ? AND deletedAt IS NULL";
    const row = this.db.prepare(sql).get(windowId, tenantId) as Row | undefined;
    return row ? this.mapWindow(row) : undefined;
  }

  async listAuditExclusionWindows(
    tenantId: string,
    options: ListOptions = {},
  ): Promise<AuditExclusionWindow[]> {
    const sql = options.includeDeleted
      ? "SELECT * FROM audit_exclusion_windows WHERE tenantId = ? ORDER BY startsAt, id"
      : "SELECT * FROM audit_exclusion_windows WHERE tenantId = ? AND deletedAt IS NULL ORDER BY startsAt, id";
    return (this.db.prepare(sql).all(tenantId) as Row[]).map((row) => this.mapWindow(row));
  }

  async updateAuditExclusionWindow(
    tenantId: string,
    windowId: string,
    update: AuditExclusionWindowUpdate,
  ): Promise<AuditExclusionWindow | undefined> {
    const existing = await this.getAuditExclusionWindow(tenantId, windowId);
    if (!existing) return undefined;
    const updated: AuditExclusionWindow = {
      ...existing,
      startsAt: update.startsAt ?? existing.startsAt,
      endsAt: update.endsAt ?? existing.endsAt,
      reason: update.reason === undefined ? existing.reason : update.reason,
      updatedAt: nowIso(),
    };
    this.db.transaction(() => {
      this.db
        .prepare(
          `UPDATE audit_exclusion_windows
             SET startsAt = ?, endsAt = ?, reason = ?, updatedAt = ?
           WHERE id = ? AND tenantId = ? AND deletedAt IS NULL`,
        )
        .run(updated.startsAt, updated.endsAt, updated.reason, updated.updatedAt, windowId, tenantId);
      this.writeAuditEvent("audit.window.update", "audit_exclusion_window", windowId, tenantId, existing, updated);
    })();
    return this.getAuditExclusionWindow(tenantId, windowId);
  }

  async softDeleteAuditExclusionWindow(
    tenantId: string,
    windowId: string,
    options: { now?: string } = {},
  ): Promise<boolean> {
    const existing = await this.getAuditExclusionWindow(tenantId, windowId);
    if (!existing) return false;
    const at = options.now ?? nowIso();
    const after: AuditExclusionWindow = { ...existing, deletedAt: at, updatedAt: at };
    this.db.transaction(() => {
      this.db
        .prepare(
          "UPDATE audit_exclusion_windows SET deletedAt = ?, updatedAt = ? WHERE id = ? AND tenantId = ? AND deletedAt IS NULL",
        )
        .run(at, at, windowId, tenantId);
      this.writeAuditEvent("audit.window.delete", "audit_exclusion_window", windowId, tenantId, existing, after);
    })();
    return true;
  }
}

export async function openSqliteAuditRepository(
  options: OpenSqliteRepositoryOptions,
): Promise<SqliteAuditRepository> {
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
    const existing = row?.version === null || row?.version === undefined ? 0 : Number(row.version);
    if (existing > target) {
      throw new SchemaVersionError(existing, target);
    }
    const applied = runMigrations(db, migrations);
    if (applied !== target) {
      throw new SchemaVersionError(applied, target);
    }
    return new SqliteAuditRepository(db, applied);
  } catch (error) {
    db.close();
    throw error;
  }
}
