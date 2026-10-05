// EPIC-006 remediation and EPIC-007 schedules and scripts on real storage (T-0824).
//
// Plans, schedules, and scripts persist through the db repositories, which already
// match the route stores.
//
// Remediation plan jobs run plan-remediation.ps1 through the job queue's dispatcher and
// apply-remediation.ps1 the same way and store each action's result (T-0838). Verify
// jobs run verify-remediation.ps1 and store the outcome on the action (T-0839).
// Scheduled assessment jobs run through the same queue with a run record and a
// context.json (T-0840). Custom scripts run in the T-0126 sandbox through
// run-custom-script.ps1 (T-0837).
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  remediationPlanFromWorkerOutput,
  toManualInstructionView,
  toRemediationActionView,
  type RemediationActionUpdate,
  type RemediationRepository,
  type Schedule,
  type ScheduleRepository,
  type SqliteRepository,
} from "@m365-assess/db";
import type { JobEnvelope, JobType } from "@m365-assess/contracts";
import type Database from "better-sqlite3";
import { AppError } from "../errors.js";
import type { RemediationApplyHandle, RemediationIdempotencyStore } from "../domain/remediation/apply.js";
import type { JobQueue, RunWorkerFn } from "../jobs/queue.js";
import { WorkerResultError, superviseJob, type SuperviseJobOptions } from "../jobs/supervisor.js";
import type { RemediationPlanStore, RemediationQueue } from "../routes/remediation.js";
import type { CredentialStoreRow } from "../routes/credentials.js";
import type {
  ScheduleHistoryStore,
  ScheduleRunOutcome,
  ScheduleRunQueue,
  ScheduleStore,
} from "../routes/schedules.js";
import type { ScriptSandbox, ScriptSandboxResult } from "../routes/scripts.js";
import type { CustomTestDispatcher, CustomTestWorkerOutput } from "../custom-tests/run.js";
import type { TickSchedule, TickScheduleStore } from "../scheduler/tick.js";
import type { TenantStore } from "../routes/tenants.js";
import { NO_CREDENTIAL, toCredentialBlock, type CredentialBlock, type WorkerRunner } from "./workers.js";

export { NO_CREDENTIAL };

export const JOB_DISPATCH_UNAVAILABLE = "jobs.dispatch_unavailable";

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
export const VERIFY_WORKER = "verify-remediation.ps1";
export const REMEDIATION_OUTPUT_UNREADABLE = "remediation.output_unreadable";
export const REMEDIATION_APPLY_NO_PLAN = "remediation.apply_no_plan";
const PLAN_FILE = "remediation-plan.json";
const APPLY_FILE = "remediation-apply.json";
const VERIFY_FILE = "remediation-verify.json";
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
 * credential. Apply and verify jobs sign in to the tenant, so their job file carries
 * the credential block (toCredentialBlock, T-0826); apply also carries the plan job's
 * folder, where the stored plan artifact lives.
 */
