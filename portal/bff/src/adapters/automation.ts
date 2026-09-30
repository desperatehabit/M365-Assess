// EPIC-006 remediation and EPIC-007 schedules and scripts on real storage (T-0824).
//
// Plans, schedules, and scripts persist through the db repositories, which already
// match the route stores.
//
// Remediation plan jobs run plan-remediation.ps1 through the job queue's dispatcher and
// their plans are stored when the job succeeds (T-0836). Apply jobs run
// apply-remediation.ps1 the same way and store each action's result (T-0838). Still
// not wired, and refused with 501 before anything is enqueued or run:
//
// - Remediation verify (T-0839).
// - Schedule run-now (T-0840).
// - Custom scripts, which run in the T-0126 sandbox with no worker entrypoint (T-0837).
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  remediationPlanFromWorkerOutput,
  toManualInstructionView,
  toRemediationActionView,
  type RemediationActionUpdate,
  type RemediationRepository,
  type SqliteRepository,
} from "@m365-assess/db";
import type { JobEnvelope } from "@m365-assess/contracts";
import type Database from "better-sqlite3";
import { AppError } from "../errors.js";
import type { RemediationApplyHandle, RemediationIdempotencyStore } from "../domain/remediation/apply.js";
import type { JobQueue, RunWorkerFn } from "../jobs/queue.js";
import { WorkerResultError, superviseJob, type SuperviseJobOptions } from "../jobs/supervisor.js";
import type { RemediationPlanStore, RemediationQueue } from "../routes/remediation.js";
import type { CredentialStoreRow } from "../routes/credentials.js";
import type { ScheduleHistoryStore, ScheduleRunOutcome, ScheduleRunQueue } from "../routes/schedules.js";
import type { ScriptSandbox } from "../routes/scripts.js";
import { NO_CREDENTIAL, toCredentialBlock, type CredentialBlock } from "./workers.js";

export { NO_CREDENTIAL };

export const JOB_DISPATCH_UNAVAILABLE = "jobs.dispatch_unavailable";
export const SCRIPT_SANDBOX_UNAVAILABLE = "scripts.sandbox_unavailable";

function unavailable(code: string, message: string): AppError {
  return new AppError(code, message, 501);
}

/** Remediation reads; the db package renames each action's check reference for the routes. */
export function createRemediationStore(repo: RemediationRepository): RemediationPlanStore {
  return {
    getRemediationPlan: (planId) => repo.getRemediationPlan(planId),
    listRemediationActions: async (planId) => (await repo.listRemediationActions(planId)).map(toRemediationActionView),
    async getRemediationAction(actionId) {
      const action = await repo.getRemediationAction(actionId);
      return action ? toRemediationActionView(action) : undefined;
    },
    listRemediationActionsForTenant: async (tenantId) =>
      (await repo.listRemediationActionsForTenant(tenantId)).map(toRemediationActionView),
    async getManualInstruction(check) {
      const instruction = await repo.getManualInstruction(check);
      return instruction ? toManualInstructionView(instruction) : undefined;
    },
  };
}

export const PLAN_WORKER = "plan-remediation.ps1";
export const APPLY_WORKER = "apply-remediation.ps1";
export const REMEDIATION_OUTPUT_UNREADABLE = "remediation.output_unreadable";
export const REMEDIATION_APPLY_NO_PLAN = "remediation.apply_no_plan";
const PLAN_FILE = "remediation-plan.json";
const APPLY_FILE = "remediation-apply.json";
const FINDINGS_FILE = "findings.json";

function operationOf(envelope: JobEnvelope): unknown {
  return (envelope.payload as unknown as Record<string, unknown>)["operation"];
}

export interface RemediationQueueOptions {
  readonly jobs: Pick<JobQueue, "enqueue">;
  readonly repo: Pick<SqliteRepository, "listFindings" | "listJobs">;
  readonly credentials: CredentialStoreRow;
  readonly storageRoot: string;
}

/**
 * Plan jobs: writes the job file and the run's findings into the job's folder, then
 * enqueues. The plan worker makes no tenant calls, so the job file carries no
 * credential. Apply jobs sign in to the tenant, so their job file carries the
 * credential block (toCredentialBlock, T-0826) and the plan job's folder, where the
 * stored plan artifact lives. Verify is refused until its worker is wired (T-0839).
 */
