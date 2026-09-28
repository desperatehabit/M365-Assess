// EnrollmentProfileTemplate persistence and per-platform profile validation
// (EPIC-017 SPEC §3.5, §4.4, §5; T-0329).
//
// `validateEnrollmentProfile` is the single per-platform check, used for templates here and
// for live profile writes by routes/enrollment-profiles.ts:
//   apple-ade          @odata.type depIOSEnrollmentProfile or depMacOSEnrollmentProfile
//   android-enterprise @odata.type androidDeviceOwnerEnrollmentProfile (defaulted), and a
//                      supported enrollmentMode
// Both need a displayName and must not carry Graph-managed or secret fields (the Android
// enrollment token and QR code). The storage engine is kept behind this interface (ADR-0015).

type Row = Record<string, unknown>;

export const ENROLLMENT_PLATFORMS = ["apple-ade", "android-enterprise"] as const;
export type EnrollmentPlatform = (typeof ENROLLMENT_PLATFORMS)[number];

export const APPLE_PROFILE_TYPES = [
  "#microsoft.graph.depIOSEnrollmentProfile",
  "#microsoft.graph.depMacOSEnrollmentProfile",
] as const;
export const ANDROID_PROFILE_TYPE = "#microsoft.graph.androidDeviceOwnerEnrollmentProfile";
export const ANDROID_ENROLLMENT_MODES = [
  "corporateOwnedDedicatedDevice",
  "corporateOwnedFullyManaged",
  "corporateOwnedWorkProfile",
  "corporateOwnedAOSPUserlessDevice",
  "corporateOwnedAOSPUserAssociatedDevice",
] as const;

/** Fields Graph manages or that are enrollment secrets; never accepted from a caller. */
export const ENROLLMENT_FORBIDDEN_FIELDS = [
  "id",
  "createdDateTime",
  "lastModifiedDateTime",
  "enrolledDeviceCount",
  "tokenValue",
  "tokenCreationDateTime",
  "tokenExpirationDateTime",
  "qrCodeContent",
  "qrCodeImage",
  "isDefault",
] as const;

export const MAX_ENROLLMENT_PROFILE_BYTES = 64 * 1024;

export class EnrollmentProfileValidationError extends Error {
  constructor(
    message: string,
    readonly field: string,
  ) {
    super(message);
    this.name = "EnrollmentProfileValidationError";
  }
}

export class EnrollmentProfileConflictError extends Error {
  constructor(name: string) {
    super(`an enrollment profile template named '${name}' already exists`);
    this.name = "EnrollmentProfileConflictError";
  }
}

export function isEnrollmentPlatform(value: unknown): value is EnrollmentPlatform {
  return (ENROLLMENT_PLATFORMS as readonly unknown[]).includes(value);
}

/**
 * Validates a profile body for its platform and returns a normalised copy (Android gets its
 * @odata.type). `partial` relaxes required fields for a PATCH body.
 */
export function validateEnrollmentProfile(
  platform: unknown,
  profile: unknown,
  options: { partial?: boolean } = {},
): Record<string, unknown> {
  if (!isEnrollmentPlatform(platform)) {
    throw new EnrollmentProfileValidationError(`platform must be one of: ${ENROLLMENT_PLATFORMS.join(", ")}`, "platform");
  }
  if (profile === null || typeof profile !== "object" || Array.isArray(profile)) {
    throw new EnrollmentProfileValidationError("profile must be a JSON object", "profile");
  }
  const body = { ...(profile as Record<string, unknown>) };
  const forbidden = ENROLLMENT_FORBIDDEN_FIELDS.filter((f) => f in body);
  if (forbidden.length > 0) {
    throw new EnrollmentProfileValidationError(`profile must not carry: ${forbidden.join(", ")}`, "profile");
  }
  if (Buffer.byteLength(JSON.stringify(body), "utf8") > MAX_ENROLLMENT_PROFILE_BYTES) {
    throw new EnrollmentProfileValidationError(`profile exceeds ${MAX_ENROLLMENT_PROFILE_BYTES} bytes`, "profile");
  }
  const partial = options.partial === true;
  if (!partial || body["displayName"] !== undefined) {
    if (typeof body["displayName"] !== "string" || !body["displayName"].trim()) {
      throw new EnrollmentProfileValidationError("profile.displayName is required", "profile");
    }
  }

  if (platform === "apple-ade") {
    if ((!partial || body["@odata.type"] !== undefined) && !(APPLE_PROFILE_TYPES as readonly unknown[]).includes(body["@odata.type"])) {
      throw new EnrollmentProfileValidationError(`an Apple ADE profile's @odata.type must be one of: ${APPLE_PROFILE_TYPES.join(", ")}`, "profile");
    }
    return body;
  }

  if (body["@odata.type"] === undefined) body["@odata.type"] = ANDROID_PROFILE_TYPE;
  if (body["@odata.type"] !== ANDROID_PROFILE_TYPE) {
    throw new EnrollmentProfileValidationError(`an Android Enterprise profile's @odata.type must be ${ANDROID_PROFILE_TYPE}`, "profile");
  }
  if ((!partial || body["enrollmentMode"] !== undefined) && !(ANDROID_ENROLLMENT_MODES as readonly unknown[]).includes(body["enrollmentMode"])) {
    throw new EnrollmentProfileValidationError(`profile.enrollmentMode must be one of: ${ANDROID_ENROLLMENT_MODES.join(", ")}`, "profile");
  }
  return body;
}

