import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { SqliteRemediationRepository, SqliteRepository, loadMigrations, runMigrations } from "@m365-assess/db";
import type { JobEnvelope, ResultEnvelope } from "@m365-assess/contracts";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import type { CredentialRecord, CredentialStoreRow } from "../routes/credentials.js";
import {
  JOB_DISPATCH_UNAVAILABLE,
  NO_CREDENTIAL,
  REMEDIATION_APPLY_NO_PLAN,
  REMEDIATION_OUTPUT_UNREADABLE,
  buildApplyWorkerArgs,
  buildPlanWorkerArgs,
  createJobBackedRemediationIdempotencyStore,
  createRemediationQueue,
  createRemediationStore,
  createRemediationWorkerRunner,
  createScheduleHistoryStore,
  createScriptSandbox,
  createUnavailableScheduleQueue,
  withRemediationApplyIngestion,
  withRemediationPlanIngestion,
} from "./automation.js";

const CREDENTIAL: CredentialRecord = {
  id: "c-1",
  tenantId: "t-a",
  authMethod: "certificate-thumbprint",
  clientId: "app-1",
  secretRef: "thumbprint://ABC",
  thumbprint: "ABC",
  environment: "commercial",
  expiresOn: null,
  lastValidated: null,
  createdAt: "",
  updatedAt: "",
};

const credentials: CredentialStoreRow = {
  getCredential: async (tenantId) => (tenantId === "t-a" ? CREDENTIAL : undefined),
  upsertCredential: async (input) => input,
  appendAuditEvent: async () => undefined,
};

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

async function setup() {
  const db = new Database(":memory:");
  const version = runMigrations(db, loadMigrations());
  const repo = new SqliteRepository(db, version, "memory");
  await repo.upsertTenant({ id: "t-a", displayName: null, defaultDomain: null, initialDomain: null, source: "direct", status: "active", excluded: false, lastRunAt: null, errorCount: 0 });
  return { db, version, repo };
}

describe("remediation store (T-0824)", () => {
  it("serves plans and actions with the check reference renamed for the routes", async () => {
    const { db, version, repo } = await setup();
    await repo.createRun({ id: "run-1", tenantId: "t-a", parentRunId: null, trigger: "manual", sections: [], options: null, startedAt: null, finishedAt: null, status: "succeeded", artifactPath: null, summaryCounts: null, provenance: null });
    const remediation = new SqliteRemediationRepository(db, version);
    await remediation.createRemediationPlan({
      id: "plan-1",
      tenantId: "t-a",
      runId: "run-1",
      findingIds: ["f-1"],
      mode: "automated",
      createdBy: "admin",
      actions: [{ id: "act-1", planId: "plan-1", checkId: "CA-1", command: "Set-Thing", target: null, state: "planned" }],
    } as never);
    const store = createRemediationStore(remediation);

    expect(await store.getRemediationPlan("plan-1")).toMatchObject({ id: "plan-1", tenantId: "t-a" });
    const [action] = await store.listRemediationActions("plan-1");
    expect(action).toMatchObject({ id: "act-1", check: "CA-1", state: "planned" });
    expect(await store.getRemediationAction!("act-1")).toMatchObject({ check: "CA-1" });
    expect(await store.listRemediationActionsForTenant!("t-a")).toHaveLength(1);
    expect(await store.getManualInstruction!("missing")).toBeUndefined();
  });
});

describe("schedule history (T-0824)", () => {
  it("lists a schedule's jobs, newest first, from the jobs table", async () => {
    const { db, repo } = await setup();
    const job = (id: string, scheduleId: string, state: "queued" | "done" | "failed", progress: Record<string, unknown>, createdAt: string) =>
      repo.createJob({
        id,
        type: "assessment",
        tenantId: "t-a",
        payload: { contextRef: `schedules/${scheduleId}/context.json`, outputRef: `schedules/${scheduleId}/${id}-run` },
        state,
        attempts: 0,
        progress,
        createdAt,
      });
    await job("j-1", "sch-1", "done", { queueState: "succeeded", runId: "r-1" }, "2026-09-26T01:00:00.000Z");
    await job("j-2", "sch-1", "failed", { queueState: "failed", runId: "r-2", error: "worker.failed" }, "2026-09-26T02:00:00.000Z");
    await job("j-3", "sch-10", "queued", { queueState: "queued" }, "2026-09-26T03:00:00.000Z");

    const runs = await createScheduleHistoryStore(db).listScheduleRuns("sch-1");
    expect(runs.map((r) => [r.jobId, r.runId, r.outcome, r.error])).toEqual([
      ["j-2", "r-2", "failed", "worker.failed"],
      ["j-1", "r-1", "succeeded", null],
    ]);
    expect(runs[0]!.finishedAt).not.toBeNull();
  });
});

