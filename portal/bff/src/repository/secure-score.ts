// Secure Score snapshot + action-mapping storage (EPIC-031 SPEC §5, §4.2;
// 03-database.md §5/§6/§7).
//
// Snapshots are the trend source (SPEC §4.2): append-only rows keyed by tenant
// and observation time, pruned by the configured retention window
// (03-database.md §7). Mappings are the action→remediation link: global and
// registry-derived (SPEC §11.1), so they carry no tenantId; rows are upserted
// in place and never deleted. A mapping change writes an AuditEvent
// (03-database.md §6) through the append-only audit_events table created by the
// base migration. The BFF-facing mapping field is `check`, renamed from the
// contract's check reference exactly as the db package renames each remediation
// action's check reference for the routes (RemediationActionView).
// The storage engine is kept behind this interface (ADR-0015): callers pass an
// opened connection, never SQL.
import { randomUUID } from "node:crypto";
import { AppError, type ErrorDetail } from "../errors.js";

type Row = Record<string, unknown>;

export interface SecureScoreSnapshot {
  id: string;
  tenantId: string;
  at: string;
  current: number;
  max: number;
  percentage: number;
  categories: Record<string, unknown>;
}

// Storage metadata: snapshots are append-only trend points.
export interface SecureScoreSnapshotRecord extends SecureScoreSnapshot {
  createdAt: string;
}

export interface ScoreActionMapping {
  actionId: string;
  check: string;
  standardKey: string;
}

// Storage metadata: mappings are upserted in place, never deleted.
export interface ScoreActionMappingRecord extends ScoreActionMapping {
  createdAt: string;
  updatedAt: string;
}

export interface SecureScoreSnapshotInput {
  id?: string;
  tenantId: string;
  at?: string;
  current: number;
  max: number;
  percentage: number;
  categories?: Record<string, unknown> | string;
  createdAt?: string;
}

export interface SecureScoreSnapshotListOptions {
  /** Inclusive lower bound on the observation time `at`. */
  from?: string;
  /** Inclusive upper bound on the observation time `at`. */
  to?: string;
  limit?: number;
}

export interface SecureScoreSnapshotRetentionOptions {
  /** Maximum age of snapshots to retain in days. */
  retentionDays?: number;
  /** Explicit ISO timestamp or Date cutoff; snapshots observed before it are pruned. */
  olderThan?: string | Date;
}

export interface SecureScoreSnapshotPruneResult {
  prunedSnapshotsCount: number;
}

export const SECURE_SCORE_AUDIT_SOURCES = ["request", "schedule", "remediation"] as const;

export type SecureScoreAuditSource = (typeof SECURE_SCORE_AUDIT_SOURCES)[number];

export interface ScoreActionMappingInput {
  actionId: string;
  check: string;
  standardKey: string;
  /** Actor user id; an absent actor is audited as system. */
  by?: string;
  source?: SecureScoreAuditSource;
  createdAt?: string;
  updatedAt?: string;
}

export interface ScoreActionMappingListOptions {
  check?: string;
}

// Minimal structural view of a SQLite connection so this module names no engine
// package; the caller's better-sqlite3 Database satisfies it.
export interface SecureScoreStatement {
  run(...params: unknown[]): { changes: number };
  all(...params: unknown[]): unknown[];
  get(...params: unknown[]): unknown;
}

export interface SecureScoreDatabase {
  prepare(sql: string): SecureScoreStatement;
  close?(): void;
}

export interface SecureScoreRepository {
  readonly schemaVersion: number;

  close(): void;

  recordSnapshot(input: SecureScoreSnapshotInput): Promise<SecureScoreSnapshotRecord>;
  getSnapshot(tenantId: string, id: string): Promise<SecureScoreSnapshotRecord | undefined>;
  listSnapshots(
    tenantId: string,
    options?: SecureScoreSnapshotListOptions,
  ): Promise<SecureScoreSnapshotRecord[]>;
  pruneSnapshots(
    options: SecureScoreSnapshotRetentionOptions,
  ): Promise<SecureScoreSnapshotPruneResult>;