export interface EnrollmentProfileTemplate {
  readonly id: string;
  readonly name: string;
  readonly platform: EnrollmentPlatform;
  readonly profileJson: Record<string, unknown>;
  readonly createdBy: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface EnrollmentProfileTemplateInput {
  readonly id: string;
  readonly name: string;
  readonly platform: string;
  readonly profileJson: Record<string, unknown>;
  readonly createdBy: string;
  readonly createdAt: string;
}

export type EnrollmentProfileTemplatePatch = Partial<Pick<EnrollmentProfileTemplate, "name" | "profileJson">>;

export interface EnrollmentTemplateStatement {
  run(...params: unknown[]): { changes: number };
  all(...params: unknown[]): unknown[];
  get(...params: unknown[]): unknown;
}

export interface EnrollmentTemplateDatabase {
  prepare(sql: string): EnrollmentTemplateStatement;
  close?(): void;
}

export interface EnrollmentProfileTemplateRepository {
  readonly schemaVersion: number;
  close(): void;
  list(platform?: EnrollmentPlatform): Promise<EnrollmentProfileTemplate[]>;
  get(id: string): Promise<EnrollmentProfileTemplate | undefined>;
  create(input: EnrollmentProfileTemplateInput): Promise<EnrollmentProfileTemplate>;
  update(id: string, patch: EnrollmentProfileTemplatePatch, at: string): Promise<EnrollmentProfileTemplate | undefined>;
  delete(id: string): Promise<boolean>;
}

function validateName(name: unknown): string {
  if (typeof name !== "string" || !name.trim()) throw new EnrollmentProfileValidationError("name is required", "name");
  if (name.trim().length > 256) throw new EnrollmentProfileValidationError("name is too long", "name");
  return name.trim();
}

function isUniqueViolation(error: unknown): boolean {
  return error instanceof Error && /UNIQUE constraint failed/i.test(error.message);
}

export class SqliteEnrollmentProfileTemplateRepository implements EnrollmentProfileTemplateRepository {
  readonly schemaVersion: number;

  constructor(
    private readonly db: EnrollmentTemplateDatabase,
    schemaVersion: number,
  ) {
    this.schemaVersion = schemaVersion;
  }

  close(): void {
    this.db.close?.();
  }

  private map(row: Row): EnrollmentProfileTemplate {
    return {
      id: String(row["id"]),
      name: String(row["name"]),
      platform: String(row["platform"]) as EnrollmentPlatform,
      profileJson: JSON.parse(String(row["profileJson"])) as Record<string, unknown>,
      createdBy: String(row["createdBy"]),
      createdAt: String(row["createdAt"]),
      updatedAt: String(row["updatedAt"]),
    };
  }

  async list(platform?: EnrollmentPlatform): Promise<EnrollmentProfileTemplate[]> {
    const rows = platform
      ? this.db.prepare("SELECT * FROM enrollment_profile_templates WHERE platform = ? ORDER BY name COLLATE NOCASE").all(platform)
      : this.db.prepare("SELECT * FROM enrollment_profile_templates ORDER BY name COLLATE NOCASE").all();
    return (rows as Row[]).map((r) => this.map(r));
  }

  async get(id: string): Promise<EnrollmentProfileTemplate | undefined> {
    const row = this.db.prepare("SELECT * FROM enrollment_profile_templates WHERE id = ?").get(id) as Row | undefined;
    return row ? this.map(row) : undefined;
  }

  async create(input: EnrollmentProfileTemplateInput): Promise<EnrollmentProfileTemplate> {
    const name = validateName(input.name);
    const profile = validateEnrollmentProfile(input.platform, input.profileJson);
    try {
      this.db
        .prepare(
          `INSERT INTO enrollment_profile_templates (id, name, platform, profileJson, createdBy, createdAt, updatedAt)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(input.id, name, input.platform, JSON.stringify(profile), input.createdBy, input.createdAt, input.createdAt);
    } catch (error) {
      if (isUniqueViolation(error)) throw new EnrollmentProfileConflictError(name);
      throw error;
    }
    const saved = await this.get(input.id);
    if (!saved) throw new Error(`enrollment profile template ${input.id} was not persisted`);
    return saved;
  }

  async update(id: string, patch: EnrollmentProfileTemplatePatch, at: string): Promise<EnrollmentProfileTemplate | undefined> {
    const current = await this.get(id);
    if (!current) return undefined;
    const name = patch.name === undefined ? current.name : validateName(patch.name);
    const profile = validateEnrollmentProfile(current.platform, patch.profileJson ?? current.profileJson);
    try {
      this.db
        .prepare("UPDATE enrollment_profile_templates SET name = ?, profileJson = ?, updatedAt = ? WHERE id = ?")
        .run(name, JSON.stringify(profile), at, id);
    } catch (error) {
      if (isUniqueViolation(error)) throw new EnrollmentProfileConflictError(name);
      throw error;
    }
    return this.get(id);
  }

  async delete(id: string): Promise<boolean> {
    return this.db.prepare("DELETE FROM enrollment_profile_templates WHERE id = ?").run(id).changes > 0;
  }
}
