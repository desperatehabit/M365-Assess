// Transport rule templates (EPIC-021 SPEC.md §3.3, §5; T-0403).
//
// Persists TransportRuleTemplate (id, name, ruleJson, variables, source). A
// template is a persisted snapshot of a transport rule: cloning a rule to a
// template stores its JSON with declared variables and never writes to a
// tenant. `source` is constrained to 'local' in v1 (SPEC §11.3); community
// sharing is deferred to EPIC-039. This module is shared with the connector
// templates (T-0405).
import { randomUUID } from "node:crypto";
import Database from "better-sqlite3";
import { SchemaVersionError } from "./repository.js";
import {
  SCHEMA_VERSIONS_TABLE,
  loadMigrations,
  runMigrations,
  type OpenSqliteRepositoryOptions,
} from "./sqlite-repository.js";

type Row = Record<string, unknown>;

export const TRANSPORT_RULE_TEMPLATE_SOURCES = ["local"] as const;
export type TransportRuleTemplateSource = (typeof TRANSPORT_RULE_TEMPLATE_SOURCES)[number];

export interface TransportRuleTemplateVariable {
  name: string;
  defaultValue?: string;
}

export interface TransportRuleTemplate {
  id: string;
  name: string;
  ruleJson: Record<string, unknown>;
  variables: TransportRuleTemplateVariable[];
  source: TransportRuleTemplateSource;
  createdAt: string;
  updatedAt: string;
  deletedAt: string | null;
}

export interface TransportRuleTemplateCreateInput {
  id?: string;
  name: string;
  ruleJson: Record<string, unknown>;
  variables?: TransportRuleTemplateVariable[];
  source?: string;
  createdAt?: string;
  updatedAt?: string;
}

export interface TransportRuleTemplateUpdateInput {
  name?: string;
  ruleJson?: Record<string, unknown>;
  variables?: TransportRuleTemplateVariable[];
  source?: string;
  updatedAt?: string;
}

export interface TransportRuleTemplateCloneInput {
  id?: string;
  name: string;
  createdAt?: string;
}

export interface TransportRuleTemplateListOptions {
  includeDeleted?: boolean;
}

export interface TransportRuleTemplateReadOptions {
  includeDeleted?: boolean;
}

export interface TransportRuleTemplateRepository {
  readonly schemaVersion: number;

  close(): void;

