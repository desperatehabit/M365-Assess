// Progress events cross the BFF to the web UI (SSE, EPIC-003 T-0044). Like the
// job/result envelopes they are versioned plain JSON and carry no secret or
// tenant PII beyond ids and section names.

import { EnvelopeValidationError, JOB_TYPES, type JobType } from "./envelope.js";

export const PROGRESS_EVENT_SCHEMA_VERSION = "v1" as const;

export type ProgressEventSchemaVersion = typeof PROGRESS_EVENT_SCHEMA_VERSION;

export const RUN_STATES = [
  "queued",
  "running",
  "succeeded",
  "failed",
  "cancelled",
] as const;

export type RunState = (typeof RUN_STATES)[number];

export const SECTION_STATES = [
  "pending",
  "running",
  "succeeded",
  "failed",
  "skipped",
  "cancelled",
] as const;

export type SectionState = (typeof SECTION_STATES)[number];

export interface ProgressEvent {
  schemaVersion: ProgressEventSchemaVersion;
  sequence: number;
  eventId: string;
  runId: string;
  tenantId: string;
  jobId: string;
  jobType: JobType;
  requestId: string;
  correlationId: string;
  at: string;
  state: RunState;
  section?: string;
  sectionState?: SectionState;
  completed?: number;
  total?: number;
  message?: string;
}

export function parseProgressEvent(input: string | unknown): ProgressEvent {
  const value = parseJson(input);
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new EnvelopeValidationError(
      "event.invalid",
      "Progress event must be a JSON object",
      undefined,
    );
  }
  const record = value as Record<string, unknown>;

  if (record.schemaVersion !== PROGRESS_EVENT_SCHEMA_VERSION) {
    throw new EnvelopeValidationError(
      "event.unsupported_schema_version",
      `Progress event has unsupported schemaVersion ${JSON.stringify(record.schemaVersion)}; expected ${PROGRESS_EVENT_SCHEMA_VERSION}`,
      record.schemaVersion,
    );
  }

  for (const field of [
    "eventId",
    "runId",
    "tenantId",
    "jobId",
    "requestId",
    "correlationId",
    "at",
  ]) {
    if (typeof record[field] !== "string" || record[field] === "") {
      throw new EnvelopeValidationError(
        "event.invalid",
        `Progress event is missing required string field '${field}'`,
        undefined,
      );
    }
  }

  if (typeof record.sequence !== "number" || !Number.isInteger(record.sequence)) {
    throw new EnvelopeValidationError(
      "event.invalid",
      "Progress event is missing an integer sequence",
      undefined,
    );
  }

  if (
    typeof record.jobType !== "string" ||
    !(JOB_TYPES as readonly string[]).includes(record.jobType)
  ) {
    throw new EnvelopeValidationError(
      "event.invalid",
      `Progress event has unknown jobType ${JSON.stringify(record.jobType)}`,
      undefined,
    );
  }

  if (
    typeof record.state !== "string" ||
    !(RUN_STATES as readonly string[]).includes(record.state)
  ) {
    throw new EnvelopeValidationError(
      "event.invalid",
      `Progress event has unknown state ${JSON.stringify(record.state)}`,
      undefined,
    );
  }

  if (
    record.sectionState !== undefined &&
    (typeof record.sectionState !== "string" ||
      !(SECTION_STATES as readonly string[]).includes(record.sectionState))
  ) {
    throw new EnvelopeValidationError(
      "event.invalid",
      `Progress event has unknown sectionState ${JSON.stringify(record.sectionState)}`,
      undefined,
    );
  }

  return record as unknown as ProgressEvent;
}

function parseJson(input: string | unknown): unknown {
  if (typeof input !== "string") {
    return input;
  }
  try {
    return JSON.parse(input);
  } catch {
    throw new EnvelopeValidationError(
      "event.invalid_json",
      "Progress event is not valid JSON",
      undefined,
    );
  }
}
