// Device-action history (EPIC-018 SPEC §5, §3.3, §6). The repository is
// append-only by shape — it exposes no update or delete path — and every read
// is scoped by both tenantId and deviceId, so a caller cannot widen a query.
// The storage engine is kept behind this interface (ADR-0015): callers pass an
// opened connection, never SQL.

type Row = Record<string, unknown>;

export type DeviceActionKind = "sync" | "retire" | "wipe" | "fresh-start";
export type DeviceActionState = "applied" | "pending-approval" | "failed";

export interface DeviceAction {
  readonly id: string;
  readonly tenantId: string;
  readonly deviceId: string;
  readonly action: DeviceActionKind;
  readonly reason: string | null;
  readonly state: DeviceActionState;
  readonly appliedAt: string;
  readonly appliedBy: string;
  readonly result: string;
}

export type DeviceActionInput = DeviceAction;

export const DEVICE_ACTION_KINDS: readonly DeviceActionKind[] = Object.freeze([
  "sync",
  "retire",
  "wipe",
  "fresh-start",
]);

// Minimal structural view of a SQLite connection so this module names no engine
// package; the caller's better-sqlite3 Database satisfies it.
export interface DeviceActionStatement {
  run(...params: unknown[]): { changes: number };
  all(...params: unknown[]): unknown[];
  get(...params: unknown[]): unknown;
}

export interface DeviceActionDatabase {
  prepare(sql: string): DeviceActionStatement;
  close?(): void;
}

export interface DeviceActionRepository {
  readonly schemaVersion: number;

  close(): void;

  appendDeviceAction(input: DeviceActionInput): Promise<DeviceAction>;
  listDeviceActions(tenantId: string, deviceId: string): Promise<DeviceAction[]>;
  getDeviceAction(tenantId: string, deviceActionId: string): Promise<DeviceAction | undefined>;
}

function asString(value: unknown): string {
  return String(value);
}

function asNullableString(value: unknown): string | null {
  return value === null || value === undefined ? null : String(value);
}

export class SqliteDeviceActionRepository implements DeviceActionRepository {
  readonly schemaVersion: number;

  constructor(
    private readonly db: DeviceActionDatabase,
    schemaVersion: number,
  ) {
    this.schemaVersion = schemaVersion;
  }

  close(): void {
    this.db.close?.();
  }

  private mapAction(row: Row): DeviceAction {
    return {
      id: asString(row["id"]),
      tenantId: asString(row["tenantId"]),
      deviceId: asString(row["deviceId"]),
      action: asString(row["action"]) as DeviceActionKind,
      reason: asNullableString(row["reason"]),
      state: asString(row["state"]) as DeviceActionState,
      appliedAt: asString(row["appliedAt"]),
      appliedBy: asString(row["appliedBy"]),
      result: asString(row["result"]),
    };
  }

  private select(tenantId: string, deviceActionId: string): DeviceAction | undefined {
    const row = this.db
      .prepare("SELECT * FROM device_actions WHERE tenantId = ? AND id = ?")
      .get(tenantId, deviceActionId) as Row | undefined;
    return row ? this.mapAction(row) : undefined;
  }

  async appendDeviceAction(input: DeviceActionInput): Promise<DeviceAction> {
    if (!DEVICE_ACTION_KINDS.includes(input.action)) {
      throw new Error(`unsupported device action: ${input.action}`);
    }
    this.db
      .prepare(
        `INSERT INTO device_actions
           (id, tenantId, deviceId, action, reason, state, appliedAt, appliedBy, result)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.id,
        input.tenantId,
        input.deviceId,
        input.action,
        input.reason,
        input.state,
        input.appliedAt,
        input.appliedBy,
        input.result,
      );
    const saved = this.select(input.tenantId, input.id);
    if (!saved) throw new Error(`device action ${input.id} was not persisted`);
    return saved;
  }

  async listDeviceActions(tenantId: string, deviceId: string): Promise<DeviceAction[]> {
    return (
      this.db
        .prepare(
          `SELECT * FROM device_actions
           WHERE tenantId = ? AND deviceId = ?
           ORDER BY appliedAt DESC, rowid DESC`,
        )
        .all(tenantId, deviceId) as Row[]
    ).map((row) => this.mapAction(row));
  }

  async getDeviceAction(
    tenantId: string,
    deviceActionId: string,
  ): Promise<DeviceAction | undefined> {
    return this.select(tenantId, deviceActionId);
  }
}
