// CaTemplate persistence behind a repository interface (ADR-0015, EPIC-015 §5).
// The BFF owns the storage contract; SQL lives only in the SQLite implementation
// and in the numbered migrations under portal/db/migrations.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";

export const CA_TEMPLATE_SOURCES = ["local"] as const;
export type CaTemplateSource = (typeof CA_TEMPLATE_SOURCES)[number];

export interface CaTemplate {
  id: string;
  name: string;
  policyJson: Record<string, unknown>;
  source: CaTemplateSource;
  category: string | null;
  version: number;
  createdAt: string;
  updatedAt: string;
  deletedAt: string | null;
}

export interface CaTemplateVersion {
  templateId: string;
  version: number;
  name: string;
  policyJson: Record<string, unknown>;
  category: string | null;
  createdAt: string;
}

export interface CaTemplateCreateInput {
  id?: string;
  name: string;
  policyJson: Record<string, unknown>;
  source?: string;
  category?: string | null;
}

export interface CaTemplateUpdateInput {
  name?: string;
  policyJson?: Record<string, unknown>;
  source?: string;
  category?: string | null;
}

export interface CaTemplateListOptions {
  includeDeleted?: boolean;
  category?: string;
}

export interface CaTemplateRepository {
  list(options?: CaTemplateListOptions): Promise<CaTemplate[]>;
  get(id: string, options?: { includeDeleted?: boolean }): Promise<CaTemplate | undefined>;
  create(input: CaTemplateCreateInput): Promise<CaTemplate>;
  update(id: string, input: CaTemplateUpdateInput): Promise<CaTemplate | undefined>;
  remove(id: string): Promise<boolean>;
  listVersions(id: string): Promise<CaTemplateVersion[]>;
  getVersion(id: string, version: number): Promise<CaTemplateVersion | undefined>;
}

export interface ValidationIssue {
  field: string;
  reason: string;
}

export class CaTemplateValidationError extends Error {
  readonly code = "ca_template.invalid";
  readonly issues: ValidationIssue[];

  constructor(issues: ValidationIssue[]) {
    super("CA template is not valid");
    this.name = "CaTemplateValidationError";
    this.issues = issues;
  }
}

export class CaTemplateNotFoundError extends Error {
  readonly code = "ca_template.not_found";
  readonly templateId: string;

  constructor(templateId: string) {
    super(`CA template ${templateId} was not found`);
    this.name = "CaTemplateNotFoundError";
    this.templateId = templateId;
  }
}

const CA_POLICY_STATES = ["enabled", "disabled", "enabledForReportingButNotEnforced"];

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

/**
 * Rejects a body that is not a well-formed Conditional Access policy object.
 * The shape matches Graph's `conditionalAccessPolicy` enough for deploy (T-0286)
 * to consume: an object naming the policy with valid `state` and object-valued
 * `conditions` / `grantControls` when present.
 */
export function collectPolicyJsonIssues(policyJson: unknown): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  if (!isPlainObject(policyJson)) {
    issues.push({ field: "policyJson", reason: "must be a JSON object" });
    return issues;
  }
  if (!nonEmptyString(policyJson["displayName"]) && !nonEmptyString(policyJson["name"])) {
    issues.push({
      field: "policyJson.displayName",
      reason: "must be a non-empty string (or a `name`)",
    });
  }
  const state = policyJson["state"];
  if (state !== undefined && !CA_POLICY_STATES.includes(String(state))) {
    issues.push({
      field: "policyJson.state",
      reason: `must be one of ${CA_POLICY_STATES.join(", ")}`,
    });
  }
  if (policyJson["conditions"] !== undefined && !isPlainObject(policyJson["conditions"])) {
    issues.push({ field: "policyJson.conditions", reason: "must be an object" });
  }
  if (policyJson["grantControls"] !== undefined && !isPlainObject(policyJson["grantControls"])) {
    issues.push({ field: "policyJson.grantControls", reason: "must be an object" });
  }
  return issues;
}

export function collectCreateIssues(input: CaTemplateCreateInput): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  if (!nonEmptyString(input.name)) {
    issues.push({ field: "name", reason: "must be a non-empty string" });
  }
  issues.push(...collectPolicyJsonIssues(input.policyJson));
  issues.push(...collectSourceIssues(input.source));
  issues.push(...collectCategoryIssues(input.category));
  return issues;
}

export function collectUpdateIssues(input: CaTemplateUpdateInput): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  if (input.name !== undefined && !nonEmptyString(input.name)) {
    issues.push({ field: "name", reason: "must be a non-empty string" });
  }
  if (input.policyJson !== undefined) {
    issues.push(...collectPolicyJsonIssues(input.policyJson));
  }
  issues.push(...collectSourceIssues(input.source));
  issues.push(...collectCategoryIssues(input.category));
  return issues;
}

function collectSourceIssues(source: unknown): ValidationIssue[] {
  if (source === undefined) return [];
  if (!(CA_TEMPLATE_SOURCES as readonly string[]).includes(String(source))) {
    return [
      {
        field: "source",
        reason: "must be 'local' in v1 (community templates are deferred to EPIC-039)",
      },
    ];
  }
  return [];
}

