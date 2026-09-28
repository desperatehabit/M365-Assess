// Per-tenant device action policies (EPIC-018 SPEC §11.1, §11.2; T-0345).
// Stores the optional two-person rule for wipe and the key-reveal auto-hide
// window. The storage engine is kept behind this interface (ADR-0015).

type Row = Record<string, unknown>;

export interface DeviceActionPolicy {
  readonly tenantId: string;
  readonly twoPersonRule: boolean;
  readonly revealWindowSec: number;
  readonly updatedAt: string;
}

export interface DeviceActionPolicyStatement {
  run(...params: unknown[]): { changes: number };
  all(...params: unknown[]): unknown[];
  get(...params: unknown[]): unknown;
}

export interface DeviceActionPolicyDatabase {
  prepare(sql: string): DeviceActionPolicyStatement;
  close?(): void;
}

export interface DeviceActionPolicyRepository {
  readonly schemaVersion: number;

  close(): void;

  getPolicy(tenantId: string): Promise<DeviceActionPolicy>;
  setTwoPersonRule(tenantId: string, enabled: boolean, updatedAt: string): Promise<DeviceActionPolicy>;
  setRevealWindow(tenantId: string, seconds: number, updatedAt: string): Promise<DeviceActionPolicy>;
}

function asString(value: unknown): string {
  return String(value);
}

function asBoolean(value: unknown): boolean {
  return value === 1 || value === true || value === "1" || value === "true";
}

function asNumber(value: unknown): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

export class SqliteDeviceActionPolicyRepository implements DeviceActionPolicyRepository {
  readonly schemaVersion: number;

  constructor(
    private readonly db: DeviceActionPolicyDatabase,
    schemaVersion: number,
  ) {
    this.schemaVersion = schemaVersion;
  }

  close(): void {
    this.db.close?.();
  }

  private mapPolicy(row: Row): DeviceActionPolicy {
    return {
      tenantId: asString(row["tenantId"]),
      twoPersonRule: asBoolean(row["twoPersonRule"]),
      revealWindowSec: asNumber(row["revealWindowSec"]),
      updatedAt: asString(row["updatedAt"]),
    };
  }

  private defaultPolicy(tenantId: string, updatedAt: string): DeviceActionPolicy {
    return { tenantId, twoPersonRule: false, revealWindowSec: 30, updatedAt };
  }

  async getPolicy(tenantId: string): Promise<DeviceActionPolicy> {
    const row = this.db
      .prepare("SELECT * FROM device_action_policies WHERE tenantId = ?")
      .get(tenantId) as Row | undefined;
    if (!row) return this.defaultPolicy(tenantId, new Date().toISOString());
    return this.mapPolicy(row);
  }

  async setTwoPersonRule(tenantId: string, enabled: boolean, updatedAt: string): Promise<DeviceActionPolicy> {
    this.db
      .prepare(
        `INSERT INTO device_action_policies (tenantId, twoPersonRule, revealWindowSec, updatedAt)
         VALUES (?, ?, 30, ?)
         ON CONFLICT(tenantId) DO UPDATE SET twoPersonRule = excluded.twoPersonRule, updatedAt = excluded.updatedAt`,
      )
      .run(tenantId, enabled ? 1 : 0, updatedAt);
    const saved = await this.getPolicy(tenantId);
    return { ...saved, twoPersonRule: enabled, updatedAt };
  }

  async setRevealWindow(tenantId: string, seconds: number, updatedAt: string): Promise<DeviceActionPolicy> {
    const clamped = Math.max(15, Math.min(120, Math.round(seconds)));
    this.db
      .prepare(
        `INSERT INTO device_action_policies (tenantId, twoPersonRule, revealWindowSec, updatedAt)
         VALUES (?, 0, ?, ?)
         ON CONFLICT(tenantId) DO UPDATE SET revealWindowSec = excluded.revealWindowSec, updatedAt = excluded.updatedAt`,
      )
      .run(tenantId, clamped, updatedAt);
    const saved = await this.getPolicy(tenantId);
    return { ...saved, revealWindowSec: clamped, updatedAt };
  }
}
