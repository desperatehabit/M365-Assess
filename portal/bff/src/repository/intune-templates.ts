// IntuneTemplate persistence behind a repository interface (ADR-0015, EPIC-016 §5).
// The BFF owns the storage contract; SQL lives only in the SQLite implementation
// and in the numbered migration under portal/db/migrations.
//
// The `platform`/`policyType` pairs are the v1 subset of the shared Intune
// policy-type registry (T-0301): Windows configuration and compliance ship first
// (SPEC §11.1), other types are rejected rather than silently accepted. When the
// T-0301 registry lands it should replace INTUNE_POLICY_TYPES below.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";

export const INTUNE_TEMPLATE_SOURCES = ["local"] as const;
export type IntuneTemplateSource = (typeof INTUNE_TEMPLATE_SOURCES)[number];

export const INTUNE_POLICY_KINDS = ["configuration", "compliance"] as const;
export type IntunePolicyKind = (typeof INTUNE_POLICY_KINDS)[number];

export interface IntunePolicyTypePair {
  readonly platform: string;
  readonly policyType: IntunePolicyKind;
}

/** Valid `platform`/`policyType` pairs for v1 (T-0301 registry subset). */
export const INTUNE_POLICY_TYPES: readonly IntunePolicyTypePair[] = Object.freeze([
  Object.freeze({ platform: "windows10", policyType: "configuration" }),
  Object.freeze({ platform: "windows10", policyType: "compliance" }),
  Object.freeze({ platform: "windows81", policyType: "configuration" }),
  Object.freeze({ platform: "windows81", policyType: "compliance" }),
]);

export function isSupportedIntunePolicyType(platform: unknown, policyType: unknown): boolean {
  return INTUNE_POLICY_TYPES.some(
    (pair) => pair.platform === platform && pair.policyType === policyType,
  );
}

export type IntuneAssignment = Record<string, unknown>;

export interface IntuneTemplate {
  id: string;
  name: string;
  platform: string;
  policyType: IntunePolicyKind;
  policyJson: Record<string, unknown>;
  assignments: IntuneAssignment[];
  source: IntuneTemplateSource;
  createdAt: string;
  updatedAt: string;
  deletedAt: string | null;
}

export interface IntuneTemplateCreateInput {
  id?: string;
  name: string;
  platform: string;
  policyType: string;
  policyJson: Record<string, unknown>;
  assignments?: IntuneAssignment[];
  source?: string;
}

export interface IntuneTemplateUpdateInput {
  name?: string;
  platform?: string;
  policyType?: string;
  policyJson?: Record<string, unknown>;
  assignments?: IntuneAssignment[];
  source?: string;
}

export interface IntuneTemplateListOptions {
  includeDeleted?: boolean;
  platform?: string;
  policyType?: string;
}

export interface IntuneTemplateRepository {
  list(options?: IntuneTemplateListOptions): Promise<IntuneTemplate[]>;
  get(id: string, options?: { includeDeleted?: boolean }): Promise<IntuneTemplate | undefined>;
  create(input: IntuneTemplateCreateInput): Promise<IntuneTemplate>;
  update(id: string, input: IntuneTemplateUpdateInput): Promise<IntuneTemplate | undefined>;
  remove(id: string): Promise<boolean>;
}

export interface ValidationIssue {
  field: string;
  reason: string;
}

export class IntuneTemplateValidationError extends Error {
  readonly code = "intune_template.invalid";
  readonly issues: ValidationIssue[];

  constructor(issues: ValidationIssue[]) {
    super("Intune template is not valid");
    this.name = "IntuneTemplateValidationError";
    this.issues = issues;
  }
}

export class IntuneTemplateNotFoundError extends Error {
  readonly code = "intune_template.not_found";
  readonly templateId: string;

