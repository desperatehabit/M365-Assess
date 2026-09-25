// RBAC & API-client entities (EPIC-038 §5) on top of the shared repository
// contract. Base roles are seeded builtin=1 by migration 0002 and are immutable:
// this module exposes no update/delete path for a builtin role.
import Database from "better-sqlite3";
import {
  SchemaVersionError,
  type AccessIPRange,
  type AccessIPRangeInput,
  type ApiClient,
  type ApiClientInput,
  type PermissionRegistryEntry,
  type PermissionRegistryInput,
  type PortalUser,
  type PortalUserInput,
  type PortalUserStatus,
  type Role,
  type RoleInput,
  type ScopeTargetType,
  type UserScope,
  type UserScopeInput,
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

function asBool(value: unknown): boolean {
  return asNumber(value) === 1;
}

function parseJson(value: unknown): Record<string, unknown> | null {
  if (value === null || value === undefined) return null;
  try {
    const parsed: unknown = JSON.parse(String(value));
    return typeof parsed === "object" && parsed !== null
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
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

function stringifyJson(value: unknown): string | null {
  return value === null || value === undefined ? null : JSON.stringify(value);
}

function stringifyArray(value: readonly string[] | undefined): string {
  return JSON.stringify(value ?? []);
}

function parseNullableNumber(value: unknown): number | null {
  return value === null || value === undefined ? null : asNumber(value);
}

/** Raised when a caller tries to mutate a builtin role (SPEC §4.1, §6). */
export class BuiltinRoleError extends Error {
  readonly code = "rbac.builtin_role_immutable";

  constructor(roleId: string) {
    super(`role ${roleId} is builtin and immutable`);
    this.name = "BuiltinRoleError";
  }
}

export interface RbacRepository {
  readonly schemaVersion: number;

  close(): void;

  listPortalUsers(): Promise<PortalUser[]>;
  getPortalUser(userId: string): Promise<PortalUser | undefined>;
  upsertPortalUser(input: PortalUserInput): Promise<PortalUser>;
  removePortalUser(userId: string): Promise<boolean>;

  listUserScopes(userId: string): Promise<UserScope[]>;
  upsertUserScope(input: UserScopeInput): Promise<UserScope>;
  removeUserScope(scopeId: string): Promise<boolean>;

  listRoles(): Promise<Role[]>;
  getRole(roleId: string): Promise<Role | undefined>;
  upsertCustomRole(input: RoleInput): Promise<Role>;
  removeCustomRole(roleId: string): Promise<boolean>;

  listApiClients(): Promise<ApiClient[]>;
  getApiClient(clientId: string): Promise<ApiClient | undefined>;
  upsertApiClient(input: ApiClientInput): Promise<ApiClient>;
  removeApiClient(clientId: string): Promise<boolean>;

  listAccessIPRanges(): Promise<AccessIPRange[]>;
  upsertAccessIPRange(input: AccessIPRangeInput): Promise<AccessIPRange>;
  removeAccessIPRange(rangeId: string): Promise<boolean>;

  listPermissions(): Promise<PermissionRegistryEntry[]>;
  getPermission(endpoint: string): Promise<PermissionRegistryEntry | undefined>;
  upsertPermission(input: PermissionRegistryInput): Promise<PermissionRegistryEntry>;
}

export class SqliteRbacRepository implements RbacRepository {
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

  private mapPortalUser(row: Row): PortalUser {
    return {
      id: asString(row["id"]),
      upn: asString(row["upn"]),
      displayName: asNullableString(row["displayName"]),
      status: asString(row["status"]) as PortalUserStatus,
      preferences: parseJson(row["preferences"]),
      roleId: asNullableString(row["roleId"]),
      createdAt: asString(row["createdAt"]),
      updatedAt: asString(row["updatedAt"]),
    };
  }

  private mapRole(row: Row): Role {
    return {
      id: asString(row["id"]),
      name: asString(row["name"]),
      include: parseJsonArray(row["include"]),
      exclude: parseJsonArray(row["exclude"]),
      builtin: asBool(row["builtin"]),
      createdAt: asString(row["createdAt"]),
      updatedAt: asString(row["updatedAt"]),
    };
  }

  private mapUserScope(row: Row): UserScope {
    return {
      id: asString(row["id"]),
      userId: asString(row["userId"]),
      targetType: asString(row["targetType"]) as ScopeTargetType,
      targetId: asNullableString(row["targetId"]),
      createdAt: asString(row["createdAt"]),
      updatedAt: asString(row["updatedAt"]),
    };
  }

  private mapApiClient(row: Row): ApiClient {
    return {
      id: asString(row["id"]),
      name: asString(row["name"]),
      secretHash: asString(row["secretHash"]),
      roles: parseJsonArray(row["roles"]),
      ipRanges: parseJsonArray(row["ipRanges"]),
      rateLimit: parseNullableNumber(row["rateLimit"]),
      enabled: asBool(row["enabled"]),
      lastUsedAt: asNullableString(row["lastUsedAt"]),
      createdAt: asString(row["createdAt"]),
      updatedAt: asString(row["updatedAt"]),
    };
  }

  private mapAccessIPRange(row: Row): AccessIPRange {
    return {
      id: asString(row["id"]),
      cidr: asString(row["cidr"]),
      scope: asNullableString(row["scope"]),
      createdAt: asString(row["createdAt"]),
      updatedAt: asString(row["updatedAt"]),
    };
  }

  private mapPermission(row: Row): PermissionRegistryEntry {
    return {
      endpoint: asString(row["endpoint"]),
      permission: asString(row["permission"]),
      functionality: asNullableString(row["functionality"]),
      createdAt: asString(row["createdAt"]),
      updatedAt: asString(row["updatedAt"]),
    };
  }

  async listPortalUsers(): Promise<PortalUser[]> {
    return (
      this.db.prepare("SELECT * FROM portal_users ORDER BY upn").all() as Row[]
    ).map((row) => this.mapPortalUser(row));
  }

  async getPortalUser(userId: string): Promise<PortalUser | undefined> {
    const row = this.db.prepare("SELECT * FROM portal_users WHERE id = ?").get(userId) as
      | Row
      | undefined;
    return row ? this.mapPortalUser(row) : undefined;
  }

  async upsertPortalUser(input: PortalUserInput): Promise<PortalUser> {
    const createdAt = input.createdAt ?? nowIso();
    const updatedAt = input.updatedAt ?? nowIso();
    this.db
      .prepare(
        `INSERT INTO portal_users (id, upn, displayName, status, preferences, roleId, createdAt, updatedAt)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           upn = excluded.upn,
           displayName = excluded.displayName,
           status = excluded.status,
           preferences = excluded.preferences,
           roleId = excluded.roleId,
           updatedAt = excluded.updatedAt`,
      )
      .run(
        input.id,
        input.upn,
        input.displayName ?? null,
        input.status,
        stringifyJson(input.preferences),
        input.roleId ?? null,
        createdAt,
        updatedAt,
      );
    const user = await this.getPortalUser(input.id);
    if (!user) throw new Error(`portal user ${input.id} was not persisted`);
    return user;
  }

  async removePortalUser(userId: string): Promise<boolean> {
    const result = this.db.prepare("DELETE FROM portal_users WHERE id = ?").run(userId);
    return result.changes > 0;
  }

  async listUserScopes(userId: string): Promise<UserScope[]> {
    return (
      this.db
        .prepare("SELECT * FROM user_scopes WHERE userId = ? ORDER BY createdAt")
        .all(userId) as Row[]
    ).map((row) => this.mapUserScope(row));
  }

  private userScopeById(scopeId: string): UserScope | undefined {
    const row = this.db.prepare("SELECT * FROM user_scopes WHERE id = ?").get(scopeId) as
      | Row
      | undefined;
    return row ? this.mapUserScope(row) : undefined;
  }

  async upsertUserScope(input: UserScopeInput): Promise<UserScope> {
    const createdAt = input.createdAt ?? nowIso();
    const updatedAt = input.updatedAt ?? nowIso();
    this.db
      .prepare(
        `INSERT INTO user_scopes (id, userId, targetType, targetId, createdAt, updatedAt)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           userId = excluded.userId,
           targetType = excluded.targetType,
           targetId = excluded.targetId,
           updatedAt = excluded.updatedAt`,
      )
      .run(
        input.id,
        input.userId,
        input.targetType,
        input.targetId ?? null,
        createdAt,
        updatedAt,
      );
    const scope = this.userScopeById(input.id);
    if (!scope) throw new Error(`user scope ${input.id} was not persisted`);
    return scope;
  }

  async removeUserScope(scopeId: string): Promise<boolean> {
    const result = this.db.prepare("DELETE FROM user_scopes WHERE id = ?").run(scopeId);
    return result.changes > 0;
  }

  async listRoles(): Promise<Role[]> {
    return (this.db.prepare("SELECT * FROM roles ORDER BY name").all() as Row[]).map((row) =>
      this.mapRole(row),
    );
  }

  async getRole(roleId: string): Promise<Role | undefined> {
    const row = this.db.prepare("SELECT * FROM roles WHERE id = ?").get(roleId) as Row | undefined;
    return row ? this.mapRole(row) : undefined;
  }

  async upsertCustomRole(input: RoleInput): Promise<Role> {
    if (input.builtin) throw new BuiltinRoleError(input.id);
    const existing = await this.getRole(input.id);
    if (existing?.builtin) throw new BuiltinRoleError(input.id);
    const createdAt = input.createdAt ?? nowIso();
    const updatedAt = input.updatedAt ?? nowIso();
    this.db
      .prepare(
        `INSERT INTO roles (id, name, "include", "exclude", builtin, createdAt, updatedAt)
         VALUES (?, ?, ?, ?, 0, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           name = excluded.name,
           "include" = excluded."include",
           "exclude" = excluded."exclude",
           builtin = 0,
           updatedAt = excluded.updatedAt`,
      )
      .run(
        input.id,
        input.name,
        stringifyArray(input.include),
        stringifyArray(input.exclude),
        createdAt,
        updatedAt,
      );
    const role = await this.getRole(input.id);
    if (!role) throw new Error(`role ${input.id} was not persisted`);
    return role;
  }

  async removeCustomRole(roleId: string): Promise<boolean> {
    const existing = await this.getRole(roleId);
    if (!existing) return false;
    if (existing.builtin) throw new BuiltinRoleError(roleId);
    const result = this.db.prepare("DELETE FROM roles WHERE id = ?").run(roleId);
    return result.changes > 0;
  }

  async listApiClients(): Promise<ApiClient[]> {
    return (this.db.prepare("SELECT * FROM api_clients ORDER BY name").all() as Row[]).map((row) =>
      this.mapApiClient(row),
    );
  }

  async getApiClient(clientId: string): Promise<ApiClient | undefined> {
    const row = this.db.prepare("SELECT * FROM api_clients WHERE id = ?").get(clientId) as
      | Row
      | undefined;
    return row ? this.mapApiClient(row) : undefined;
  }

  async upsertApiClient(input: ApiClientInput): Promise<ApiClient> {
    const createdAt = input.createdAt ?? nowIso();
    const updatedAt = input.updatedAt ?? nowIso();
    this.db
      .prepare(
        `INSERT INTO api_clients (id, name, secretHash, roles, ipRanges, rateLimit, enabled, lastUsedAt, createdAt, updatedAt)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           name = excluded.name,
           secretHash = excluded.secretHash,
           roles = excluded.roles,
           ipRanges = excluded.ipRanges,
           rateLimit = excluded.rateLimit,
           enabled = excluded.enabled,
           lastUsedAt = excluded.lastUsedAt,
           updatedAt = excluded.updatedAt`,
      )
      .run(
        input.id,
        input.name,
        input.secretHash,
        stringifyArray(input.roles),
        stringifyArray(input.ipRanges),
        input.rateLimit ?? null,
        input.enabled ? 1 : 0,
        input.lastUsedAt ?? null,
        createdAt,
        updatedAt,
      );
    const client = await this.getApiClient(input.id);
    if (!client) throw new Error(`api client ${input.id} was not persisted`);
    return client;
  }

  async removeApiClient(clientId: string): Promise<boolean> {
    const result = this.db.prepare("DELETE FROM api_clients WHERE id = ?").run(clientId);
    return result.changes > 0;
  }

  async listAccessIPRanges(): Promise<AccessIPRange[]> {
    return (
      this.db.prepare("SELECT * FROM access_ip_ranges ORDER BY cidr").all() as Row[]
    ).map((row) => this.mapAccessIPRange(row));
  }

  private accessIPRangeById(rangeId: string): AccessIPRange | undefined {
    const row = this.db.prepare("SELECT * FROM access_ip_ranges WHERE id = ?").get(rangeId) as
      | Row
      | undefined;
    return row ? this.mapAccessIPRange(row) : undefined;
  }

  async upsertAccessIPRange(input: AccessIPRangeInput): Promise<AccessIPRange> {
    const createdAt = input.createdAt ?? nowIso();
    const updatedAt = input.updatedAt ?? nowIso();
    this.db
      .prepare(
        `INSERT INTO access_ip_ranges (id, cidr, scope, createdAt, updatedAt)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           cidr = excluded.cidr,
           scope = excluded.scope,
           updatedAt = excluded.updatedAt`,
      )
      .run(input.id, input.cidr, input.scope ?? null, createdAt, updatedAt);
    const range = this.accessIPRangeById(input.id);
    if (!range) throw new Error(`access ip range ${input.id} was not persisted`);
    return range;
  }

  async removeAccessIPRange(rangeId: string): Promise<boolean> {
    const result = this.db.prepare("DELETE FROM access_ip_ranges WHERE id = ?").run(rangeId);
    return result.changes > 0;
  }

  async listPermissions(): Promise<PermissionRegistryEntry[]> {
    return (
      this.db.prepare("SELECT * FROM permission_registry ORDER BY endpoint").all() as Row[]
    ).map((row) => this.mapPermission(row));
  }

  async getPermission(endpoint: string): Promise<PermissionRegistryEntry | undefined> {
    const row = this.db.prepare("SELECT * FROM permission_registry WHERE endpoint = ?").get(endpoint) as
      | Row
      | undefined;
    return row ? this.mapPermission(row) : undefined;
  }

  async upsertPermission(input: PermissionRegistryInput): Promise<PermissionRegistryEntry> {
    const createdAt = input.createdAt ?? nowIso();
    const updatedAt = input.updatedAt ?? nowIso();
    this.db
      .prepare(
        `INSERT INTO permission_registry (endpoint, permission, functionality, createdAt, updatedAt)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(endpoint) DO UPDATE SET
           permission = excluded.permission,
           functionality = excluded.functionality,
           updatedAt = excluded.updatedAt`,
      )
      .run(input.endpoint, input.permission, input.functionality ?? null, createdAt, updatedAt);
    const entry = await this.getPermission(input.endpoint);
    if (!entry) throw new Error(`permission ${input.endpoint} was not persisted`);
    return entry;
  }
}

export async function openSqliteRbacRepository(
  options: OpenSqliteRepositoryOptions,
): Promise<SqliteRbacRepository> {
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
    return new SqliteRbacRepository(db, applied);
  } catch (error) {
    db.close();
    throw error;
  }
}
