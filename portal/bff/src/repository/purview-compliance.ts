// Purview compliance storage (EPIC-030 SPEC §5, §8; 03-database.md §5/§6).
//
// Policies are read live from Purview/Graph/EXO, so this module persists only
// the two durable entities: area-typed ComplianceTemplate rows (soft-deleted so
// history survives) and append-only CompliancePolicyChange history that records
// before/after. The storage engine is kept behind this interface (ADR-0015):
// callers pass an opened connection, never SQL, and the repository exposes no
// update or delete path for change records.
import { randomUUID } from "node:crypto";
import { AppError, type ErrorDetail } from "../errors.js";

type Row = Record<string, unknown>;

export const PURVIEW_AREAS = ["dlp", "retention", "label", "sit", "safelinks"] as const;

export type PurviewArea = (typeof PURVIEW_AREAS)[number];

export const COMPLIANCE_TEMPLATE_SOURCES = ["local"] as const;

export type ComplianceTemplateSource = (typeof COMPLIANCE_TEMPLATE_SOURCES)[number];

export interface ComplianceTemplate {
  id: string;
  name: string;
  area: PurviewArea;
  payload: Record<string, unknown>;
  variables: Record<string, unknown>;
  source: ComplianceTemplateSource;
}

// Storage metadata: templates soft-delete so audit and history survive (§5).
export interface ComplianceTemplateRecord extends ComplianceTemplate {
  createdAt: string;
  updatedAt: string;
  deletedAt: string | null;
}

export interface CompliancePolicyChange {
  id: string;
  tenantId: string;
  area: PurviewArea;
  policyId: string;
  at: string;
  by: string;
  before: Record<string, unknown> | null;
  after: Record<string, unknown> | null;
}

export interface ComplianceTemplateInput {
  id?: string;
  name: string;
  area: PurviewArea;
  payload: Record<string, unknown> | string;
  variables?: Record<string, unknown> | string;
  source?: ComplianceTemplateSource;
  createdAt?: string;
  updatedAt?: string;
}

export interface ComplianceTemplatePatch {
  name?: string;
  area?: PurviewArea;
  payload?: Record<string, unknown> | string;
  variables?: Record<string, unknown> | string;
}

export interface ComplianceTemplateListOptions {
  area?: PurviewArea;
  includeDeleted?: boolean;
}

export interface CompliancePolicyChangeInput {
  id?: string;
  tenantId: string;
  area: PurviewArea;
  policyId: string;
  at?: string;
  by: string;
  before?: Record<string, unknown> | string | null;
  after?: Record<string, unknown> | string | null;
  createdAt?: string;
}

export interface CompliancePolicyChangeListOptions {
  area?: PurviewArea;
  policyId?: string;
}

// Minimal structural view of a SQLite connection so this module names no engine
// package; the caller's better-sqlite3 Database satisfies it.
export interface PurviewStatement {
  run(...params: unknown[]): { changes: number };
  all(...params: unknown[]): unknown[];
  get(...params: unknown[]): unknown;
}

export interface PurviewDatabase {
  prepare(sql: string): PurviewStatement;
  close?(): void;
}

export interface PurviewComplianceRepository {
  readonly schemaVersion: number;

  close(): void;

  createTemplate(input: ComplianceTemplateInput): Promise<ComplianceTemplateRecord>;
  getTemplate(
    id: string,
    options?: { includeDeleted?: boolean },
  ): Promise<ComplianceTemplateRecord | undefined>;
  listTemplates(options?: ComplianceTemplateListOptions): Promise<ComplianceTemplateRecord[]>;
  updateTemplate(
    id: string,
    patch: ComplianceTemplatePatch,
  ): Promise<ComplianceTemplateRecord | undefined>;
  softDeleteTemplate(id: string, options?: { now?: string }): Promise<boolean>;