function collectCategoryIssues(category: unknown): ValidationIssue[] {
  if (category === undefined || category === null) return [];
  if (!nonEmptyString(category)) {
    return [{ field: "category", reason: "must be a non-empty string when provided" }];
  }
  return [];
}

export function validateCreate(input: CaTemplateCreateInput): void {
  const issues = collectCreateIssues(input);
  if (issues.length > 0) throw new CaTemplateValidationError(issues);
}

export function validateUpdate(input: CaTemplateUpdateInput): void {
  const issues = collectUpdateIssues(input);
  if (issues.length > 0) throw new CaTemplateValidationError(issues);
}

function clonePolicy(policyJson: Record<string, unknown>): Record<string, unknown> {
  return JSON.parse(JSON.stringify(policyJson)) as Record<string, unknown>;
}

function nowIso(): string {
  return new Date().toISOString();
}

function randomTemplateId(): string {
  return globalThis.crypto.randomUUID();
}

export class InMemoryCaTemplateRepository implements CaTemplateRepository {
  private readonly rows = new Map<string, CaTemplate>();
  private readonly versions = new Map<string, CaTemplateVersion[]>();

  async list(options: CaTemplateListOptions = {}): Promise<CaTemplate[]> {
    return [...this.rows.values()]
      .filter((row) => options.includeDeleted === true || row.deletedAt === null)
      .filter((row) => options.category === undefined || row.category === options.category)
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((row) => ({ ...row, policyJson: clonePolicy(row.policyJson) }));
  }

  async get(id: string, options: { includeDeleted?: boolean } = {}): Promise<CaTemplate | undefined> {
    const row = this.rows.get(id);
    if (!row) return undefined;
    if (!options.includeDeleted && row.deletedAt !== null) return undefined;
    return { ...row, policyJson: clonePolicy(row.policyJson) };
  }

  async create(input: CaTemplateCreateInput): Promise<CaTemplate> {
    validateCreate(input);
    const at = nowIso();
    const id = input.id ?? randomTemplateId();
    if (this.rows.has(id)) {
      throw new CaTemplateValidationError([{ field: "id", reason: `${id} already exists` }]);
    }
    const row: CaTemplate = {
      id,
      name: input.name,
      policyJson: clonePolicy(input.policyJson),
      source: "local",
      category: input.category ?? null,
      version: 1,
      createdAt: at,
      updatedAt: at,
      deletedAt: null,
    };
    this.rows.set(id, row);
    this.versions.set(id, [
      {
        templateId: id,
        version: 1,
        name: row.name,
        policyJson: clonePolicy(row.policyJson),
        category: row.category,
        createdAt: at,
      },
    ]);
    return { ...row, policyJson: clonePolicy(row.policyJson) };
  }

  async update(id: string, input: CaTemplateUpdateInput): Promise<CaTemplate | undefined> {
    validateUpdate(input);
    const existing = this.rows.get(id);
    if (!existing || existing.deletedAt !== null) return undefined;
    const at = nowIso();
    const next: CaTemplate = {
      ...existing,
      name: input.name ?? existing.name,
      policyJson:
        input.policyJson === undefined ? existing.policyJson : clonePolicy(input.policyJson),
      source: "local",
      category: input.category === undefined ? existing.category : input.category,
      version: existing.version + 1,
      updatedAt: at,
    };
    this.rows.set(id, next);
    const history = this.versions.get(id) ?? [];
    history.push({
      templateId: id,
      version: next.version,
      name: next.name,
      policyJson: clonePolicy(next.policyJson),
      category: next.category,
      createdAt: at,
    });
    this.versions.set(id, history);
    return { ...next, policyJson: clonePolicy(next.policyJson) };
  }

  async remove(id: string): Promise<boolean> {
    const existing = this.rows.get(id);
    if (!existing || existing.deletedAt !== null) return false;
    this.rows.set(id, { ...existing, deletedAt: nowIso(), updatedAt: nowIso() });
    return true;
  }

  async listVersions(id: string): Promise<CaTemplateVersion[]> {
    return (this.versions.get(id) ?? [])
      .slice()
      .sort((a, b) => a.version - b.version)
      .map((entry) => ({ ...entry, policyJson: clonePolicy(entry.policyJson) }));
  }

  async getVersion(id: string, version: number): Promise<CaTemplateVersion | undefined> {
    const entry = (this.versions.get(id) ?? []).find((candidate) => candidate.version === version);
    return entry ? { ...entry, policyJson: clonePolicy(entry.policyJson) } : undefined;
  }
}

type Row = Record<string, unknown>;

const MIGRATION_URL = new URL("../../../db/migrations/0003_ca_templates.sql", import.meta.url);

