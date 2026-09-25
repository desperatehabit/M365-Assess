import { describe, expect, it } from "vitest";
import { EnvelopeValidationError } from "@m365-assess/contracts";
import type {
  JobEnvelope,
  ResultEnvelope,
  ResultStatus,
} from "@m365-assess/contracts";
import type { ProgressEvent } from "@m365-assess/contracts/events";
import { JobCancelledError, JobTimeoutError } from "./supervisor.js";
import {
  JobQueue,
  normalizePoolSize,
  type JobStatePersistence,
  type PersistedJobRecord,
  type PersistedJobState,
  type PersistedJobStateUpdate,
  type PersistedJobInput,
} from "./queue.js";

const TENANT_ID = "00000000-0000-0000-0000-000000000000";

class MemoryJobStore implements JobStatePersistence {
  readonly records = new Map<
    string,
    { state: PersistedJobState; progress: Record<string, unknown> | null }
  >();

  async createJob(input: PersistedJobInput): Promise<unknown> {
    if (this.records.has(input.id)) {
      throw new Error(`job ${input.id} already exists`);
    }
    this.records.set(input.id, {
      state: input.state,
      progress: input.progress,
    });
    return undefined;
  }

  async getJob(jobId: string): Promise<PersistedJobRecord | undefined> {
    return this.records.get(jobId);
  }

  async updateJobState(
    jobId: string,
    state: PersistedJobState,
    update: PersistedJobStateUpdate = {},
  ): Promise<unknown> {
    const existing = this.records.get(jobId);
    if (existing === undefined) {
      return undefined;
    }
    this.records.set(jobId, {
      state,
      progress: update.progress === undefined ? existing.progress : update.progress,
    });
    return undefined;
  }
}

function makeJob(jobId: string): JobEnvelope {
  return {
    schemaVersion: "v1",
    jobId,
    jobType: "assessment",
    tenantId: TENANT_ID,
    runId: `run-${jobId}`,
    requestId: `req-${jobId}`,
    correlationId: `corr-${jobId}`,
    createdAt: "2026-01-01T00:00:00.000Z",
    payload: {
      contextRef: `runs/run-${jobId}/context.json`,
      outputRef: `runs/run-${jobId}/tenant`,
      credentialRef: `tenants/${TENANT_ID}/credential`,
      sectionRefs: [],
      artifactRefs: [],
    },
  };
}

function makeResult(job: JobEnvelope, status: ResultStatus = "succeeded"): ResultEnvelope {
  return {
    schemaVersion: "v1",
    jobId: job.jobId,
    jobType: job.jobType,
    tenantId: job.tenantId,
    runId: job.runId,
    requestId: job.requestId,
    correlationId: job.correlationId,
    status,
    startedAt: "2026-01-01T00:00:00.000Z",
    finishedAt: "2026-01-01T00:05:00.000Z",
    exitCode: status === "succeeded" ? 0 : 1,
    artifactRefs: [],
  };
}

