// ApplicationTemplate persistence (EPIC-017 SPEC §3.3, §5; T-0327).
//
// Portal-wide templates for app uploads. `config` is an app upload request body (T-0323
// shape) whose string values may carry `%name%` tokens; `variables` declares the tokens
// the template expects, each with an optional default. Validation happens here so no
// caller can persist a template for an app type v1 does not deploy, a config carrying
// credentials, or a malformed variable. The storage engine is kept behind this interface
// (ADR-0015): callers pass an opened connection, never SQL.
import { lookupAppType, supportedAppTypes } from "../domain/intune-app-types.js";
import { isVariableName } from "../domain/variable-substitution.js";
import { AppDeploymentValidationError, serializeAppDeploymentJson } from "./app-deployments.js";

type Row = Record<string, unknown>;

export interface ApplicationTemplateVariable {
  readonly name: string;
  readonly description?: string;
  /** Used when neither the tenant, the globals, nor the deploy request supplies a value. */
  readonly defaultValue?: string;
}

export interface ApplicationTemplate {
  readonly id: string;
  readonly name: string;
  readonly appType: string;
  readonly config: Record<string, unknown>;
  readonly variables: readonly ApplicationTemplateVariable[];
  readonly createdBy: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface ApplicationTemplateInput {
  readonly id: string;
  readonly name: string;
  readonly appType: string;
  readonly config: Record<string, unknown>;
  readonly variables?: readonly ApplicationTemplateVariable[];
  readonly createdBy: string;
  readonly createdAt: string;
}

export type ApplicationTemplatePatch = Partial<
  Pick<ApplicationTemplate, "name" | "appType" | "config" | "variables">
>;

export interface ApplicationTemplateStatement {
  run(...params: unknown[]): { changes: number };
  all(...params: unknown[]): unknown[];
  get(...params: unknown[]): unknown;
}

export interface ApplicationTemplateDatabase {
  prepare(sql: string): ApplicationTemplateStatement;
  close?(): void;
}

export interface ApplicationTemplateRepository {
  readonly schemaVersion: number;
  close(): void;
  list(): Promise<ApplicationTemplate[]>;
  get(id: string): Promise<ApplicationTemplate | undefined>;
  create(input: ApplicationTemplateInput): Promise<ApplicationTemplate>;
  /** Returns undefined when the template does not exist. */
  update(id: string, patch: ApplicationTemplatePatch, at: string): Promise<ApplicationTemplate | undefined>;
  delete(id: string): Promise<boolean>;
}

/** Thrown for invalid template input; `field` names what was wrong. */
export class ApplicationTemplateValidationError extends Error {
  constructor(
    message: string,
    readonly field: string,
  ) {
    super(message);
    this.name = "ApplicationTemplateValidationError";
  }
}

/** Thrown when another template already has the name (case-insensitive). */
export class ApplicationTemplateConflictError extends Error {
  constructor(name: string) {
    super(`an application template named '${name}' already exists`);
    this.name = "ApplicationTemplateConflictError";
  }
}

const MAX_VARIABLES = 50;

function validateName(name: unknown): string {
  if (typeof name !== "string" || name.trim().length === 0) {
    throw new ApplicationTemplateValidationError("name is required", "name");
  }
  if (name.trim().length > 256) throw new ApplicationTemplateValidationError("name is too long", "name");
  return name.trim();
}

function validateAppType(appType: unknown): string {
  const type = typeof appType === "string" ? appType.trim().toLowerCase() : "";
  const entry = lookupAppType(type);
  if (!entry) {
    throw new ApplicationTemplateValidationError(
      `appType must be one of: ${supportedAppTypes().join(", ")}`,
      "appType",
    );
  }
  if (!entry.supported) {
    throw new ApplicationTemplateValidationError(
      `app type '${type}' is not yet supported; supported types in v1: ${supportedAppTypes().join(", ")}`,
      "appType",
    );
  }
  return type;
}

function validateConfig(config: unknown): string {
  if (config === null || typeof config !== "object" || Array.isArray(config)) {
    throw new ApplicationTemplateValidationError("config must be a JSON object", "config");
  }
  try {
    return serializeAppDeploymentJson("config", config as Record<string, unknown>);
  } catch (error) {
    if (error instanceof AppDeploymentValidationError) {
      throw new ApplicationTemplateValidationError(error.message, "config");
    }
    throw error;
  }
}

export function validateTemplateVariables(value: unknown): ApplicationTemplateVariable[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new ApplicationTemplateValidationError("variables must be an array", "variables");
  if (value.length > MAX_VARIABLES) {
    throw new ApplicationTemplateValidationError(`at most ${MAX_VARIABLES} variables`, "variables");
  }
  const seen = new Set<string>();
  return value.map((raw, i) => {
    if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
      throw new ApplicationTemplateValidationError(`variables[${i}] must be an object`, "variables");
    }
    const record = raw as Record<string, unknown>;
    const name = typeof record["name"] === "string" ? record["name"].trim() : "";
    if (!isVariableName(name)) {
      throw new ApplicationTemplateValidationError(`variables[${i}].name '${name}' is not a valid variable name`, "variables");
    }
    if (seen.has(name)) throw new ApplicationTemplateValidationError(`variable '${name}' is declared twice`, "variables");
    seen.add(name);
    const out: { name: string; description?: string; defaultValue?: string } = { name };
    if (record["description"] !== undefined) {
      if (typeof record["description"] !== "string") {
        throw new ApplicationTemplateValidationError(`variables[${i}].description must be a string`, "variables");
      }
      out.description = record["description"];
    }
    if (record["defaultValue"] !== undefined) {
      if (typeof record["defaultValue"] !== "string") {
        throw new ApplicationTemplateValidationError(`variables[${i}].defaultValue must be a string`, "variables");
      }
      out.defaultValue = record["defaultValue"];
    }
    return out;
  });
}

