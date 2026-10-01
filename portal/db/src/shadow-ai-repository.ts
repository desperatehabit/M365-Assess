// Shadow AI discovery findings store (EPIC-041 SPEC.md §5, §9; T-0807).
//
// Persists ShadowAiFinding (id, tenantId, tool, user, detectedAt, state) for
// unsanctioned AI-tool usage. Findings are written by the shadow-ai discovery
// service and triaged portal-side; the store is deliberately report-only — it
// has no block / CA write path (SPEC §9). Every read and state change is
// tenant-scoped (T-0743) at the storage boundary so one tenant's findings can
// never be listed or mutated through another tenant's id. Self-contained: the
// types live here so no shared repository file is touched.
import Database from "better-sqlite3";
import { SchemaVersionError } from "./repository.js";
import {
  SCHEMA_VERSIONS_TABLE,
  loadMigrations,
  runMigrations,
  type OpenSqliteRepositoryOptions,
} from "./sqlite-repository.js";

type Row = Record<string, unknown>;

export type ShadowAiFindingState = "open" | "acknowledged" | "dismissed";

export interface ShadowAiFinding {
  readonly id: string;
  readonly tenantId: string;
  readonly tool: string;
  readonly user: string;
  readonly detectedAt: string;
  readonly state: ShadowAiFindingState;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface ShadowAiFindingInput {
  readonly id: string;
  readonly tenantId: string;
  readonly tool: string;
  readonly user: string;
  readonly detectedAt: string;
  readonly state?: ShadowAiFindingState;
  readonly createdAt?: string;
  readonly updatedAt?: string;
}

function nowIso(): string {
  return new Date().toISOString();
}

function asString(value: unknown): string {
  return String(value);
}

function asNumber(value: unknown): number {
  return typeof value === "number" ? value : Number(value);
}

export interface ShadowAiFindingRepository {
  readonly schemaVersion: number;

  close(): void;

  saveFindings(findings: readonly ShadowAiFindingInput[]): Promise<ShadowAiFinding[]>;
  listFindings(tenantId: string): Promise<ShadowAiFinding[]>;
  getFinding(tenantId: string, findingId: string): Promise<ShadowAiFinding | undefined>;
  updateFindingState(
    tenantId: string,
    findingId: string,
    state: ShadowAiFindingState,
  ): Promise<ShadowAiFinding | undefined>;
}

export class SqliteShadowAiFindingRepository implements ShadowAiFindingRepository {
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

  private mapFinding(row: Row): ShadowAiFinding {
    return {
      id: asString(row["id"]),
      tenantId: asString(row["tenantId"]),
      tool: asString(row["tool"]),
      user: asString(row["user"]),
      detectedAt: asString(row["detectedAt"]),
      state: asString(row["state"]) as ShadowAiFindingState,
      createdAt: asString(row["createdAt"]),
      updatedAt: asString(row["updatedAt"]),
    };
  }

  async saveFindings(findings: readonly ShadowAiFindingInput[]): Promise<ShadowAiFinding[]> {
    const instant = nowIso();
    const upsert = this.db.prepare(
      `INSERT INTO shadow_ai_findings (id, tenantId, tool, "user", detectedAt, state, createdAt, updatedAt)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (id) DO UPDATE SET
         updatedAt = excluded.updatedAt`,
    );
    this.db.transaction(() => {
      for (const finding of findings) {
        upsert.run(
          finding.id,
          finding.tenantId,
          finding.tool,
          finding.user,
          finding.detectedAt,
          finding.state ?? "open",
          finding.createdAt ?? instant,
          finding.updatedAt ?? instant,
        );
      }
    })();
    return Promise.all(
      findings.map(async (finding) => {
        const stored = await this.getFinding(finding.tenantId, finding.id);
        if (!stored) throw new Error(`shadow ai finding ${finding.id} was not persisted`);
        return stored;
      }),
    );
  }

  async listFindings(tenantId: string): Promise<ShadowAiFinding[]> {
    return (
      this.db
        .prepare(
          "SELECT * FROM shadow_ai_findings WHERE tenantId = ? ORDER BY detectedAt DESC, id",
        )
        .all(tenantId) as Row[]
    ).map((row) => this.mapFinding(row));
  }

  async getFinding(tenantId: string, findingId: string): Promise<ShadowAiFinding | undefined> {
    const row = this.db
      .prepare("SELECT * FROM shadow_ai_findings WHERE id = ? AND tenantId = ?")
      .get(findingId, tenantId) as Row | undefined;
    return row ? this.mapFinding(row) : undefined;
  }

  async updateFindingState(
    tenantId: string,
    findingId: string,
    state: ShadowAiFindingState,
  ): Promise<ShadowAiFinding | undefined> {
    const result = this.db
      .prepare(
        "UPDATE shadow_ai_findings SET state = ?, updatedAt = ? WHERE id = ? AND tenantId = ?",
      )
      .run(state, nowIso(), findingId, tenantId);
    if (result.changes === 0) return undefined;
    return this.getFinding(tenantId, findingId);
  }
}

export async function openSqliteShadowAiFindingRepository(
  options: OpenSqliteRepositoryOptions,
): Promise<SqliteShadowAiFindingRepository> {
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
    return new SqliteShadowAiFindingRepository(db, applied);
  } catch (error) {
    db.close();
    throw error;
  }
}
