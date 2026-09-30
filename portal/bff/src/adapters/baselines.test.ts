import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  DEFAULT_STANDARDS_REGISTRY_PATH,
  SqliteBaselinesRepository,
  SqliteDriftRepository,
  SqliteRepository,
  SqliteStandardsRepository,
  loadMigrations,
  runMigrations,
} from "@m365-assess/db";
import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import type { JobEnvelope } from "@m365-assess/contracts";
import {
  BASELINE_EVALUATION_ARTIFACT,
  createBaselineAdvanceStore,
  createBaselineAlignmentStore,
  createBaselineEvaluationRunner,
  createBaselineHistory,
  createBaselinesFleetStore,
  createBaselinesMigrateStore,
  createBaselinesStore,
  ingestBaselineEvaluation,
} from "./baselines.js";

function setup() {
  const db = new Database(":memory:");
  const version = runMigrations(db, loadMigrations());
  return {
    baselines: new SqliteBaselinesRepository(db, version),
    drift: new SqliteDriftRepository(db, version, DEFAULT_STANDARDS_REGISTRY_PATH),
    standards: new SqliteStandardsRepository(db, version, DEFAULT_STANDARDS_REGISTRY_PATH),
  };
}

const STAGE = { order: 0, conditions: [{ key: "CA-1", expected: true }], action: "report" as const };

describe("baselines adapters (T-0825)", () => {
  it("creates and updates baselines with their stages and assignments", async () => {
    const store = createBaselinesStore(setup().baselines);
    const created = await store.createBaseline({
      id: "b-1",
      name: "Rollout",
      stages: [STAGE],
      assignments: [{ targetType: "tenant", targetId: "t-a", precedence: 0 }],
    });
    // The route's stage shape has no back-reference to the baseline.
    expect(created.stages).toEqual([STAGE]);

    const next = { order: 1, conditions: [{ key: "CA-2", expected: 1 }], action: "remediate" as const };
    const updated = await store.updateBaseline("b-1", {
      name: "Rollout 2",
      stages: [STAGE, next],
      assignments: [{ targetType: "allTenants", targetId: null, precedence: 0 }],
    });
    expect(updated).toMatchObject({ name: "Rollout 2", stages: [STAGE, next] });
    expect(await store.listBaselineAssignments("b-1")).toEqual([
      { baselineId: "b-1", targetType: "allTenants", targetId: null, precedence: 0 },
    ]);
    expect(await store.updateBaseline("missing", { name: "x" })).toBeUndefined();
    expect((await store.listBaselines()).map((b) => b.id)).toEqual(["b-1"]);
    expect(await store.deleteBaseline("b-1")).toBe(true);
  });

  it("advances rollouts and records history for the alignment view", async () => {
    const { baselines } = setup();
    await baselines.createBaseline({ id: "b-1", name: "Rollout", stages: [STAGE] });
    const advance = createBaselineAdvanceStore(baselines);
    await advance.upsertRollout({ baselineId: "b-1", tenantId: "t-a", stage: 0, state: "eligible" });
    expect(await advance.getRollout("b-1", "t-a")).toMatchObject({ stage: 0, state: "eligible" });
    await createBaselineHistory(baselines).append({
      baselineId: "b-1",
      tenantId: "t-a",
      event: "stage.advanced",
      detail: { from: 0 },
      at: "2026-09-01T00:00:00.000Z",
    });
    await baselines.appendTrend({ baselineId: "b-1", tenantId: "t-a", at: "2026-09-01T00:00:00.000Z", compliance: 1 });

    const alignment = createBaselineAlignmentStore(baselines);
    expect((await alignment.getBaseline("b-1"))?.stages).toEqual([STAGE]);
    expect(await alignment.listRollouts("b-1")).toHaveLength(1);
    expect(await alignment.listHistory("b-1", 10)).toEqual([
      expect.objectContaining({ id: expect.any(String), event: "stage.advanced", detail: { from: 0 } }),
    ]);
    expect(await alignment.listTrend("b-1")).toEqual([{ baselineId: "b-1", tenantId: "t-a", at: "2026-09-01T00:00:00.000Z", compliance: 1 }]);
  });

  it("builds the fleet view from rollouts and drift deviation counts", async () => {
    const { baselines, drift } = setup();
    await baselines.createBaseline({ id: "b-1", name: "Rollout" });
    await baselines.upsertRollout({ baselineId: "b-1", tenantId: "t-a", stage: 0, state: "active" });
    await drift.upsertDeviations("t-a", [{ standardKey: "CA-1", kind: "mismatch", current: 1, expected: 2 }]);
    const fleet = createBaselinesFleetStore(baselines, drift);
    expect(await fleet.listRollouts()).toHaveLength(1);
    expect(await fleet.countDeviationsByState()).toMatchObject({ open: 1, total: 1 });
    expect(await fleet.openDeviationsByTenant()).toEqual({ "t-a": 1 });
  });

  it("reads a standards template and its assignments as the migration source", async () => {
    const { baselines, standards } = setup();
    await standards.createStandardTemplate({ id: "tpl-1", name: "Tier 1", kind: "standards", settings: [{ key: "CA-1", value: true }] });
    await standards.upsertTemplateAssignment({ templateId: "tpl-1", targetType: "group", targetId: "g-1", precedence: 2 });
    const store = createBaselinesMigrateStore(standards, baselines);
    expect(await store.getSourceTemplate("tpl-1")).toEqual({
      id: "tpl-1",
      name: "Tier 1",
      kind: "standards",
      settings: [{ key: "CA-1", value: true }],
      assignments: [{ targetType: "group", targetId: "g-1", precedence: 2 }],
    });
    expect(await store.getSourceTemplate("missing")).toBeUndefined();
    const created = await store.createBaseline({ name: "From Tier 1", stages: [STAGE], assignments: [] });
    expect(created.stages).toEqual([STAGE]);
  });
});