function isUniqueViolation(error: unknown): boolean {
  return error instanceof Error && /UNIQUE constraint failed/i.test(error.message);
}

export class SqliteApplicationTemplateRepository implements ApplicationTemplateRepository {
  readonly schemaVersion: number;

  constructor(
    private readonly db: ApplicationTemplateDatabase,
    schemaVersion: number,
  ) {
    this.schemaVersion = schemaVersion;
  }

  close(): void {
    this.db.close?.();
  }

  private map(row: Row): ApplicationTemplate {
    return {
      id: String(row["id"]),
      name: String(row["name"]),
      appType: String(row["appType"]),
      config: JSON.parse(String(row["config"])) as Record<string, unknown>,
      variables: JSON.parse(String(row["variables"])) as ApplicationTemplateVariable[],
      createdBy: String(row["createdBy"]),
      createdAt: String(row["createdAt"]),
      updatedAt: String(row["updatedAt"]),
    };
  }

  async list(): Promise<ApplicationTemplate[]> {
    return (this.db.prepare("SELECT * FROM application_templates ORDER BY name COLLATE NOCASE").all() as Row[]).map((r) =>
      this.map(r),
    );
  }

  async get(id: string): Promise<ApplicationTemplate | undefined> {
    const row = this.db.prepare("SELECT * FROM application_templates WHERE id = ?").get(id) as Row | undefined;
    return row ? this.map(row) : undefined;
  }

  async create(input: ApplicationTemplateInput): Promise<ApplicationTemplate> {
    const name = validateName(input.name);
    const appType = validateAppType(input.appType);
    const config = validateConfig(input.config);
    const variables = JSON.stringify(validateTemplateVariables(input.variables));
    try {
      this.db
        .prepare(
          `INSERT INTO application_templates (id, name, appType, config, variables, createdBy, createdAt, updatedAt)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(input.id, name, appType, config, variables, input.createdBy, input.createdAt, input.createdAt);
    } catch (error) {
      if (isUniqueViolation(error)) throw new ApplicationTemplateConflictError(name);
      throw error;
    }
    const saved = await this.get(input.id);
    if (!saved) throw new Error(`application template ${input.id} was not persisted`);
    return saved;
  }

  async update(id: string, patch: ApplicationTemplatePatch, at: string): Promise<ApplicationTemplate | undefined> {
    const current = await this.get(id);
    if (!current) return undefined;
    const name = patch.name === undefined ? current.name : validateName(patch.name);
    const appType = patch.appType === undefined ? current.appType : validateAppType(patch.appType);
    const config = validateConfig(patch.config ?? current.config);
    const variables = JSON.stringify(
      patch.variables === undefined ? current.variables : validateTemplateVariables(patch.variables),
    );
    try {
      this.db
        .prepare(
          `UPDATE application_templates SET name = ?, appType = ?, config = ?, variables = ?, updatedAt = ?
           WHERE id = ?`,
        )
        .run(name, appType, config, variables, at, id);
    } catch (error) {
      if (isUniqueViolation(error)) throw new ApplicationTemplateConflictError(name);
      throw error;
    }
    return this.get(id);
  }

  async delete(id: string): Promise<boolean> {
    return this.db.prepare("DELETE FROM application_templates WHERE id = ?").run(id).changes > 0;
  }
}
