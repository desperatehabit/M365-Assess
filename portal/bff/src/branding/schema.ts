// BrandingConfig schema (EPIC-037 SPEC.md §3.2, §5; ADR-0016).
// The instance branding applied at render time by EPIC-005 report rendering:
// colours, logo/cover asset references, watermark, footer, page numbers,
// presets, and per-report-type defaults. Validation lives here so the T-0724
// route and the repository share one typed contract. Asset bytes never appear
// here: logoRef/coverRef are relative artifact-tier references only.

export const BRANDING_SCHEMA_VERSION = "v1" as const;

export type BrandingSchemaVersion = typeof BRANDING_SCHEMA_VERSION;

export interface BrandingColors {
  primary: string;
  secondary: string;
}

export interface BrandingWatermark {
  enabled: boolean;
  text: string;
}

export interface BrandingFooter {
  show: boolean;
  text: string;
  coverText: string;
}

export interface BrandingPageNumbers {
  show: boolean;
}

export interface BrandingPreset {
  id: string;
  name: string;
  colors: BrandingColors;
}

export interface BrandingReportDefaults {
  primary?: string;
  secondary?: string;
  logoRef?: string | null;
  watermarkText?: string;
  footerText?: string;
  showPageNumbers?: boolean;
}

export interface BrandingConfig {
  schemaVersion: BrandingSchemaVersion;
  colors: BrandingColors;
  logoRef: string | null;
  coverRef: string | null;
  watermark: BrandingWatermark;
  footer: BrandingFooter;
  pageNumbers: BrandingPageNumbers;
  presets: BrandingPreset[];
  perReportDefaults: Record<string, BrandingReportDefaults>;
}

export type BrandingValidationCode = "branding.invalid";

export class BrandingValidationError extends Error {
  readonly code: BrandingValidationCode = "branding.invalid";
  readonly field: string;

  constructor(field: string, message: string) {
    super(message);
    this.name = "BrandingValidationError";
    this.field = field;
  }
}

const HEX_COLOR = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;
const ASSET_REF = /^[A-Za-z0-9][A-Za-z0-9._/-]*\.(png|jpe?g|webp)$/;
const SCHEME = /^[a-zA-Z][a-zA-Z0-9+.-]*:/;
const PRESET_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

const MAX_PRESETS = 20;
const MAX_REPORT_DEFAULTS = 32;
const MAX_WATERMARK_TEXT = 120;
const MAX_FOOTER_TEXT = 500;
const MAX_PRESET_NAME = 100;
const MAX_ASSET_REF = 512;

const TOP_LEVEL_FIELDS = [
  "schemaVersion",
  "colors",
  "logoRef",
  "coverRef",
  "watermark",
  "footer",
  "pageNumbers",
  "presets",
  "perReportDefaults",
] as const;

export function defaultBrandingConfig(): BrandingConfig {
  return {
    schemaVersion: BRANDING_SCHEMA_VERSION,
    colors: { primary: "#1B4F72", secondary: "#2E86C1" },
    logoRef: null,
    coverRef: null,
    watermark: { enabled: false, text: "" },
    footer: { show: true, text: "", coverText: "" },
    pageNumbers: { show: true },
    presets: [],
    perReportDefaults: {},
  };
}

function invalid(field: string, message: string): BrandingValidationError {
  return new BrandingValidationError(field, message);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseColor(value: unknown, field: string): string {
  if (typeof value !== "string" || !HEX_COLOR.test(value)) {
    throw invalid(field, `${field} must be a hex colour such as '#1B4F72'`);
  }
  return value;
}

function parseAssetRef(value: unknown, field: string): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== "string" || value.length === 0 || value.length > MAX_ASSET_REF) {
    throw invalid(field, `${field} must be a relative asset reference`);
  }
  if (
    value.includes("..") ||
    value.startsWith("/") ||
    value.includes("\\") ||
    /\s/.test(value) ||
    SCHEME.test(value) ||
    !ASSET_REF.test(value)
  ) {
    throw invalid(
      field,
      `${field} must be a relative raster asset reference such as 'branding/logo.png'`,
    );
  }
  return value;
}

