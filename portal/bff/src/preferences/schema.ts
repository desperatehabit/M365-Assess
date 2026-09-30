// UserPreferences schema (EPIC-037 SPEC.md §3.4, §4.3, §5).
// Per-user portal preferences: general table/usage settings, navigation
// bookmarks, theme/density/text scale, and portal links. Validation lives here
// so the T-0726 route and the web localStorage mirror (T-0728) share one typed
// contract; the database stores the validated blob opaquely (migration 0049).
// Unknown keys are rejected at every level so a stale client cannot smuggle
// fields the server does not know how to validate.

export const PREFERENCES_SCHEMA_VERSION = "v1" as const;

export type PreferencesSchemaVersion = typeof PREFERENCES_SCHEMA_VERSION;

export const PREFERENCES_THEMES = ["light", "dark", "system"] as const;
export type PreferencesTheme = (typeof PREFERENCES_THEMES)[number];

export const PREFERENCES_DENSITIES = ["compact", "comfortable"] as const;
export type PreferencesDensity = (typeof PREFERENCES_DENSITIES)[number];

export const PREFERENCES_TABLE_VIEW_MODES = ["table", "card"] as const;
export type PreferencesTableViewMode = (typeof PREFERENCES_TABLE_VIEW_MODES)[number];

export interface PreferencesGeneral {
  usageLocation: string;
  tablePageSize: number;
  tableViewMode: PreferencesTableViewMode;
  defaultTestSuite: string;
  persistFilters: boolean;
}

export interface PreferencesBookmark {
  id: string;
  label: string;
  path: string;
}

export interface PreferencesNavigation {
  bookmarks: PreferencesBookmark[];
  compactNav: boolean;
}

export interface PreferencesAppearance {
  theme: PreferencesTheme;
  density: PreferencesDensity;
  textScale: number;
}

export interface PreferencesPortalLink {
  id: string;
  label: string;
  url: string;
}

export interface PreferencesPortalLinks {
  links: PreferencesPortalLink[];
}

export interface UserPreferences {
  schemaVersion: PreferencesSchemaVersion;
  general: PreferencesGeneral;
  navigation: PreferencesNavigation;
  appearance: PreferencesAppearance;
  portalLinks: PreferencesPortalLinks;
}

export type PreferencesValidationCode = "preferences.invalid";

export class PreferencesValidationError extends Error {
  readonly code: PreferencesValidationCode = "preferences.invalid";
  readonly field: string;

  constructor(field: string, message: string) {
    super(message);
    this.name = "PreferencesValidationError";
    this.field = field;
  }
}

const MAX_USAGE_LOCATION = 64;
const MAX_TEST_SUITE = 120;
const MIN_TABLE_PAGE_SIZE = 1;
const MAX_TABLE_PAGE_SIZE = 500;
const MIN_TEXT_SCALE = 0.75;
const MAX_TEXT_SCALE = 1.5;
const MAX_BOOKMARKS = 50;
const MAX_PORTAL_LINKS = 20;
const MAX_LABEL = 100;
const MAX_BOOKMARK_PATH = 200;
const MAX_PORTAL_URL = 512;

const SLUG = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const SCHEME = /^[a-zA-Z][a-zA-Z0-9+.-]*:/;

const TOP_LEVEL_FIELDS = [
  "schemaVersion",
  "general",
  "navigation",
  "appearance",
  "portalLinks",
] as const;

const GENERAL_FIELDS = [
  "usageLocation",
  "tablePageSize",
  "tableViewMode",
  "defaultTestSuite",
  "persistFilters",
] as const;

const NAVIGATION_FIELDS = ["bookmarks", "compactNav"] as const;
const APPEARANCE_FIELDS = ["theme", "density", "textScale"] as const;
const PORTAL_LINKS_FIELDS = ["links"] as const;
const BOOKMARK_FIELDS = ["id", "label", "path"] as const;
const PORTAL_LINK_FIELDS = ["id", "label", "url"] as const;

export function defaultUserPreferences(): UserPreferences {
  return {
    schemaVersion: PREFERENCES_SCHEMA_VERSION,
    general: {
      usageLocation: "",
      tablePageSize: 25,
      tableViewMode: "table",
      defaultTestSuite: "",
      persistFilters: false,
    },
    navigation: {
      bookmarks: [],
      compactNav: false,
    },
    appearance: {
      theme: "system",
      density: "comfortable",
      textScale: 1,
    },
    portalLinks: {
      links: [],
    },
  };
}

