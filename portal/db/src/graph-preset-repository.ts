// Graph Explorer saved preset store (EPIC-040 SPEC.md §3.1, §5, §6; T-0783).
//
// Persists GraphPreset (id, name, method, url, body, createdBy). Reads are scoped
// by createdBy so a caller only ever loads its own presets; the service is the
// layer that decides when an admin may reach another user's row. Delete is a hard
// delete (the SPEC §5 entity has no deletedAt). A row carries no tenant credential
// and no secret: only the request fields and the owner are stored.
import Database from "better-sqlite3";
import {
  SchemaVersionError,
  type GraphPreset,
  type GraphPresetInput,
  type GraphPresetListOptions,
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

function asNumber(value: unknown): number {
  return typeof value === "number" ? value : Number(value);
}

// The body is an arbitrary JSON document (or absent); unlike the object-only
// parsers elsewhere this accepts any JSON value the service allowed through.
function parseJsonValue(value: unknown): unknown {
  if (value === null || value === undefined) return null;
  try {
    return JSON.parse(String(value)) as unknown;
  } catch {
    return null;
  }
}

function stringifyBody(value: unknown): string | null {
  return value === undefined || value === null ? null : JSON.stringify(value);
}

export interface GraphPresetRepository {
  readonly schemaVersion: number;

  close(): void;

  createGraphPreset(input: GraphPresetInput): Promise<GraphPreset>;
  getGraphPreset(presetId: string): Promise<GraphPreset | undefined>;
  listGraphPresets(options?: GraphPresetListOptions): Promise<GraphPreset[]>;
  deleteGraphPreset(presetId: string): Promise<boolean>;
}

export class SqliteGraphPresetRepository implements GraphPresetRepository {
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

  private mapPreset(row: Row): GraphPreset {
    return {
      id: asString(row["id"]),
      name: asString(row["name"]),
      method: asString(row["method"]),
      url: asString(row["url"]),
      body: parseJsonValue(row["body"]),
      createdBy: asString(row["createdBy"]),
      createdAt: asString(row["createdAt"]),
      updatedAt: asString(row["updatedAt"]),
    };
  }

  async createGraphPreset(input: GraphPresetInput): Promise<GraphPreset> {
    const instant = nowIso();
    this.db
      .prepare(
        `INSERT INTO graph_presets (id, name, method, url, body, createdBy, createdAt, updatedAt)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.id,
        input.name,
        input.method,
        input.url,
        stringifyBody(input.body),
        input.createdBy,
        input.createdAt ?? instant,
        input.updatedAt ?? instant,
      );
    const created = await this.getGraphPreset(input.id);
    if (!created) throw new Error(`graph preset ${input.id} was not persisted`);
    return created;
  }

  async getGraphPreset(presetId: string): Promise<GraphPreset | undefined> {
    const row = this.db
      .prepare("SELECT * FROM graph_presets WHERE id = ?")
      .get(presetId) as Row | undefined;
    return row ? this.mapPreset(row) : undefined;
  }

  async listGraphPresets(options: GraphPresetListOptions = {}): Promise<GraphPreset[]> {
    const rows = (
      options.createdBy === undefined
        ? this.db.prepare("SELECT * FROM graph_presets ORDER BY createdAt, id").all()
        : this.db
            .prepare("SELECT * FROM graph_presets WHERE createdBy = ? ORDER BY createdAt, id")
            .all(options.createdBy)
    ) as Row[];
    return rows.map((row) => this.mapPreset(row));
  }

  async deleteGraphPreset(presetId: string): Promise<boolean> {
    const result = this.db.prepare("DELETE FROM graph_presets WHERE id = ?").run(presetId);
    return result.changes > 0;
  }
}

export async function openSqliteGraphPresetRepository(
  options: OpenSqliteRepositoryOptions,
): Promise<SqliteGraphPresetRepository> {
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
    return new SqliteGraphPresetRepository(db, applied);
  } catch (error) {
    db.close();
    throw error;
  }
}
