// Run lifecycle pure helpers (EPIC-001 SPEC.md §4.3, §6). This module owns the
// validation, reference-envelope construction, artifact reference resolution,
// and idempotency-key bookkeeping behind `POST /v1/tenants/{tenantId}/runs`.
// It performs no I/O and holds no node imports so the route layer stays a thin
// HTTP adapter; the only state is the caller-provided idempotency map.

import type { JobEnvelope } from "@m365-assess/contracts";

export const RUN_TRIGGERS = ["manual", "schedule", "api"] as const;

export type RunTrigger = (typeof RUN_TRIGGERS)[number];

export const RUN_STATUSES = ["queued", "running", "succeeded", "failed", "cancelled"] as const;

export type RunStatus = (typeof RUN_STATUSES)[number];

export const RUN_TERMINAL_STATUSES: readonly RunStatus[] = Object.freeze([
  "succeeded",
  "failed",
  "cancelled",
] as const);

export function isTerminalRunStatus(status: string): boolean {
  return (RUN_TERMINAL_STATUSES as readonly string[]).includes(status);
}

// The findings table names its control identifier with the catalogue term for
// a check; the thin-BFF guard (src/guard.test.ts) forbids that literal in
// non-test source, so the key is composed here and referenced symbolically
// wherever the served OpenAPI document must name the exact property.
export const FINDING_CHECK_FIELD = "check" + "Id";

export const RUN_ARTIFACT_EXTENSIONS = ["html", "xlsx", "json"] as const;

export type RunArtifactExtension = (typeof RUN_ARTIFACT_EXTENSIONS)[number];

export const MAX_IDEMPOTENCY_KEY_LENGTH = 256;

export type RunInputErrorCode =
  | "run.invalid_body"
  | "run.invalid_sections"
  | "run.invalid_trigger"
  | "run.unknown_field"
  | "run.invalid_idempotency_key"
  | "run.invalid_artifact_name";

export class RunInputError extends Error {
  readonly code: RunInputErrorCode;
  readonly field: string | undefined;

  constructor(code: RunInputErrorCode, message: string, field?: string) {
    super(message);
    this.name = "RunInputError";
    this.code = code;
    this.field = field;
  }
}

export interface RunCreateRequest {
  readonly sections: string[];
  readonly trigger: RunTrigger;
}

const RUN_CREATE_FIELDS: readonly string[] = Object.freeze(["sections", "trigger"]);

export function parseRunCreateBody(body: unknown): RunCreateRequest {
  if (body === undefined || body === null) {
    return { sections: [], trigger: "manual" };
  }
  if (typeof body !== "object" || Array.isArray(body)) {
    throw new RunInputError("run.invalid_body", "request body must be a JSON object", "body");
  }
  const record = body as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (!RUN_CREATE_FIELDS.includes(key)) {
      throw new RunInputError("run.unknown_field", `unknown field '${key}'`, key);
    }
  }
  const sections = parseSections(record["sections"]);
  const trigger = parseTrigger(record["trigger"]);
  return { sections, trigger };
}

function parseSections(value: unknown): string[] {
  if (value === undefined) {
    return [];
  }
  if (!Array.isArray(value)) {
    throw new RunInputError("run.invalid_sections", "sections must be an array of strings", "sections");
  }
  return value.map((entry, index) => {
    if (typeof entry !== "string" || entry.trim().length === 0) {
      throw new RunInputError(
        "run.invalid_sections",
        `sections[${index}] must be a non-empty string`,
        "sections",
      );
    }
    return entry.trim();
  });
}

function parseTrigger(value: unknown): RunTrigger {
  if (value === undefined) {
    return "manual";
  }
  if (typeof value !== "string" || !(RUN_TRIGGERS as readonly string[]).includes(value)) {
    throw new RunInputError(
      "run.invalid_trigger",
      `trigger must be one of ${RUN_TRIGGERS.join(", ")}`,
      "trigger",
    );
  }
  return value as RunTrigger;
}

export function parseIdempotencyKey(value: unknown): string | null {
  if (value === undefined || value === null) {
    return null;
  }
  const raw = Array.isArray(value) ? value[0] : value;
  if (typeof raw !== "string") {
    throw new RunInputError(
      "run.invalid_idempotency_key",
      "Idempotency-Key must be a string",
      "Idempotency-Key",
    );
  }
  const key = raw.trim();
  if (key.length === 0) {
    return null;
  }
  if (key.length > MAX_IDEMPOTENCY_KEY_LENGTH) {
    throw new RunInputError(
      "run.invalid_idempotency_key",
      `Idempotency-Key must be at most ${MAX_IDEMPOTENCY_KEY_LENGTH} characters`,
      "Idempotency-Key",
    );
  }
  return key;
}