export function createRemediationQueue(options: RemediationQueueOptions): RemediationQueue {
  const { jobs, repo, credentials, storageRoot } = options;
  return {
    async enqueue(envelope) {
      const operation = operationOf(envelope);
      if (operation !== "plan" && operation !== "apply") {
        throw unavailable(
          JOB_DISPATCH_UNAVAILABLE,
          `remediation ${String(operation)} jobs cannot run yet: no worker dispatch for them`,
        );
      }
      const folder = path.resolve(storageRoot, envelope.payload.outputRef);
      await mkdir(folder, { recursive: true, mode: 0o700 });
      if (operation === "plan") {
        const findings = await repo.listFindings(envelope.tenantId, envelope.runId);
        await writeFile(path.join(folder, FINDINGS_FILE), JSON.stringify(findings), { mode: 0o600 });
        await writeFile(path.resolve(storageRoot, envelope.payload.contextRef), JSON.stringify(envelope), { mode: 0o600 });
        return jobs.enqueue(envelope);
      }
      const apply = await prepareApplyJob(envelope, repo, credentials);
      await writeFile(
        path.resolve(storageRoot, envelope.payload.contextRef),
        JSON.stringify({ ...apply.envelope, credential: apply.credential }),
        { mode: 0o600 },
      );
      return jobs.enqueue(apply.envelope);
    },
  };
}

/**
 * Resolves the plan job's folder for an apply job and the tenant's credential block.
 * The apply worker reads the plan from the plan job's output folder, so the apply
 * envelope carries that folder as `planOutputRef` for the runner to pass as -PlanFile.
 */
async function prepareApplyJob(
  envelope: JobEnvelope,
  repo: Pick<SqliteRepository, "listJobs">,
  credentials: CredentialStoreRow,
): Promise<{ envelope: JobEnvelope; credential: CredentialBlock }> {
  const payload = envelope.payload as unknown as Record<string, unknown>;
  const planId = typeof payload["planId"] === "string" ? payload["planId"] : "";
  if (planId === "") {
    throw new AppError(REMEDIATION_APPLY_NO_PLAN, "the apply job has no planId", 409);
  }
  const planJob = (await repo.listJobs(envelope.tenantId)).find((job) => {
    const jobPayload = (job.payload ?? {}) as Record<string, unknown>;
    return jobPayload["planId"] === planId && jobPayload["operation"] === "plan";
  });
  const planOutputRef = planJob?.payload?.["outputRef"];
  if (typeof planOutputRef !== "string" || planOutputRef === "") {
    throw new AppError(REMEDIATION_APPLY_NO_PLAN, `no stored plan job for plan ${planId}`, 409);
  }
  const credential = await credentials.getCredential(envelope.tenantId);
  if (!credential) {
    throw new AppError(
      NO_CREDENTIAL,
      `tenant '${envelope.tenantId}' has no credential; set one before applying remediation`,
      409,
    );
  }
  const extra: Record<string, unknown> = { planOutputRef };
  return {
    envelope: { ...envelope, payload: { ...envelope.payload, ...extra } },
    credential: toCredentialBlock(credential),
  };
}

/** plan-remediation.ps1 reads the job file and findings from the job's folder. */
export function buildPlanWorkerArgs(envelope: JobEnvelope, workerScriptPath: string): string[] {
  return [
    "-NoProfile",
    "-NonInteractive",
    "-File",
    workerScriptPath,
    "-JobFile",
    envelope.payload.contextRef,
    "-OutputFolder",
    envelope.payload.outputRef,
    "-FindingsFile",
    path.posix.join(envelope.payload.outputRef, FINDINGS_FILE),
  ];
}

/**
 * apply-remediation.ps1 reads the job file and the plan from the plan job's folder
 * (the apply envelope carries it as `planOutputRef`), then writes its results to its
 * own folder as `remediation-apply.json`.
 */
export function buildApplyWorkerArgs(envelope: JobEnvelope, workerScriptPath: string): string[] {
  const payload = envelope.payload as unknown as Record<string, unknown>;
  const planOutputRef = typeof payload["planOutputRef"] === "string" ? payload["planOutputRef"] : "";
  return [
    "-NoProfile",
    "-NonInteractive",
    "-File",
    workerScriptPath,
    "-JobFile",
    envelope.payload.contextRef,
    "-OutputFolder",
    envelope.payload.outputRef,
    "-PlanFile",
    path.posix.join(planOutputRef, PLAN_FILE),
  ];
}

export type RemediationWorkerOptions = Omit<SuperviseJobOptions, "signal" | "workerScriptPath" | "buildArgs"> & {
  readonly workersDir: string;
};

