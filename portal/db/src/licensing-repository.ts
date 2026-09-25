// License pricing and per-user assignment changes (EPIC-033 §5) on top of the
// shared repository contract. Pricing is global with a per-tenant override
// that wins for that tenant's cost view (SPEC §11.2): a NULL tenantId is the
// global seed, and reads resolve the per-tenant row first, falling back to
// the global row. LicenseChange is append-only (id/tenantId/userId/skuId/
// action/state/by/at): only append/get/list are exposed, every write appends
// an AuditEvent in the same transaction, and the migration adds no-update and
// no-delete triggers so the invariant does not depend on callers (ADR-0015).
// Tenant scoping is enforced here, not left to callers. No Graph calls and
// no route code belong here.
import Database from "better-sqlite3";
import { randomUUID } from "node:crypto";
import {
  SchemaVersionError,
  type AuditEventInput,
  type LicenseChange,
  type LicenseChangeAction,
  type LicenseChangeInput,
  type LicenseChangeListOptions,
  type LicensePricing,
  type LicensePricingInput,
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

function asNumber(value: unknown): number {
  return typeof value === "number" ? value : Number(value);
}

export interface LicensingRepository {
  readonly schemaVersion: number;

  close(): void;

  getLicensePricing(tenantId: string, skuId: string): Promise<LicensePricing | undefined>;
  listLicensePricing(tenantId?: string): Promise<LicensePricing[]>;
  upsertLicensePricing(input: LicensePricingInput): Promise<LicensePricing>;

  appendLicenseChange(input: LicenseChangeInput): Promise<LicenseChange>;
  getLicenseChange(tenantId: string, changeId: string): Promise<LicenseChange | undefined>;
  listLicenseChanges(
    tenantId: string,
    options?: LicenseChangeListOptions,
  ): Promise<LicenseChange[]>;
}

function snapshot(value: unknown): Record<string, unknown> | null {
  return value === null || value === undefined
    ? null
    : (JSON.parse(JSON.stringify(value)) as Record<string, unknown>);
}

export class SqliteLicensingRepository implements LicensingRepository {
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

  private mapPricing(row: Row): LicensePricing {
    return {
      skuId: asString(row["skuId"]),
      tenantId: asNullableString(row["tenantId"]),
      skuPartNumber: asNullableString(row["skuPartNumber"]),
      unitPrice: asNumber(row["unitPrice"]),
      currency: asString(row["currency"]),
      updatedAt: asString(row["updatedAt"]),
    };
  }

  private mapChange(row: Row): LicenseChange {
    return {
      id: asString(row["id"]),
      tenantId: asString(row["tenantId"]),
      userId: asString(row["userId"]),
      skuId: asString(row["skuId"]),
      action: asString(row["action"]) as LicenseChangeAction,
      state: asString(row["state"]),
      by: asNullableString(row["by"]),
      at: asString(row["at"]),
    };
  }

  private writeAuditEvent(
    action: string,
    targetType: string,
    targetId: string,
    tenantId: string | null,
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

  async getLicensePricing(tenantId: string, skuId: string): Promise<LicensePricing | undefined> {
    const scoped = this.db
      .prepare("SELECT * FROM license_pricing WHERE skuId = ? AND tenantId = ?")
      .get(skuId, tenantId) as Row | undefined;
    if (scoped) return this.mapPricing(scoped);
    const global = this.db
      .prepare("SELECT * FROM license_pricing WHERE skuId = ? AND tenantId IS NULL")
      .get(skuId) as Row | undefined;
    return global ? this.mapPricing(global) : undefined;
  }

  async listLicensePricing(tenantId?: string): Promise<LicensePricing[]> {
    if (tenantId === undefined) {
      return (
        this.db
          .prepare("SELECT * FROM license_pricing WHERE tenantId IS NULL ORDER BY skuId")
          .all() as Row[]
      ).map((row) => this.mapPricing(row));
    }
    const rows = this.db
      .prepare(
        "SELECT * FROM license_pricing WHERE tenantId = ? OR tenantId IS NULL ORDER BY skuId",
      )
      .all(tenantId) as Row[];
    const bySku = new Map<string, LicensePricing>();
    for (const row of rows) {
      const pricing = this.mapPricing(row);
      const existing = bySku.get(pricing.skuId);
      if (!existing || existing.tenantId === null) bySku.set(pricing.skuId, pricing);
    }
    return [...bySku.values()].sort((a, b) => a.skuId.localeCompare(b.skuId));
  }

  async upsertLicensePricing(input: LicensePricingInput): Promise<LicensePricing> {
    const tenantId = input.tenantId ?? null;
    const updatedAt = input.updatedAt ?? nowIso();
    const pricing: LicensePricing = {
      skuId: input.skuId,
      tenantId,
      skuPartNumber: input.skuPartNumber ?? null,
      unitPrice: input.unitPrice,
      currency: input.currency,
      updatedAt,
    };
    this.db.transaction(() => {
      const before =
        tenantId === null
          ? ((this.db
              .prepare("SELECT * FROM license_pricing WHERE skuId = ? AND tenantId IS NULL")
              .get(pricing.skuId) as Row | undefined) ?? null)
          : ((this.db
              .prepare("SELECT * FROM license_pricing WHERE skuId = ? AND tenantId = ?")
              .get(pricing.skuId, tenantId) as Row | undefined) ?? null);
      const updated =
        tenantId === null
          ? this.db
              .prepare(
                `UPDATE license_pricing
                    SET skuPartNumber = ?, unitPrice = ?, currency = ?, updatedAt = ?
                  WHERE skuId = ? AND tenantId IS NULL`,
              )
              .run(pricing.skuPartNumber, pricing.unitPrice, pricing.currency, updatedAt, pricing.skuId)
          : this.db
              .prepare(
                `UPDATE license_pricing
                    SET skuPartNumber = ?, unitPrice = ?, currency = ?, updatedAt = ?
                  WHERE skuId = ? AND tenantId = ?`,
              )
              .run(
                pricing.skuPartNumber,
                pricing.unitPrice,
                pricing.currency,
                updatedAt,
                pricing.skuId,
                tenantId,
              );
      if (updated.changes === 0) {
        this.db
          .prepare(
            `INSERT INTO license_pricing
               (skuId, tenantId, skuPartNumber, unitPrice, currency, updatedAt)
             VALUES (?, ?, ?, ?, ?, ?)`,
          )
          .run(
            pricing.skuId,
            tenantId,
            pricing.skuPartNumber,
            pricing.unitPrice,
            pricing.currency,
            updatedAt,
          );
      }
      this.writeAuditEvent(
        "licensing.pricing.upsert",
        "license_pricing",
        pricing.skuId,
        tenantId,
        before ? this.mapPricing(before) : null,
        pricing,
      );
    })();
    if (tenantId === null) {
      const row = this.db
        .prepare("SELECT * FROM license_pricing WHERE skuId = ? AND tenantId IS NULL")
        .get(pricing.skuId) as Row | undefined;
      if (!row) throw new Error(`license pricing ${pricing.skuId} was not persisted`);
      return this.mapPricing(row);
    }
    const persisted = await this.getLicensePricing(tenantId, pricing.skuId);
    if (!persisted) throw new Error(`license pricing ${pricing.skuId} was not persisted`);
    return persisted;
  }

  async appendLicenseChange(input: LicenseChangeInput): Promise<LicenseChange> {
    const change: LicenseChange = {
      id: input.id,
      tenantId: input.tenantId,
      userId: input.userId,
      skuId: input.skuId,
      action: input.action,
      state: input.state,
      by: input.by ?? null,
      at: input.at ?? nowIso(),
    };
    this.db.transaction(() => {
      this.db
        .prepare(
          `INSERT INTO license_changes
             (id, tenantId, userId, skuId, action, state, "by", "at")
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          change.id,
          change.tenantId,
          change.userId,
          change.skuId,
          change.action,
          change.state,
          change.by,
          change.at,
        );
      this.writeAuditEvent(
        "licensing.change.append",
        "license_change",
        change.id,
        change.tenantId,
        null,
        change,
      );
    })();
    const persisted = await this.getLicenseChange(change.tenantId, change.id);
    if (!persisted) throw new Error(`license change ${change.id} was not persisted`);
    return persisted;
  }

  async getLicenseChange(tenantId: string, changeId: string): Promise<LicenseChange | undefined> {
    const row = this.db
      .prepare("SELECT * FROM license_changes WHERE id = ? AND tenantId = ?")
      .get(changeId, tenantId) as Row | undefined;
    return row ? this.mapChange(row) : undefined;
  }

  async listLicenseChanges(
    tenantId: string,
    options: LicenseChangeListOptions = {},
  ): Promise<LicenseChange[]> {
    if (options.userId === undefined) {
      return (
        this.db
          .prepare('SELECT * FROM license_changes WHERE tenantId = ? ORDER BY "at", id')
          .all(tenantId) as Row[]
      ).map((row) => this.mapChange(row));
    }
    return (
      this.db
        .prepare('SELECT * FROM license_changes WHERE tenantId = ? AND userId = ? ORDER BY "at", id')
        .all(tenantId, options.userId) as Row[]
    ).map((row) => this.mapChange(row));
  }
}

export async function openSqliteLicensingRepository(
  options: OpenSqliteRepositoryOptions,
): Promise<SqliteLicensingRepository> {
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
    return new SqliteLicensingRepository(db, applied);
  } catch (error) {
    db.close();
    throw error;
  }
}
