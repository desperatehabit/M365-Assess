// EPIC-029 alerting entities (SPEC §5, T-0859).
//
// Migration 0037 defines alert_rules, alert_events, notification_configs, and
// webhook_rules but shipped no repository, so the route stores were implemented only
// by test fakes. This repository persists all four entities. Migration 0128 adds the
// columns the route contracts need (rule tenant/severity/scope/channels/builtIn and an
// event source), and `lastFiredAt` is derived from the newest event.
import { randomUUID } from "node:crypto";
import Database from "better-sqlite3";
import { SchemaVersionError } from "./repository.js";
import {
  SCHEMA_VERSIONS_TABLE,
  loadMigrations,
  runMigrations,
  type OpenSqliteRepositoryOptions,
} from "./sqlite-repository.js";

export type AlertRuleSeverity = "Critical" | "High" | "Medium" | "Low" | "Info";
export type AlertRuleScope = "tenant" | "group";
export type AlertRuleChannel = "email" | "webhook" | "psa" | "slack";

export const ALERT_EVENT_STATES = ["open", "snoozed", "resolved"] as const;
export type AlertEventState = (typeof ALERT_EVENT_STATES)[number];

export interface AlertRuleRecord {
  id: string;
  name: string;
  source: string;
  severity: AlertRuleSeverity;
  scope: AlertRuleScope;
  channels: AlertRuleChannel[];
  enabled: boolean;
  scriptMode: boolean;
  scheduleId: string | null;
  lastFiredAt: string | null;
  builtIn: boolean;
  /** Null for a global rule; the tenant a rule is scoped to otherwise. */
  tenantId: string | null;
  /** The authored criteria, exposed to the dry-run evaluator. */
  conditions: unknown[];
  actions: unknown[];
  createdAt: string;
  updatedAt: string;
  deletedAt: string | null;
}

export interface AlertRuleUpsert {
  readonly id: string;
  readonly name: string;
  readonly source: string;
  readonly severity: AlertRuleSeverity;
  readonly scope: AlertRuleScope;
  readonly channels: readonly AlertRuleChannel[];
  readonly enabled?: boolean;
  readonly scriptMode?: boolean;
  readonly scheduleId?: string | null;
  readonly builtIn?: boolean;
  readonly tenantId?: string | null;
  readonly conditions?: readonly unknown[];
  readonly actions?: readonly unknown[];
}

export interface AlertRulePatch {
  readonly name?: string;
  readonly source?: string;
  readonly severity?: AlertRuleSeverity;
  readonly scope?: AlertRuleScope;
  readonly channels?: readonly AlertRuleChannel[];
  readonly enabled?: boolean;
  readonly scriptMode?: boolean;
  readonly scheduleId?: string | null;
  readonly builtIn?: boolean;
  readonly tenantId?: string | null;
  readonly conditions?: readonly unknown[];
  readonly actions?: readonly unknown[];
}

export interface AlertEventRecord {
  id: string;
  ruleId: string;
  tenantId: string;
  firedAt: string;
  severity: AlertRuleSeverity;
  payload: Record<string, unknown> | null;
  state: AlertEventState;
  snoozeUntil: string | null;
  /** The owning rule's source, joined for the §3.5 queue view. */
  source: string | null;
  createdAt: string;
  updatedAt: string;
  deletedAt: string | null;
}

export interface AlertEventInsert {
  readonly id?: string;
  readonly ruleId: string;
  readonly tenantId: string;
  readonly firedAt: string;
  readonly severity: AlertRuleSeverity;
  readonly payload?: Record<string, unknown> | null;
  readonly state?: AlertEventState;
  readonly snoozeUntil?: string | null;
}

export interface AlertEventQuery {
  readonly tenantId?: string;
  readonly ruleId?: string;
  readonly state?: AlertEventState;
  readonly source?: string;
  readonly severity?: AlertRuleSeverity;
  readonly cursor: string | null;
  readonly limit: number;
}

export interface AlertEventQueryPage {
  readonly totalCount: number;
  readonly items: AlertEventRecord[];
  readonly nextCursor: string | null;
}

export const NOTIFICATION_CHANNELS = ["email", "webhook", "psa", "slack"] as const;
export type NotificationChannel = (typeof NOTIFICATION_CHANNELS)[number];

