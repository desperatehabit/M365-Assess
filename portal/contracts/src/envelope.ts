// The BFF and PowerShell workers communicate over these plain-JSON envelopes.
// Per ADR-0014 they carry references (paths, ids, credential handles), never
// secrets or blobs, so the boundary stays small and serializable.

export const ENVELOPE_SCHEMA_VERSION = "v1" as const;

export type EnvelopeSchemaVersion = typeof ENVELOPE_SCHEMA_VERSION;

export const JOB_TYPES = [
  "assessment",
  "standards",
  "drift",
  "baseline",
  "backup",
  "remediation",
  "report",
] as const;

export type JobType = (typeof JOB_TYPES)[number];

export const RESULT_STATUSES = ["succeeded", "failed", "cancelled"] as const;

export type ResultStatus = (typeof RESULT_STATUSES)[number];

export interface JobPayload {
  contextRef: string;
  outputRef: string;
  credentialRef: string;
  sectionRefs: string[];
  artifactRefs: string[];
}

export interface JobEnvelope {
  schemaVersion: EnvelopeSchemaVersion;
  jobId: string;
  jobType: JobType;
  tenantId: string;
  runId: string;
  requestId: string;
  correlationId: string;
  createdAt: string;
  payload: JobPayload;
}

export interface ResultSummary {
  total: number;
  byStatus: Record<string, number>;
}

export interface EnvelopeError {
  code: string;
  message: string;
  retryable: boolean;
  details?: Record<string, unknown>;
}

export interface ResultEnvelope {
  schemaVersion: EnvelopeSchemaVersion;
  jobId: string;
  jobType: JobType;
  tenantId: string;
  runId: string;
  requestId: string;
  correlationId: string;
  status: ResultStatus;
  startedAt: string;
  finishedAt: string;
  exitCode: number;
  artifactRefs: string[];
  summary?: ResultSummary;
  error?: EnvelopeError;
}

export class EnvelopeValidationError extends Error {
  readonly code: string;
  readonly schemaVersion: unknown;

  constructor(code: string, message: string, schemaVersion: unknown) {
    super(message);
    this.name = "EnvelopeValidationError";
    this.code = code;
    this.schemaVersion = schemaVersion;
  }
}

type UnknownRecord = Record<string, unknown>;

const JOB_REQUIRED_STRINGS = [
  "jobId",
  "tenantId",
  "runId",
  "requestId",
  "correlationId",
  "createdAt",
] as const;

const RESULT_REQUIRED_STRINGS = [
  "jobId",
  "tenantId",
  "runId",
  "requestId",
  "correlationId",
  "startedAt",
  "finishedAt",
] as const;

export function serializeEnvelope(envelope: JobEnvelope | ResultEnvelope): string {
  return JSON.stringify(envelope);
}

export function parseJobEnvelope(input: string | unknown): JobEnvelope {
  const record = asRecord(input, "Job");
  assertSchemaVersion(record.schemaVersion, "Job");
  for (const field of JOB_REQUIRED_STRINGS) {
    assertStringField(record, field, "Job");
  }
  assertJobType(record.jobType, "Job");
  assertReferencePayload(record.payload);
  return record as unknown as JobEnvelope;
}

export function parseResultEnvelope(input: string | unknown): ResultEnvelope {
  const record = asRecord(input, "Result");
  assertSchemaVersion(record.schemaVersion, "Result");
  for (const field of RESULT_REQUIRED_STRINGS) {
    assertStringField(record, field, "Result");
  }
  assertJobType(record.jobType, "Result");
  assertResultStatus(record.status);
  if (typeof record.exitCode !== "number") {
    throw new EnvelopeValidationError(
      "envelope.invalid",
      "Result envelope is missing required number field 'exitCode'",
      undefined,
    );
  }
  assertStringArray(record.artifactRefs, "Result", "artifactRefs");
  return record as unknown as ResultEnvelope;
}

function asRecord(input: string | unknown, kind: string): UnknownRecord {
  const value = parseJson(input, kind);
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new EnvelopeValidationError(
      "envelope.invalid",
      `${kind} envelope must be a JSON object`,
      undefined,
    );
  }
  return value as UnknownRecord;
}

function parseJson(input: string | unknown, kind: string): unknown {
  if (typeof input !== "string") {
    return input;
  }
  try {
    return JSON.parse(input);
  } catch {
    throw new EnvelopeValidationError(
      "envelope.invalid_json",
      `${kind} envelope is not valid JSON`,
      undefined,
    );
  }
}

function assertSchemaVersion(
  value: unknown,
  kind: string,
): asserts value is EnvelopeSchemaVersion {
  if (value !== ENVELOPE_SCHEMA_VERSION) {
    throw new EnvelopeValidationError(
      "envelope.unsupported_schema_version",
      `${kind} envelope has unsupported schemaVersion ${JSON.stringify(value)}; expected ${ENVELOPE_SCHEMA_VERSION}`,
      value,
    );
  }
}

function assertStringField(record: UnknownRecord, field: string, kind: string): void {
  const value = record[field];
  if (typeof value !== "string" || value.length === 0) {
    throw new EnvelopeValidationError(
      "envelope.invalid",
      `${kind} envelope is missing required string field '${field}'`,
      undefined,
    );
  }
}

function assertJobType(value: unknown, kind: string): asserts value is JobType {
  if (typeof value !== "string" || !(JOB_TYPES as readonly string[]).includes(value)) {
    throw new EnvelopeValidationError(
      "envelope.invalid_job_type",
      `${kind} envelope has unknown jobType ${JSON.stringify(value)}`,
      undefined,
    );
  }
}

function assertResultStatus(value: unknown): asserts value is ResultStatus {
  if (
    typeof value !== "string" ||
    !(RESULT_STATUSES as readonly string[]).includes(value)
  ) {
    throw new EnvelopeValidationError(
      "envelope.invalid",
      `Result envelope has unknown status ${JSON.stringify(value)}`,
      undefined,
    );
  }
}

function assertReferencePayload(value: unknown): void {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new EnvelopeValidationError(
      "envelope.invalid",
      "Job envelope is missing the reference payload object",
      undefined,
    );
  }
  const payload = value as UnknownRecord;
  for (const field of ["contextRef", "outputRef", "credentialRef"]) {
    assertStringField(payload, field, "Job payload");
  }
  assertStringArray(payload.sectionRefs, "Job payload", "sectionRefs");
  assertStringArray(payload.artifactRefs, "Job payload", "artifactRefs");
}

function assertStringArray(value: unknown, kind: string, field: string): void {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new EnvelopeValidationError(
      "envelope.invalid",
      `${kind} is missing required string array field '${field}'`,
      undefined,
    );
  }
}