  putMapping(input: ScoreActionMappingInput): Promise<ScoreActionMappingRecord>;
  getMapping(actionId: string): Promise<ScoreActionMappingRecord | undefined>;
  listMappings(options?: ScoreActionMappingListOptions): Promise<ScoreActionMappingRecord[]>;
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

function parseJsonObject(value: unknown): Record<string, unknown> | null {
  if (value === null || value === undefined) return null;
  try {
    const parsed: unknown = JSON.parse(String(value));
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function stringifyJson(value: unknown): string | null {
  return value === null || value === undefined ? null : JSON.stringify(value);
}

function invalid(field: string, reason: string): AppError {
  const details: ErrorDetail[] = [{ field, reason }];
  return new AppError("secureScore.invalid", "invalid secure score record", 400, details);
}

function isAuditSource(value: unknown): value is SecureScoreAuditSource {
  return (
    typeof value === "string" &&
    (SECURE_SCORE_AUDIT_SOURCES as readonly string[]).includes(value)
  );
}

function requireNonEmpty(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw invalid(field, "must be a non-empty string");
  }
  return value.trim();
}

function requireFiniteNumber(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw invalid(field, "must be a finite number");
  }
  return value;
}

function requireJsonObject(value: unknown, field: string): Record<string, unknown> {
  let candidate = value;
  if (typeof value === "string") {
    try {
      candidate = JSON.parse(value);
    } catch {
      throw invalid(field, "must be well-formed JSON");
    }
  }
  if (typeof candidate !== "object" || candidate === null || Array.isArray(candidate)) {
    throw invalid(field, "must be a JSON object");
  }
  return candidate as Record<string, unknown>;
}

function requireInstant(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw invalid(field, "must be an ISO-8601 instant");
  }
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    throw invalid(field, "must be an ISO-8601 instant");
  }
  return parsed.toISOString();
}

function retentionCutoff(options: SecureScoreSnapshotRetentionOptions): string {
  if (options.olderThan !== undefined) {
    return options.olderThan instanceof Date
      ? options.olderThan.toISOString()
      : String(options.olderThan);
  }
  if (typeof options.retentionDays === "number") {
    return new Date(Date.now() - options.retentionDays * 86400 * 1000).toISOString();
  }
  throw new Error("pruneSnapshots requires olderThan or retentionDays option");
}

export class SqliteSecureScoreRepository implements SecureScoreRepository {
  readonly schemaVersion: number;

  constructor(
    private readonly db: SecureScoreDatabase,
    schemaVersion: number,
  ) {
    this.schemaVersion = schemaVersion;
  }

  close(): void {
    this.db.close?.();
  }

  private mapSnapshot(row: Row): SecureScoreSnapshotRecord {
    return {
      id: asString(row["id"]),
      tenantId: asString(row["tenantId"]),
      at: asString(row["at"]),
      current: asNumber(row["current"]),
      max: asNumber(row["max"]),
      percentage: asNumber(row["percentage"]),
      categories: parseJsonObject(row["categories"]) ?? {},
      createdAt: asString(row["createdAt"]),
    };
  }

  private mapMapping(row: Row): ScoreActionMappingRecord {
    return {
      actionId: asString(row["actionId"]),
      check: asString(row["check"]),
      standardKey: asString(row["standardKey"]),
      createdAt: asString(row["createdAt"]),
      updatedAt: asString(row["updatedAt"]),
    };
  }

  private selectSnapshot(tenantId: string, id: string): SecureScoreSnapshotRecord | undefined {
    const row = this.db
      .prepare("SELECT * FROM secure_score_snapshots WHERE tenantId = ? AND id = ?")
      .get(tenantId, id) as Row | undefined;
    return row ? this.mapSnapshot(row) : undefined;
  }

  private selectMapping(actionId: string): ScoreActionMappingRecord | undefined {
    const row = this.db
      .prepare("SELECT * FROM score_action_mappings WHERE actionId = ?")
      .get(actionId) as Row | undefined;
    return row ? this.mapMapping(row) : undefined;
  }

