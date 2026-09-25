// Report templates are the builder's saved documents (EPIC-005 SPEC.md §5). The
// v1 block set is fixed to six typed blocks (§11.2) so the renderer and the
// builder UI consume one contract and an unknown or malformed block is rejected
// at the boundary — the mitigation for the §9 "block/data drift" risk.

export const REPORT_SCHEMA_VERSION = "v1" as const;

export type ReportSchemaVersion = typeof REPORT_SCHEMA_VERSION;

export const BLOCK_TYPES = [
  "chart",
  "score-cards",
  "progress-bars",
  "section-divider",
  "page-break",
  "rich-text",
] as const;

export type BlockType = (typeof BLOCK_TYPES)[number];

// A live block may only bind to the five entities resolved by the worker
// (§11.3): anything else is rejected rather than silently rendering empty.
export const BINDABLE_ENTITIES = [
  "run-summary",
  "findings",
  "compliance",
  "secure-score",
  "licenses",
] as const;

export type BindableEntity = (typeof BINDABLE_ENTITIES)[number];

export const CHART_KINDS = ["bar", "line", "area", "pie", "donut"] as const;

export type ChartKind = (typeof CHART_KINDS)[number];

export const PAGE_SIZES = ["A4", "Letter", "Legal"] as const;

export type PageSize = (typeof PAGE_SIZES)[number];

export const PAGE_ORIENTATIONS = ["portrait", "landscape"] as const;

export type PageOrientation = (typeof PAGE_ORIENTATIONS)[number];

// `static` on the block says whether it renders captured/authored content or
// live data; the descriptor records which entity a live block (or a captured
// snapshot reverted from one) came from.
export interface DataBindingDescriptor {
  entity: BindableEntity;
  field?: string;
}

export interface ChartBlockSettings {
  chartKind: ChartKind;
  series?: string[];
}

export interface ScoreCardsBlockSettings {
  metrics: string[];
  columns?: number;
}

export interface ProgressBarsBlockSettings {
  metrics: string[];
  showPercentages?: boolean;
}

export interface SectionDividerBlockSettings {
  eyebrow?: string;
}

export type PageBreakBlockSettings = Record<string, never>;

export interface RichTextBlockSettings {
  body: string;
}

export interface BaseReportBlock {
  id: string;
  title: string;
  static: boolean;
  dataBinding?: DataBindingDescriptor;
}

export interface ChartBlock extends BaseReportBlock {
  type: "chart";
  settings: ChartBlockSettings;
}

export interface ScoreCardsBlock extends BaseReportBlock {
  type: "score-cards";
  settings: ScoreCardsBlockSettings;
}

export interface ProgressBarsBlock extends BaseReportBlock {
  type: "progress-bars";
  settings: ProgressBarsBlockSettings;
}

export interface SectionDividerBlock extends BaseReportBlock {
  type: "section-divider";
  settings: SectionDividerBlockSettings;
}

export interface PageBreakBlock extends BaseReportBlock {
  type: "page-break";
  settings: PageBreakBlockSettings;
}

export interface RichTextBlock extends BaseReportBlock {
  type: "rich-text";
  settings: RichTextBlockSettings;
}

export type ReportBlock =
  | ChartBlock
  | ScoreCardsBlock
  | ProgressBarsBlock
  | SectionDividerBlock
  | PageBreakBlock
  | RichTextBlock;

export interface ReportSettings {
  title: string;
  subtitle?: string;
  redact: boolean;
}

export interface PageSetup {
  pageSize: PageSize;
  orientation: PageOrientation;
  marginMm: number;
  headerText?: string;
  footerText?: string;
}

// Per-report overrides of the instance BrandingConfig (EPIC-037); absent
// fields fall back to the configured branding at render time.
export interface BrandingOverrides {
  primaryColor?: string;
  secondaryColor?: string;
  logoRef?: string;
  watermarkText?: string;
  footerText?: string;
  showPageNumbers?: boolean;
}

