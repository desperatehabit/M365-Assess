// AppSetting schema (EPIC-037 SPEC.md §5, §9, §11.1).
// Typed application settings: a fixed key registry where every key maps to a
// type, a default, and the scopes it may take. SPEC §9 names settings sprawl
// as a risk whose mitigation is this typed schema — no free-form blobs.
// Validation lives here so the T-0722 route and the repository share one
// typed contract; the repository persists whatever this schema accepts.

export const SETTINGS_SCHEMA_VERSION = "v1" as const;

export type SettingsSchemaVersion = typeof SETTINGS_SCHEMA_VERSION;

export type SettingScope = "global" | "tenant";

export type SettingValueType = "string" | "boolean" | "number";

export type SettingValue = string | boolean | number;

export interface SettingKeyDefinition {
  readonly type: SettingValueType;
  readonly default: SettingValue;
  readonly scopes: readonly SettingScope[];
  readonly min?: number;
  readonly max?: number;
  readonly maxLength?: number;
}

// The typed key registry (SPEC §11.1). Every application setting write is
// validated against this table: an unknown key or a value that does not match
// the declared type is rejected. Keys are namespaced by the §3.1 settings tab
// they belong to; branding, feature flags, and preferences are owned by their
// own schemas (T-0723/T-0725/T-0726) and are deliberately absent here.
export const SETTING_KEY_REGISTRY = {
  "general.portalName": {
    type: "string",
    default: "M365-Assess",
    scopes: ["global"],
    maxLength: 100,
  },
  "general.sessionTimeoutMinutes": {
    type: "number",
    default: 480,
    scopes: ["global"],
    min: 5,
    max: 1440,
  },
  "security.requireMfaForAdmins": {
    type: "boolean",
    default: true,
    scopes: ["global"],
  },
} as const satisfies Record<string, SettingKeyDefinition>;

export type SettingKey = keyof typeof SETTING_KEY_REGISTRY;

// Migration path for key changes (SPEC §11.1). The registry is versioned and
// every key change follows these steps so the T-0722 API and operators can
// reason about it:
//
//  1. Add a key — append a definition. Existing rows are unaffected; reads
//     fall back to the declared default until the key is written.
//  2. Change a type — bump SETTINGS_SCHEMA_VERSION, add a db migration that
//     rewrites the affected rows, and record the change in the schema header.
//  3. Rename a key — add the new key and a db migration that copies old rows
//     onto the new key. The old key is then rejected as unknown here.
//  4. Remove a key — reject it in the registry for one release, then drop
//     the row in a later migration.

export type SettingsValidationCode = "settings.unknown_key" | "settings.invalid_value";

export class SettingsValidationError extends Error {
  readonly code: SettingsValidationCode;
  readonly key: string;

  constructor(code: SettingsValidationCode, key: string, message: string) {
    super(message);
    this.name = "SettingsValidationError";
    this.code = code;
    this.key = key;
  }
}

export interface SettingKeyValue {
  key: SettingKey;
  value: SettingValue;
}

function invalid(key: string, message: string): SettingsValidationError {
  return new SettingsValidationError("settings.invalid_value", key, message);
}

export function isSettingKey(key: string): key is SettingKey {
  return Object.prototype.hasOwnProperty.call(SETTING_KEY_REGISTRY, key);
}

export function settingDefinition(key: string): SettingKeyDefinition | undefined {
  return isSettingKey(key) ? SETTING_KEY_REGISTRY[key] : undefined;
}

export function listSettingKeys(): SettingKey[] {
  return Object.keys(SETTING_KEY_REGISTRY) as SettingKey[];
}

export function defaultSettingValue(key: SettingKey): SettingValue {
  return SETTING_KEY_REGISTRY[key].default;
}

export function allowedSettingScopes(key: SettingKey): readonly SettingScope[] {
  return SETTING_KEY_REGISTRY[key].scopes;
}

function assertValueType(
  key: SettingKey,
  value: unknown,
  definition: SettingKeyDefinition,
): asserts value is SettingValue {
  if (definition.type === "boolean") {
    if (typeof value !== "boolean") {
      throw invalid(key, `${key} must be a boolean`);
    }
    return;
  }
  if (definition.type === "number") {
    if (typeof value !== "number" || !Number.isFinite(value)) {
      throw invalid(key, `${key} must be a finite number`);
    }
    if (definition.min !== undefined && value < definition.min) {
      throw invalid(key, `${key} must be at least ${definition.min}`);
    }
    if (definition.max !== undefined && value > definition.max) {
      throw invalid(key, `${key} must be at most ${definition.max}`);
    }
    return;
  }
  if (typeof value !== "string") {
    throw invalid(key, `${key} must be a string`);
  }
  if (definition.maxLength !== undefined && value.length > definition.maxLength) {
    throw invalid(key, `${key} must be at most ${definition.maxLength} characters`);
  }
}

export function parseSettingValue(key: unknown, value: unknown): SettingKeyValue {
  if (typeof key !== "string" || !isSettingKey(key)) {
    throw new SettingsValidationError(
      "settings.unknown_key",
      String(key),
      `unknown setting key ${JSON.stringify(key)}; expected one of ${listSettingKeys().join(", ")}`,
    );
  }
  assertValueType(key, value, SETTING_KEY_REGISTRY[key]);
  return { key, value };
}