/** The remediation runner for the job dispatcher: plan and apply jobs (see the file header). */
export function createRemediationWorkerRunner(options: RemediationWorkerOptions): RunWorkerFn {
  const { workersDir, ...supervise } = options;
  return async (envelope, signal) => {
    const operation = operationOf(envelope);
    if (operation === "plan") {
      return superviseJob(envelope, {
        ...supervise,
        workerScriptPath: path.join(workersDir, PLAN_WORKER),
        buildArgs: buildPlanWorkerArgs,
        signal,
      });
    }
    if (operation === "apply") {
      return superviseJob(envelope, {
        ...supervise,
        workerScriptPath: path.join(workersDir, APPLY_WORKER),
        buildArgs: buildApplyWorkerArgs,
        signal,
      });
    }
    throw new WorkerResultError(JOB_DISPATCH_UNAVAILABLE, `no worker runs remediation ${String(operation)} jobs`);
  };
}

export interface RemediationIngestionOptions {
  readonly remediation: Pick<RemediationRepository, "createRemediationPlan" | "getRemediationPlan" | "upsertManualInstruction">;
  readonly storageRoot: string;
}

/**
 * Stores a succeeded plan job's plan, actions, and manual instructions before the
 * queue reports the job finished. Output that is missing or malformed fails the job.
 */
export function withRemediationPlanIngestion(runWorker: RunWorkerFn, options: RemediationIngestionOptions): RunWorkerFn {
  const { remediation, storageRoot } = options;
  return async (envelope, signal) => {
    const result = await runWorker(envelope, signal);
    if (envelope.jobType !== "remediation" || operationOf(envelope) !== "plan" || result.status !== "succeeded") {
      return result;
    }
    const payload = envelope.payload as unknown as Record<string, unknown>;
    try {
      const planId = payload["planId"];
      if (typeof planId !== "string" || planId === "") throw new Error("the plan job has no planId");
      const file = path.resolve(storageRoot, envelope.payload.outputRef, PLAN_FILE);
      const { plan, instructions } = remediationPlanFromWorkerOutput(await readFile(file, "utf8"), {
        planId,
        tenantId: envelope.tenantId,
        runId: envelope.runId,
        createdBy: typeof payload["createdBy"] === "string" ? payload["createdBy"] : "system",
      });
      // A retried job must not fail on the plan its first attempt stored.
      if (!(await remediation.getRemediationPlan(planId))) await remediation.createRemediationPlan(plan);
      for (const instruction of instructions) await remediation.upsertManualInstruction(instruction);
      return result;
    } catch (error) {
      const message = `remediation plan output unreadable: ${error instanceof Error ? error.message : String(error)}`;
      return { ...result, status: "failed", error: { code: REMEDIATION_OUTPUT_UNREADABLE, message, retryable: false } };
    }
  };
}

export interface RemediationApplyIngestionOptions {
  readonly remediation: Pick<RemediationRepository, "updateRemediationAction">;
  readonly storageRoot: string;
}

/**
 * Stores a succeeded apply job's per-action results before the queue reports the job
 * finished, so the plan and history routes serve them. Dry runs change no action
 * state: their results carry `dryRun: true` and are skipped. Output that is missing
 * or malformed fails the job, mirroring the plan ingestion.
 */
export function withRemediationApplyIngestion(runWorker: RunWorkerFn, options: RemediationApplyIngestionOptions): RunWorkerFn {
  const { remediation, storageRoot } = options;
  return async (envelope, signal) => {
    const result = await runWorker(envelope, signal);
    if (envelope.jobType !== "remediation" || operationOf(envelope) !== "apply" || result.status !== "succeeded") {
      return result;
    }
    try {
      const file = path.resolve(storageRoot, envelope.payload.outputRef, APPLY_FILE);
      const output = JSON.parse(await readFile(file, "utf8")) as Record<string, unknown>;
      const results = Array.isArray(output["Results"]) ? (output["Results"] as unknown[]) : [];
      for (const item of results) {
        const record = (item ?? {}) as Record<string, unknown>;
        if (record["dryRun"] === true) continue;
        const actionId = record["actionId"];
        if (typeof actionId !== "string" || actionId === "") continue;
        const state = record["state"];
        if (state !== "applied" && state !== "failed" && state !== "skipped") continue;
        const update: RemediationActionUpdate = { state };
        const before = record["before"];
        if (before !== undefined) update.before = before as Record<string, unknown> | null;
        const after = record["after"];
        if (after !== undefined) update.after = after as Record<string, unknown> | null;
        const appliedAt = record["appliedAt"];
        if (typeof appliedAt === "string" && appliedAt !== "") update.appliedAt = appliedAt;
        const actor = record["actor"];
        if (typeof actor === "string" && actor !== "") update.appliedBy = actor;
        const applyResult = record["result"];
        if (applyResult !== undefined) update.result = applyResult as Record<string, unknown> | null;
        const error = record["error"];
        if (typeof error === "string" && error !== "") update.error = error;
        if (envelope.correlationId) update.correlationId = envelope.correlationId;
        await remediation.updateRemediationAction(actionId, update);
      }
      return result;
    } catch (error) {
      const message = `remediation apply output unreadable: ${error instanceof Error ? error.message : String(error)}`;
      return { ...result, status: "failed", error: { code: REMEDIATION_OUTPUT_UNREADABLE, message, retryable: false } };
    }
  };
}