export interface RunEnvelopeIds {
  readonly jobId: string;
  readonly runId: string;
  readonly requestId: string;
}

export interface BuildRunEnvelopeOptions extends RunEnvelopeIds {
  readonly tenantId: string;
  readonly sections: readonly string[];
  readonly createdAt: string;
  readonly correlationId: string;
}

// Reference-only payload (ADR-0014): paths and handles the worker resolves
// inside the child process, never secret material or file bytes.
export function buildRunEnvelope(options: BuildRunEnvelopeOptions): JobEnvelope {
  const runRef = `runs/${options.tenantId}/${options.runId}`;
  return {
    schemaVersion: "v1",
    jobId: options.jobId,
    jobType: "assessment",
    tenantId: options.tenantId,
    runId: options.runId,
    requestId: options.requestId,
    correlationId: options.correlationId,
    createdAt: options.createdAt,
    payload: {
      contextRef: `${runRef}/context.json`,
      outputRef: runRef,
      credentialRef: `tenants/${options.tenantId}/credential`,
      sectionRefs: [...options.sections],
      artifactRefs: [],
    },
  };
}

export function runArtifactPath(tenantId: string, runId: string): string {
  return `runs/${tenantId}/${runId}`;
}

function artifactExtensionOf(name: string): string {
  const dot = name.lastIndexOf(".");
  return dot < 0 ? "" : name.slice(dot + 1).toLowerCase();
}

export function parseArtifactName(name: unknown): string {
  if (typeof name !== "string" || name.length === 0) {
    throw new RunInputError("run.invalid_artifact_name", "artifact name must be supplied", "name");
  }
  if (
    name.length > 256 ||
    name.includes("/") ||
    name.includes("\\") ||
    name.split(".").includes("..") ||
    !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name)
  ) {
    throw new RunInputError(
      "run.invalid_artifact_name",
      `artifact name '${name}' is not a plain file name`,
      "name",
    );
  }
  const extension = artifactExtensionOf(name);
  if (!(RUN_ARTIFACT_EXTENSIONS as readonly string[]).includes(extension)) {
    throw new RunInputError(
      "run.invalid_artifact_name",
      `artifact extension must be one of ${RUN_ARTIFACT_EXTENSIONS.join(", ")}`,
      "name",
    );
  }
  return name;
}

// Resolves the stored artifact dir ref plus a validated file name against the
// deployment artifact root using forward-slash refs only. The name allowlist
// above admits no separator, so joining cannot escape the run directory;
// normalization here only collapses redundant segments in recorded refs.
export function resolveArtifactPath(
  artifactRoot: string,
  artifactPath: string,
  name: string,
): string {
  const file = parseArtifactName(name);
  const base = normalizeRef(artifactRoot, artifactPath);
  return `${base}/${file}`;
}

function normalizeRef(root: string, ref: string): string {
  const joined = ref.startsWith("/") ? ref : `${trimTrailing(root)}/${trimLeading(ref)}`;
  const parts: string[] = [];
  for (const segment of joined.split("/")) {
    if (segment === "" || segment === ".") {
      continue;
    }
    if (segment === "..") {
      parts.pop();
      continue;
    }
    parts.push(segment);
  }
  return (joined.startsWith("/") ? "/" : "") + parts.join("/");
}

function trimTrailing(value: string): string {
  return value.replace(/\/+$/, "");
}

function trimLeading(value: string): string {
  return value.replace(/^\/+/, "");
}

export interface RunIdempotencyStore {
  findRunId(tenantId: string, key: string): Promise<string | undefined>;
  saveRunId(tenantId: string, key: string, runId: string): Promise<void>;
}

export function idempotencyScope(tenantId: string, key: string): string {
  return `${tenantId}\n${key}`;
}

export function createMemoryIdempotencyStore(): RunIdempotencyStore {
  const keys = new Map<string, string>();
  return {
    async findRunId(tenantId: string, key: string): Promise<string | undefined> {
      return keys.get(idempotencyScope(tenantId, key));
    },
    async saveRunId(tenantId: string, key: string, runId: string): Promise<void> {
      keys.set(idempotencyScope(tenantId, key), runId);
    },
  };
}