export interface NotificationConfigRecord {
  id: string;
  channel: NotificationChannel;
  target: string;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
  deletedAt: string | null;
}

export interface WebhookRuleRecord {
  id: string;
  url: string;
  match: string;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
  deletedAt: string | null;
}

export interface WebhookRuleUpsert {
  readonly id: string;
  readonly url: string;
  readonly match: string;
  readonly enabled?: boolean;
}

interface RuleRow {
  id: string;
  name: string;
  source: string;
  severity: string;
  scope: string;
  channels: string;
  conditions: string;
  actions: string;
  enabled: number;
  scriptMode: number;
  scheduleId: string | null;
  builtIn: number;
  tenantId: string | null;
  lastFiredAt: string | null;
  createdAt: string;
  updatedAt: string;
  deletedAt: string | null;
}

interface EventRow {
  id: string;
  ruleId: string;
  tenantId: string;
  firedAt: string;
  severity: string;
  payload: string | null;
  state: string;
  snoozeUntil: string | null;
  source: string | null;
  createdAt: string;
  updatedAt: string;
  deletedAt: string | null;
}

interface NotificationRow {
  id: string;
  channel: string;
  target: string;
  enabled: number;
  createdAt: string;
  updatedAt: string;
  deletedAt: string | null;
}

interface WebhookRuleRow {
  id: string;
  url: string;
  match: string;
  enabled: number;
  createdAt: string;
  updatedAt: string;
  deletedAt: string | null;
}