export interface ReportTemplate {
  schemaVersion: ReportSchemaVersion;
  id: string;
  name: string;
  blocks: ReportBlock[];
  settings: ReportSettings;
  pageSetup: PageSetup;
  brandingOverrides?: BrandingOverrides;
}

export class ReportValidationError extends Error {
  readonly code: string;
  readonly path: string | undefined;

  constructor(code: string, message: string, path?: string) {
    super(message);
    this.name = "ReportValidationError";
    this.code = code;
    this.path = path;
  }
}

type UnknownRecord = Record<string, unknown>;

export function serializeReportTemplate(template: ReportTemplate): string {
  return JSON.stringify(template);
}

export function parseReportTemplate(input: string | unknown): ReportTemplate {
  const record = asRecord(input, "Report template", "template");
  if (record.schemaVersion !== REPORT_SCHEMA_VERSION) {
    throw new ReportValidationError(
      "report.unsupported_schema_version",
      `Report template has unsupported schemaVersion ${JSON.stringify(record.schemaVersion)}; expected ${REPORT_SCHEMA_VERSION}`,
      "template.schemaVersion",
    );
  }
  assertString(record, "id", "template");
  assertString(record, "name", "template");
  assertReportSettings(record.settings, "template.settings");
  assertPageSetup(record.pageSetup, "template.pageSetup");
  assertBrandingOverrides(record.brandingOverrides, "template.brandingOverrides");
  if (!Array.isArray(record.blocks)) {
    throw invalid("Report template is missing required array field 'blocks'", "template.blocks");
  }
  for (const [index, block] of record.blocks.entries()) {
    parseReportBlock(block, `template.blocks[${index}]`);
  }
  return record as unknown as ReportTemplate;
}

export function parseReportBlock(input: unknown, path = "block"): ReportBlock {
  const record = asRecord(input, "Report block", path);
  assertString(record, "id", path);
  assertString(record, "title", path);
  if (typeof record.static !== "boolean") {
    throw invalid(`Report block is missing required boolean field 'static'`, `${path}.static`);
  }
  if (typeof record.type !== "string" || !isBlockType(record.type)) {
    throw new ReportValidationError(
      "report.unknown_block_type",
      `${path} has unknown block type ${JSON.stringify(record.type)}`,
      `${path}.type`,
    );
  }
  assertDataBinding(record, path);
  assertBlockSettings(record.settings, record.type, `${path}.settings`);
  return record as unknown as ReportBlock;
}

export function isBlockType(value: unknown): value is BlockType {
  return typeof value === "string" && (BLOCK_TYPES as readonly string[]).includes(value);
}

export function isBindableEntity(value: unknown): value is BindableEntity {
  return (
    typeof value === "string" && (BINDABLE_ENTITIES as readonly string[]).includes(value)
  );
}

function assertDataBinding(record: UnknownRecord, path: string): void {
  const binding = record.dataBinding;
  if (binding === undefined || binding === null) {
    if (record.static !== true) {
      throw new ReportValidationError(
        "report.missing_binding",
        `${path} is a live block and requires a dataBinding`,
        `${path}.dataBinding`,
      );
    }
    return;
  }
  const descriptor = asRecord(binding, "Data binding", `${path}.dataBinding`);
  if (!isBindableEntity(descriptor.entity)) {
    throw new ReportValidationError(
      "report.unknown_binding",
      `${path} has unknown dataBinding entity ${JSON.stringify(descriptor.entity)}`,
      `${path}.dataBinding.entity`,
    );
  }
  if (descriptor.field !== undefined) {
    assertString(descriptor, "field", `${path}.dataBinding`);
  }
}

