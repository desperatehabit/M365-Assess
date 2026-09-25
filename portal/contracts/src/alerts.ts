// Normalized alert model (EPIC-028 SPEC.md §3.3, §9 risk, §11.2). Defender,
// Defender for Office 365 (MDO), and Graph security alerts have diverging raw
// shapes; the alert list and detail views consume this single shape instead, so
// each source maps onto the contract here and an unmappable shape is rejected
// at the boundary rather than silently coerced into an empty row. Types only —
// no HTTP or worker behavior lives in this module.

export const ALERT_SCHEMA_VERSION = "v1" as const;

export type AlertSchemaVersion = typeof ALERT_SCHEMA_VERSION;

export const ALERT_SOURCES = ["defender", "mdo", "graph"] as const;

export type AlertSource = (typeof ALERT_SOURCES)[number];

export const ALERT_SEVERITIES = [
  "unknown",
  "informational",
  "low",
  "medium",
  "high",
] as const;

export type AlertSeverity = (typeof ALERT_SEVERITIES)[number];

export const ALERT_STATUSES = ["unknown", "new", "inProgress", "resolved"] as const;

export type AlertStatus = (typeof ALERT_STATUSES)[number];

export const ALERT_ENTITY_KINDS = [
  "user",
  "device",
  "mailbox",
  "ip",
  "file",
  "url",
  "process",
  "unknown",
] as const;

export type AlertEntityKind = (typeof ALERT_ENTITY_KINDS)[number];

export interface AlertEntity {
  kind: AlertEntityKind;
  id?: string;
  displayName?: string;
}

export interface NormalizedAlert {
  schemaVersion: AlertSchemaVersion;
  id: string;
  source: AlertSource;
  title: string;
  severity: AlertSeverity;
  status: AlertStatus;
  entity: AlertEntity | null;
  created: string;
  incidentId: string | null;
  passthrough: Record<string, unknown>;
}

export class AlertValidationError extends Error {
  readonly code: string;
  readonly path: string | undefined;

  constructor(code: string, message: string, path?: string) {
    super(message);
    this.name = "AlertValidationError";
    this.code = code;
    this.path = path;
  }
}

type UnknownRecord = Record<string, unknown>;

// Fields consumed into the canonical model; everything else survives in
// `passthrough` so a source-specific field is never dropped.
const CONSUMED_KEYS = new Set([
  "id",
  "title",
  "severity",
  "status",
  "createdDateTime",
  "incidentId",
  "actorDisplayName",
  "evidence",
  "@odata.type",
]);

const SEVERITY_BY_KEY: Record<string, AlertSeverity> = {
  unknown: "unknown",
  informational: "informational",
  low: "low",
  medium: "medium",
  high: "high",
};

const STATUS_BY_KEY: Record<string, AlertStatus> = {
  unknown: "unknown",
  new: "new",
  inprogress: "inProgress",
  resolved: "resolved",
};

export function isAlertSource(value: unknown): value is AlertSource {
  return typeof value === "string" && (ALERT_SOURCES as readonly string[]).includes(value);
}

export function normalizeDefenderAlert(input: string | unknown): NormalizedAlert {
  return normalizeAlert(input, "defender");
}

export function normalizeMdoAlert(input: string | unknown): NormalizedAlert {
  return normalizeAlert(input, "mdo");
}

export function normalizeGraphAlert(input: string | unknown): NormalizedAlert {
  return normalizeAlert(input, "graph");
}

export function normalizeAlert(input: string | unknown, source: AlertSource): NormalizedAlert {
  if (!isAlertSource(source)) {
    throw new AlertValidationError(
      "alert.unknown_source",
      `Alert has unknown source ${JSON.stringify(source)}; expected one of ${ALERT_SOURCES.join(", ")}`,
      "source",
    );
  }
  const record = asRecord(input, source);
  const id = requireString(record, "id", source);
  const title = requireString(record, "title", source);
  const created = requireString(record, "createdDateTime", source);
  return {
    schemaVersion: ALERT_SCHEMA_VERSION,
    id,
    source,
    title,
    severity: normalizeEnum("severity", record.severity, SEVERITY_BY_KEY, source),
    status: normalizeEnum("status", record.status, STATUS_BY_KEY, source),
    entity: mapEntity(record),
    created,
    incidentId: optionalString(record.incidentId),
    passthrough: collectPassthrough(record),
  };
}

export function validateAlert(input: string | unknown): NormalizedAlert {
  const record = asRecord(input, "alert");
  if (record.schemaVersion !== ALERT_SCHEMA_VERSION) {
    throw new AlertValidationError(
      "alert.unsupported_schema_version",
      `Alert has unsupported schemaVersion ${JSON.stringify(record.schemaVersion)}; expected ${ALERT_SCHEMA_VERSION}`,
      "alert.schemaVersion",
    );
  }
  requireString(record, "id", "alert");
  requireString(record, "title", "alert");
  requireString(record, "created", "alert");
  if (!isAlertSource(record.source)) {
    throw new AlertValidationError(
      "alert.unknown_source",
      `Alert has unknown source ${JSON.stringify(record.source)}`,
      "alert.source",
    );
  }
  normalizeEnum("severity", record.severity, SEVERITY_BY_KEY, "alert");
  normalizeEnum("status", record.status, STATUS_BY_KEY, "alert");
  if (record.incidentId !== null && typeof record.incidentId !== "string") {
    throw invalid("Alert field 'incidentId' must be a string or null", "alert.incidentId");
  }
  const entity = record.entity;
  if (entity !== null) {
    const entityRecord = asRecord(entity, "alert.entity");
    if (
      typeof entityRecord.kind !== "string" ||
      !(ALERT_ENTITY_KINDS as readonly string[]).includes(entityRecord.kind)
    ) {
      throw new AlertValidationError(
        "alert.invalid",
        `Alert entity has unknown kind ${JSON.stringify(entityRecord.kind)}`,
        "alert.entity.kind",
      );
    }
  }
  const passthrough = record.passthrough;
  if (typeof passthrough !== "object" || passthrough === null || Array.isArray(passthrough)) {
    throw invalid("Alert field 'passthrough' must be an object", "alert.passthrough");
  }
  return record as unknown as NormalizedAlert;
}

