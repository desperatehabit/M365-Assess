// AutopilotProfileTemplate persistence (EPIC-017 SPEC §3.4, §5; T-0328).
//
// Portal-wide templates for Windows Autopilot deployment profiles: `profileJson` is the
// Graph windowsAutopilotDeploymentProfile body and `groupTag` the tag its devices carry.
// Validation happens here: the body must be an Azure AD or hybrid (Active Directory)
// deployment profile, carry no identity or credential fields, and stay small. The storage
// engine is kept behind this interface (ADR-0015): callers pass an opened connection.
import { AppDeploymentValidationError, serializeAppDeploymentJson } from "./app-deployments.js";

type Row = Record<string, unknown>;

export const AUTOPILOT_PROFILE_TYPES = [
  "#microsoft.graph.azureADWindowsAutopilotDeploymentProfile",
  "#microsoft.graph.activeDirectoryWindowsAutopilotDeploymentProfile",
] as const;

/** Graph-managed fields a template must not carry; they belong to a live profile. */
const READ_ONLY_FIELDS = ["id", "createdDateTime", "lastModifiedDateTime", "assignments", "assignedDevices"];

const GROUP_TAG = /^[A-Za-z0-9 _.-]{1,128}$/;

export interface AutopilotProfileTemplate {
  readonly id: string;
  readonly name: string;
  readonly profileJson: Record<string, unknown>;
  readonly groupTag: string | null;
  readonly createdBy: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface AutopilotProfileTemplateInput {
  readonly id: string;
  readonly name: string;
  readonly profileJson: Record<string, unknown>;
  readonly groupTag?: string | null;
  readonly createdBy: string;
  readonly createdAt: string;
}

export type AutopilotProfileTemplatePatch = Partial<Pick<AutopilotProfileTemplate, "name" | "profileJson" | "groupTag">>;

export interface AutopilotProfileStatement {
  run(...params: unknown[]): { changes: number };
  all(...params: unknown[]): unknown[];
  get(...params: unknown[]): unknown;
}

export interface AutopilotProfileDatabase {
  prepare(sql: string): AutopilotProfileStatement;
  close?(): void;
}

export interface AutopilotProfileTemplateRepository {
  readonly schemaVersion: number;
  close(): void;
  list(): Promise<AutopilotProfileTemplate[]>;
  get(id: string): Promise<AutopilotProfileTemplate | undefined>;
  create(input: AutopilotProfileTemplateInput): Promise<AutopilotProfileTemplate>;
  update(id: string, patch: AutopilotProfileTemplatePatch, at: string): Promise<AutopilotProfileTemplate | undefined>;
  delete(id: string): Promise<boolean>;
}

export class AutopilotProfileValidationError extends Error {
  constructor(
    message: string,
    readonly field: string,
  ) {
    super(message);
    this.name = "AutopilotProfileValidationError";
  }
}

export class AutopilotProfileConflictError extends Error {
  constructor(name: string) {
    super(`an Autopilot profile template named '${name}' already exists`);
    this.name = "AutopilotProfileConflictError";
  }
}

function validateName(name: unknown): string {
  if (typeof name !== "string" || !name.trim()) throw new AutopilotProfileValidationError("name is required", "name");
  if (name.trim().length > 256) throw new AutopilotProfileValidationError("name is too long", "name");
  return name.trim();
}

function validateGroupTag(tag: unknown): string | null {
  if (tag === undefined || tag === null || tag === "") return null;
  if (typeof tag !== "string" || !GROUP_TAG.test(tag.trim())) {
    throw new AutopilotProfileValidationError(
      "groupTag must be 1-128 letters, digits, spaces, dots, dashes, or underscores",
      "groupTag",
    );
  }
  return tag.trim();
}

function validateProfile(profile: unknown): string {
  if (profile === null || typeof profile !== "object" || Array.isArray(profile)) {
    throw new AutopilotProfileValidationError("profileJson must be a JSON object", "profileJson");
  }
  const body = profile as Record<string, unknown>;
  if (!(AUTOPILOT_PROFILE_TYPES as readonly unknown[]).includes(body["@odata.type"])) {
    throw new AutopilotProfileValidationError(
      `profileJson @odata.type must be one of: ${AUTOPILOT_PROFILE_TYPES.join(", ")}`,
      "profileJson",
    );
  }
  if (typeof body["displayName"] !== "string" || !body["displayName"].trim()) {
    throw new AutopilotProfileValidationError("profileJson.displayName is required", "profileJson");
  }
  const readOnly = READ_ONLY_FIELDS.filter((f) => f in body);
  if (readOnly.length > 0) {
    throw new AutopilotProfileValidationError(
      `profileJson must not carry live-profile fields: ${readOnly.join(", ")}`,
      "profileJson",
    );
  }
  try {
    return serializeAppDeploymentJson("profileJson", body);
  } catch (error) {
    if (error instanceof AppDeploymentValidationError) throw new AutopilotProfileValidationError(error.message, "profileJson");
    throw error;
  }
}

function isUniqueViolation(error: unknown): boolean {
  return error instanceof Error && /UNIQUE constraint failed/i.test(error.message);
}

export class SqliteAutopilotProfileTemplateRepository implements AutopilotProfileTemplateRepository {
  readonly schemaVersion: number;

