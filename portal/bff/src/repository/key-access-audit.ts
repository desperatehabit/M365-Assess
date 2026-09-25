// Key retrieval audit (EPIC-018 SPEC §5, §4.2). The repository records who
// revealed which device key and when; key values are never written here, only
// the access record. It is append-only by shape — no update or delete path —
// and every read is scoped by tenantId, so a caller cannot widen a query.
// The storage engine is kept behind this interface (ADR-0015): callers pass an
// opened connection, never SQL.

type Row = Record<string, unknown>;

export type KeyAccessKeyType = "bitlocker" | "laps";

export interface KeyAccessAudit {
  readonly id: string;
  readonly tenantId: string;
  readonly deviceId: string;
  readonly keyType: KeyAccessKeyType;
  readonly actor: string;
  readonly at: string;
}

export type KeyAccessAuditInput = KeyAccessAudit;

export const KEY_ACCESS_KEY_TYPES: readonly KeyAccessKeyType[] = Object.freeze([
  "bitlocker",
  "laps",
]);

// Minimal structural view of a SQLite connection so this module names no engine
// package; the caller's better-sqlite3 Database satisfies it.
export interface KeyAccessAuditStatement {
  run(...params: unknown[]): { changes: number };
  all(...params: unknown[]): unknown[];
  get(...params: unknown[]): unknown;
}

export interface KeyAccessAuditDatabase {
  prepare(sql: string): KeyAccessAuditStatement;
  close?(): void;
}

export interface KeyAccessAuditRepository {
  readonly schemaVersion: number;

  close(): void;

  appendKeyAccessAudit(input: KeyAccessAuditInput): Promise<KeyAccessAudit>;
  listKeyAccessAudits(tenantId: string, deviceId: string): Promise<KeyAccessAudit[]>;
  getKeyAccessAudit(tenantId: string, auditId: string): Promise<KeyAccessAudit | undefined>;
}

function asString(value: unknown): string {
  return String(value);
}

export class SqliteKeyAccessAuditRepository implements KeyAccessAuditRepository {
  readonly schemaVersion: number;

  constructor(
    private readonly db: KeyAccessAuditDatabase,
    schemaVersion: number,
  ) {
    this.schemaVersion = schemaVersion;
  }

  close(): void {
    this.db.close?.();
  }

  private mapAudit(row: Row): KeyAccessAudit {
    return {
      id: asString(row["id"]),
      tenantId: asString(row["tenantId"]),
      deviceId: asString(row["deviceId"]),
      keyType: asString(row["keyType"]) as KeyAccessKeyType,
      actor: asString(row["actor"]),
      at: asString(row["at"]),
    };
  }

  private select(tenantId: string, auditId: string): KeyAccessAudit | undefined {
    const row = this.db
      .prepare("SELECT * FROM key_access_audit WHERE tenantId = ? AND id = ?")
      .get(tenantId, auditId) as Row | undefined;
    return row ? this.mapAudit(row) : undefined;
  }

  async appendKeyAccessAudit(input: KeyAccessAuditInput): Promise<KeyAccessAudit> {
    if (!KEY_ACCESS_KEY_TYPES.includes(input.keyType)) {
      throw new Error(`unsupported key type: ${input.keyType}`);
    }
    this.db
      .prepare(
        `INSERT INTO key_access_audit
           (id, tenantId, deviceId, keyType, actor, at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(input.id, input.tenantId, input.deviceId, input.keyType, input.actor, input.at);
    const saved = this.select(input.tenantId, input.id);
    if (!saved) throw new Error(`key access audit ${input.id} was not persisted`);
    return saved;
  }

  async listKeyAccessAudits(
    tenantId: string,
    deviceId: string,
  ): Promise<KeyAccessAudit[]> {
    return (
      this.db
        .prepare(
          `SELECT * FROM key_access_audit
           WHERE tenantId = ? AND deviceId = ?
           ORDER BY at DESC, rowid DESC`,
        )
        .all(tenantId, deviceId) as Row[]
    ).map((row) => this.mapAudit(row));
  }

  async getKeyAccessAudit(
    tenantId: string,
    auditId: string,
  ): Promise<KeyAccessAudit | undefined> {
    return this.select(tenantId, auditId);
  }
}