export function isNormalizedAlert(value: unknown): value is NormalizedAlert {
  try {
    validateAlert(value);
    return true;
  } catch {
    return false;
  }
}

function normalizeEnum<T extends string>(
  field: string,
  value: unknown,
  table: Record<string, T>,
  source: string,
): T {
  const mapped = typeof value === "string" ? table[value.toLowerCase()] : undefined;
  if (mapped === undefined) {
    throw new AlertValidationError(
      "alert.unmappable_source",
      `Alert has unmappable ${field} ${JSON.stringify(value)}`,
      `${source}.${field}`,
    );
  }
  return mapped;
}

function mapEntity(record: UnknownRecord): AlertEntity | null {
  const evidence = record.evidence;
  if (Array.isArray(evidence)) {
    for (const item of evidence) {
      if (item === null || typeof item !== "object" || Array.isArray(item)) {
        continue;
      }
      const entity = mapEvidence(item as UnknownRecord);
      if (entity !== null) {
        return entity;
      }
    }
  }
  const actor = optionalString(record.actorDisplayName);
  if (actor !== null) {
    return { kind: "unknown", displayName: actor };
  }
  return null;
}

function mapEvidence(item: UnknownRecord): AlertEntity | null {
  const type = pickString(item, "@odata.type", "evidenceType", "type");
  const kind = entityKindFromType(type);
  if (kind === null) {
    return null;
  }
  switch (kind) {
    case "user": {
      const account = asOptionalRecord(item.userAccount);
      const displayName = pickString(account ?? item, "displayName", "accountName", "userPrincipalName");
      const id = pickString(account ?? item, "azureAdUserId", "accountName", "userPrincipalName");
      return entity(kind, displayName, id);
    }
    case "device":
      return entity(
        kind,
        pickString(item, "deviceDnsName", "displayName"),
        pickString(item, "mdeDeviceId", "azureAdDeviceId", "deviceId"),
      );
    case "mailbox":
      return entity(
        kind,
        pickString(item, "primaryAddress", "mailboxPrimaryAddress", "displayName"),
        pickString(item, "primaryAddress", "mailboxPrimaryAddress"),
      );
    case "ip":
      return entity(kind, pickString(item, "ipAddress", "address"), null);
    case "file":
      return entity(kind, pickString(item, "fileName", "displayName"), pickString(item, "fileHash", "sha256", "filePath"));
    case "url":
      return entity(kind, pickString(item, "url", "displayName"), null);
    case "process":
      return entity(kind, pickString(item, "processFilePath", "displayName"), pickString(item, "processId"));
    default:
      return { kind };
  }
}

function entity(kind: AlertEntityKind, displayName: string | null, id: string | null): AlertEntity {
  const result: AlertEntity = { kind };
  if (displayName !== null) {
    result.displayName = displayName;
  }
  if (id !== null) {
    result.id = id;
  }
  return result;
}

function entityKindFromType(type: string | null): AlertEntityKind | null {
  if (type === null) {
    return null;
  }
  const normalized = type.toLowerCase();
  if (normalized.includes("user")) {
    return "user";
  }
  if (normalized.includes("device")) {
    return "device";
  }
  if (normalized.includes("mailbox")) {
    return "mailbox";
  }
  if (normalized.includes("process")) {
    return "process";
  }
  if (normalized.includes("url")) {
    return "url";
  }
  if (normalized.includes("file")) {
    return "file";
  }
  if (normalized.includes("ip")) {
    return "ip";
  }
  return null;
}

function collectPassthrough(record: UnknownRecord): Record<string, unknown> {
  const passthrough: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(record)) {
    if (!CONSUMED_KEYS.has(key)) {
      passthrough[key] = value;
    }
  }
  return passthrough;
}

function asRecord(input: string | unknown, source: string): UnknownRecord {
  const value = typeof input === "string" ? parseJson(input, source) : input;
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw invalid(`${source} alert must be a JSON object`, source);
  }
  return value as UnknownRecord;
}

function asOptionalRecord(value: unknown): UnknownRecord | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as UnknownRecord)
    : null;
}

function parseJson(input: string, source: string): unknown {
  try {
    return JSON.parse(input);
  } catch {
    throw new AlertValidationError(
      "alert.invalid_json",
      `${source} alert is not valid JSON`,
      source,
    );
  }
}

function requireString(record: UnknownRecord, field: string, path: string): string {
  const value = record[field];
  if (typeof value !== "string" || value.length === 0) {
    throw new AlertValidationError(
      "alert.unmappable_source",
      `Alert is missing required string field '${field}'`,
      `${path}.${field}`,
    );
  }
  return value;
}

function optionalString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function pickString(record: UnknownRecord, ...fields: string[]): string | null {
  for (const field of fields) {
    const value = record[field];
    if (typeof value === "string" && value.length > 0) {
      return value;
    }
  }
  return null;
}

function invalid(message: string, path: string): AlertValidationError {
  return new AlertValidationError("alert.invalid", message, path);
}