describe("baseline evaluation runner and ingestion (T-0841)", () => {
  const workersDir = fileURLToPath(new URL("../../../workers", import.meta.url));

  function setup() {
    const db = new Database(":memory:");
    const version = runMigrations(db, loadMigrations());
    const baselines = new SqliteBaselinesRepository(db, version);
    const findings = new SqliteRepository(db, version, "memory");
    return { db, baselines, findings };
  }

  it("evaluates each tenant's baselines through the worker and writes rollouts, history, and trend", async () => {
    const storageRoot = mkdtempSync(path.join(tmpdir(), "baseline-runner-"));
    try {
      const { baselines, findings } = setup();
      await findings.upsertTenant({
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
      await baselines.createBaseline({
        id: "b-1",
        name: "Rollout",
        stages: [{ order: 0, conditions: [{ key: "CA-1", expected: true }], action: "report" }],
      });
      const runner = createBaselineEvaluationRunner({
        workersDir,
        storageRoot,
        baselines,
        tenants: { listTenants: async () => [{ id: "t-a" }] },
        findings,
        latestRunId: async () => null,
      });
      const envelope = {
        schemaVersion: "v1",
        jobId: "job-1",
        jobType: "baseline",
        tenantId: "all",
        runId: "run-1",
        requestId: "req-1",
        correlationId: "corr-1",
        createdAt: "2026-09-29T00:00:00.000Z",
        payload: {
          contextRef: "baselines/job.json",
          outputRef: "baselines/t-a/job-1",
          credentialRef: "tenants/t-a/credential",
          sectionRefs: [],
          artifactRefs: [],
        },
      } as unknown as JobEnvelope;
      const result = await runner(envelope, new AbortController().signal);
      expect(result.status).toBe("succeeded");
      expect(await baselines.getRollout("b-1", "t-a")).toMatchObject({ baselineId: "b-1", tenantId: "t-a", stage: 0 });
      expect(await baselines.listHistory("b-1", 10)).toEqual([
        expect.objectContaining({ event: "stage.evaluated", detail: { stage: 0, satisfied: 0, evaluated: 1, state: "active" } }),
      ]);
      expect(await baselines.listTrend("b-1")).toEqual([
        expect.objectContaining({ baselineId: "b-1", tenantId: "t-a", compliance: 0 }),
      ]);
    } finally {
      rmSync(storageRoot, { recursive: true, force: true });
    }
  });

  it("marks the rollout eligible when the stage is compliant", async () => {
    const storageRoot = mkdtempSync(path.join(tmpdir(), "baseline-runner-ok-"));
    try {
      const { baselines, findings } = setup();
      await findings.upsertTenant({
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
      await findings.createRun({
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
      await findings.replaceRunFindings("t-a", "run-1", [
        { id: "f-1", tenantId: "t-a", runId: "run-1", checkId: "CA-1", status: "Pass", currentValue: "true" },
      ]);
      await baselines.createBaseline({
        id: "b-1",
        name: "Rollout",
        stages: [{ order: 0, conditions: [{ key: "CA-1", expected: true }], action: "report" }],
      });
      const runner = createBaselineEvaluationRunner({
        workersDir,
        storageRoot,
        baselines,
        tenants: { listTenants: async () => [{ id: "t-a" }] },
        findings,
        latestRunId: async () => "run-1",
      });
      const envelope = {
        schemaVersion: "v1",
        jobId: "job-1",
        jobType: "baseline",
        tenantId: "t-a",
        runId: "run-1",
        requestId: "req-1",
        correlationId: "corr-1",
        createdAt: "2026-09-29T00:00:00.000Z",
        payload: {
          contextRef: "baselines/job.json",
          outputRef: "baselines/t-a/job-1",
          credentialRef: "tenants/t-a/credential",
          sectionRefs: [],
          artifactRefs: [],
        },
      } as unknown as JobEnvelope;
      const result = await runner(envelope, new AbortController().signal);
      expect(result.status).toBe("succeeded");
      expect(await baselines.getRollout("b-1", "t-a")).toMatchObject({ stage: 0, state: "eligible" });
      expect(await baselines.listTrend("b-1")).toEqual([expect.objectContaining({ compliance: 1 })]);
    } finally {
      rmSync(storageRoot, { recursive: true, force: true });
    }
  });

  it("ingests an evaluation artifact into rollout, history, and trend", async () => {
    const storageRoot = mkdtempSync(path.join(tmpdir(), "baseline-ingest-"));
    try {
      const { baselines } = setup();
      await baselines.createBaseline({
        id: "b-1",
        name: "Rollout",
        stages: [{ order: 0, conditions: [{ key: "CA-1", expected: true }], action: "report" }],
      });
      const outputRef = "baselines/t-a/job-9";
      const folder = path.join(storageRoot, outputRef);
      mkdirSync(folder, { recursive: true });
      writeFileSync(
        path.join(folder, BASELINE_EVALUATION_ARTIFACT),
        JSON.stringify([
          {
            BaselineId: "b-1",
            StageResults: [{ order: 0, evaluated: 2, mismatched: 1, compliant: false }],
            RunAt: "2026-09-29T00:00:00.000Z",
          },
        ]),
      );
      const result = {
        schemaVersion: "v1",
        jobId: "job-9",
        jobType: "baseline",
        tenantId: "t-a",
        runId: "run-1",
        requestId: "req-9",
        correlationId: "corr-9",
        status: "succeeded",
        exitCode: 0,
        artifactRefs: [BASELINE_EVALUATION_ARTIFACT],
      } as never;
      await ingestBaselineEvaluation(
        { tenantId: "t-a", payload: { outputRef } },
        result,
        { baselines, storageRoot },
      );
      expect(await baselines.getRollout("b-1", "t-a")).toMatchObject({ stage: 0, state: "active" });
      expect(await baselines.listHistory("b-1", 10)).toEqual([
        expect.objectContaining({ event: "stage.evaluated", detail: { stage: 0, satisfied: 1, evaluated: 2, state: "active" } }),
      ]);
      expect(await baselines.listTrend("b-1")).toEqual([expect.objectContaining({ compliance: 0.5 })]);
    } finally {
      rmSync(storageRoot, { recursive: true, force: true });
    }
  });
});
