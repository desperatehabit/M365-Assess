// EPIC-010 baselines and rollouts on real storage (T-0825).
//
// Baselines, stages, assignments, rollouts, history, and trend persist through the db
// baselines repository. The fleet view counts deviations from the drift repository, and
// migration reads its source template from the standards repository. A baseline job
// evaluates each of the tenant's baselines against its current stage (T-0841): the
// runner reads the baselines, rollouts, and latest findings, the worker runs
// Invoke-Baseline, and the rollout, history, and trend writes are ingested from the
// evaluation artifact.
import { randomUUID } from "node:crypto";
import path from "node:path";
import { readFile } from "node:fs/promises";
import type {
  Baseline,
  SqliteBaselinesRepository,
  SqliteDriftRepository,
  SqliteRepository,
  SqliteStandardsRepository,
} from "@m365-assess/db";
import type { ResultEnvelope } from "@m365-assess/contracts";
import type { RunWorkerFn } from "../jobs/queue.js";
import { superviseJob } from "../jobs/supervisor.js";
import { buildEvaluationRecords } from "../domain/baseline-history.js";
import type { AdvanceHistoryPort, AdvanceStore } from "../routes/baselines-advance.js";
import type { AlignmentStore } from "../routes/baselines-alignment.js";
import type { FleetStore } from "../routes/baselines-fleet.js";
import type { MigrateStore } from "../routes/baselines-migrate.js";
import type { BaselineRecord, BaselinesStore } from "../routes/baselines.js";
import type { TenantStore } from "../routes/tenants.js";

/** The route's baseline: stages without the db's back-reference to their baseline. */
function toBaselineRecord(baseline: Baseline): BaselineRecord {
  return {
    ...baseline,
    stages: baseline.stages.map(({ order, conditions, action }) => ({ order, conditions, action })),
  };
}

async function getBaselineRecord(repo: SqliteBaselinesRepository, baselineId: string): Promise<BaselineRecord | undefined> {
  const baseline = await repo.getBaseline(baselineId);
  return baseline ? toBaselineRecord(baseline) : undefined;
}

export function createBaselinesStore(repo: SqliteBaselinesRepository): BaselinesStore {
  return {
    listBaselines: async () => (await repo.listBaselines()).map(toBaselineRecord),
    getBaseline: (baselineId) => getBaselineRecord(repo, baselineId),
    createBaseline: async (input) => toBaselineRecord(await repo.createBaseline(input)),
    async updateBaseline(baselineId, { stages, assignments, ...fields }) {
      if (!(await repo.updateBaseline(baselineId, fields))) return undefined;
      if (stages) await repo.setStages(baselineId, stages);
      if (assignments) await repo.setAssignments(baselineId, assignments);
      return getBaselineRecord(repo, baselineId);
    },
    deleteBaseline: (baselineId) => repo.deleteBaseline(baselineId),
    listBaselineAssignments: (baselineId) => repo.getAssignments(baselineId),
    setBaselineAssignments: (baselineId, assignments) => repo.setAssignments(baselineId, assignments),
  };
}

export function createBaselineAdvanceStore(repo: SqliteBaselinesRepository): AdvanceStore {
  return {
    getBaseline: (baselineId) => getBaselineRecord(repo, baselineId),
    getRollout: (baselineId, tenantId) => repo.getRollout(baselineId, tenantId),
    upsertRollout: (input) => repo.upsertRollout(input),
  };
}

export function createBaselineHistory(repo: SqliteBaselinesRepository): AdvanceHistoryPort {
  return {
    append: (event) => repo.appendHistory({ id: randomUUID(), ...event }),
  };
}

export function createBaselineAlignmentStore(repo: SqliteBaselinesRepository): AlignmentStore {
  return {
    getBaseline: (baselineId) => getBaselineRecord(repo, baselineId),
    listRollouts: (baselineId) => repo.listRollouts(baselineId),
    listHistory: (baselineId, limit) => repo.listHistory(baselineId, limit),
    listTrend: (baselineId) => repo.listTrend(baselineId),
  };
}

export function createBaselinesFleetStore(baselines: SqliteBaselinesRepository, drift: SqliteDriftRepository): FleetStore {
  return {
    listBaselines: async () => (await baselines.listBaselines()).map(toBaselineRecord),
    listRollouts: () => baselines.listAllRollouts(),
    countDeviationsByState: () => drift.countDeviationsByState(),
    openDeviationsByTenant: () => drift.countOpenDeviationsByTenant(),
  };
}

export function createBaselinesMigrateStore(
  standards: SqliteStandardsRepository,
  baselines: SqliteBaselinesRepository,
): MigrateStore {
  return {
    async getSourceTemplate(templateId) {
      const template = await standards.getStandardTemplate(templateId);
      if (!template) return undefined;
      const assignments = (await standards.listTemplateAssignments())
        .filter((assignment) => assignment.templateId === templateId)
        .map(({ targetType, targetId, precedence }) => ({ targetType, targetId, precedence }));
      return { id: template.id, name: template.name, kind: template.kind, settings: template.settings, assignments };
    },
    createBaseline: async (input) => toBaselineRecord(await baselines.createBaseline(input)),
  };
}

// ─── Baseline evaluation (T-0841) ────────────────────────────────────────────

function parseCurrentValue(value: string | null): unknown {
  if (value === null || value === undefined) return null;
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return value;
  }
}