function assertBlockSettings(
  value: unknown,
  type: BlockType,
  path: string,
): void {
  const settings = asRecord(value, "Block settings", path);
  switch (type) {
    case "chart":
      assertEnum(settings, "chartKind", CHART_KINDS, path);
      if (settings.series !== undefined) {
        assertStringArray(settings, "series", path, false, "report.invalid_settings");
      }
      return;
    case "score-cards":
    case "progress-bars":
      assertStringArray(settings, "metrics", path, true, "report.invalid_settings");
      return;
    case "rich-text":
      assertString(settings, "body", path, "report.invalid_settings");
      return;
    case "section-divider":
    case "page-break":
      return;
  }
}

function assertReportSettings(value: unknown, path: string): void {
  const settings = asRecord(value, "Report settings", path);
  assertString(settings, "title", path);
  if (settings.subtitle !== undefined) {
    assertString(settings, "subtitle", path);
  }
  if (typeof settings.redact !== "boolean") {
    throw invalid(`Report settings is missing required boolean field 'redact'`, `${path}.redact`);
  }
}

function assertPageSetup(value: unknown, path: string): void {
  const pageSetup = asRecord(value, "Page setup", path);
  assertEnum(pageSetup, "pageSize", PAGE_SIZES, path);
  assertEnum(pageSetup, "orientation", PAGE_ORIENTATIONS, path);
  if (typeof pageSetup.marginMm !== "number" || !Number.isFinite(pageSetup.marginMm) || pageSetup.marginMm < 0) {
    throw invalid(
      `Page setup is missing required non-negative number field 'marginMm'`,
      `${path}.marginMm`,
    );
  }
  for (const field of ["headerText", "footerText"]) {
    if (pageSetup[field] !== undefined) {
      assertString(pageSetup, field, path);
    }
  }
}

function assertBrandingOverrides(value: unknown, path: string): void {
  if (value === undefined) {
    return;
  }
  const overrides = asRecord(value, "Branding overrides", path);
  for (const field of ["primaryColor", "secondaryColor", "logoRef", "watermarkText", "footerText"]) {
    if (overrides[field] !== undefined) {
      assertString(overrides, field, path);
    }
  }
  if (overrides.showPageNumbers !== undefined && typeof overrides.showPageNumbers !== "boolean") {
    throw invalid(`Branding overrides field 'showPageNumbers' must be a boolean`, `${path}.showPageNumbers`);
  }
}

function asRecord(value: unknown, kind: string, path: string): UnknownRecord {
  const parsed = typeof value === "string" ? parseJson(value, kind, path) : value;
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw invalid(`${kind} must be a JSON object`, path);
  }
  return parsed as UnknownRecord;
}

function parseJson(value: string, kind: string, path: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    throw new ReportValidationError(
      "report.invalid_json",
      `${kind} is not valid JSON`,
      path,
    );
  }
}

function assertString(
  record: UnknownRecord,
  field: string,
  path: string,
  code = "report.invalid",
): void {
  const value = record[field];
  if (typeof value !== "string" || value.length === 0) {
    throw new ReportValidationError(
      code,
      `Missing required string field '${field}'`,
      `${path}.${field}`,
    );
  }
}

function assertStringArray(
  record: UnknownRecord,
  field: string,
  path: string,
  requireNonEmpty: boolean,
  code = "report.invalid",
): void {
  const value = record[field];
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new ReportValidationError(
      code,
      `Missing required string array field '${field}'`,
      `${path}.${field}`,
    );
  }
  if (requireNonEmpty && value.length === 0) {
    throw new ReportValidationError(
      code,
      `Field '${field}' must contain at least one entry`,
      `${path}.${field}`,
    );
  }
}

function assertEnum<T extends string>(
  record: UnknownRecord,
  field: string,
  allowed: readonly T[],
  path: string,
): void {
  const value = record[field];
  if (typeof value !== "string" || !(allowed as readonly string[]).includes(value)) {
    throw new ReportValidationError(
      "report.invalid_settings",
      `Field '${field}' must be one of ${allowed.join(", ")}; got ${JSON.stringify(value)}`,
      `${path}.${field}`,
    );
  }
}

function invalid(message: string, path: string): ReportValidationError {
  return new ReportValidationError("report.invalid", message, path);
}