  async recordSnapshot(input: SecureScoreSnapshotInput): Promise<SecureScoreSnapshotRecord> {
    const id = input.id ?? randomUUID();
    const tenantId = requireNonEmpty(input.tenantId, "tenantId");
    const at = requireInstant(input.at ?? nowIso(), "at");
    const current = requireFiniteNumber(input.current, "current");
    const max = requireFiniteNumber(input.max, "max");
    const percentage = requireFiniteNumber(input.percentage, "percentage");
    const categories =
      input.categories === undefined ? {} : requireJsonObject(input.categories, "categories");
    const createdAt = input.createdAt ?? nowIso();
    this.db
      .prepare(
        `INSERT INTO secure_score_snapshots
           (id, tenantId, at, current, max, percentage, categories, createdAt)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(id, tenantId, at, current, max, percentage, stringifyJson(categories), createdAt);
    const saved = this.selectSnapshot(tenantId, id);
    if (!saved) throw new Error(`secure score snapshot ${id} was not persisted`);
    return saved;
  }

  async getSnapshot(
    tenantId: string,
    id: string,
  ): Promise<SecureScoreSnapshotRecord | undefined> {
    return this.selectSnapshot(
      requireNonEmpty(tenantId, "tenantId"),
      requireNonEmpty(id, "id"),
    );
  }

  async listSnapshots(
    tenantId: string,
    options: SecureScoreSnapshotListOptions = {},
  ): Promise<SecureScoreSnapshotRecord[]> {
    const where: string[] = ["tenantId = ?"];
    const params: unknown[] = [requireNonEmpty(tenantId, "tenantId")];
    if (options.from !== undefined) {
      where.push("at >= ?");
      params.push(requireInstant(options.from, "from"));
    }
    if (options.to !== undefined) {
      where.push("at <= ?");
      params.push(requireInstant(options.to, "to"));
    }
    let sql = `SELECT * FROM secure_score_snapshots WHERE ${where.join(" AND ")} ORDER BY at, id`;
    if (options.limit !== undefined) {
      if (!Number.isInteger(options.limit) || options.limit < 1) {
        throw invalid("limit", "must be a positive integer");
      }
      sql += " LIMIT ?";
      params.push(options.limit);
    }
    return (this.db.prepare(sql).all(...params) as Row[]).map((row) => this.mapSnapshot(row));
  }

  async pruneSnapshots(
    options: SecureScoreSnapshotRetentionOptions,
  ): Promise<SecureScoreSnapshotPruneResult> {
    const cutoffIso = retentionCutoff(options);
    const result = this.db
      .prepare("DELETE FROM secure_score_snapshots WHERE at < ?")
      .run(cutoffIso);
    return { prunedSnapshotsCount: result.changes };
  }

  async putMapping(input: ScoreActionMappingInput): Promise<ScoreActionMappingRecord> {
    const actionId = requireNonEmpty(input.actionId, "actionId");
    const check = requireNonEmpty(input.check, "check");
    const standardKey = requireNonEmpty(input.standardKey, "standardKey");
    const existing = this.selectMapping(actionId);
    if (existing && existing.check === check && existing.standardKey === standardKey) {
      return existing;
    }
    const createdAt = input.createdAt ?? existing?.createdAt ?? nowIso();
    const updatedAt = input.updatedAt ?? nowIso();
    this.db
      .prepare(
        `INSERT INTO score_action_mappings (actionId, "check", standardKey, createdAt, updatedAt)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(actionId) DO UPDATE SET
           "check" = excluded."check",
           standardKey = excluded.standardKey,
           updatedAt = excluded.updatedAt`,
      )
      .run(actionId, check, standardKey, createdAt, updatedAt);
    this.appendMappingAudit(
      existing === undefined
        ? null
        : { actionId: existing.actionId, check: existing.check, standardKey: existing.standardKey },
      { actionId, check, standardKey },
      input,
    );
    const saved = this.selectMapping(actionId);
    if (!saved) throw new Error(`score action mapping ${actionId} was not persisted`);
    return saved;
  }

  async getMapping(actionId: string): Promise<ScoreActionMappingRecord | undefined> {
    return this.selectMapping(requireNonEmpty(actionId, "actionId"));
  }

  async listMappings(
    options: ScoreActionMappingListOptions = {},
  ): Promise<ScoreActionMappingRecord[]> {
    const where: string[] = [];
    const params: unknown[] = [];
    if (options.check !== undefined) {
      where.push('"check" = ?');
      params.push(requireNonEmpty(options.check, "check"));
    }
    const sql =
      "SELECT * FROM score_action_mappings" +
      (where.length > 0 ? ` WHERE ${where.join(" AND ")}` : "") +
      " ORDER BY actionId";
    return (this.db.prepare(sql).all(...params) as Row[]).map((row) => this.mapMapping(row));
  }

  private appendMappingAudit(
    before: ScoreActionMapping | null,
    after: ScoreActionMapping,
    input: ScoreActionMappingInput,
  ): void {
    const source = input.source === undefined ? "request" : input.source;
    if (!isAuditSource(source)) {
      throw invalid("source", `must be one of ${SECURE_SCORE_AUDIT_SOURCES.join(", ")}`);
    }
    const at = nowIso();
    this.db
      .prepare(
        `INSERT INTO audit_events
           (id, timestamp, actorUserId, actorType, tenantId, action, targetType, targetId,
            before, after, result, error, source, correlationId, createdAt)
         VALUES (?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, 'success', NULL, ?, NULL, ?)`,
      )
      .run(
        randomUUID(),
        at,
        asNullableString(input.by),
        input.by === undefined ? "system" : "user",
        "secureScore.mapping.change",
        "scoreActionMapping",
        after.actionId,
        stringifyJson(before),
        stringifyJson(after),
        source,
        at,
      );
  }
}