export function createUnavailableScheduleQueue(): ScheduleRunQueue {
  return {
    async enqueue() {
      throw unavailable(JOB_DISPATCH_UNAVAILABLE, "scheduled jobs cannot run yet: no worker dispatch for scheduled jobs");
    },
  };
}

export function createUnavailableScriptSandbox(): ScriptSandbox {
  return {
    async run() {
      throw unavailable(SCRIPT_SANDBOX_UNAVAILABLE, "custom scripts cannot run yet: the script sandbox has no worker entrypoint");
    },
  };
}

interface JobRow {
  readonly id: string;
  readonly state: string;
  readonly progress: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

const OUTCOME_BY_QUEUE_STATE: Readonly<Record<string, ScheduleRunOutcome>> = {
  queued: "queued",
  running: "running",
  succeeded: "succeeded",
  failed: "failed",
  cancelled: "cancelled",
  done: "succeeded",
};

/**
 * A schedule's runs are the jobs it enqueued. The queue persists only the envelope's
 * payload, whose refs sit under `schedules/<scheduleId>/` (buildScheduledEnvelope).
 */
export function createScheduleHistoryStore(db: Database.Database): ScheduleHistoryStore {
  return {
    async listScheduleRuns(scheduleId) {
      const rows = db
        .prepare(
          `SELECT id, state, progress, createdAt, updatedAt FROM jobs
            WHERE json_extract(payload, '$.outputRef') LIKE ? ESCAPE '\\'
            ORDER BY createdAt DESC`,
        )
        .all(`schedules/${scheduleId.replace(/[\\%_]/g, (c) => `\\${c}`)}/%`) as JobRow[];
      return rows.map((row) => {
        const progress = row.progress ? (JSON.parse(row.progress) as Record<string, unknown>) : {};
        const queueState = typeof progress["queueState"] === "string" ? progress["queueState"] : row.state;
        const outcome = OUTCOME_BY_QUEUE_STATE[queueState] ?? "failed";
        const terminal = outcome !== "queued" && outcome !== "running";
        const error = progress["error"];
        return {
          runId: typeof progress["runId"] === "string" ? progress["runId"] : row.id,
          jobId: row.id,
          scheduleId,
          startedAt: row.createdAt,
          finishedAt: terminal ? row.updatedAt : null,
          outcome,
          error: typeof error === "string" ? error : error && typeof error === "object" ? JSON.stringify(error) : null,
        };
      });
    },
  };
}

/**
 * The apply Idempotency-Key store backed by the jobs table, so a replay returns the
 * prior handle instead of enqueuing a second apply even after a BFF restart. The
 * enqueued job row already carries the key in its payload, so `save` writes nothing
 * and `find` reads the row back. The jobs table does not persist the request id, so a
 * replayed handle carries an empty `requestId`; the job id is what the client polls.
 */
export function createJobBackedRemediationIdempotencyStore(db: Database.Database): RemediationIdempotencyStore {
  return {
    async find(tenantId, key) {
      const row = db
        .prepare(
          `SELECT id, payload FROM jobs
           WHERE tenantId = ? AND json_extract(payload, '$.idempotencyKey') = ?
           ORDER BY createdAt DESC LIMIT 1`,
        )
        .get(tenantId, key) as { id: string; payload: string | null } | undefined;
      if (!row) return undefined;
      let payload: Record<string, unknown> = {};
      if (row.payload) {
        try {
          const parsed: unknown = JSON.parse(row.payload);
          if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
            payload = parsed as Record<string, unknown>;
          }
        } catch {
          payload = {};
        }
      }
      return {
        planId: typeof payload["planId"] === "string" ? payload["planId"] : "",
        tenantId,
        jobId: row.id,
        requestId: "",
        dryRun: payload["dryRun"] === true,
        status: "queued",
      };
    },
    async save() {
      // The enqueued job row already carries the key in its payload; nothing to write.
    },
  };
}