  constructor(templateId: string) {
    super(`Intune template ${templateId} was not found`);
    this.name = "IntuneTemplateNotFoundError";
    this.templateId = templateId;
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

/**
 * Rejects a body that is not a well-formed Intune policy object. The shape
 * matches Graph's deviceManagement configuration/compliance resources enough
 * for deploy to consume: an object naming the policy, an optional string
 * `@odata.type`, and object-valued `settings` when present.
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
  const odataType = policyJson["@odata.type"];
  if (odataType !== undefined && !nonEmptyString(odataType)) {
    issues.push({ field: "policyJson.@odata.type", reason: "must be a non-empty string" });
  }
  if (policyJson["settings"] !== undefined && !isPlainObject(policyJson["settings"])) {
    issues.push({ field: "policyJson.settings", reason: "must be an object" });
  }
  return issues;
}

export function collectAssignmentsIssues(assignments: unknown): ValidationIssue[] {
  if (assignments === undefined) return [];
  if (!Array.isArray(assignments)) {
    return [{ field: "assignments", reason: "must be an array" }];
  }
  const issues: ValidationIssue[] = [];
  assignments.forEach((assignment, index) => {
    if (!isPlainObject(assignment)) {
      issues.push({ field: `assignments[${index}]`, reason: "must be an object" });
    }
  });
  return issues;
}

export function collectPolicyTypeIssues(platform: unknown, policyType: unknown): ValidationIssue[] {
  if (!nonEmptyString(platform)) {
    return [{ field: "platform", reason: "must be a non-empty string" }];
  }
  if (!nonEmptyString(policyType)) {
    return [{ field: "policyType", reason: "must be a non-empty string" }];
  }
  if (!isSupportedIntunePolicyType(platform, policyType)) {
    return [
      {
        field: "policyType",
        reason: `(${platform}, ${policyType}) is not a supported platform/policyType pair (T-0301 registry)`,
      },
    ];
  }
  return [];
}

export function collectCreateIssues(input: IntuneTemplateCreateInput): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  if (!nonEmptyString(input.name)) {
    issues.push({ field: "name", reason: "must be a non-empty string" });
  }
  issues.push(...collectPolicyTypeIssues(input.platform, input.policyType));
  issues.push(...collectPolicyJsonIssues(input.policyJson));
  issues.push(...collectAssignmentsIssues(input.assignments));
  issues.push(...collectSourceIssues(input.source));
  return issues;
}

export function collectUpdateIssues(input: IntuneTemplateUpdateInput): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  if (input.name !== undefined && !nonEmptyString(input.name)) {
    issues.push({ field: "name", reason: "must be a non-empty string" });
  }
  if (input.platform !== undefined || input.policyType !== undefined) {
    // Only validate the pair when the PATCH touches it; the repository re-checks
    // the resolved pair (existing values filled in) before writing.
    issues.push(...collectPolicyTypeIssues(input.platform, input.policyType));
  }
  if (input.policyJson !== undefined) {
    issues.push(...collectPolicyJsonIssues(input.policyJson));
  }
  issues.push(...collectAssignmentsIssues(input.assignments));
  issues.push(...collectSourceIssues(input.source));
  return issues;
}

function collectSourceIssues(source: unknown): ValidationIssue[] {
  if (source === undefined) return [];
  if (!(INTUNE_TEMPLATE_SOURCES as readonly string[]).includes(String(source))) {
    return [
      {
        field: "source",
        reason: "must be 'local' in v1 (community templates are deferred to EPIC-039)",
      },
    ];
  }
  return [];
}

export function validateCreate(input: IntuneTemplateCreateInput): void {
  const issues = collectCreateIssues(input);
  if (issues.length > 0) throw new IntuneTemplateValidationError(issues);
}

export function validateUpdate(input: IntuneTemplateUpdateInput): void {
  const issues = collectUpdateIssues(input);
  if (issues.length > 0) throw new IntuneTemplateValidationError(issues);
}

function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function cloneAssignments(assignments: readonly IntuneAssignment[]): IntuneAssignment[] {
  return cloneJson([...assignments]);
}

function nowIso(): string {
  return new Date().toISOString();
}

function randomTemplateId(): string {
  return globalThis.crypto.randomUUID();
}

export class InMemoryIntuneTemplateRepository implements IntuneTemplateRepository {
  private readonly rows = new Map<string, IntuneTemplate>();

  async list(options: IntuneTemplateListOptions = {}): Promise<IntuneTemplate[]> {
    return [...this.rows.values()]
      .filter((row) => options.includeDeleted === true || row.deletedAt === null)
      .filter((row) => options.platform === undefined || row.platform === options.platform)
      .filter((row) => options.policyType === undefined || row.policyType === options.policyType)
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((row) => cloneTemplate(row));
  }

  async get(id: string, options: { includeDeleted?: boolean } = {}): Promise<IntuneTemplate | undefined> {
    const row = this.rows.get(id);
    if (!row) return undefined;
    if (!options.includeDeleted && row.deletedAt !== null) return undefined;
    return cloneTemplate(row);
  }

  async create(input: IntuneTemplateCreateInput): Promise<IntuneTemplate> {
    validateCreate(input);
    const at = nowIso();
    const id = input.id ?? randomTemplateId();
    if (this.rows.has(id)) {
      throw new IntuneTemplateValidationError([{ field: "id", reason: `${id} already exists` }]);
    }
    const row: IntuneTemplate = {
      id,
      name: input.name,
      platform: input.platform,
      policyType: input.policyType as IntunePolicyKind,
      policyJson: cloneJson(input.policyJson),
      assignments: cloneAssignments(input.assignments ?? []),
      source: "local",
      createdAt: at,
      updatedAt: at,
      deletedAt: null,
    };
    this.rows.set(id, row);
    return cloneTemplate(row);
  }

  async update(id: string, input: IntuneTemplateUpdateInput): Promise<IntuneTemplate | undefined> {
    const existing = this.rows.get(id);
    if (!existing || existing.deletedAt !== null) return undefined;
    validateUpdate({
      name: input.name,
      platform: input.platform ?? existing.platform,
      policyType: input.policyType ?? existing.policyType,
      policyJson: input.policyJson,
      assignments: input.assignments,
      source: input.source,
    });
    const at = nowIso();
    const next: IntuneTemplate = {
      ...existing,
      name: input.name ?? existing.name,
      platform: input.platform ?? existing.platform,
      policyType: (input.policyType as IntunePolicyKind | undefined) ?? existing.policyType,
      policyJson: input.policyJson === undefined ? existing.policyJson : cloneJson(input.policyJson),
      assignments:
        input.assignments === undefined ? existing.assignments : cloneAssignments(input.assignments),
      source: "local",
      updatedAt: at,
    };
    this.rows.set(id, next);
    return cloneTemplate(next);
  }

  async remove(id: string): Promise<boolean> {
    const existing = this.rows.get(id);
    if (!existing || existing.deletedAt !== null) return false;
    this.rows.set(id, { ...existing, deletedAt: nowIso(), updatedAt: nowIso() });
    return true;
  }
}

function cloneTemplate(row: IntuneTemplate): IntuneTemplate {
  return {
    ...row,
    policyJson: cloneJson(row.policyJson),
    assignments: cloneAssignments(row.assignments),
  };
}

type Row = Record<string, unknown>;

const MIGRATION_URL = new URL("../../../db/migrations/0003_intune_templates.sql", import.meta.url);

export function intuneTemplateMigrationSql(): string {
  return readFileSync(fileURLToPath(MIGRATION_URL), "utf8");
}

function asString(value: unknown): string {
  return String(value);
}

function asNullableString(value: unknown): string | null {
  return value === null || value === undefined ? null : String(value);
}

function parseJsonObject(value: unknown): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(String(value));
    return isPlainObject(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function parseAssignments(value: unknown): IntuneAssignment[] {
  try {
    const parsed: unknown = JSON.parse(String(value));
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(isPlainObject);
  } catch {
    return [];
  }
}

export class SqliteIntuneTemplateRepository implements IntuneTemplateRepository {
  constructor(private readonly db: Database.Database) {
    this.db.exec(intuneTemplateMigrationSql());
  }

  private mapRow(row: Row): IntuneTemplate {
    return {
      id: asString(row["id"]),
      name: asString(row["name"]),
      platform: asString(row["platform"]),
      policyType: asString(row["policyType"]) as IntunePolicyKind,
      policyJson: parseJsonObject(row["policyJson"]),
      assignments: parseAssignments(row["assignments"]),
      source: asString(row["source"]) as IntuneTemplateSource,
      createdAt: asString(row["createdAt"]),
      updatedAt: asString(row["updatedAt"]),
      deletedAt: asNullableString(row["deletedAt"]),
    };
  }

  async list(options: IntuneTemplateListOptions = {}): Promise<IntuneTemplate[]> {
    const where: string[] = [];
    const params: unknown[] = [];
    if (options.includeDeleted !== true) where.push("deletedAt IS NULL");
    if (options.platform !== undefined) {
      where.push("platform = ?");
      params.push(options.platform);
    }
    if (options.policyType !== undefined) {
      where.push("policyType = ?");
      params.push(options.policyType);
    }
    const sql =
      "SELECT * FROM intune_templates" +
      (where.length > 0 ? ` WHERE ${where.join(" AND ")}` : "") +
      " ORDER BY name";
    return (this.db.prepare(sql).all(...params) as Row[]).map((row) => this.mapRow(row));
  }

  async get(id: string, options: { includeDeleted?: boolean } = {}): Promise<IntuneTemplate | undefined> {
    const sql =
      options.includeDeleted === true
        ? "SELECT * FROM intune_templates WHERE id = ?"
        : "SELECT * FROM intune_templates WHERE id = ? AND deletedAt IS NULL";
    const row = this.db.prepare(sql).get(id) as Row | undefined;
    return row ? this.mapRow(row) : undefined;
  }

  async create(input: IntuneTemplateCreateInput): Promise<IntuneTemplate> {
    validateCreate(input);
    const at = nowIso();
    const id = input.id ?? randomTemplateId();
    if (await this.get(id, { includeDeleted: true })) {
      throw new IntuneTemplateValidationError([{ field: "id", reason: `${id} already exists` }]);
    }
    this.db
      .prepare(
        `INSERT INTO intune_templates
           (id, name, platform, policyType, policyJson, assignments, source, createdAt, updatedAt, deletedAt)
         VALUES (?, ?, ?, ?, ?, ?, 'local', ?, ?, NULL)`,
      )
      .run(
        id,
        input.name,
        input.platform,
        input.policyType,
        JSON.stringify(input.policyJson),
        JSON.stringify(input.assignments ?? []),
        at,
        at,
      );
    const created = await this.get(id);
    if (!created) throw new Error(`Intune template ${id} was not persisted`);
    return created;
  }

  async update(id: string, input: IntuneTemplateUpdateInput): Promise<IntuneTemplate | undefined> {
    const existing = await this.get(id);
    if (!existing) return undefined;
    const nextPlatform = input.platform ?? existing.platform;
    const nextPolicyType = (input.policyType as IntunePolicyKind | undefined) ?? existing.policyType;
    validateUpdate({
      name: input.name,
      platform: nextPlatform,
      policyType: nextPolicyType,
      policyJson: input.policyJson,
      assignments: input.assignments,
      source: input.source,
    });
    const at = nowIso();
    const nextName = input.name ?? existing.name;
    const nextPolicy = input.policyJson === undefined ? existing.policyJson : cloneJson(input.policyJson);
    const nextAssignments =
      input.assignments === undefined ? existing.assignments : cloneAssignments(input.assignments);
    this.db
      .prepare(
        `UPDATE intune_templates
           SET name = ?, platform = ?, policyType = ?, policyJson = ?, assignments = ?, source = 'local', updatedAt = ?
         WHERE id = ? AND deletedAt IS NULL`,
      )
      .run(
        nextName,
        nextPlatform,
        nextPolicyType,
        JSON.stringify(nextPolicy),
        JSON.stringify(nextAssignments),
        at,
        id,
      );
    return this.get(id);
  }

  async remove(id: string): Promise<boolean> {
    const result = this.db
      .prepare(
        "UPDATE intune_templates SET deletedAt = ?, updatedAt = ? WHERE id = ? AND deletedAt IS NULL",
      )
      .run(nowIso(), nowIso(), id);
    return result.changes > 0;
  }
}