function parseJsonArray(value: string): unknown[] {
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function parseJsonObject(value: string | null): Record<string, unknown> | null {
  if (value === null) return null;
  try {
    const parsed = JSON.parse(value) as unknown;
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function encodeCursor(offset: number): string {
  return Buffer.from(String(offset), "utf8").toString("base64url");
}

function decodeCursor(cursor: string | null): number {
  if (cursor === null || cursor.length === 0) return 0;
  const value = Number(Buffer.from(cursor, "base64url").toString("utf8"));
  return Number.isInteger(value) && value >= 0 ? value : 0;
}

const RULE_SELECT = `
  SELECT r.*,
         (SELECT MAX(e.firedAt) FROM alert_events e
           WHERE e.ruleId = r.id AND e.deletedAt IS NULL) AS lastFiredAt
    FROM alert_rules r`;

const EVENT_SELECT = `
  SELECT e.*, r.source AS source
    FROM alert_events e
    JOIN alert_rules r ON r.id = e.ruleId`;

export class SqliteAlertingRepository {
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

  // ── alert rules ───────────────────────────────────────────────────────────

  private mapRule(row: RuleRow): AlertRuleRecord {
    return {
      id: row.id,
      name: row.name,
      source: row.source,
      severity: row.severity as AlertRuleSeverity,
      scope: row.scope as AlertRuleScope,
      channels: parseJsonArray(row.channels) as AlertRuleChannel[],
      enabled: row.enabled === 1,
      scriptMode: row.scriptMode === 1,
      scheduleId: row.scheduleId,
      lastFiredAt: row.lastFiredAt,
      builtIn: row.builtIn === 1,
      tenantId: row.tenantId,
      conditions: parseJsonArray(row.conditions),
      actions: parseJsonArray(row.actions),
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
      deletedAt: row.deletedAt,
    };
  }

  async listRules(): Promise<AlertRuleRecord[]> {
    return (
      this.db.prepare(`${RULE_SELECT} WHERE r.deletedAt IS NULL ORDER BY r.createdAt, r.id`).all() as RuleRow[]
    ).map((row) => this.mapRule(row));
  }

  async getRule(ruleId: string): Promise<AlertRuleRecord | undefined> {
    const row = this.db
      .prepare(`${RULE_SELECT} WHERE r.id = ? AND r.deletedAt IS NULL`)
      .get(ruleId) as RuleRow | undefined;
    return row === undefined ? undefined : this.mapRule(row);
  }

  async createRule(input: AlertRuleUpsert): Promise<AlertRuleRecord> {
    const now = new Date().toISOString();
    this.db
      .prepare(
        `INSERT INTO alert_rules
           (id, name, source, conditions, actions, enabled, scriptMode, scheduleId,
            tenantId, severity, scope, channels, builtIn, createdAt, updatedAt, deletedAt)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)`,
      )
      .run(
        input.id,
        input.name,
        input.source,
        JSON.stringify(input.conditions ?? []),
        JSON.stringify(input.actions ?? []),
        (input.enabled ?? true) ? 1 : 0,
        (input.scriptMode ?? false) ? 1 : 0,
        input.scheduleId ?? null,
        input.tenantId ?? null,
        input.severity,
        input.scope,
        JSON.stringify(input.channels),
        (input.builtIn ?? false) ? 1 : 0,
        now,
        now,
      );
    return (await this.getRule(input.id))!;
  }

  /** Inserts a catalog rule only when it is not already stored, preserving operator state. */
  async seedRules(rules: readonly AlertRuleUpsert[]): Promise<number> {
    let inserted = 0;
    const now = new Date().toISOString();
    const statement = this.db.prepare(
      `INSERT OR IGNORE INTO alert_rules
         (id, name, source, conditions, actions, enabled, scriptMode, scheduleId,
          tenantId, severity, scope, channels, builtIn, createdAt, updatedAt, deletedAt)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)`,
    );
    this.db.transaction(() => {
      for (const input of rules) {
        const info = statement.run(
          input.id,
          input.name,
          input.source,
          JSON.stringify(input.conditions ?? []),
          JSON.stringify(input.actions ?? []),
          (input.enabled ?? false) ? 1 : 0,
          (input.scriptMode ?? false) ? 1 : 0,
          input.scheduleId ?? null,
          input.tenantId ?? null,
          input.severity,
          input.scope,
          JSON.stringify(input.channels),
          (input.builtIn ?? true) ? 1 : 0,
          now,
          now,
        );
        inserted += info.changes;
      }
    })();
    return inserted;
  }

  async updateRule(ruleId: string, patch: AlertRulePatch): Promise<AlertRuleRecord | undefined> {
    const existing = await this.getRule(ruleId);
    if (existing === undefined) return undefined;
    const next = {
      name: patch.name ?? existing.name,
      source: patch.source ?? existing.source,
      severity: patch.severity ?? existing.severity,
      scope: patch.scope ?? existing.scope,
      channels: patch.channels ?? existing.channels,
      enabled: patch.enabled ?? existing.enabled,
      scriptMode: patch.scriptMode ?? existing.scriptMode,
      scheduleId: patch.scheduleId !== undefined ? patch.scheduleId : existing.scheduleId,
      builtIn: patch.builtIn ?? existing.builtIn,
      tenantId: patch.tenantId !== undefined ? patch.tenantId : existing.tenantId,
      conditions: patch.conditions ?? existing.conditions,
      actions: patch.actions ?? existing.actions,
    };
    this.db
      .prepare(
        `UPDATE alert_rules
            SET name = ?, source = ?, severity = ?, scope = ?, channels = ?,
                enabled = ?, scriptMode = ?, scheduleId = ?, builtIn = ?, tenantId = ?,
                conditions = ?, actions = ?, updatedAt = ?
          WHERE id = ? AND deletedAt IS NULL`,
      )
      .run(
        next.name,
        next.source,
        next.severity,
        next.scope,
        JSON.stringify(next.channels),
        next.enabled ? 1 : 0,
        next.scriptMode ? 1 : 0,
        next.scheduleId,
        next.builtIn ? 1 : 0,
        next.tenantId,
        JSON.stringify(next.conditions),
        JSON.stringify(next.actions),
        new Date().toISOString(),
        ruleId,
      );
    return this.getRule(ruleId);
  }

  async setRuleEnabled(ruleId: string, enabled: boolean): Promise<AlertRuleRecord | undefined> {
    return this.updateRule(ruleId, { enabled });
  }

  async deleteRule(ruleId: string): Promise<boolean> {
    const info = this.db
      .prepare("UPDATE alert_rules SET deletedAt = ?, updatedAt = ? WHERE id = ? AND deletedAt IS NULL")
      .run(new Date().toISOString(), new Date().toISOString(), ruleId);
    return info.changes > 0;
  }

  // ── alert events ──────────────────────────────────────────────────────────

  private mapEvent(row: EventRow): AlertEventRecord {
    return {
      id: row.id,
      ruleId: row.ruleId,
      tenantId: row.tenantId,
      firedAt: row.firedAt,
      severity: row.severity as AlertRuleSeverity,
      payload: parseJsonObject(row.payload),
      state: row.state as AlertEventState,
      snoozeUntil: row.snoozeUntil,
      source: row.source,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
      deletedAt: row.deletedAt,
    };
  }

  async createEvent(input: AlertEventInsert): Promise<AlertEventRecord> {
    const id = input.id ?? randomUUID();
    const now = new Date().toISOString();
    this.db
      .prepare(
        `INSERT INTO alert_events
           (id, ruleId, tenantId, firedAt, severity, payload, state, snoozeUntil, createdAt, updatedAt, deletedAt)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)`,
      )
      .run(
        id,
        input.ruleId,
        input.tenantId,
        input.firedAt,
        input.severity,
        input.payload === undefined || input.payload === null ? null : JSON.stringify(input.payload),
        input.state ?? "open",
        input.snoozeUntil ?? null,
        now,
        now,
      );
    const row = this.db.prepare(`${EVENT_SELECT} WHERE e.id = ?`).get(id) as EventRow | undefined;
    return this.mapEvent(row!);
  }

  async listEvents(query: AlertEventQuery): Promise<AlertEventQueryPage> {
    const clauses: string[] = ["e.deletedAt IS NULL"];
    const values: unknown[] = [];
    if (query.tenantId !== undefined) {
      clauses.push("e.tenantId = ?");
      values.push(query.tenantId);
    }
    if (query.ruleId !== undefined) {
      clauses.push("e.ruleId = ?");
      values.push(query.ruleId);
    }
    if (query.state !== undefined) {
      clauses.push("e.state = ?");
      values.push(query.state);
    }
    if (query.severity !== undefined) {
      clauses.push("e.severity = ?");
      values.push(query.severity);
    }
    if (query.source !== undefined) {
      clauses.push("r.source = ?");
      values.push(query.source);
    }
    const where = `WHERE ${clauses.join(" AND ")}`;
    const total = this.db
      .prepare(`SELECT COUNT(*) AS count FROM alert_events e JOIN alert_rules r ON r.id = e.ruleId ${where}`)
      .get(...values) as { count: number };
    const offset = decodeCursor(query.cursor);
    const rows = this.db
      .prepare(`${EVENT_SELECT} ${where} ORDER BY e.firedAt DESC, e.id DESC LIMIT ? OFFSET ?`)
      .all(...values, query.limit, offset) as EventRow[];
    const items = rows.map((row) => this.mapEvent(row));
    const nextOffset = offset + items.length;
    return {
      totalCount: total.count,
      items,
      nextCursor: nextOffset < total.count ? encodeCursor(nextOffset) : null,
    };
  }

  async snoozeRuleEvents(ruleId: string, snoozeUntil: string): Promise<AlertEventRecord[]> {
    const now = new Date().toISOString();
    const rows = this.db
      .prepare(
        `${EVENT_SELECT}
          WHERE e.ruleId = ? AND e.state = 'open' AND e.deletedAt IS NULL`,
      )
      .all(ruleId) as EventRow[];
    this.db
      .prepare(
        `UPDATE alert_events
            SET state = 'snoozed', snoozeUntil = ?, updatedAt = ?
          WHERE ruleId = ? AND state = 'open' AND deletedAt IS NULL`,
      )
      .run(snoozeUntil, now, ruleId);
    return rows.map((row) => this.mapEvent({ ...row, state: "snoozed", snoozeUntil, updatedAt: now }));
  }

  async returnDueSnoozedEvents(now: string): Promise<AlertEventRecord[]> {
    const rows = this.db
      .prepare(
        `${EVENT_SELECT}
          WHERE e.state = 'snoozed' AND e.snoozeUntil IS NOT NULL
            AND e.snoozeUntil <= ? AND e.deletedAt IS NULL`,
      )
      .all(now) as EventRow[];
    this.db
      .prepare(
        `UPDATE alert_events
            SET state = 'open', snoozeUntil = NULL, updatedAt = ?
          WHERE state = 'snoozed' AND snoozeUntil IS NOT NULL
            AND snoozeUntil <= ? AND deletedAt IS NULL`,
      )
      .run(new Date().toISOString(), now);
    return rows.map((row) => this.mapEvent({ ...row, state: "open", snoozeUntil: null }));
  }

  // ── notification configs ──────────────────────────────────────────────────

  private mapNotification(row: NotificationRow): NotificationConfigRecord {
    return {
      id: row.id,
      channel: row.channel as NotificationChannel,
      target: row.target,
      enabled: row.enabled === 1,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
      deletedAt: row.deletedAt,
    };
  }

  async listChannels(): Promise<NotificationConfigRecord[]> {
    return (
      this.db
        .prepare("SELECT * FROM notification_configs WHERE deletedAt IS NULL ORDER BY channel, id")
        .all() as NotificationRow[]
    ).map((row) => this.mapNotification(row));
  }

  async getChannel(id: string): Promise<NotificationConfigRecord | undefined> {
    const row = this.db
      .prepare("SELECT * FROM notification_configs WHERE id = ? AND deletedAt IS NULL")
      .get(id) as NotificationRow | undefined;
    return row === undefined ? undefined : this.mapNotification(row);
  }

  /** Seeds one row per channel; existing rows and operator changes are kept. */
  async seedChannels(): Promise<number> {
    const now = new Date().toISOString();
    let inserted = 0;
    const statement = this.db.prepare(
      `INSERT OR IGNORE INTO notification_configs
         (id, channel, target, enabled, createdAt, updatedAt, deletedAt)
       VALUES (?, ?, '', 0, ?, ?, NULL)`,
    );
    this.db.transaction(() => {
      for (const channel of NOTIFICATION_CHANNELS) {
        inserted += statement.run(channel, channel, now, now).changes;
      }
    })();
    return inserted;
  }

  async updateChannel(
    id: string,
    patch: { readonly target?: string; readonly enabled?: boolean },
  ): Promise<NotificationConfigRecord | undefined> {
    const existing = await this.getChannel(id);
    if (existing === undefined) return undefined;
    this.db
      .prepare("UPDATE notification_configs SET target = ?, enabled = ?, updatedAt = ? WHERE id = ?")
      .run(
        patch.target ?? existing.target,
        (patch.enabled ?? existing.enabled) ? 1 : 0,
        new Date().toISOString(),
        id,
      );
    return this.getChannel(id);
  }

  // ── outbound webhook rules ────────────────────────────────────────────────

  private mapWebhookRule(row: WebhookRuleRow): WebhookRuleRecord {
    return {
      id: row.id,
      url: row.url,
      match: row.match,
      enabled: row.enabled === 1,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
      deletedAt: row.deletedAt,
    };
  }

  async listWebhookRules(): Promise<WebhookRuleRecord[]> {
    return (
      this.db
        .prepare("SELECT * FROM webhook_rules WHERE deletedAt IS NULL ORDER BY createdAt, id")
        .all() as WebhookRuleRow[]
    ).map((row) => this.mapWebhookRule(row));
  }

  async getWebhookRule(id: string): Promise<WebhookRuleRecord | undefined> {
    const row = this.db
      .prepare("SELECT * FROM webhook_rules WHERE id = ? AND deletedAt IS NULL")
      .get(id) as WebhookRuleRow | undefined;
    return row === undefined ? undefined : this.mapWebhookRule(row);
  }

  /** Inserts or updates a webhook rule. SPEC §6 defines no route; the delivery pipeline owns it. */
  async upsertWebhookRule(input: WebhookRuleUpsert): Promise<WebhookRuleRecord> {
    const now = new Date().toISOString();
    this.db
      .prepare(
        `INSERT INTO webhook_rules (id, url, match, enabled, createdAt, updatedAt, deletedAt)
         VALUES (?, ?, ?, ?, ?, ?, NULL)
         ON CONFLICT (id) DO UPDATE SET
           url = excluded.url,
           match = excluded.match,
           enabled = excluded.enabled,
           updatedAt = excluded.updatedAt`,
      )
      .run(input.id, input.url, input.match, (input.enabled ?? true) ? 1 : 0, now, now);
    return (await this.getWebhookRule(input.id))!;
  }

  async deleteWebhookRule(id: string): Promise<boolean> {
    const now = new Date().toISOString();
    const info = this.db
      .prepare("UPDATE webhook_rules SET deletedAt = ?, updatedAt = ? WHERE id = ? AND deletedAt IS NULL")
      .run(now, now, id);
    return info.changes > 0;
  }
}

export async function openSqliteAlertingRepository(
  options: OpenSqliteRepositoryOptions,
): Promise<SqliteAlertingRepository> {
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
    return new SqliteAlertingRepository(db, applied);
  } catch (error) {
    db.close();
    throw error;
  }
}