describe("unwired execution (T-0824)", () => {
  it("refuses scheduled runs with 501", async () => {
    await expect(createUnavailableScheduleQueue().enqueue({})).rejects.toMatchObject({ status: 501, code: JOB_DISPATCH_UNAVAILABLE });
  });
});

describe("script sandbox (T-0837)", () => {
  it("runs a script version through the worker and maps the result", async () => {
    const calls: { entrypoint: string; job: Record<string, unknown> }[] = [];
    const run = async <T>(entrypoint: string, job: Record<string, unknown>): Promise<T> => {
      calls.push({ entrypoint, job });
      return { output: "hello", exitCode: 0, error: null, durationMs: 42 } as T;
    };
    const sandbox = createScriptSandbox({ run });
    const result = await sandbox.run({ content: "Write-Output 'hello'", tenantId: "t-a", dryRun: true, parameters: { dryRunContract: true } });
    expect(result).toEqual({ output: "hello", exitCode: 0, error: null, durationMs: 42 });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.entrypoint).toBe("run-custom-script.ps1");
    expect(calls[0]!.job).toEqual({ content: "Write-Output 'hello'", tenantId: "t-a", dryRun: true, parameters: { dryRunContract: true } });
  });

  it("maps a worker error to a null error field", async () => {
    const run = async <T>(): Promise<T> => ({ output: "", exitCode: 1, error: "sandbox.policy_violation: disallowed command: Get-Content", durationMs: 7 } as T);
    const sandbox = createScriptSandbox({ run });
    const result = await sandbox.run({ content: "Get-Content /etc/hostname", tenantId: "t-a", dryRun: false, parameters: null });
    expect(result).toEqual({ output: "", exitCode: 1, error: "sandbox.policy_violation: disallowed command: Get-Content", durationMs: 7 });
  });
});

// Written by plan-remediation.ps1 (see the db package's remediation-import test).
const PLAN_FIXTURE = fileURLToPath(new URL("../../../db/src/fixtures/remediation-plan.json", import.meta.url));

function planEnvelope(operation: string, jobId = "job-1"): JobEnvelope {
  return {
    schemaVersion: "v1",
    jobId,
    jobType: "remediation",
    tenantId: "t-a",
    runId: "run-1",
    requestId: "req-1",
    correlationId: "corr-1",
    createdAt: "2026-09-27T00:00:00.000Z",
    payload: {
      contextRef: `remediation/t-a/${jobId}/job.json`,
      outputRef: `remediation/t-a/${jobId}`,
      credentialRef: "tenants/t-a/credential",
      sectionRefs: [],
      artifactRefs: [],
      ...{ operation, planId: "plan-7", createdBy: "user-1" },
    },
  } as JobEnvelope;
}

function succeeded(envelope: JobEnvelope): ResultEnvelope {
  return {
    schemaVersion: "v1",
    jobId: envelope.jobId,
    jobType: envelope.jobType,
    tenantId: envelope.tenantId,
    runId: envelope.runId,
    requestId: envelope.requestId,
    correlationId: envelope.correlationId,
    status: "succeeded",
    startedAt: "2026-09-27T00:00:00.000Z",
    finishedAt: "2026-09-27T00:00:01.000Z",
    exitCode: 0,
    artifactRefs: ["remediation-plan.json"],
  };
}