  createTemplate(input: TransportRuleTemplateCreateInput): Promise<TransportRuleTemplate>;
  getTemplate(
    id: string,
    options?: TransportRuleTemplateReadOptions,
  ): Promise<TransportRuleTemplate | undefined>;
  listTemplates(options?: TransportRuleTemplateListOptions): Promise<TransportRuleTemplate[]>;
  updateTemplate(
    id: string,
    input: TransportRuleTemplateUpdateInput,
  ): Promise<TransportRuleTemplate | undefined>;
  softDeleteTemplate(id: string, options?: { now?: string }): Promise<boolean>;
  cloneTemplate(
    sourceId: string,
    input: TransportRuleTemplateCloneInput,
  ): Promise<TransportRuleTemplate | undefined>;
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

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function cloneRuleJson(ruleJson: Record<string, unknown>): Record<string, unknown> {
  return JSON.parse(JSON.stringify(ruleJson)) as Record<string, unknown>;
}

function parseJsonObject(value: unknown): Record<string, unknown> {
  if (value === null || value === undefined) return {};
  try {
    const parsed: unknown = JSON.parse(String(value));
    return isPlainObject(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function parseVariables(value: unknown): TransportRuleTemplateVariable[] {
  if (value === null || value === undefined) return [];
  try {
    const parsed: unknown = JSON.parse(String(value));
    if (!Array.isArray(parsed)) return [];
    return parsed.map((entry) => {
      if (!isPlainObject(entry) || typeof entry["name"] !== "string") return { name: "" };
      const variable: TransportRuleTemplateVariable = { name: entry["name"] };
      if (typeof entry["defaultValue"] === "string") {
        variable.defaultValue = entry["defaultValue"];
      }
      return variable;
    });
  } catch {
    return [];
  }
}

function stringifyVariables(variables: readonly TransportRuleTemplateVariable[] | undefined): string {
  return JSON.stringify(variables ?? []);
}

export class SqliteTransportRuleTemplateRepository implements TransportRuleTemplateRepository {
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

  private mapTemplate(row: Row): TransportRuleTemplate {
    return {
      id: asString(row["id"]),
      name: asString(row["name"]),
      ruleJson: parseJsonObject(row["ruleJson"]),
      variables: parseVariables(row["variables"]),
      source: asString(row["source"]) as TransportRuleTemplateSource,
      createdAt: asString(row["createdAt"]),
      updatedAt: asString(row["updatedAt"]),
      deletedAt: asNullableString(row["deletedAt"]),
    };
  }

  private templateById(id: string): TransportRuleTemplate | undefined {
    const row = this.db
      .prepare("SELECT * FROM transport_rule_templates WHERE id = ?")
      .get(id) as Row | undefined;
    return row ? this.mapTemplate(row) : undefined;
  }

  async createTemplate(input: TransportRuleTemplateCreateInput): Promise<TransportRuleTemplate> {
    const id = input.id ?? randomUUID();
    const createdAt = input.createdAt ?? nowIso();
    const updatedAt = input.updatedAt ?? createdAt;
    this.db
      .prepare(
        `INSERT INTO transport_rule_templates
           (id, name, ruleJson, variables, source, createdAt, updatedAt, deletedAt)
         VALUES (?, ?, ?, ?, ?, ?, ?, NULL)`,
      )
      .run(
        id,
        input.name,
        JSON.stringify(input.ruleJson),
        stringifyVariables(input.variables),
        input.source ?? "local",
        createdAt,
        updatedAt,
      );

    const created = this.templateById(id);
    if (!created) throw new Error(`transport rule template ${id} was not persisted`);
    return created;
  }

  async getTemplate(
    id: string,
    options: TransportRuleTemplateReadOptions = {},
  ): Promise<TransportRuleTemplate | undefined> {
    const sql =
      options.includeDeleted === true
        ? "SELECT * FROM transport_rule_templates WHERE id = ?"
        : "SELECT * FROM transport_rule_templates WHERE id = ? AND deletedAt IS NULL";
    const row = this.db.prepare(sql).get(id) as Row | undefined;
    return row ? this.mapTemplate(row) : undefined;
  }

  async listTemplates(
    options: TransportRuleTemplateListOptions = {},
  ): Promise<TransportRuleTemplate[]> {
    const sql =
      options.includeDeleted === true
        ? "SELECT * FROM transport_rule_templates ORDER BY name, id"
        : "SELECT * FROM transport_rule_templates WHERE deletedAt IS NULL ORDER BY name, id";
    return (this.db.prepare(sql).all() as Row[]).map((row) => this.mapTemplate(row));
  }

  async updateTemplate(
    id: string,
    input: TransportRuleTemplateUpdateInput,
  ): Promise<TransportRuleTemplate | undefined> {
    const existing = this.templateById(id);
    if (!existing || existing.deletedAt !== null) return undefined;
    const updatedAt = input.updatedAt ?? nowIso();
    this.db
      .prepare(
        `UPDATE transport_rule_templates
           SET name = ?, ruleJson = ?, variables = ?, source = ?, updatedAt = ?
         WHERE id = ? AND deletedAt IS NULL`,
      )
      .run(
        input.name ?? existing.name,
        JSON.stringify(input.ruleJson === undefined ? existing.ruleJson : input.ruleJson),
        stringifyVariables(input.variables === undefined ? existing.variables : input.variables),
        input.source ?? existing.source,
        updatedAt,
        id,
      );

    return this.getTemplate(id);
  }

  async softDeleteTemplate(id: string, options: { now?: string } = {}): Promise<boolean> {
    const existing = this.templateById(id);
    if (!existing || existing.deletedAt !== null) return false;
    const at = options.now ?? nowIso();
    const result = this.db
      .prepare(
        "UPDATE transport_rule_templates SET deletedAt = ?, updatedAt = ? WHERE id = ? AND deletedAt IS NULL",
      )
      .run(at, at, id);
    return result.changes > 0;
  }

  async cloneTemplate(
    sourceId: string,
    input: TransportRuleTemplateCloneInput,
  ): Promise<TransportRuleTemplate | undefined> {
    const source = this.templateById(sourceId);
    if (!source || source.deletedAt !== null) return undefined;
    const id = input.id ?? randomUUID();
    const createdAt = input.createdAt ?? nowIso();
    this.db
      .prepare(
        `INSERT INTO transport_rule_templates
           (id, name, ruleJson, variables, source, createdAt, updatedAt, deletedAt)
         VALUES (?, ?, ?, ?, 'local', ?, ?, NULL)`,
      )
      .run(
        id,
        input.name,
        JSON.stringify(cloneRuleJson(source.ruleJson)),
        stringifyVariables(source.variables),
        createdAt,
        createdAt,
      );

    const created = this.templateById(id);
    if (!created) throw new Error(`transport rule template ${id} was not persisted`);
    return created;
  }
}

export async function openSqliteTransportRuleTemplateRepository(
  options: OpenSqliteRepositoryOptions,
): Promise<SqliteTransportRuleTemplateRepository> {
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
    return new SqliteTransportRuleTemplateRepository(db, applied);
  } catch (error) {
    db.close();
    throw error;
  }
}

// Connector templates (EPIC-021 SPEC.md §3.3, §5; T-0405) share this module
// with the transport rule templates above. A ConnectorTemplate is a persisted
// snapshot of a connector (id, name, connectorJson, variables, source) and is
// never a tenant write. `connectorJson` carries connector secrets by reference
// only (T-0404): the route rejects secret material before it is persisted, so
// the storage layer only ever sees reference-bearing JSON. `source` is
// constrained to 'local' in v1 (SPEC §11.3).
export const CONNECTOR_TEMPLATE_SOURCES = ["local"] as const;
export type ConnectorTemplateSource = (typeof CONNECTOR_TEMPLATE_SOURCES)[number];

export interface ConnectorTemplateVariable {
  name: string;
  defaultValue?: string;
}

export interface ConnectorTemplate {
  id: string;
  name: string;
  connectorJson: Record<string, unknown>;
  variables: ConnectorTemplateVariable[];
  source: ConnectorTemplateSource;
  createdAt: string;
  updatedAt: string;
  deletedAt: string | null;
}

export interface ConnectorTemplateCreateInput {
  id?: string;
  name: string;
  connectorJson: Record<string, unknown>;
  variables?: ConnectorTemplateVariable[];
  source?: string;
  createdAt?: string;
  updatedAt?: string;
}

export interface ConnectorTemplateUpdateInput {
  name?: string;
  connectorJson?: Record<string, unknown>;
  variables?: ConnectorTemplateVariable[];
  source?: string;
  updatedAt?: string;
}

export interface ConnectorTemplateCloneInput {
  id?: string;
  name: string;
  createdAt?: string;
}

export interface ConnectorTemplateListOptions {
  includeDeleted?: boolean;
}

export interface ConnectorTemplateReadOptions {
  includeDeleted?: boolean;
}

export interface ConnectorTemplateRepository {
  readonly schemaVersion: number;

  close(): void;

  createTemplate(input: ConnectorTemplateCreateInput): Promise<ConnectorTemplate>;
  getTemplate(
    id: string,
    options?: ConnectorTemplateReadOptions,
  ): Promise<ConnectorTemplate | undefined>;
  listTemplates(options?: ConnectorTemplateListOptions): Promise<ConnectorTemplate[]>;
  updateTemplate(
    id: string,
    input: ConnectorTemplateUpdateInput,
  ): Promise<ConnectorTemplate | undefined>;
  softDeleteTemplate(id: string, options?: { now?: string }): Promise<boolean>;
  cloneTemplate(
    sourceId: string,
    input: ConnectorTemplateCloneInput,
  ): Promise<ConnectorTemplate | undefined>;
}

function cloneConnectorJson(connectorJson: Record<string, unknown>): Record<string, unknown> {
  return JSON.parse(JSON.stringify(connectorJson)) as Record<string, unknown>;
}

export class SqliteConnectorTemplateRepository implements ConnectorTemplateRepository {
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

  private mapTemplate(row: Row): ConnectorTemplate {
    return {
      id: asString(row["id"]),
      name: asString(row["name"]),
      connectorJson: parseJsonObject(row["connectorJson"]),
      variables: parseVariables(row["variables"]),
      source: asString(row["source"]) as ConnectorTemplateSource,
      createdAt: asString(row["createdAt"]),
      updatedAt: asString(row["updatedAt"]),
      deletedAt: asNullableString(row["deletedAt"]),
    };
  }

  private templateById(id: string): ConnectorTemplate | undefined {
    const row = this.db
      .prepare("SELECT * FROM connector_templates WHERE id = ?")
      .get(id) as Row | undefined;
    return row ? this.mapTemplate(row) : undefined;
  }

  async createTemplate(input: ConnectorTemplateCreateInput): Promise<ConnectorTemplate> {
    const id = input.id ?? randomUUID();
    const createdAt = input.createdAt ?? nowIso();
    const updatedAt = input.updatedAt ?? createdAt;
    this.db
      .prepare(
        `INSERT INTO connector_templates
           (id, name, connectorJson, variables, source, createdAt, updatedAt, deletedAt)
         VALUES (?, ?, ?, ?, ?, ?, ?, NULL)`,
      )
      .run(
        id,
        input.name,
        JSON.stringify(input.connectorJson),
        stringifyVariables(input.variables),
        input.source ?? "local",
        createdAt,
        updatedAt,
      );

    const created = this.templateById(id);
    if (!created) throw new Error(`connector template ${id} was not persisted`);
    return created;
  }

  async getTemplate(
    id: string,
    options: ConnectorTemplateReadOptions = {},
  ): Promise<ConnectorTemplate | undefined> {
    const sql =
      options.includeDeleted === true
        ? "SELECT * FROM connector_templates WHERE id = ?"
        : "SELECT * FROM connector_templates WHERE id = ? AND deletedAt IS NULL";
    const row = this.db.prepare(sql).get(id) as Row | undefined;
    return row ? this.mapTemplate(row) : undefined;
  }

  async listTemplates(options: ConnectorTemplateListOptions = {}): Promise<ConnectorTemplate[]> {
    const sql =
      options.includeDeleted === true
        ? "SELECT * FROM connector_templates ORDER BY name, id"
        : "SELECT * FROM connector_templates WHERE deletedAt IS NULL ORDER BY name, id";
    return (this.db.prepare(sql).all() as Row[]).map((row) => this.mapTemplate(row));
  }

  async updateTemplate(
    id: string,
    input: ConnectorTemplateUpdateInput,
  ): Promise<ConnectorTemplate | undefined> {
    const existing = this.templateById(id);
    if (!existing || existing.deletedAt !== null) return undefined;
    const updatedAt = input.updatedAt ?? nowIso();
    this.db
      .prepare(
        `UPDATE connector_templates
           SET name = ?, connectorJson = ?, variables = ?, source = ?, updatedAt = ?
         WHERE id = ? AND deletedAt IS NULL`,
      )
      .run(
        input.name ?? existing.name,
        JSON.stringify(
          input.connectorJson === undefined ? existing.connectorJson : input.connectorJson,
        ),
        stringifyVariables(input.variables === undefined ? existing.variables : input.variables),
        input.source ?? existing.source,
        updatedAt,
        id,
      );

    return this.getTemplate(id);
  }

  async softDeleteTemplate(id: string, options: { now?: string } = {}): Promise<boolean> {
    const existing = this.templateById(id);
    if (!existing || existing.deletedAt !== null) return false;
    const at = options.now ?? nowIso();
    const result = this.db
      .prepare(
        "UPDATE connector_templates SET deletedAt = ?, updatedAt = ? WHERE id = ? AND deletedAt IS NULL",
      )
      .run(at, at, id);
    return result.changes > 0;
  }

  async cloneTemplate(
    sourceId: string,
    input: ConnectorTemplateCloneInput,
  ): Promise<ConnectorTemplate | undefined> {
    const source = this.templateById(sourceId);
    if (!source || source.deletedAt !== null) return undefined;
    const id = input.id ?? randomUUID();
    const createdAt = input.createdAt ?? nowIso();
    this.db
      .prepare(
        `INSERT INTO connector_templates
           (id, name, connectorJson, variables, source, createdAt, updatedAt, deletedAt)
         VALUES (?, ?, ?, ?, 'local', ?, ?, NULL)`,
      )
      .run(
        id,
        input.name,
        JSON.stringify(cloneConnectorJson(source.connectorJson)),
        stringifyVariables(source.variables),
        createdAt,
        createdAt,
      );

    const created = this.templateById(id);
    if (!created) throw new Error(`connector template ${id} was not persisted`);
    return created;
  }
}

export async function openSqliteConnectorTemplateRepository(
  options: OpenSqliteRepositoryOptions,
): Promise<SqliteConnectorTemplateRepository> {
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
    return new SqliteConnectorTemplateRepository(db, applied);
  } catch (error) {
    db.close();
    throw error;
  }
}