function parseColors(value: unknown, field: string): BrandingColors {
  if (!isRecord(value)) throw invalid(field, `${field} must be an object`);
  rejectUnknown(Object.keys(value), ["primary", "secondary"], field);
  return {
    primary: parseColor(value["primary"], `${field}.primary`),
    secondary: parseColor(value["secondary"], `${field}.secondary`),
  };
}

function parseWatermark(value: unknown, field: string): BrandingWatermark {
  if (!isRecord(value)) throw invalid(field, `${field} must be an object`);
  rejectUnknown(Object.keys(value), ["enabled", "text"], field);
  if (typeof value["enabled"] !== "boolean") {
    throw invalid(`${field}.enabled`, `${field}.enabled must be a boolean`);
  }
  if (typeof value["text"] !== "string" || value["text"].length > MAX_WATERMARK_TEXT) {
    throw invalid(
      `${field}.text`,
      `${field}.text must be a string of at most ${MAX_WATERMARK_TEXT} characters`,
    );
  }
  if (value["enabled"] === true && value["text"].length === 0) {
    throw invalid(`${field}.text`, `${field}.text must be non-empty when the watermark is enabled`);
  }
  return { enabled: value["enabled"], text: value["text"] };
}

function parseFooter(value: unknown, field: string): BrandingFooter {
  if (!isRecord(value)) throw invalid(field, `${field} must be an object`);
  rejectUnknown(Object.keys(value), ["show", "text", "coverText"], field);
  if (typeof value["show"] !== "boolean") {
    throw invalid(`${field}.show`, `${field}.show must be a boolean`);
  }
  for (const key of ["text", "coverText"] as const) {
    const text = value[key];
    if (typeof text !== "string" || text.length > MAX_FOOTER_TEXT) {
      throw invalid(
        `${field}.${key}`,
        `${field}.${key} must be a string of at most ${MAX_FOOTER_TEXT} characters`,
      );
    }
  }
  return {
    show: value["show"] as boolean,
    text: value["text"] as string,
    coverText: value["coverText"] as string,
  };
}

function parsePageNumbers(value: unknown, field: string): BrandingPageNumbers {
  if (!isRecord(value)) throw invalid(field, `${field} must be an object`);
  rejectUnknown(Object.keys(value), ["show"], field);
  if (typeof value["show"] !== "boolean") {
    throw invalid(`${field}.show`, `${field}.show must be a boolean`);
  }
  return { show: value["show"] };
}

function parsePreset(value: unknown, field: string): BrandingPreset {
  if (!isRecord(value)) throw invalid(field, `${field} must be an object`);
  rejectUnknown(Object.keys(value), ["id", "name", "colors"], field);
  const id = value["id"];
  if (typeof id !== "string" || !PRESET_ID.test(id)) {
    throw invalid(`${field}.id`, `${field}.id must be a slug of letters, digits, '-' or '_'`);
  }
  const name = value["name"];
  if (typeof name !== "string" || name.length === 0 || name.length > MAX_PRESET_NAME) {
    throw invalid(
      `${field}.name`,
      `${field}.name must be a non-empty string of at most ${MAX_PRESET_NAME} characters`,
    );
  }
  return { id, name, colors: parseColors(value["colors"], `${field}.colors`) };
}

function parseReportDefaults(value: unknown, field: string): BrandingReportDefaults {
  if (!isRecord(value)) throw invalid(field, `${field} must be an object`);
  rejectUnknown(
    Object.keys(value),
    ["primary", "secondary", "logoRef", "watermarkText", "footerText", "showPageNumbers"],
    field,
  );
  const parsed: BrandingReportDefaults = {};
  if (value["primary"] !== undefined) parsed.primary = parseColor(value["primary"], `${field}.primary`);
  if (value["secondary"] !== undefined) {
    parsed.secondary = parseColor(value["secondary"], `${field}.secondary`);
  }
  if (value["logoRef"] !== undefined) parsed.logoRef = parseAssetRef(value["logoRef"], `${field}.logoRef`);
  if (value["watermarkText"] !== undefined) {
    if (typeof value["watermarkText"] !== "string" || value["watermarkText"].length > MAX_WATERMARK_TEXT) {
      throw invalid(
        `${field}.watermarkText`,
        `${field}.watermarkText must be a string of at most ${MAX_WATERMARK_TEXT} characters`,
      );
    }
    parsed.watermarkText = value["watermarkText"];
  }
  if (value["footerText"] !== undefined) {
    if (typeof value["footerText"] !== "string" || value["footerText"].length > MAX_FOOTER_TEXT) {
      throw invalid(
        `${field}.footerText`,
        `${field}.footerText must be a string of at most ${MAX_FOOTER_TEXT} characters`,
      );
    }
    parsed.footerText = value["footerText"];
  }
  if (value["showPageNumbers"] !== undefined) {
    if (typeof value["showPageNumbers"] !== "boolean") {
      throw invalid(`${field}.showPageNumbers`, `${field}.showPageNumbers must be a boolean`);
    }
    parsed.showPageNumbers = value["showPageNumbers"];
  }
  return parsed;
}