describe("remediation plan jobs (T-0836)", () => {
  function tempRoot(): string {
    const root = mkdtempSync(path.join(tmpdir(), "m365-remediation-"));
    dirs.push(root);
    return root;
  }

  it("writes the job file and the run's findings, then enqueues a plan job", async () => {
    const { repo } = await setup();
    await repo.createRun({ id: "run-1", tenantId: "t-a", parentRunId: null, trigger: "manual", sections: [], options: null, startedAt: null, finishedAt: null, status: "succeeded", artifactPath: null, summaryCounts: null, provenance: null });
    await repo.replaceRunFindings("t-a", "run-1", [
      { id: "run-1:0", runId: "run-1", tenantId: "t-a", checkId: "X-001.1", controlName: null, category: null, collector: null, status: "Fail", severity: null, currentValue: null, recommendedValue: null, evidence: null, frameworkRefs: [], remediationMode: null },
    ]);
    const root = tempRoot();
    const enqueued: JobEnvelope[] = [];
    const queue = createRemediationQueue({ jobs: { enqueue: async (e) => (enqueued.push(e), e.jobId) }, repo, credentials, storageRoot: root });

    const env = planEnvelope("plan");
    expect(await queue.enqueue(env)).toBe("job-1");
    expect(enqueued).toEqual([env]);
    const folder = path.join(root, "remediation/t-a/job-1");
    expect(JSON.parse(readFileSync(path.join(folder, "job.json"), "utf8"))).toEqual(env);
    expect(JSON.parse(readFileSync(path.join(folder, "findings.json"), "utf8"))).toEqual([
      expect.objectContaining({ id: "run-1:0", status: "Fail" }),
    ]);
    if (process.platform !== "win32") expect(statSync(path.join(folder, "job.json")).mode & 0o777).toBe(0o600);
  });

  it("refuses verify jobs with 501 before enqueueing", async () => {
    const { repo } = await setup();
    const enqueued: JobEnvelope[] = [];
    const queue = createRemediationQueue({ jobs: { enqueue: async (e) => (enqueued.push(e), e.jobId) }, repo, credentials, storageRoot: tempRoot() });
    await expect(queue.enqueue(planEnvelope("verify"))).rejects.toMatchObject({ status: 501, code: JOB_DISPATCH_UNAVAILABLE });
    expect(enqueued).toEqual([]);
  });

  it("runs plan-remediation.ps1 on the job's folder", async () => {
    expect(buildPlanWorkerArgs(planEnvelope("plan"), "/w/plan-remediation.ps1")).toEqual([
      "-NoProfile",
      "-NonInteractive",
      "-File",
      "/w/plan-remediation.ps1",
      "-JobFile",
      "remediation/t-a/job-1/job.json",
      "-OutputFolder",
      "remediation/t-a/job-1",
      "-FindingsFile",
      "remediation/t-a/job-1/findings.json",
    ]);
    const runner = createRemediationWorkerRunner({ workersDir: "/w", storageRoot: tempRoot() });
    await expect(runner(planEnvelope("verify"), new AbortController().signal)).rejects.toMatchObject({ code: JOB_DISPATCH_UNAVAILABLE });
  });

  it("runs apply-remediation.ps1 with the plan job's folder as -PlanFile", async () => {
    const apply = planEnvelope("apply");
    const planOutputRef = "remediation/t-a/plan-job-1";
    const withPlan = { ...apply, payload: { ...apply.payload, ...{ planOutputRef } } };
    expect(buildApplyWorkerArgs(withPlan, "/w/apply-remediation.ps1")).toEqual([
      "-NoProfile",
      "-NonInteractive",
      "-File",
      "/w/apply-remediation.ps1",
      "-JobFile",
      "remediation/t-a/job-1/job.json",
      "-OutputFolder",
      "remediation/t-a/job-1",
      "-PlanFile",
      "remediation/t-a/plan-job-1/remediation-plan.json",
    ]);
  });

  it("stores a succeeded plan job's plan and instructions under the job's plan id", async () => {
    const { db, version, repo } = await setup();
    await repo.createRun({ id: "run-1", tenantId: "t-a", parentRunId: null, trigger: "manual", sections: [], options: null, startedAt: null, finishedAt: null, status: "succeeded", artifactPath: null, summaryCounts: null, provenance: null });
    const remediation = new SqliteRemediationRepository(db, version);
    const root = tempRoot();
    const env = planEnvelope("plan");
    const worker = withRemediationPlanIngestion(
      async (e) => {
        const folder = path.join(root, e.payload.outputRef);
        mkdirSync(folder, { recursive: true });
        copyFileSync(PLAN_FIXTURE, path.join(folder, "remediation-plan.json"));
        return succeeded(e);
      },
      { remediation, storageRoot: root },
    );

    expect(await worker(env, new AbortController().signal)).toMatchObject({ status: "succeeded" });
    expect(await remediation.getRemediationPlan("plan-7")).toMatchObject({ tenantId: "t-a", runId: "run-1", mode: "mixed", createdBy: "user-1" });
    expect(await remediation.listRemediationActions("plan-7")).toHaveLength(3);
    expect(await remediation.getManualInstruction("CA-REPORTONLY-001")).toMatchObject({ portalPath: expect.stringContaining("Conditional Access") });

    // A retry of the same job does not fail on the stored plan.
    expect(await worker(env, new AbortController().signal)).toMatchObject({ status: "succeeded" });
  });

  it("fails a plan job whose output is missing", async () => {
    const { db, version } = await setup();
    const remediation = new SqliteRemediationRepository(db, version);
    const worker = withRemediationPlanIngestion(async (e) => succeeded(e), { remediation, storageRoot: tempRoot() });
    expect(await worker(planEnvelope("plan"), new AbortController().signal)).toMatchObject({
      status: "failed",
      error: { code: REMEDIATION_OUTPUT_UNREADABLE },
    });
    expect(await remediation.getRemediationPlan("plan-7")).toBeUndefined();
  });

  it("writes the apply job file with the credential block and the plan job's folder", async () => {
    const { repo } = await setup();
    await repo.createJob({
      id: "plan-job-1",
      type: "remediation",
      tenantId: "t-a",
      payload: { operation: "plan", planId: "plan-7", outputRef: "remediation/t-a/plan-job-1" },
      state: "done",
      attempts: 1,
      progress: null,
      createdAt: "2026-09-27T00:00:00.000Z",
    });
    const root = tempRoot();
    const enqueued: JobEnvelope[] = [];
    const queue = createRemediationQueue({ jobs: { enqueue: async (e) => (enqueued.push(e), e.jobId) }, repo, credentials, storageRoot: root });

    const env = planEnvelope("apply");
    expect(await queue.enqueue(env)).toBe("job-1");
    expect(enqueued).toHaveLength(1);
    expect(enqueued[0]!.payload).toMatchObject({ planOutputRef: "remediation/t-a/plan-job-1" });

    const jobFile = JSON.parse(readFileSync(path.join(root, "remediation/t-a/job-1", "job.json"), "utf8"));
    expect(jobFile.credential).toEqual({
      credentialRef: "tenants/t-a/credential",
      record: expect.objectContaining({ tenantId: "t-a", clientId: "app-1", thumbprint: "ABC" }),
    });
    expect(jobFile.payload).toMatchObject({ operation: "apply", planId: "plan-7", planOutputRef: "remediation/t-a/plan-job-1" });
  });

  it("refuses an apply whose tenant has no credential", async () => {
    const { repo } = await setup();
    await repo.createJob({
      id: "plan-job-1",
      type: "remediation",
      tenantId: "t-a",
      payload: { operation: "plan", planId: "plan-7", outputRef: "remediation/t-a/plan-job-1" },
      state: "done",
      attempts: 1,
      progress: null,
      createdAt: "2026-09-27T00:00:00.000Z",
    });
    const noCredential: CredentialStoreRow = { ...credentials, getCredential: async () => undefined };
    const queue = createRemediationQueue({ jobs: { enqueue: async () => "" }, repo, credentials: noCredential, storageRoot: tempRoot() });
    await expect(queue.enqueue(planEnvelope("apply"))).rejects.toMatchObject({ status: 409, code: NO_CREDENTIAL });
  });

  it("refuses an apply whose plan job is not stored", async () => {
    const { repo } = await setup();
    const queue = createRemediationQueue({ jobs: { enqueue: async () => "" }, repo, credentials, storageRoot: tempRoot() });
    await expect(queue.enqueue(planEnvelope("apply"))).rejects.toMatchObject({ status: 409, code: REMEDIATION_APPLY_NO_PLAN });
  });

  it("stores a succeeded apply job's action results", async () => {
    const { db, version } = await setup();
    const remediation = new SqliteRemediationRepository(db, version);
    await remediation.createRemediationPlan({
      id: "plan-7",
      tenantId: "t-a",
      runId: "run-1",
      findingIds: ["f-1"],
      mode: "automated",
      createdBy: "user-1",
      actions: [
        { id: "act-1", planId: "plan-7", checkId: "CA-1", command: "Set-Thing", target: null, state: "planned" },
        { id: "act-2", planId: "plan-7", checkId: "SPO-1", command: "Set-Other", target: null, state: "planned" },
      ],
    } as never);
    const root = tempRoot();
    const env = planEnvelope("apply");
    const worker = withRemediationApplyIngestion(
      async (e) => {
        const folder = path.join(root, e.payload.outputRef);
        mkdirSync(folder, { recursive: true });
        writeFileSync(
          path.join(folder, "remediation-apply.json"),
          JSON.stringify({
            PlanId: "plan-7",
            TenantId: "t-a",
            Results: [
              { actionId: "act-1", state: "applied", before: { enabled: false }, after: { enabled: true }, appliedAt: "2026-09-27T00:00:01.000Z", actor: "user-1", result: { enabled: true }, error: null, dryRun: false },
              { actionId: "act-2", state: "failed", before: null, after: null, appliedAt: "2026-09-27T00:00:02.000Z", actor: "user-1", result: null, error: "boom", dryRun: false },
            ],
            Summary: { total: 2, applied: 1, skipped: 0, failed: 1, dryrun: 0 },
          }),
        );
        return succeeded(e);
      },
      { remediation, storageRoot: root },
    );

    expect(await worker(env, new AbortController().signal)).toMatchObject({ status: "succeeded" });
    expect(await remediation.getRemediationAction("act-1")).toMatchObject({
      state: "applied",
      before: { enabled: false },
      after: { enabled: true },
      appliedAt: "2026-09-27T00:00:01.000Z",
      appliedBy: "user-1",
      result: { enabled: true },
      correlationId: "corr-1",
    });
    expect(await remediation.getRemediationAction("act-2")).toMatchObject({
      state: "failed",
      error: "boom",
      appliedBy: "user-1",
    });
  });

  it("dry runs change no action state", async () => {
    const { db, version } = await setup();
    const remediation = new SqliteRemediationRepository(db, version);
    await remediation.createRemediationPlan({
      id: "plan-7",
      tenantId: "t-a",
      runId: "run-1",
      findingIds: ["f-1"],
      mode: "automated",
      createdBy: "user-1",
      actions: [{ id: "act-1", planId: "plan-7", checkId: "CA-1", command: "Set-Thing", target: null, state: "planned" }],
    } as never);
    const root = tempRoot();
    const worker = withRemediationApplyIngestion(
      async (e) => {
        const folder = path.join(root, e.payload.outputRef);
        mkdirSync(folder, { recursive: true });
        writeFileSync(
          path.join(folder, "remediation-apply.json"),
          JSON.stringify({
            PlanId: "plan-7",
            TenantId: "t-a",
            Results: [
              { actionId: "act-1", state: "dryrun", before: { enabled: false }, after: null, appliedAt: null, actor: "user-1", result: null, error: null, dryRun: true },
            ],
            Summary: { total: 1, applied: 0, skipped: 0, failed: 0, dryrun: 1 },
          }),
        );
        return succeeded(e);
      },
      { remediation, storageRoot: root },
    );

    expect(await worker(planEnvelope("apply"), new AbortController().signal)).toMatchObject({ status: "succeeded" });
    expect(await remediation.getRemediationAction("act-1")).toMatchObject({ state: "planned", appliedAt: null, appliedBy: null });
  });

  it("fails an apply job whose output is missing", async () => {
    const { db, version } = await setup();
    const remediation = new SqliteRemediationRepository(db, version);
    const worker = withRemediationApplyIngestion(async (e) => succeeded(e), { remediation, storageRoot: tempRoot() });
    expect(await worker(planEnvelope("apply"), new AbortController().signal)).toMatchObject({
      status: "failed",
      error: { code: REMEDIATION_OUTPUT_UNREADABLE },
    });
  });

  it("replays an apply Idempotency-Key from the jobs table after a restart", async () => {
    const { db, repo } = await setup();
    await repo.createJob({
      id: "apply-job-1",
      type: "remediation",
      tenantId: "t-a",
      payload: { operation: "apply", planId: "plan-7", dryRun: true, idempotencyKey: "key-1" },
      state: "done",
      attempts: 1,
      progress: null,
      createdAt: "2026-09-27T00:00:00.000Z",
    });
    const store = createJobBackedRemediationIdempotencyStore(db);
    await expect(store.find("t-a", "key-1")).resolves.toMatchObject({
      planId: "plan-7",
      jobId: "apply-job-1",
      dryRun: true,
      status: "queued",
    });
    await expect(store.find("t-a", "missing")).resolves.toBeUndefined();
  });
});