export function caTemplateMigrationSql(): string {
  return readFileSync(fileURLToPath(MIGRATION_URL), "utf8");
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

function parseJsonObject(value: unknown): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(String(value));
    return isPlainObject(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

export class SqliteCaTemplateRepository implements CaTemplateRepository {
  constructor(private readonly db: Database.Database) {
    this.db.exec(caTemplateMigrationSql());
  }

  private mapRow(row: Row): CaTemplate {
    return {
      id: asString(row["id"]),
      name: asString(row["name"]),
      policyJson: parseJsonObject(row["policyJson"]),
      source: asString(row["source"]) as CaTemplateSource,
      category: asNullableString(row["category"]),
      version: asNumber(row["version"]),
      createdAt: asString(row["createdAt"]),
      updatedAt: asString(row["updatedAt"]),
      deletedAt: asNullableString(row["deletedAt"]),
    };
  }

  private mapVersion(row: Row): CaTemplateVersion {
    return {
      templateId: asString(row["templateId"]),
      version: asNumber(row["version"]),
      name: asString(row["name"]),
      policyJson: parseJsonObject(row["policyJson"]),
      category: asNullableString(row["category"]),
      createdAt: asString(row["createdAt"]),
    };
  }

  async list(options: CaTemplateListOptions = {}): Promise<CaTemplate[]> {
    const where: string[] = [];
    const params: unknown[] = [];
    if (options.includeDeleted !== true) where.push("deletedAt IS NULL");
    if (options.category !== undefined) {
      where.push("category = ?");
      params.push(options.category);
    }
    const sql =
      "SELECT * FROM ca_templates" +
      (where.length > 0 ? ` WHERE ${where.join(" AND ")}` : "") +
      " ORDER BY name";
    return (this.db.prepare(sql).all(...params) as Row[]).map((row) => this.mapRow(row));
  }

  async get(id: string, options: { includeDeleted?: boolean } = {}): Promise<CaTemplate | undefined> {
    const sql =
      options.includeDeleted === true
        ? "SELECT * FROM ca_templates WHERE id = ?"
        : "SELECT * FROM ca_templates WHERE id = ? AND deletedAt IS NULL";
    const row = this.db.prepare(sql).get(id) as Row | undefined;
    return row ? this.mapRow(row) : undefined;
  }

  async create(input: CaTemplateCreateInput): Promise<CaTemplate> {
    validateCreate(input);
    const at = nowIso();
    const id = input.id ?? randomTemplateId();
    if (await this.get(id, { includeDeleted: true })) {
      throw new CaTemplateValidationError([{ field: "id", reason: `${id} already exists` }]);
    }
    const policyJson = clonePolicy(input.policyJson);
    const apply = this.db.transaction(() => {
      this.db
        .prepare(
          `INSERT INTO ca_templates
             (id, name, policyJson, source, category, version, createdAt, updatedAt, deletedAt)
           VALUES (?, ?, ?, 'local', ?, 1, ?, ?, NULL)`,
        )
        .run(id, input.name, JSON.stringify(policyJson), input.category ?? null, at, at);
      this.insertVersion(id, 1, input.name, policyJson, input.category ?? null, at);
    });
    apply();
    const created = await this.get(id);
    if (!created) throw new Error(`CA template ${id} was not persisted`);
    return created;
  }

  async update(id: string, input: CaTemplateUpdateInput): Promise<CaTemplate | undefined> {
    validateUpdate(input);
    const existing = await this.get(id);
    if (!existing) return undefined;
    const at = nowIso();
    const nextName = input.name ?? existing.name;
    const nextPolicy = input.policyJson === undefined ? existing.policyJson : clonePolicy(input.policyJson);
    const nextCategory = input.category === undefined ? existing.category : input.category;
    const nextVersion = existing.version + 1;
    const apply = this.db.transaction(() => {
      this.db
        .prepare(
          `UPDATE ca_templates
             SET name = ?, policyJson = ?, source = 'local', category = ?, version = ?, updatedAt = ?
           WHERE id = ? AND deletedAt IS NULL`,
        )
        .run(nextName, JSON.stringify(nextPolicy), nextCategory, nextVersion, at, id);
      this.insertVersion(id, nextVersion, nextName, nextPolicy, nextCategory, at);
    });
    apply();
    return this.get(id);
  }

  async remove(id: string): Promise<boolean> {
    const result = this.db
      .prepare("UPDATE ca_templates SET deletedAt = ?, updatedAt = ? WHERE id = ? AND deletedAt IS NULL")
      .run(nowIso(), nowIso(), id);
    return result.changes > 0;
  }

  async listVersions(id: string): Promise<CaTemplateVersion[]> {
    return (
      this.db
        .prepare("SELECT * FROM ca_template_versions WHERE templateId = ? ORDER BY version")
        .all(id) as Row[]
    ).map((row) => this.mapVersion(row));
  }

  async getVersion(id: string, version: number): Promise<CaTemplateVersion | undefined> {
    const row = this.db
      .prepare("SELECT * FROM ca_template_versions WHERE templateId = ? AND version = ?")
      .get(id, version) as Row | undefined;
    return row ? this.mapVersion(row) : undefined;
  }

  private insertVersion(
    templateId: string,
    version: number,
    name: string,
    policyJson: Record<string, unknown>,
    category: string | null,
    createdAt: string,
  ): void {
    this.db
      .prepare(
        `INSERT INTO ca_template_versions
           (templateId, version, name, policyJson, category, createdAt)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(templateId, version, name, JSON.stringify(policyJson), category, createdAt);
  }
}
