// Template library entities (EPIC-039 §5) on top of the shared repository
// contract. Items, repos, and packages are global index tables
// (04-data-modeling §2), so there is no tenantId to scope; browsing is
// read-only and mutations are audited by the service layer.
import Database from "better-sqlite3";
import {
  SchemaVersionError,
  type TemplateItemSource,
  type TemplateLibraryItem,
  type TemplateLibraryItemInput,
  type TemplateLibraryItemListOptions,
  type TemplatePackage,
  type TemplatePackageInput,
  type TemplateRepo,
  type TemplateRepoInput,
  type TemplateRepoListOptions,
  type TemplateRepoReviewState,
} from "./repository.js";
import {
  SCHEMA_VERSIONS_TABLE,
  loadMigrations,
  runMigrations,
  type OpenSqliteRepositoryOptions,
} from "./sqlite-repository.js";

type Row = Record<string, unknown>;

/** The §9 template-type registry; each type is owned by its epic. */
export const TEMPLATE_TYPES = [
  "conditional-access",
  "intune-configuration",
  "intune-compliance",
  "intune-protection",
  "intune-policy",
  "standards",
  "baseline",
  "group",
  "policy",
  "pim-role-settings",
  "report-builder",
  "custom-test",
] as const;

export type TemplateType = (typeof TEMPLATE_TYPES)[number];

const TEMPLATE_SOURCES: readonly TemplateItemSource[] = ["local", "community"];

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