  recordPolicyChange(input: CompliancePolicyChangeInput): Promise<CompliancePolicyChange>;
  getPolicyChange(tenantId: string, id: string): Promise<CompliancePolicyChange | undefined>;
  listPolicyChanges(
    tenantId: string,
    options?: CompliancePolicyChangeListOptions,
  ): Promise<CompliancePolicyChange[]>;
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

function stringifyJson(value: unknown): string {
  return JSON.stringify(value);
}

function parseJsonObject(value: unknown): Record<string, unknown> | null {
  if (value === null || value === undefined) return null;
  try {
    const parsed: unknown = JSON.parse(String(value));
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function invalid(field: string, reason: string): AppError {
  const details: ErrorDetail[] = [{ field, reason }];
  return new AppError("purview.invalid", "invalid purview compliance record", 400, details);
}

function isPurviewArea(value: unknown): value is PurviewArea {
  return typeof value === "string" && (PURVIEW_AREAS as readonly string[]).includes(value);
}

function isTemplateSource(value: unknown): value is ComplianceTemplateSource {
  return (
    typeof value === "string" &&
    (COMPLIANCE_TEMPLATE_SOURCES as readonly string[]).includes(value)
  );
}

function requireArea(value: unknown): PurviewArea {
  if (!isPurviewArea(value)) {
    throw invalid("area", `must be one of ${PURVIEW_AREAS.join(", ")}`);
  }
  return value;
}

function requireSource(value: unknown): ComplianceTemplateSource {
  if (!isTemplateSource(value)) {
    throw invalid("source", "must be 'local' in v1");
  }
  return value;
}

function requireNonEmpty(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw invalid(field, "must be a non-empty string");
  }
  return value.trim();
}

function requireJsonObject(value: unknown, field: string): Record<string, unknown> {
  let candidate = value;
  if (typeof value === "string") {
    try {
      candidate = JSON.parse(value);
    } catch {
      throw invalid(field, "must be well-formed JSON");
    }
  }
  if (typeof candidate !== "object" || candidate === null || Array.isArray(candidate)) {
    throw invalid(field, "must be a JSON object");
  }
  return candidate as Record<string, unknown>;
}

function optionalJsonObject(
  value: unknown,
  field: string,
): Record<string, unknown> | null {
  if (value === null || value === undefined) return null;
  return requireJsonObject(value, field);
}

function requireInstant(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw invalid(field, "must be an ISO-8601 instant");
  }
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    throw invalid(field, "must be an ISO-8601 instant");
  }
  return parsed.toISOString();
}

export class SqlitePurviewComplianceRepository implements PurviewComplianceRepository {
  readonly schemaVersion: number;

  constructor(
    private readonly db: PurviewDatabase,
    schemaVersion: number,
  ) {
    this.schemaVersion = schemaVersion;
  }

  close(): void {
    this.db.close?.();
  }

  private mapTemplate(row: Row): ComplianceTemplateRecord {
    return {
      id: asString(row["id"]),
      name: asString(row["name"]),
      area: asString(row["area"]) as PurviewArea,
      payload: parseJsonObject(row["payload"]) ?? {},
      variables: parseJsonObject(row["variables"]) ?? {},
      source: asString(row["source"]) as ComplianceTemplateSource,
      createdAt: asString(row["createdAt"]),
      updatedAt: asString(row["updatedAt"]),
      deletedAt: asNullableString(row["deletedAt"]),
    };
  }

  private mapChange(row: Row): CompliancePolicyChange {
    return {
      id: asString(row["id"]),
      tenantId: asString(row["tenantId"]),
      area: asString(row["area"]) as PurviewArea,
      policyId: asString(row["policyId"]),
      at: asString(row["at"]),
      by: asString(row["by"]),
      before: parseJsonObject(row["before"]),
      after: parseJsonObject(row["after"]),
    };
  }

  private selectTemplate(
    id: string,
    options: { includeDeleted?: boolean } = {},
  ): ComplianceTemplateRecord | undefined {
    const sql = options.includeDeleted
      ? "SELECT * FROM compliance_templates WHERE id = ?"
      : "SELECT * FROM compliance_templates WHERE id = ? AND deletedAt IS NULL";
    const row = this.db.prepare(sql).get(id) as Row | undefined;
    return row ? this.mapTemplate(row) : undefined;
  }

  private selectChange(tenantId: string, id: string): CompliancePolicyChange | undefined {
    const row = this.db
      .prepare("SELECT * FROM compliance_policy_changes WHERE tenantId = ? AND id = ?")
      .get(tenantId, id) as Row | undefined;
    return row ? this.mapChange(row) : undefined;
  }

  async createTemplate(input: ComplianceTemplateInput): Promise<ComplianceTemplateRecord> {
    const id = input.id ?? randomUUID();
    const name = requireNonEmpty(input.name, "name");
    const area = requireArea(input.area);
    const source = requireSource(input.source ?? "local");
    const payload = requireJsonObject(input.payload, "payload");
    const variables =
      input.variables === undefined ? {} : requireJsonObject(input.variables, "variables");
    const createdAt = input.createdAt ?? nowIso();
    const updatedAt = input.updatedAt ?? createdAt;
    this.db
      .prepare(
        `INSERT INTO compliance_templates
           (id, name, area, payload, variables, source, createdAt, updatedAt, deletedAt)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL)`,
      )
      .run(id, name, area, stringifyJson(payload), stringifyJson(variables), source, createdAt, updatedAt);
    const saved = this.selectTemplate(id, { includeDeleted: true });
    if (!saved) throw new Error(`compliance template ${id} was not persisted`);
    return saved;
  }

