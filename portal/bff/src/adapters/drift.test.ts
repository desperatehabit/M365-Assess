import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  DEFAULT_STANDARDS_REGISTRY_PATH,
  SqliteDriftRepository,
  SqliteRepository,
  loadMigrations,
  runMigrations,
} from "@m365-assess/db";
import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import {
  DRIFT_DEVIATIONS_ARTIFACT,
  createDriftDeletionPort,
  createDriftRefresh,
  createDriftStore,
  createDriftTriageStore,
  withDriftIngestion,
} from "./drift.js";
import type { JobEnvelope, ResultEnvelope } from "@m365-assess/contracts";

async function setup() {
  const db = new Database(":memory:");
  const repo = new SqliteDriftRepository(db, runMigrations(db, loadMigrations()), DEFAULT_STANDARDS_REGISTRY_PATH);
  await repo.upsertDeviations("t-a", [{ standardKey: "CA-1", resourceId: "p-1", kind: "mismatch", current: 1, expected: 2 }]);
  await repo.upsertDeviations("t-b", [{ standardKey: "CA-1", resourceId: "p-2", kind: "extra", current: 1, expected: null }]);
  return repo;
}

describe("drift adapters (T-0825)", () => {
  it("lists deviations per tenant and across tenants", async () => {
    const store = createDriftStore(await setup());
    expect(await store.listDeviations("t-a")).toHaveLength(1);
    expect(await store.listDeviations("t-b", { kind: "mismatch" })).toEqual([]);
    expect((await store.listAllDeviations!()).map((d) => d.tenantId)).toEqual(["t-a", "t-b"]);
  });

  it("applies triage by deviation id", async () => {
    const repo = await setup();
    const store = createDriftTriageStore(repo);
    const [row] = await repo.listDeviations("t-a");
    expect(await store.getDeviationById(row!.id)).toMatchObject({ tenantId: "t-a", state: "open" });
    const accepted = await store.applyTriageByDeviationId(row!.id, {
      state: "accepted",
      reason: "known",
      expiresOn: "2027-01-01T00:00:00.000Z",
      autoRemediateOnExpiry: false,
      overrideValue: null,
    });
    expect(accepted).toMatchObject({ id: row!.id, state: "accepted", reason: "known" });
    expect(await store.applyTriageByDeviationId("missing", { state: "accepted", reason: null, expiresOn: null, autoRemediateOnExpiry: false, overrideValue: null })).toBeUndefined();
  });

});

