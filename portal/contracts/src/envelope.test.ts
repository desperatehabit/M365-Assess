import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parse as parseYaml } from "yaml";
import {
  ENVELOPE_SCHEMA_VERSION,
  EnvelopeValidationError,
  parseJobEnvelope,
  parseResultEnvelope,
  serializeEnvelope,
  type JobEnvelope,
  type ResultEnvelope,
} from "./envelope.js";
import {
  PROGRESS_EVENT_SCHEMA_VERSION,
  parseProgressEvent,
  type ProgressEvent,
} from "./events.js";

const TENANT_ID = "00000000-0000-0000-0000-000000000000";

const job: JobEnvelope = {
  schemaVersion: ENVELOPE_SCHEMA_VERSION,
  jobId: "job-0001",
  jobType: "assessment",
  tenantId: TENANT_ID,
  runId: "run-0001",
  requestId: "req-0001",
  correlationId: "corr-0001",
  createdAt: "2026-01-01T00:00:00.000Z",
  payload: {
    contextRef: "runs/run-0001/context.json",
    outputRef: "runs/run-0001/tenant",
    credentialRef: "tenants/" + TENANT_ID + "/credential",
    sectionRefs: ["Identity", "Exchange"],
    artifactRefs: [],
  },
};

const result: ResultEnvelope = {
  schemaVersion: ENVELOPE_SCHEMA_VERSION,
  jobId: "job-0001",
  jobType: "assessment",
  tenantId: TENANT_ID,
  runId: "run-0001",
  requestId: "req-0001",
  correlationId: "corr-0001",
  status: "succeeded",
  startedAt: "2026-01-01T00:00:00.000Z",
  finishedAt: "2026-01-01T00:05:00.000Z",
  exitCode: 0,
  artifactRefs: ["runs/run-0001/report.html"],
  summary: { total: 3, byStatus: { Pass: 2, Fail: 1 } },
};

const event: ProgressEvent = {
  schemaVersion: PROGRESS_EVENT_SCHEMA_VERSION,
  sequence: 1,
  eventId: "evt-0001",
  runId: "run-0001",
  tenantId: TENANT_ID,
  jobId: "job-0001",
  jobType: "assessment",
  requestId: "req-0001",
  correlationId: "corr-0001",
  at: "2026-01-01T00:00:05.000Z",
  state: "running",
  section: "Identity",
  sectionState: "running",
  completed: 1,
  total: 2,
};

function capture(fn: () => unknown): unknown {
  try {
    fn();
  } catch (error) {
    return error;
  }
  throw new Error("expected function to throw");
}

function collectKeys(value: unknown, keys: string[] = []): string[] {
  if (Array.isArray(value)) {
    for (const item of value) {
      collectKeys(item, keys);
    }
  } else if (value !== null && typeof value === "object") {
    for (const [key, nested] of Object.entries(value)) {
      keys.push(key);
      collectKeys(nested, keys);
    }
  }
  return keys;
}

const SECRET_KEYS = new Set([
  "clientSecret",
  "certificatePassword",
  "certificate",
  "password",
  "secret",
  "secretValue",
  "privateKey",
  "thumbprint",
  "token",
  "accessToken",
  "refreshToken",
]);

describe("envelope round-trip", () => {
  it("round-trips a JobEnvelope", () => {
    expect(parseJobEnvelope(serializeEnvelope(job))).toEqual(job);
  });

  it("round-trips a ResultEnvelope", () => {
    expect(parseResultEnvelope(serializeEnvelope(result))).toEqual(result);
  });

  it("accepts an already-parsed object", () => {
    expect(parseJobEnvelope(job)).toEqual(job);
  });
});

describe("envelope schema version", () => {
  it("rejects a JobEnvelope with an unknown schemaVersion", () => {
    const error = capture(() => parseJobEnvelope({ ...job, schemaVersion: "v99" }));
    expect(error).toBeInstanceOf(EnvelopeValidationError);
    expect((error as EnvelopeValidationError).code).toBe(
      "envelope.unsupported_schema_version",
    );
  });

  it("rejects a ResultEnvelope with an unknown schemaVersion", () => {
    const error = capture(() => parseResultEnvelope({ ...result, schemaVersion: 2 }));
    expect(error).toBeInstanceOf(EnvelopeValidationError);
    expect((error as EnvelopeValidationError).code).toBe(
      "envelope.unsupported_schema_version",
    );
  });

  it("rejects a payload that is not valid JSON", () => {
    const error = capture(() => parseJobEnvelope("{ not json"));
    expect(error).toBeInstanceOf(EnvelopeValidationError);
    expect((error as EnvelopeValidationError).code).toBe("envelope.invalid_json");
  });

  it("rejects a JobEnvelope missing a required reference", () => {
    const incomplete = {
      ...job,
      payload: { ...job.payload, contextRef: undefined },
    };
    const error = capture(() => parseJobEnvelope(incomplete));
    expect(error).toBeInstanceOf(EnvelopeValidationError);
    expect((error as EnvelopeValidationError).code).toBe("envelope.invalid");
  });
});

describe("envelope references", () => {
  it("carries references rather than secret material", () => {
    const keys = collectKeys(JSON.parse(serializeEnvelope(job)));
    expect(keys.length).toBeGreaterThan(0);
    for (const key of keys) {
      expect(SECRET_KEYS.has(key)).toBe(false);
    }
  });

  it("serializes the credential as a reference", () => {
    expect(job.payload.credentialRef).toBe("tenants/" + TENANT_ID + "/credential");
    expect(serializeEnvelope(job)).not.toContain("password");
  });
});

describe("progress events", () => {
  it("round-trips a progress event", () => {
    expect(parseProgressEvent(JSON.stringify(event))).toEqual(event);
  });

  it("rejects a progress event with an unknown schemaVersion", () => {
    const error = capture(() => parseProgressEvent({ ...event, schemaVersion: "v0" }));
    expect(error).toBeInstanceOf(EnvelopeValidationError);
    expect((error as EnvelopeValidationError).code).toBe(
      "event.unsupported_schema_version",
    );
  });

  it("requires a monotonic-friendly integer sequence", () => {
    const error = capture(() => parseProgressEvent({ ...event, sequence: 1.5 }));
    expect(error).toBeInstanceOf(EnvelopeValidationError);
    expect((error as EnvelopeValidationError).code).toBe("event.invalid");
  });
});

describe("openapi skeleton", () => {
  const doc = parseYaml(
    readFileSync(new URL("../openapi/portal.v1.yaml", import.meta.url), "utf8"),
  ) as {
    openapi: string;
    paths: Record<string, unknown>;
    components: {
      schemas: Record<string, { required?: string[] }>;
      parameters: Record<string, unknown>;
    };
  };

  it("parses as OpenAPI 3.1", () => {
    expect(doc.openapi).toMatch(/^3\.1\./);
    expect(doc.paths).toEqual({});
  });

  it("defines the structured error schema", () => {
    const errorSchema = doc.components.schemas.Error;
    expect(errorSchema).toBeDefined();
    expect(errorSchema?.required).toEqual(
      expect.arrayContaining(["code", "message", "correlationId"]),
    );
  });

  it("defines the cursor pagination schema and parameters", () => {
    const page = doc.components.schemas.CursorPage;
    expect(page).toBeDefined();
    expect(page?.required).toEqual(expect.arrayContaining(["items", "nextCursor"]));
    expect(doc.components.parameters.Cursor).toBeDefined();
    expect(doc.components.parameters.Limit).toBeDefined();
  });
});