  async getTemplate(
    id: string,
    options: { includeDeleted?: boolean } = {},
  ): Promise<ComplianceTemplateRecord | undefined> {
    return this.selectTemplate(id, options);
  }

  async listTemplates(
    options: ComplianceTemplateListOptions = {},
  ): Promise<ComplianceTemplateRecord[]> {
    const where: string[] = [];
    const params: unknown[] = [];
    if (options.includeDeleted !== true) where.push("deletedAt IS NULL");
    if (options.area !== undefined) {
      where.push("area = ?");
      params.push(requireArea(options.area));
    }
    const sql =
      "SELECT * FROM compliance_templates" +
      (where.length > 0 ? ` WHERE ${where.join(" AND ")}` : "") +
      " ORDER BY createdAt, id";
    return (this.db.prepare(sql).all(...params) as Row[]).map((row) => this.mapTemplate(row));
  }

  async updateTemplate(
    id: string,
    patch: ComplianceTemplatePatch,
  ): Promise<ComplianceTemplateRecord | undefined> {
    const existing = this.selectTemplate(id, { includeDeleted: true });
    if (!existing || existing.deletedAt !== null) return undefined;
    const name = patch.name === undefined ? existing.name : requireNonEmpty(patch.name, "name");
    const area = patch.area === undefined ? existing.area : requireArea(patch.area);
    const payload =
      patch.payload === undefined ? existing.payload : requireJsonObject(patch.payload, "payload");
    const variables =
      patch.variables === undefined
        ? existing.variables
        : requireJsonObject(patch.variables, "variables");
    this.db
      .prepare(
        `UPDATE compliance_templates
            SET name = ?, area = ?, payload = ?, variables = ?, updatedAt = ?
          WHERE id = ? AND deletedAt IS NULL`,
      )
      .run(name, area, stringifyJson(payload), stringifyJson(variables), nowIso(), id);
    return this.selectTemplate(id);
  }

  async softDeleteTemplate(id: string, options: { now?: string } = {}): Promise<boolean> {
    const at = options.now ?? nowIso();
    const result = this.db
      .prepare(
        "UPDATE compliance_templates SET deletedAt = ?, updatedAt = ? WHERE id = ? AND deletedAt IS NULL",
      )
      .run(at, at, id);
    return result.changes > 0;
  }

  async recordPolicyChange(input: CompliancePolicyChangeInput): Promise<CompliancePolicyChange> {
    const id = input.id ?? randomUUID();
    const tenantId = requireNonEmpty(input.tenantId, "tenantId");
    const area = requireArea(input.area);
    const policyId = requireNonEmpty(input.policyId, "policyId");
    const at = requireInstant(input.at ?? nowIso(), "at");
    const by = requireNonEmpty(input.by, "by");
    const before = optionalJsonObject(input.before, "before");
    const after = optionalJsonObject(input.after, "after");
    const createdAt = input.createdAt ?? nowIso();
    this.db
      .prepare(
        `INSERT INTO compliance_policy_changes
           (id, tenantId, area, policyId, at, "by", "before", "after", createdAt)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        tenantId,
        area,
        policyId,
        at,
        by,
        before === null ? null : stringifyJson(before),
        after === null ? null : stringifyJson(after),
        createdAt,
      );
    const saved = this.selectChange(tenantId, id);
    if (!saved) throw new Error(`compliance policy change ${id} was not persisted`);
    return saved;
  }

  async getPolicyChange(
    tenantId: string,
    id: string,
  ): Promise<CompliancePolicyChange | undefined> {
    return this.selectChange(tenantId, id);
  }

  async listPolicyChanges(
    tenantId: string,
    options: CompliancePolicyChangeListOptions = {},
  ): Promise<CompliancePolicyChange[]> {
    const where: string[] = ["tenantId = ?"];
    const params: unknown[] = [tenantId];
    if (options.area !== undefined) {
      where.push("area = ?");
      params.push(requireArea(options.area));
    }
    if (options.policyId !== undefined) {
      where.push("policyId = ?");
      params.push(options.policyId);
    }
    const sql = `SELECT * FROM compliance_policy_changes WHERE ${where.join(" AND ")} ORDER BY at, id`;
    return (this.db.prepare(sql).all(...params) as Row[]).map((row) => this.mapChange(row));
  }
}