describe("drift refresh, deletion port, and ingestion (T-0841)", () => {
  function recordingJobs() {
    const envelopes: Record<string, unknown>[] = [];
    return { jobs: { enqueue: async (envelope: Record<string, unknown>) => { envelopes.push(envelope); return envelope.jobId as string; } }, envelopes };
  }

  async function findingsRepo() {
    const db = new Database(":memory:");
    const version = runMigrations(db, loadMigrations());
    const repo = new SqliteRepository(db, version, "memory");
    await repo.upsertTenant({
      id: "t-a",
      displayName: null,
      defaultDomain: null,
      initialDomain: null,
      source: "direct",
      status: "active",
      excluded: false,
      lastRunAt: null,
      errorCount: 0,
    });
    await repo.createRun({
      id: "run-1",
      tenantId: "t-a",
      parentRunId: null,
      trigger: "manual",
      sections: [],
      options: null,
      startedAt: null,
      finishedAt: null,
      status: "succeeded",
      artifactPath: null,
      summaryCounts: null,
      provenance: null,
    });
    await repo.replaceRunFindings("t-a", "run-1", [
      { id: "f-1", tenantId: "t-a", runId: "run-1", checkId: "CA-1", status: "Fail", currentValue: "1" },
    ]);
    return repo;
  }

  it("refresh enqueues a drift job with the current state and writes its job file", async () => {
    const storageRoot = mkdtempSync(path.join(tmpdir(), "drift-refresh-"));
    try {
      const db = new Database(":memory:");
      const version = runMigrations(db, loadMigrations());
      const drift = new SqliteDriftRepository(db, version, DEFAULT_STANDARDS_REGISTRY_PATH);
      await drift.upsertDeviations("t-a", []);
      const findings = await findingsRepo();
      const { jobs, envelopes } = recordingJobs();
      const refresh = createDriftRefresh({
        jobs,
        drift,
        findings,
        latestRunId: async () => "run-1",
        storageRoot,
      });
      expect((await refresh.refresh("t-a")).recomputed).toBe(true);
      expect(envelopes).toHaveLength(1);
      expect(envelopes[0]).toMatchObject({
        jobType: "drift",
        tenantId: "t-a",
        runId: "run-1",
        payload: {
          templateId: "",
          currentState: [{ key: "CA-1|", value: 1 }],
          extraPolicies: [],
        },
      });
      const jobFile = JSON.parse(readFileSync(path.join(storageRoot, "drift/t-a/context.json"), "utf8")) as {
        payload: { currentState: { key: string; value: unknown }[] };
      };
      expect(jobFile.payload.currentState).toEqual([{ key: "CA-1|", value: 1 }]);
    } finally {
      rmSync(storageRoot, { recursive: true, force: true });
    }
  });

  it("queues a deny deletion as a remediation apply job", async () => {
    const { jobs, envelopes } = recordingJobs();
    const port = createDriftDeletionPort({ jobs });
    const jobId = await port.queueDeletion({
      kind: "drift-deny-delete",
      tenantId: "t-a",
      standardKey: "CA-1",
      resourceId: "p-1",
      reason: "remove",
      notBefore: "2026-09-30T00:00:00.000Z",
    });
    expect(jobId).toEqual(expect.any(String));
    expect(envelopes).toHaveLength(1);
    expect(envelopes[0]).toMatchObject({
      jobType: "remediation",
      tenantId: "t-a",
      payload: { operation: "apply" },
    });
  });

  it("stores a succeeded refresh's deviations through upsertDeviations", async () => {
    const storageRoot = mkdtempSync(path.join(tmpdir(), "drift-ingest-"));
    try {
      const db = new Database(":memory:");
      const version = runMigrations(db, loadMigrations());
      const drift = new SqliteDriftRepository(db, version, DEFAULT_STANDARDS_REGISTRY_PATH);
      const outputRef = "drift/t-a/run-1";
      const folder = path.join(storageRoot, outputRef);
      mkdirSync(folder, { recursive: true });
      const rows = [
        { standardKey: "CA-1", resourceId: "p-1", kind: "mismatch", current: 1, expected: 2, lastSeenAt: "2026-09-29T00:00:00.000Z" },
      ];
      writeFileSync(path.join(folder, DRIFT_DEVIATIONS_ARTIFACT), JSON.stringify(rows));
      const envelope = {
        schemaVersion: "v1",
        jobId: "job-1",
        jobType: "drift",
        tenantId: "t-a",
        runId: "run-1",
        requestId: "req-1",
        correlationId: "corr-1",
        createdAt: "2026-09-29T00:00:00.000Z",
        payload: { outputRef },
      } as unknown as JobEnvelope;
      const result = {
        schemaVersion: "v1",
        jobId: "job-1",
        jobType: "drift",
        tenantId: "t-a",
        runId: "run-1",
        requestId: "req-1",
        correlationId: "corr-1",
        status: "succeeded",
        exitCode: 0,
        artifactRefs: [DRIFT_DEVIATIONS_ARTIFACT],
      } as unknown as ResultEnvelope;
      const runWorker = withDriftIngestion(async () => result, { drift, storageRoot });
      await runWorker(envelope, new AbortController().signal);
      expect(await drift.listDeviations("t-a")).toEqual([
        expect.objectContaining({ standardKey: "CA-1", resourceId: "p-1", kind: "mismatch", current: 1, expected: 2 }),
      ]);
    } finally {
      rmSync(storageRoot, { recursive: true, force: true });
    }
  });

  it("preserves triage when the refresh upserts deviations", async () => {
    const storageRoot = mkdtempSync(path.join(tmpdir(), "drift-ingest-triage-"));
    try {
      const db = new Database(":memory:");
      const version = runMigrations(db, loadMigrations());
      const drift = new SqliteDriftRepository(db, version, DEFAULT_STANDARDS_REGISTRY_PATH);
      await drift.upsertDeviations("t-a", [
        { standardKey: "CA-1", resourceId: "p-1", kind: "mismatch", current: 1, expected: 2 },
      ]);
      const [existing] = await drift.listDeviations("t-a");
      await drift.setDeviationTriageById(existing!.id, {
        state: "accepted",
        reason: "known",
        expiresOn: "2027-01-01T00:00:00.000Z",
        autoRemediateOnExpiry: false,
        overrideValue: null,
      });
      const outputRef = "drift/t-a/run-1";
      const folder = path.join(storageRoot, outputRef);
      mkdirSync(folder, { recursive: true });
      writeFileSync(
        path.join(folder, DRIFT_DEVIATIONS_ARTIFACT),
        JSON.stringify([
          { standardKey: "CA-1", resourceId: "p-1", kind: "mismatch", current: 1, expected: 2, lastSeenAt: "2026-09-29T00:00:00.000Z" },
        ]),
      );
      const envelope = {
        schemaVersion: "v1",
        jobId: "job-1",
        jobType: "drift",
        tenantId: "t-a",
        runId: "run-1",
        requestId: "req-1",
        correlationId: "corr-1",
        createdAt: "2026-09-29T00:00:00.000Z",
        payload: { outputRef },
      } as unknown as JobEnvelope;
      const result = {
        schemaVersion: "v1",
        jobId: "job-1",
        jobType: "drift",
        tenantId: "t-a",
        runId: "run-1",
        requestId: "req-1",
        correlationId: "corr-1",
        status: "succeeded",
        exitCode: 0,
        artifactRefs: [DRIFT_DEVIATIONS_ARTIFACT],
      } as unknown as ResultEnvelope;
      const runWorker = withDriftIngestion(async () => result, { drift, storageRoot });
      await runWorker(envelope, new AbortController().signal);
      expect(await drift.getDeviationById(existing!.id)).toMatchObject({ state: "accepted", reason: "known" });
    } finally {
      rmSync(storageRoot, { recursive: true, force: true });
    }
  });
});