export interface BaselineEvaluationRunnerOptions {
  readonly workersDir: string;
  readonly storageRoot: string;
  readonly baselines: Pick<SqliteBaselinesRepository, "listBaselines" | "getRollout">;
  readonly tenants: Pick<TenantStore, "listTenants">;
  readonly findings: Pick<SqliteRepository, "listFindings">;
  readonly latestRunId: (tenantId: string) => Promise<string | null>;
}

/**
 * The `baseline` job runner: reads the tenant's baselines, their rollouts (to
 * find each tenant's current stage), and the latest findings (for the current
 * state map), then runs the baseline worker entrypoint once per tenant. The
 * worker evaluates each baseline against its current stage; the rollout,
 * history, and trend writes are ingested from the evaluation artifact.
 */
export function createBaselineEvaluationRunner(options: BaselineEvaluationRunnerOptions): RunWorkerFn {
  const { workersDir, storageRoot, baselines, tenants, findings, latestRunId } = options;
  return async (envelope, signal) => {
    const tenantId = envelope.tenantId;
    const tenantIds =
      tenantId === "all"
        ? (await tenants.listTenants()).map((tenant) => tenant.id)
        : [tenantId];
    let lastResult: ResultEnvelope = {
      schemaVersion: "v1",
      jobId: envelope.jobId,
      jobType: "baseline",
      tenantId,
      runId: envelope.runId,
      requestId: envelope.requestId,
      correlationId: envelope.correlationId,
      status: "succeeded",
      startedAt: new Date().toISOString(),
      finishedAt: new Date().toISOString(),
      exitCode: 0,
      artifactRefs: [],
    };
    for (const id of tenantIds) {
      const runId = await latestRunId(id);
      const rows = runId ? await findings.listFindings(id, runId) : [];
      const currentState = rows.map((row) => ({
        key: row.checkId,
        value: parseCurrentValue(row.currentValue),
      }));
      const allBaselines = await baselines.listBaselines();
      const baselineData: { baselineId: string; stages: Baseline["stages"] }[] = [];
      for (const baseline of allBaselines) {
        const rollout = await baselines.getRollout(baseline.id, id);
        const stage = rollout?.stage ?? 0;
        const currentStage = baseline.stages.find((entry) => entry.order === stage) ?? baseline.stages[0];
        if (!currentStage) continue;
        baselineData.push({ baselineId: baseline.id, stages: [currentStage] });
      }
      if (baselineData.length === 0) continue;
      const jobId = randomUUID();
      const subOutputRef = `baselines/${id}/${jobId}`;
      const subEnvelope = {
        ...envelope,
        jobId,
        tenantId: id,
        runId,
        payload: {
          ...(envelope.payload as Record<string, unknown>),
          outputRef: subOutputRef,
          baselines: baselineData,
          currentState,
        },
      };
      const result = await superviseJob(subEnvelope, {
        workerScriptPath: path.join(workersDir, "run-baseline.ps1"),
        storageRoot,
        signal,
      });
      await ingestBaselineEvaluation(subEnvelope, result, { baselines, storageRoot });
      lastResult = result;
    }
    return lastResult;
  };
}

export const BASELINE_EVALUATION_ARTIFACT = "baseline-evaluation.json";

export interface BaselineIngestionOptions {
  readonly baselines: Pick<SqliteBaselinesRepository, "upsertRollout" | "appendHistory" | "appendTrend">;
  readonly storageRoot: string;
}

/**
 * Writes a succeeded baseline evaluation's rollout, history event, and trend
 * point per baseline. The rollout state follows the stage state machine
 * (active / eligible / complete); history and trend come from the shared
 * record builder. A missing artifact is not an error: a tenant with no
 * baselines writes nothing.
 */
export async function ingestBaselineEvaluation(
  envelope: { tenantId: string; payload: Record<string, unknown> },
  result: ResultEnvelope,
  options: BaselineIngestionOptions,
): Promise<void> {
  if (result.status !== "succeeded") return;
  const outputRef = typeof envelope.payload["outputRef"] === "string" ? envelope.payload["outputRef"] : "";
  if (!outputRef) return;
  const raw = await readFile(path.resolve(options.storageRoot, outputRef, BASELINE_EVALUATION_ARTIFACT), "utf8");
  const evaluations = JSON.parse(raw) as ReadonlyArray<{
    BaselineId: string;
    StageResults: ReadonlyArray<{
      order: number;
      evaluated: number;
      mismatched: number;
      compliant: boolean;
    }>;
    RunAt: string;
  }>;
  for (const evaluation of evaluations) {
    const stageResult = evaluation.StageResults[0];
    if (!stageResult) continue;
    const { history, trend } = buildEvaluationRecords({
      baselineId: evaluation.BaselineId,
      tenantId: envelope.tenantId,
      stage: stageResult.order,
      satisfied: stageResult.evaluated - stageResult.mismatched,
      evaluated: stageResult.evaluated,
      state: stageResult.compliant ? "eligible" : "active",
      at: evaluation.RunAt,
    });
    await options.baselines.upsertRollout({
      baselineId: evaluation.BaselineId,
      tenantId: envelope.tenantId,
      stage: stageResult.order,
      state: stageResult.compliant ? "eligible" : "active",
      lastRunAt: evaluation.RunAt,
    });
    await options.baselines.appendHistory({ id: randomUUID(), ...history });
    await options.baselines.appendTrend(trend);
  }
}