function rejectUnknown(keys: string[], allowed: readonly string[], field: string): void {
  for (const key of keys) {
    if (!allowed.includes(key)) {
      throw invalid(`${field}.${key}`, `${field} has an unknown field '${key}'`);
    }
  }
}

function parseJsonInput(input: string | unknown): unknown {
  if (typeof input !== "string") return input;
  try {
    return JSON.parse(input) as unknown;
  } catch {
    throw invalid("branding", "Branding config is not valid JSON");
  }
}

export function parseBrandingConfig(input: string | unknown): BrandingConfig {
  const record = parseJsonInput(input);
  if (!isRecord(record)) throw invalid("branding", "Branding config must be a JSON object");
  rejectUnknown(Object.keys(record), TOP_LEVEL_FIELDS as unknown as string[], "branding");

  if (record["schemaVersion"] !== undefined && record["schemaVersion"] !== BRANDING_SCHEMA_VERSION) {
    throw invalid(
      "branding.schemaVersion",
      `Branding config has unsupported schemaVersion ${JSON.stringify(record["schemaVersion"])}; expected ${BRANDING_SCHEMA_VERSION}`,
    );
  }

  const presetsInput = record["presets"] ?? [];
  if (!Array.isArray(presetsInput) || presetsInput.length > MAX_PRESETS) {
    throw invalid("branding.presets", `branding.presets must be an array of at most ${MAX_PRESETS}`);
  }
  const presets = presetsInput.map((entry, index) => parsePreset(entry, `branding.presets[${index}]`));
  const seen = new Set<string>();
  for (const preset of presets) {
    if (seen.has(preset.id)) {
      throw invalid("branding.presets", `branding.presets has a duplicate id '${preset.id}'`);
    }
    seen.add(preset.id);
  }

  const defaultsInput = record["perReportDefaults"] ?? {};
  if (!isRecord(defaultsInput) || Object.keys(defaultsInput).length > MAX_REPORT_DEFAULTS) {
    throw invalid(
      "branding.perReportDefaults",
      `branding.perReportDefaults must be an object of at most ${MAX_REPORT_DEFAULTS} entries`,
    );
  }
  const perReportDefaults: Record<string, BrandingReportDefaults> = {};
  for (const [kind, entry] of Object.entries(defaultsInput)) {
    if (kind.length === 0) {
      throw invalid("branding.perReportDefaults", "branding.perReportDefaults has an empty report kind");
    }
    perReportDefaults[kind] = parseReportDefaults(entry, `branding.perReportDefaults.${kind}`);
  }

  return {
    schemaVersion: BRANDING_SCHEMA_VERSION,
    colors: parseColors(record["colors"], "branding.colors"),
    logoRef: parseAssetRef(record["logoRef"] ?? null, "branding.logoRef"),
    coverRef: parseAssetRef(record["coverRef"] ?? null, "branding.coverRef"),
    watermark: parseWatermark(record["watermark"], "branding.watermark"),
    footer: parseFooter(record["footer"], "branding.footer"),
    pageNumbers: parsePageNumbers(record["pageNumbers"], "branding.pageNumbers"),
    presets,
    perReportDefaults,
  };
}

export function serializeBrandingConfig(config: BrandingConfig): string {
  return JSON.stringify(parseBrandingConfig(config));
}