interface Deferred<T> {
  readonly promise: Promise<T>;
  resolve(value: T): void;
  reject(error: unknown): void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

async function waitFor(condition: () => boolean, what: string): Promise<void> {
  const deadline = Date.now() + 3000;
  while (!condition()) {
    if (Date.now() > deadline) {
      throw new Error(`timed out waiting for ${what}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

describe("JobQueue pool size", () => {
  it("defaults to 2 and accepts configuration", () => {
    const store = new MemoryJobStore();
    const runWorker = async (envelope: JobEnvelope): Promise<ResultEnvelope> =>
      makeResult(envelope);
    expect(new JobQueue({ persistence: store, runWorker }).poolSize).toBe(2);
    expect(
      new JobQueue({ persistence: store, runWorker, poolSize: 4 }).poolSize,
    ).toBe(4);
  });

  it("falls back to the default for invalid sizes", () => {
    expect(normalizePoolSize(undefined)).toBe(2);
    expect(normalizePoolSize(0)).toBe(2);
    expect(normalizePoolSize(-1)).toBe(2);
    expect(normalizePoolSize(1.5)).toBe(2);
  });
});

describe("JobQueue lifecycle", () => {
  it("rejects an envelope schema mismatch without persisting", async () => {
    const store = new MemoryJobStore();
    const queue = new JobQueue({
      persistence: store,
      runWorker: async (envelope) => makeResult(envelope),
    });
    await expect(queue.enqueue({ jobId: "job-bad" })).rejects.toBeInstanceOf(
      EnvelopeValidationError,
    );
    expect(store.records.size).toBe(0);
    expect(queue.depth).toBe(0);
    expect(queue.activeCount).toBe(0);
  });

  it("runs a stubbed worker to a persisted terminal state", async () => {
    const store = new MemoryJobStore();
    const events: ProgressEvent[] = [];
    const queue = new JobQueue({
      persistence: store,
      runWorker: async (envelope) => makeResult(envelope, "succeeded"),
      onProgress: (event) => {
        events.push(event);
      },
    });
    const job = makeJob("job-0001");
    const id = await queue.enqueue(job);
    expect(id).toBe("job-0001");
    await queue.drain();

    expect(await queue.getState(id)).toBe("succeeded");
    const stored = await store.getJob(id);
    expect(stored?.state).toBe("done");
    expect(stored?.progress?.["queueState"]).toBe("succeeded");
    expect(events.map((event) => event.state)).toEqual([
      "queued",
      "running",
      "succeeded",
    ]);
  });

  it("persists a failed worker result as failed", async () => {
    const store = new MemoryJobStore();
    const queue = new JobQueue({
      persistence: store,
      runWorker: async (envelope) => makeResult(envelope, "failed"),
    });
    const id = await queue.enqueue(makeJob("job-0002"));
    await queue.drain();
    expect(await queue.getState(id)).toBe("failed");
    const stored = await store.getJob(id);
    expect(stored?.state).toBe("failed");
    expect(stored?.progress?.["queueState"]).toBe("failed");
  });

  it("marks the run failed when the worker throws, keeping the error code", async () => {
    const store = new MemoryJobStore();
    const queue = new JobQueue({
      persistence: store,
      runWorker: async () => {
        throw new JobTimeoutError("job-0003", 10);
      },
    });
    const id = await queue.enqueue(makeJob("job-0003"));
    await queue.drain();
    expect(await queue.getState(id)).toBe("failed");
    const stored = await store.getJob(id);
    expect(stored?.progress?.["queueState"]).toBe("failed");
    expect(stored?.progress?.["code"]).toBe("worker.timeout");
  });

  it("holds jobs until a worker slot frees, in FIFO order", async () => {
    const store = new MemoryJobStore();
    const started: string[] = [];
    const gates = new Map<string, Deferred<ResultEnvelope>>();
    const queue = new JobQueue({
      persistence: store,
      poolSize: 2,
      runWorker: (envelope) => {
        started.push(envelope.jobId);
        const gate = deferred<ResultEnvelope>();
        gates.set(envelope.jobId, gate);
        return gate.promise;
      },
    });

    await queue.enqueue(makeJob("job-a"));
    await queue.enqueue(makeJob("job-b"));
    await queue.enqueue(makeJob("job-c"));

    await waitFor(() => started.length === 2, "two workers to start");
    expect(queue.activeCount).toBe(2);
    expect(queue.depth).toBe(1);

    gates.get("job-a")?.resolve(makeResult(makeJob("job-a")));
    await waitFor(() => started.length === 3, "third worker to start");
    expect(started).toEqual(["job-a", "job-b", "job-c"]);

    gates.get("job-b")?.resolve(makeResult(makeJob("job-b")));
    gates.get("job-c")?.resolve(makeResult(makeJob("job-c")));
    await queue.drain();
    expect(await queue.getState("job-a")).toBe("succeeded");
    expect(await queue.getState("job-b")).toBe("succeeded");
    expect(await queue.getState("job-c")).toBe("succeeded");
  });

  it("cancels a queued job before it starts", async () => {
    const store = new MemoryJobStore();
    const gate = deferred<ResultEnvelope>();
    const queue = new JobQueue({
      persistence: store,
      poolSize: 1,
      runWorker: () => gate.promise,
    });
    await queue.enqueue(makeJob("job-first"));
    await waitFor(() => queue.activeCount === 1, "first job to start");
    await queue.enqueue(makeJob("job-second"));

    expect(await queue.cancel("job-second")).toBe(true);
    expect(await queue.getState("job-second")).toBe("cancelled");

    gate.resolve(makeResult(makeJob("job-first")));
    await queue.drain();
    expect(await queue.getState("job-first")).toBe("succeeded");
    expect(await queue.getState("job-second")).toBe("cancelled");
    const stored = await store.getJob("job-second");
    expect(stored?.progress?.["queueState"]).toBe("cancelled");
  });

  it("cancels a running job through the abort signal", async () => {
    const store = new MemoryJobStore();
    const queue = new JobQueue({
      persistence: store,
      poolSize: 1,
      runWorker: (envelope, signal) =>
        new Promise<ResultEnvelope>((_, reject) => {
          signal.addEventListener("abort", () => {
            reject(new JobCancelledError(envelope.jobId));
          });
        }),
    });
    await queue.enqueue(makeJob("job-live"));
    await waitFor(() => queue.activeCount === 1, "job to start");
    expect(await queue.cancel("job-live")).toBe(true);
    await queue.drain();
    expect(await queue.getState("job-live")).toBe("cancelled");
  });

  it("honors cancel while a job is starting", async () => {
    const inner = new MemoryJobStore();
    let releaseRunningUpdate!: () => void;
    const runningUpdateGate = new Promise<void>((resolve) => {
      releaseRunningUpdate = resolve;
    });
    let runningUpdateBlocked = false;
    const started: string[] = [];
    const gatingStore: JobStatePersistence = {
      createJob: (input) => inner.createJob(input),
      getJob: (jobId) => inner.getJob(jobId),
      updateJobState: (jobId, state, update) => {
        if (state === "running") {
          runningUpdateBlocked = true;
          return runningUpdateGate.then(() =>
            inner.updateJobState(jobId, state, update),
          );
        }
        return inner.updateJobState(jobId, state, update);
      },
    };
    const queue = new JobQueue({
      persistence: gatingStore,
      poolSize: 1,
      runWorker: async (envelope) => {
        started.push(envelope.jobId);
        return makeResult(envelope);
      },
    });
    await queue.enqueue(makeJob("job-starting"));
    await waitFor(() => runningUpdateBlocked, "start to reach persistence");

    expect(await queue.cancel("job-starting")).toBe(true);
    releaseRunningUpdate();
    await queue.drain();

    expect(started).toEqual([]);
    expect(await queue.getState("job-starting")).toBe("cancelled");
  });

  it("returns false when cancelling an unknown job", async () => {
    const queue = new JobQueue({
      persistence: new MemoryJobStore(),
      runWorker: async (envelope) => makeResult(envelope),
    });
    expect(await queue.cancel("job-missing")).toBe(false);
  });
});