export function createRemediationQueue(options: RemediationQueueOptions): RemediationQueue {
  const { jobs, repo, credentials, storageRoot } = options;
  return {
    async enqueue(envelope) {
      const operation = operationOf(envelope);
      if (operation !== "plan" && operation !== "apply" && operation !== "verify") {
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
      if (operation === "apply") {
        const apply = await prepareApplyJob(envelope, repo, credentials);
        await writeFile(
          path.resolve(storageRoot, envelope.payload.contextRef),
          JSON.stringify({ ...apply.envelope, credential: apply.credential }),
          { mode: 0o600 },
        );
        return jobs.enqueue(apply.envelope);
      }
      const verify = await prepareVerifyJob(envelope, credentials);
      await writeFile(
        path.resolve(storageRoot, envelope.payload.contextRef),
        JSON.stringify({ ...verify.envelope, credential: verify.credential }),
        { mode: 0o600 },
      );
      return jobs.enqueue(verify.envelope);
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

/**
 * Resolves the tenant's credential block for a verify job. Verify re-reads tenant
 * state, so it signs in like apply; it carries no plan reference.
 */
async function prepareVerifyJob(
  envelope: JobEnvelope,
  credentials: CredentialStoreRow,
): Promise<{ envelope: JobEnvelope; credential: CredentialBlock }> {
  const credential = await credentials.getCredential(envelope.tenantId);
  if (!credential) {
    throw new AppError(
      NO_CREDENTIAL,
      `tenant '${envelope.tenantId}' has no credential; set one before verifying remediation`,
      409,
    );
  }
  return { envelope, credential: toCredentialBlock(credential) };
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

/** verify-remediation.ps1 reads the job file and writes its result to its own folder. */
export function buildVerifyWorkerArgs(envelope: JobEnvelope, workerScriptPath: string): string[] {
  return [
    "-NoProfile",
    "-NonInteractive",
    "-File",
    workerScriptPath,
    "-JobFile",
    envelope.payload.contextRef,
    "-OutputFolder",
    envelope.payload.outputRef,
  ];
}

export type RemediationWorkerOptions = Omit<SuperviseJobOptions, "signal" | "workerScriptPath" | "buildArgs"> & {
  readonly workersDir: string;
};

/** The remediation runner for the job dispatcher: plan, apply, and verify jobs (see the file header). */
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
    if (operation === "verify") {
      return superviseJob(envelope, {
        ...supervise,
        workerScriptPath: path.join(workersDir, VERIFY_WORKER),
        buildArgs: buildVerifyWorkerArgs,
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

export interface RemediationVerifyIngestionOptions {
  readonly remediation: Pick<RemediationRepository, "updateRemediationAction">;
  readonly storageRoot: string;
}

/**
 * Stores a succeeded verify job's outcome on its action before the queue reports the
 * job finished, so the plan and history routes serve it. The verify worker captures
 * the action update through the verify seams; output that is missing or malformed
 * fails the job, mirroring the apply ingestion.
 */
export function withRemediationVerifyIngestion(runWorker: RunWorkerFn, options: RemediationVerifyIngestionOptions): RunWorkerFn {
  const { remediation, storageRoot } = options;
  return async (envelope, signal) => {
    const result = await runWorker(envelope, signal);
    if (envelope.jobType !== "remediation" || operationOf(envelope) !== "verify" || result.status !== "succeeded") {
      return result;
    }
    try {
      const file = path.resolve(storageRoot, envelope.payload.outputRef, VERIFY_FILE);
      const output = JSON.parse(await readFile(file, "utf8")) as Record<string, unknown>;
      const actionId = output["ActionId"];
      if (typeof actionId !== "string" || actionId === "") throw new Error("the verify job has no ActionId");
      const updates = Array.isArray(output["ActionUpdates"]) ? (output["ActionUpdates"] as unknown[]) : [];
      for (const item of updates) {
        const record = (item ?? {}) as Record<string, unknown>;
        const update = record["update"] as Record<string, unknown> | undefined;
        if (!update) continue;
        const state = update["state"];
        if (state !== "applied" && state !== "failed" && state !== "skipped") continue;
        const actionUpdate: RemediationActionUpdate = { state };
        const error = update["error"];
        if (error !== undefined) actionUpdate.error = error as string | null;
        const appliedAt = update["appliedAt"];
        if (typeof appliedAt === "string" && appliedAt !== "") actionUpdate.appliedAt = appliedAt;
        const appliedBy = update["appliedBy"];
        if (typeof appliedBy === "string" && appliedBy !== "") actionUpdate.appliedBy = appliedBy;
        const updateResult = update["result"];
        if (updateResult !== undefined) actionUpdate.result = updateResult as Record<string, unknown> | null;
        if (envelope.correlationId) actionUpdate.correlationId = envelope.correlationId;
        await remediation.updateRemediationAction(actionId, actionUpdate);
      }
      return result;
    } catch (error) {
      const message = `remediation verify output unreadable: ${error instanceof Error ? error.message : String(error)}`;
      return { ...result, status: "failed", error: { code: REMEDIATION_OUTPUT_UNREADABLE, message, retryable: false } };
    }
  };
}

export interface ScheduleRunQueueOptions {
  readonly jobs: Pick<JobQueue, "enqueue">;
  readonly repo: Pick<SqliteRepository, "createRun" | "updateRun">;
  readonly storageRoot: string;
  readonly tenants: TenantStore;
  readonly credentials: CredentialStoreRow;
  /** Job types with a runner on the dispatcher; enqueuing any other type is refused with 501. */
  readonly runnableTypes: ReadonlySet<JobType>;
}

/**
 * Scheduled runs: an assessment job gets a run record and a context.json (run-tenant.ps1
 * rebuilds its RunContext from it), then enqueues through the job queue. A schedule type
 * with no runner on the dispatcher is refused with 501 before anything is enqueued.
 */
export function createScheduleRunQueue(options: ScheduleRunQueueOptions): ScheduleRunQueue {
  const { jobs, repo, storageRoot, tenants, credentials, runnableTypes } = options;

  async function failRun(envelope: JobEnvelope, message: string): Promise<string> {
    const now = new Date().toISOString();
    await repo.updateRun(envelope.tenantId, envelope.runId, {
      status: "failed",
      finishedAt: now,
      updatedAt: now,
      summaryCounts: { error: message },
    });
    return envelope.jobId;
  }

  return {
    async enqueue(envelopeInput) {
      const envelope = envelopeInput as JobEnvelope & { readonly scheduleId?: string };
      if (!runnableTypes.has(envelope.jobType)) {
        throw unavailable(
          JOB_DISPATCH_UNAVAILABLE,
          `no worker is registered for ${envelope.jobType} jobs`,
        );
      }
      if (envelope.jobType === "assessment") {
        const now = new Date().toISOString();
        const provenance: Record<string, unknown> = {
          jobId: envelope.jobId,
          correlationId: envelope.correlationId,
        };
        if (envelope.scheduleId !== undefined) provenance["scheduleId"] = envelope.scheduleId;
        await repo.createRun({
          id: envelope.runId,
          tenantId: envelope.tenantId,
          parentRunId: null,
          trigger: "schedule",
          sections: [...envelope.payload.sectionRefs],
          options: null,
          startedAt: null,
          finishedAt: null,
          status: "queued",
          artifactPath: envelope.payload.outputRef,
          summaryCounts: null,
          provenance,
          createdAt: now,
          updatedAt: now,
        });
        const credential = await credentials.getCredential(envelope.tenantId);
        if (!credential) {
          return failRun(envelope, `tenant ${envelope.tenantId} has no credential; set one before running an assessment`);
        }
        if (credential.authMethod !== "certificate-thumbprint" || !credential.thumbprint) {
          return failRun(envelope, `assessment runs need a certificate-thumbprint credential; ${credential.authMethod} is not supported yet`);
        }
        const tenant = await tenants.getTenant(envelope.tenantId);
        const context = {
          SchemaVersion: 1,
          Tenant: {
            TenantId: envelope.tenantId,
            DisplayName: tenant?.displayName ?? null,
            DefaultDomain: tenant?.defaultDomain ?? null,
            InitialDomain: tenant?.initialDomain ?? null,
          },
          Auth: {
            Method: "Certificate",
            ClientId: credential.clientId,
            CertificateThumbprint: credential.thumbprint,
            M365Environment: credential.environment,
          },
          Scope: { Sections: [...envelope.payload.sectionRefs] },
          Output: { OutputFolder: path.resolve(storageRoot, envelope.payload.outputRef) },
        };
        const contextPath = path.resolve(storageRoot, envelope.payload.contextRef);
        await mkdir(path.dirname(contextPath), { recursive: true });
        await writeFile(contextPath, JSON.stringify(context), { mode: 0o600 });
      }
      return jobs.enqueue(envelope);
    },
  };
}

/**
 * Refuses to save a schedule whose type has no runner on the dispatcher, so a task that
 * can never run is rejected at save time instead of failing silently at run time.
 */
export function createRunnerValidatingScheduleStore(
  store: ScheduleStore,
  runnableTypes: ReadonlySet<JobType>,
): ScheduleStore {
  return {
    listSchedules: (options) => store.listSchedules(options),
    getSchedule: (scheduleId, options) => store.getSchedule(scheduleId, options),
    softDeleteSchedule: (scheduleId, options) => store.softDeleteSchedule(scheduleId, options),
    async createSchedule(input) {
      if (!runnableTypes.has(input.type as JobType)) {
        throw unavailable(JOB_DISPATCH_UNAVAILABLE, `no worker is registered for ${input.type} jobs`);
      }
      return store.createSchedule(input);
    },
    async updateSchedule(scheduleId, patch) {
      if (patch.type !== undefined && !runnableTypes.has(patch.type as JobType)) {
        throw unavailable(JOB_DISPATCH_UNAVAILABLE, `no worker is registered for ${patch.type} jobs`);
      }
      return store.updateSchedule(scheduleId, patch);
    },
  };
}

export interface ScheduleJobStateStore {
  /** Whether the schedule has a job in flight (queued or running). */
  isRunning(scheduleId: string): Promise<boolean>;
  /** The newest terminal job's finish time for the schedule, if any. */
  lastFinishedJob(scheduleId: string): Promise<{ readonly finishedAt: string } | undefined>;
}

function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (c) => `\\${c}`);
}

/**
 * Reads a schedule's job state from the jobs table: the queue persists only the envelope
 * payload, whose outputRef sits under `schedules/<scheduleId>/` (buildScheduledEnvelope).
 */
export function createScheduleJobStateStore(db: Database.Database): ScheduleJobStateStore {
  return {
    async isRunning(scheduleId) {
      const row = db
        .prepare(
          `SELECT 1 AS one FROM jobs
           WHERE json_extract(payload, '$.outputRef') LIKE ? ESCAPE '\\'
             AND state IN ('queued', 'running')
           LIMIT 1`,
        )
        .get(`schedules/${escapeLike(scheduleId)}/%`);
      return row !== undefined;
    },
    async lastFinishedJob(scheduleId) {
      const row = db
        .prepare(
          `SELECT updatedAt FROM jobs
           WHERE json_extract(payload, '$.outputRef') LIKE ? ESCAPE '\\'
             AND state IN ('done', 'failed')
           ORDER BY updatedAt DESC
           LIMIT 1`,
        )
        .get(`schedules/${escapeLike(scheduleId)}/%`) as { updatedAt: string } | undefined;
      return row === undefined ? undefined : { finishedAt: row.updatedAt };
    },
  };
}

function toTickSchedule(schedule: Schedule): TickSchedule {
  return {
    id: schedule.id,
    type: schedule.type,
    cron: schedule.cron,
    timezone: schedule.timezone,
    targetScope: schedule.targetScope,
    enabled: schedule.enabled,
    lastRunAt: schedule.lastRunAt,
    nextRunAt: schedule.nextRunAt,
  };
}

/** Adapts the schedule repository to the scheduler tick's store seam. */
export function createTickScheduleStore(repo: ScheduleRepository): TickScheduleStore {
  return {
    async listSchedules() {
      const schedules = await repo.listSchedules();
      return schedules.filter((schedule) => schedule.deletedAt === null).map(toTickSchedule);
    },
    async getSchedule(scheduleId) {
      const schedule = await repo.getSchedule(scheduleId);
      return schedule !== undefined && schedule.deletedAt === null ? toTickSchedule(schedule) : undefined;
    },
    async updateSchedule(scheduleId, patch) {
      await repo.updateSchedule(scheduleId, { ...patch });
    },
  };
}

export const CUSTOM_SCRIPT_WORKER = "run-custom-script.ps1";

export interface ScriptSandboxOptions {
  readonly run: WorkerRunner;
}

/**
 * Custom script sandbox: runs a script version through run-custom-script.ps1, which
 * executes it in the T-0126 sandbox and returns output, exit code, and duration.
 * The dry-run contract is enforced by the route (T-0127); the worker passes the
 * dryRun flag through so the script can honour it.
 */
export function createScriptSandbox(options: ScriptSandboxOptions): ScriptSandbox {
  const { run } = options;
  return {
    async run(input) {
      const result = await run<ScriptSandboxResult>(CUSTOM_SCRIPT_WORKER, {
        content: input.content,
        tenantId: input.tenantId,
        dryRun: input.dryRun,
        parameters: input.parameters,
      });
      return {
        output: result.output,
        exitCode: result.exitCode,
        error: result.error ?? null,
        durationMs: result.durationMs ?? null,
      };
    },
  };
}

/**
 * Real custom-test dispatcher (T-0889): executes the version through the T-0126
 * sandbox worker (run-custom-script.ps1) and maps its exit code to a test status.
 * The route must inject this at the composition root; runCustomTest refuses to
 * run without a dispatcher so a missing binding can never fabricate a Pass.
 */
export function createCustomTestDispatcher(options: ScriptSandboxOptions): CustomTestDispatcher {
  const { run } = options;
  return async (_envelope, data): Promise<CustomTestWorkerOutput> => {
    const result = await run<ScriptSandboxResult>(CUSTOM_SCRIPT_WORKER, {
      content: data.scriptContent,
      tenantId: data.tenantId,
      dryRun: data.dryRun,
      parameters: data.parameters ?? null,
    });
    const status: CustomTestWorkerOutput["status"] =
      result.error && result.exitCode !== 0 ? "Error" : result.exitCode === 0 ? "Pass" : "Fail";
    return {
      success: status === "Pass",
      status,
      output: result.output,
      renderedMarkdown: data.markdownTemplate
        ? data.markdownTemplate.replace(/\{\{\s*status\s*\}\}/g, status)
        : result.output,
      dryRun: data.dryRun,
      exitCode: result.exitCode,
      error: result.error ?? null,
      durationMs: result.durationMs ?? null,
    };
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