function invalid(field: string, message: string): PreferencesValidationError {
  return new PreferencesValidationError(field, message);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function rejectUnknown(keys: string[], allowed: readonly string[], field: string): void {
  for (const key of keys) {
    if (!allowed.includes(key)) {
      throw invalid(`${field}.${key}`, `${field} has an unknown field '${key}'`);
    }
  }
}

function parseEnum<T extends string>(
  value: unknown,
  allowed: readonly T[],
  field: string,
): T {
  if (typeof value !== "string" || !allowed.includes(value as T)) {
    throw invalid(field, `${field} must be one of ${allowed.join(", ")}`);
  }
  return value as T;
}

function parseBoolean(value: unknown, field: string): boolean {
  if (typeof value !== "boolean") {
    throw invalid(field, `${field} must be a boolean`);
  }
  return value;
}

function parseBoundedString(value: unknown, field: string, max: number): string {
  if (typeof value !== "string" || value.length > max) {
    throw invalid(field, `${field} must be a string of at most ${max} characters`);
  }
  return value;
}

function parseSlug(value: unknown, field: string): string {
  if (typeof value !== "string" || !SLUG.test(value)) {
    throw invalid(field, `${field} must be a slug of letters, digits, '-' or '_'`);
  }
  return value;
}

function parseBookmarkPath(value: unknown, field: string): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > MAX_BOOKMARK_PATH ||
    !value.startsWith("/") ||
    value.includes("..") ||
    /\s/.test(value) ||
    SCHEME.test(value)
  ) {
    throw invalid(field, `${field} must be a relative portal path such as '/dashboard'`);
  }
  return value;
}

function parsePortalUrl(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0 || value.length > MAX_PORTAL_URL) {
    throw invalid(field, `${field} must be a string of at most ${MAX_PORTAL_URL} characters`);
  }
  if (/\s/.test(value) || SCHEME.test(value.replace(/^https?:\/\//i, ""))) {
    throw invalid(field, `${field} must be an absolute http(s) URL`);
  }
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw invalid(field, `${field} must be an absolute http(s) URL`);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw invalid(field, `${field} must be an absolute http(s) URL`);
  }
  return value;
}

function parseGeneral(value: unknown, field: string): PreferencesGeneral {
  if (!isRecord(value)) throw invalid(field, `${field} must be an object`);
  rejectUnknown(Object.keys(value), GENERAL_FIELDS, field);
  const pageSize = value["tablePageSize"];
  if (
    typeof pageSize !== "number" ||
    !Number.isInteger(pageSize) ||
    pageSize < MIN_TABLE_PAGE_SIZE ||
    pageSize > MAX_TABLE_PAGE_SIZE
  ) {
    throw invalid(
      `${field}.tablePageSize`,
      `${field}.tablePageSize must be an integer between ${MIN_TABLE_PAGE_SIZE} and ${MAX_TABLE_PAGE_SIZE}`,
    );
  }
  return {
    usageLocation: parseBoundedString(value["usageLocation"], `${field}.usageLocation`, MAX_USAGE_LOCATION),
    tablePageSize: pageSize,
    tableViewMode: parseEnum(value["tableViewMode"], PREFERENCES_TABLE_VIEW_MODES, `${field}.tableViewMode`),
    defaultTestSuite: parseBoundedString(
      value["defaultTestSuite"],
      `${field}.defaultTestSuite`,
      MAX_TEST_SUITE,
    ),
    persistFilters: parseBoolean(value["persistFilters"], `${field}.persistFilters`),
  };
}

function parseBookmark(value: unknown, field: string): PreferencesBookmark {
  if (!isRecord(value)) throw invalid(field, `${field} must be an object`);
  rejectUnknown(Object.keys(value), BOOKMARK_FIELDS, field);
  return {
    id: parseSlug(value["id"], `${field}.id`),
    label: parseBoundedString(value["label"], `${field}.label`, MAX_LABEL),
    path: parseBookmarkPath(value["path"], `${field}.path`),
  };
}

