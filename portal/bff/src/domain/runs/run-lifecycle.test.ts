import { describe, expect, it } from "vitest";
import {
  FINDING_CHECK_FIELD,
  buildRunEnvelope,
  createMemoryIdempotencyStore,
  isTerminalRunStatus,
  parseArtifactName,
  parseIdempotencyKey,
  parseRunCreateBody,
  resolveArtifactPath,
  runArtifactPath,
  RunInputError,
} from "./run-lifecycle.js";

describe("parseRunCreateBody", () => {
  it("defaults to a manual run with no sections", () => {
    expect(parseRunCreateBody(undefined)).toEqual({ sections: [], trigger: "manual" });
    expect(parseRunCreateBody(null)).toEqual({ sections: [], trigger: "manual" });
    expect(parseRunCreateBody({})).toEqual({ sections: [], trigger: "manual" });
  });

  it("accepts sections and an api trigger", () => {
    expect(
      parseRunCreateBody({ sections: [" Identity ", "mail"], trigger: "api" }),
    ).toEqual({ sections: ["Identity", "mail"], trigger: "api" });
  });

  it("rejects a non-object body, bad sections, bad trigger, and unknown fields", () => {
    expect(() => parseRunCreateBody("nope")).toThrow(RunInputError);
    expect(() => parseRunCreateBody({ sections: "Identity" })).toThrow(
      expect.objectContaining({ code: "run.invalid_sections" }),
    );
    expect(() => parseRunCreateBody({ sections: [""] })).toThrow(
      expect.objectContaining({ code: "run.invalid_sections" }),
    );
    expect(() => parseRunCreateBody({ trigger: "nightly" })).toThrow(
      expect.objectContaining({ code: "run.invalid_trigger" }),
    );
    expect(() => parseRunCreateBody({ tenants: ["a"] })).toThrow(
      expect.objectContaining({ code: "run.unknown_field" }),
    );
  });
});

describe("parseIdempotencyKey", () => {
  it("treats a missing or blank key as absent", () => {
    expect(parseIdempotencyKey(undefined)).toBeNull();
    expect(parseIdempotencyKey("   ")).toBeNull();
  });

  it("trims a supplied key and rejects an overlong one", () => {
    expect(parseIdempotencyKey("  key-1 ")).toBe("key-1");
    expect(() => parseIdempotencyKey("k".repeat(257))).toThrow(
      expect.objectContaining({ code: "run.invalid_idempotency_key" }),
    );
  });
});

describe("buildRunEnvelope", () => {
  it("carries references only, never secret material", () => {
    const envelope = buildRunEnvelope({
      jobId: "job-1",
      runId: "run-1",
      requestId: "req-1",
      correlationId: "corr-1",
      tenantId: "tenant-a",
      sections: ["Identity"],
      createdAt: "2026-06-01T00:00:00.000Z",
    });
    expect(envelope).toMatchObject({
      schemaVersion: "v1",
      jobType: "assessment",
      tenantId: "tenant-a",
      runId: "run-1",
      payload: {
        contextRef: "runs/tenant-a/run-1/context.json",
        outputRef: "runs/tenant-a/run-1",
        credentialRef: "tenants/tenant-a/credential",
        sectionRefs: ["Identity"],
        artifactRefs: [],
      },
    });
    expect(JSON.stringify(envelope)).not.toContain("secret");
  });
});

describe("runArtifactPath", () => {
  it("matches the envelope output ref", () => {
    expect(runArtifactPath("tenant-a", "run-1")).toBe("runs/tenant-a/run-1");
  });
});

describe("parseArtifactName", () => {
  it("accepts report artifacts and rejects traversal or unknown extensions", () => {
    expect(parseArtifactName("report.html")).toBe("report.html");
    expect(parseArtifactName("export.XLSX")).toBe("export.XLSX");
    expect(() => parseArtifactName("../secret.json")).toThrow(
      expect.objectContaining({ code: "run.invalid_artifact_name" }),
    );
    expect(() => parseArtifactName("..")).toThrow(RunInputError);
    expect(() => parseArtifactName("notes.txt")).toThrow(
      expect.objectContaining({ code: "run.invalid_artifact_name" }),
    );
    expect(() => parseArtifactName("")).toThrow(RunInputError);
  });
});

describe("resolveArtifactPath", () => {
  it("joins the recorded ref under the artifact root", () => {
    expect(resolveArtifactPath("/data", "runs/tenant-a/run-1", "report.html")).toBe(
      "/data/runs/tenant-a/run-1/report.html",
    );
  });

  it("keeps an absolute recorded ref and collapses redundant segments", () => {
    expect(resolveArtifactPath("/data", "/var/runs/./run-1", "a.json")).toBe(
      "/var/runs/run-1/a.json",
    );
  });
});

describe("isTerminalRunStatus", () => {
  it("treats queued and running as active", () => {
    expect(isTerminalRunStatus("queued")).toBe(false);
    expect(isTerminalRunStatus("running")).toBe(false);
    expect(isTerminalRunStatus("succeeded")).toBe(true);
    expect(isTerminalRunStatus("failed")).toBe(true);
    expect(isTerminalRunStatus("cancelled")).toBe(true);
  });
});

describe("createMemoryIdempotencyStore", () => {
  it("scopes keys per tenant", async () => {
    const store = createMemoryIdempotencyStore();
    expect(await store.findRunId("tenant-a", "key-1")).toBeUndefined();
    await store.saveRunId("tenant-a", "key-1", "run-1");
    expect(await store.findRunId("tenant-a", "key-1")).toBe("run-1");
    expect(await store.findRunId("tenant-b", "key-1")).toBeUndefined();
  });
});

describe("FINDING_CHECK_FIELD", () => {
  it("names the persisted finding identifier property", () => {
    expect(FINDING_CHECK_FIELD).toBe("checkId");
  });
});