  constructor(
    private readonly db: AutopilotProfileDatabase,
    schemaVersion: number,
  ) {
    this.schemaVersion = schemaVersion;
  }

  close(): void {
    this.db.close?.();
  }

  private map(row: Row): AutopilotProfileTemplate {
    return {
      id: String(row["id"]),
      name: String(row["name"]),
      profileJson: JSON.parse(String(row["profileJson"])) as Record<string, unknown>,
      groupTag: row["groupTag"] === null || row["groupTag"] === undefined ? null : String(row["groupTag"]),
      createdBy: String(row["createdBy"]),
      createdAt: String(row["createdAt"]),
      updatedAt: String(row["updatedAt"]),
    };
  }

  async list(): Promise<AutopilotProfileTemplate[]> {
    return (this.db.prepare("SELECT * FROM autopilot_profile_templates ORDER BY name COLLATE NOCASE").all() as Row[]).map((r) =>
      this.map(r),
    );
  }

  async get(id: string): Promise<AutopilotProfileTemplate | undefined> {
    const row = this.db.prepare("SELECT * FROM autopilot_profile_templates WHERE id = ?").get(id) as Row | undefined;
    return row ? this.map(row) : undefined;
  }

  async create(input: AutopilotProfileTemplateInput): Promise<AutopilotProfileTemplate> {
    const name = validateName(input.name);
    const profile = validateProfile(input.profileJson);
    const groupTag = validateGroupTag(input.groupTag);
    try {
      this.db
        .prepare(
          `INSERT INTO autopilot_profile_templates (id, name, profileJson, groupTag, createdBy, createdAt, updatedAt)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(input.id, name, profile, groupTag, input.createdBy, input.createdAt, input.createdAt);
    } catch (error) {
      if (isUniqueViolation(error)) throw new AutopilotProfileConflictError(name);
      throw error;
    }
    const saved = await this.get(input.id);
    if (!saved) throw new Error(`Autopilot profile template ${input.id} was not persisted`);
    return saved;
  }

  async update(id: string, patch: AutopilotProfileTemplatePatch, at: string): Promise<AutopilotProfileTemplate | undefined> {
    const current = await this.get(id);
    if (!current) return undefined;
    const name = patch.name === undefined ? current.name : validateName(patch.name);
    const profile = validateProfile(patch.profileJson ?? current.profileJson);
    const groupTag = patch.groupTag === undefined ? current.groupTag : validateGroupTag(patch.groupTag);
    try {
      this.db
        .prepare("UPDATE autopilot_profile_templates SET name = ?, profileJson = ?, groupTag = ?, updatedAt = ? WHERE id = ?")
        .run(name, profile, groupTag, at, id);
    } catch (error) {
      if (isUniqueViolation(error)) throw new AutopilotProfileConflictError(name);
      throw error;
    }
    return this.get(id);
  }

  async delete(id: string): Promise<boolean> {
    return this.db.prepare("DELETE FROM autopilot_profile_templates WHERE id = ?").run(id).changes > 0;
  }
}