function parseNavigation(value: unknown, field: string): PreferencesNavigation {
  if (!isRecord(value)) throw invalid(field, `${field} must be an object`);
  rejectUnknown(Object.keys(value), NAVIGATION_FIELDS, field);
  const bookmarks = value["bookmarks"];
  if (!Array.isArray(bookmarks) || bookmarks.length > MAX_BOOKMARKS) {
    throw invalid(`${field}.bookmarks`, `${field}.bookmarks must be an array of at most ${MAX_BOOKMARKS}`);
  }
  return {
    bookmarks: bookmarks.map((entry, index) => parseBookmark(entry, `${field}.bookmarks[${index}]`)),
    compactNav: parseBoolean(value["compactNav"], `${field}.compactNav`),
  };
}

function parseAppearance(value: unknown, field: string): PreferencesAppearance {
  if (!isRecord(value)) throw invalid(field, `${field} must be an object`);
  rejectUnknown(Object.keys(value), APPEARANCE_FIELDS, field);
  const textScale = value["textScale"];
  if (
    typeof textScale !== "number" ||
    !Number.isFinite(textScale) ||
    textScale < MIN_TEXT_SCALE ||
    textScale > MAX_TEXT_SCALE
  ) {
    throw invalid(
      `${field}.textScale`,
      `${field}.textScale must be a number between ${MIN_TEXT_SCALE} and ${MAX_TEXT_SCALE}`,
    );
  }
  return {
    theme: parseEnum(value["theme"], PREFERENCES_THEMES, `${field}.theme`),
    density: parseEnum(value["density"], PREFERENCES_DENSITIES, `${field}.density`),
    textScale,
  };
}

function parsePortalLink(value: unknown, field: string): PreferencesPortalLink {
  if (!isRecord(value)) throw invalid(field, `${field} must be an object`);
  rejectUnknown(Object.keys(value), PORTAL_LINK_FIELDS, field);
  return {
    id: parseSlug(value["id"], `${field}.id`),
    label: parseBoundedString(value["label"], `${field}.label`, MAX_LABEL),
    url: parsePortalUrl(value["url"], `${field}.url`),
  };
}

function parsePortalLinks(value: unknown, field: string): PreferencesPortalLinks {
  if (!isRecord(value)) throw invalid(field, `${field} must be an object`);
  rejectUnknown(Object.keys(value), PORTAL_LINKS_FIELDS, field);
  const links = value["links"];
  if (!Array.isArray(links) || links.length > MAX_PORTAL_LINKS) {
    throw invalid(`${field}.links`, `${field}.links must be an array of at most ${MAX_PORTAL_LINKS}`);
  }
  return {
    links: links.map((entry, index) => parsePortalLink(entry, `${field}.links[${index}]`)),
  };
}

function parseJsonInput(input: string | unknown): unknown {
  if (typeof input !== "string") return input;
  try {
    return JSON.parse(input) as unknown;
  } catch {
    throw invalid("preferences", "Preferences are not valid JSON");
  }
}

export function parseUserPreferences(input: string | unknown): UserPreferences {
  const record = parseJsonInput(input);
  if (!isRecord(record)) throw invalid("preferences", "Preferences must be a JSON object");
  rejectUnknown(Object.keys(record), TOP_LEVEL_FIELDS as unknown as string[], "preferences");

  if (record["schemaVersion"] !== undefined && record["schemaVersion"] !== PREFERENCES_SCHEMA_VERSION) {
    throw invalid(
      "preferences.schemaVersion",
      `Preferences have unsupported schemaVersion ${JSON.stringify(record["schemaVersion"])}; expected ${PREFERENCES_SCHEMA_VERSION}`,
    );
  }

  return {
    schemaVersion: PREFERENCES_SCHEMA_VERSION,
    general: parseGeneral(record["general"], "preferences.general"),
    navigation: parseNavigation(record["navigation"], "preferences.navigation"),
    appearance: parseAppearance(record["appearance"], "preferences.appearance"),
    portalLinks: parsePortalLinks(record["portalLinks"], "preferences.portalLinks"),
  };
}

export function serializeUserPreferences(prefs: UserPreferences): string {
  return JSON.stringify(parseUserPreferences(prefs));
}