function asBool(value: unknown): boolean {
  return asNumber(value) === 1;
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

function stringifyArray(value: readonly string[] | undefined): string {
  return JSON.stringify(value ?? []);
}

/** Raised when a template type is not in the §9 registry. */
export class InvalidTemplateTypeError extends Error {
  readonly code = "template.invalid_type";

  constructor(type: string) {
    super(`template type ${type} is not registered`);
    this.name = "InvalidTemplateTypeError";
  }
}

/** Raised when a source is neither local nor community (SPEC §5). */
export class InvalidTemplateSourceError extends Error {
  readonly code = "template.invalid_source";

  constructor(source: string) {
    super(`template source ${source} must be local or community`);
    this.name = "InvalidTemplateSourceError";
  }
}

function assertTemplateType(type: string): void {
  if (!(TEMPLATE_TYPES as readonly string[]).includes(type)) {
    throw new InvalidTemplateTypeError(type);
  }
}

function assertTemplateSource(source: string): void {
  if (!TEMPLATE_SOURCES.includes(source as TemplateItemSource)) {
    throw new InvalidTemplateSourceError(source);
  }
}

export interface TemplateRepository {
  readonly schemaVersion: number;

  close(): void;

  getTemplateRepo(repoId: string, options?: { includeDeleted?: boolean }): Promise<
    TemplateRepo | undefined
  >;
  listTemplateRepos(options?: TemplateRepoListOptions): Promise<TemplateRepo[]>;
  upsertTemplateRepo(input: TemplateRepoInput): Promise<TemplateRepo>;
  softDeleteTemplateRepo(repoId: string, options?: { now?: string }): Promise<boolean>;

  getTemplateLibraryItem(
    itemId: string,
    options?: { includeDeleted?: boolean },
  ): Promise<TemplateLibraryItem | undefined>;
  listTemplateLibraryItems(
    options?: TemplateLibraryItemListOptions,
  ): Promise<TemplateLibraryItem[]>;
  upsertTemplateLibraryItem(input: TemplateLibraryItemInput): Promise<TemplateLibraryItem>;
  softDeleteTemplateLibraryItem(itemId: string, options?: { now?: string }): Promise<boolean>;

  getTemplatePackage(
    packageId: string,
    options?: { includeDeleted?: boolean },
  ): Promise<TemplatePackage | undefined>;
  listTemplatePackages(options?: { includeDeleted?: boolean }): Promise<TemplatePackage[]>;
  upsertTemplatePackage(input: TemplatePackageInput): Promise<TemplatePackage>;
  softDeleteTemplatePackage(packageId: string, options?: { now?: string }): Promise<boolean>;
}

export class SqliteTemplateRepository implements TemplateRepository {
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

  private mapRepo(row: Row): TemplateRepo {
    return {
      id: asString(row["id"]),
      url: asString(row["url"]),
      name: asString(row["name"]),
      types: parseJsonArray(row["types"]),
      writeAccess: asBool(row["writeAccess"]),
      builtin: asBool(row["builtin"]),
      signed: asBool(row["signed"]),
      reviewState: asString(row["reviewState"]) as TemplateRepoReviewState,
      trusted: asBool(row["trusted"]),
      createdAt: asString(row["createdAt"]),
      updatedAt: asString(row["updatedAt"]),
      deletedAt: asNullableString(row["deletedAt"]),
    };
  }

  private mapItem(row: Row): TemplateLibraryItem {
    return {
      id: asString(row["id"]),
      type: asString(row["type"]),
      name: asString(row["name"]),
      body: asString(row["body"]),
      source: asString(row["source"]) as TemplateItemSource,
      repoId: asNullableString(row["repoId"]),
      createdAt: asString(row["createdAt"]),
      updatedAt: asString(row["updatedAt"]),
      deletedAt: asNullableString(row["deletedAt"]),
    };
  }

  private mapPackage(row: Row): TemplatePackage {
    return {
      id: asString(row["id"]),
      name: asString(row["name"]),
      version: asString(row["version"]),
      contents: parseJsonArray(row["contents"]),
      source: asString(row["source"]) as TemplateItemSource,
      createdAt: asString(row["createdAt"]),
      updatedAt: asString(row["updatedAt"]),
      deletedAt: asNullableString(row["deletedAt"]),
    };
  }

  async getTemplateRepo(
    repoId: string,
    options: { includeDeleted?: boolean } = {},
  ): Promise<TemplateRepo | undefined> {
    const sql = options.includeDeleted
      ? "SELECT * FROM template_repos WHERE id = ?"
      : "SELECT * FROM template_repos WHERE id = ? AND deletedAt IS NULL";
    const row = this.db.prepare(sql).get(repoId) as Row | undefined;
    return row ? this.mapRepo(row) : undefined;
  }

  async listTemplateRepos(options: TemplateRepoListOptions = {}): Promise<TemplateRepo[]> {
    const where: string[] = [];
    const params: unknown[] = [];
    if (!options.includeDeleted) where.push("deletedAt IS NULL");
    if (options.builtin !== undefined) {
      where.push("builtin = ?");
      params.push(options.builtin ? 1 : 0);
    }
    if (options.trusted !== undefined) {
      where.push("trusted = ?");
      params.push(options.trusted ? 1 : 0);
    }
    const sql =
      "SELECT * FROM template_repos" +
      (where.length > 0 ? ` WHERE ${where.join(" AND ")}` : "") +
      " ORDER BY name";
    return (this.db.prepare(sql).all(...params) as Row[]).map((row) => this.mapRepo(row));
  }

  async upsertTemplateRepo(input: TemplateRepoInput): Promise<TemplateRepo> {
    const createdAt = input.createdAt ?? nowIso();
    const updatedAt = input.updatedAt ?? nowIso();
    this.db
      .prepare(
        `INSERT INTO template_repos
           (id, url, name, types, writeAccess, builtin, signed, reviewState, trusted, createdAt, updatedAt, deletedAt)
         VALUES
           (@id, @url, @name, @types, @writeAccess, @builtin, @signed, @reviewState, @trusted, @createdAt, @updatedAt, @deletedAt)
         ON CONFLICT(id) DO UPDATE SET
           url = excluded.url,
           name = excluded.name,
           types = excluded.types,
           writeAccess = excluded.writeAccess,
           builtin = excluded.builtin,
           signed = excluded.signed,
           reviewState = excluded.reviewState,
           trusted = excluded.trusted,
           updatedAt = excluded.updatedAt,
           deletedAt = excluded.deletedAt`,
      )
      .run({
        id: input.id,
        url: input.url,
        name: input.name,
        types: stringifyArray(input.types),
        writeAccess: input.writeAccess ? 1 : 0,
        builtin: input.builtin ? 1 : 0,
        signed: input.signed ? 1 : 0,
        reviewState: input.reviewState,
        trusted: input.trusted ? 1 : 0,
        createdAt,
        updatedAt,
        deletedAt: input.deletedAt ?? null,
      });
    const repo = await this.getTemplateRepo(input.id, { includeDeleted: true });
    if (!repo) throw new Error(`template repo ${input.id} was not persisted`);
    return repo;
  }

  async softDeleteTemplateRepo(
    repoId: string,
    options: { now?: string } = {},
  ): Promise<boolean> {
    const at = options.now ?? nowIso();
    const result = this.db
      .prepare(
        "UPDATE template_repos SET deletedAt = ?, updatedAt = ? WHERE id = ? AND deletedAt IS NULL",
      )
      .run(at, at, repoId);
    return result.changes > 0;
  }

  async getTemplateLibraryItem(
    itemId: string,
    options: { includeDeleted?: boolean } = {},
  ): Promise<TemplateLibraryItem | undefined> {
    const sql = options.includeDeleted
      ? "SELECT * FROM template_library_items WHERE id = ?"
      : "SELECT * FROM template_library_items WHERE id = ? AND deletedAt IS NULL";
    const row = this.db.prepare(sql).get(itemId) as Row | undefined;
    return row ? this.mapItem(row) : undefined;
  }

  async listTemplateLibraryItems(
    options: TemplateLibraryItemListOptions = {},
  ): Promise<TemplateLibraryItem[]> {
    const where: string[] = [];
    const params: unknown[] = [];
    if (!options.includeDeleted) where.push("deletedAt IS NULL");
    if (options.type !== undefined) {
      where.push("type = ?");
      params.push(options.type);
    }
    if (options.source !== undefined) {
      where.push("source = ?");
      params.push(options.source);
    }
    if (options.repoId !== undefined) {
      where.push("repoId = ?");
      params.push(options.repoId);
    }
    const sql =
      "SELECT * FROM template_library_items" +
      (where.length > 0 ? ` WHERE ${where.join(" AND ")}` : "") +
      " ORDER BY name";
    return (this.db.prepare(sql).all(...params) as Row[]).map((row) => this.mapItem(row));
  }

  async upsertTemplateLibraryItem(
    input: TemplateLibraryItemInput,
  ): Promise<TemplateLibraryItem> {
    assertTemplateType(input.type);
    assertTemplateSource(input.source);
    const createdAt = input.createdAt ?? nowIso();
    const updatedAt = input.updatedAt ?? nowIso();
    this.db
      .prepare(
        `INSERT INTO template_library_items
           (id, type, name, body, source, repoId, createdAt, updatedAt, deletedAt)
         VALUES
           (@id, @type, @name, @body, @source, @repoId, @createdAt, @updatedAt, @deletedAt)
         ON CONFLICT(id) DO UPDATE SET
           type = excluded.type,
           name = excluded.name,
           body = excluded.body,
           source = excluded.source,
           repoId = excluded.repoId,
           updatedAt = excluded.updatedAt,
           deletedAt = excluded.deletedAt`,
      )
      .run({
        id: input.id,
        type: input.type,
        name: input.name,
        body: input.body,
        source: input.source,
        repoId: input.repoId ?? null,
        createdAt,
        updatedAt,
        deletedAt: input.deletedAt ?? null,
      });
    const item = await this.getTemplateLibraryItem(input.id, { includeDeleted: true });
    if (!item) throw new Error(`template library item ${input.id} was not persisted`);
    return item;
  }

  async softDeleteTemplateLibraryItem(
    itemId: string,
    options: { now?: string } = {},
  ): Promise<boolean> {
    const at = options.now ?? nowIso();
    const result = this.db
      .prepare(
        "UPDATE template_library_items SET deletedAt = ?, updatedAt = ? WHERE id = ? AND deletedAt IS NULL",
      )
      .run(at, at, itemId);
    return result.changes > 0;
  }

  async getTemplatePackage(
    packageId: string,
    options: { includeDeleted?: boolean } = {},
  ): Promise<TemplatePackage | undefined> {
    const sql = options.includeDeleted
      ? "SELECT * FROM template_packages WHERE id = ?"
      : "SELECT * FROM template_packages WHERE id = ? AND deletedAt IS NULL";
    const row = this.db.prepare(sql).get(packageId) as Row | undefined;
    return row ? this.mapPackage(row) : undefined;
  }

  async listTemplatePackages(
    options: { includeDeleted?: boolean } = {},
  ): Promise<TemplatePackage[]> {
    const sql = options.includeDeleted
      ? "SELECT * FROM template_packages ORDER BY name"
      : "SELECT * FROM template_packages WHERE deletedAt IS NULL ORDER BY name";
    return (this.db.prepare(sql).all() as Row[]).map((row) => this.mapPackage(row));
  }

  async upsertTemplatePackage(input: TemplatePackageInput): Promise<TemplatePackage> {
    assertTemplateSource(input.source);
    const createdAt = input.createdAt ?? nowIso();
    const updatedAt = input.updatedAt ?? nowIso();
    this.db
      .prepare(
        `INSERT INTO template_packages
           (id, name, version, contents, source, createdAt, updatedAt, deletedAt)
         VALUES
           (@id, @name, @version, @contents, @source, @createdAt, @updatedAt, @deletedAt)
         ON CONFLICT(id) DO UPDATE SET
           name = excluded.name,
           version = excluded.version,
           contents = excluded.contents,
           source = excluded.source,
           updatedAt = excluded.updatedAt,
           deletedAt = excluded.deletedAt`,
      )
      .run({
        id: input.id,
        name: input.name,
        version: input.version,
        contents: stringifyArray(input.contents),
        source: input.source,
        createdAt,
        updatedAt,
        deletedAt: input.deletedAt ?? null,
      });
    const pkg = await this.getTemplatePackage(input.id, { includeDeleted: true });
    if (!pkg) throw new Error(`template package ${input.id} was not persisted`);
    return pkg;
  }

  async softDeleteTemplatePackage(
    packageId: string,
    options: { now?: string } = {},
  ): Promise<boolean> {
    const at = options.now ?? nowIso();
    const result = this.db
      .prepare(
        "UPDATE template_packages SET deletedAt = ?, updatedAt = ? WHERE id = ? AND deletedAt IS NULL",
      )
      .run(at, at, packageId);
    return result.changes > 0;
  }
}

export async function openSqliteTemplateRepository(
  options: OpenSqliteRepositoryOptions,
): Promise<SqliteTemplateRepository> {
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
    const existing =
      row?.version === null || row?.version === undefined ? 0 : asNumber(row.version);
    if (existing > target) {
      throw new SchemaVersionError(existing, target);
    }
    const applied = runMigrations(db, migrations);
    if (applied !== target) {
      throw new SchemaVersionError(applied, target);
    }
    return new SqliteTemplateRepository(db, applied);
  } catch (error) {
    db.close();
    throw error;
  }
}
